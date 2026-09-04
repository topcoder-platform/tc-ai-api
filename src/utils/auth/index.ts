import { MastraAuthAuth0 } from '@mastra/auth-auth0';
import { CompositeAuth } from '@mastra/core/server';
import { API_PREFIX, CHAT_ROUTE_BASE_PATH, RAG_ADMIN_ROUTE_BASE_PATH } from '../server-routes';
import { authorizeAccessPolicy } from './access-control';
import { tcUserIdClaimKey } from './tc-domain';

const mapUserToResourceId = (user: Record<string, unknown>): string | undefined => {
  const userId = user[tcUserIdClaimKey()];
  if (typeof userId === 'string') return userId;
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
  `${RAG_ADMIN_ROUTE_BASE_PATH}/*`,
];

export const apiAuthLayer = new CompositeAuth([
  // TC Member Auth0 JWTs
  new MastraAuthAuth0({
    domain: process.env.AUTH0_DOMAIN,
    audience: process.env.AUTH0_AUDIENCE,
    protected: PROTECTED_PATHS,
    mapUserToResourceId,
    authorizeUser: authorizeAccessPolicy,
  }),
  // TC M2M Auth0 JWTs
  new MastraAuthAuth0({
    domain: process.env.AUTH0_M2M_DOMAIN,
    audience: process.env.AUTH0_M2M_AUDIENCE,
    protected: PROTECTED_PATHS,
    mapUserToResourceId,
    authorizeUser: authorizeAccessPolicy,
  }),
]);
