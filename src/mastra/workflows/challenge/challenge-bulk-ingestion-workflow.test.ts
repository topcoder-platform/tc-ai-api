import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
    searchExecute: vi.fn(),
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.mock('../../tools/challenge/search-challenges-tool', () => ({
    searchChallengesTool: { execute: mocks.searchExecute },
}));

vi.mock('../../../utils/logger', () => ({
    tcAILogger: mocks.logger,
}));

// Import after mocks are set up
import { challengeBulkIngestionWorkflow, _testing } from './challenge-bulk-ingestion-workflow';

const {
    collectChallengesStep,
    ingestOneChallengeStep,
    aggregateReportsStep,
    resolveConcurrency,
    foreachConcurrency,
} = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StepExecutor {
    execute: (params: Record<string, unknown>) => Promise<unknown>;
}

async function runStep<T>(step: unknown, params: Record<string, unknown>): Promise<T> {
    const executable = step as unknown as StepExecutor;
    return (await executable.execute({
        requestContext: {},
        getInitData: () => ({}),
        ...params,
    })) as T;
}

interface ChallengeTask {
    challengeId: string;
    name: string;
    dryRun: boolean;
}

interface ChallengeResult {
    challengeId: string;
    name: string;
    status: 'success' | 'failed';
    error?: string;
    chunks: number;
    skipped: boolean;
    dryRun: boolean;
    forceSplits: unknown[];
    projectId: string | null;
}

interface BulkReport {
    processed: number;
    succeeded: number;
    failed: number;
    skipped: number;
    totalChunks: number;
    forceSplits: unknown[];
    dryRun: boolean;
    results: ChallengeResult[];
}

function summary(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        name: `Challenge ${id}`,
        status: 'Active',
        tags: [],
        skills: [],
        ...overrides,
    };
}

/** A search page result as returned by searchChallengesTool. */
function page(challenges: Record<string, unknown>[], pageNumber: number, perPage: number) {
    return {
        challenges,
        total: challenges.length,
        page: pageNumber,
        perPage,
    };
}

function ingestionReport(overrides: Record<string, unknown> = {}) {
    return {
        chunks: 3,
        forceSplits: [],
        dryRun: false,
        skipped: false,
        projectId: '4321',
        ...overrides,
    };
}

/** Builds a mastra stub whose challenge-ingestion run resolves to `runResult`. */
function mastraStub(runResult: unknown) {
    const start = vi.fn().mockResolvedValue(runResult);
    const createRun = vi.fn().mockResolvedValue({ start });
    const getWorkflowById = vi.fn().mockReturnValue({ createRun });
    return { mastra: { getWorkflowById }, getWorkflowById, createRun, start };
}

function challengeResult(overrides: Partial<ChallengeResult> = {}): ChallengeResult {
    return {
        challengeId: 'c1',
        name: 'Challenge c1',
        status: 'success',
        chunks: 2,
        skipped: false,
        dryRun: false,
        forceSplits: [],
        projectId: '4321',
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Workflow shape / registration contract
// ---------------------------------------------------------------------------

describe('challengeBulkIngestionWorkflow', () => {
    it('is registered with id challenge-bulk-ingestion', () => {
        expect(challengeBulkIngestionWorkflow.id).toBe('challenge-bulk-ingestion');
    });

    it('exposes the three pipeline steps in order', () => {
        const ids = Object.keys(challengeBulkIngestionWorkflow.steps);
        expect(ids).toEqual([
            'collect-challenges',
            'ingest-one-challenge',
            'aggregate-reports',
        ]);
    });
});

// ---------------------------------------------------------------------------
// Step 1 – collect-challenges (pagination + filters)
// ---------------------------------------------------------------------------

describe('collect-challenges step', () => {
    it('defaults the status filter to ACTIVE + COMPLETED, one scalar pass each', async () => {
        mocks.searchExecute.mockResolvedValue(page([], 1, 20));

        await runStep<ChallengeTask[]>(collectChallengesStep, { inputData: {} });

        expect(mocks.searchExecute).toHaveBeenCalledTimes(2);
        expect(mocks.searchExecute.mock.calls.map((call) => call[0].status)).toEqual([
            ['ACTIVE'],
            ['COMPLETED'],
        ]);
        expect(mocks.searchExecute.mock.calls[0][0]).toMatchObject({ page: 1, perPage: 20 });
    });

    it('forwards an explicit status filter instead of the default', async () => {
        mocks.searchExecute.mockResolvedValueOnce(page([], 1, 20));

        await runStep<ChallengeTask[]>(collectChallengesStep, {
            inputData: { status: ['DRAFT'] },
        });

        expect(mocks.searchExecute).toHaveBeenCalledTimes(1);
        expect(mocks.searchExecute.mock.calls[0][0].status).toEqual(['DRAFT']);
    });

    it('de-duplicates a challenge returned by more than one status pass', async () => {
        mocks.searchExecute
            .mockResolvedValueOnce(page([summary('a'), summary('b')], 1, 20))
            .mockResolvedValueOnce(page([summary('b'), summary('c')], 1, 20));

        const tasks = await runStep<ChallengeTask[]>(collectChallengesStep, { inputData: {} });

        expect(tasks.map((task) => task.challengeId)).toEqual(['a', 'b', 'c']);
    });

    it('forwards projectId, types, tracks, tags, groups and updatedDateStart filters', async () => {
        mocks.searchExecute.mockResolvedValueOnce(page([], 1, 20));

        await runStep<ChallengeTask[]>(collectChallengesStep, {
            inputData: {
                status: ['ACTIVE'],
                projectId: '4321',
                types: ['Challenge'],
                tracks: ['Development'],
                tags: ['React'],
                groups: ['group-a'],
                updatedDateStart: '2026-01-01T00:00:00.000Z',
            },
        });

        expect(mocks.searchExecute.mock.calls[0][0]).toMatchObject({
            projectId: '4321',
            types: ['Challenge'],
            tracks: ['Development'],
            tags: ['React'],
            groups: ['group-a'],
            updatedDateStart: '2026-01-01T00:00:00.000Z',
        });
    });

    it('paginates until a short page is returned', async () => {
        mocks.searchExecute
            .mockResolvedValueOnce(page([summary('a'), summary('b')], 1, 2))
            .mockResolvedValueOnce(page([summary('c'), summary('d')], 2, 2))
            .mockResolvedValueOnce(page([summary('e')], 3, 2));

        const tasks = await runStep<ChallengeTask[]>(collectChallengesStep, {
            inputData: { status: ['ACTIVE'], perPage: 2 },
        });

        expect(mocks.searchExecute).toHaveBeenCalledTimes(3);
        expect(mocks.searchExecute.mock.calls.map((call) => call[0].page)).toEqual([1, 2, 3]);
        expect(tasks.map((task) => task.challengeId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('stops when a full page is followed by an empty page', async () => {
        mocks.searchExecute
            .mockResolvedValueOnce(page([summary('a'), summary('b')], 1, 2))
            .mockResolvedValueOnce(page([], 2, 2));

        const tasks = await runStep<ChallengeTask[]>(collectChallengesStep, {
            inputData: { status: ['ACTIVE'], perPage: 2 },
        });

        expect(mocks.searchExecute).toHaveBeenCalledTimes(2);
        expect(tasks).toHaveLength(2);
    });

    it('never derives a page count from total (total is the current page length)', async () => {
        // total === 1 on a full page of 1 would yield 1 page if treated as a
        // grand total; the short-page rule must keep paginating instead.
        mocks.searchExecute
            .mockResolvedValueOnce(page([summary('a')], 1, 1))
            .mockResolvedValueOnce(page([summary('b')], 2, 1))
            .mockResolvedValueOnce(page([], 3, 1));

        const tasks = await runStep<ChallengeTask[]>(collectChallengesStep, {
            inputData: { status: ['ACTIVE'], perPage: 1 },
        });

        expect(mocks.searchExecute).toHaveBeenCalledTimes(3);
        expect(tasks.map((task) => task.challengeId)).toEqual(['a', 'b']);
    });

    it('stops at the maxPages guard and warns', async () => {
        mocks.searchExecute.mockResolvedValue(page([summary('a'), summary('b')], 1, 2));

        const tasks = await runStep<ChallengeTask[]>(collectChallengesStep, {
            inputData: { status: ['ACTIVE'], perPage: 2, maxPages: 2 },
        });

        expect(mocks.searchExecute).toHaveBeenCalledTimes(2);
        expect(tasks).toHaveLength(2); // duplicate ids across pages are de-duplicated
        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('maxPages guard'));
    });

    it('returns an empty task list when zero challenges match', async () => {
        mocks.searchExecute.mockResolvedValue(page([], 1, 20));

        const tasks = await runStep<ChallengeTask[]>(collectChallengesStep, { inputData: {} });

        expect(tasks).toEqual([]);
    });

    it('propagates dryRun onto every task', async () => {
        mocks.searchExecute.mockResolvedValue(page([summary('a'), summary('b')], 1, 20));

        const tasks = await runStep<ChallengeTask[]>(collectChallengesStep, {
            inputData: { dryRun: true },
        });

        expect(tasks).toHaveLength(2);
        expect(tasks.every((task) => task.dryRun === true)).toBe(true);
    });

    it('skips challenges without a usable id', async () => {
        mocks.searchExecute.mockResolvedValue(
            page([summary('a'), { ...summary('x'), id: '' }, { ...summary('y'), id: undefined }], 1, 20),
        );

        const tasks = await runStep<ChallengeTask[]>(collectChallengesStep, { inputData: {} });

        expect(tasks.map((task) => task.challengeId)).toEqual(['a']);
    });

    it('throws when the search tool returns a validation error instead of results', async () => {
        mocks.searchExecute.mockResolvedValueOnce({ error: { message: 'bad input' } });

        await expect(
            runStep<ChallengeTask[]>(collectChallengesStep, { inputData: {} }),
        ).rejects.toThrow('did not return results for page 1');
    });

    it('logs and rethrows a search failure (a broken search aborts the run)', async () => {
        mocks.searchExecute.mockRejectedValueOnce(
            new Error('Failed to search challenges (HTTP 500)'),
        );

        await expect(
            runStep<ChallengeTask[]>(collectChallengesStep, { inputData: {} }),
        ).rejects.toThrow('Failed to search challenges (HTTP 500)');

        expect(mocks.logger.error).toHaveBeenCalledWith(
            expect.stringContaining('Search failed on page 1'),
        );
    });
});

// ---------------------------------------------------------------------------
// Step 2 – ingest-one-challenge (nested workflow invocation + isolation)
// ---------------------------------------------------------------------------

describe('ingest-one-challenge step', () => {
    const task: ChallengeTask = { challengeId: 'c1', name: 'Challenge c1', dryRun: false };

    it('runs challenge-ingestion via getWorkflowById + createRun + run.start', async () => {
        const stub = mastraStub({ status: 'success', result: ingestionReport() });

        const result = await runStep<ChallengeResult>(ingestOneChallengeStep, {
            inputData: task,
            mastra: stub.mastra,
        });

        expect(stub.getWorkflowById).toHaveBeenCalledWith('challenge-ingestion');
        expect(stub.createRun).toHaveBeenCalledTimes(1);
        expect(stub.start).toHaveBeenCalledWith(
            expect.objectContaining({ inputData: { challengeId: 'c1', dryRun: false } }),
        );
        expect(result).toMatchObject({
            challengeId: 'c1',
            status: 'success',
            chunks: 3,
            skipped: false,
            projectId: '4321',
        });
    });

    it('propagates dryRun into the nested run input', async () => {
        const stub = mastraStub({
            status: 'success',
            result: ingestionReport({ dryRun: true }),
        });

        const result = await runStep<ChallengeResult>(ingestOneChallengeStep, {
            inputData: { ...task, dryRun: true },
            mastra: stub.mastra,
        });

        expect(stub.start).toHaveBeenCalledWith(
            expect.objectContaining({ inputData: { challengeId: 'c1', dryRun: true } }),
        );
        expect(result.dryRun).toBe(true);
    });

    it('carries through a skipped ingestion report', async () => {
        const stub = mastraStub({
            status: 'success',
            result: ingestionReport({ chunks: 0, skipped: true, projectId: null }),
        });

        const result = await runStep<ChallengeResult>(ingestOneChallengeStep, {
            inputData: task,
            mastra: stub.mastra,
        });

        expect(result).toMatchObject({ status: 'success', skipped: true, chunks: 0, projectId: null });
    });

    it('returns a failed result (without throwing) when the nested run fails', async () => {
        const stub = mastraStub({ status: 'failed', error: new Error('embedding failure') });

        const result = await runStep<ChallengeResult>(ingestOneChallengeStep, {
            inputData: task,
            mastra: stub.mastra,
        });

        expect(result).toMatchObject({
            challengeId: 'c1',
            status: 'failed',
            error: 'embedding failure',
            chunks: 0,
        });
    });

    it('returns a failed result for a non-success, non-failed run status', async () => {
        const stub = mastraStub({ status: 'suspended' });

        const result = await runStep<ChallengeResult>(ingestOneChallengeStep, {
            inputData: task,
            mastra: stub.mastra,
        });

        expect(result.status).toBe('failed');
        expect(result.error).toContain('suspended');
    });

    it('returns a failed result when getWorkflowById throws', async () => {
        const mastra = {
            getWorkflowById: vi.fn(() => {
                throw new Error('workflow lookup exploded');
            }),
        };

        const result = await runStep<ChallengeResult>(ingestOneChallengeStep, {
            inputData: task,
            mastra,
        });

        expect(result).toMatchObject({ status: 'failed', error: 'workflow lookup exploded' });
    });

    it('returns a failed result when the ingestion workflow is not registered', async () => {
        const mastra = { getWorkflowById: vi.fn().mockReturnValue(undefined) };

        const result = await runStep<ChallengeResult>(ingestOneChallengeStep, {
            inputData: task,
            mastra,
        });

        expect(result.status).toBe('failed');
        expect(result.error).toContain('challenge-ingestion');
    });

    it('returns a failed result when createRun throws', async () => {
        const mastra = {
            getWorkflowById: vi.fn().mockReturnValue({
                createRun: vi.fn().mockRejectedValue(new Error('createRun exploded')),
            }),
        };

        const result = await runStep<ChallengeResult>(ingestOneChallengeStep, {
            inputData: task,
            mastra,
        });

        expect(result).toMatchObject({ status: 'failed', error: 'createRun exploded' });
    });

    it('returns a failed result when run.start throws', async () => {
        const mastra = {
            getWorkflowById: vi.fn().mockReturnValue({
                createRun: vi.fn().mockResolvedValue({
                    start: vi.fn().mockRejectedValue(new Error('run.start exploded')),
                }),
            }),
        };

        const result = await runStep<ChallengeResult>(ingestOneChallengeStep, {
            inputData: task,
            mastra,
        });

        expect(result).toMatchObject({ status: 'failed', error: 'run.start exploded' });
    });

    it('returns a failed result when mastra is unavailable', async () => {
        const result = await runStep<ChallengeResult>(ingestOneChallengeStep, {
            inputData: task,
            mastra: undefined,
        });

        expect(result.status).toBe('failed');
    });
});

// ---------------------------------------------------------------------------
// Concurrency resolution
// ---------------------------------------------------------------------------

describe('concurrency resolution', () => {
    it('defaults to 3 when concurrency is absent', () => {
        expect(foreachConcurrency({ getInitData: () => ({}) })).toBe(3);
        expect(foreachConcurrency({ getInitData: () => undefined })).toBe(3);
    });

    it('honours an explicit concurrency from the workflow input', () => {
        expect(foreachConcurrency({ getInitData: () => ({ concurrency: 7 }) })).toBe(7);
    });

    it('clamps concurrency to the bounded range', () => {
        expect(resolveConcurrency(0)).toBe(1);
        expect(resolveConcurrency(-5)).toBe(1);
        expect(resolveConcurrency(100)).toBe(10);
        expect(resolveConcurrency(2.7)).toBe(2);
        expect(resolveConcurrency(Number.NaN)).toBe(3);
        expect(resolveConcurrency('many')).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// Step 3 – aggregate-reports
// ---------------------------------------------------------------------------

describe('aggregate-reports step', () => {
    it('aggregates totals while retaining per-challenge entries', async () => {
        const results: ChallengeResult[] = [
            challengeResult({ challengeId: 'a', chunks: 2 }),
            challengeResult({
                challengeId: 'b',
                chunks: 4,
                forceSplits: [
                    {
                        recordId: 'b',
                        chunkIndex: 1,
                        originalTokens: 3000,
                        resultingChunks: 2,
                        reason: 'atomic block too large',
                    },
                ],
            }),
            challengeResult({ challengeId: 'c', chunks: 0, skipped: true }),
            challengeResult({ challengeId: 'd', status: 'failed', error: 'boom', chunks: 0 }),
        ];

        const report = await runStep<BulkReport>(aggregateReportsStep, { inputData: results });

        expect(report).toMatchObject({
            processed: 4,
            succeeded: 3,
            failed: 1,
            skipped: 1,
            totalChunks: 6,
            dryRun: false,
        });
        expect(report.forceSplits).toHaveLength(1);
        expect(report.results.map((entry) => entry.challengeId)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('produces zero-valued totals for zero matching challenges', async () => {
        const report = await runStep<BulkReport>(aggregateReportsStep, { inputData: [] });

        expect(report).toEqual({
            processed: 0,
            succeeded: 0,
            failed: 0,
            skipped: 0,
            totalChunks: 0,
            forceSplits: [],
            dryRun: false,
            results: [],
        });
    });

    it('reports dryRun: true from the workflow input even with zero matches', async () => {
        const report = await runStep<BulkReport>(aggregateReportsStep, {
            inputData: [],
            getInitData: () => ({ dryRun: true }),
        });

        expect(report.dryRun).toBe(true);
        expect(report.processed).toBe(0);
    });

    it('does not abort when every challenge failed', async () => {
        const results: ChallengeResult[] = [
            challengeResult({ challengeId: 'a', status: 'failed', error: 'boom', chunks: 0 }),
            challengeResult({ challengeId: 'b', status: 'failed', error: 'bang', chunks: 0 }),
        ];

        const report = await runStep<BulkReport>(aggregateReportsStep, { inputData: results });

        expect(report).toMatchObject({ processed: 2, succeeded: 0, failed: 2, totalChunks: 0 });
        expect(report.results.map((entry) => entry.error)).toEqual(['boom', 'bang']);
    });
});
