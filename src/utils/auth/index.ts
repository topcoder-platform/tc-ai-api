import { MastraAuthAuth0 } from '@mastra/auth-auth0';
import { CompositeAuth } from '@mastra/core/server';

console.log('AUTH0_DOMAIN', process.env.AUTH0_DOMAIN);
console.log('AUTH0_AUDIENCE', process.env.AUTH0_AUDIENCE);
console.log('AUTH0_M2M_DOMAIN', process.env.AUTH0_M2M_DOMAIN);
console.log('AUTH0_M2M_AUDIENCE', process.env.AUTH0_M2M_AUDIENCE);

export const apiAuthLayer = new CompositeAuth([
  // // TC Member Auth0 JWTs
  // new MastraAuthAuth0({
  //   domain: process.env.AUTH0_DOMAIN,
  //   audience: process.env.AUTH0_AUDIENCE,
  // }),
  // TC M2M Auth0 JWTs
  new MastraAuthAuth0({
    domain: process.env.AUTH0_M2M_DOMAIN ?? 'topcoder-dev.auth0.com',
    audience: process.env.AUTH0_M2M_AUDIENCE ?? 'https://m2m.topcoder-dev.com/',
  }),
]);
