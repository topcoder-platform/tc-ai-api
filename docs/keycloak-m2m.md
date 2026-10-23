# Keycloak M2M migration branch

This branch pins shared core `4.0.0-keycloak.1` to immutable commit `e844764`.
Deploy only after this workload and its downstream receivers are configured for
Keycloak. Existing DEV application deployments remain on Auth0.

## Provider switch: `USE_KEYCLOAK`

`USE_KEYCLOAK=true` makes `M2MService` (the explicitly enabled tool fallbacks) get its
token from Keycloak, using `KEYCLOAK_TOKEN_URL`, `KEYCLOAK_AUDIENCE`,
`KEYCLOAK_CLIENT_ID` and `KEYCLOAK_CLIENT_SECRET` from workload-specific encrypted
storage (optional `KEYCLOAK_SCOPE` narrows approved grants). `KEYCLOAK_ISSUER` is also
required; see `.env.sample`. Never copy Auth0 M2M credentials into these settings.
Unset or `false` restores the Auth0 behaviour from before the migration: the request
goes to `M2M_AUTH_PROXY_SERVER_URL` (default `https://auth0proxy.topcoder-dev.com/token`)
for `M2M_AUTH_URL` (default `https://topcoder-dev.auth0.com/oauth/token`) and
`M2M_AUTH_AUDIENCE` (default `https://m2m.topcoder-dev.com/`) with
`M2M_AUTH_CLIENT_ID`/`M2M_AUTH_CLIENT_SECRET`. Issuance and caching belong to shared core.

`tc-core-library-js` reads the flag (`auth.useKeycloak`), so the service and the core
always agree. Any value other than `true`/`false` fails at startup. The CircleCI deploy
loads only `/config/tc-ai-api/appvar` (not `/config/common/global-appvar`), so the flag
is `/config/tc-ai-api/appvar/USE_KEYCLOAK`, next to the Keycloak and `M2M_AUTH_*` settings.

Incoming machine tokens: with `true`, Keycloak tokens are accepted, plus Auth0 tokens
while `LEGACY_M2M_ISSUERS`/`LEGACY_M2M_AUDIENCE` are set. With `false`, Auth0 tokens
are accepted through `LEGACY_M2M_*`, plus Keycloak tokens while `KEYCLOAK_ISSUER` and
`KEYCLOAK_AUDIENCE` are set, so callers that have not switched yet keep working.

**Rollback:** set `USE_KEYCLOAK=false` and force a new deployment so tasks re-read SSM.
No code or dependency change is needed. Keep the `M2M_AUTH_*` settings in SSM until
Keycloak has been accepted.

Member tokens retain explicit `VALID_ISSUERS` and `AUTH_USER_AUDIENCES` JSON arrays.
Legacy HMAC member tokens additionally require `AUTH_SECRET`. Set
`ALLOW_LEGACY_USER_AUDIENCE=true` only to explicitly retain legacy member audience
behavior. `LEGACY_M2M_ISSUERS`/`LEGACY_M2M_AUDIENCE` let Auth0 machine tokens pass the
same normalizer (see the provider switch above).

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
Do not set `DISABLE_AUTH=true` on accessible deployments. The core never retries a
failed Keycloak request against Auth0; rolling back is the explicit `USE_KEYCLOAK=false`
change above.

Validation: lint, the Mastra production build, and all 770 enabled tests pass
(one pre-existing test is skipped). Four boundary tests exercise signed RSA/HMAC
principals and verified issuance caching; `m2m.service.test.ts` covers both providers. Live DEV validation covers issuance,
cache reuse, normalized service identity, isolated memory keys, and workflow scope
denial. Standalone `tsc --noEmit` reports 13 pre-existing diagnostics in member
insights/search code and tests; an unchanged af5dfc76 snapshot with its original
lockfile reports the same 13 diagnostics. The new authentication provider typechecks.
