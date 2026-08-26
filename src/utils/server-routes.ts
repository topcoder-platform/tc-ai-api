// Single source of truth for the server's route surfaces, so auth/middleware
// path patterns can't drift out of sync with how routes are actually mounted.
export const API_PREFIX = '/v6/ai';
export const CHAT_ROUTE_BASE_PATH = `${API_PREFIX}/chat`;
export const CHAT_ROUTE_PATH = `${CHAT_ROUTE_BASE_PATH}/:agentId`;
