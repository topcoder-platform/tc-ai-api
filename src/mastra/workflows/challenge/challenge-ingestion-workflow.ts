/**
 * Challenge ingestion workflow (id: challenge-ingestion).
 *
 * Ingests a single challenge into the vector index, either by challengeId
 * (fetched through fetchChallengeTool) or from an inline record. Only the
 * PUBLIC description is ever embedded — privateDescription is reviewer-only
 * content and is deliberately never read here.
 *
 * projectId is carried as a string reference only; no projects-api call is
 * made during ingestion (D10).
 */

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { noopObserve } from '@mastra/core/tools';
import { embedMany } from 'ai';
import { z } from 'zod';
import { getRagConfig } from '../../../config/rag.config';
import { tcAILogger } from '../../../utils/logger';
import { createEmbeddingModel } from '../../../utils/providers/embedding-factory';
import { chunkChallengeDescription } from '../../rag/chunking';
import { enrichChunksWithChallengeName, parseSkills, processDescription } from '../../rag/content';
import {
    generateDeterministicId,
    validateRecord,
    withRetry,
} from '../../rag/ingestion-utils';
import type { ChallengeRecord, ChunkMetadata, ReportedForceSplit } from '../../rag/types';
import { ensureChallengeIndex } from '../../vector/challenge-vector-store';
import { fetchChallengeTool } from '../../tools/challenge/fetch-challenge-tool';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

/**
 * Inline challenge record. `typeName` / `trackName` are free-form strings and
 * are never enum-validated (D12).
 */
const inlineChallengeSchema = z.object({
    id: z.string().describe('Challenge id (any non-empty string for inline records)'),
    name: z.string().describe('Challenge name'),
    description: z.string().describe('Public challenge description (markdown or html)'),
    descriptionFormat: z.string().optional().describe('"html" triggers HTML→Markdown conversion'),
    typeName: z.string().optional().describe('Free-form challenge type (not enum-validated)'),
    trackName: z.string().optional().describe('Free-form challenge track (not enum-validated)'),
    skills: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('Comma-separated string or array of skill names'),
    projectId: z
        .union([z.string(), z.number()])
        .nullable()
        .optional()
        .describe('Project reference; stored as a string (D10 — never dereferenced)'),
    groups: z.array(z.string()).optional().describe('Challenge group ids'),
});

const ingestionInputSchema = z.object({
    challengeId: z
        .string()
        .uuid()
        .optional()
        .describe('UUID of the challenge to fetch and ingest'),
    challenge: inlineChallengeSchema
        .optional()
        .describe('Inline challenge record to ingest instead of fetching one'),
    dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe('Chunk and embed but skip the vector upsert'),
});

/** A challenge normalized into the shape the ingestion pipeline consumes. */
const normalizedRecordSchema = z.object({
    challengeId: z.string(),
    name: z.string(),
    description: z.string(),
    descriptionFormat: z.string().optional(),
    type: z.string(),
    track: z.string(),
    skills: z.array(z.string()),
    groups: z.array(z.string()),
    projectId: z.string().nullable(),
});

const resolvedChallengeSchema = z.object({
    record: normalizedRecordSchema,
    dryRun: z.boolean(),
});

const reportedForceSplitSchema = z.object({
    recordId: z.string(),
    chunkIndex: z.number(),
    originalTokens: z.number(),
    resultingChunks: z.number(),
    reason: z.string(),
});

const chunkMetadataSchema = z.object({
    challengeId: z.string(),
    name: z.string(),
    type: z.string(),
    track: z.string(),
    skills: z.array(z.string()),
    groups: z.array(z.string()),
    projectId: z.string().nullable(),
    chunkIndex: z.number(),
    totalChunks: z.number(),
    text: z.string(),
    ingestedAt: z.string(),
});

const embeddedChunksSchema = z.object({
    challengeId: z.string(),
    projectId: z.string().nullable(),
    dryRun: z.boolean(),
    skipped: z.boolean(),
    chunks: z.number(),
    forceSplits: z.array(reportedForceSplitSchema),
    vectorIds: z.array(z.string()),
    embeddings: z.array(z.array(z.number())),
    metadata: z.array(chunkMetadataSchema),
});

const ingestionReportSchema = z.object({
    chunks: z.number().describe('Number of chunks produced (and upserted unless dryRun/skipped)'),
    forceSplits: z.array(reportedForceSplitSchema).describe('Atomic blocks that had to be split'),
    dryRun: z.boolean(),
    skipped: z.boolean().describe('True when the description was empty after processing'),
    projectId: z.string().nullable(),
});

export type ChallengeIngestionReport = z.infer<typeof ingestionReportSchema>;

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/**
 * @mastra/pg compares metadata scalars as text, so a numeric projectId would
 * silently fail to match a filter — always store it as a string.
 */
function normalizeProjectId(value: string | number | null | undefined): string | null {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    return String(value);
}

/** Free-form type/track value, accepting either a plain string or `{ name }`. */
function toFreeFormName(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    if (value && typeof value === 'object' && 'name' in value) {
        const name = (value as { name?: unknown }).name;
        return typeof name === 'string' ? name : '';
    }
    return '';
}

/** Flattens the API's `{ id, name }[]` skills shape, or an inline array/CSV string. */
function normalizeSkills(value: unknown): string[] {
    if (value === null || value === undefined) {
        return [];
    }
    if (typeof value === 'string') {
        return parseSkills(value);
    }
    if (Array.isArray(value)) {
        const names = value.map((entry) =>
            typeof entry === 'string' ? entry : toFreeFormName(entry),
        );
        return parseSkills(names.join(','));
    }
    return [];
}

function toStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

type NormalizedRecord = z.infer<typeof normalizedRecordSchema>;

function normalizeInlineRecord(record: ChallengeRecord): NormalizedRecord {
    return {
        challengeId: record.id,
        name: record.name,
        description: record.description,
        descriptionFormat: record.descriptionFormat,
        type: record.typeName ?? '',
        track: record.trackName ?? '',
        skills: normalizeSkills(record.skills),
        groups: toStringArray(record.groups),
        projectId: normalizeProjectId(record.projectId),
    };
}

function normalizeFetchedChallenge(
    challenge: Record<string, unknown>,
    fallbackId: string,
): NormalizedRecord {
    return {
        challengeId: typeof challenge.id === 'string' ? challenge.id : fallbackId,
        name: typeof challenge.name === 'string' ? challenge.name : '',
        // privateDescription is intentionally not read — it must never be embedded.
        description: typeof challenge.description === 'string' ? challenge.description : '',
        descriptionFormat:
            typeof challenge.descriptionFormat === 'string' ? challenge.descriptionFormat : undefined,
        type: toFreeFormName(challenge.type),
        track: toFreeFormName(challenge.track),
        skills: normalizeSkills(challenge.skills),
        groups: toStringArray(challenge.groups),
        projectId: normalizeProjectId(challenge.projectId as string | number | null | undefined),
    };
}

// ---------------------------------------------------------------------------
// Step 1 – Resolve the challenge (fetch by id or accept inline)
// ---------------------------------------------------------------------------

const resolveChallengeStep = createStep({
    id: 'resolve-challenge',
    description:
        'Resolves the challenge to ingest from exactly one source: a challengeId ' +
        '(fetched via fetchChallengeTool) or an inline challenge record.',
    inputSchema: ingestionInputSchema,
    outputSchema: resolvedChallengeSchema,
    execute: async ({ inputData, requestContext }) => {
        const { challengeId, challenge, dryRun = false } = inputData;
        const hasChallengeId = typeof challengeId === 'string' && challengeId.trim().length > 0;
        const hasInlineChallenge = challenge !== undefined && challenge !== null;

        if (hasChallengeId === hasInlineChallenge) {
            throw new Error(
                '[challenge-ingestion:resolve-challenge] exactly one source required: ' +
                'supply either challengeId or challenge (not both, not neither)',
            );
        }

        if (hasInlineChallenge) {
            const record = challenge as ChallengeRecord;
            const validationError = validateRecord(record);
            if (validationError) {
                throw new Error(
                    `[challenge-ingestion:resolve-challenge] invalid inline challenge record: ${validationError}`,
                );
            }
            tcAILogger.info(
                `[challenge-ingestion:resolve-challenge] Using inline challenge record ${record.id} ("${record.name}")`,
            );
            return { record: normalizeInlineRecord(record), dryRun };
        }

        tcAILogger.info(
            `[challenge-ingestion:resolve-challenge] Fetching challenge ${challengeId} via fetchChallengeTool`,
        );

        const toolResult = await fetchChallengeTool.execute?.(
            { challengeId: challengeId! },
            { requestContext, observe: noopObserve },
        );

        if (!toolResult || 'error' in toolResult || !toolResult.challenge) {
            throw new Error(
                `[challenge-ingestion:resolve-challenge] challenge-not-found: no challenge returned for id ${challengeId}`,
            );
        }

        const record = normalizeFetchedChallenge(
            toolResult.challenge as unknown as Record<string, unknown>,
            challengeId!,
        );

        tcAILogger.info(
            `[challenge-ingestion:resolve-challenge] Resolved challenge ${record.challengeId} ` +
            `("${record.name}", type: ${record.type || 'n/a'}, track: ${record.track || 'n/a'}, ` +
            `projectId: ${record.projectId ?? 'null'}, skills: ${record.skills.length})`,
        );

        return { record, dryRun };
    },
});

// ---------------------------------------------------------------------------
// Step 2 – Process, chunk and embed the public description
// ---------------------------------------------------------------------------

const chunkAndEmbedStep = createStep({
    id: 'chunk-and-embed',
    description:
        'Processes the public description (line endings, BOM, HTML→Markdown, frontmatter), ' +
        'chunks it, enriches each chunk with the challenge name header and embeds the chunks.',
    inputSchema: resolvedChallengeSchema,
    outputSchema: embeddedChunksSchema,
    execute: async ({ inputData }) => {
        const config = getRagConfig();
        const { record, dryRun } = inputData;

        const emptyResult = {
            challengeId: record.challengeId,
            projectId: record.projectId,
            dryRun,
            skipped: true,
            chunks: 0,
            forceSplits: [] as ReportedForceSplit[],
            vectorIds: [] as string[],
            embeddings: [] as number[][],
            metadata: [] as ChunkMetadata[],
        };

        const content = processDescription(record.description, record.descriptionFormat);
        if (content.length === 0) {
            tcAILogger.info(
                `[challenge-ingestion:chunk-and-embed] Skipping challenge ${record.challengeId} — ` +
                'description is empty after processing',
            );
            return emptyResult;
        }

        const { chunks, forceSplits } = await chunkChallengeDescription(content, {
            maxSize: config.chunkMaxSize,
            overlap: config.chunkOverlap,
            contextWindow: config.embedding.maxContextWindow,
        });

        if (chunks.length === 0) {
            tcAILogger.info(
                `[challenge-ingestion:chunk-and-embed] Skipping challenge ${record.challengeId} — ` +
                'chunking produced no chunks',
            );
            return emptyResult;
        }

        // Enrichment happens AFTER chunking so the header is part of both the
        // embedded text and the deterministic vector id hash input.
        const enriched = enrichChunksWithChallengeName(chunks, record.name);
        const chunkTexts = enriched.map((chunk) => chunk.text);
        const totalChars = chunkTexts.reduce((sum, text) => sum + text.length, 0);
        const longestChunk = chunkTexts.reduce((max, text) => Math.max(max, text.length), 0);

        tcAILogger.info(
            `[challenge-ingestion:chunk-and-embed] Challenge ${record.challengeId} — ` +
            `${chunkTexts.length} chunks, ${totalChars} chars, longest ${longestChunk} chars, ` +
            `${forceSplits.length} force-splits`,
        );

        let embeddings: number[][];
        try {
            const result = await withRetry(() =>
                embedMany({
                    model: createEmbeddingModel(config.embedding.provider, config.embedding.modelId),
                    values: chunkTexts,
                }),
            );
            embeddings = result.embeddings;
        } catch (error) {
            throw new Error(
                `[challenge-ingestion:chunk-and-embed] embedding failure for challenge ` +
                `${record.challengeId} (chunks: ${chunkTexts.length}, totalChars: ${totalChars}, ` +
                `longestChunk: ${longestChunk}): ${errorMessage(error)}`,
                { cause: error },
            );
        }

        if (embeddings.length !== chunkTexts.length) {
            throw new Error(
                `[challenge-ingestion:chunk-and-embed] embedding failure for challenge ` +
                `${record.challengeId} (chunks: ${chunkTexts.length}, totalChars: ${totalChars}, ` +
                `longestChunk: ${longestChunk}): embedding provider returned ` +
                `${embeddings.length} vectors`,
            );
        }

        const ingestedAt = new Date().toISOString();
        const metadata: ChunkMetadata[] = chunkTexts.map((text, index) => ({
            challengeId: record.challengeId,
            name: record.name,
            type: record.type,
            track: record.track,
            skills: record.skills,
            groups: record.groups,
            projectId: record.projectId,
            chunkIndex: index + 1,
            totalChunks: chunkTexts.length,
            text,
            ingestedAt,
        }));

        const vectorIds = chunkTexts.map((text) =>
            generateDeterministicId(`${record.challengeId}-${text}`),
        );

        tcAILogger.info(
            `[challenge-ingestion:chunk-and-embed] Embedded ${embeddings.length} chunks for ` +
            `challenge ${record.challengeId}`,
        );

        return {
            challengeId: record.challengeId,
            projectId: record.projectId,
            dryRun,
            skipped: false,
            chunks: chunkTexts.length,
            forceSplits: forceSplits.map((split) => ({
                ...split,
                recordId: record.challengeId,
            })),
            vectorIds,
            embeddings,
            metadata,
        };
    },
});

// ---------------------------------------------------------------------------
// Step 3 – Upsert vectors (atomic per-challenge replacement)
// ---------------------------------------------------------------------------

const upsertVectorsStep = createStep({
    id: 'upsert-vectors',
    description:
        'Ensures the challenge vector index exists, then replaces the challenge\'s vectors in a ' +
        'single upsert using deleteFilter { challengeId }. Skipped on dryRun.',
    inputSchema: embeddedChunksSchema,
    outputSchema: ingestionReportSchema,
    execute: async ({ inputData }) => {
        const {
            challengeId,
            projectId,
            dryRun,
            skipped,
            chunks,
            forceSplits,
            vectorIds,
            embeddings,
            metadata,
        } = inputData;

        const report = { chunks, forceSplits, dryRun, skipped, projectId };

        if (skipped) {
            tcAILogger.info(
                `[challenge-ingestion:upsert-vectors] Nothing to upsert for challenge ${challengeId} — record skipped`,
            );
            return report;
        }

        if (dryRun) {
            tcAILogger.info(
                `[challenge-ingestion:upsert-vectors] Dry run — skipping upsert of ${chunks} ` +
                `chunks for challenge ${challengeId}`,
            );
            return report;
        }

        const config = getRagConfig();
        const indexName = config.vectorIndexName;

        let store;
        try {
            store = await ensureChallengeIndex();
        } catch (error) {
            throw new Error(
                `[challenge-ingestion:upsert-vectors] database failure while ensuring index ` +
                `"${indexName}" for challenge ${challengeId}: ${errorMessage(error)}`,
                { cause: error },
            );
        }

        try {
            // deleteFilter makes the delete + insert a single atomic per-challenge
            // replacement, so a failure cannot leave partially indexed chunks.
            await store.upsert({
                indexName,
                vectors: embeddings,
                metadata,
                ids: vectorIds,
                deleteFilter: { challengeId },
            });
        } catch (error) {
            throw new Error(
                `[challenge-ingestion:upsert-vectors] database failure during upsert for challenge ` +
                `${challengeId} (chunks: ${chunks}, vectors: ${embeddings.length}): ${errorMessage(error)}`,
                { cause: error },
            );
        }

        tcAILogger.info(
            `[challenge-ingestion:upsert-vectors] Upserted ${embeddings.length} vectors into ` +
            `"${indexName}" for challenge ${challengeId} (replaced any previous chunks)`,
        );

        return report;
    },
});

// ---------------------------------------------------------------------------
// Testing Exports
// ---------------------------------------------------------------------------

export const _testing = {
    ingestionInputSchema,
    resolveChallengeStep,
    chunkAndEmbedStep,
    upsertVectorsStep,
    normalizeProjectId,
    normalizeSkills,
    toFreeFormName,
};

// ---------------------------------------------------------------------------
// Workflow Definition
// ---------------------------------------------------------------------------

export const challengeIngestionWorkflow = createWorkflow({
    id: 'challenge-ingestion',
    description:
        'Ingests one challenge into the vector index: resolve (by id or inline) → ' +
        'chunk and embed the public description → upsert with per-challenge replacement.',
    inputSchema: ingestionInputSchema,
    outputSchema: ingestionReportSchema,
})
    .then(resolveChallengeStep)
    .then(chunkAndEmbedStep)
    .then(upsertVectorsStep)
    .commit();
