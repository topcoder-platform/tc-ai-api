// Single source of truth for the server's route surfaces, so auth/middleware
// path patterns can't drift out of sync with how routes are actually mounted.
export const API_PREFIX = '/v6/ai';

/**
 * Custom-route paths are ABSOLUTE. Mastra mounts an apiRoutes entry on the root
 * app at its literal `path` — unlike built-ins, which it registers with
 * `{ prefix: apiPrefix }` — so each constant below must spell out the full
 * URL path, not a fragment relative to anything.
 *
 * They also CANNOT live under API_PREFIX. Mastra reserves it for its built-ins
 * and throws at boot from `validateCustomRoutePaths()`:
 *
 *   Custom API route "/v6/ai/rag/challenges" must not start with "/v6/ai" —
 *   that path is reserved for built-in Mastra routes.
 *
 * So every custom route sits beside the prefix rather than under it, which is
 * also why each base path needs its own entry in apiAuthLayer's `protected`
 * list and in resourceIdMiddleware's registration.
 */
export const CHAT_ROUTE_BASE_PATH = '/v6/ai-chat';
export const CHAT_ROUTE_PATH = `${CHAT_ROUTE_BASE_PATH}/:agentId`;

/**
 * Namespace for this repo's own (non-Mastra-built-in) API routes. Protecting
 * the namespace rather than each route means a custom route added here later
 * is covered by apiAuthLayer without a second edit.
 */
export const CUSTOM_API_BASE_PATH = '/v6/ai-api';

/** RAG index administration API — see src/utils/routes/rag-index.routes.ts. */
export const RAG_ADMIN_ROUTE_BASE_PATH = `${CUSTOM_API_BASE_PATH}/rag`;
export const RAG_CHALLENGES_ROUTE_PATH = `${RAG_ADMIN_ROUTE_BASE_PATH}/challenges`;
export const RAG_CHALLENGE_ROUTE_PATH = `${RAG_CHALLENGES_ROUTE_PATH}/:challengeId`;
