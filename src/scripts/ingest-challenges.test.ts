import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
    getWorkflowById: vi.fn(),
    createRun: vi.fn(),
    runStart: vi.fn(),
    getRagConfig: vi.fn(),
    deleteIndex: vi.fn(),
    readlineAnswer: 'y',
}));

vi.mock('../mastra', () => ({
    mastra: { getWorkflowById: mocks.getWorkflowById },
}));

vi.mock('../config/rag.config', () => ({
    getRagConfig: mocks.getRagConfig,
}));

vi.mock('../mastra/vector/challenge-vector-store', () => ({
    getChallengeVectorStore: () => ({ deleteIndex: mocks.deleteIndex }),
}));

vi.mock('node:readline', () => ({
    createInterface: () => ({
        question: (_prompt: string, cb: (answer: string) => void) => cb(mocks.readlineAnswer),
        close: () => undefined,
    }),
}));

import { main, _testing } from './ingest-challenges';
import { IngestionLogger } from './ingestion-logger';
import type { IngestionReport } from '../mastra/rag/types';

const { parseOptions, getCsvFiles, processFile, runIngestionWorkflow } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-challenges-test-'));
    tmpDirs.push(dir);
    return dir;
}

function writeCsv(dir: string, filename: string, content: string): string {
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, content);
    return filePath;
}

const VALID_CSV = [
    '"id","name","description","descriptionFormat","typeName","trackName","skills"',
    '"c1","Challenge One","Body one","markdown","Challenge","Development","React"',
    '"c2","Challenge Two","Body two","markdown","Task","Quality Assurance","Selenium"',
].join('\n');

function defaultRagConfig() {
    return {
        embedding: { provider: 'TC-Ollama', modelId: 'nomic-embed-text', dimension: 768, maxContextWindow: 2048 },
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

function successfulWorkflow(report: { chunks: number; forceSplits: unknown[] } = { chunks: 3, forceSplits: [] }) {
    mocks.getWorkflowById.mockReturnValue({ createRun: mocks.createRun });
    mocks.createRun.mockResolvedValue({ start: mocks.runStart });
    mocks.runStart.mockResolvedValue({ status: 'success', result: report });
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.readlineAnswer = 'y';
    mocks.getRagConfig.mockReturnValue(defaultRagConfig());
});

afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// parseOptions
// ---------------------------------------------------------------------------

describe('parseOptions', () => {
    it('defaults folder to "data" when neither --file nor --folder is given', () => {
        expect(parseOptions([])).toEqual({ folder: 'data', file: undefined, dryRun: false, clearAll: false });
    });

    it('parses --file and leaves folder undefined', () => {
        expect(parseOptions(['--file', 'x.csv'])).toMatchObject({ file: 'x.csv', folder: undefined });
    });

    it('parses --folder explicitly', () => {
        expect(parseOptions(['--folder', 'custom'])).toMatchObject({ folder: 'custom' });
    });

    it('rejects both --file and --folder together', () => {
        expect(() => parseOptions(['--file', 'x.csv', '--folder', 'y'])).toThrow(/cannot use both/i);
    });

    it('parses --dry-run and --clear-all flags', () => {
        expect(parseOptions(['--dry-run', '--clear-all'])).toMatchObject({ dryRun: true, clearAll: true });
    });
});

// ---------------------------------------------------------------------------
// getCsvFiles
// ---------------------------------------------------------------------------

describe('getCsvFiles', () => {
    it('returns the single resolved file for --file', () => {
        const dir = tmpDir();
        const filePath = writeCsv(dir, 'a.csv', VALID_CSV);
        expect(getCsvFiles({ file: filePath, dryRun: false, clearAll: false })).toEqual([filePath]);
    });

    it('throws when --file does not exist', () => {
        expect(() => getCsvFiles({ file: '/nonexistent/x.csv', dryRun: false, clearAll: false })).toThrow(
            /file not found/i,
        );
    });

    it('throws when --folder does not exist', () => {
        expect(() => getCsvFiles({ folder: '/nonexistent/dir', dryRun: false, clearAll: false })).toThrow(
            /folder not found/i,
        );
    });

    it('throws when the folder has no .csv files', () => {
        const dir = tmpDir();
        fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
        expect(() => getCsvFiles({ folder: dir, dryRun: false, clearAll: false })).toThrow(/no csv files found/i);
    });

    it('returns every .csv file in the folder, ignoring non-csv files', () => {
        const dir = tmpDir();
        writeCsv(dir, 'a.csv', VALID_CSV);
        writeCsv(dir, 'b.csv', VALID_CSV);
        fs.writeFileSync(path.join(dir, 'readme.md'), 'ignore me');
        const files = getCsvFiles({ folder: dir, dryRun: false, clearAll: false });
        expect(files.map((f) => path.basename(f)).sort()).toEqual(['a.csv', 'b.csv']);
    });
});

// ---------------------------------------------------------------------------
// runIngestionWorkflow
// ---------------------------------------------------------------------------

describe('runIngestionWorkflow', () => {
    it('invokes challenge-ingestion via createRun().start() and returns chunks/forceSplits', async () => {
        successfulWorkflow({ chunks: 4, forceSplits: [{ chunkIndex: 0, originalTokens: 10, resultingChunks: 2, reason: 'code-block' }] });

        const result = await runIngestionWorkflow(
            { id: 'c1', name: 'Test', description: 'body' },
            false,
        );

        expect(mocks.getWorkflowById).toHaveBeenCalledWith('challenge-ingestion');
        expect(mocks.runStart).toHaveBeenCalledWith({
            inputData: { challenge: { id: 'c1', name: 'Test', description: 'body' }, dryRun: false },
        });
        expect(result.chunks).toBe(4);
        expect(result.forceSplits).toHaveLength(1);
    });

    it('throws when the workflow is not registered', async () => {
        mocks.getWorkflowById.mockReturnValue(undefined);
        await expect(runIngestionWorkflow({ id: 'c1', name: 'Test', description: 'body' }, false)).rejects.toThrow(
            /not registered/i,
        );
    });

    it('throws with the run error detail when the run does not succeed', async () => {
        mocks.getWorkflowById.mockReturnValue({ createRun: mocks.createRun });
        mocks.createRun.mockResolvedValue({ start: mocks.runStart });
        mocks.runStart.mockResolvedValue({ status: 'failed', error: new Error('embedding provider unavailable') });

        await expect(runIngestionWorkflow({ id: 'c1', name: 'Test', description: 'body' }, false)).rejects.toThrow(
            /embedding provider unavailable/,
        );
    });
});

// ---------------------------------------------------------------------------
// processFile
// ---------------------------------------------------------------------------

describe('processFile', () => {
    async function runProcessFile(csvContent: string, dryRun = false) {
        const dir = tmpDir();
        const filePath = writeCsv(dir, 'challenges.csv', csvContent);
        const logger = IngestionLogger.create(dir);
        const report: IngestionReport = {
            startTime: new Date().toISOString(),
            endTime: '',
            totals: { files: 1, records: 0, chunks: 0, errors: 0, forceSplits: 0 },
            files: {},
        };
        await processFile(filePath, logger, report, dryRun);
        await logger.close();
        return report;
    }

    it('ingests every valid row through runIngestionWorkflow and aggregates chunks', async () => {
        successfulWorkflow({ chunks: 3, forceSplits: [] });

        const report = await runProcessFile(VALID_CSV);

        expect(mocks.runStart).toHaveBeenCalledTimes(2);
        expect(report.totals.records).toBe(2);
        expect(report.totals.chunks).toBe(6);
        expect(report.totals.errors).toBe(0);
        expect(report.files['challenges.csv'].records).toBe(2);
    });

    it('passes dryRun through to the workflow input', async () => {
        successfulWorkflow({ chunks: 1, forceSplits: [] });
        await runProcessFile(VALID_CSV, true);
        expect(mocks.runStart).toHaveBeenCalledWith(expect.objectContaining({
            inputData: expect.objectContaining({ dryRun: true }),
        }));
    });

    it('records a per-row error and continues when a row fails validation', async () => {
        successfulWorkflow({ chunks: 2, forceSplits: [] });
        const csv = [
            '"id","name","description","descriptionFormat","typeName","trackName","skills"',
            '"","Missing Id","Body","markdown","Challenge","Development","React"',
            '"c2","Challenge Two","Body two","markdown","Task","Quality Assurance","Selenium"',
        ].join('\n');

        const report = await runProcessFile(csv);

        expect(report.totals.errors).toBe(1);
        expect(report.totals.records).toBe(1);
        expect(report.files['challenges.csv'].errors[0].message).toMatch(/missing id/i);
    });

    it('records a per-row error and continues when the workflow rejects for one row', async () => {
        mocks.getWorkflowById.mockReturnValue({ createRun: mocks.createRun });
        mocks.createRun.mockResolvedValue({ start: mocks.runStart });
        mocks.runStart
            .mockResolvedValueOnce({ status: 'success', result: { chunks: 2, forceSplits: [] } })
            .mockResolvedValueOnce({ status: 'failed', error: new Error('database unreachable') });

        const report = await runProcessFile(VALID_CSV);

        expect(report.totals.records).toBe(1);
        expect(report.totals.errors).toBe(1);
        expect(report.files['challenges.csv'].errors[0].message).toMatch(/database unreachable/);
    });

    it('aborts the whole file with a single error when required columns are missing', async () => {
        successfulWorkflow();
        const csv = '"id","name"\n"c1","Missing Columns"';

        const report = await runProcessFile(csv);

        expect(mocks.runStart).not.toHaveBeenCalled();
        expect(report.totals.errors).toBe(1);
        expect(report.files['challenges.csv'].errors[0].message).toMatch(/missing required columns/i);
    });
});

// ---------------------------------------------------------------------------
// main — end-to-end
// ---------------------------------------------------------------------------

describe('main', () => {
    it('ingests a CSV file end-to-end and writes report.json', async () => {
        successfulWorkflow({ chunks: 5, forceSplits: [] });
        const csvDir = tmpDir();
        const logDir = tmpDir();
        const filePath = writeCsv(csvDir, 'challenges.csv', VALID_CSV);

        await main(['--file', filePath], logDir);

        const runDirs = fs.readdirSync(logDir);
        expect(runDirs).toHaveLength(1);
        const reportPath = path.join(logDir, runDirs[0], 'report.json');
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        expect(report.totals.records).toBe(2);
        expect(report.totals.chunks).toBe(10);
        expect(report.totals.errors).toBe(0);
    });

    it('drops the vector index on --clear-all after confirmation, before ingesting', async () => {
        successfulWorkflow({ chunks: 1, forceSplits: [] });
        mocks.deleteIndex.mockResolvedValue(undefined);
        const csvDir = tmpDir();
        const logDir = tmpDir();
        const filePath = writeCsv(csvDir, 'challenges.csv', VALID_CSV);

        await main(['--file', filePath, '--clear-all'], logDir);

        expect(mocks.deleteIndex).toHaveBeenCalledWith({ indexName: 'challenge_embeddings' });
    });

    it('skips both deleteIndex and ingestion when the user declines the --clear-all confirmation', async () => {
        mocks.readlineAnswer = 'n';
        const csvDir = tmpDir();
        const logDir = tmpDir();
        const filePath = writeCsv(csvDir, 'challenges.csv', VALID_CSV);

        await main(['--file', filePath, '--clear-all'], logDir);

        expect(mocks.deleteIndex).not.toHaveBeenCalled();
        expect(mocks.runStart).not.toHaveBeenCalled();
        // No log directory was ever created since main() returns before IngestionLogger.create()
        expect(fs.existsSync(logDir) && fs.readdirSync(logDir).length).toBeFalsy();
    });

    it('does not call deleteIndex on --clear-all when --dry-run is also set', async () => {
        successfulWorkflow({ chunks: 1, forceSplits: [] });
        const csvDir = tmpDir();
        const logDir = tmpDir();
        const filePath = writeCsv(csvDir, 'challenges.csv', VALID_CSV);

        await main(['--file', filePath, '--clear-all', '--dry-run'], logDir);

        expect(mocks.deleteIndex).not.toHaveBeenCalled();
    });
});
