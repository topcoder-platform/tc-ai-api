import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
    getWorkflowById: vi.fn(),
    createRun: vi.fn(),
    runStart: vi.fn(),
}));

vi.mock('../mastra', () => ({
    mastra: { getWorkflowById: mocks.getWorkflowById },
}));

import { main, _testing } from './sync-challenges';

const { parseOptions } = _testing;

function successfulWorkflow(
    report: { processed: number; succeeded: number; failed: number; skipped: number; totalChunks: number } = {
        processed: 3,
        succeeded: 3,
        failed: 0,
        skipped: 0,
        totalChunks: 12,
    },
) {
    mocks.getWorkflowById.mockReturnValue({ createRun: mocks.createRun });
    mocks.createRun.mockResolvedValue({ start: mocks.runStart });
    mocks.runStart.mockResolvedValue({ status: 'success', result: report });
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    process.exitCode = undefined;
});

// ---------------------------------------------------------------------------
// parseOptions
// ---------------------------------------------------------------------------

describe('parseOptions', () => {
    it('defaults to no filters and LIVE mode', () => {
        expect(parseOptions([])).toEqual({
            projectId: undefined,
            status: undefined,
            types: undefined,
            tracks: undefined,
            updatedSince: undefined,
            dryRun: false,
            concurrency: undefined,
        });
    });

    it('parses --project-id, --updated-since and --dry-run', () => {
        expect(parseOptions(['--project-id', '17423', '--updated-since', '2026-08-01', '--dry-run'])).toMatchObject({
            projectId: '17423',
            updatedSince: '2026-08-01',
            dryRun: true,
        });
    });

    it('parses repeated --status/--types/--tracks into arrays', () => {
        const options = parseOptions(['--status', 'ACTIVE', '--status', 'COMPLETED', '--types', 'Challenge']);
        expect(options.status).toEqual(['ACTIVE', 'COMPLETED']);
        expect(options.types).toEqual(['Challenge']);
    });

    it('parses --concurrency as a number', () => {
        expect(parseOptions(['--concurrency', '5'])).toMatchObject({ concurrency: 5 });
    });
});

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

describe('main', () => {
    it('invokes challenge-bulk-ingestion with the parsed filters', async () => {
        successfulWorkflow();

        await main(['--project-id', '17423', '--status', 'ACTIVE', '--updated-since', '2026-08-01']);

        expect(mocks.getWorkflowById).toHaveBeenCalledWith('challenge-bulk-ingestion');
        expect(mocks.runStart).toHaveBeenCalledWith({
            inputData: {
                projectId: '17423',
                status: ['ACTIVE'],
                types: undefined,
                tracks: undefined,
                updatedDateStart: '2026-08-01',
                dryRun: false,
                concurrency: undefined,
            },
        });
    });

    it('reports success and leaves exitCode unset when nothing failed', async () => {
        successfulWorkflow({ processed: 5, succeeded: 5, failed: 0, skipped: 1, totalChunks: 20 });
        await main([]);
        expect(process.exitCode).toBeUndefined();
    });

    it('sets exitCode 1 when the bulk report has failures, without throwing', async () => {
        successfulWorkflow({ processed: 5, succeeded: 3, failed: 2, skipped: 0, totalChunks: 10 });
        await expect(main([])).resolves.toBeUndefined();
        expect(process.exitCode).toBe(1);
    });

    it('rejects when the workflow is not registered', async () => {
        mocks.getWorkflowById.mockReturnValue(undefined);
        await expect(main([])).rejects.toThrow(/not registered/i);
    });

    it('sets exitCode 1 without throwing when the run does not succeed', async () => {
        mocks.getWorkflowById.mockReturnValue({ createRun: mocks.createRun });
        mocks.createRun.mockResolvedValue({ start: mocks.runStart });
        mocks.runStart.mockResolvedValue({ status: 'failed', error: new Error('search API unreachable') });

        await expect(main([])).resolves.toBeUndefined();
        expect(process.exitCode).toBe(1);
    });
});
