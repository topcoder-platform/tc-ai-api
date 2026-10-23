/**
 * Outbound M2M settings for this workload. `tc-core-library-js` picks the provider from
 * `USE_KEYCLOAK` (see M2MService): `true` uses the KEYCLOAK_* settings and rejects missing or
 * invalid ones; unset, empty or `false` uses `auth0`, the M2M_AUTH_* settings and defaults this
 * service used before the Keycloak migration.
 */
export const M2mConfig = {
  KEYCLOAK_ISSUER: process.env.KEYCLOAK_ISSUER,
  KEYCLOAK_AUDIENCE: process.env.KEYCLOAK_AUDIENCE,
  KEYCLOAK_TOKEN_URL: process.env.KEYCLOAK_TOKEN_URL,
  KEYCLOAK_CLIENT_ID: process.env.KEYCLOAK_CLIENT_ID,
  KEYCLOAK_CLIENT_SECRET: process.env.KEYCLOAK_CLIENT_SECRET,
  KEYCLOAK_SCOPE: process.env.KEYCLOAK_SCOPE,
  auth0: {
    url: process.env.M2M_AUTH_URL ?? 'https://topcoder-dev.auth0.com/oauth/token',
    domain: process.env.M2M_AUTH_DOMAIN ?? 'topcoder-dev.auth0.com',
    audience: process.env.M2M_AUTH_AUDIENCE ?? 'https://m2m.topcoder-dev.com/',
    proxyUrl: process.env.M2M_AUTH_PROXY_SERVER_URL ?? 'https://auth0proxy.topcoder-dev.com/token',
    clientId: process.env.M2M_AUTH_CLIENT_ID,
    clientSecret: process.env.M2M_AUTH_CLIENT_SECRET,
  },
};
