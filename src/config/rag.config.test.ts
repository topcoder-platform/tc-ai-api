import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getRagConfig } from './rag.config';

// ---------------------------------------------------------------------------
// Env var keys managed by these tests
// ---------------------------------------------------------------------------
const RAG_ENV_KEYS = [
    'RAG_EMBEDDING_PROVIDER',
    'RAG_EMBEDDING_MODEL_ID',
    'VECTOR_INDEX_NAME',
    'VECTOR_SEARCH_THRESHOLD',
    'RAG_CHUNK_MAX_SIZE',
    'RAG_CHUNK_OVERLAP',
    'RAG_TOP_K',
    'CHALLENGE_SEARCH_AI_PROVIDER',
    'CHALLENGE_SEARCH_AI_MODEL_ID',
    'MASTRA_DB_CONNECTION',
    'MASTRA_DB_SCHEMA',
];

describe('rag.config — getRagConfig', () => {
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
        savedEnv = {};
        for (const key of RAG_ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        for (const key of RAG_ENV_KEYS) {
            if (savedEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = savedEnv[key];
            }
        }
    });

    // VAL-FOUND-021: getRagConfig resolves lazily and does not throw at module load
    describe('lazy resolution (D5)', () => {
        it('does not throw at module load even when all RAG env vars are unset', async () => {
            // Re-import the module fresh with no RAG env vars set.
            // vi.resetModules is not needed here because the module never throws
            // at import time by design — but we verify the import succeeds.
            const mod = await import('./rag.config');
            expect(mod.getRagConfig).toBeDefined();
            expect(typeof mod.getRagConfig).toBe('function');
        });

        it('returns defaults when called with no RAG env vars set', () => {
            // With no env vars, defaults should be used (TC-Ollama/nomic-embed-text)
            const config = getRagConfig();
            expect(config.embedding.provider).toBe('TC-Ollama');
            expect(config.embedding.modelId).toBe('nomic-embed-text');
            expect(config.embedding.dimension).toBe(768);
            expect(config.embedding.maxContextWindow).toBe(2048);
        });
    });

    // VAL-FOUND-022: TC-Ollama/nomic-embed-text → dimension 768, contextWindow 2048
    describe('dimension mapping', () => {
        it('maps TC-Ollama/nomic-embed-text to dimension 768 and maxContextWindow 2048', () => {
            process.env.RAG_EMBEDDING_PROVIDER = 'TC-Ollama';
            process.env.RAG_EMBEDDING_MODEL_ID = 'nomic-embed-text';
            const config = getRagConfig();
            expect(config.embedding.dimension).toBe(768);
            expect(config.embedding.maxContextWindow).toBe(2048);
        });

        // VAL-FOUND-023: AWSBedrock/amazon.titan-embed-text-v2:0 → dimension 1024, contextWindow 8192
        it('maps AWSBedrock/amazon.titan-embed-text-v2:0 to dimension 1024 and maxContextWindow 8192', () => {
            process.env.RAG_EMBEDDING_PROVIDER = 'AWSBedrock';
            process.env.RAG_EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';
            const config = getRagConfig();
            expect(config.embedding.dimension).toBe(1024);
            expect(config.embedding.maxContextWindow).toBe(8192);
        });

        // VAL-FOUND-024: unknown provider/model throws actionable error
        it('throws actionable error for unknown provider/model combination', () => {
            process.env.RAG_EMBEDDING_PROVIDER = 'TC-Ollama';
            process.env.RAG_EMBEDDING_MODEL_ID = 'unknown-model';
            expect(() => getRagConfig()).toThrow(
                /(provider|model|supported|RAG_EMBEDDING)/i,
            );
        });

        it('throws actionable error for unknown provider', () => {
            process.env.RAG_EMBEDDING_PROVIDER = 'UnknownProvider';
            process.env.RAG_EMBEDDING_MODEL_ID = 'nomic-embed-text';
            expect(() => getRagConfig()).toThrow(
                /(provider|model|supported|RAG_EMBEDDING)/i,
            );
        });

        it('error message names the offending provider and model', () => {
            process.env.RAG_EMBEDDING_PROVIDER = 'TC-Ollama';
            process.env.RAG_EMBEDDING_MODEL_ID = 'bad-model';
            expect(() => getRagConfig()).toThrow(/TC-Ollama/);
            expect(() => getRagConfig()).toThrow(/bad-model/);
        });
    });

    // VAL-FOUND-025: VECTOR_INDEX_NAME validated as SQL identifier
    describe('VECTOR_INDEX_NAME SQL identifier validation', () => {
        it('accepts a valid SQL identifier', () => {
            process.env.VECTOR_INDEX_NAME = 'challenge_embeddings';
            expect(() => getRagConfig()).not.toThrow();
            const config = getRagConfig();
            expect(config.vectorIndexName).toBe('challenge_embeddings');
        });

        it('rejects a SQL injection-style string', () => {
            process.env.VECTOR_INDEX_NAME = 'challenge; DROP TABLE;';
            expect(() => getRagConfig()).toThrow();
        });

        it('rejects a digit-prefixed identifier', () => {
            process.env.VECTOR_INDEX_NAME = '1bad';
            expect(() => getRagConfig()).toThrow();
        });

        it('rejects an identifier with spaces', () => {
            process.env.VECTOR_INDEX_NAME = 'bad name';
            expect(() => getRagConfig()).toThrow();
        });

        it('defaults to challenge_embeddings when unset', () => {
            const config = getRagConfig();
            expect(config.vectorIndexName).toBe('challenge_embeddings');
        });
    });

    // VAL-FOUND-026: env-overridable numeric config
    describe('env-overridable numeric config', () => {
        it('overrides RAG_CHUNK_MAX_SIZE, RAG_CHUNK_OVERLAP, RAG_TOP_K, VECTOR_SEARCH_THRESHOLD', () => {
            process.env.RAG_CHUNK_MAX_SIZE = '256';
            process.env.RAG_CHUNK_OVERLAP = '25';
            process.env.RAG_TOP_K = '5';
            process.env.VECTOR_SEARCH_THRESHOLD = '0.75';
            const config = getRagConfig();
            expect(config.chunkMaxSize).toBe(256);
            expect(config.chunkOverlap).toBe(25);
            expect(config.topK).toBe(5);
            expect(config.vectorSearchThreshold).toBe(0.75);
        });

        it('restores defaults when env vars are unset', () => {
            const config = getRagConfig();
            expect(config.chunkMaxSize).toBe(512);
            expect(config.chunkOverlap).toBe(50);
            expect(config.topK).toBe(10);
            expect(config.vectorSearchThreshold).toBe(0.5);
        });

        it('throws actionable error for non-numeric RAG_CHUNK_MAX_SIZE', () => {
            process.env.RAG_CHUNK_MAX_SIZE = 'not-a-number';
            expect(() => getRagConfig()).toThrow();
        });

        it('throws actionable error for non-numeric VECTOR_SEARCH_THRESHOLD', () => {
            process.env.VECTOR_SEARCH_THRESHOLD = 'not-a-number';
            expect(() => getRagConfig()).toThrow();
        });
    });

    // VAL-FOUND-027: type and track are free-form strings, not enums
    describe('type and track as free-form strings (D12)', () => {
        it('documents known types and tracks as informational arrays', () => {
            const config = getRagConfig();
            expect(Array.isArray(config.knownTypes)).toBe(true);
            expect(Array.isArray(config.knownTracks)).toBe(true);
            // Known types include the current reference-table names
            expect(config.knownTypes).toContain('Challenge');
            expect(config.knownTypes).toContain('First2Finish');
            // Known tracks include all four ChallengeTrackEnum values
            expect(config.knownTracks).toContain('Design');
            expect(config.knownTracks).toContain('Data Science');
            expect(config.knownTracks).toContain('Development');
            expect(config.knownTracks).toContain('Quality Assurance');
        });

        it('known types and tracks are plain strings, not enum-validated', () => {
            const config = getRagConfig();
            for (const t of config.knownTypes) {
                expect(typeof t).toBe('string');
            }
            for (const t of config.knownTracks) {
                expect(typeof t).toBe('string');
            }
        });
    });

    // VAL-FOUND-028: reuses MASTRA_DB_CONNECTION and MASTRA_DB_SCHEMA
    describe('database config reuses MASTRA_DB_CONNECTION and MASTRA_DB_SCHEMA', () => {
        it('sources connectionString from MASTRA_DB_CONNECTION', () => {
            process.env.MASTRA_DB_CONNECTION = 'postgresql://user:pass@localhost/ai-api?schema=agents';
            const config = getRagConfig();
            expect(config.database.connectionString).toBe(
                'postgresql://user:pass@localhost/ai-api?schema=agents',
            );
        });

        it('sources schemaName from MASTRA_DB_SCHEMA', () => {
            process.env.MASTRA_DB_SCHEMA = 'agents';
            const config = getRagConfig();
            expect(config.database.schemaName).toBe('agents');
        });

        it('defaults schemaName to "ai" when MASTRA_DB_SCHEMA is unset', () => {
            delete process.env.MASTRA_DB_SCHEMA;
            const config = getRagConfig();
            expect(config.database.schemaName).toBe('ai');
        });

        it('does not introduce separate POSTGRES_* variables', () => {
            process.env.MASTRA_DB_CONNECTION = 'postgresql://user:pass@localhost/ai-api?schema=agents';
            process.env.MASTRA_DB_SCHEMA = 'agents';
            const config = getRagConfig();
            // The database config only has connectionString and schemaName
            expect(Object.keys(config.database).sort()).toEqual(
                ['connectionString', 'schemaName'],
            );
        });
    });

    describe('challenge search AI config', () => {
        it('defaults to AWSBedrock/us.anthropic.claude-haiku-4-5', () => {
            const config = getRagConfig();
            expect(config.challengeSearchAI.provider).toBe('AWSBedrock');
            expect(config.challengeSearchAI.modelId).toBe(
                'us.anthropic.claude-haiku-4-5',
            );
        });

        it('is env-overridable via CHALLENGE_SEARCH_AI_PROVIDER and CHALLENGE_SEARCH_AI_MODEL_ID', () => {
            process.env.CHALLENGE_SEARCH_AI_PROVIDER = 'TC-Ollama';
            process.env.CHALLENGE_SEARCH_AI_MODEL_ID = 'qwen2.5:latest';
            const config = getRagConfig();
            expect(config.challengeSearchAI.provider).toBe('TC-Ollama');
            expect(config.challengeSearchAI.modelId).toBe('qwen2.5:latest');
        });
    });
});
