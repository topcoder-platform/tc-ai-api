// Single source of truth for the server's route surfaces, so auth/middleware
// path patterns can't drift out of sync with how routes are actually mounted.
export const API_PREFIX = '/v6/ai';

/**
 * Custom apiRoutes CANNOT live under API_PREFIX. Mastra reserves it for its
 * built-ins and throws at boot from `validateCustomRoutePaths()`:
 *
 *   Custom API route "/v6/ai/rag/challenges" must not start with "/v6/ai" —
 *   that path is reserved for built-in Mastra routes.
 *
 * So every custom route is a hyphenated sibling of the prefix instead
 * (`/v6/ai-chat`, `/v6/ai-rag`), which is also why both need their own entry in
 * apiAuthLayer's `protected` list and in resourceIdMiddleware's registration.
 */
export const CHAT_ROUTE_BASE_PATH = '/v6/ai-chat';
export const CHAT_ROUTE_PATH = `${CHAT_ROUTE_BASE_PATH}/:agentId`;

/** RAG index administration API — see src/utils/routes/rag-index.routes.ts. */
export const RAG_ADMIN_ROUTE_BASE_PATH = '/v6/ai-rag';
export const RAG_CHALLENGES_ROUTE_PATH = `${RAG_ADMIN_ROUTE_BASE_PATH}/challenges`;
export const RAG_CHALLENGE_ROUTE_PATH = `${RAG_CHALLENGES_ROUTE_PATH}/:challengeId`;
