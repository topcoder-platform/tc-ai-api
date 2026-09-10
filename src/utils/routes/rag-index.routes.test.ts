/**
 * Boot-time contract tests for the custom API routes.
 *
 * These exist because a bad route PATH is not a type error and is not covered
 * by the handler tests — it throws only when Mastra builds the Hono app, i.e.
 * at container start. `/v6/ai/rag/challenges` shipped once and crash-looped the
 * service on boot with:
 *
 *   Custom API route "/v6/ai/rag/challenges" must not start with "/v6/ai" —
 *   that path is reserved for built-in Mastra routes.
 *
 * Asserting Mastra's own rule here turns that class of failure into a red test.
 */
import { describe, expect, it } from 'vitest';
import { ragIndexRoutes } from './rag-index.routes';
import {
    API_PREFIX,
    RAG_ADMIN_ROUTE_BASE_PATH,
    RAG_CHALLENGE_ROUTE_PATH,
    RAG_CHALLENGES_ROUTE_PATH,
} from '../server-routes';

describe('rag index routes', () => {
    it('registers exactly the list and delete routes', () => {
        expect(ragIndexRoutes.map(route => `${route.method} ${route.path}`)).toEqual([
            `GET ${RAG_CHALLENGES_ROUTE_PATH}`,
            `DELETE ${RAG_CHALLENGE_ROUTE_PATH}`,
        ]);
    });

    // Mastra's validateCustomRoutePaths() throws at boot for any custom route
    // at or beneath apiPrefix. Nothing else in the build catches it.
    it.each(['GET', 'DELETE'])('%s path does not collide with apiPrefix', method => {
        const route = ragIndexRoutes.find(r => r.method === method);
        expect(route).toBeDefined();
        expect(route!.path.startsWith(`${API_PREFIX}/`)).toBe(false);
        expect(route!.path).not.toBe(API_PREFIX);
    });

    it('keeps every route under the base path the auth layer protects', () => {
        // apiAuthLayer's `protected` list and access-control's ROUTE_PATH_TARGETS
        // are both keyed off RAG_ADMIN_ROUTE_BASE_PATH; a route outside it would
        // be silently unauthenticated and unauthorized.
        for (const route of ragIndexRoutes) {
            expect(route.path.startsWith(`${RAG_ADMIN_ROUTE_BASE_PATH}/`)).toBe(true);
        }
    });

    it('requires auth explicitly rather than inheriting Mastra\'s default', () => {
        for (const route of ragIndexRoutes) {
            expect(route.requiresAuth).toBe(true);
        }
    });
});
