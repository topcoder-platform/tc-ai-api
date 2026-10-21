import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiDocsRoutes, buildApiDocsSpec } from './api-docs.routes';
import { ragIndexRoutes } from './rag-index.routes';
import {
    API_DOCS_PUBLIC_PATHS,
    API_DOCS_ROUTE_PATH,
    API_DOCS_SPEC_ROUTE_PATH,
    API_PREFIX,
    CUSTOM_API_BASE_PATH,
    RAG_CHALLENGES_ROUTE_PATH,
    isSwaggerUIEnabled,
} from '../server-routes';

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('api docs routes', () => {
    it('is off unless SWAGGER_UI_ENABLED is exactly "true"', () => {
        vi.stubEnv('SWAGGER_UI_ENABLED', '');
        expect(isSwaggerUIEnabled()).toBe(false);
        vi.stubEnv('SWAGGER_UI_ENABLED', '1');
        expect(isSwaggerUIEnabled()).toBe(false);
        vi.stubEnv('SWAGGER_UI_ENABLED', 'true');
        expect(isSwaggerUIEnabled()).toBe(true);
    });

    it('registers the UI and spec routes as public GETs', () => {
        expect(apiDocsRoutes.map(route => `${route.method} ${route.path}`)).toEqual([
            `GET ${API_DOCS_ROUTE_PATH}`,
            `GET ${API_DOCS_SPEC_ROUTE_PATH}`,
        ]);
        for (const route of apiDocsRoutes) {
            expect(route.requiresAuth).toBe(false);
        }
        expect(API_DOCS_PUBLIC_PATHS).toEqual([API_DOCS_ROUTE_PATH, API_DOCS_SPEC_ROUTE_PATH]);
    });

    it('lives in a namespace the ALB forwards, outside the reserved apiPrefix', () => {
        // The ALB only forwards /v6/ai/*, /v6/ai-chat/* and /v6/ai-api/*; Mastra
        // throws at boot for custom routes under apiPrefix.
        for (const route of apiDocsRoutes) {
            expect(route.path.startsWith(`${CUSTOM_API_BASE_PATH}/`)).toBe(true);
            expect(route.path.startsWith(`${API_PREFIX}/`)).toBe(false);
        }
    });
});

describe('buildApiDocsSpec', () => {
    const spec = buildApiDocsSpec(ragIndexRoutes);

    it('resolves built-in routes against API_PREFIX', () => {
        expect(spec.servers).toEqual([{ url: API_PREFIX }]);
        expect(spec.paths['/agents']).toBeDefined();
    });

    it('includes custom routes at their absolute path, served from the root', () => {
        const ragPath = spec.paths[RAG_CHALLENGES_ROUTE_PATH];
        expect(ragPath?.get).toBeDefined();
        expect(ragPath.servers).toEqual([{ url: '/' }]);
    });

    it('declares bearer auth so Swagger UI can send a token', () => {
        expect(spec.components.securitySchemes.bearerAuth).toEqual({
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
        });
        expect(spec.security).toEqual([{ bearerAuth: [] }]);
    });

    it('does not list the docs routes themselves', () => {
        const withDocs = buildApiDocsSpec([...ragIndexRoutes, ...apiDocsRoutes]);
        expect(withDocs.paths[API_DOCS_ROUTE_PATH]).toBeUndefined();
        expect(withDocs.paths[API_DOCS_SPEC_ROUTE_PATH]).toBeUndefined();
    });
});
