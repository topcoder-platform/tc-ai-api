import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
    fetchExecute: vi.fn(),
    embedMany: vi.fn(),
    createEmbeddingModel: vi.fn(() => ({ modelId: 'mock-embedding-model' })),
    ensureChallengeIndex: vi.fn(),
    upsert: vi.fn(),
    getRagConfig: vi.fn(),
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.mock('../../tools/challenge/fetch-challenge-tool', () => ({
    fetchChallengeTool: { execute: mocks.fetchExecute },
}));

vi.mock('ai', async (importOriginal) => {
    const actual = await importOriginal<typeof import('ai')>();
    return { ...actual, embedMany: mocks.embedMany };
});

vi.mock('../../../utils/providers/embedding-factory', () => ({
    createEmbeddingModel: mocks.createEmbeddingModel,
}));

vi.mock('../../vector/challenge-vector-store', () => ({
    ensureChallengeIndex: mocks.ensureChallengeIndex,
}));

vi.mock('../../../config/rag.config', () => ({
    getRagConfig: mocks.getRagConfig,
}));

vi.mock('../../../utils/logger', () => ({
    tcAILogger: mocks.logger,
}));

// Import after mocks are set up
import { generateDeterministicId } from '../../rag/ingestion-utils';
import type { ChunkMetadata } from '../../rag/types';
import { challengeIngestionWorkflow, _testing } from './challenge-ingestion-workflow';

// Captured immediately after module evaluation: getRagConfig must not be
// invoked while the module graph is being loaded (D5 — lazy config).
const getRagConfigCallsAtImport = mocks.getRagConfig.mock.calls.length;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StepExecutor {
    execute: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

async function runStep<T = Record<string, unknown>>(
    step: unknown,
    inputData: unknown,
): Promise<T> {
    const executable = step as unknown as StepExecutor;
    return (await executable.execute({ inputData, requestContext: {} })) as T;
}

function baseConfig(overrides: Record<string, unknown> = {}) {
    return {
        embedding: {
            provider: 'TC-Ollama',
            modelId: 'nomic-embed-text',
            dimension: 768,
            maxContextWindow: 2048,
        },
        vectorIndexName: 'challenge_embeddings',
        vectorSearchThreshold: 0.5,
        chunkMaxSize: 512,
        chunkOverlap: 50,
        topK: 10,
        challengeSearchAI: { provider: 'AWSBedrock', modelId: 'us.anthropic.claude-haiku-4-5' },
        database: { connectionString: undefined, schemaName: 'ai' },
        knownTypes: [],
        knownTracks: [],
        ...overrides,
    };
}

const CHALLENGE_ID = '11111111-2222-4333-8444-555555555555';

function apiChallenge(overrides: Record<string, unknown> = {}) {
    return {
        id: CHALLENGE_ID,
        name: 'Build a Widget',
        description: 'PUBLIC BODY about widgets and gizmos.',
        privateDescription: 'SECRET reviewer-only notes.',
        descriptionFormat: 'markdown',
        status: 'Active',
        track: 'Development',
        type: 'Challenge',
        tags: [],
        skills: [{ id: 's1', name: 'React' }, { id: 's2', name: 'React' }, { id: 's3', name: 'Node.js' }],
        numOfRegistrants: 0,
        numOfSubmissions: 0,
        projectId: 4321,
        groups: ['group-a'],
        ...overrides,
    };
}

/** Normalized record as produced by the resolve-challenge step. */
function normalizedRecord(overrides: Record<string, unknown> = {}) {
    return {
        challengeId: CHALLENGE_ID,
        name: 'Build a Widget',
        description: 'PUBLIC BODY about widgets and gizmos.',
        descriptionFormat: 'markdown',
        type: 'Challenge',
        track: 'Development',
        skills: ['React', 'Node.js'],
        groups: ['group-a'],
        projectId: '4321',
        ...overrides,
    };
}

interface ResolveOutput {
    record: ReturnType<typeof normalizedRecord>;
    dryRun: boolean;
}

interface EmbedOutput {
    challengeId: string;
    projectId: string | null;
    dryRun: boolean;
    skipped: boolean;
    chunks: number;
    forceSplits: unknown[];
    vectorIds: string[];
    embeddings: number[][];
    metadata: ChunkMetadata[];
}

interface Report {
    chunks: number;
    forceSplits: unknown[];
    dryRun: boolean;
    skipped: boolean;
    projectId: string | null;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRagConfig.mockReturnValue(baseConfig());
    mocks.createEmbeddingModel.mockReturnValue({ modelId: 'mock-embedding-model' });
    mocks.fetchExecute.mockResolvedValue({ challenge: apiChallenge() });
    mocks.embedMany.mockImplementation(async ({ values }: { values: string[] }) => ({
        embeddings: values.map((_, i) => [i, 0.1, 0.2]),
    }));
    mocks.upsert.mockResolvedValue([]);
    mocks.ensureChallengeIndex.mockResolvedValue({ upsert: mocks.upsert });
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Workflow shape & registration
// ---------------------------------------------------------------------------

describe('challenge-ingestion workflow definition', () => {
    it('exposes the workflow id challenge-ingestion', () => {
        expect(challengeIngestionWorkflow.id).toBe('challenge-ingestion');
    });

    it('is registered in src/mastra/index.ts', () => {
        const indexSource = readFileSync(
            resolvePath(__dirname, '../../index.ts'),
            'utf8',
        );
        expect(indexSource).toContain('challengeIngestionWorkflow');
        expect(indexSource).toContain(
            "from './workflows/challenge/challenge-ingestion-workflow'",
        );
    });

    it('does not resolve the RAG config at module load (D5)', () => {
        expect(getRagConfigCallsAtImport).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

describe('challenge-ingestion input schema', () => {
    it('accepts a UUID challengeId and defaults dryRun to false', () => {
        const parsed = _testing.ingestionInputSchema.parse({ challengeId: CHALLENGE_ID });
        expect(parsed.challengeId).toBe(CHALLENGE_ID);
        expect(parsed.dryRun).toBe(false);
    });

    it('rejects a challengeId that is not a UUID', () => {
        const result = _testing.ingestionInputSchema.safeParse({ challengeId: 'not-a-uuid' });
        expect(result.success).toBe(false);
    });

    it('accepts an inline challenge with free-form type and track (D12)', () => {
        const result = _testing.ingestionInputSchema.safeParse({
            challenge: {
                id: 'abc',
                name: 'Inline',
                description: 'Body',
                typeName: 'Totally New Type',
                trackName: 'Some Future Track',
            },
        });
        expect(result.success).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// resolve-challenge
// ---------------------------------------------------------------------------

describe('resolve-challenge step', () => {
    it('fetches by challengeId via fetchChallengeTool and normalizes the record', async () => {
        const out = await runStep<ResolveOutput>(_testing.resolveChallengeStep, {
            challengeId: CHALLENGE_ID,
            dryRun: false,
        });

        expect(mocks.fetchExecute).toHaveBeenCalledTimes(1);
        expect(mocks.fetchExecute.mock.calls[0][0]).toEqual({ challengeId: CHALLENGE_ID });
        expect(out.record.challengeId).toBe(CHALLENGE_ID);
        expect(out.record.name).toBe('Build a Widget');
        expect(out.record.type).toBe('Challenge');
        expect(out.record.track).toBe('Development');
        expect(out.record.groups).toEqual(['group-a']);
        expect(out.dryRun).toBe(false);
    });

    it('parses, deduplicates and filters skills', async () => {
        mocks.fetchExecute.mockResolvedValue({
            challenge: apiChallenge({
                skills: [{ id: 'a', name: 'React' }, { id: 'b', name: ' React ' }, { id: 'c', name: '' }],
            }),
        });

        const out = await runStep<ResolveOutput>(_testing.resolveChallengeStep, {
            challengeId: CHALLENGE_ID,
        });

        expect(out.record.skills).toEqual(['React']);
    });

    it('normalizes a numeric projectId to a string (never a number)', async () => {
        const out = await runStep<ResolveOutput>(_testing.resolveChallengeStep, {
            challengeId: CHALLENGE_ID,
        });

        expect(out.record.projectId).toBe('4321');
        expect(typeof out.record.projectId).toBe('string');
    });

    it('normalizes a missing projectId to null', async () => {
        mocks.fetchExecute.mockResolvedValue({
            challenge: apiChallenge({ projectId: undefined }),
        });

        const out = await runStep<ResolveOutput>(_testing.resolveChallengeStep, {
            challengeId: CHALLENGE_ID,
        });

        expect(out.record.projectId).toBeNull();
    });

    it('validates an inline record and never calls fetchChallengeTool', async () => {
        const out = await runStep<ResolveOutput>(_testing.resolveChallengeStep, {
            challenge: {
                id: 'inline-1',
                name: 'Inline Challenge',
                description: 'Inline body text.',
                skills: 'React, , React, Node.js',
                projectId: 99,
                groups: ['g1'],
                typeName: 'First2Finish',
                trackName: 'Development',
            },
            dryRun: true,
        });

        expect(mocks.fetchExecute).not.toHaveBeenCalled();
        expect(out.record.challengeId).toBe('inline-1');
        expect(out.record.skills).toEqual(['React', 'Node.js']);
        expect(out.record.projectId).toBe('99');
        expect(out.dryRun).toBe(true);
    });

    it('rejects an inline record that fails validateRecord', async () => {
        await expect(
            runStep(_testing.resolveChallengeStep, {
                challenge: { id: 'inline-2', name: 'No body', description: '   ' },
            }),
        ).rejects.toThrow(/Empty description/);
    });

    it('fails with an exactly-one-source error when both sources are supplied', async () => {
        await expect(
            runStep(_testing.resolveChallengeStep, {
                challengeId: CHALLENGE_ID,
                challenge: { id: 'x', name: 'y', description: 'z' },
            }),
        ).rejects.toThrow(/exactly one source/i);
        expect(mocks.fetchExecute).not.toHaveBeenCalled();
    });

    it('fails with an exactly-one-source error when neither source is supplied', async () => {
        await expect(runStep(_testing.resolveChallengeStep, { dryRun: false })).rejects.toThrow(
            /exactly one source/i,
        );
    });

    it('fails gracefully with challenge-not-found for an unknown challengeId', async () => {
        mocks.fetchExecute.mockResolvedValue({ challenge: null });

        await expect(
            runStep(_testing.resolveChallengeStep, { challengeId: CHALLENGE_ID }),
        ).rejects.toThrow(/challenge-not-found/);
    });

    it('makes no projects-api call during resolution (D10)', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        await runStep(_testing.resolveChallengeStep, { challengeId: CHALLENGE_ID });

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('logs with the [challenge-ingestion:resolve-challenge] prefix', async () => {
        await runStep(_testing.resolveChallengeStep, { challengeId: CHALLENGE_ID });

        const messages = mocks.logger.info.mock.calls.map((c) => String(c[0]));
        expect(messages.some((m) => m.startsWith('[challenge-ingestion:resolve-challenge]'))).toBe(
            true,
        );
    });
});

// ---------------------------------------------------------------------------
// chunk-and-embed
// ---------------------------------------------------------------------------

describe('chunk-and-embed step', () => {
    it('embeds every chunk and produces 1-based metadata with all 11 fields', async () => {
        const out = await runStep<EmbedOutput>(_testing.chunkAndEmbedStep, {
            record: normalizedRecord(),
            dryRun: false,
        });

        expect(out.skipped).toBe(false);
        expect(out.chunks).toBeGreaterThan(0);
        expect(out.embeddings).toHaveLength(out.chunks);
        expect(out.metadata).toHaveLength(out.chunks);
        expect(mocks.embedMany).toHaveBeenCalledTimes(1);

        const meta = out.metadata[0];
        expect(Object.keys(meta).sort()).toEqual(
            [
                'challengeId',
                'chunkIndex',
                'groups',
                'ingestedAt',
                'name',
                'projectId',
                'skills',
                'text',
                'totalChunks',
                'track',
                'type',
            ].sort(),
        );
        expect(meta.challengeId).toBe(CHALLENGE_ID);
        expect(meta.name).toBe('Build a Widget');
        expect(meta.type).toBe('Challenge');
        expect(meta.track).toBe('Development');
        expect(Array.isArray(meta.skills)).toBe(true);
        expect(Array.isArray(meta.groups)).toBe(true);
        expect(typeof meta.projectId).toBe('string');
        expect(meta.chunkIndex).toBe(1);
        expect(out.metadata.map((m) => m.chunkIndex)).toEqual(
            out.metadata.map((_, i) => i + 1),
        );
        expect(meta.totalChunks).toBe(out.chunks);
        expect(typeof meta.text).toBe('string');
        expect(new Date(meta.ingestedAt).toISOString()).toBe(meta.ingestedAt);
    });

    it('prefixes every chunk with the # Challenge: <name> header', async () => {
        const out = await runStep<EmbedOutput>(_testing.chunkAndEmbedStep, {
            record: normalizedRecord(),
            dryRun: false,
        });

        for (const meta of out.metadata) {
            expect(meta.text.startsWith('# Challenge: Build a Widget')).toBe(true);
        }
        const embedded: string[] = mocks.embedMany.mock.calls[0][0].values;
        for (const value of embedded) {
            expect(value.startsWith('# Challenge: Build a Widget')).toBe(true);
        }
    });

    it('converts HTML descriptions to Markdown before chunking', async () => {
        const out = await runStep<EmbedOutput>(_testing.chunkAndEmbedStep, {
            record: normalizedRecord({
                description: '<h2>Overview</h2><p>Build a <strong>widget</strong>.</p>',
                descriptionFormat: 'HTML',
            }),
            dryRun: false,
        });

        const joined = out.metadata.map((m) => m.text).join('\n');
        expect(joined).toContain('## Overview');
        expect(joined).toContain('**widget**');
        expect(joined).not.toContain('<h2>');
    });

    it('strips YAML frontmatter before chunking', async () => {
        const out = await runStep<EmbedOutput>(_testing.chunkAndEmbedStep, {
            record: normalizedRecord({
                description: '---\ntitle: hidden meta\n---\nVisible body content.',
            }),
            dryRun: false,
        });

        const joined = out.metadata.map((m) => m.text).join('\n');
        expect(joined).not.toContain('hidden meta');
        expect(joined).toContain('Visible body content.');
    });

    it('normalizes BOM and CRLF before chunking', async () => {
        const out = await runStep<EmbedOutput>(_testing.chunkAndEmbedStep, {
            record: normalizedRecord({
                description: '\uFEFFLine one\r\nLine two\r\n',
            }),
            dryRun: false,
        });

        const joined = out.metadata.map((m) => m.text).join('\n');
        expect(joined).not.toContain('\uFEFF');
        expect(joined).not.toContain('\r');
        expect(joined).toContain('Line one\nLine two');
    });

    it('embeds only the public description, never privateDescription', async () => {
        const resolved = await runStep<ResolveOutput>(_testing.resolveChallengeStep, {
            challengeId: CHALLENGE_ID,
        });
        const out = await runStep<EmbedOutput>(_testing.chunkAndEmbedStep, {
            record: resolved.record,
            dryRun: false,
        });

        const embedded: string[] = mocks.embedMany.mock.calls[0][0].values;
        expect(embedded.join('\n')).toContain('PUBLIC BODY');
        expect(embedded.join('\n')).not.toContain('SECRET');
        expect(out.metadata.map((m) => m.text).join('\n')).not.toContain('SECRET');
    });

    it('skips an empty/whitespace description with skipped: true', async () => {
        const out = await runStep<EmbedOutput>(_testing.chunkAndEmbedStep, {
            record: normalizedRecord({ description: '  \r\n \uFEFF ' }),
            dryRun: false,
        });

        expect(out.skipped).toBe(true);
        expect(out.chunks).toBe(0);
        expect(out.metadata).toEqual([]);
        expect(mocks.embedMany).not.toHaveBeenCalled();
    });

    it('produces deterministic vector ids across runs', async () => {
        const first = await runStep<EmbedOutput>(_testing.chunkAndEmbedStep, {
            record: normalizedRecord(),
            dryRun: false,
        });
        const second = await runStep<EmbedOutput>(_testing.chunkAndEmbedStep, {
            record: normalizedRecord(),
            dryRun: false,
        });

        expect(second.vectorIds).toEqual(first.vectorIds);
        expect(first.vectorIds).toEqual(
            first.metadata.map((m) => generateDeterministicId(`${CHALLENGE_ID}-${m.text}`)),
        );
    });

    it('reports a chunk count and force-split records', async () => {
        const out = await runStep<EmbedOutput>(_testing.chunkAndEmbedStep, {
            record: normalizedRecord(),
            dryRun: false,
        });

        expect(Array.isArray(out.forceSplits)).toBe(true);
        expect(out.chunks).toBe(out.metadata.length);
    });

    it('surfaces an embedding failure with chunk count, total chars and longest chunk', async () => {
        mocks.embedMany.mockRejectedValue(new Error('ollama connection refused'));

        await expect(
            runStep(_testing.chunkAndEmbedStep, {
                record: normalizedRecord(),
                dryRun: false,
            }),
        ).rejects.toThrow(
            /embedding failure.*chunks: \d+.*totalChars: \d+.*longestChunk: \d+.*ollama connection refused/s,
        );
    }, 15_000);

    it('retries embedding with linear backoff via withRetry', async () => {
        mocks.embedMany
            .mockRejectedValueOnce(new Error('transient'))
            .mockImplementation(async ({ values }: { values: string[] }) => ({
                embeddings: values.map((_, i) => [i]),
            }));

        const out = await runStep<EmbedOutput>(_testing.chunkAndEmbedStep, {
            record: normalizedRecord(),
            dryRun: false,
        });

        expect(mocks.embedMany).toHaveBeenCalledTimes(2);
        expect(out.chunks).toBeGreaterThan(0);
    }, 15_000);

    it('logs with the [challenge-ingestion:chunk-and-embed] prefix', async () => {
        await runStep(_testing.chunkAndEmbedStep, {
            record: normalizedRecord(),
            dryRun: false,
        });

        const messages = mocks.logger.info.mock.calls.map((c) => String(c[0]));
        expect(messages.some((m) => m.startsWith('[challenge-ingestion:chunk-and-embed]'))).toBe(
            true,
        );
    });
});

// ---------------------------------------------------------------------------
// upsert-vectors
// ---------------------------------------------------------------------------

describe('upsert-vectors step', () => {
    function embedded(overrides: Partial<EmbedOutput> = {}): EmbedOutput {
        return {
            challengeId: CHALLENGE_ID,
            projectId: '4321',
            dryRun: false,
            skipped: false,
            chunks: 2,
            forceSplits: [],
            vectorIds: ['id-1', 'id-2'],
            embeddings: [[0.1], [0.2]],
            metadata: [
                { challengeId: CHALLENGE_ID, chunkIndex: 1 } as unknown as ChunkMetadata,
                { challengeId: CHALLENGE_ID, chunkIndex: 2 } as unknown as ChunkMetadata,
            ],
            ...overrides,
        };
    }

    it('ensures the index and upserts with deleteFilter for atomic per-challenge replacement', async () => {
        const report = await runStep<Report>(_testing.upsertVectorsStep, embedded());

        expect(mocks.ensureChallengeIndex).toHaveBeenCalledTimes(1);
        expect(mocks.upsert).toHaveBeenCalledTimes(1);
        expect(mocks.upsert.mock.calls[0][0]).toEqual({
            indexName: 'challenge_embeddings',
            vectors: [[0.1], [0.2]],
            metadata: embedded().metadata,
            ids: ['id-1', 'id-2'],
            deleteFilter: { challengeId: CHALLENGE_ID },
        });
        expect(report).toEqual({
            chunks: 2,
            forceSplits: [],
            dryRun: false,
            skipped: false,
            projectId: '4321',
        });
    });

    it('indexes a challenge with a null projectId', async () => {
        const report = await runStep<Report>(
            _testing.upsertVectorsStep,
            embedded({ projectId: null }),
        );

        expect(mocks.upsert).toHaveBeenCalledTimes(1);
        expect(report.projectId).toBeNull();
    });

    it('does not upsert on dryRun', async () => {
        const report = await runStep<Report>(_testing.upsertVectorsStep, embedded({ dryRun: true }));

        expect(mocks.upsert).not.toHaveBeenCalled();
        expect(mocks.ensureChallengeIndex).not.toHaveBeenCalled();
        expect(report.dryRun).toBe(true);
        expect(report.chunks).toBe(2);
    });

    it('does not upsert when the record was skipped', async () => {
        const report = await runStep<Report>(
            _testing.upsertVectorsStep,
            embedded({ skipped: true, chunks: 0, embeddings: [], vectorIds: [], metadata: [] }),
        );

        expect(mocks.upsert).not.toHaveBeenCalled();
        expect(report.skipped).toBe(true);
        expect(report.chunks).toBe(0);
    });

    it('distinguishes a database failure from an embedding failure and leaves no partial state', async () => {
        mocks.upsert.mockRejectedValue(new Error('duplicate key value'));

        await expect(runStep(_testing.upsertVectorsStep, embedded())).rejects.toThrow(
            /database failure.*duplicate key value/s,
        );
        await expect(runStep(_testing.upsertVectorsStep, embedded())).rejects.not.toThrow(
            /embedding failure/,
        );
        // The single upsert call (delete + insert in one transaction) is the only
        // write attempted, so a failure cannot leave partially indexed chunks.
        expect(mocks.upsert).toHaveBeenCalledTimes(2);
    });

    it('surfaces an actionable dimension-mismatch error from ensureChallengeIndex', async () => {
        mocks.ensureChallengeIndex.mockRejectedValue(
            new Error(
                'Dimension mismatch: vector index "challenge_embeddings" has dimension 1024, ' +
                'but the configured embedding model requires dimension 768.',
            ),
        );

        await expect(runStep(_testing.upsertVectorsStep, embedded())).rejects.toThrow(
            /Dimension mismatch.*dimension 1024.*dimension 768/s,
        );
        expect(mocks.upsert).not.toHaveBeenCalled();
    });

    it('logs with the [challenge-ingestion:upsert-vectors] prefix', async () => {
        await runStep(_testing.upsertVectorsStep, embedded());

        const messages = mocks.logger.info.mock.calls.map((c) => String(c[0]));
        expect(messages.some((m) => m.startsWith('[challenge-ingestion:upsert-vectors]'))).toBe(
            true,
        );
    });
});

// ---------------------------------------------------------------------------
// End-to-end (steps chained manually)
// ---------------------------------------------------------------------------

describe('challenge-ingestion end to end', () => {
    it('ingests by challengeId and upserts, writing nothing to console (D6)', async () => {
        const consoleSpies = [
            vi.spyOn(console, 'log').mockImplementation(() => undefined),
            vi.spyOn(console, 'info').mockImplementation(() => undefined),
            vi.spyOn(console, 'warn').mockImplementation(() => undefined),
            vi.spyOn(console, 'error').mockImplementation(() => undefined),
        ];

        const resolved = await runStep<ResolveOutput>(_testing.resolveChallengeStep, {
            challengeId: CHALLENGE_ID,
            dryRun: false,
        });
        const embeddedOut = await runStep<EmbedOutput>(_testing.chunkAndEmbedStep, resolved);
        const report = await runStep<Report>(_testing.upsertVectorsStep, embeddedOut);

        expect(Object.keys(report).sort()).toEqual(
            ['chunks', 'dryRun', 'forceSplits', 'projectId', 'skipped'].sort(),
        );
        expect(report.chunks).toBeGreaterThan(0);
        expect(report.dryRun).toBe(false);
        expect(report.skipped).toBe(false);
        expect(report.projectId).toBe('4321');
        expect(mocks.upsert).toHaveBeenCalledTimes(1);
        for (const spy of consoleSpies) {
            expect(spy).not.toHaveBeenCalled();
        }
    });

    it('re-ingestion preserves vector ids and chunk count', async () => {
        const first = await runStep<EmbedOutput>(_testing.chunkAndEmbedStep, {
            record: normalizedRecord(),
            dryRun: false,
        });
        await runStep<Report>(_testing.upsertVectorsStep, first);
        const firstIds: string[] = mocks.upsert.mock.calls[0][0].ids;

        const second = await runStep<EmbedOutput>(_testing.chunkAndEmbedStep, {
            record: normalizedRecord(),
            dryRun: false,
        });
        await runStep<Report>(_testing.upsertVectorsStep, second);
        const secondIds: string[] = mocks.upsert.mock.calls[1][0].ids;

        expect(secondIds).toEqual(firstIds);
        expect(second.chunks).toBe(first.chunks);
    });

    it('modified re-ingestion replaces chunks atomically via deleteFilter', async () => {
        const modified = await runStep<EmbedOutput>(_testing.chunkAndEmbedStep, {
            record: normalizedRecord({ description: 'Completely different body text now.' }),
            dryRun: false,
        });
        await runStep<Report>(_testing.upsertVectorsStep, modified);

        const call = mocks.upsert.mock.calls[0][0];
        expect(call.deleteFilter).toEqual({ challengeId: CHALLENGE_ID });
        expect(call.ids).toHaveLength(modified.chunks);
    });

    it('dryRun chunks and embeds but does not upsert', async () => {
        const resolved = await runStep<ResolveOutput>(_testing.resolveChallengeStep, {
            challengeId: CHALLENGE_ID,
            dryRun: true,
        });
        const embeddedOut = await runStep<EmbedOutput>(_testing.chunkAndEmbedStep, resolved);
        const report = await runStep<Report>(_testing.upsertVectorsStep, embeddedOut);

        expect(mocks.embedMany).toHaveBeenCalledTimes(1);
        expect(mocks.upsert).not.toHaveBeenCalled();
        expect(report.dryRun).toBe(true);
        expect(report.chunks).toBeGreaterThan(0);
    });

    it('ingests an inline record without calling fetchChallengeTool', async () => {
        const resolved = await runStep<ResolveOutput>(_testing.resolveChallengeStep, {
            challenge: {
                id: 'inline-e2e',
                name: 'Inline E2E',
                description: 'Inline description body for the end to end test.',
                skills: ['TypeScript'],
                projectId: null,
                groups: [],
            },
            dryRun: false,
        });
        const embeddedOut = await runStep<EmbedOutput>(_testing.chunkAndEmbedStep, resolved);
        const report = await runStep<Report>(_testing.upsertVectorsStep, embeddedOut);

        expect(mocks.fetchExecute).not.toHaveBeenCalled();
        expect(report.chunks).toBeGreaterThan(0);
        expect(report.projectId).toBeNull();
        expect(mocks.upsert.mock.calls[0][0].deleteFilter).toEqual({ challengeId: 'inline-e2e' });
    });
});
