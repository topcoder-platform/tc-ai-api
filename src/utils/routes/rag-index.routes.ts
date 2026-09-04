/**
 * RAG index admin API — list and delete what challenge_embeddings holds.
 *
 * Registered as custom apiRoutes (see src/mastra/index.ts). They live under
 * `/v6/ai-rag`, NOT under API_PREFIX: Mastra reserves the prefix for its
 * built-ins and throws at boot for any custom route beneath it (see
 * server-routes.ts). Auth comes from two places: `requiresAuth: true` makes
 * Mastra authenticate them (set explicitly rather than relying on its
 * `requiresAuth !== false` default, since that default is what decides whether
 * these are reachable unauthenticated), and ADR 0004's `authorizeAccessPolicy`
 * gates them on the `route`/`rag-challenges` policy, which ships restricted to
 * administrators.
 *
 * Pagination is returned in X-Page/X-Per-Page/X-Total/X-Total-Pages headers
 * with a bare array body — the Topcoder platform convention that
 * platform-ui's xhrGetPaginatedAsync already reads, and which this server
 * already lists in its CORS exposeHeaders.
 */

import { registerApiRoute } from '@mastra/core/server';
import { deleteIndexedChallenge, listIndexedChallenges } from '../../mastra/rag/index-admin';
import { tcAILogger } from '../logger';
import { RAG_CHALLENGE_ROUTE_PATH, RAG_CHALLENGES_ROUTE_PATH } from '../server-routes';

/** Empty/whitespace query params are treated as absent, not as a filter for "". */
function queryValue(raw: string | undefined): string | undefined {
    const trimmed = raw?.trim();
    return trimmed ? trimmed : undefined;
}

function queryNumber(raw: string | undefined): number | undefined {
    const trimmed = queryValue(raw);
    if (trimmed === undefined) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export const listIndexedChallengesRoute = registerApiRoute(
    RAG_CHALLENGES_ROUTE_PATH,
    {
        method: 'GET',
        requiresAuth: true,
        openapi: {
            summary: 'List challenges currently in the RAG vector index',
            description:
                'Aggregates challenge_embeddings by challengeId. Paginated via '
                + 'X-Page/X-Per-Page/X-Total/X-Total-Pages response headers.',
            tags: ['rag-admin'],
        },
        handler: async c => {
            try {
                const result = await listIndexedChallenges({
                    page: queryNumber(c.req.query('page')),
                    perPage: queryNumber(c.req.query('perPage')),
                    projectId: queryValue(c.req.query('projectId')),
                    track: queryValue(c.req.query('track')),
                    type: queryValue(c.req.query('type')),
                    search: queryValue(c.req.query('search')),
                });

                c.header('X-Page', String(result.page));
                c.header('X-Per-Page', String(result.perPage));
                c.header('X-Total', String(result.total));
                c.header('X-Total-Pages', String(result.totalPages));

                return c.json(result.rows);
            } catch (error) {
                tcAILogger.error('[rag-index-admin] list failed', { error });
                return c.json({ error: errorMessage(error) }, 500);
            }
        },
    },
);

export const deleteIndexedChallengeRoute = registerApiRoute(
    RAG_CHALLENGE_ROUTE_PATH,
    {
        method: 'DELETE',
        requiresAuth: true,
        openapi: {
            summary: "Remove one challenge's vectors from the RAG index",
            description:
                'Deletes every chunk whose metadata.challengeId matches. '
                + 'Returns 404 when the challenge holds no vectors.',
            tags: ['rag-admin'],
        },
        handler: async c => {
            const challengeId = c.req.param('challengeId')?.trim();
            if (!challengeId) {
                return c.json({ error: 'challengeId is required' }, 400);
            }

            try {
                const result = await deleteIndexedChallenge(challengeId);
                if (!result) {
                    return c.json(
                        { error: `Challenge "${challengeId}" is not in the index` },
                        404,
                    );
                }
                return c.json(result);
            } catch (error) {
                tcAILogger.error('[rag-index-admin] delete failed', { challengeId, error });
                return c.json({ error: errorMessage(error) }, 500);
            }
        },
    },
);

export const ragIndexRoutes = [listIndexedChallengesRoute, deleteIndexedChallengeRoute];
