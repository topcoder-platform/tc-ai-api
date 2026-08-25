import { MastraAuthAuth0 } from '@mastra/auth-auth0';
import { CompositeAuth } from '@mastra/core/server';
import { API_PREFIX } from '../server-routes';

// Matches the TC userId claim key used across the platform, e.g.
// https://topcoder.com/userId or https://topcoder-dev.com/userId
const tcUserIdClaimKey = (): string => {
  const tcApiBase = process.env.TC_API_BASE || '';
  let domain = 'topcoder.com';
  try {
    if (tcApiBase) {
      domain = new URL(tcApiBase).hostname.replace('api.', '');
    }
  } catch {
    // fall back to default domain
  }
  return `https://${domain}/userId`;
};

const mapUserToResourceId = (user: Record<string, unknown>): string | undefined => {
  const userId = user[tcUserIdClaimKey()];
  if (typeof userId === 'string') return userId;
  // M2M tokens don't carry the TC userId claim; fall back to the subject
  return typeof user.sub === 'string' ? user.sub : undefined;
};

export const apiAuthLayer = new CompositeAuth([
  // TC Member Auth0 JWTs
  new MastraAuthAuth0({
    domain: process.env.AUTH0_DOMAIN,
    audience: process.env.AUTH0_AUDIENCE,
    protected: [`${API_PREFIX}/*`],
    mapUserToResourceId,
  }),
  // TC M2M Auth0 JWTs
  new MastraAuthAuth0({
    domain: process.env.AUTH0_M2M_DOMAIN,
    audience: process.env.AUTH0_M2M_AUDIENCE,
    protected: [`${API_PREFIX}/*`],
    mapUserToResourceId,
  }),
]);
