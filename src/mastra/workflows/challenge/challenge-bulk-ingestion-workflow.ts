/**
 * Challenge bulk ingestion workflow (id: challenge-bulk-ingestion).
 *
 * Paginates through searchChallengesTool with the supplied filters and runs the
 * single-challenge `challenge-ingestion` workflow once per matched challenge,
 * fanned out with bounded concurrency, then aggregates the per-challenge
 * reports.
 *
 * The nested workflow is invoked imperatively (getWorkflowById → createRun →
 * run.start) rather than composed as a foreach step: a composed workflow step
 * rethrows the nested failure, which would kill the fan-out queue and abort the
 * whole run on the first bad challenge.
 */

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { noopObserve } from '@mastra/core/tools';
import { z } from 'zod';
import { tcAILogger } from '../../../utils/logger';
import { searchChallengesTool } from '../../tools/challenge/search-challenges-tool';

const DEFAULT_STATUS = ['ACTIVE', 'COMPLETED'];
const DEFAULT_CONCURRENCY = 3;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 10;
const DEFAULT_PER_PAGE = 20;
const DEFAULT_MAX_PAGES = 50;
const INGESTION_WORKFLOW_ID = 'challenge-ingestion';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const bulkInputSchema = z.object({
    status: z
        .array(z.string())
        .optional()
        .describe('Challenge statuses to ingest (defaults to ACTIVE + COMPLETED)'),
    projectId: z
        .string()
        .optional()
        .describe('Restrict the search to a single project (string — D10)'),
    types: z.array(z.string()).optional().describe('Challenge type filter'),
    tracks: z.array(z.string()).optional().describe('Challenge track filter'),
    tags: z.array(z.string()).optional().describe('Challenge tag filter'),
    groups: z.array(z.string()).optional().describe('Challenge group filter'),
    updatedDateStart: z
        .string()
        .optional()
        .describe('Only ingest challenges updated on or after this date (incremental sync)'),
    dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe('Chunk and embed every matched challenge but skip all vector upserts'),
    concurrency: z
        .number()
        .int()
        .optional()
        .default(DEFAULT_CONCURRENCY)
        .describe(`Fan-out width for per-challenge ingestion (clamped to ${MIN_CONCURRENCY}-${MAX_CONCURRENCY})`),
    perPage: z
        .number()
        .int()
        .optional()
        .default(DEFAULT_PER_PAGE)
        .describe('Page size used when paginating searchChallengesTool'),
    maxPages: z
        .number()
        .int()
        .optional()
        .default(DEFAULT_MAX_PAGES)
        .describe('Safety guard on the number of search pages fetched'),
});

/** One unit of per-challenge work handed to the fan-out step. */
const challengeTaskSchema = z.object({
    challengeId: z.string(),
    name: z.string(),
    dryRun: z.boolean(),
});

const reportedForceSplitSchema = z.object({
    recordId: z.string(),
    chunkIndex: z.number(),
    originalTokens: z.number(),
    resultingChunks: z.number(),
    reason: z.string(),
});

const challengeResultSchema = z.object({
    challengeId: z.string(),
    name: z.string(),
    status: z.enum(['success', 'failed']),
    error: z.string().optional(),
    chunks: z.number(),
    skipped: z.boolean(),
    dryRun: z.boolean(),
    forceSplits: z.array(reportedForceSplitSchema),
    projectId: z.string().nullable(),
});

const bulkReportSchema = z.object({
    processed: z.number().describe('Number of matched challenges that were run'),
    succeeded: z.number(),
    failed: z.number(),
    skipped: z.number().describe('Successful runs whose description was empty after processing'),
    totalChunks: z.number(),
    forceSplits: z.array(reportedForceSplitSchema),
    dryRun: z.boolean(),
    results: z.array(challengeResultSchema).describe('Per-challenge reports, in search order'),
});

export type ChallengeBulkIngestionReport = z.infer<typeof bulkReportSchema>;

type ChallengeResult = z.infer<typeof challengeResultSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Bounded fan-out width: never 0 (would stall the queue), never unbounded. */
function resolveConcurrency(value: unknown): number {
    const requested =
        typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_CONCURRENCY;
    return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, requested));
}

function foreachConcurrency({ getInitData }: { getInitData: () => unknown }): number {
    const init = getInitData() as { concurrency?: number } | undefined;
    return resolveConcurrency(init?.concurrency);
}

/**
 * Minimal shape of the nested run, kept structural so the deeply generic
 * Workflow/Run types don't leak into this workflow's own inference.
 */
interface NestedRunResult {
    status: string;
    result?: unknown;
    error?: unknown;
}

interface NestedWorkflow {
    createRun: () => Promise<{
        start: (args: { inputData: unknown; requestContext?: unknown }) => Promise<NestedRunResult>;
    }>;
}

interface WorkflowRegistry {
    getWorkflowById?: (id: string) => unknown;
}

// ---------------------------------------------------------------------------
// Step 1 – Collect matching challenges (paginated search)
// ---------------------------------------------------------------------------

const collectChallengesStep = createStep({
    id: 'collect-challenges',
    description:
        'Paginates searchChallengesTool with the supplied filters and returns one ingestion ' +
        'task per matched challenge.',
    inputSchema: bulkInputSchema,
    outputSchema: z.array(challengeTaskSchema),
    execute: async ({ inputData, requestContext }) => {
        const {
            status,
            projectId,
            types,
            tracks,
            tags,
            groups,
            updatedDateStart,
            dryRun = false,
            perPage = DEFAULT_PER_PAGE,
            maxPages = DEFAULT_MAX_PAGES,
        } = inputData;

        const effectiveStatus = status?.length ? status : DEFAULT_STATUS;
        const effectivePerPage = perPage > 0 ? perPage : DEFAULT_PER_PAGE;
        const effectiveMaxPages = maxPages > 0 ? maxPages : DEFAULT_MAX_PAGES;

        tcAILogger.info(
            `[challenge-bulk-ingestion:collect-challenges] Searching challenges — ` +
            `status: ${effectiveStatus.join(',')}, projectId: ${projectId ?? 'any'}, ` +
            `types: ${types?.join(',') || 'any'}, tracks: ${tracks?.join(',') || 'any'}, ` +
            `tags: ${tags?.join(',') || 'any'}, groups: ${groups?.join(',') || 'any'}, ` +
            `updatedDateStart: ${updatedDateStart ?? 'none'}, perPage: ${effectivePerPage}, ` +
            `maxPages: ${effectiveMaxPages}, dryRun: ${dryRun}`,
        );

        const tasks: z.infer<typeof challengeTaskSchema>[] = [];
        const seen = new Set<string>();
        let pagesFetched = 0;

        // `status` is a scalar enum in the v6 API (a list is rejected with HTTP
        // 400), so each status gets its own paginated pass; `seen` de-duplicates
        // any challenge that shows up under more than one pass.
        for (const singleStatus of effectiveStatus) {
            for (let page = 1; page <= effectiveMaxPages; page++) {
                pagesFetched++;
                let result;
                try {
                    result = await searchChallengesTool.execute?.(
                        {
                            status: [singleStatus],
                            projectId,
                            types,
                            tracks,
                            tags,
                            groups,
                            updatedDateStart,
                            page,
                            perPage: effectivePerPage,
                        },
                        { requestContext, observe: noopObserve },
                    );
                } catch (error) {
                    tcAILogger.error(
                        `[challenge-bulk-ingestion:collect-challenges] Search failed on page ${page} ` +
                        `for status ${singleStatus} (perPage: ${effectivePerPage}, collected so far: ` +
                        `${tasks.length}): ${errorMessage(error)}`,
                    );
                    throw error;
                }

                if (!result || 'error' in result) {
                    const detail = result ? JSON.stringify(result.error) : 'no result returned';
                    tcAILogger.error(
                        `[challenge-bulk-ingestion:collect-challenges] Search rejected on page ${page} ` +
                        `for status ${singleStatus}: ${detail}`,
                    );
                    throw new Error(
                        `[challenge-bulk-ingestion:collect-challenges] searchChallengesTool did not return ` +
                        `results for page ${page} (status ${singleStatus}): ${detail}`,
                    );
                }

                const challenges = result.challenges ?? [];

                for (const challenge of challenges) {
                    const challengeId = challenge?.id;
                    if (typeof challengeId !== 'string' || challengeId.length === 0) {
                        continue;
                    }
                    if (seen.has(challengeId)) {
                        continue;
                    }
                    seen.add(challengeId);
                    tasks.push({ challengeId, name: challenge.name ?? '', dryRun });
                }

                // `total` from the tool is the CURRENT page length (the v6
                // endpoint returns a bare array), so a short or empty page is
                // the only reliable end-of-results signal.
                if (challenges.length === 0 || challenges.length < effectivePerPage) {
                    break;
                }

                if (page === effectiveMaxPages) {
                    tcAILogger.warn(
                        `[challenge-bulk-ingestion:collect-challenges] Reached maxPages guard ` +
                        `(${effectiveMaxPages}) for status ${singleStatus}; additional matching ` +
                        'challenges may not be ingested',
                    );
                }
            }
        }

        tcAILogger.info(
            `[challenge-bulk-ingestion:collect-challenges] Collected ${tasks.length} challenges ` +
            `across ${pagesFetched} page(s) / ${effectiveStatus.length} status pass(es)`,
        );

        return tasks;
    },
});

// ---------------------------------------------------------------------------
// Step 2 – Ingest one challenge (fanned out, never throws)
// ---------------------------------------------------------------------------

const ingestOneChallengeStep = createStep({
    id: 'ingest-one-challenge',
    description:
        'Runs the challenge-ingestion workflow for a single challenge and converts any failure ' +
        'into a failed result so one bad challenge cannot abort the bulk run.',
    inputSchema: challengeTaskSchema,
    outputSchema: challengeResultSchema,
    execute: async ({ inputData, mastra, requestContext }): Promise<ChallengeResult> => {
        const { challengeId, name, dryRun } = inputData;

        const failure = (error: string): ChallengeResult => {
            tcAILogger.error(
                `[challenge-bulk-ingestion:ingest-one-challenge] Challenge ${challengeId} failed: ${error}`,
            );
            return {
                challengeId,
                name,
                status: 'failed',
                error,
                chunks: 0,
                skipped: false,
                dryRun,
                forceSplits: [],
                projectId: null,
            };
        };

        // Resolution, run creation and run start are all inside one try/catch:
        // every one of them can throw, and a throw here would kill the fan-out
        // queue for the remaining challenges.
        try {
            const registry = mastra as unknown as WorkflowRegistry | undefined;
            const workflow = registry?.getWorkflowById?.(INGESTION_WORKFLOW_ID) as
                | NestedWorkflow
                | undefined;

            if (!workflow) {
                return failure(`workflow "${INGESTION_WORKFLOW_ID}" is not registered`);
            }

            const run = await workflow.createRun();
            const runResult = await run.start({
                inputData: { challengeId, dryRun },
                requestContext,
            });

            if (!runResult || runResult.status !== 'success') {
                const status = runResult?.status ?? 'unknown';
                const detail = runResult?.error
                    ? errorMessage(runResult.error)
                    : `challenge-ingestion run ended with status "${status}"`;
                return failure(detail);
            }

            const report = (runResult.result ?? {}) as {
                chunks?: number;
                skipped?: boolean;
                dryRun?: boolean;
                forceSplits?: z.infer<typeof reportedForceSplitSchema>[];
                projectId?: string | null;
            };

            tcAILogger.info(
                `[challenge-bulk-ingestion:ingest-one-challenge] Challenge ${challengeId} ingested — ` +
                `chunks: ${report.chunks ?? 0}, skipped: ${report.skipped ?? false}, dryRun: ${dryRun}`,
            );

            return {
                challengeId,
                name,
                status: 'success',
                chunks: report.chunks ?? 0,
                skipped: report.skipped ?? false,
                dryRun: report.dryRun ?? dryRun,
                forceSplits: report.forceSplits ?? [],
                projectId: report.projectId ?? null,
            };
        } catch (error) {
            return failure(errorMessage(error));
        }
    },
});

// ---------------------------------------------------------------------------
// Step 3 – Aggregate the per-challenge reports
// ---------------------------------------------------------------------------

const aggregateReportsStep = createStep({
    id: 'aggregate-reports',
    description:
        'Reduces the per-challenge results into run totals while retaining every ' +
        'per-challenge entry.',
    inputSchema: z.array(challengeResultSchema),
    outputSchema: bulkReportSchema,
    execute: async ({ inputData, getInitData }) => {
        const results = inputData ?? [];
        const init = getInitData() as { dryRun?: boolean } | undefined;

        const succeeded = results.filter((result) => result.status === 'success').length;
        const failed = results.filter((result) => result.status === 'failed').length;
        const skipped = results.filter((result) => result.status === 'success' && result.skipped).length;
        const totalChunks = results.reduce((sum, result) => sum + result.chunks, 0);
        const forceSplits = results.flatMap((result) => result.forceSplits);
        const dryRun =
            typeof init?.dryRun === 'boolean'
                ? init.dryRun
                : results.length > 0 && results.every((result) => result.dryRun);

        tcAILogger.info(
            `[challenge-bulk-ingestion:aggregate-reports] Processed ${results.length} challenges — ` +
            `succeeded: ${succeeded}, failed: ${failed}, skipped: ${skipped}, ` +
            `chunks: ${totalChunks}, forceSplits: ${forceSplits.length}, dryRun: ${dryRun}`,
        );

        return {
            processed: results.length,
            succeeded,
            failed,
            skipped,
            totalChunks,
            forceSplits,
            dryRun,
            results,
        };
    },
});

// ---------------------------------------------------------------------------
// Testing Exports
// ---------------------------------------------------------------------------

export const _testing = {
    bulkInputSchema,
    collectChallengesStep,
    ingestOneChallengeStep,
    aggregateReportsStep,
    resolveConcurrency,
    foreachConcurrency,
    DEFAULT_STATUS,
    DEFAULT_CONCURRENCY,
    MIN_CONCURRENCY,
    MAX_CONCURRENCY,
    DEFAULT_PER_PAGE,
    DEFAULT_MAX_PAGES,
};

// ---------------------------------------------------------------------------
// Workflow Definition
// ---------------------------------------------------------------------------

export const challengeBulkIngestionWorkflow = createWorkflow({
    id: 'challenge-bulk-ingestion',
    description:
        'Bulk-ingests challenges into the vector index: paginated search → bounded per-challenge ' +
        'challenge-ingestion fan-out → aggregated report.',
    inputSchema: bulkInputSchema,
    outputSchema: bulkReportSchema,
})
    .then(collectChallengesStep)
    .foreach(ingestOneChallengeStep, { concurrency: foreachConcurrency })
    .then(aggregateReportsStep)
    .commit();
