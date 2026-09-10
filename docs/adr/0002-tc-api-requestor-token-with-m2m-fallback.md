# ADR 0002 — Requestor-token-first authorization for Topcoder platform API calls, with per-tool M2M fallback

- **Status:** **Accepted** (proposed 2026-08-25, accepted 2026-08-25) — implemented on this branch
- **Date:** 2026-08-25
- **Target branch:** `challenges-rag`
- **Related:** [ADR 0001](0001-integrate-challenges-vector-rag.md); the `mapUserToResourceId` / `resourceIdMiddleware` fix landed earlier on this branch (`src/utils/auth/index.ts`, `src/utils/middleware/resourceIdMiddleware.ts`) — this ADR closes the equivalent authorization gap for *outbound* calls to the Topcoder platform, the way that fix closed it for *inbound* memory/thread access.

## Context

### The problem

Every Mastra tool in this repo that calls the Topcoder platform (`TC_API_BASE`) today does so with one of two authorization postures, and neither is "authorize as the person who's actually asking":

1. **Hardcoded service M2M token, always.** `fetch-challenge-by-id`, `search-challenges`, and `fetch-project-by-id` unconditionally call `M2MService.getM2MToken()` and use that for every request, regardless of who is chatting. An M2M service credential typically has broad, service-wide read access — so a user could have a challenge, project, or scorecard returned to them by these tools that they would *not* be able to see if they queried the Topcoder platform with their own account. This is the same class of bug the resource-ID isolation fix addressed for memory/threads, just on the outbound side.
2. **No Authorization header at all.** `standardized-skills-semantic-search`, `standardized-skills-fuzzy-match`, and the internal `fetchScorecard()` helper in `challenge-context-workflow.ts` call `TC_API_BASE` anonymously. Whether that's intentional (genuinely public catalog data) or an oversight hasn't been confirmed with the platform/API owners.

There is also no shared client — all six call sites hand-roll their own `fetch()`, headers, timeout, and error handling.

### What the framework already gives us

Mastra core already resolves and preserves the **requestor's own bearer token** for every authenticated HTTP request, with no additional plumbing required:

- `coreAuthMiddleware` (inside `@mastra/core`'s server auth flow — the same code path documented in ["Reserved keys"](https://mastra.ai/docs/server/request-context) and exercised by `apiAuthLayer`/`CompositeAuth` in this repo) sets `MASTRA_AUTH_TOKEN_KEY` on the request's `RequestContext` immediately after a token is successfully authenticated, on *every* protected route — both the built-in `/v6/ai/*` routes and the custom `chatRoute()` at `/chat/:agentId`.
- That exact `RequestContext` instance is what `chatRoute()` (`@mastra/ai-sdk`) forwards into `agent.stream()` / `agent.generate()` as `params.requestContext`.
- Mastra threads that same `RequestContext` automatically into every tool invocation triggered during that run, exposed as `context.requestContext` on a tool's `execute(inputData, context)` — confirmed in the installed `@mastra/core@1.61.0` types (`dist/tools/types.d.ts`, `ToolExecutionContext.requestContext: RequestContext`) and in the embedded docs ("Accessing values with tools").

**So "preserve the token so it can be passed to tools" is already solved by the framework.** No new storage layer, no new middleware, no session store. What's actually missing is: (a) tools don't read `context.requestContext.get(MASTRA_AUTH_TOKEN_KEY)` at all today, and (b) there's no consistent, reviewable policy for *when* a tool is allowed to fall back to the privileged service M2M token instead.

### Terminology (to avoid confusion between two different tokens)

| Term | What it is | Where it comes from |
| --- | --- | --- |
| **Requestor token** | The bearer token the *caller of tc-ai-api* authenticated with (a TC member Auth0 JWT, or an M2M JWT if the caller itself is a service) | `context.requestContext.get(MASTRA_AUTH_TOKEN_KEY)`, set by Mastra's core auth flow (`apiAuthLayer`) |
| **Service M2M token** | tc-ai-api's *own* machine-to-machine credential, used to call the Topcoder platform on the tool's behalf | `M2MService.getM2MToken()` (`src/utils/auth/m2m.service.ts`), unchanged by this ADR |

## Scope

**In scope:**
- A shared, reusable client for all outbound calls from Mastra tools/workflow steps to `TC_API_BASE`.
- Requestor-token-first request flow for that client — the same bearer token that authenticated the caller of tc-ai-api (member JWT or M2M JWT alike) is forwarded as-is; the client makes no distinction between token types.
- A single, explicit, off-by-default settings map controlling — per tool ID — whether a 401/403 on the requestor-token attempt is allowed to retry with the service M2M token.
- Migrating the three currently M2M-only tools (`fetch-challenge-by-id`, `search-challenges`, `fetch-project-by-id`) onto the shared client, requestor-token-only (no fallback entry).

**Out of scope (explicitly, confirmed at review):**
- The two currently-anonymous tools (`standardized-skills-semantic-search`, `standardized-skills-fuzzy-match`) — public endpoints, left unmodified.
- The internal `fetchScorecard()` helper in `challenge-context-workflow.ts` — also anonymous today, left unmodified.
- `src/scripts/ingest-challenges.ts` and `src/scripts/sync-challenges.ts` — these are offline CLI jobs with no HTTP request, no requestor, and no `RequestContext`; they don't call `TC_API_BASE` today (confirmed by search) and aren't affected.
- Changing what `M2MService` is or how it obtains/caches tokens.
- Changing `apiAuthLayer`, `resourceIdMiddleware`, or anything upstream of tool execution — those are already fixed to correctly populate `MASTRA_AUTH_TOKEN_KEY` and `MASTRA_RESOURCE_ID_KEY`.
- Any change to which Topcoder platform endpoints exist or what they return.

## Affected call sites (all `TC_API_BASE` usage in `src/`)

| # | File | Tool / caller id | Endpoint | Auth before this ADR | Auth after this ADR |
| --- | --- | --- | --- | --- | --- |
| 1 | `src/mastra/tools/challenge/fetch-challenge-tool.ts` | `fetch-challenge-by-id` | `GET /v6/challenges/:id` | M2M only | **Requestor token, always** (member or M2M JWT, whichever authenticated the caller) — no fallback configured |
| 2 | `src/mastra/tools/challenge/search-challenges-tool.ts` | `search-challenges` | `GET /v6/challenges` | M2M only | **Requestor token, always** — no fallback configured |
| 3 | `src/mastra/tools/project/fetch-project-tool.ts` | `fetch-project-by-id` | `GET /v6/projects/:id` | M2M only | **Requestor token, always** — no fallback configured |
| 4 | `src/mastra/tools/skills/standardized-skills-semantic-tool.ts` | `standardized-skills-semantic-search` | `POST /v5/standardized-skills/skills/semantic-search` | None | Unchanged — out of scope, public endpoint |
| 5 | `src/mastra/tools/skills/standardized-skills-fuzzy-tool.ts` | `standardized-skills-fuzzy-match` | `GET /v5/standardized-skills/skills/fuzzymatch` | None | Unchanged — out of scope, public endpoint |
| 6 | `src/mastra/workflows/challenge/challenge-context-workflow.ts` (`fetchScorecard()`, ~line 481, called from the `parse` step ~line 412) | not a tool — internal helper | `GET /v6/scorecards/:id` | None | Unchanged — out of scope, public endpoint |

Also grepped and confirmed **not** affected: `src/mastra/tools/challenge/challenge-vector-query-tool.ts` (queries pgvector, not `TC_API_BASE`), the agents under `src/mastra/agents/`, and both ingestion/sync CLI scripts.

## Decision

1. **Add a shared TC API client** (`src/utils/tc-api-client.ts`) that every call site above uses instead of hand-rolling `fetch()`. Its contract:
   ```ts
   async function callTcApi(options: {
     toolId: string;              // matches createTool({ id }) — the fallback config key
     url: string;
     init?: RequestInit;          // method, body — Authorization/Content-Type are added by the client
     requestContext: RequestContext | undefined;
   }): Promise<Response>
   ```
2. **Requestor-token-first.** The client reads `requestContext?.get(MASTRA_AUTH_TOKEN_KEY)` and, if present, makes the request with `Authorization: Bearer <requestor token>`. This is the default and only path for any `toolId` not opted into fallback.
3. **Fallback trigger.** If the requestor-token attempt returns HTTP `401` or `403` (or there was no requestor token to try), the client checks `TOOL_M2M_FALLBACK_CONFIG[toolId]`.
4. **Fallback config map, off by default.** A single file (`src/config/tool-auth-fallback.config.ts`) maps tool ID → boolean. A tool ID absent from the map is treated as `false`. Only when the entry is `true` does the client retry once with `M2MService.getM2MToken()`.
5. **No requestor token at all** (tool invoked outside an authenticated request — dev harness, future non-chat entrypoint): if fallback is enabled for that `toolId`, go straight to the M2M attempt without wasting a request; if not enabled, fail fast with a clear error rather than silently downgrading to M2M.
6. **Exactly one fallback retry**, no further backoff/retry loop — if the M2M attempt also fails, the error propagates to the tool/agent as-is.
7. **Every fallback event is logged** (`tcAILogger.warn`) with the `toolId` and the HTTP status that triggered it — for the same auditability reason the auth-resolution log was added to `resourceIdMiddleware`. Never log the token itself (neither requestor nor M2M).
8. **The three currently-M2M tools ship requestor-token-only** (confirmed at review — see Resolution of open questions, below): `TOOL_M2M_FALLBACK_CONFIG` has no entries for them at all. The client makes no distinction between a member JWT and an M2M JWT — whichever token authenticated the caller of tc-ai-api is simply forwarded to the Topcoder platform call. This is intentional, not a placeholder: the fallback mechanism (items 3–7) exists as reusable infrastructure for a future tool that needs it, not because these three need it.

### Config surface

```ts
// src/config/tool-auth-fallback.config.ts
export const TOOL_M2M_FALLBACK_CONFIG: Record<string, boolean> = {
  // Off by default. Add `true` only for a tool ID that must keep working
  // even when the requestor's own token can't reach the endpoint — treat
  // flipping this to `true` as a reviewable privilege-escalation decision,
  // not a default.
};
```

## Implementation plan (as executed)

### Phase 0 — Shared client
- `src/utils/tc-api-client.ts`: `callTcApi()` per the contract above, plus default headers (`Content-Type`, `app-version`); timeout stays caller-supplied via `init.signal`.
- `src/config/tool-auth-fallback.config.ts`: the config map, starts and ships **empty** — off by default, and no entries are added for the three tools migrated in Phase 1 (see Decision item 8).
- `src/utils/tc-api-client.test.ts`: unit tests in isolation (mocked `fetch`, mocked `M2MService`, mocked config map) covering requestor success; requestor 401/403 with no fallback configured (passes through, no M2M call); requestor 401/403 with fallback enabled (single M2M retry, both outcomes); non-401/403 error status (no fallback attempted); no requestor token with fallback on/off; default headers.

### Phase 1 — Migrate the three M2M-only tools
- `fetch-challenge-tool.ts`, `search-challenges-tool.ts`, `fetch-project-tool.ts`: replaced the direct `M2MService` + `fetch()` calls with `callTcApi({ toolId: <tool's own id>, requestContext: context.requestContext, ... })`. Dropped the module-level `const m2mService = new M2MService()` from each tool file (only `tc-api-client.ts` instantiates it now, used solely on the fallback path these three don't exercise).
- Updated each tool's existing `*.test.ts` to supply a stub `context.requestContext` returning a fake requestor token (instead of relying on the mocked `M2MService`), and updated the "Authorization" assertions accordingly.

### Phase 2 — Anonymous tools (decided: not touched)
- `standardized-skills-semantic-tool.ts`, `standardized-skills-fuzzy-tool.ts`, and `challenge-context-workflow.ts`'s `fetchScorecard()` are confirmed public/no-auth endpoints and are **left exactly as they were** — no code change.

### Phase 3 — Validation
- `npx tsc --noEmit`, `npx eslint`, full `vitest run` — all green (359 tests, up from 348: 49 updated across the three migrated tools' existing suites + 11 new in `tc-api-client.test.ts`).
- Manual verification still recommended before merge: hit `/chat/:agentId` as a real TC member and confirm (via the `tcAILogger.info('Auth resolved for request', ...)` log) that the same request's tool calls reach the Topcoder platform with that member's own token.

## File-level mapping

| File | Change |
| --- | --- |
| `src/utils/tc-api-client.ts` | **New** — shared client |
| `src/config/tool-auth-fallback.config.ts` | **New** — fallback settings map |
| `src/mastra/tools/challenge/fetch-challenge-tool.ts` | Modified — use `callTcApi`, requestor token only |
| `src/mastra/tools/challenge/search-challenges-tool.ts` | Modified — use `callTcApi`, requestor token only |
| `src/mastra/tools/project/fetch-project-tool.ts` | Modified — use `callTcApi`, requestor token only |
| `src/mastra/tools/skills/standardized-skills-semantic-tool.ts` | **Unchanged** — confirmed out of scope |
| `src/mastra/tools/skills/standardized-skills-fuzzy-tool.ts` | **Unchanged** — confirmed out of scope |
| `src/mastra/workflows/challenge/challenge-context-workflow.ts` | **Unchanged** — confirmed out of scope |
| `src/utils/tc-api-client.test.ts` | **New** — client unit tests (11 tests) |
| `src/mastra/tools/challenge/fetch-challenge-tool.test.ts` | Modified — requestor-token context stub, updated Authorization assertion |
| `src/mastra/tools/challenge/search-challenges-tool.test.ts` | Modified — requestor-token context stub, updated Authorization assertion |
| `src/mastra/tools/project/fetch-project-tool.test.ts` | Modified — requestor-token context stub, updated Authorization assertion |

## Consequences

**Positive**
- TC platform tool calls are authorized as the actual requesting user by default — closes the outbound half of the authorization gap the memory/thread `resourceId` fix closed on the inbound half.
- M2M privilege use becomes an explicit, auditable, per-tool opt-in instead of an implicit default — a reviewer can see exactly which tools can escalate to the service credential and why.
- One place (`tc-api-client.ts`) owns headers, timeout, and retry policy for every Topcoder platform call instead of six independent copies.

**Negative / risk**
- **No safety net for these three tools.** Because they ship without a fallback entry, if a specific member's own token is ever rejected by `/v6/challenges` or `/v6/projects` for reasons unrelated to legitimate access control (token edge cases, a platform-side regression), the tool call fails outright — there is no automatic M2M retry to mask it. This is the deliberate trade-off in Decision item 8: correctness of authorization (never showing a user data their own token can't see) was prioritized over availability. If this turns out to be too strict in practice, enabling fallback for one of these tool IDs is a one-line change to `TOOL_M2M_FALLBACK_CONFIG`.
- Adds one extra network round trip only on the fallback path (for any *future* tool that opts in) — no added latency for the three tools migrated here, since they never attempt a second request.
- The fallback config map is a new place privilege escalation can be silently widened; needs to be covered by code review norms (any PR flipping an entry to `true` should say why).

## Resolution of open questions (2026-08-25)

The three open questions blocking implementation were resolved at review, confirmed by the requester:

1. **Do the TC v6 Challenges/Projects APIs accept a member's own token?** — **Confirmed: yes.** This validates requestor-token-first as viable for all three tools without needing platform-side changes.
2. **Initial fallback-flag value for the three currently-M2M tools?** — **Resolved: no fallback at all.** These three ship passing the requestor's token through directly, unconditionally, with nothing in `TOOL_M2M_FALLBACK_CONFIG` for them. Explicitly confirmed to apply uniformly regardless of token type (TC member JWT or M2M JWT) — the client doesn't branch on which kind of token it received, it simply forwards whatever authenticated the caller. This is stricter than the ADR's original recommendation (which proposed starting fallback `true` as a safety net) — see the Negative/risk note above for the trade-off this accepts.
3. **Should the anonymous tools/workflow call join this pattern?** — **Resolved: no, leave them exactly as they are.** No code changes were made to `standardized-skills-semantic-tool.ts`, `standardized-skills-fuzzy-tool.ts`, or `challenge-context-workflow.ts`.

Two lower-priority open items from the original draft remain genuinely open (not blocking, since nothing in the current implementation depends on them):
- Whether a single fallback retry with no backoff is the right long-term policy for a tool that *does* opt into fallback — untested in production since no tool currently exercises that path.
- Whether `tcAILogger.warn` is the right level for fallback events — same caveat, not yet exercised outside unit tests.

## Prerequisites — status

- ~~Answers to Open Questions 1–3~~ — resolved above.
- `MASTRA_AUTH_TOKEN_KEY` (`@mastra/core/request-context`) usage — implemented and covered by `src/utils/tc-api-client.test.ts`; no issues surfaced.
- `M2MService`'s call pattern is now genuinely "only when a future tool opts into fallback" rather than "always" for these three tools — no code change was needed in `M2MService` itself, confirming the original assumption.
