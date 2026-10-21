/** Explicit Keycloak settings for this workload; shared core rejects missing/invalid configuration. */
export const M2mConfig = {
  M2M_PROVIDER: process.env.M2M_PROVIDER,
  KEYCLOAK_ISSUER: process.env.KEYCLOAK_ISSUER,
  KEYCLOAK_AUDIENCE: process.env.KEYCLOAK_AUDIENCE,
  KEYCLOAK_TOKEN_URL: process.env.KEYCLOAK_TOKEN_URL,
  KEYCLOAK_CLIENT_ID: process.env.KEYCLOAK_CLIENT_ID,
  KEYCLOAK_CLIENT_SECRET: process.env.KEYCLOAK_CLIENT_SECRET,
  KEYCLOAK_SCOPE: process.env.KEYCLOAK_SCOPE,
};
