import { MastraAuthAuth0 } from '@mastra/auth-auth0';
import { CompositeAuth } from '@mastra/core/server';

export const apiAuthLayer = new CompositeAuth([
  // TC Member Auth0 JWTs
  new MastraAuthAuth0({
    domain: process.env.AUTH0_DOMAIN,
    audience: process.env.AUTH0_AUDIENCE,
    authorizeUser: async (...args) => {
      // TODO: Custom authorization logic based on TC Member roles/permissions
      // Currently just logs the args and allows all authenticated users regardless of roles
      console.log('TC User JWT Args are', args);
      return true;
    },
  }),
  // TC M2M Auth0 JWTs
  new MastraAuthAuth0({
    domain: process.env.AUTH0_M2M_DOMAIN,
    audience: process.env.AUTH0_M2M_AUDIENCE,
    authorizeUser: async (...args) => {
      // TODO: Custom authorization logic based on TC M2M scopes/permissions
      //
      console.log('TC M2M JWT Args are', args);
      return true;
    },
  }),
]);
