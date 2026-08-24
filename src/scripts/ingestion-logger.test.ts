import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IngestionLogger } from './ingestion-logger';
import type { IngestionReport } from '../mastra/rag/types';

const tmpDirs: string[] = [];

function tmpBaseDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingestion-logger-test-'));
    tmpDirs.push(dir);
    return dir;
}

afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('IngestionLogger.create', () => {
    it('creates a timestamped ingestion-<ts> directory under baseDir', async () => {
        const base = tmpBaseDir();
        const logger = IngestionLogger.create(base);

        const logDir = logger.getLogDir();
        expect(logDir.startsWith(base)).toBe(true);
        expect(path.basename(logDir)).toMatch(/^ingestion-/);
        expect(fs.existsSync(logDir)).toBe(true);

        await logger.close();
    });

    it('has created output.log but not error.log once the stream has flushed', async () => {
        const base = tmpBaseDir();
        const logger = IngestionLogger.create(base);
        const logDir = logger.getLogDir();

        await logger.close();

        expect(fs.existsSync(path.join(logDir, 'output.log'))).toBe(true);
        expect(fs.existsSync(path.join(logDir, 'error.log'))).toBe(false);
    });
});

describe('IngestionLogger — child context prefixing', () => {
    it('nests child contexts as [parent] [child]', async () => {
        const base = tmpBaseDir();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const logger = IngestionLogger.create(base);
        const fileLogger = logger.child('challenges.csv');
        const recordLogger = fileLogger.child('challenge-1 (Test)');

        recordLogger.log('processed');

        const printedLine = logSpy.mock.calls.at(-1)?.[0] as string;
        expect(printedLine).toContain('[challenges.csv] [challenge-1 (Test)] processed');

        await logger.close();
    });

    it('writes every log() call to output.log', async () => {
        const base = tmpBaseDir();
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const logger = IngestionLogger.create(base);

        logger.log('starting');
        logger.child('file.csv').log('processing');
        await logger.close();

        const contents = fs.readFileSync(path.join(logger.getLogDir(), 'output.log'), 'utf8');
        expect(contents).toContain('starting');
        expect(contents).toContain('[file.csv] processing');
    });
});

describe('IngestionLogger — error handling', () => {
    it('never creates error.log when error() is never called', async () => {
        const base = tmpBaseDir();
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const logger = IngestionLogger.create(base);

        logger.log('no error yet');
        await logger.close();

        expect(fs.existsSync(path.join(logger.getLogDir(), 'error.log'))).toBe(false);
    });

    it('lazily creates error.log once error() has been called', async () => {
        const base = tmpBaseDir();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const logger = IngestionLogger.create(base);

        logger.error('something failed');
        await logger.close();

        expect(fs.existsSync(path.join(logger.getLogDir(), 'error.log'))).toBe(true);
    });

    it('includes both message and error.message, plus the stack, in error.log', async () => {
        const base = tmpBaseDir();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const logger = IngestionLogger.create(base);

        const err = new Error('boom');
        logger.error('operation failed', err);
        await logger.close();

        const errorContents = fs.readFileSync(path.join(logger.getLogDir(), 'error.log'), 'utf8');
        expect(errorContents).toContain('operation failed: boom');
        expect(errorContents).toContain(err.stack!.split('\n')[0]);
    });
});

describe('IngestionLogger.writeReport', () => {
    it('writes report.json with the exact report contents', async () => {
        const base = tmpBaseDir();
        const logger = IngestionLogger.create(base);

        const report: IngestionReport = {
            startTime: '2026-08-24T00:00:00.000Z',
            endTime: '2026-08-24T00:01:00.000Z',
            totals: { files: 1, records: 2, chunks: 5, errors: 0, forceSplits: 0 },
            files: {
                'challenges.csv': { records: 2, chunks: 5, errors: [], forceSplits: [] },
            },
        };
        logger.writeReport(report);
        await logger.close();

        const written = JSON.parse(fs.readFileSync(path.join(logger.getLogDir(), 'report.json'), 'utf8'));
        expect(written).toEqual(report);
    });
});
