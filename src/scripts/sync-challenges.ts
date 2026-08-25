/**
 * Incremental-sync / project-scoped backfill CLI (per D11) — sync-challenges.
 *
 * Thin CLI wrapper around the `challenge-bulk-ingestion` workflow's paginated
 * Challenge Search API fan-out (via mastra.getWorkflowById → createRun →
 * run.start), for operators who prefer a command line over calling the
 * workflow's generated API route. This is the PRIMARY bulk-ingestion and
 * incremental-sync surface — the CSV CLI (ingest-challenges.ts) is secondary.
 *
 * Usage:
 *   pnpm run sync -- --project-id 17423 [--dry-run]
 *   pnpm run sync -- --status ACTIVE --updated-since 2026-08-01 --concurrency 5
 */

import { parseArgs } from 'node:util';
import { mastra } from '../mastra';

const BULK_WORKFLOW_ID = 'challenge-bulk-ingestion';

interface CliOptions {
    projectId?: string;
    status?: string[];
    types?: string[];
    tracks?: string[];
    updatedSince?: string;
    dryRun: boolean;
    concurrency?: number;
}

function parseOptions(argv: string[]): CliOptions {
    const { values } = parseArgs({
        args: argv,
        options: {
            'project-id': { type: 'string' },
            status: { type: 'string', multiple: true },
            types: { type: 'string', multiple: true },
            tracks: { type: 'string', multiple: true },
            'updated-since': { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
            concurrency: { type: 'string' },
        },
    });

    return {
        projectId: values['project-id'],
        status: values.status,
        types: values.types,
        tracks: values.tracks,
        updatedSince: values['updated-since'],
        dryRun: Boolean(values['dry-run']),
        concurrency: values.concurrency ? Number(values.concurrency) : undefined,
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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

interface BulkIngestionReport {
    processed: number;
    succeeded: number;
    failed: number;
    skipped: number;
    totalChunks: number;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
    const options = parseOptions(argv);

    console.log('Starting challenge sync...');
    console.log(`   projectId: ${options.projectId ?? 'any'}`);
    console.log(`   status: ${options.status?.join(',') || 'default (ACTIVE, COMPLETED)'}`);
    console.log(`   types: ${options.types?.join(',') || 'any'}`);
    console.log(`   tracks: ${options.tracks?.join(',') || 'any'}`);
    console.log(`   updatedDateStart: ${options.updatedSince ?? 'none (full sync)'}`);
    console.log(`   mode: ${options.dryRun ? 'DRY RUN' : 'LIVE'}`);

    const workflow = mastra.getWorkflowById(BULK_WORKFLOW_ID) as unknown as WorkflowHandle | undefined;
    if (!workflow) {
        throw new Error(`Workflow "${BULK_WORKFLOW_ID}" is not registered`);
    }

    const run = await workflow.createRun();
    const runResult = await run.start({
        inputData: {
            projectId: options.projectId,
            status: options.status,
            types: options.types,
            tracks: options.tracks,
            updatedDateStart: options.updatedSince,
            dryRun: options.dryRun,
            concurrency: options.concurrency,
        },
    });

    if (!runResult || runResult.status !== 'success') {
        const detail =
            runResult && 'error' in runResult && runResult.error
                ? errorMessage(runResult.error)
                : `run ended with status "${runResult?.status ?? 'unknown'}"`;
        console.error(`Sync failed: ${detail}`);
        process.exitCode = 1;
        return;
    }

    const report = runResult.result as unknown as BulkIngestionReport;
    console.log('Sync complete!');
    console.log(`   Processed: ${report.processed}`);
    console.log(`   Succeeded: ${report.succeeded}`);
    console.log(`   Failed: ${report.failed}`);
    console.log(`   Skipped (empty description): ${report.skipped}`);
    console.log(`   Chunks: ${report.totalChunks}`);

    if (report.failed > 0) {
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    main().catch((error) => {
        console.error('Fatal error during sync:', errorMessage(error));
        process.exitCode = 1;
    });
}

// ---------------------------------------------------------------------------
// Testing Exports
// ---------------------------------------------------------------------------

export const _testing = { parseOptions };
