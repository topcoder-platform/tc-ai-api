Object.assign(process.env, {
  M2M_PROVIDER: 'keycloak',
  KEYCLOAK_ISSUER: 'https://keycloak.example.test/realms/test',
  KEYCLOAK_AUDIENCE: 'https://api.example.test',
  KEYCLOAK_TOKEN_URL: 'https://keycloak.example.test/m2m/token',
  VALID_ISSUERS: '["https://members.example.test"]',
  AUTH_SECRET: 'synthetic-unit-test-key',
  ALLOW_LEGACY_USER_AUDIENCE: 'true',
});
