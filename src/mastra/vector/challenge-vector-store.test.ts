import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// Use vi.hoisted so mock function references survive vi.mock hoisting
const mocks = vi.hoisted(() => {
    return {
        createIndex: vi.fn(),
        describeIndex: vi.fn(),
        disconnect: vi.fn(),
    };
});

// Mock PgVector from @mastra/pg — must use a regular function (not arrow)
// so `new PgVector(...)` works as a constructor
vi.mock('@mastra/pg', () => {
    return {
        PgVector: vi.fn().mockImplementation(function () {
            return {
                createIndex: mocks.createIndex,
                describeIndex: mocks.describeIndex,
                disconnect: mocks.disconnect,
            };
        }),
    };
});

// Mock rag.config so we can control dimension/vectorIndexName
vi.mock('../../config/rag.config', () => ({
    getRagConfig: vi.fn(),
}));

// Mock logger
vi.mock('../../utils/logger', () => ({
    tcAILogger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
    },
}));

// Import after mocks are set up
import { PgVector } from '@mastra/pg';
import { getRagConfig } from '../../config/rag.config';
import {
    getChallengeVectorStore,
    ensureChallengeIndex,
    _testing,
} from './challenge-vector-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockConfig(overrides: Partial<{
    dimension: number;
    vectorIndexName: string;
    provider: string;
    modelId: string;
}> = {}) {
    vi.mocked(getRagConfig).mockReturnValue({
        embedding: {
            provider: overrides.provider || 'TC-Ollama',
            modelId: overrides.modelId || 'nomic-embed-text',
            dimension: overrides.dimension ?? 768,
            maxContextWindow: 2048,
        },
        vectorIndexName: overrides.vectorIndexName || 'challenge_embeddings',
        vectorSearchThreshold: 0.5,
        chunkMaxSize: 512,
        chunkOverlap: 50,
        topK: 10,
        challengeSearchAI: { provider: 'AWSBedrock', modelId: 'haiku' },
        database: { connectionString: 'test-conn', schemaName: 'ai' },
        knownTypes: [],
        knownTracks: [],
    } as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('challenge-vector-store', () => {
    let savedDbConnection: string | undefined;
    let savedDbSchema: string | undefined;

    beforeEach(() => {
        vi.clearAllMocks();
        _testing.resetSingleton();
        mockConfig();

        savedDbConnection = process.env.MASTRA_DB_CONNECTION;
        savedDbSchema = process.env.MASTRA_DB_SCHEMA;
        process.env.MASTRA_DB_CONNECTION = 'postgres://test:5432/db';
        process.env.MASTRA_DB_SCHEMA = 'agents';
    });

    afterEach(() => {
        _testing.resetSingleton();
        if (savedDbConnection === undefined) {
            delete process.env.MASTRA_DB_CONNECTION;
        } else {
            process.env.MASTRA_DB_CONNECTION = savedDbConnection;
        }
        if (savedDbSchema === undefined) {
            delete process.env.MASTRA_DB_SCHEMA;
        } else {
            process.env.MASTRA_DB_SCHEMA = savedDbSchema;
        }
    });

    // VAL-FOUND-034: getChallengeVectorStore is a lazy singleton
    describe('getChallengeVectorStore — lazy singleton', () => {
        it('returns the same PgVector instance on repeated calls', () => {
            const store1 = getChallengeVectorStore();
            const store2 = getChallengeVectorStore();
            expect(store1).toBe(store2);
        });

        it('constructs PgVector at most once across multiple calls', () => {
            getChallengeVectorStore();
            getChallengeVectorStore();
            getChallengeVectorStore();
            expect(PgVector).toHaveBeenCalledTimes(1);
        });

        it('does not construct PgVector at module import time', () => {
            // After resetSingleton, no construction should have occurred yet.
            // The module was already imported at the top of this file.
            // If construction happened at import, PgVector would have been
            // called before any test ran.
            _testing.resetSingleton();
            vi.mocked(PgVector).mockClear();
            // Verify zero calls immediately after reset (no construction)
            expect(PgVector).not.toHaveBeenCalled();
            // Construction happens only when the function is called
            getChallengeVectorStore();
            expect(PgVector).toHaveBeenCalledTimes(1);
        });
    });

    // VAL-FOUND-035: PgVector constructed with id, connectionString, schemaName
    describe('PgVector constructor arguments', () => {
        it('constructs with id "tc-ai-api-rag-vector"', () => {
            getChallengeVectorStore();
            expect(PgVector).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: 'tc-ai-api-rag-vector',
                }),
            );
        });

        it('constructs with connectionString from MASTRA_DB_CONNECTION', () => {
            process.env.MASTRA_DB_CONNECTION = 'postgres://user:pass@host:5432/mydb';
            _testing.resetSingleton();
            getChallengeVectorStore();
            expect(PgVector).toHaveBeenCalledWith(
                expect.objectContaining({
                    connectionString: 'postgres://user:pass@host:5432/mydb',
                }),
            );
        });

        it('constructs with schemaName from MASTRA_DB_SCHEMA', () => {
            process.env.MASTRA_DB_SCHEMA = 'agents';
            _testing.resetSingleton();
            getChallengeVectorStore();
            expect(PgVector).toHaveBeenCalledWith(
                expect.objectContaining({
                    schemaName: 'agents',
                }),
            );
        });

        it('defaults schemaName to "ai" when MASTRA_DB_SCHEMA is unset', () => {
            delete process.env.MASTRA_DB_SCHEMA;
            _testing.resetSingleton();
            getChallengeVectorStore();
            expect(PgVector).toHaveBeenCalledWith(
                expect.objectContaining({
                    schemaName: 'ai',
                }),
            );
        });

        it('passes all three fields in a single constructor call', () => {
            process.env.MASTRA_DB_CONNECTION = 'postgres://localhost/db';
            process.env.MASTRA_DB_SCHEMA = 'myschema';
            _testing.resetSingleton();
            getChallengeVectorStore();
            expect(PgVector).toHaveBeenCalledWith({
                id: 'tc-ai-api-rag-vector',
                connectionString: 'postgres://localhost/db',
                schemaName: 'myschema',
            });
        });
    });

    // VAL-FOUND-036: ensureChallengeIndex creates HNSW index with cosine metric
    describe('ensureChallengeIndex — HNSW + cosine', () => {
        it('calls createIndex with metric: "cosine"', async () => {
            mocks.describeIndex.mockResolvedValue({ dimension: 0, count: 0 });
            mocks.createIndex.mockResolvedValue(undefined);

            await ensureChallengeIndex();

            expect(mocks.createIndex).toHaveBeenCalledWith(
                expect.objectContaining({
                    metric: 'cosine',
                }),
            );
        });

        it('calls createIndex with indexConfig: { type: "hnsw" }', async () => {
            mocks.describeIndex.mockResolvedValue({ dimension: 0, count: 0 });
            mocks.createIndex.mockResolvedValue(undefined);

            await ensureChallengeIndex();

            expect(mocks.createIndex).toHaveBeenCalledWith(
                expect.objectContaining({
                    indexConfig: { type: 'hnsw' },
                }),
            );
        });

        it('calls createIndex with the configured indexName and dimension', async () => {
            mocks.describeIndex.mockResolvedValue({ dimension: 0, count: 0 });
            mocks.createIndex.mockResolvedValue(undefined);
            mockConfig({ dimension: 768, vectorIndexName: 'challenge_embeddings' });

            await ensureChallengeIndex();

            expect(mocks.createIndex).toHaveBeenCalledWith(
                expect.objectContaining({
                    indexName: 'challenge_embeddings',
                    dimension: 768,
                }),
            );
        });

        it('is idempotent — calls createIndex every time even when the index already exists', async () => {
            // createIndex is itself idempotent (CREATE TABLE/INDEX IF NOT EXISTS)
            // and is the only place @mastra/pg's schema migrations run (e.g. the
            // 1.22+ namespace column), so it must run on every call, not just
            // when the index is missing.
            mocks.describeIndex.mockResolvedValue({ dimension: 768, count: 0 });
            mocks.createIndex.mockResolvedValue(undefined);

            await ensureChallengeIndex();
            expect(mocks.createIndex).toHaveBeenCalledTimes(1);

            await ensureChallengeIndex();
            expect(mocks.createIndex).toHaveBeenCalledTimes(2);
        });

        it('does not throw on second call', async () => {
            mocks.describeIndex.mockResolvedValue({ dimension: 768, count: 0 });
            mocks.createIndex.mockResolvedValue(undefined);

            await expect(ensureChallengeIndex()).resolves.not.toThrow();
            await expect(ensureChallengeIndex()).resolves.not.toThrow();
        });

        it('creates index when it does not exist (dimension 0)', async () => {
            mocks.describeIndex.mockResolvedValue({ dimension: 0, count: 0 });
            mocks.createIndex.mockResolvedValue(undefined);

            await ensureChallengeIndex();

            expect(mocks.createIndex).toHaveBeenCalledTimes(1);
        });

        it('creates index when describeIndex throws (table missing)', async () => {
            mocks.describeIndex.mockRejectedValue(new Error('relation does not exist'));
            mocks.createIndex.mockResolvedValue(undefined);

            await ensureChallengeIndex();

            expect(mocks.createIndex).toHaveBeenCalledTimes(1);
        });

        it('returns the PgVector instance', async () => {
            mocks.describeIndex.mockResolvedValue({ dimension: 768, count: 0 });
            mocks.createIndex.mockResolvedValue(undefined);

            const store = getChallengeVectorStore();
            const result = await ensureChallengeIndex();
            expect(result).toBe(store);
        });
    });

    // VAL-FOUND-037: metadataIndexes for challengeId, projectId, track
    describe('ensureChallengeIndex — metadataIndexes', () => {
        it('passes metadataIndexes with exactly challengeId, projectId, track', async () => {
            mocks.describeIndex.mockResolvedValue({ dimension: 0, count: 0 });
            mocks.createIndex.mockResolvedValue(undefined);

            await ensureChallengeIndex();

            expect(mocks.createIndex).toHaveBeenCalledWith(
                expect.objectContaining({
                    metadataIndexes: ['challengeId', 'projectId', 'track'],
                }),
            );
        });

        it('does not include other fields in metadataIndexes', async () => {
            mocks.describeIndex.mockResolvedValue({ dimension: 0, count: 0 });
            mocks.createIndex.mockResolvedValue(undefined);

            await ensureChallengeIndex();

            const callArgs = mocks.createIndex.mock.calls[0][0] as any;
            expect(callArgs.metadataIndexes).toEqual(
                ['challengeId', 'projectId', 'track'],
            );
            expect(callArgs.metadataIndexes).toHaveLength(3);
        });
    });

    // VAL-FOUND-038: dimension guard
    describe('ensureChallengeIndex — dimension guard (D7)', () => {
        it('throws actionable error on dimension mismatch', async () => {
            // Index exists with 768, config says 1024
            mocks.describeIndex.mockResolvedValue({ dimension: 768, count: 100 });
            mockConfig({ dimension: 1024 });

            await expect(ensureChallengeIndex()).rejects.toThrow(
                /(VECTOR_INDEX_NAME|reindex|dimension)/i,
            );
        });

        it('error message names both dimensions', async () => {
            mocks.describeIndex.mockResolvedValue({ dimension: 768, count: 100 });
            mockConfig({ dimension: 1024 });

            try {
                await ensureChallengeIndex();
                expect.fail('Should have thrown');
            } catch (e: any) {
                expect(e.message).toContain('768');
                expect(e.message).toContain('1024');
            }
        });

        it('error message points at VECTOR_INDEX_NAME or reindex as remediation', async () => {
            mocks.describeIndex.mockResolvedValue({ dimension: 768, count: 100 });
            mockConfig({ dimension: 1024 });

            try {
                await ensureChallengeIndex();
                expect.fail('Should have thrown');
            } catch (e: any) {
                expect(e.message).toMatch(/VECTOR_INDEX_NAME|reindex/i);
            }
        });

        it('does not call createIndex on dimension mismatch', async () => {
            mocks.describeIndex.mockResolvedValue({ dimension: 768, count: 100 });
            mockConfig({ dimension: 1024 });

            try {
                await ensureChallengeIndex();
            } catch {
                // expected
            }
            expect(mocks.createIndex).not.toHaveBeenCalled();
        });

        it('does not throw when dimensions match', async () => {
            mocks.describeIndex.mockResolvedValue({ dimension: 768, count: 100 });
            mockConfig({ dimension: 768 });

            await expect(ensureChallengeIndex()).resolves.not.toThrow();
        });

        it('still calls createIndex when dimensions match (idempotent schema check)', async () => {
            mocks.describeIndex.mockResolvedValue({ dimension: 768, count: 100 });
            mocks.createIndex.mockResolvedValue(undefined);
            mockConfig({ dimension: 768 });

            await ensureChallengeIndex();
            expect(mocks.createIndex).toHaveBeenCalledTimes(1);
        });

        it('names the index in the error message', async () => {
            mocks.describeIndex.mockResolvedValue({ dimension: 768, count: 100 });
            mockConfig({ dimension: 1024, vectorIndexName: 'challenge_embeddings' });

            try {
                await ensureChallengeIndex();
                expect.fail('Should have thrown');
            } catch (e: any) {
                expect(e.message).toContain('challenge_embeddings');
            }
        });
    });

    // VAL-FOUND-039: no disconnect on request paths
    describe('no disconnect on request paths', () => {
        it('does not call disconnect during getChallengeVectorStore', () => {
            getChallengeVectorStore();
            expect(mocks.disconnect).not.toHaveBeenCalled();
        });

        it('does not call disconnect during ensureChallengeIndex (create path)', async () => {
            mocks.describeIndex.mockResolvedValue({ dimension: 0, count: 0 });
            mocks.createIndex.mockResolvedValue(undefined);

            await ensureChallengeIndex();
            expect(mocks.disconnect).not.toHaveBeenCalled();
        });

        it('does not call disconnect during ensureChallengeIndex (index already exists)', async () => {
            mocks.describeIndex.mockResolvedValue({ dimension: 768, count: 0 });
            mocks.createIndex.mockResolvedValue(undefined);

            await ensureChallengeIndex();
            expect(mocks.disconnect).not.toHaveBeenCalled();
        });

        it('does not call disconnect during dimension guard failure', async () => {
            mocks.describeIndex.mockResolvedValue({ dimension: 768, count: 100 });
            mockConfig({ dimension: 1024 });

            try {
                await ensureChallengeIndex();
            } catch {
                // expected
            }
            expect(mocks.disconnect).not.toHaveBeenCalled();
        });
    });
});
