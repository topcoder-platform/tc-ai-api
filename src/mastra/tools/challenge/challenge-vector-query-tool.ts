/**
 * Challenge vector query tool — shared retrieval logic for the
 * challenge-search-agent and the challenge-search workflow (D8), so the two
 * paths cannot rank differently.
 *
 * Composes an $and metadata filter from skills/type/track/groups/projectId,
 * embeds the query text through the provider factory, and queries the shared
 * PgVector store. The relevance threshold is applied AFTER retrieval
 * (post-filtered in this tool) rather than passed to query({ minScore }),
 * because passing minScore forces @mastra/pg off the HNSW ANN fast path onto
 * a full exact scan (see ADR 0001, "Query planning consequences").
 *
 * `query` is optional here (unlike the source prototype's required `query`):
 * a caller supplying only filters (e.g. projectId) gets a metadata-only
 * lookup — @mastra/pg's query() accepts a filter with no queryVector — which
 * is how the challenge-search workflow answers "everything indexed for this
 * project" without an LLM call (D8/D10).
 */

import { createTool } from '@mastra/core/tools';
import { withAccessPolicy } from '../../../utils/auth/access-control';
import { embed } from 'ai';
import { z } from 'zod';
import { getRagConfig } from '../../../config/rag.config';
import { tcAILogger } from '../../../utils/logger';
import { createEmbeddingModel } from '../../../utils/providers/embedding-factory';
import { ensureChallengeIndex } from '../../vector/challenge-vector-store';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const resultMetadataSchema = z.object({
    challengeId: z.string().optional(),
    name: z.string().optional(),
    type: z.string().optional(),
    track: z.string().optional(),
    skills: z.array(z.string()).optional(),
    groups: z.array(z.string()).optional(),
    projectId: z.string().nullable().optional(),
    chunkIndex: z.number().optional(),
    totalChunks: z.number().optional(),
});

const resultSchema = z.object({
    text: z.string().optional(),
    score: z.number().optional(),
    metadata: resultMetadataSchema.optional(),
});

export type ChallengeVectorQueryResult = z.infer<typeof resultSchema>;

const outputSchema = z.object({
    success: z.boolean().describe('Indicates if the query was successful.'),
    count: z.number().optional().describe('Number of relevant results found.'),
    results: z.array(resultSchema).optional().describe('Ranked chunks with their score and metadata.'),
    error: z.string().optional().describe('Error message if the query failed.'),
});

/**
 * WORKAROUND (carried over from the source prototype, re-verified against
 * zod 4 + @mastra/core 1.57): Mastra's OpenAISchemaCompatLayer rewrites
 * `.optional()` fields to `.nullable()` for some providers, and Ollama then
 * sends `""` instead of `null` for those now-nullable fields — which fails
 * Zod validation on plain string fields expecting omission rather than an
 * empty string. Wrapping the whole input in z.preprocess() stops Mastra from
 * introspecting the inner object shape, bypassing that rewrite.
 * See @mastra/schema-compat/src/provider-compats/openai.ts (processZodType).
 */
const inputSchema = z.preprocess(
    (input) => input,
    z.object({
        query: z
            .string()
            .optional()
            .describe(
                'Natural-language search text. May be omitted when at least one filter ' +
                '(skills, type, track, groups, projectId) is supplied instead — the search ' +
                'then becomes a metadata-only lookup with no embedding call.',
            ),
        skills: z.array(z.string()).optional().describe('Filter by challenge skills (e.g. ["TypeScript", "React"])'),
        type: z
            .enum(['Challenge', 'Marathon Match'])
            .optional()
            .describe(
                'Filter by challenge type. One of "Challenge" (standard challenge) or ' +
                '"Marathon Match" (extended-duration competitive challenge). Omit to search across all types.',
            ),
        track: z
            .enum(['Data Science', 'Design', 'Quality Assurance', 'Development'])
            .optional()
            .describe(
                'Filter by challenge track. One of "Data Science", "Design", "Quality Assurance", ' +
                'or "Development". Omit to search across all tracks.',
            ),
        groups: z.array(z.string()).optional().describe('Filter by challenge group ids'),
        projectId: z
            .union([z.string(), z.array(z.string())])
            .optional()
            .describe('Opaque project reference (D10) — a single id or a set of ids'),
        topK: z.number().optional().describe('Max results to return (defaults from RAG_TOP_K)'),
        minScore: z
            .number()
            .optional()
            .describe('Minimum similarity score, applied after retrieval (defaults from VECTOR_SEARCH_THRESHOLD)'),
    }),
);

export type ChallengeVectorQueryInput = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Filter composition
// ---------------------------------------------------------------------------

/**
 * Builds the $and metadata filter from the supplied dimensions.
 * Returns undefined when no filter dimension is present.
 *
 * Typed `any`: @mastra/pg's PGVectorFilter type is a closed structural union
 * not exported from the package's public entry point (deep imports are
 * blocked by its package.json "exports" map), so there is no way to name it
 * from here. The shape below ($and of $eq/$in leaves) is exactly what
 * PgVector's filter builder documents and what the source prototype used.
 */
export function buildMetadataFilter(
    input: Pick<ChallengeVectorQueryInput, 'type' | 'track' | 'skills' | 'groups' | 'projectId'>,
): any {
    const conditions: Record<string, unknown>[] = [];

    if (input.type) {
        conditions.push({ type: { $eq: input.type } });
    }
    if (input.track) {
        conditions.push({ track: { $eq: input.track } });
    }
    if (input.skills?.length) {
        conditions.push({ skills: { $in: input.skills } });
    }
    if (input.groups?.length) {
        conditions.push({ groups: { $in: input.groups } });
    }
    if (input.projectId !== undefined) {
        const ids = Array.isArray(input.projectId) ? input.projectId : [input.projectId];
        if (ids.length > 0) {
            conditions.push({ projectId: { $in: ids } });
        }
    }

    return conditions.length > 0 ? { $and: conditions } : undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const challengeVectorQueryTool = withAccessPolicy(createTool({
    id: 'challenge-vector-query',
    description:
        'Searches indexed Topcoder challenge descriptions by semantic similarity, with optional ' +
        'metadata filters for skills, type, track, groups, and projectId. Returns raw ranked chunks ' +
        '(no summarisation). query may be omitted when at least one filter is supplied.',
    inputSchema,
    outputSchema,
    execute: async (inputData) => {
        const config = getRagConfig();
        const filter = buildMetadataFilter(inputData);
        const query = inputData.query?.trim();

        if (!query && !filter) {
            return {
                success: false,
                error:
                    'At least one of query or a filter (skills, type, track, groups, projectId) is required',
            };
        }

        const topK = inputData.topK ?? config.topK;
        const minScore = inputData.minScore ?? config.vectorSearchThreshold;

        try {
            const store = await ensureChallengeIndex();

            let queryVector: number[] | undefined;
            if (query) {
                const { embedding } = await embed({
                    model: createEmbeddingModel(config.embedding.provider, config.embedding.modelId, 'challenge-vector-query-tool'),
                    value: query,
                });
                queryVector = embedding;
            }

            // minScore is deliberately NOT passed to query() — see module docblock.
            const results = await store.query({
                indexName: config.vectorIndexName,
                queryVector,
                topK,
                filter,
            });

            // The metadata-only path (no queryVector) returns score: 0 for every
            // row by construction (ordered by vector_id instead) — thresholding
            // it would silently discard every result.
            const relevant = queryVector ? results.filter((r) => (r.score ?? 0) >= minScore) : results;

            if (results.length > 0 && relevant.length === 0) {
                tcAILogger.warn(
                    `[challenge-vector-query] ${results.length} results found, all below threshold ` +
                    `${minScore}. Top scores: ${results.slice(0, 3).map((r) => r.score?.toFixed(3)).join(', ')}. ` +
                    'Consider lowering VECTOR_SEARCH_THRESHOLD.',
                );
            }

            return {
                success: true,
                count: relevant.length,
                results: relevant.map((r) => ({
                    text: r.metadata?.text,
                    score: r.score,
                    metadata: {
                        challengeId: r.metadata?.challengeId,
                        name: r.metadata?.name,
                        type: r.metadata?.type,
                        track: r.metadata?.track,
                        skills: r.metadata?.skills,
                        groups: r.metadata?.groups,
                        projectId: r.metadata?.projectId ?? null,
                        chunkIndex: r.metadata?.chunkIndex,
                        totalChunks: r.metadata?.totalChunks,
                    },
                })),
            };
        } catch (error) {
            const message = errorMessage(error);
            tcAILogger.error(`[challenge-vector-query] query failed: ${message}`);
            return { success: false, error: message };
        }
    },
}));

// ---------------------------------------------------------------------------
// Testing Exports
// ---------------------------------------------------------------------------

export const _testing = { buildMetadataFilter };
