# ADR 0004 — Role-based access control for Agents, Workflows, and Tools

- **Status:** **Accepted — implemented** (see *Implementation notes* at the end for three corrections found while building it)
- **Date:** 2026-08-27
- **Target branch:** `challenges-rag`
- **Related:** ADR 0001 (D10 — "any scope restriction MUST be enforced server-side, never left to the model"), ADR 0002 (existing inbound-vs-outbound auth split), `src/utils/auth/index.ts` (`apiAuthLayer`), `src/utils/middleware/resourceIdMiddleware.ts`, `src/config/tool-auth-fallback.config.ts` (precedent for a per-tool, opt-in-by-default code registry)

## Corrections after implementation

Two claims below turned out to be wrong when the design was executed rather than read. Both are corrected in place
where they appear; recorded together here because one of them was a live vulnerability and the other invalidates this
ADR's headline argument.

### C1. The registry-key alias bypassed every policy (fixed)

Policies key on a resource's own `.id`, but `getAgentById`/`getWorkflowById` fall back to the **registry key**, so both
spellings address the same resource over HTTP — and `authorizeAccessPolicy` trusted whichever appeared in the URL:

```
/v6/ai/workflows/challenge-ingestion/start          member(no roles) -> DENY
/v6/ai/workflows/challengeIngestionWorkflow/start   member(no roles) -> ALLOW  <-- BYPASS
```

Not hypothetical: platform-ui's `RAG_CHALLENGE_INGESTION_WORKFLOW_ID` defaulted to the registry key, so the only
production caller of a restricted workflow was using the bypassing spelling. The "Registry-key vs `.id` is a standing
footgun" risk noted at the bottom of this ADR was therefore understated — it was not only a config-authoring hazard,
it was an authorization bypass. Fixed by `TARGET_ID_ALIASES` + `canonicalTargetId()` in
`src/config/access-control.config.ts`, applied inside `resolveAccessPolicy()` before any lookup. Tests assert every
alias resolves identically to its canonical id, and that every restricted code default has an alias entry.

### C2. There was no chatRoute gap

This ADR's central argument — that `chatRoute` can never reach `authorizeUser` because it declares neither a matching
`protected` path nor `requiresAuth` — is **false**. `buildHonoApp` derives `const requiresAuth = route.requiresAuth
!== false` (`@mastra/deployer/dist/server/index.js:4478`), so custom routes are protected **by default**, and
`isProtectedCustomRoute` pattern-matches the registered `/v6/ai-chat/:agentId` against the incoming path. Executed
against the real exported helpers with the *pre-ADR* config (`protected: ['/v6/ai/*']`):

```
POST /v6/ai-chat/challenge-search-agent   customRoute=true  protectedPre=true  protectedPost=true
```

chatRoute was already protected and already reaching `authorizeUser`; it has been covered since `authorizeUser` became
a real function, with no `protected`-list change required. The `${CHAT_ROUTE_BASE_PATH}/*` entry is kept — it makes
coverage explicit and independent of Mastra's `requiresAuth` default rather than contingent on it — but it is
belt-and-braces, not the load-bearing fix this ADR claimed. The error was reading `isProtectedPath`'s two branches
without checking what populates `customRouteAuthConfig`.

## Context

### What exists today

Authentication (not authorization) is already in place:

- `apiAuthLayer` (`src/utils/auth/index.ts`) is a `CompositeAuth` of two `MastraAuthAuth0` providers: one validates **member** JWTs (`AUTH0_DOMAIN`/`AUTH0_AUDIENCE`), one validates **inbound M2M** JWTs (`AUTH0_M2M_DOMAIN`/`AUTH0_M2M_AUDIENCE` — a *separate* Auth0 API resource from the *outbound* M2M identity in `src/config/m2m.config.ts`/`M2MService`, which this service uses to call *other* TC APIs per ADR 0002. Easy to conflate; they are opposite directions).
- `resourceIdMiddleware`/`chatResourceIdMiddleware` (`src/utils/middleware/resourceIdMiddleware.ts`) run on every request under `${API_PREFIX}/*` (`/v6/ai/*`) and `${CHAT_ROUTE_BASE_PATH}/*` (`/v6/ai-chat/*`), resolve the authenticated user (from context or by calling `apiAuthLayer.authenticateToken` directly), and pin `MASTRA_RESOURCE_ID_KEY` to the caller's TC userId (member) or `sub` (M2M) so Mastra memory is scoped per-caller. This 401s on missing/invalid auth.
- `DISABLE_AUTH=true` turns the whole thing off (local dev/test).

**What's missing:** nothing today distinguishes *who* the caller is once they're authenticated. Any valid member JWT or M2M JWT — regardless of role or granted scope — can call any agent, run any workflow, or (transitively, as an agent tool call) invoke any tool. Concretely: `challenge-bulk-ingestion` re-embeds and rewrites the shared vector index for every challenge matching a filter — currently callable by any authenticated principal, member or M2M, with zero privilege check. ADR 0001's own D10 said scope restriction "MUST be enforced server-side, never left to the model" — that principle currently has no RBAC layer to stand on.

### The existing auth layer already works correctly — this ADR extends it, not replaces it

To be precise about what's already proven to work in production versus what's actually missing: **authentication is correctly enforced today on all three HTTP surfaces** — native Mastra routes (`/v6/ai/agents/*`, `/v6/ai/workflows/*`) and the custom `chatRoute()` (`/v6/ai-chat/:agentId`) all reject missing/invalid tokens with `401`. That's confirmed working and this ADR does not touch it. The gap is narrower and one level up: **nothing today checks *which* authenticated caller is allowed to do *which* thing** — there is no authorization/RBAC layer on top of a correctly-functioning authentication layer. This section documents exactly which existing mechanism this ADR plugs into, verified by reading the installed packages' actual compiled code (`@mastra/core@1.63.0`, `@mastra/server@1.63.0`, `@mastra/deployer@1.63.0`, `@mastra/auth-auth0@1.2.2`), not assumed from docs alone.

**Mastra's own per-route auth check already runs for every registered route, built-in or custom.** `registerRoute()` (`@mastra/deployer`'s server adapter) wraps *every* route it mounts — including `apiRoutes` entries like `chatRoute()` — in an identical call to `this.checkRouteAuth(route, {...})` before invoking the route's own handler. `checkRouteAuth` (`@mastra/server`'s `server-adapter/index.js`) is a thin wrapper around the exported `coreAuthMiddleware` (`@mastra/server`'s `helpers.ts`): it re-authenticates the token via `authConfig.authenticateToken`, populates `requestContext` (`user`, `MASTRA_RESOURCE_ID_KEY` via `authConfig.mapUserToResourceId`, and — if a `server.rbac` provider is configured, which this repo doesn't use — `MASTRA_USER_ROLES_KEY`/`MASTRA_USER_PERMISSIONS_KEY`), and then — this is the load-bearing part — calls `authConfig.authorizeUser(user, request)` if the auth config implements it, denying with `403` on `false`. So `authorizeUser` isn't a hook this ADR has to newly wire into the request path; **it is already invoked on every request Mastra considers "protected," today, and simply defaults to allow-all** because neither `MastraAuthAuth0` in `apiAuthLayer` currently supplies a custom `authorizeUser` (each falls back to `MastraAuthAuth0`'s own default: *"allows access to all authenticated users"*, confirmed in `@mastra/auth-auth0`'s reference doc). Extending `apiAuthLayer`'s two providers with a role/scope-checking `authorizeUser` therefore isn't new plumbing — it's supplying the one missing argument to plumbing that's already firing on every protected request. `CompositeAuth.authorizeUser` (confirmed by reading `@mastra/core`'s compiled `CompositeAuth` class) ORs its providers' `authorizeUser` results, so the same function can be passed to both the member and M2M `MastraAuthAuth0` instances without conflict — each just evaluates the same `(user, request)` pair independently.

(Mastra also ships two other, more elaborate authorization primitives on `MastraAuthConfig` — a declarative `rules: [{ path, methods, condition, allow }]` array and an `authorize(path, method, user, ctx)` function — plus a wholly separate `server.rbac`/`server.fga` provider concept (`getPermissions`/`getRoles`, EE-gated). None of these apply here: `coreAuthMiddleware` checks `"authorizeUser" in authConfig"` **first**, and falls through to `authorize`/`rules` only when `authorizeUser` is absent. Since `apiAuthLayer` is a `CompositeAuth`, which always implements `authorizeUser`, those other branches are unreachable for this setup regardless. `authorizeUser` is correctly the one mechanism to build on here, not a preference among several equally-live options.)

**"Protected" is a path-pattern decision, evaluated once per route, made *before* `authorizeUser` ever gets a chance to run.** *(The rest of this paragraph, and its conclusion that this is "the actual, narrow gap", is **wrong** — see C2 above. Custom routes default to `requiresAuth: true`, so `isProtectedCustomRoute` already returned `true` for chatRoute. Retained as written for the record.)* `coreAuthMiddleware` only proceeds to authenticate/authorize a request at all if `isProtectedPath(path, method, authConfig, customRouteAuthConfig)` is true. That function ORs two things: (a) the path matching an entry in `defaultAuthConfig.protected` (Mastra's own built-in default, `["/api/*"]` — unrelated to this repo's `API_PREFIX`) or `authConfig.protected` (this repo's `${API_PREFIX}/*`, i.e. `/v6/ai/*`, merged from both `MastraAuthAuth0` instances by `CompositeAuth`'s constructor), or (b) the specific custom route being registered with `requiresAuth: true` in its own definition (`isProtectedCustomRoute`, keyed off a `customRouteAuthConfig` map built from each `apiRoutes` entry's own `requiresAuth` field). `chatRoute()` (`@mastra/ai-sdk`) does neither: its path is `/v6/ai-chat/:agentId`, which matches neither `/api/*` nor `/v6/ai/*`, and its `registerApiRoute(...)` call (confirmed by reading the installed `@mastra/ai-sdk@1.10.0` source) never sets `requiresAuth`. So `checkRouteAuth`/`coreAuthMiddleware` **does get invoked** for every chatRoute request (it's registered through the exact same `registerRoute()` path as everything else), but `isProtectedPath` returns `false` for it, and the function returns "allow, do nothing" before ever reaching `authenticateToken` or `authorizeUser`. **This is why `authorizeUser` alone, even once populated with a real policy, would never fire for chatRoute** — not because chatRoute lacks auth (it doesn't; see next paragraph), but because Mastra's native per-route check never gets past its own "is this path protected" gate for it.

**What actually authenticates chatRoute today is this repo's own code, running earlier in the request pipeline, independently of the mechanism above.** `resourceIdMiddleware`/`chatResourceIdMiddleware` (`src/utils/middleware/resourceIdMiddleware.ts`) are registered as Hono `server.middleware` entries (`${API_PREFIX}/*` and `${CHAT_ROUTE_BASE_PATH}/*`), which Hono runs *before* the specific route handler — i.e. before `checkRouteAuth` ever executes inside that handler. `resourceIdMiddlewareHandler` calls `apiAuthLayer.authenticateToken(...)` directly and 401s on failure; that's genuinely why chatRoute correctly rejects bad tokens today, and this ADR changes none of it. But this custom middleware only calls `authenticateToken` — never `authorizeUser` — so even with a real role/scope check wired into `apiAuthLayer`, nothing on the chatRoute path evaluates it, from either mechanism, until this ADR closes that specific, narrow gap.

**The fix, given all of the above, is one line, not new middleware** *(superseded by C2 — chatRoute needed no fix; the line below is retained as explicit, default-independent coverage)**:* add `${CHAT_ROUTE_BASE_PATH}/*` to the `protected` array already passed to both `MastraAuthAuth0` providers in `apiAuthLayer`. That's the only thing standing between chatRoute and the exact same native `checkRouteAuth`/`coreAuthMiddleware`/`authorizeUser` path every other protected route already goes through — since `checkRouteAuth` already runs for chatRoute on every request (confirmed above), it only needs `isProtectedPath` to say yes. No new middleware, no second copy of the authorization check, no risk of the two mechanisms drifting apart. `resourceIdMiddleware.ts` itself needs **no changes** for this — it keeps doing exactly what it does today (pre-emptive authentication + resourceId scoping); `coreAuthMiddleware` will now additionally run its own (redundant, harmless — same token, same result) authentication and, newly, its authorization check, immediately afterward, inside the route handler.

Tools remain the one case genuinely outside this entire mechanism: this codebase never registers a top-level `tools: {}` map on the `Mastra` instance, so a tool is never itself a route — it's invoked from inside an agent's tool-calling loop (`generate`/`stream`/chatRoute, all already covered by the above) or directly from workflow step code (`tool.execute(...)`, e.g. `challenge-search-workflow.ts:249`, `challenge-bulk-ingestion-workflow.ts`). There's no path/route for `coreAuthMiddleware` to gate for a tool specifically — enforcement for that category has to happen inside the tool itself, using the `user` that `coreAuthMiddleware`/`resourceIdMiddleware` already placed on `RequestContext` by the time any tool runs. See Decision 5.

### Route addressing — `.id` wins, not the registry key (verified, not assumed)

`Mastra.getAgentById()`'s own docs: *"It first searches registered agents by `agent.id`. If no agent matches, it falls back to... the agent registry key."* Confirmed the same holds for workflows by reading this repo's code: `challenge-bulk-ingestion-workflow.ts:318` calls `registry.getWorkflowById('challenge-ingestion')` (the workflow's own `id:` field) to invoke the nested ingestion run, and `challenge-context-workflow.ts:947` calls `mastra.getAgentById('challenge-parser-agent')` (the agent's own `id:` field) — neither uses the object-property name it's registered under in `src/mastra/index.ts`.

This matters because **5 of the 10 agent/workflow registrations in this repo have a registry key that differs from the resource's own `.id`**:

| Registered as (object key in `src/mastra/index.ts`) | Resource's own `.id` |
| --- | --- |
| `challengeParserAgent` | `challenge-parser-agent` |
| `challengeSearchAgent` | `challenge-search-agent` |
| `jdRewriterAgent` | `jd-rewriter-agent` |
| `challengeIngestionWorkflow` | `challenge-ingestion` |
| `challengeBulkIngestionWorkflow` | `challenge-bulk-ingestion` |
| `challengeSearchWorkflow` | `challenge-search` |
| `challengeContextWorkflow` | `challenge-context` |
| `skillExtractionWorkflow` | `skill-extraction-workflow` |
| `jdAutowriteWorkflow` | `jd-autowrite` |
| `skillsMatchingAgent` | `skillsMatchingAgent` *(matches — the one exception)* |

Any policy keyed on the wrong one silently never matches, and a miss defaults to "no policy configured" — a false sense of security, not a loud failure. This ADR keys every policy on the resource's own `.id` (the value used at `createTool`/`createStep`/`new Agent`/`createWorkflow` call sites — literally the `AGENT_ID`/`TOOL_ID`/`id:` constants already visible in each file), and flags getting this right as a Prerequisite to double-check during implementation, not an assumption to carry forward silently.

### Nested, in-process invocations are transitively covered, not separately gated

`challenge-bulk-ingestion` invokes `challenge-ingestion` via `getWorkflowById → createRun → run.start` (in-process, not a second HTTP round-trip); `challenge-context` invokes `challenge-parser-agent` via `mastra.getAgentById(...).generate(...)` (also in-process). Neither nested call re-enters Mastra's HTTP router, so an HTTP-boundary policy check does **not** run a second time for the nested call — it inherits whatever authorization already happened at the outer HTTP entry point. This is intentional, not a gap: you cannot reach the nested call without already having passed the outer one.

### No existing role/scope claim convention — greenfield, needs to be flexible

Nothing in this codebase reads a roles or scope claim today. The only comparable prior art is the TC userId claim (`https://<domain>/userId`, domain derived from `TC_API_BASE`, dev vs prod) used by `mapUserToResourceId`/`resourceIdMiddleware` — and that exact domain-derivation snippet is **already duplicated three times** (`src/utils/auth/index.ts`, `src/utils/middleware/resourceIdMiddleware.ts`, `src/mastra/agents/challenge/challenge-search-agent.ts`). This ADR adds a parallel `https://<domain>/roles` claim by the same convention and takes the opportunity to consolidate the domain-resolution snippet into one shared helper, since this would otherwise be a fourth copy.

**Confirmed against a real decoded member JWT (prod, `iss: https://auth.topcoder.com/`):** the roles claim is `https://topcoder.com/roles`, a plain string array — exactly the guessed convention, domain-derived the same way as `.../userId` (so `https://topcoder-dev.com/roles` on dev, per the same `resolveTcDomain()` logic). The same token's array includes `"administrator"` verbatim — confirming both the claim key and the exact role string this ADR's default policy checks for. `ACCESS_CONTROL_ROLES_CLAIM` remains available as an override, but its default (`https://${resolveTcDomain()}/roles`) is now verified correct, not a guess. (Note: this evidence is a **member** token; it carries no `scope` claim, so it says nothing about the M2M side — `challengesRAG:admin` still needs to be created in Auth0 as a permission on the M2M audience, see Prerequisites.)

## Scope

**In scope:**

- A policy model (`public` / `deny` / `restricted { roles?, scopes? }`) and a resolution order (env override → code-level default → global default) shared across all three categories.
- Enforcement for **agents and workflows** by supplying a real `authorizeUser` to `apiAuthLayer` — the hook Mastra's native `coreAuthMiddleware` already invokes on every protected request today (currently a no-op default-allow) — plus extending the `protected` path list so that existing, already-running mechanism also covers `chatRoute` (`/v6/ai-chat/:agentId`), the one surface it doesn't reach today.
- Enforcement for **tools** in-process, via the authenticated user already carried on `RequestContext` (set by Mastra's own `coreAuthMiddleware` and by this repo's `resourceIdMiddleware` before any agent/workflow body runs) — since tools have no HTTP route of their own for any auth middleware to gate.
- An env-var configuration surface following this repo's existing convention (`rag.config.ts`'s validated-with-sane-default pattern), plus a code-level default registry following `TOOL_M2M_FALLBACK_CONFIG`'s existing precedent (explicit map, absent entry = default, flipping an entry is a reviewable privilege decision).
- A baked-in default policy — **`roles: ['administrator']`, `scopes: ['challengesRAG:admin']`** — for `challenge-ingestion` and `challenge-bulk-ingestion`, so a fresh deploy is safe before any operator sets an env var.
- Unit tests verifying correct allow/deny behavior for each category (agent, workflow, tool) and each credential type (member role, M2M scope), plus the policy-resolution precedence itself.

**Out of scope (explicitly deferred, not rejected):**

- Fine-grained, per-resource-**instance** policy (e.g. "this member may only ingest projectId X"). This ADR is resource-**category** RBAC — which agent/workflow/tool a caller may invoke at all — not row-level ABAC. ADR 0001's D10 project-isolation model is unaffected and unrelated.
- Any UI/admin surface for managing policies. Configuration is env vars + a code registry, matching every other config surface in this repo (`rag.config.ts`, `TOOL_M2M_FALLBACK_CONFIG`).
- Auditing beyond a single structured log line per denial (reusing `tcAILogger`, matching the existing `tcAILogger.warn`/`.error` usage elsewhere).
- Rate limiting — a separate, unrelated concern.
- Changing anything about `DISABLE_AUTH`'s existing behavior (dev/test escape hatch, unchanged: RBAC is inert whenever auth is disabled, since there's no authenticated user to check).
- A separate Studio auth design — not needed. Confirmed: Studio routes agent/workflow interactions through the same `/v6/ai/agents/*`/`/v6/ai/workflows/*` HTTP paths as any other caller, so this ADR's enforcement automatically covers Studio too, with no Studio-specific code. In practice this mostly matters when auth is enabled with `DISABLE_AUTH=false` — a developer using Studio against such an environment needs the same role/scope as any other caller to reach a restricted resource (`challenge-ingestion`/`challenge-bulk-ingestion` by default); Studio itself doesn't get a bypass.

## Resource inventory (as of this ADR; the config registry must track any future addition)

| Category | Registered as (object key) | `.id` used for routing/policy | Caller surface |
| --- | --- | --- | --- |
| Agent | `challengeSearchAgent` | `challenge-search-agent` | `/v6/ai/agents/challenge-search-agent/*`, `/v6/ai-chat/challenge-search-agent` |
| Agent | `challengeParserAgent` | `challenge-parser-agent` | `/v6/ai/agents/challenge-parser-agent/*`; also invoked in-process by `challenge-context` |
| Agent | `jdRewriterAgent` | `jd-rewriter-agent` | `/v6/ai/agents/jd-rewriter-agent/*`; also invoked in-process by `jd-autowrite` |
| Agent | `skillsMatchingAgent` | `skillsMatchingAgent` | `/v6/ai/agents/skillsMatchingAgent/*`; also invoked in-process by `skill-extraction-workflow` |
| Workflow | `challengeIngestionWorkflow` | `challenge-ingestion` | `/v6/ai/workflows/challenge-ingestion/*` — **default-restricted (this ADR)** |
| Workflow | `challengeBulkIngestionWorkflow` | `challenge-bulk-ingestion` | `/v6/ai/workflows/challenge-bulk-ingestion/*` — **default-restricted (this ADR)** |
| Workflow | `challengeSearchWorkflow` | `challenge-search` | `/v6/ai/workflows/challenge-search/*` |
| Workflow | `challengeContextWorkflow` | `challenge-context` | `/v6/ai/workflows/challenge-context/*` |
| Workflow | `skillExtractionWorkflow` | `skill-extraction-workflow` | `/v6/ai/workflows/skill-extraction-workflow/*` |
| Workflow | `jdAutowriteWorkflow` | `jd-autowrite` | `/v6/ai/workflows/jd-autowrite/*` |
| Tool | `challengeVectorQueryTool` | `challenge-vector-query` | Agent-callable (`challengeSearchAgent`); also called directly by `challenge-search` workflow steps |
| Tool | `fetchChallengeTool` | `fetch-challenge-by-id` | Agent-callable (`challengeSearchAgent`) |
| Tool | `fetchProjectTool` | `fetch-project-by-id` | Agent-callable (`challengeSearchAgent`) |
| Tool | `searchChallengesTool` | `search-challenges` | Workflow-internal only (`challenge-bulk-ingestion` step) — not agent-exposed |
| Tool | `standardizedSkillsFuzzyTool` | `standardized-skills-fuzzy-match` | Workflow-internal only (`skill-extraction-workflow` step) |
| Tool | `standardizedSkillsSemanticTool` | `standardized-skills-semantic-search` | Workflow-internal only (`skill-extraction-workflow` step) |

Every resource not explicitly listed with a restricted default falls through to `public` (any authenticated caller) — unchanged from today's behavior. Only the two ingestion workflows change behavior out of the box.

## Decision

### 1. Policy model and resolution (`src/config/access-control.config.ts`)

```ts
export type AccessPolicy =
  | { mode: 'public' }                                          // any authenticated caller
  | { mode: 'deny' }                                             // nobody, regardless of role/scope
  | { mode: 'restricted'; roles?: string[]; scopes?: string[] }; // see checkAccess below

export type AccessCategory = 'agent' | 'workflow' | 'tool' | 'route';
// 'route' was added when the RAG index admin API landed: this repo's own
// registerApiRoute entries are neither agents nor workflows, so they matched
// none of authorizeAccessPolicy's patterns and stayed open to any
// authenticated caller. Route slugs are assigned by this repo (mapped from a
// path prefix by ROUTE_PATH_TARGETS), so they have no registry-key alias.

/**
 * Code-level defaults, mirroring TOOL_M2M_FALLBACK_CONFIG's convention:
 * a target id absent here falls through to ACCESS_CONTROL_DEFAULT_POLICY
 * (public unless overridden). Flipping an existing entry, or adding a new
 * `deny`/`restricted` entry, is a reviewable privilege decision.
 */
export const DEFAULT_ACCESS_POLICIES: Record<AccessCategory, Record<string, AccessPolicy>> = {
  agent: {},
  workflow: {
    'challenge-ingestion': { mode: 'restricted', roles: ['administrator'], scopes: ['challengesRAG:admin'] },
    'challenge-bulk-ingestion': { mode: 'restricted', roles: ['administrator'], scopes: ['challengesRAG:admin'] },
  },
  tool: {},
  route: {
    // GET/DELETE ${API_PREFIX}/rag/challenges — mutates the same shared vector
    // index as the ingestion workflows, so it ships behind the same credentials.
    'rag-challenges': { mode: 'restricted', roles: ['administrator'], scopes: ['challengesRAG:admin'] },
  },
};
```

Resolution order, per `(category, targetId)`, computed once and cached (mirrors `getRagConfig()`'s lazy-resolve-once style, just keyed instead of singleton):

1. **Env override** — `ACCESS_POLICY_<CATEGORY>_<TARGET_KEY>_MODE` / `_ROLES` / `_SCOPES` (see Env surface below), if any of the three is set for that target.
2. **Code default** — `DEFAULT_ACCESS_POLICIES[category][targetId]`, if present.
3. **Global default** — `ACCESS_CONTROL_DEFAULT_POLICY` env var, `public` (default) or `deny`.

`<TARGET_KEY>` is the target's `.id` upper-snake-cased (`toEnvKey('challenge-ingestion') === 'CHALLENGE_INGESTION'`, `toEnvKey('challenge-vector-query') === 'CHALLENGE_VECTOR_QUERY'`) — same transform in both directions, unit-tested directly (see Testing).

### 2. Claim extraction — consolidate the existing domain-derivation, add a parallel roles claim

Extract the domain-derivation snippet duplicated in `src/utils/auth/index.ts`, `resourceIdMiddleware.ts`, and `challenge-search-agent.ts` into one shared helper (proposed: `src/utils/auth/tc-domain.ts`, `resolveTcDomain(): string`), and have all three existing call sites — plus this ADR's new code — import it. This ADR would otherwise add a fourth near-identical copy; consolidating now is a small, low-risk, directly-motivated cleanup, not a separate refactor.

```ts
// src/utils/auth/tc-domain.ts (new, extracted — behavior-identical to the 3 existing copies)
export function resolveTcDomain(): string { /* TC_API_BASE hostname, minus "api.", default "topcoder.com" */ }

// src/utils/auth/access-control.ts (new)
const rolesClaimKey = () =>
  process.env.ACCESS_CONTROL_ROLES_CLAIM || `https://${resolveTcDomain()}/roles`;

interface AuthenticatedCaller {
  isM2M: boolean;      // mirrors resourceIdMiddleware's existing userId-claim-absent test
  roles: string[];     // from rolesClaimKey(), [] if absent/not an array
  scopes: string[];    // from the standard OAuth `scope` claim, space-delimited, [] if absent
}

export function toAuthenticatedCaller(user: Record<string, unknown>): AuthenticatedCaller {
  const userIdKey = `https://${resolveTcDomain()}/userId`;
  const isM2M = !user[userIdKey];
  const rawRoles = user[rolesClaimKey()];
  const roles = Array.isArray(rawRoles) ? rawRoles.filter((r): r is string => typeof r === 'string') : [];
  const scopes = typeof user.scope === 'string' ? user.scope.split(' ').filter(Boolean) : [];
  return { isM2M, roles, scopes };
}
```

`ACCESS_CONTROL_ROLES_CLAIM` exists as an override point in case a different environment's Auth0 tenant ever uses a different claim name — its default (`https://${resolveTcDomain()}/roles`) is confirmed correct against a real decoded prod token (see Context), so this is a safety valve for the unexpected, not a stand-in for an unverified guess.

### 3. The shared check (`checkAccess`)

```ts
export function checkAccess(caller: AuthenticatedCaller, policy: AccessPolicy): boolean {
  if (policy.mode === 'public') return true;
  if (policy.mode === 'deny') return false;
  // mode === 'restricted': each credential type is checked against its own dimension only.
  if (caller.isM2M) {
    return !!policy.scopes?.length && policy.scopes.some(s => caller.scopes.includes(s));
  }
  return !!policy.roles?.length && policy.roles.some(r => caller.roles.includes(r));
}
```

Deliberately **not** "either dimension satisfies either credential type" — an M2M caller is checked only against `scopes`, a member caller only against `roles`. A `restricted` policy that configures only `roles` (no `scopes`) implicitly denies all M2M callers for that target, and vice versa; this is the direct implementation of the requirement *"based on JWT token or M2M access should be determined by verifying presence of a specific role[s] for JWT and/or scope[s] for M2M."*

### 4. Enforcement — agents & workflows (plug into the existing, already-firing `authorizeUser` hook — one call site)

`authorizeAccessPolicy(user, request): boolean`:

1. Parse `request.url`'s path against three patterns: `^${API_PREFIX}/agents/([^/]+)` → `('agent', match[1])`; `^${API_PREFIX}/workflows/([^/]+)` → `('workflow', match[1])`; `^${CHAT_ROUTE_BASE_PATH}/([^/]+)` → `('agent', match[1])` (chatRoute's `:agentId`). No match (memory/threads/telemetry/scorers/other `apiPrefix` routes) → `true` (out of this ADR's scope; unaffected).
2. Resolve the policy for `(category, targetId)` per the resolution order above.
3. `return checkAccess(toAuthenticatedCaller(user), policy)`.

Two small edits to **one existing file**, `src/utils/auth/index.ts` — no new middleware, no second copy of the check:

- Pass `authorizeUser: authorizeAccessPolicy` to **both** `MastraAuthAuth0` constructors in `apiAuthLayer`. This is the exact extension point Mastra's own docs recommend (`docs-auth-custom-auth-provider.md`'s "Role-based Authorization" example) and, per the previous section, the one already being invoked by `coreAuthMiddleware` on every protected request today — currently just evaluating to "true" by default. `CompositeAuth.authorizeUser` ORs both providers' results, so passing the identical function to each is correct and not redundant logic to maintain twice — it's one function definition, evaluated twice (once per provider) by `CompositeAuth` itself, not two definitions this ADR has to keep in sync.
- Extend the `protected` array passed to both providers from `[`${API_PREFIX}/*`]` to `[`${API_PREFIX}/*`, `${CHAT_ROUTE_BASE_PATH}/*`]`. This is the one thing needed for `coreAuthMiddleware`'s own `isProtectedPath` check to say "yes" for chatRoute — at which point it runs the exact same authenticate-then-`authorizeUser` sequence it already runs for `/v6/ai/agents/*` and `/v6/ai/workflows/*`, with no additional code. `resourceIdMiddleware.ts` is untouched by this change (see previous section for why it doesn't need to be) — its own pre-emptive authentication continues to run first and unaffected; `coreAuthMiddleware`'s newly-enabled check for chatRoute simply runs a moment later, inside the route handler, as it already structurally does for every other protected route.

One accepted side effect: once chatRoute's path is in `protected`, `coreAuthMiddleware` will re-run `authenticateToken` a second time for every chatRoute request (it always does its own authentication rather than trusting `requestContext`'s already-set `user`) — a harmless, redundant network/verification round-trip on the same token, not a correctness issue, and not something introduced by this ADR's own code (it's `coreAuthMiddleware`'s existing behavior for every route it protects, including the native agent/workflow routes already).

### 5. Enforcement — tools (in-process, via `RequestContext`)

Tools have no HTTP route, but every tool's `execute(inputData, context)` already receives `context.requestContext` (confirmed: `fetch-challenge-tool.ts` reads it today; `challenge-search-workflow.ts:249` and `challenge-bulk-ingestion-workflow.ts` both pass `{ requestContext, observe: noopObserve }` explicitly when calling a tool's `.execute()` directly from a workflow step) — and `resourceIdMiddleware`/`chatResourceIdMiddleware` already populate `requestContext.set('user', user)` before any agent or workflow body runs, for both the apiPrefix and chatRoute surfaces alike. That makes `RequestContext` the one enforcement point that already uniformly covers every way a tool can be invoked in this codebase — no path parsing needed.

```ts
// src/utils/auth/access-control.ts (new)
export class ToolAccessDeniedError extends Error {}

export function withAccessPolicy<T extends { id: string; execute?: (...args: any[]) => any }>(tool: T): T {
  const originalExecute = tool.execute;
  if (!originalExecute) return tool;
  return {
    ...tool,
    execute: async (inputData: unknown, context: { requestContext?: { get(key: string): unknown } }) => {
      if (process.env.DISABLE_AUTH === 'true') return originalExecute(inputData, context);
      const user = context?.requestContext?.get('user') as Record<string, unknown> | undefined;
      const policy = resolveAccessPolicy('tool', tool.id);
      if (!user || !checkAccess(toAuthenticatedCaller(user), policy)) {
        tcAILogger.warn(`[access-control] denied tool "${tool.id}"`, { hasUser: !!user });
        throw new ToolAccessDeniedError(`Access denied for tool "${tool.id}"`);
      }
      return originalExecute(inputData, context);
    },
  };
}
```

Applied **at each tool's own export site** — e.g. `challenge-vector-query-tool.ts`'s last line becomes `export const challengeVectorQueryTool = withAccessPolicy(createTool({ ... }));` — not at each place a tool happens to get wired into an agent's `tools:` map or a workflow step. This means the guard travels with the exported tool object itself: a future agent that imports `challengeVectorQueryTool` and adds it to its own `tools:` map gets the same protection automatically, with no way to "forget" to wrap it at the call site.

`ToolAccessDeniedError` thrown from inside a tool's `execute()` propagates through Mastra's existing tool-call error handling the same way any other thrown tool error does today (e.g. `challenge-vector-query-tool.ts`'s own try/catch around store errors) — surfaced to the LLM as a failed tool call it can report on, or to a workflow step as a rejected `tool.execute()` call it already has to handle.

### 6. Env var surface (all optional, all with defaults — matches `rag.config.ts`'s convention)

```bash
# Global
ACCESS_CONTROL_DEFAULT_POLICY="[public|deny — default public]"
ACCESS_CONTROL_ROLES_CLAIM="[JWT claim key for member roles — default https://<TC_API_BASE domain>/roles]"

# Per-target override — only needed to diverge from the code default / global default.
# <CATEGORY> = AGENT | WORKFLOW | TOOL | ROUTE, <TARGET_KEY> = the target's own .id
# (or, for ROUTE, this repo's route slug), upper-snake-cased.
ACCESS_POLICY_<CATEGORY>_<TARGET_KEY>_MODE="[public|deny — omit to use ROLES/SCOPES below]"
ACCESS_POLICY_<CATEGORY>_<TARGET_KEY>_ROLES="[comma-separated member roles]"
ACCESS_POLICY_<CATEGORY>_<TARGET_KEY>_SCOPES="[comma-separated M2M scopes]"

# Example — this is also the code-level default, so setting these is redundant
# unless overriding it (e.g. loosening for a staging environment):
ACCESS_POLICY_WORKFLOW_CHALLENGE_INGESTION_ROLES="administrator"
ACCESS_POLICY_WORKFLOW_CHALLENGE_INGESTION_SCOPES="challengesRAG:admin"
ACCESS_POLICY_WORKFLOW_CHALLENGE_BULK_INGESTION_ROLES="administrator"
ACCESS_POLICY_WORKFLOW_CHALLENGE_BULK_INGESTION_SCOPES="challengesRAG:admin"
```

An invalid `_MODE` value (anything other than `public`/`deny`) throws an actionable error at first resolution, the same way `rag.config.ts`'s `parseNumber`/`validateSqlIdentifier` reject a bad value today — not a silent fallback.

**Opt-in/opt-out, concretely:**
- Open up a currently-restricted target (e.g. loosen ingestion for a staging env without a redeploy): set its `_MODE=public` env var, or clear `_ROLES`/`_SCOPES` and rely on the global default if it's already `public`.
- Restrict a currently-open target (e.g. lock down `challenge-search` to a specific role later): set `ACCESS_POLICY_WORKFLOW_CHALLENGE_SEARCH_ROLES=...` — zero code change.
- Hard-block a target regardless of any role/scope (e.g. temporarily disable a tool): `ACCESS_POLICY_TOOL_<ID>_MODE=deny`.
- Tighten the whole system's unconfigured-target default from open to closed: `ACCESS_CONTROL_DEFAULT_POLICY=deny` (then every target needs an explicit `public`/`restricted` entry — a deliberate, visible posture change, not a per-target migration).

### 7. Logging on denial

Every denial (both enforcement points) logs one `tcAILogger.warn` line with category, targetId, and whether a user was even present — matching the existing `tcAILogger.warn` used in `challenge-vector-query-tool.ts` for the below-threshold case. No new logging infrastructure.

## Implementation plan

### Phase 0 — Policy core
- `src/utils/auth/tc-domain.ts` (new): extract `resolveTcDomain()`; update `src/utils/auth/index.ts` and `resourceIdMiddleware.ts` to import it instead of their inline copies (behavior-identical, confirmed by their existing tests continuing to pass unmodified).
- `src/config/access-control.config.ts` (new): `AccessPolicy`, `AccessCategory`, `DEFAULT_ACCESS_POLICIES` (with the two ingestion-workflow entries), `toEnvKey()`.
- `src/utils/auth/access-control.ts` (new): `toAuthenticatedCaller()`, `checkAccess()`, `resolveAccessPolicy()` (env → code default → global default, with `_MODE`/`_ROLES`/`_SCOPES` parsing and validation), `ToolAccessDeniedError`, `withAccessPolicy()`, `authorizeAccessPolicy()` (path-parsing entry point for the HTTP boundary).
- `src/utils/auth/access-control.test.ts` (new): the core unit test surface —
  - `checkAccess`: public always allows; deny always denies; restricted+member+matching role allows; restricted+member+non-matching role denies; restricted+M2M+matching scope allows; restricted+M2M+non-matching scope denies; restricted with only `roles` configured + M2M caller denies (no scopes to check); restricted with only `scopes` configured + member caller denies.
  - `toEnvKey()`: round-trips every id in the Resource inventory table above.
  - `resolveAccessPolicy()`: env override beats code default beats global default; an invalid `_MODE` throws; `_ROLES`/`_SCOPES` are comma-split and trimmed; the two ingestion workflow ids resolve to the baked-in restricted policy with **no env vars set at all** (guards the "safe by default on a fresh deploy" property directly).
  - `withAccessPolicy()`: against a synthetic test-double tool — allows when `DISABLE_AUTH=true` regardless of user; denies with no user in `requestContext` when auth is enabled; denies a member without the required role; allows a member with it; denies M2M without the required scope; allows M2M with it; a `public`-policy tool is callable by any authenticated caller with no role/scope at all.

### Phase 1 — Wire into agents & workflows
- `src/utils/auth/index.ts`: add `authorizeUser: authorizeAccessPolicy` to both `MastraAuthAuth0` constructors; extend each provider's `protected` array to also include `${CHAT_ROUTE_BASE_PATH}/*`. `resourceIdMiddleware.ts` is **not** touched by this phase.
- New `src/utils/auth/access-control.test.ts` additions (or a dedicated file) covering `authorizeAccessPolicy` directly against constructed `Request` objects for all three path shapes: member lacking `administrator` requesting a `challenge-ingestion`-shaped workflow path → denied; member with the role → allowed; M2M lacking `challengesRAG:admin` → denied; M2M with the scope → allowed; a `/v6/ai/agents/*`-shaped path with no configured policy → allowed regardless of role/scope (default-public unaffected); a `${CHAT_ROUTE_BASE_PATH}/:agentId`-shaped path resolves to category `'agent'` and applies that agent's policy the same as its native `/v6/ai/agents/:agentId` counterpart would — this is the test that actually exercises the fix for the documented chatRoute gap, not just asserts it in prose.
- Confirm (existing tests, unmodified) that `resourceIdMiddleware.test.ts` still passes as-is — this phase doesn't change that file's behavior, only `apiAuthLayer`'s `protected`/`authorizeUser` configuration, which `resourceIdMiddleware.test.ts` already mocks out entirely (`vi.mock('../auth', ...)`).

### Phase 2 — Wire into tools
- Wrap each of the 6 tools' exports with `withAccessPolicy(...)` at their own definition site (`challenge-vector-query-tool.ts`, `fetch-challenge-tool.ts`, `fetch-project-tool.ts`, `search-challenges-tool.ts`, `standardized-skills-fuzzy-tool.ts`, `standardized-skills-semantic-tool.ts`). All six resolve to `public` today (no code-default entries), so this is behavior-preserving until a policy is actually configured for one of them.
- Confirm each tool's existing test suite (`*.test.ts`, all of which already construct a `context`/`minimalContext` object per the pattern in `challenge-vector-query-tool.test.ts`) still passes by extending that context with a `requestContext` stub exposing `.get('user')` — since `DISABLE_AUTH` isn't set in the unit-test process, the wrapper must not require it to be; tests instead supply a `requestContext` whose `.get('user')` returns an authenticated stub, or rely on the wrapper allowing public-policy tools through with a plain authenticated user.

### Phase 3 — Validation
- `npx tsc --noEmit`, `npx eslint`, full `vitest run`.
- Manual smoke test: with `DISABLE_AUTH=false` and real Auth0 config, confirm a member token **without** `administrator` gets `403` from `POST /v6/ai/workflows/challenge-ingestion/start-async`, and the same member **with** it succeeds; confirm an M2M token without `challengesRAG:admin` gets `403` from the same route, and with it succeeds.
- Manual smoke test: confirm `challenge-search-agent` (public by default) is still reachable via `/v6/ai-chat/challenge-search-agent` by any authenticated member — proves the chatRoute fix didn't regress the unrestricted default case.

### Phase 4 — Documentation
- `README.md`: env var table entries for `ACCESS_CONTROL_DEFAULT_POLICY`, `ACCESS_CONTROL_ROLES_CLAIM`, and the `ACCESS_POLICY_<CATEGORY>_<TARGET_KEY>_*` pattern (with the ingestion-workflow example), plus a short "Access control" section explaining the three-layer resolution order.
- `.env.sample`: the two global keys, plus the ingestion-workflow example pair (commented, since they're already the code default and don't need to be set).

## File-level mapping

| File | Change |
| --- | --- |
| `src/utils/auth/tc-domain.ts` | New — extracted `resolveTcDomain()` |
| `src/utils/auth/index.ts` | Modified — imports `resolveTcDomain()`; adds `authorizeUser: authorizeAccessPolicy` to both Auth0 providers; extends each provider's `protected` list with `${CHAT_ROUTE_BASE_PATH}/*` |
| `src/utils/middleware/resourceIdMiddleware.ts` | Modified — imports `resolveTcDomain()` only (the tc-domain consolidation from Decision 2); **no RBAC logic added here** |
| `src/utils/middleware/resourceIdMiddleware.test.ts` | **Unchanged** — behavior of this file is untouched by this ADR |
| `src/config/access-control.config.ts` | New — policy types, `DEFAULT_ACCESS_POLICIES`, `toEnvKey()` |
| `src/utils/auth/access-control.ts` | New — `toAuthenticatedCaller`, `checkAccess`, `resolveAccessPolicy`, `withAccessPolicy`, `authorizeAccessPolicy`, `ToolAccessDeniedError` |
| `src/utils/auth/access-control.test.ts` | New — core policy/claim/wrapper unit tests |
| `src/mastra/tools/challenge/challenge-vector-query-tool.ts` | Modified — export wrapped in `withAccessPolicy(...)` |
| `src/mastra/tools/challenge/fetch-challenge-tool.ts` | Modified — same |
| `src/mastra/tools/project/fetch-project-tool.ts` | Modified — same |
| `src/mastra/tools/challenge/search-challenges-tool.ts` | Modified — same |
| `src/mastra/tools/skills/standardized-skills-fuzzy-tool.ts` | Modified — same |
| `src/mastra/tools/skills/standardized-skills-semantic-tool.ts` | Modified — same |
| `README.md` | Modified — env var table + "Access control" section |
| `.env.sample` | Modified — new keys |
| `src/mastra/agents/**`, `src/mastra/workflows/**` (bodies) | **Unchanged** — enforcement is centralized, not per-resource code |

## Consequences

**Positive**
- `challenge-ingestion`/`challenge-bulk-ingestion` are safe by default the moment this ships — no operator action required, matching the explicit requirement.
- One shared `checkAccess`/`resolveAccessPolicy` implementation for all three categories — no drift between "how agents are gated" and "how tools are gated."
- Opting a new resource in or out of restriction is an env var (no redeploy) or a one-line code-registry entry (reviewable, `git blame`-able, same pattern as `TOOL_M2M_FALLBACK_CONFIG`) — never a per-resource code change to the resource itself.
- ~~Closes a real, previously-silent gap: chatRoute gets RBAC coverage it structurally lacked.~~ **Withdrawn (C2):**
  chatRoute was already protected by Mastra's `requiresAuth` default and already reached `authorizeUser`. The
  `protected`-list entry makes that explicit rather than default-dependent, which is worth keeping, but it closed no gap.
- Closes a real, previously-silent bypass instead (C1): a restricted agent or workflow could be invoked by spelling its
  registry key in the URL instead of its `.id`.
- Agent/workflow enforcement is **one function, wired at one existing extension point** (`authorizeUser`, already invoked by Mastra's own `coreAuthMiddleware` on every protected request) plus a one-line path-list extension — not a parallel authorization system. `resourceIdMiddleware.ts` needed zero RBAC-related changes because the existing, working pipeline already had the right hook; it just needed a real function instead of the default allow-all, and one more path pattern to reach chatRoute.

**Negative / risk**
- **`coreAuthMiddleware` re-authenticates chatRoute requests a second time** once its path is added to `protected` (it always calls `authenticateToken` itself rather than trusting `requestContext`'s already-set `user`) — a harmless, pre-existing pattern for every route it protects (native routes already pay this cost too), not a new correctness issue, but worth knowing about if chatRoute latency is ever profiled.
- **Only the prod (`topcoder.com`) roles claim has been directly confirmed.** The dev-domain equivalent (`https://topcoder-dev.com/roles`) is inferred by the same `resolveTcDomain()` convention already relied on for the `userId` claim, not independently checked against a dev-issued token. If it ever diverges, every `restricted` policy would silently deny every member caller in dev (empty roles array) until `ACCESS_CONTROL_ROLES_CLAIM` is corrected — mitigated by that env var existing as an override, but worth a quick dev-token spot-check during Phase 3 rather than assumed identical to prod.
- **`challengesRAG:admin` must exist in Auth0 before this ships**, as a permission on the `AUTH0_M2M_AUDIENCE` API resource, granted to whichever M2M client(s) should trigger ingestion — an out-of-repo, dashboard-side prerequisite this ADR cannot satisfy by itself.
- **Registry-key vs `.id` mismatch is a standing footgun beyond this ADR's own code** — any future contributor adding a policy entry keyed on the object-property name instead of the resource's own `.id` gets a silent no-op, not an error. The `toEnvKey` round-trip test in Phase 0 catches it for the *known* resources at write time, but not for a resource added later without a matching test update.
- **`withAccessPolicy` changes the tool object's `execute` reference.** Any existing test or code that does identity comparison on a tool's `execute` function (none currently observed in this repo, but not exhaustively verified) would break. Flagged for confirmation in Phase 2, not assumed safe.

## Decisions confirmed in review

- **Studio uses the same paths.** Confirmed: Mastra Studio (`studioBase: '/studio'`) routes agent/workflow interactions through the same `/v6/ai/agents/*`/`/v6/ai/workflows/*` HTTP paths as any other caller — no separate Studio auth design needed (folded into Scope above).
- **`ACCESS_CONTROL_DEFAULT_POLICY=public` is the default**, confirmed, not merely a proposed starting point — unconfigured agents/workflows/tools stay open to any authenticated caller unless explicitly restricted (env override or a `DEFAULT_ACCESS_POLICIES` entry). `deny` remains available as an opt-in, whole-system hardening posture (Decision 6) for an environment that wants closed-by-default, but that is not what ships here.
- **`checkAccess` keeps member roles and M2M scopes on separate dimensions**, confirmed as the intended design, not a placeholder: an M2M caller is checked only against a policy's `scopes`, a member caller only against its `roles`. A `restricted` policy with only one dimension configured implicitly denies the other credential type for that target — this is the direct implementation of "role[s] for JWT and/or scope[s] for M2M," not an oversight to revisit.
- **The roles claim key and the `administrator` role string are confirmed**, not guessed — verified against a real decoded prod member JWT (`iss: https://auth.topcoder.com/`): `https://topcoder.com/roles` is a plain string array, and it includes `"administrator"` verbatim among the caller's actual roles (alongside e.g. `"copilot"`, `"Topcoder Staff"`, `"Connect Manager"` — confirming the claim really is a flat role-name array, not a structured object). `ACCESS_CONTROL_ROLES_CLAIM`'s default (`https://${resolveTcDomain()}/roles`) is now a verified default, not a best guess — no override needed for this claim on either environment.

## Prerequisites to confirm before implementation starts

- **Create the `challengesRAG:admin` scope/permission in Auth0** on the `AUTH0_M2M_AUDIENCE` API resource, and grant it to the M2M client(s) that should be able to trigger ingestion. Still open — the confirmed payload above is a member token and carries no `scope` claim, so it confirms the JWT-role side only, not the M2M side.
- **Resolved (C2): there was no chatRoute gap.** (Original item: a manual smoke test for the `protected`-list design closing the chatRoute gap) — the mechanism was verified by reading `@mastra/deployer`'s and `@mastra/server`'s compiled source, not by an end-to-end request, so Phase 3's smoke test (chatRoute `403` before/after the role check) is the first live confirmation.
- Reviewer sign-off on the tool-export-site wrapping approach (Decision 5) — specifically:
  - **One policy per tool, globally, not per-usage.** Wrapping at the tool's own export site means a tool has exactly one access policy regardless of caller — no per-agent/per-workflow variance without a second wrapped export. A non-issue today (every tool in the Resource inventory has exactly one caller), but a real constraint on future flexibility to accept knowingly, not discover later.
  - **Failure surfaces as a thrown `ToolAccessDeniedError`, breaking each tool's own `{success: false, error}` convention.** Fine for the agent tool-calling loop (a thrown tool error becomes a failed tool-call result the LLM sees), but needs confirming for the workflow-step call sites that invoke `tool.execute()` directly (`challenge-search-workflow.ts:249`, `challenge-bulk-ingestion-workflow.ts`) — their existing try/catch handles the tool's own return shape, not necessarily a thrown error from inside it.
  - **The `{...tool, execute: wrappedExecute}` shallow clone is assumed behaviorally identical to the original `createTool(...)` result** — not verified against Mastra's own tool-handling internals (schema introspection, tool-calling dispatch), only asserted by "the shape looks the same."

## Implementation notes (added at implementation time)

Three things surfaced while building this against the installed `@mastra/*@1.63.0` packages. The
first is a correctness bug in Decision 4 as written; the other two close open items above.

**1. `authorizeUser`'s second argument is not a `Request` — Decision 4's `request.url` is `undefined`.**
`coreAuthMiddleware` passes `adaptToMastraAuthRequest(rawRequest)`, which returns a
`HonoRequestLike` (`{ raw, headers, header() }`) — the `MastraAuthRequest` union is
`Request | HonoRequestLike`, and the adapter always produces the latter for a real `Request` input.
Reading `.url` off it yields `undefined`, no path pattern matches, and `authorizeAccessPolicy`
returns its "not an agent/workflow path" allow — i.e. **the policy would silently never apply**.
The implementation uses Mastra's own exported `getWebRequest(request): Request | undefined`
(`@mastra/core/server`) to recover the underlying `Request`, and **fails closed** (returns `false`)
if it can't. `access-control.test.ts` exercises `authorizeAccessPolicy` against the
`HonoRequestLike` shape specifically, so this can't silently regress.

**2. Supplying `authorizeUser` in the provider options *replaces* `MastraAuthAuth0`'s own check.**
`MastraAuthAuth0`'s constructor ends with `this.registerOptions(options)`, which assigns
`this.authorizeUser = opts.authorizeUser.bind(this)` — an own property that shadows the class's
prototype `authorizeUser`, whose baseline behavior is to reject users lacking `sub`/`id` and users
whose `exp` has passed. `authorizeAccessPolicy` therefore re-asserts both checks before evaluating
any policy, so nothing is lost. (Because Mastra `.bind(this)`s it, the function must also never
read `this` — it doesn't.)

**3. The `{...tool, execute}` shallow clone is safe — resolves the third open Prerequisite.**
`createTool` returns a `Tool` class instance, but the class body declares **no prototype methods**:
every field, including `this[MASTRA_TOOL_MARKER] = true` where
`MASTRA_TOOL_MARKER = Symbol.for("mastra.core.tool.Tool")`, is an own enumerable property, and
object spread copies own enumerable symbol keys. Mastra's `isMastraTool()` accepts
`MASTRA_TOOL_MARKER in tool` without requiring `instanceof Tool`, and the only other `instanceof Tool`
check in `@mastra/core` is guarded by `typeof tool === "function"`. Wrapping the *instance's*
`execute` (rather than the `opts.execute` passed into `createTool`) also means Mastra's
input/output/resume/requestContext validation still runs — it lives inside the wrapped call.

**Other Prerequisites resolved during implementation:**

- *Thrown `ToolAccessDeniedError` at direct `tool.execute()` workflow call sites* — confirmed safe.
  All six direct call sites already wrap the call in a `try`/`catch` that either rethrows a
  descriptive error or converts it into a failed step result. The nested
  `challenge-bulk-ingestion` → `challenge-ingestion` run forwards `requestContext` into
  `run.start()`, so the nested run's tools still see the authenticated user.
- *Existing tool test suites* — the four tool `*.test.ts` files needed their `minimalContext`
  extended with a `requestContext.get('user')` stub, since the wrapper is fail-closed on a missing
  user even under a `public` policy. That was the only test churn; no assertions changed.

**Still open (unchanged):** creating `challengesRAG:admin` in Auth0 on the `AUTH0_M2M_AUDIENCE` API
resource, the live smoke tests in Phase 3, and the dev-token spot-check of the
`https://topcoder-dev.com/roles` claim key.
