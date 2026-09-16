# ADR 0005 — Challenge resources tool (copilot / reviewers / registrants / managers / observers) for `challengeSearchAgent`

- **Status:** Proposed
- **Date:** 2026-09-16
- **Target branch:** `develop`
- **Related:** [ADR 0001](0001-integrate-challenges-vector-rag.md) (D10 — server-side scope enforcement), [ADR 0002](0002-tc-api-requestor-token-with-m2m-fallback.md) (requestor-token-first `callTcApi`, per-tool M2M fallback registry — **extended by this ADR**, see Decision 4), [ADR 0004](0004-role-based-access-for-agents-workflows-tools.md) (agent/workflow/tool RBAC layer — this ADR's tool must be wired into it, not bypass it), `src/mastra/tools/challenge/fetch-challenge-tool.ts` and `src/mastra/tools/project/fetch-project-tool.ts` (direct structural precedent), `src/mastra/agents/challenge/challenge-search-agent.ts` (the agent this tool is added to), platform-ui `src/apps/customer-portal/src/customer-portal.routes.tsx` (the RBAC gate on the UI surface this tool is reached through)

## Update — aligned with the consuming UI's own RBAC (added before implementation, 2026-09-16)

Everything below this box was written against an initial assumption — **`public` access, requestor-token-forwarded** — that turned out to be wrong on both counts once checked against (a) the platform-ui page that actually hosts `challengeSearchAgent`, and (b) a closer read of this ADR's own unauthenticated-curl evidence. Both corrections are folded into the sections below (Context, Decisions confirmed, Decision 4/6, Consequences); this box is a pointer, not a duplicate.

1. **The tool's default access policy changes from `public` to `restricted`.** `challengeSearchAgent` (and by extension every tool it calls, including this one) is only reachable through platform-ui's customer-portal "Assistants"/"TopScout" page, and that page's *root* route is gated by `rolesRequired: [UserRole.administrator, UserRole.talentManager]` (`platform-ui/src/apps/customer-portal/src/customer-portal.routes.tsx:48-51`) — confirmed by reading that route, its `RestrictedRoute` guard, and the `PlatformRoute` type that carries `rolesRequired`. `fetch-challenge-resources`'s own ADR 0004 policy should match that gate rather than defaulting open under it. See the revised "Decisions confirmed" and Decision 6 below.
2. **The upstream Resources API is not actually "return everything to anyone" — it silently degrades by credential, it doesn't error.** Re-reading this ADR's own evidence: the unauthenticated `roleId=<Copilot's id>` and `roleId=<Reviewer's id>` probes against a real, populated challenge (162 total resources) both returned `200` with an **empty array**, not the actual assignees — while the same unauthenticated call with no `roleId` filter, and the same call filtered to `Submitter`, returned full real data. Originally read as "no copilot on this challenge"; on reflection that's the wrong read for a *reviewer* role too, on a challenge with 162 resources. This matches, rather than contradicts, what was raised directly during this update: the Resources API enriches its response by caller credential, and un-privileged/no credential only ever sees `Submitter`-role rows. Confirming this precisely (authenticated vs. unauthenticated diff on the *same* filter) needs a real token this session doesn't have — flagged in Prerequisites — but the tool is designed defensively around it now rather than around the earlier, too-optimistic "it's all public" reading.
3. **Outbound credential selection is no longer "always forward the requestor's token" (ADR 0002's default for every other tool).** Because (1) restricts this tool's callers to exactly two member roles, and (2) means a `Talent Manager`'s own JWT cannot be assumed to carry the same TC-platform-level visibility into privileged resource roles that an `administrator`'s JWT does, the tool now branches on the caller's own role: `administrator` → forward their JWT as-is (unchanged posture, least-privilege, matches every other tool); anything else RBAC lets through (i.e. `Talent Manager`) → use tc-ai-api's own service M2M credential instead, unconditionally, not as a reactive fallback-on-403 (there's no error to react to — see point 2). This needs a small, additive extension to the shared `callTcApi` client (Decision 4), not a bespoke fetch in this tool.

## Context

`challengeSearchAgent` can currently search challenges (`challenge-vector-query`), fetch one challenge's full detail including its `winners` array (`fetch-challenge-by-id`), and resolve a project (`fetch-project-by-id`). It has no way to answer "who copiloted this challenge", "who are the reviewers", "who's registered", or "who's managing this" — none of that is challenge-detail data; it lives on the separate Resources API (`resources-api` service, `TC_API_BASE`'s `/v6/resources` and `/v6/resource-roles`), which this repo does not call today.

### Verified against the real APIs (prod, 2026-09-16 — dev mirrors the same shape per the linked Swagger docs)

- `GET /v6/resource-roles` returns a flat, **unauthenticated** JSON array of all 26 resource roles, each `{ id, name, legacyId, fullReadAccess, fullWriteAccess, isActive, selfObtainable }` — e.g. `{"id":"cfe12b3f-2a24-4639-9d8b-ec86726f76bd","name":"Copilot","legacyId":14,...}`. Confirmed the full list; it includes (among others) `Copilot`, `Submitter`, `Reviewer`, `Iterative Reviewer`, `Final Reviewer`, `Screener`, `Primary Screener`, `Checkpoint Screener`, `Checkpoint Reviewer`, `Accuracy Reviewer`, `Stress Reviewer`, `Specification Reviewer`, `Specification Submitter`, `Post-Mortem Reviewer`, `Failure Reviewer`, `Aggregator`, `Approver`, `Manager`, `Client Manager`, `Payment Manager`, `Observer`, `Free Agent`, `Team Captain`, `Designer`, `Problem Tester`, `Problem Writer`. **No role literally named "Registrant" exists** — the role members get on registering/submitting to a challenge is `Submitter`.
- `GET /v6/resources?challengeId=<uuid>&page=&perPage=` is also **unauthenticated** on prod (confirmed with no `Authorization` header sent, HTTP 200) and paginated with standard `X-Total`/`X-Page`/`X-Per-Page`/`X-Total-Pages`/`Link` headers (confirmed against a real challenge: 162 total resources, `perPage=10` → `x-total-pages: 17`). Each row already embeds the human-readable role inline — `{ id, challengeId, memberId, memberHandle, roleId, roleName, created, createdBy, rating, legacyId, phaseChangeNotifications }` — e.g. `{"memberId":"40788310","memberHandle":"lal_g","roleId":"732339e7-...","roleName":"Submitter",...}`.
- **`roleId` accepts exactly one UUID per request — confirmed, not assumed.** `roleId=<uuid>` filters correctly (162→ some subset). `roleId[]=<uuid>&roleId[]=<uuid>` and a comma-joined `roleId=<uuid>,<uuid>` both fail with `400 {"message":"\"roleId\" must be a string"}`. This is the load-bearing constraint behind Decision 3 below: a caller-facing "role category" that spans several actual resource-roles (see next point) **cannot** be expressed as a single upstream `roleId` filter.
- Several of the categories the user actually asks about in natural language span *multiple* resource-roles, not one: "reviewers" plausibly means any of `Reviewer` / `Iterative Reviewer` / `Final Reviewer` / `Screener` / `Primary Screener` / `Checkpoint Screener` / `Checkpoint Reviewer` / `Accuracy Reviewer` / `Stress Reviewer` / `Specification Reviewer` / `Post-Mortem Reviewer` / `Failure Reviewer` / `Aggregator` / `Approver` depending on the challenge's track and review setup; "managers" plausibly means `Manager` or `Client Manager`. A tool that only recognizes the single canonical role name (`Reviewer`, `Manager`) would silently return empty/partial results on challenges using the other variants.
- **Unauthenticated `roleId` filters for non-`Submitter` roles return an empty array, not an error, not the real data.** Against the same 162-resource challenge used above: `roleId=<Copilot's id>` → `200 []`; `roleId=<Reviewer's id>` → `200 []` — with zero `Authorization` header sent, same as the calls that *did* return real data (the unfiltered list, and `roleId=<Submitter's id>` → 162 real rows). See the Update box above: this is the concrete evidence behind "roles other than submitter are only queryable when a token is provided" — the API filters silently rather than 401/403ing, which is why credential selection (Decision 3/4) can't be a reactive fallback-on-error the way ADR 0002's existing `TOOL_M2M_FALLBACK_CONFIG` fallback is.

### What this ADR adds

A new agent-callable tool, `fetch-challenge-resources`, giving `challengeSearchAgent` read access to a single challenge's resource list, filterable by a caller-facing role **category** (resolved server-side to the matching set of actual resource-role ids/names) or by an exact `roleId` when the caller already has one. Per ADR 0004, it must ship wrapped in `withAccessPolicy(...)` like every other tool in this repo — being agent-callable is not a carve-out from the RBAC layer.

## Scope

**In scope:**
- One new tool, `fetch-challenge-resources`, taking a single `challengeId` (no batch support — matches the upstream API and every existing single-challenge tool in this repo) and an optional role selector.
- A code-level registry mapping five caller-facing categories — `copilot`, `reviewers`, `registrants`, `managers`, `observers` — to the actual resource-role name(s) each covers, plus an `all` selector (or omitting the role parameter) that returns every resource unfiltered.
- Resolution of category → resource-role id(s) via `GET /v6/resource-roles`, fetched once and memoized for the process lifetime (mirrors `rag.config.ts`'s lazy-resolve-once convention already used in this repo).
- An escape hatch accepting a raw `roleId` UUID directly (bypassing category resolution) for a caller that already has one from a prior lookup.
- Wiring the tool into `challengeSearchAgent`'s `tools` map and adding an agent-instructions section teaching it which natural-language phrasing maps to which category.
- An RBAC entry point per ADR 0004 (`withAccessPolicy(...)` wrapping the exported tool) with a **`restricted` default policy** — `roles: ['administrator', 'Talent Manager']`, no `scopes` — added to `DEFAULT_ACCESS_POLICIES['tool']` in `src/config/access-control.config.ts`, matching the RBAC already enforced one layer up in platform-ui for the only UI surface that reaches this tool.
- A small, additive extension to `callTcApi` (`src/utils/tc-api-client.ts`, ADR 0002) adding a `forceM2M` option, and the tool's own logic for deciding when to set it based on the caller's role.
- Unit tests for category resolution, the resource-roles cache, response filtering/grouping, the tool's `execute` against a mocked `fetch`, the RBAC policy, and the new `forceM2M` branch in `callTcApi`.

**Out of scope (explicitly deferred, not rejected):**
- Batch / multi-challenge resource lookups — the upstream API and this tool are single-`challengeId` only, matching the user's explicit requirement and every existing tool's shape (`fetch-challenge-by-id`, `fetch-project-by-id`).
- Mutating resources (adding/removing a challenge resource) — this is a **read-only** tool; `POST`/`DELETE /v6/resources` are not touched.
- A generic "any resource-role by exact name" free-text input — superseded by the category registry (Decision 1) plus the raw-`roleId` escape hatch, which together cover both the common NLP-mapped case and the exact-id case.
- TTL-based cache invalidation for the resource-roles list — confirmed as unnecessary for now (see Decisions confirmed below); a process restart picks up any upstream role addition/rename.
- **Credential selection keyed on the requested role *category*** (e.g. "force M2M only when `role` is `reviewers`/`copilot`/etc., forward the requestor's token for `registrants`") — considered and rejected in favor of keying on the *caller's own role* instead (Decision 3). The category-keyed version was tempting since `Submitter` alone is confirmed visible unauthenticated, but it would mean an `administrator`'s own, perfectly sufficient JWT gets swapped for the shared service credential just because they asked for reviewers — unnecessary privilege substitution for the one caller whose own token already works.
- **An M2M-callable path for this tool** — the `restricted` policy configures only `roles`, no `scopes`, which per `checkAccess` (ADR 0004) implicitly denies every M2M caller of tc-ai-api itself. Deliberate: nothing calls `challengeSearchAgent` via M2M today, so there's no consumer to support and no Auth0 scope to provision. Revisit (add `scopes`) if that changes.

## Decisions confirmed (asked directly, before writing this ADR)

- **Category grouping is curated, not narrow or fuzzy.** Each of `reviewers`/`managers` resolves to an explicit, reviewable list of resource-role names (Decision 1), not just the single canonically-named role, and not a live substring match against whatever `/v6/resource-roles` happens to return. Chosen specifically because a narrow match would silently miss challenges using `Iterative Reviewer`/`Client Manager`/etc., and a fuzzy match would drift unreviewed if Topcoder ever adds a role whose name happens to contain "review" or "manage" for an unrelated purpose.
- ~~Default access policy is `public`...~~ **Superseded (Update box above).** The tool's only reachable caller surface (`challengeSearchAgent` via platform-ui's customer-portal Assistants/TopScout page) is itself gated by `rolesRequired: [administrator, Talent Manager]` at the route level — defaulting this tool open underneath that gate would be a silent, unnecessary widening, not a neutral choice. **Confirmed default is now `restricted { roles: ['administrator', 'Talent Manager'] }`**, added to `DEFAULT_ACCESS_POLICIES['tool']` (Decision 6) — the first `tool`-category entry in that map (every other tool in the repo is still `public`).
- **The resource-roles list is fetched once and memoized for the process lifetime**, not on a TTL and not on every call. It's 26 stable, rarely-changed reference rows; a new role added upstream is picked up on the next deploy/restart, matching this repo's existing lazy-singleton convention (`rag.config.ts`) rather than introducing a new caching pattern.
- **The tool accepts either a caller-facing category or a raw `roleId`.** The category path is what `challengeSearchAgent`'s NLP-driven usage relies on; the raw-`roleId` path exists for a caller (agent turn, workflow step, or a future tool) that already resolved an exact id from a prior `fetch-challenge-resources` or `/v6/resource-roles` call and wants to re-query precisely, without going through category resolution again.
- **Outbound TC API credential is chosen by the caller's own role, not by the requested category.** `administrator` → forward their own JWT (`callTcApi`'s existing default, unchanged). Any other RBAC-permitted role (i.e. `Talent Manager`) → force tc-ai-api's own service M2M token for every call this tool makes, unconditionally (Decision 3/4) — not a reactive fallback, since the evidence above shows the upstream API degrades silently rather than erroring on insufficient credential.

## Resource inventory update (ADR 0004's table)

Per ADR 0004 §"Resource inventory", every new tool must be added to that table and, being agent-callable, defaults through `DEFAULT_ACCESS_POLICIES['tool']` (absent entry ⇒ global default, `public`) unless explicitly restricted:

| Category | Registered as (object key) | `.id` used for routing/policy | Caller surface |
| --- | --- | --- | --- |
| Tool | `fetchChallengeResourcesTool` | `fetch-challenge-resources` | Agent-callable (`challengeSearchAgent`) — **default-restricted (this ADR)**: `roles: ['administrator', 'Talent Manager']`, no `scopes` (M2M denied) |

## Decision

### 1. Category registry (`src/config/challenge-resource-roles.config.ts`, new)

```ts
/**
 * Caller-facing role categories, mapped to the actual `GET /v6/resource-roles`
 * `name` values each one covers. Verified against the live resource-roles
 * list (26 entries, prod, 2026-09-16) — see ADR 0005. A category name absent
 * here, or a listed role name that no longer exists upstream, is a code
 * change (this map), not a runtime guess: resolution fails loud (Decision 2)
 * rather than silently returning nothing.
 *
 * Flipping/extending an entry is a reviewable decision, same convention as
 * TOOL_M2M_FALLBACK_CONFIG and DEFAULT_ACCESS_POLICIES.
 */
export const CHALLENGE_RESOURCE_ROLE_CATEGORIES = {
  copilot: ['Copilot'],
  reviewers: [
    'Reviewer', 'Iterative Reviewer', 'Final Reviewer', 'Screener',
    'Primary Screener', 'Checkpoint Screener', 'Checkpoint Reviewer',
    'Accuracy Reviewer', 'Stress Reviewer', 'Specification Reviewer',
    'Post-Mortem Reviewer', 'Failure Reviewer', 'Aggregator', 'Approver',
  ],
  registrants: ['Submitter'], // no role is literally named "Registrant" (verified)
  managers: ['Manager', 'Client Manager'], // Payment Manager deliberately excluded — billing role, not a challenge-run role
  observers: ['Observer'],
} as const;

export type ChallengeResourceCategory = keyof typeof CHALLENGE_RESOURCE_ROLE_CATEGORIES;
```

### 2. Resource-roles cache + resolution (`src/utils/tc-resource-roles-cache.ts`, new)

```ts
import { callTcApi } from './tc-api-client';
import type { RequestContext } from '@mastra/core/request-context';

interface ResourceRole {
  id: string;
  name: string;
}

let cached: Promise<ResourceRole[]> | undefined;

/** Fetches GET /v6/resource-roles once per process; concurrent first callers
 * share the same in-flight promise (no duplicate-fetch race). */
function loadResourceRoles(requestContext: RequestContext | undefined): Promise<ResourceRole[]> {
  if (!cached) {
    cached = callTcApi({
      toolId: 'fetch-challenge-resources',
      url: `${process.env.TC_API_BASE}/v6/resource-roles`,
      init: { method: 'GET', signal: AbortSignal.timeout(15_000) },
      requestContext,
    }).then(async (res) => {
      if (!res.ok) throw new Error(`Failed to fetch resource roles (HTTP ${res.status})`);
      return (await res.json()) as ResourceRole[];
    }).catch((err) => { cached = undefined; throw err; }); // don't memoize a failure
  }
  return cached;
}

/** Resolves a category to its set of role ids, by name, against the live
 * resource-roles list. Throws (not silent-empty) if a configured role name
 * no longer exists upstream — an actionable signal that
 * CHALLENGE_RESOURCE_ROLE_CATEGORIES is stale, not "no matches". */
export async function resolveCategoryRoleIds(
  category: string,
  roleNames: readonly string[],
  requestContext: RequestContext | undefined,
): Promise<Set<string>> {
  const roles = await loadResourceRoles(requestContext);
  const byName = new Map(roles.map((r) => [r.name, r.id]));
  const ids = roleNames.map((name) => {
    const id = byName.get(name);
    if (!id) throw new Error(`Resource role "${name}" (category "${category}") not found in /v6/resource-roles — check CHALLENGE_RESOURCE_ROLE_CATEGORIES against the live role list.`);
    return id;
  });
  return new Set(ids);
}
```

Cache-failure handling: a failed fetch does **not** memoize (the `.catch` clears `cached`), so a transient upstream error is retried on the next call rather than permanently wedging the tool for the process's lifetime.

### 3. The tool (`src/mastra/tools/challenge/fetch-challenge-resources-tool.ts`, new)

Always fetches the **full** resource list for the challenge in one request (`perPage=1000`, matching the user's own example and avoiding the "one `roleId` per request" ceiling from Decision-relevant evidence above), then filters/groups in-process — one upstream call to `/v6/resources` regardless of how many actual role names a category spans, plus the one-time (cached) `/v6/resource-roles` call:

```ts
import { createTool } from '@mastra/core/tools';
import { withAccessPolicy, toAuthenticatedCaller } from '../../../utils/auth/access-control';
import { z } from 'zod';
import type { RequestContext } from '@mastra/core/request-context';
import { callTcApi } from '../../../utils/tc-api-client';
import { CHALLENGE_RESOURCE_ROLE_CATEGORIES, type ChallengeResourceCategory } from '../../../config/challenge-resource-roles.config';
import { resolveCategoryRoleIds } from '../../../utils/tc-resource-roles-cache';

const TOOL_ID = 'fetch-challenge-resources';
const BASE_URL = `${process.env.TC_API_BASE}/v6/resources`;
const MAX_PER_PAGE = 1000; // matches the user-supplied example; see Consequences re: truncation beyond this
const ADMIN_ROLE = 'administrator'; // only role whose own JWT is forwarded as-is — see Decision 3

const resourceSchema = z.object({
  memberId: z.string(),
  memberHandle: z.string(),
  roleId: z.string(),
  roleName: z.string(),
  created: z.string().optional(),
});

export const fetchChallengeResourcesTool = withAccessPolicy(createTool({
  id: TOOL_ID,
  description:
    'Lists a Topcoder challenge\'s resources (copilot, reviewers, registrants/submitters, managers, ' +
    'observers, or all of them) from the v6 Resources API. Takes exactly one challengeId.',
  inputSchema: z.object({
    challengeId: z.string().uuid().describe('UUID of the Topcoder challenge'),
    role: z.enum(['copilot', 'reviewers', 'registrants', 'managers', 'observers', 'all'])
      .optional()
      .describe('Caller-facing role category — omit or use "all" to return every resource'),
    roleId: z.string().uuid().optional()
      .describe('Exact resource-role UUID (from a prior lookup) — takes precedence over "role" when both are given'),
  }),
  outputSchema: z.object({
    challengeId: z.string(),
    role: z.string(), // echoes the resolved selector: the category, "roleId:<uuid>", or "all"
    resources: z.array(resourceSchema),
    total: z.number(),
    truncated: z.boolean().describe(`true if the challenge has more than ${MAX_PER_PAGE} total resources — see ADR 0005`),
  }),
  execute: async (inputData, context) => {
    const logger = context.mastra?.getLogger?.();
    logger?.info('Fetching challenge resources: {challengeId} role={role}', {
      challengeId: inputData.challengeId, role: inputData.role ?? inputData.roleId ?? 'all',
    });
    return await fetchChallengeResources(inputData, context.requestContext);
  },
}));

interface Input { challengeId: string; role?: ChallengeResourceCategory | 'all'; roleId?: string }

/**
 * `withAccessPolicy` has already confirmed the caller holds `administrator`
 * or `Talent Manager` by the time this runs — this only decides *which*
 * credential to forward for the outbound TC API call, not whether to allow
 * the call at all. `administrator`'s own JWT is trusted as-is (least
 * privilege: use it when it's already sufficient); every other RBAC-permitted
 * role forces the service M2M token, because the evidence in this ADR shows
 * the upstream API silently omits privileged-role rows for a caller whose own
 * credential doesn't carry that visibility, rather than erroring — there's no
 * 401/403 for a reactive fallback (ADR 0002's existing mechanism) to react to.
 */
function shouldForceM2M(requestContext: RequestContext | undefined): boolean {
  const user = requestContext?.get('user') as Record<string, unknown> | undefined;
  if (!user) return true; // fail toward the credential that at least works for Submitter-only data
  return !toAuthenticatedCaller(user).roles.includes(ADMIN_ROLE);
}

const fetchChallengeResources = async (input: Input, requestContext: RequestContext | undefined) => {
  const forceM2M = shouldForceM2M(requestContext);
  const url = `${BASE_URL}?challengeId=${encodeURIComponent(input.challengeId)}&page=1&perPage=${MAX_PER_PAGE}`;
  const response = await callTcApi({
    toolId: TOOL_ID, url, init: { method: 'GET', signal: AbortSignal.timeout(15_000) }, requestContext, forceM2M,
  });
  if (!response.ok) throw new Error(`Failed to fetch resources for challenge ${input.challengeId} (HTTP ${response.status})`);

  const all: any[] = await response.json();
  const totalHeader = Number(response.headers.get('x-total') ?? all.length);

  let roleIds: Set<string> | undefined;
  let label: string;
  if (input.roleId) {
    roleIds = new Set([input.roleId]);
    label = `roleId:${input.roleId}`;
  } else if (input.role && input.role !== 'all') {
    roleIds = await resolveCategoryRoleIds(input.role, CHALLENGE_RESOURCE_ROLE_CATEGORIES[input.role], requestContext);
    label = input.role;
  } else {
    label = 'all';
  }

  const filtered = roleIds ? all.filter((r) => roleIds!.has(r.roleId)) : all;

  return {
    challengeId: input.challengeId,
    role: label,
    resources: filtered.map((r) => ({
      memberId: String(r.memberId), memberHandle: r.memberHandle,
      roleId: r.roleId, roleName: r.roleName, created: r.created ?? undefined,
    })),
    total: filtered.length,
    truncated: totalHeader > all.length,
  };
};
```

`roleId` deliberately wins over `role` when both are set (documented in the schema) rather than erroring — it's the more specific input, and an agent that already resolved an exact id from a prior call has no reason to also pass a category.

`resolveCategoryRoleIds`'s own `/v6/resource-roles` lookup (Decision 2) is unaffected by `forceM2M` — that endpoint is confirmed public/unfiltered regardless of credential (it's reference data, not per-challenge resource assignments), so it keeps using `callTcApi`'s default requestor-first behavior. Only the `/v6/resources` call itself needs the branch.

### 4. `callTcApi` gains a `forceM2M` option (`src/utils/tc-api-client.ts`, modified — extends ADR 0002)

A small, additive change to the one shared outbound client, not a second hand-rolled `fetch` in this tool (which is exactly the pattern ADR 0002 eliminated):

```ts
export interface CallTcApiOptions {
  toolId: string;
  url: string;
  init?: RequestInit;
  requestContext: RequestContext | undefined;
  /**
   * When true, skips requestor-token forwarding entirely and always uses
   * tc-ai-api's own service M2M token — regardless of TOOL_M2M_FALLBACK_CONFIG
   * and regardless of whether a requestor token is present. For a caller a
   * tool's own RBAC policy allows through, but whose own token may not carry
   * the TC-platform-level visibility the call needs (see ADR 0005). Distinct
   * from the existing fallback-on-401/403 behavior below, which is reactive;
   * this is a proactive, tool-decided override.
   */
  forceM2M?: boolean;
}

export async function callTcApi({ toolId, url, init, requestContext, forceM2M }: CallTcApiOptions): Promise<Response> {
  if (forceM2M) {
    return fetchWithToken(url, init, await m2mService.getM2MToken());
  }
  // ...unchanged from ADR 0002: requestor-token-first, with fallback-on-401/403
  // when TOOL_M2M_FALLBACK_CONFIG[toolId] is true.
}
```

`forceM2M` defaults to `undefined`/falsy, so every other tool's behavior (all of which omit it) is byte-for-byte unchanged — this is additive, not a reinterpretation of ADR 0002's existing contract.

### 5. Agent wiring (`src/mastra/agents/challenge/challenge-search-agent.ts`)

- Import and add to the `tools` map: `tools: { challengeVectorQueryTool, fetchProjectTool, fetchChallengeTool, fetchChallengeResourcesTool }`.
- New instructions section (placed after "Fetching full challenge details", before "Answering"), teaching the NLP → category mapping explicitly rather than leaving it to the model to invent parameter values:

  > **Who's on a challenge (resources)**
  > Use the "fetch-challenge-resources" tool when the user asks about *people* on a challenge by role — not challenge content. Map their phrasing to the tool's "role" parameter:
  > - copilot / "who copiloted this" → `role: "copilot"`
  > - reviewer(s) / "who reviewed it" / "who scored submissions" → `role: "reviewers"`
  > - registrant(s) / "who registered" / "who's submitting" / "who joined" → `role: "registrants"`
  > - manager(s) → `role: "managers"`
  > - observer(s) → `role: "observers"`
  > - "who's on this challenge" / "everyone involved" / no specific role named → omit "role" (or pass `"all"`)
  >
  > Only pass "roleId" instead of "role" if you already have an exact resource-role UUID from an earlier tool result — never guess one. Like "fetch-challenge-by-id", this tool takes a single challengeId, so resolve to one challenge first. Link every member handle it returns the same way you link winners' handles (see "Linking to member profiles" below): `[handle](${MEMBER_PROFILE_BASE_URL}/handle)`. If "truncated" comes back true, say the list may be incomplete (challenge has more resources than were fetched) rather than presenting it as exhaustive.

### 6. RBAC wiring (ADR 0004) — `restricted`, not `public`

- `fetchChallengeResourcesTool` is exported already wrapped in `withAccessPolicy(...)` (Decision 3) — unchanged mechanism from ADR 0004. What changes is the policy itself: add an entry to `DEFAULT_ACCESS_POLICIES['tool']` in `src/config/access-control.config.ts` —
  ```ts
  tool: {
    'fetch-challenge-resources': { mode: 'restricted', roles: ['administrator', 'Talent Manager'] },
  },
  ```
  No `scopes` key — per `checkAccess`'s existing, deliberate design (ADR 0004 Decision 3: "an M2M caller is checked only against `scopes`... A `restricted` policy that configures only `roles`... implicitly denies all M2M callers"), this denies every M2M caller of tc-ai-api by construction, matching the "Out of scope" decision above (no M2M consumer of this tool exists today).
- Add the tool id to ADR 0004's "Resource inventory" table (done above, for anyone auditing that ADR against the current tool set) — this is the **first `tool`-category entry** in `DEFAULT_ACCESS_POLICIES`; every prior tool in that table is still `public`.
- `TOOL_M2M_FALLBACK_CONFIG`: still no entry added — that registry governs the *reactive* fallback-on-401/403 path (ADR 0002), which this tool doesn't use. Its outbound credential selection is the new *proactive* `forceM2M` branch (Decision 3/4) instead, driven by the caller's RBAC-checked role, not by an upstream error response.
- **This is enforcement in *addition to*, not instead of, platform-ui's own route-level gate.** Per ADR 0001's D10 ("any scope restriction MUST be enforced server-side, never left to the model" — the same principle, one layer up: never left to the calling UI either), tc-ai-api cannot assume platform-ui's `RestrictedRoute` is the only thing standing between an unprivileged member and this tool; any other current or future caller of `challengeSearchAgent` (direct API access, a different UI, Studio) is independently bound by this policy.

## Implementation plan

### Phase 0 — Category registry + resource-roles cache
- `src/config/challenge-resource-roles.config.ts` (new): `CHALLENGE_RESOURCE_ROLE_CATEGORIES`, `ChallengeResourceCategory`.
- `src/utils/tc-resource-roles-cache.ts` (new): `resolveCategoryRoleIds()`, with the fetch-once-memoize-don't-cache-failures behavior above.
- `src/utils/tc-resource-roles-cache.test.ts` (new): resolves a category to the expected id set against a mocked `/v6/resource-roles` response; concurrent calls before the first resolves share one fetch (no duplicate network calls); a category naming a role absent from the mocked response throws with an actionable message; a failed fetch is retried (not permanently cached) on the next call.

### Phase 1 — Shared client: `callTcApi` gets `forceM2M`
- `src/utils/tc-api-client.ts` (modified): add the `forceM2M` option (Decision 4). Purely additive — no existing call site changes behavior.
- `src/utils/tc-api-client.test.ts` (modified): `forceM2M: true` uses the M2M token even when a requestor token is present in `requestContext`; `forceM2M: true` with no requestor token at all still succeeds (doesn't hit the existing "no requestor token and fallback not enabled" error path); `forceM2M` omitted/false is byte-for-byte the existing, already-tested behavior (regression guard — existing tests for every other tool must keep passing unmodified).

### Phase 2 — The tool
- `src/mastra/tools/challenge/fetch-challenge-resources-tool.ts` (new), wrapped in `withAccessPolicy(...)`, including the `shouldForceM2M` branch (Decision 3).
- `src/mastra/tools/challenge/fetch-challenge-resources-tool.test.ts` (new), mocking `fetch` per the pattern in `fetch-challenge-tool.test.ts`:
  - `role: "copilot"` returns only the resources whose `roleId` matches the resolved Copilot id.
  - `role: "reviewers"` against a mocked response containing several reviewer-variant `roleName`s (e.g. `Reviewer` and `Iterative Reviewer`) returns all of them — the test that actually exercises multi-role-per-category filtering, not just single-role.
  - `role: "registrants"` matches `Submitter`.
  - Omitted `role` (and explicit `"all"`) returns every resource unfiltered.
  - `roleId` (raw UUID) filters directly and takes precedence when `role` is also supplied.
  - `x-total` header greater than the returned array length ⇒ `truncated: true`; equal ⇒ `false`.
  - Non-2xx upstream response throws with the challenge id and status in the message.
  - **`shouldForceM2M`**: a stub user with `roles: ['administrator']` ⇒ `callTcApi` called with `forceM2M: false`/omitted; a stub user with `roles: ['Talent Manager']` (no `administrator`) ⇒ `callTcApi` called with `forceM2M: true`; a user with both roles ⇒ `false` (administrator wins); no user on `requestContext` ⇒ `true` (fail toward the credential that works for at least `Submitter` data, never toward an unauthenticated call for privileged categories).
  - `withAccessPolicy` itself: a stub user with neither `administrator` nor `Talent Manager` is denied before `execute` ever runs (ADR 0004's existing wrapper behavior, exercised here against this tool's new `restricted` policy rather than assumed).

### Phase 3 — Agent wiring
- `src/mastra/agents/challenge/challenge-search-agent.ts`: import, add to `tools`, add the instructions section (Decision 5).
- No test changes required — this agent has no existing test suite asserting on tool wiring (confirmed by inspecting the file's directory); if that changes before this ships, extend accordingly.

### Phase 4 — RBAC config
- `src/config/access-control.config.ts` (modified): add the `tool: { 'fetch-challenge-resources': {...} }` entry (Decision 6).
- `src/config/access-control.config.test.ts` / `src/utils/auth/access-control.test.ts` (whichever already covers `DEFAULT_ACCESS_POLICIES` resolution per ADR 0004): extend to assert `resolveAccessPolicy('tool', 'fetch-challenge-resources')` resolves to the restricted policy with **no env vars set**, mirroring ADR 0004's own "safe by default on a fresh deploy" test for the ingestion workflows.

### Phase 5 — Validation
- `npx tsc --noEmit`, `npx eslint`, full `vitest run`.
- Manual smoke test against dev: `fetch-challenge-resources` with `role: "copilot"`/`"reviewers"`/`"registrants"` on a real challenge id, confirming counts match what `/v6/resources?challengeId=...` returns directly for the same role names.
- Manual smoke test, credential selection: with `DISABLE_AUTH=false`, confirm a member token carrying `Talent Manager` but not `administrator` still gets real (non-empty) `reviewers`/`copilot` results — i.e. that `forceM2M` is actually taking effect and not silently falling back to the member's own, insufficiently-privileged JWT. This is the test that actually validates the fix this update makes, not just that the tool runs.
- Manual smoke test, RBAC: confirm a member token with neither `administrator` nor `Talent Manager` gets `403` from this tool (via the agent or directly), and that a member with either role succeeds.
- Manual conversational smoke test on `challenge-search-agent` (dev): "who copiloted challenge X", "who were the reviewers on X", "who's registered for X" — confirm the agent calls the tool with the expected `role` value rather than inventing a `roleId` or skipping the tool.

### Phase 6 — Documentation
- `docs/adr/0004-role-based-access-for-agents-workflows-tools.md`'s "Resource inventory" table: add the `fetch-challenge-resources` row (already drafted above; apply on merge).
- No README/`.env.sample` changes — no new env vars (the restricted policy is a code-level default per Decision 6, same as the two ingestion workflows in ADR 0004; an env override remains available if it ever needs loosening without a redeploy).

## File-level mapping

| File | Change |
| --- | --- |
| `src/config/challenge-resource-roles.config.ts` | New — category → role-name registry |
| `src/utils/tc-resource-roles-cache.ts` | New — memoized `/v6/resource-roles` fetch + category resolution |
| `src/utils/tc-resource-roles-cache.test.ts` | New |
| `src/utils/tc-api-client.ts` | Modified — adds `forceM2M` option (Decision 4) |
| `src/utils/tc-api-client.test.ts` | Modified — `forceM2M` behavior + regression coverage for existing tools |
| `src/mastra/tools/challenge/fetch-challenge-resources-tool.ts` | New — the tool, wrapped in `withAccessPolicy(...)`, includes `shouldForceM2M` |
| `src/mastra/tools/challenge/fetch-challenge-resources-tool.test.ts` | New |
| `src/mastra/agents/challenge/challenge-search-agent.ts` | Modified — import + `tools` map entry + new instructions section |
| `src/config/access-control.config.ts` | Modified — adds the `tool['fetch-challenge-resources']` restricted policy (Decision 6) |
| `docs/adr/0004-role-based-access-for-agents-workflows-tools.md` | Modified — Resource inventory table gains one row |

## Consequences

**Positive**
- Closes a real, requested capability gap: `challengeSearchAgent` can now answer role-based "who" questions it currently cannot answer at all.
- Category resolution is centralized and reviewable (`CHALLENGE_RESOURCE_ROLE_CATEGORIES`), not left to the LLM to guess a `roleId` UUID or a raw role-name string — the model only ever picks from a fixed, documented enum.
- One upstream `/v6/resources` call per invocation regardless of how many actual role names a category spans (confirmed necessary — `roleId` only accepts one value per request), plus a resource-roles fetch that happens at most once per process.
- Ships already wired into ADR 0004's RBAC layer (`withAccessPolicy`), not bolted on after the fact — consistent with that ADR's "the guard travels with the exported tool object" design.
- **The tool's own RBAC now matches, rather than sits underneath, the RBAC already enforced on the one UI surface that reaches it** (platform-ui's customer-portal `rolesRequired: [administrator, Talent Manager]`) — closes the gap that would otherwise exist between "the page is gated" and "the tool behind the page is gated," per ADR 0001's D10 principle applied one layer further out than that ADR originally scoped it.
- **Credential selection is fail-safe by design, not fail-open**: `shouldForceM2M` defaults to forcing M2M (the credential confirmed to work) whenever it can't positively identify the caller as `administrator`, rather than defaulting to forwarding a possibly-insufficient JWT and silently under-returning results.

**Negative / risk**
- **`perPage=1000` is a real ceiling, not unlimited.** A challenge with more than 1000 total resources (essentially unheard of today, but not contractually impossible) gets a `truncated: true` flag and an incomplete list rather than full pagination. Chosen deliberately to keep this tool a single upstream call; revisit with a follow-up page-loop if a real challenge is ever found to exceed it.
- **The category registry is a hand-curated snapshot of a live 26-role list.** If Topcoder adds a new reviewer/manager-shaped role upstream, it silently isn't included in `reviewers`/`managers` until `CHALLENGE_RESOURCE_ROLE_CATEGORIES` is updated — mitigated by `resolveCategoryRoleIds` failing loud (not silently returning fewer results) only for a role *removed or renamed* upstream, not for one *added* upstream that isn't yet in the map. This is a one-directional safety net, not a complete one.
- **`registrants` is a naming translation the tool makes on the caller's behalf** — the upstream role is `Submitter`, not "Registrant". If Topcoder's own product surfaces ever start using "Registrant" for a upstream-distinct concept, this mapping would need revisiting; as of this ADR, no such role exists.
- **Every `Talent Manager` query now runs on tc-ai-api's own shared service M2M credential, not the individual's own identity.** This is a deliberate trade (Decision 3) to guarantee complete results, but it does mean the outbound call to Topcoder no longer distinguishes *which* Talent Manager asked — audit trail on the Topcoder side for that traffic is tc-ai-api's service identity, not the individual member. Matches ADR 0002's own stated caution about M2M being "broad, service-wide access," now deliberately invoked here rather than accidentally defaulted into.
- **`'Talent Manager'` as an exact role-string match is assumed, not independently verified against a decoded JWT.** ADR 0004 verified `administrator` appears verbatim in a real prod token's `https://topcoder.com/roles` claim; `'Talent Manager'` (with that exact casing/spacing, taken from platform-ui's `UserRole.talentManager` enum value) is assumed to come from the same underlying Auth0 role source platform-ui reads via `profile.roles`, but this ADR has not decoded a real Talent-Manager token to confirm the claim spells it identically. See Prerequisites.
- **Two RBAC-relevant identity systems now have to agree by convention, not by shared code**: platform-ui's `RestrictedRoute`/`PRIVILEGED_ROLES` and tc-ai-api's `DEFAULT_ACCESS_POLICIES`/`toAuthenticatedCaller` independently read "the user's roles" from what should be the same Auth0 identity, but nothing enforces that platform-ui's route guard and this tool's policy stay in sync going forward — noted also as a pre-existing loose end one layer up: the investigation that produced this update separately found platform-ui's own *nav-visibility* list (`PRIVILEGED_ROLES`, includes `"Project Manager"`) already disagrees with its *route-enforcement* list (`rolesRequired: [administrator, Talent Manager]`, excludes it) — this ADR's policy intentionally follows the enforced list, not the nav list, but the drift on the platform-ui side is a separate, pre-existing issue this ADR does not fix.

## Prerequisites to confirm before implementation starts

- **Both upstream endpoints' base shape were verified directly (prod) while writing this ADR** — `/v6/resource-roles` and `/v6/resources` are real, live-tested, not assumed.
- **Not yet confirmed: an authenticated-vs-unauthenticated diff on the *same* `roleId` filter.** The evidence for "non-`Submitter` roles need a token" is the unauthenticated call returning `[]` for `Copilot`/`Reviewer`; a fully conclusive test would repeat that exact call *with* a valid JWT or M2M token and confirm it returns the real rows. This session has no credential to run that second half of the comparison — do it as the first step of Phase 5's smoke testing, before relying on `forceM2M` in production.
- **Confirm `'Talent Manager'` is the literal string in a decoded member JWT's roles claim**, the same way ADR 0004 confirmed `'administrator'` — spot-check against a real Talent Manager's token during Phase 5, not assumed identical to platform-ui's `UserRole.talentManager` enum value just because the label matches.
- **Partial dev spot-check done:** `GET https://api.topcoder-dev.com/v6/resource-roles` confirmed `200` unauthenticated (same shape as prod). `GET .../v6/resources?challengeId=...` against dev returned `404` using the *prod* challenge id from this ADR's examples — expected, since dev and prod don't share challenge data, not evidence of an auth difference — but the resources endpoint's dev behavior against a real *dev* challenge id was not independently confirmed. Use a real dev challenge id for this check in Phase 5's manual smoke test.
- **No new Auth0 provisioning required** (unlike ADR 0004's `challengesRAG:admin`) — this policy only checks the existing member `roles` claim, and configures no `scopes`, so there's nothing to create on the M2M audience for this specific change.
