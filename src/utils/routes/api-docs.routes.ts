/**
 * Swagger UI for the deployed API, behind the SWAGGER_UI_ENABLED env flag.
 *
 * Mastra's built-in docs (`server.build.swaggerUI` / `openAPIDocs`) don't work
 * for this deployment, for three reasons:
 *
 *  - Swagger UI is hard-wired to the server root (`/swagger-ui`), which the ALB
 *    never forwards to this service — it only routes `/v6/ai/*`,
 *    `/v6/ai-chat/*` and `/v6/ai-api/*`.
 *  - The spec is served at `${API_PREFIX}/openapi.json`, which apiAuthLayer
 *    protects and resourceIdMiddleware 401s, so the UI can't load it.
 *  - The generated spec declares no security scheme, so Swagger UI has no
 *    "Authorize" button and every "Try it out" call fails with a 401.
 *
 * So both routes live under CUSTOM_API_BASE_PATH, are listed in the Auth0
 * providers' `public` paths (see ../auth), and the spec is rebuilt from the
 * same Mastra generators the built-in endpoint uses, with a bearer scheme added.
 * Only the docs are public: requests sent from the UI still carry the token
 * entered under "Authorize" and are authenticated as usual.
 *
 * The flag is read when the server config is evaluated, i.e. at process start,
 * so it is a per-environment runtime toggle (ECS task env), not a build flag.
 */

import { registerApiRoute } from '@mastra/core/server';
import type { ApiRoute } from '@mastra/core/server';
import {
    SERVER_ROUTES,
    convertCustomRoutesToOpenAPIPaths,
    generateOpenAPIDocument,
} from '@mastra/server/server-adapter';
import { API_DOCS_ROUTE_PATH, API_DOCS_SPEC_ROUTE_PATH, API_PREFIX } from '../server-routes';

/**
 * Mirrors MastraServer.buildOpenAPISpec(): built-in routes resolve against
 * API_PREFIX, custom routes (mounted at absolute paths) against `/`. Server
 * URLs stay relative so the spec works on localhost and behind the ALB alike.
 */
export function buildApiDocsSpec(customRoutes: ApiRoute[] = []) {
    const spec = generateOpenAPIDocument(SERVER_ROUTES, {
        title: 'Topcoder AI API',
        version: '1.0.0',
        description: 'Mastra built-in routes under ' + API_PREFIX + ' plus this service\'s custom routes.',
    });
    spec.servers = [{ url: API_PREFIX }];

    const customPaths = convertCustomRoutesToOpenAPIPaths(customRoutes);
    for (const pathItem of Object.values(customPaths)) {
        pathItem.servers ??= [{ url: '/' }];
    }
    spec.paths = { ...spec.paths, ...customPaths };

    // Member and M2M Auth0 tokens are both plain bearer JWTs.
    spec.components = {
        ...spec.components,
        securitySchemes: {
            ...spec.components?.securitySchemes,
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
    };
    spec.security = [{ bearerAuth: [] }];

    return spec;
}

function swaggerUIHtml(specUrl: string): string {
    const dist = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5';
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Topcoder AI API — Swagger UI</title>
    <link rel="stylesheet" href="${dist}/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${dist}/swagger-ui-bundle.js" crossorigin="anonymous"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: ${JSON.stringify(specUrl)},
        dom_id: '#swagger-ui',
        persistAuthorization: true,
      });
    </script>
  </body>
</html>`;
}

// Built lazily on first request — by then every apiRoute is registered — and
// reused after that: the route table doesn't change for the process lifetime.
let cachedSpec: ReturnType<typeof buildApiDocsSpec> | undefined;

export const apiDocsSpecRoute = registerApiRoute(API_DOCS_SPEC_ROUTE_PATH, {
    method: 'GET',
    requiresAuth: false,
    handler: async c => {
        cachedSpec ??= buildApiDocsSpec(c.get('mastra').getServer()?.apiRoutes);
        return c.json(cachedSpec);
    },
});

export const swaggerUIRoute = registerApiRoute(API_DOCS_ROUTE_PATH, {
    method: 'GET',
    requiresAuth: false,
    handler: async c => c.html(swaggerUIHtml(API_DOCS_SPEC_ROUTE_PATH)),
});

// Neither route carries `openapi` metadata, so neither appears in the spec.
export const apiDocsRoutes = [swaggerUIRoute, apiDocsSpecRoute];
