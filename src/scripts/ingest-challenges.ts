/**
 * CSV backfill CLI (secondary path, per D11) — ingest-challenges.
 *
 * Streams challenge rows from CSV file(s) through the same `challenge-ingestion`
 * workflow the API path uses (via mastra.getWorkflowById → createRun → run.start),
 * so CLI and API cannot drift onto separate implementations. The PRIMARY bulk
 * path is the `challenge-bulk-ingestion` workflow (paginated Challenge Search
 * API, see sync-challenges.ts); this CLI remains for offline/air-gapped
 * environments and for importing historical CSV exports that predate the
 * search API.
 *
 * Usage:
 *   pnpm run ingest -- --file path/to/challenges.csv [--dry-run]
 *   pnpm run ingest -- --folder path/to/csvs [--dry-run]
 *   pnpm run ingest -- --clear-all --folder path/to/csvs
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { parseArgs } from 'node:util';
import { parse } from 'csv-parse';
import { mastra } from '../mastra';
import { getChallengeVectorStore } from '../mastra/vector/challenge-vector-store';
import { getRagConfig } from '../config/rag.config';
import { validateColumns, validateRecord } from '../mastra/rag/ingestion-utils';
import type { ChallengeRecord, IngestionReport, ReportedForceSplit } from '../mastra/rag/types';
import { IngestionLogger } from './ingestion-logger';

const INGESTION_WORKFLOW_ID = 'challenge-ingestion';

// ---------------------------------------------------------------------------
// CLI options
// ---------------------------------------------------------------------------

interface CliOptions {
    folder?: string;
    file?: string;
    dryRun: boolean;
    clearAll: boolean;
}

function parseOptions(argv: string[]): CliOptions {
    const { values } = parseArgs({
        args: argv,
        options: {
            folder: { type: 'string' },
            file: { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
            'clear-all': { type: 'boolean', default: false },
        },
    });

    if (values.file && values.folder) {
        throw new Error('Cannot use both --file and --folder. Use one or the other.');
    }

    return {
        folder: values.file ? undefined : (values.folder ?? 'data'),
        file: values.file,
        dryRun: Boolean(values['dry-run']),
        clearAll: Boolean(values['clear-all']),
    };
}

function getCsvFiles(options: CliOptions): string[] {
    if (options.file) {
        const filePath = path.resolve(options.file);
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }
        return [filePath];
    }

    const folderPath = path.resolve(options.folder!);
    if (!fs.existsSync(folderPath)) {
        throw new Error(`Folder not found: ${folderPath}`);
    }

    const files = fs
        .readdirSync(folderPath)
        .filter((f) => f.endsWith('.csv'))
        .map((f) => path.join(folderPath, f));

    if (files.length === 0) {
        throw new Error(`No CSV files found in: ${folderPath}`);
    }

    return files;
}

function confirmAction(question: string): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(`${question} (y/N) `, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === 'y');
        });
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Per-file / per-record processing — shares the challenge-ingestion workflow
// with the API path via mastra.getWorkflowById().createRun().start()
// ---------------------------------------------------------------------------

interface IngestionRunReport {
    chunks: number;
    forceSplits: ReportedForceSplit[];
}

/**
 * Minimal structural shape of a Workflow/Run, kept loose (rather than
 * importing the deeply generic Workflow/Run types) so this script's own
 * inference isn't dragged through every OTHER registered workflow's input
 * schema — same rationale as the NestedRunResult cast in
 * challenge-bulk-ingestion-workflow.ts.
 */
interface WorkflowRun {
    start: (args: { inputData: unknown }) => Promise<{ status: string; result?: unknown; error?: unknown }>;
}
interface WorkflowHandle {
    createRun: () => Promise<WorkflowRun>;
}

async function runIngestionWorkflow(
    record: ChallengeRecord,
    dryRun: boolean,
): Promise<IngestionRunReport> {
    const workflow = mastra.getWorkflowById(INGESTION_WORKFLOW_ID) as unknown as WorkflowHandle | undefined;
    if (!workflow) {
        throw new Error(`Workflow "${INGESTION_WORKFLOW_ID}" is not registered`);
    }

    const run = await workflow.createRun();
    const runResult = await run.start({ inputData: { challenge: record, dryRun } });

    if (!runResult || runResult.status !== 'success') {
        const detail =
            runResult && 'error' in runResult && runResult.error
                ? errorMessage(runResult.error)
                : `run ended with status "${runResult?.status ?? 'unknown'}"`;
        throw new Error(detail);
    }

    const report = runResult.result as unknown as IngestionRunReport;
    return {
        chunks: report?.chunks ?? 0,
        forceSplits: report?.forceSplits ?? [],
    };
}

async function processFile(
    filePath: string,
    logger: IngestionLogger,
    report: IngestionReport,
    dryRun: boolean,
): Promise<void> {
    const filename = path.basename(filePath);
    const fileLogger = logger.child(filename);
    fileLogger.log('Processing file...');

    report.files[filename] = { records: 0, chunks: 0, errors: [], forceSplits: [] };
    const fileStats = report.files[filename];

    const parser = fs.createReadStream(filePath).pipe(parse({ columns: true, skip_empty_lines: true }));

    let isFirstRecord = true;
    let recordCount = 0;

    for await (const rawRecord of parser) {
        if (isFirstRecord) {
            isFirstRecord = false;
            const missingColumns = validateColumns(Object.keys(rawRecord as Record<string, unknown>));
            if (missingColumns.length > 0) {
                const message = `Missing required columns: ${missingColumns.join(', ')}`;
                fileLogger.error(message);
                fileStats.errors.push({ recordId: filename, message });
                report.totals.errors++;
                return;
            }
        }

        recordCount++;
        const record = rawRecord as ChallengeRecord;

        const validationError = validateRecord(record);
        if (validationError) {
            const idRef = record.id || `#${recordCount}`;
            fileLogger.child(idRef).error(validationError);
            fileStats.errors.push({ recordId: idRef, message: validationError });
            report.totals.errors++;
            continue;
        }

        const recordLogger = fileLogger.child(`${record.id} (${record.name})`);
        try {
            const runReport = await runIngestionWorkflow(record, dryRun);

            fileStats.records++;
            fileStats.chunks += runReport.chunks;
            report.totals.records++;
            report.totals.chunks += runReport.chunks;
            for (const split of runReport.forceSplits) {
                fileStats.forceSplits.push({ ...split, recordId: record.id });
                report.totals.forceSplits++;
            }

            if (recordCount % 10 === 0) {
                fileLogger.log(`   Processed ${recordCount} records...`);
            }
        } catch (error) {
            const message = errorMessage(error);
            recordLogger.error(message, error instanceof Error ? error : undefined);
            fileStats.errors.push({
                recordId: record.id,
                message,
                stack: error instanceof Error ? error.stack : undefined,
            });
            report.totals.errors++;
        }
    }

    fileLogger.log(`Complete: ${fileStats.records} records, ${fileStats.chunks} chunks`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(
    argv: string[] = process.argv.slice(2),
    logBaseDir = 'logs',
): Promise<void> {
    const startDate = new Date();
    const report: IngestionReport = {
        startTime: startDate.toISOString(),
        endTime: '',
        totals: { files: 0, records: 0, chunks: 0, errors: 0, forceSplits: 0 },
        files: {},
    };

    const options = parseOptions(argv);
    const csvFiles = getCsvFiles(options);

    if (options.clearAll) {
        const confirmed = await confirmAction('This will delete ALL embeddings. Are you sure?');
        if (!confirmed) {
            console.log('Aborted.');
            return;
        }
    }

    const logger = IngestionLogger.create(logBaseDir);
    logger.log('Starting CSV ingestion...');
    logger.log(`   Command: ingest ${argv.join(' ')}`);
    logger.log(`   Mode: ${options.dryRun ? 'DRY RUN' : 'LIVE'}`);

    const config = getRagConfig();
    logger.log(
        `   Embedding: ${config.embedding.provider}/${config.embedding.modelId} (${config.embedding.dimension}D)`,
    );
    logger.log(`Found ${csvFiles.length} CSV file(s)`);
    report.totals.files = csvFiles.length;

    try {
        if (options.clearAll && !options.dryRun) {
            logger.log('Clearing ALL embeddings — dropping the vector index...');
            const store = getChallengeVectorStore();
            await store.deleteIndex({ indexName: config.vectorIndexName });
            logger.log('Index dropped. It will be recreated on the next ingestion run.');
        }

        for (const filePath of csvFiles) {
            await processFile(filePath, logger, report, options.dryRun);
        }

        const endDate = new Date();
        report.endTime = endDate.toISOString();
        const duration = ((endDate.getTime() - startDate.getTime()) / 1000).toFixed(2);

        logger.log(`Ingestion complete in ${duration}s!`);
        logger.log(`   Files: ${report.totals.files}`);
        logger.log(`   Records: ${report.totals.records}`);
        logger.log(`   Chunks: ${report.totals.chunks}`);
        logger.log(`   Errors: ${report.totals.errors}`);
        if (report.totals.forceSplits > 0) {
            logger.warn(`Force-splits: ${report.totals.forceSplits} (atomic chunks exceeded token limit)`);
        }
        logger.log(`Logs saved to: ${logger.getLogDir()}`);
        logger.writeReport(report);

        if (report.totals.errors > 0) {
            process.exitCode = 1;
        }
    } catch (error) {
        logger.error('Fatal error during ingestion', error instanceof Error ? error : undefined);
        process.exitCode = 1;
    } finally {
        await logger.close();
    }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    main();
}

// ---------------------------------------------------------------------------
// Testing Exports
// ---------------------------------------------------------------------------

export const _testing = { parseOptions, getCsvFiles, processFile, runIngestionWorkflow };
