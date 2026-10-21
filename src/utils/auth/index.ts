import { MastraAuthProvider, type MastraAuthRequest } from '@mastra/core/server';
import type { Principal } from 'tc-core-library-js';
import { API_DOCS_PUBLIC_PATHS, API_PREFIX, CHAT_ROUTE_BASE_PATH, CUSTOM_API_BASE_PATH, isSwaggerUIEnabled } from '../server-routes';
import { authorizeAccessPolicy } from './access-control';
import { mapUserToResourceId } from './resource-id';
import { core } from './core';

// chatRoute() (CHAT_ROUTE_BASE_PATH/:agentId) lives outside apiPrefix and never
// sets requiresAuth, so Mastra's coreAuthMiddleware treats it as unprotected and
// returns before ever reaching authorizeUser. Listing it here is what brings it
// under the same authenticate-then-authorize path as the native routes.
const PROTECTED_PATHS = [
  `${API_PREFIX}/*`,
  `${CHAT_ROUTE_BASE_PATH}/*`,
  `${CUSTOM_API_BASE_PATH}/*`,
];

// The Swagger UI page and its spec sit inside CUSTOM_API_BASE_PATH (the only
// namespaces the ALB forwards are protected ones), so they must be carved out
// explicitly — `requiresAuth: false` alone doesn't override a `protected` match.
const PUBLIC_PATHS = isSwaggerUIEnabled() ? API_DOCS_PUBLIC_PATHS : [];

/**
 * Mastra authentication adapter for the common Keycloak/member validator.
 * The same normalized principal drives route policy, tool policy and memory isolation.
 */
export class CoreAuthProvider extends MastraAuthProvider<Principal> {
  private readonly validator: ReturnType<typeof core.auth.createValidator>;

  /** Sets protected/public paths and the shared validator; no arguments; invalid configuration throws. */
  constructor() {
    super({name: 'topcoder-shared-core', protected: PROTECTED_PATHS, public: PUBLIC_PATHS, mapUserToResourceId});
    this.validator = core.auth.createValidator();
  }

  /** Validates a bearer token; returns a normalized principal or null; token errors are sanitized and never logged. */
  async authenticateToken(token: string, _request?: unknown): Promise<Principal | null> {
    try { return await this.validator.verify(token); } catch { return null; }
  }

  /** Applies endpoint policy to the verified user/request; returns allow/deny; invalid policy configuration throws. */
  authorizeUser(user: Principal, request: MastraAuthRequest): boolean {
    return authorizeAccessPolicy(user, request);
  }
}

export const apiAuthLayer = new CoreAuthProvider();
