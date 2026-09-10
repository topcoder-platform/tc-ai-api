import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
    embed: vi.fn(),
    createEmbeddingModel: vi.fn(() => ({ modelId: 'mock-embedding-model' })),
    storeQuery: vi.fn(),
    getRagConfig: vi.fn(),
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.mock('ai', async (importOriginal) => {
    const actual = await importOriginal<typeof import('ai')>();
    return { ...actual, embed: mocks.embed };
});

vi.mock('../../../utils/providers/embedding-factory', () => ({
    createEmbeddingModel: mocks.createEmbeddingModel,
}));

vi.mock('../../vector/challenge-vector-store', () => ({
    ensureChallengeIndex: async () => ({ query: mocks.storeQuery }),
}));

vi.mock('../../../config/rag.config', () => ({
    getRagConfig: mocks.getRagConfig,
}));

vi.mock('../../../utils/logger', () => ({
    tcAILogger: mocks.logger,
}));

import { challengeVectorQueryTool, _testing } from './challenge-vector-query-tool';

const { buildMetadataFilter } = _testing;

const minimalContext = {
    mastra: undefined,
    requestContext: { get: (key: string) => (key === 'user' ? { sub: 'test-user' } : undefined) },
} as any;

async function executeTool(input: Record<string, unknown>): Promise<any> {
    return challengeVectorQueryTool.execute?.(input, minimalContext) as Promise<any>;
}

function defaultConfig() {
    return {
        embedding: { provider: 'AWSBedrock', modelId: 'amazon.titan-embed-text-v2:0', dimension: 1024, maxContextWindow: 8192 },
        vectorIndexName: 'challenge_embeddings',
        vectorSearchThreshold: 0.5,
        chunkMaxSize: 512,
        chunkOverlap: 50,
        topK: 10,
        challengeSearchAI: { provider: 'AWSBedrock', modelId: 'model' },
        database: { connectionString: 'postgres://x', schemaName: 'ai' },
        knownTypes: [],
        knownTracks: [],
    };
}

function hit(overrides: Record<string, unknown> = {}) {
    return {
        id: 'vec-1',
        score: 0.9,
        metadata: {
            challengeId: 'challenge-1',
            name: 'Test Challenge',
            type: 'Challenge',
            track: 'Development',
            skills: ['React'],
            groups: ['acme'],
            projectId: '17423',
            chunkIndex: 1,
            totalChunks: 3,
            text: 'chunk text',
        },
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRagConfig.mockReturnValue(defaultConfig());
    mocks.embed.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });
    mocks.storeQuery.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// buildMetadataFilter
// ---------------------------------------------------------------------------

describe('buildMetadataFilter', () => {
    it('returns undefined when no filter dimension is present', () => {
        expect(buildMetadataFilter({})).toBeUndefined();
    });

    it('composes $eq for type and track', () => {
        expect(buildMetadataFilter({ type: 'Challenge', track: 'Development' })).toEqual({
            $and: [{ type: { $eq: 'Challenge' } }, { track: { $eq: 'Development' } }],
        });
    });

    it('composes $in for skills and groups', () => {
        expect(buildMetadataFilter({ skills: ['React', 'TypeScript'], groups: ['g1'] })).toEqual({
            $and: [{ skills: { $in: ['React', 'TypeScript'] } }, { groups: { $in: ['g1'] } }],
        });
    });

    it('normalizes a single projectId string into $in', () => {
        expect(buildMetadataFilter({ projectId: '17423' })).toEqual({
            $and: [{ projectId: { $in: ['17423'] } }],
        });
    });

    it('passes an array projectId through to $in', () => {
        expect(buildMetadataFilter({ projectId: ['1', '2'] })).toEqual({
            $and: [{ projectId: { $in: ['1', '2'] } }],
        });
    });

    it('ignores an empty skills/groups array', () => {
        expect(buildMetadataFilter({ skills: [], groups: [] })).toBeUndefined();
    });

    it('combines every dimension into one $and array', () => {
        const filter = buildMetadataFilter({
            type: 'Challenge',
            track: 'Development',
            skills: ['React'],
            groups: ['acme'],
            projectId: '17423',
        });
        expect(filter.$and).toHaveLength(5);
    });
});

// ---------------------------------------------------------------------------
// execute — input validation
// ---------------------------------------------------------------------------

describe('challengeVectorQueryTool — input validation', () => {
    it('fails when neither query nor a filter is supplied', async () => {
        const result = await executeTool({});
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/at least one of query or a filter/i);
        expect(mocks.storeQuery).not.toHaveBeenCalled();
    });

    it('fails when query is only whitespace and no filter is supplied', async () => {
        const result = await executeTool({ query: '   ' });
        expect(result.success).toBe(false);
        expect(mocks.storeQuery).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// execute — semantic query path
// ---------------------------------------------------------------------------

describe('challengeVectorQueryTool — semantic query path', () => {
    it('embeds the query and queries the store with the resulting vector', async () => {
        mocks.storeQuery.mockResolvedValue([hit()]);

        const result = await executeTool({ query: 'realtime dashboard' });

        expect(mocks.createEmbeddingModel).toHaveBeenCalledWith('AWSBedrock', 'amazon.titan-embed-text-v2:0', 'challenge-vector-query-tool');
        expect(mocks.embed).toHaveBeenCalledWith(
            expect.objectContaining({ value: 'realtime dashboard' }),
        );
        expect(mocks.storeQuery).toHaveBeenCalledWith({
            indexName: 'challenge_embeddings',
            queryVector: [0.1, 0.2, 0.3],
            topK: 10,
            filter: undefined,
        });
        expect(result.success).toBe(true);
        expect(result.count).toBe(1);
        expect(result.results[0]).toEqual({
            text: 'chunk text',
            score: 0.9,
            metadata: {
                challengeId: 'challenge-1',
                name: 'Test Challenge',
                type: 'Challenge',
                track: 'Development',
                skills: ['React'],
                groups: ['acme'],
                projectId: '17423',
                chunkIndex: 1,
                totalChunks: 3,
            },
        });
    });

    it('never passes minScore to store.query (post-filters in app code instead)', async () => {
        mocks.storeQuery.mockResolvedValue([hit({ score: 0.9 }), hit({ score: 0.1 })]);

        const result = await executeTool({ query: 'test', minScore: 0.5 });

        const callArgs = mocks.storeQuery.mock.calls[0][0];
        expect(callArgs).not.toHaveProperty('minScore');
        expect(result.count).toBe(1);
        expect(result.results[0].score).toBe(0.9);
    });

    it('applies the configured minScore when none is supplied', async () => {
        mocks.storeQuery.mockResolvedValue([hit({ score: 0.6 }), hit({ score: 0.4 })]);

        const result = await executeTool({ query: 'test' });

        expect(result.count).toBe(1);
        expect(result.results[0].score).toBe(0.6);
    });

    it('warns but still succeeds when every result falls below threshold', async () => {
        mocks.storeQuery.mockResolvedValue([hit({ score: 0.1 })]);

        const result = await executeTool({ query: 'test', minScore: 0.5 });

        expect(result.success).toBe(true);
        expect(result.count).toBe(0);
        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('below threshold'));
    });

    it('respects an explicit topK override', async () => {
        mocks.storeQuery.mockResolvedValue([]);
        await executeTool({ query: 'test', topK: 3 });
        expect(mocks.storeQuery).toHaveBeenCalledWith(expect.objectContaining({ topK: 3 }));
    });

    it('composes filters alongside the query', async () => {
        mocks.storeQuery.mockResolvedValue([]);
        await executeTool({ query: 'test', type: 'Challenge', skills: ['React'] });
        expect(mocks.storeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                filter: { $and: [{ type: { $eq: 'Challenge' } }, { skills: { $in: ['React'] } }] },
            }),
        );
    });
});

// ---------------------------------------------------------------------------
// execute — metadata-only path (D8/D10, no query)
// ---------------------------------------------------------------------------

describe('challengeVectorQueryTool — metadata-only path', () => {
    it('skips embedding and queries with no queryVector when only a filter is supplied', async () => {
        mocks.storeQuery.mockResolvedValue([hit({ score: 0 })]);

        const result = await executeTool({ projectId: '17423' });

        expect(mocks.embed).not.toHaveBeenCalled();
        expect(mocks.storeQuery).toHaveBeenCalledWith({
            indexName: 'challenge_embeddings',
            queryVector: undefined,
            topK: 10,
            filter: { $and: [{ projectId: { $in: ['17423'] } }] },
        });
        expect(result.success).toBe(true);
        expect(result.count).toBe(1);
    });

    it('does not threshold score:0 metadata-only rows even with a high minScore', async () => {
        mocks.storeQuery.mockResolvedValue([hit({ score: 0 }), hit({ score: 0 })]);

        const result = await executeTool({ projectId: '17423', minScore: 0.9 });

        expect(result.count).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// execute — error path
// ---------------------------------------------------------------------------

describe('challengeVectorQueryTool — error path', () => {
    it('returns success:false with the error message when the store throws', async () => {
        mocks.storeQuery.mockRejectedValue(new Error('connection refused'));

        const result = await executeTool({ query: 'test' });

        expect(result.success).toBe(false);
        expect(result.error).toBe('connection refused');
        expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
    });

    it('returns success:false when the embedding call fails', async () => {
        mocks.embed.mockRejectedValue(new Error('embedding provider unavailable'));

        const result = await executeTool({ query: 'test' });

        expect(result.success).toBe(false);
        expect(result.error).toBe('embedding provider unavailable');
        expect(mocks.storeQuery).not.toHaveBeenCalled();
    });
});
