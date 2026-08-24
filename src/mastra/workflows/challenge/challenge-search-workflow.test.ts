import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
    queryExecute: vi.fn(),
    getRagConfig: vi.fn(() => ({ topK: 10, vectorSearchThreshold: 0.5 })),
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.mock('../../tools/challenge/challenge-vector-query-tool', () => ({
    challengeVectorQueryTool: { execute: mocks.queryExecute },
}));

vi.mock('../../../config/rag.config', () => ({
    getRagConfig: mocks.getRagConfig,
}));

vi.mock('../../../utils/logger', () => ({
    tcAILogger: mocks.logger,
}));

import { challengeSearchWorkflow, _testing } from './challenge-search-workflow';

const { searchChallengesStep } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hit(overrides: Record<string, unknown> = {}) {
    return {
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
        ...overrides,
    };
}

interface StepExecutor {
    execute: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

async function runStep(inputData: Record<string, unknown>): Promise<any> {
    const executable = searchChallengesStep as unknown as StepExecutor;
    return executable.execute({ inputData, requestContext: {} });
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRagConfig.mockReturnValue({ topK: 10, vectorSearchThreshold: 0.5 });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('challenge-search:search-challenges — input validation', () => {
    it('throws when neither query nor a filter is supplied', async () => {
        await expect(runStep({})).rejects.toThrow(/at least one of query or a filter/i);
        expect(mocks.queryExecute).not.toHaveBeenCalled();
    });

    it('proceeds with a filter-only input (no query)', async () => {
        mocks.queryExecute.mockResolvedValue({ success: true, results: [] });
        await expect(runStep({ projectId: '17423' })).resolves.toBeTruthy();
        expect(mocks.queryExecute).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Tool delegation
// ---------------------------------------------------------------------------

describe('challenge-search:search-challenges — tool delegation', () => {
    it('passes query, filters, topK and minScore through to the shared tool', async () => {
        mocks.queryExecute.mockResolvedValue({ success: true, results: [] });

        await runStep({
            query: 'realtime dashboard',
            skills: ['React'],
            type: 'Challenge',
            track: 'Development',
            groups: ['acme'],
            projectId: '17423',
            topK: 5,
            minScore: 0.4,
        });

        expect(mocks.queryExecute).toHaveBeenCalledWith(
            {
                query: 'realtime dashboard',
                skills: ['React'],
                type: 'Challenge',
                track: 'Development',
                groups: ['acme'],
                projectId: '17423',
                topK: 5,
                minScore: 0.4,
            },
            expect.objectContaining({ requestContext: {} }),
        );
    });

    it('throws when the tool reports failure', async () => {
        mocks.queryExecute.mockResolvedValue({ success: false, error: 'connection refused' });
        await expect(runStep({ query: 'test' })).rejects.toThrow(/connection refused/);
    });

    it('throws when the tool call itself rejects', async () => {
        mocks.queryExecute.mockRejectedValue(new Error('embedding provider unavailable'));
        await expect(runStep({ query: 'test' })).rejects.toThrow(/embedding provider unavailable/);
    });
});

// ---------------------------------------------------------------------------
// groupBy: chunk
// ---------------------------------------------------------------------------

describe('challenge-search:search-challenges — groupBy chunk', () => {
    it('returns raw hits ordered by descending score, no grouping', async () => {
        mocks.queryExecute.mockResolvedValue({
            success: true,
            results: [hit({ score: 0.3 }), hit({ score: 0.9 })],
        });

        const result = await runStep({ query: 'test', groupBy: 'chunk' });

        expect(result.groupBy).toBe('chunk');
        expect(result.count).toBe(2);
        expect(result.results.map((r: any) => r.score)).toEqual([0.9, 0.3]);
        expect(result.results[0]).toMatchObject({ text: 'chunk text', challengeId: 'challenge-1' });
    });
});

// ---------------------------------------------------------------------------
// groupBy: challenge (default)
// ---------------------------------------------------------------------------

describe('challenge-search:search-challenges — groupBy challenge (default)', () => {
    it('groups chunks by challengeId, using the best chunk score as the challenge score', async () => {
        mocks.queryExecute.mockResolvedValue({
            success: true,
            results: [
                hit({ score: 0.5, metadata: { ...hit().metadata, chunkIndex: 2 } }),
                hit({ score: 0.9, metadata: { ...hit().metadata, chunkIndex: 1 } }),
            ],
        });

        const result = await runStep({ query: 'test' });

        expect(result.groupBy).toBe('challenge');
        expect(result.count).toBe(1);
        const [entry] = result.results;
        expect(entry.challengeId).toBe('challenge-1');
        expect(entry.score).toBe(0.9);
        expect(entry.name).toBe('Test Challenge');
        expect(entry.chunks).toHaveLength(2);
        expect(entry.chunks[0].score).toBe(0.9);
        expect(entry.chunks[1].score).toBe(0.5);
    });

    it('produces one entry per distinct challenge, ranked by best score', async () => {
        mocks.queryExecute.mockResolvedValue({
            success: true,
            results: [
                hit({ score: 0.4, metadata: { ...hit().metadata, challengeId: 'challenge-2' } }),
                hit({ score: 0.95, metadata: { ...hit().metadata, challengeId: 'challenge-1' } }),
            ],
        });

        const result = await runStep({ query: 'test' });

        expect(result.count).toBe(2);
        expect(result.results.map((r: any) => r.challengeId)).toEqual(['challenge-1', 'challenge-2']);
    });

    it('defaults to challenge grouping when groupBy is omitted', async () => {
        mocks.queryExecute.mockResolvedValue({ success: true, results: [hit()] });
        const result = await runStep({ query: 'test' });
        expect(result.groupBy).toBe('challenge');
    });
});

// ---------------------------------------------------------------------------
// groupBy: project
// ---------------------------------------------------------------------------

describe('challenge-search:search-challenges — groupBy project', () => {
    it('rolls chunks up by projectId and lists distinct contributing challengeIds', async () => {
        mocks.queryExecute.mockResolvedValue({
            success: true,
            results: [
                hit({ score: 0.6, metadata: { ...hit().metadata, challengeId: 'challenge-1' } }),
                hit({ score: 0.8, metadata: { ...hit().metadata, challengeId: 'challenge-2' } }),
            ],
        });

        const result = await runStep({ projectId: '17423', groupBy: 'project' });

        expect(result.groupBy).toBe('project');
        expect(result.count).toBe(1);
        const [entry] = result.results;
        expect(entry.projectId).toBe('17423');
        expect(entry.score).toBe(0.8);
        expect(entry.challengeIds.sort()).toEqual(['challenge-1', 'challenge-2']);
        expect(entry.chunks).toHaveLength(2);
    });

    it('groups a null projectId separately from string projectIds', async () => {
        mocks.queryExecute.mockResolvedValue({
            success: true,
            results: [
                hit({ score: 0.5, metadata: { ...hit().metadata, projectId: null } }),
                hit({ score: 0.7, metadata: { ...hit().metadata, projectId: '17423' } }),
            ],
        });

        const result = await runStep({ type: 'Challenge', groupBy: 'project' });

        expect(result.count).toBe(2);
        const projectIds = result.results.map((r: any) => r.projectId);
        expect(projectIds).toContain(null);
        expect(projectIds).toContain('17423');
    });
});

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

describe('challengeSearchWorkflow', () => {
    it('is registered with id challenge-search', () => {
        expect(challengeSearchWorkflow.id).toBe('challenge-search');
    });
});
