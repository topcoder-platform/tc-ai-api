import { MastraAuthAuth0 } from '@mastra/auth-auth0';
import { CompositeAuth } from '@mastra/core/server';

export const apiAuthLayer = new CompositeAuth([
  // TC Member Auth0 JWTs
  new MastraAuthAuth0({
    domain: process.env.AUTH0_DOMAIN,
    audience: process.env.AUTH0_AUDIENCE,
  }),
  // TC M2M Auth0 JWTs
  new MastraAuthAuth0({
    domain: process.env.AUTH0_M2M_DOMAIN ?? 'topcoder-dev.auth0.com',
    audience: process.env.AUTH0_M2M_AUDIENCE ?? 'https://m2m.topcoder-dev.com/',
  }),
]);
