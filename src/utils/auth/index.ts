import { CompositeAuth } from '@mastra/core/server';
import {
  API_DOCS_PUBLIC_PATHS,
  API_PREFIX,
  CHAT_ROUTE_BASE_PATH,
  CUSTOM_API_BASE_PATH,
  isSwaggerUIEnabled,
} from '../server-routes';
import { tcUserIdClaimKey } from './tc-domain';
import { SharedJwtAuth } from './shared-jwt-auth';

const mapUserToResourceId = (user: Record<string, unknown>): string | undefined => {
  const userId = user[tcUserIdClaimKey()];
  if (typeof userId === 'string' || typeof userId === 'number') return String(userId);
  // M2M tokens don't carry the TC userId claim; fall back to the subject
  return typeof user.sub === 'string' ? user.sub : undefined;
};

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

function authProvider(domain: string | undefined, audience: string | undefined): SharedJwtAuth {
  if (!domain || !audience) throw new Error('Auth0 domain and audience are required');
  return new SharedJwtAuth({
    jwt: {
      issuers: [{ issuer: `https://${domain}/`, algorithm: 'RS256', audience }],
      // A client-credentials token must target the machine API audience,
      // even if both token types share an Auth0 tenant.
      AUTH0_AUDIENCE: process.env.AUTH0_M2M_AUDIENCE,
    },
    protected: PROTECTED_PATHS,
    public: PUBLIC_PATHS,
    mapUserToResourceId,
  });
}

export const apiAuthLayer = new CompositeAuth([
  // TC Member Auth0 JWTs
  authProvider(process.env.AUTH0_DOMAIN, process.env.AUTH0_AUDIENCE),
  // TC M2M Auth0 JWTs
  authProvider(process.env.AUTH0_M2M_DOMAIN, process.env.AUTH0_M2M_AUDIENCE),
]);
