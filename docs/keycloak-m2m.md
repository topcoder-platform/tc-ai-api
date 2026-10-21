# Keycloak M2M migration branch

This branch pins shared core `4.0.0-keycloak.0` to immutable commit `c262f4a`.
Deploy only after this workload and its downstream receivers are configured for
Keycloak. Existing DEV application deployments remain on Auth0.

Set `M2M_PROVIDER=keycloak`, `KEYCLOAK_ISSUER`, `KEYCLOAK_AUDIENCE`, and
`KEYCLOAK_TOKEN_URL` as shown in `.env.sample`. Outbound fallback credentials use
`KEYCLOAK_CLIENT_ID`/`KEYCLOAK_CLIENT_SECRET` from workload-specific encrypted
storage; optional `KEYCLOAK_SCOPE` narrows approved grants. Never copy Auth0 M2M
credentials into these settings. Issuance and caching belong to shared core.

Member tokens retain explicit `VALID_ISSUERS` and `AUTH_USER_AUDIENCES` JSON arrays.
Legacy HMAC member tokens additionally require `AUTH_SECRET`. Set
`ALLOW_LEGACY_USER_AUDIENCE=true` only to explicitly retain legacy member audience
behavior. Optional `LEGACY_M2M_ISSUERS`/`LEGACY_M2M_AUDIENCE` provide a deliberate
validation overlap; issuance never falls back to Auth0.

`CoreAuthProvider` returns only shared normalized principals. Endpoint and tool
policy uses normalized member roles or common `hasScopes(..., 'any')` for services.
Raw namespaces, arbitrary role-claim overrides, permissions and missing user IDs
cannot establish machine identity. Existing public/deny/restricted target policies
remain in effect; `public` still means an authenticated caller. Register and grant
`challengesRAG:admin` and `sys1:use` only to clients authorized for those operations.

Member memory keys remain numeric IDs rendered as strings. Service keys contain
both issuer and client ID, so they cannot collide with member IDs or another issuer.
Existing Auth0 service-memory keys are not reused automatically. Resource middleware
trusts only the reserved verified identity, never a plain requestContext.user from
HTTP input. Trusted in-process tool calls must supply normalized principal fixtures.

Run `nvm use`, `pnpm lint`, `pnpm build`, and `pnpm test` before rollout. Validate
scoped allow/deny behavior and member role access against real downstream receivers.
Do not set `DISABLE_AUTH=true` on accessible deployments. Roll back application,
core dependency, and workload credentials together; do not automatically retry with
Auth0 credentials after an issuance failure.

Validation: lint, the Mastra production build, and all 767 enabled tests pass
(one pre-existing test is skipped). Four boundary tests exercise signed RSA/HMAC
principals and verified issuance caching. Live DEV validation covers issuance,
cache reuse, normalized service identity, isolated memory keys, and workflow scope
denial. Standalone `tsc --noEmit` reports 13 pre-existing diagnostics in member
insights/search code and tests; an unchanged af5dfc76 snapshot with its original
lockfile reports the same 13 diagnostics. The new authentication provider typechecks.
