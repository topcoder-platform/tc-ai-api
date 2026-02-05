import { MastraAuthAuth0 } from '@mastra/auth-auth0';
import { CompositeAuth } from '@mastra/core/server';

export const apiAuthLayer = new CompositeAuth([
  // TC Member Auth0 JWTs
  new MastraAuthAuth0({
    domain: process.env.AUTH0_DOMAIN,
    audience: process.env.AUTH0_AUDIENCE,
    authorizeUser: async () => {
      // TODO: Custom authorization logic based on TC Member roles/permissions
      // Currently just allows all authenticated users with valid TC JWTs
      return true;
    },
  }),
  // TC M2M Auth0 JWTs
  new MastraAuthAuth0({
    domain: process.env.AUTH0_M2M_DOMAIN,
    audience: process.env.AUTH0_M2M_AUDIENCE,
    authorizeUser: async () => {
      // TODO: Custom authorization logic based on TC M2M scopes/permissions
      return true;
    },
  }),
]);
