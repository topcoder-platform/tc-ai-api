# ADR 0006 — Member insights tool (profile / stats / special roles / activity) for `challengeSearchAgent`

- **Status:** Proposed
- **Date:** 2026-09-18
- **Target branch:** `develop`
- **Related:** [ADR 0002](0002-tc-api-requestor-token-with-m2m-fallback.md) (requestor-token-first `callTcApi`, the generic `forceM2M` option this ADR reuses as-is — no client change needed), [ADR 0004](0004-role-based-access-for-agents-workflows-tools.md) (agent/workflow/tool RBAC layer), [ADR 0005](0005-challenge-resources-tool-for-challenge-search-agent.md) (direct precedent for this ADR's shape, restricted policy, and credential-forcing pattern — see Decision 5), `src/mastra/tools/challenge/fetch-challenge-resources-tool.ts` (structural precedent), `src/mastra/agents/challenge/challenge-search-agent.ts` (the agent this tool is added to; already has a `MEMBER_PROFILE_BASE_URL` and a "Linking to member profiles" instructions section from handling challenge winners/resources)

## Context

`challengeSearchAgent` can currently answer "who's on this challenge" (`fetch-challenge-resources`, ADR 0005) and link a member's handle to their profile page, but it has no way to answer "who is this member" — their track record, rating, special-role history (copilot/reviewer), or skills. That data lives on the separate Members API (`members-api`, `TC_API_BASE`'s `/v6/members/*`), which this repo does not call today.

### Verified against the real API (prod, 2026-09-18)

Walked all five in-scope endpoints against a real, high-activity member (`Ghostar`, userId `151743`) using an M2M token (scopes include `read:user_profiles`), plus the published OpenAPI spec at `{TC_API_BASE}/v6/members/api-docs.json` (the Swagger UI's underlying JSON — not documented anywhere, found by probing common spec paths) for the authorization matrix and query-parameter contracts the UI doesn't make copy-pasteable.

**`GET /members/{handle}`** — full profile. Confirmed 30 top-level fields for a real member, including `skills` (an array of **799** entries for Ghostar — each a full taxonomy object: `id`, `name`, `category`, `displayMode` (`principal` vs `additional`), `levels` (the levels *this member has attained* for that skill — `self-declared` and/or `verified`, not a list of possible levels)). Only **8** of Ghostar's 799 skills are `displayMode: "principal"` (the member's own showcased/highlighted skills) — the other 791 are `"additional"`. Full profile payload: **~390 KB**.

- **A `fields=` query param exists and is documented** (`GET /members` and `GET /members/{handle}` both support it) — but it only controls a *documented allow-list* of fields (`userId`, `handle`, `firstName`, `lastName`, `tracks`, `status`, `addresses`, `description`, `email`, `homeCountryCode`, `competitionCountryCode`, `photoURL`, `maxRating`, `createdAt`/`createdBy`/`updatedAt`/`updatedBy`, `verified`). **`phones` and `identityVerified` are not in that allow-list and cannot be filtered out** — confirmed live: requesting `fields=userId,handle` still returns `phones` (a raw mobile number, e.g. `+610479187242`) and `identityVerified` in the response. This repo will not attempt to suppress them at the upstream call (no mechanism exists to); see Decision 2 for how this ADR handles it instead.
- **Authorization is documented explicitly, and it does not treat `Talent Manager` as a privileged JWT role for this endpoint.** Per the spec: secure fields (`firstName`, `lastName`, `addresses`, `email`, `createdBy`, `updatedBy`) require *either* the profile owner or a JWT carrying `administrator`/`admin`, *or* an M2M token with `read:user_profiles`/`all:user_profiles` scope. `Talent Manager` appears in neither the "secure fields" role list nor the separate "communication fields" autocomplete-role list (`copilot`, `administrator`, `admin`, `Connect Copilot`, `Connect Account Manager`, `Connect Admin`, `Account Executive`) that gates `email`/`firstName`/`lastName` on the *search* endpoint. **This is the concrete upstream evidence behind this ADR's credential-forcing requirement (Decision 5): a Talent Manager's own JWT does not unlock secure/communication fields on this API at all — only M2M scope does.**
- 404 shape confirmed: `{"message": "Member with handle: \"<handle>\" doesn't exist"}`.

**`GET /members?userId=<id>`** — confirmed working exactly as instructed for handle resolution: returns a **JSON array** (not an object), one element per match, with the member's `handle` alongside an *embedded* `stats` array and `skills`. Notably, this endpoint's response did **not** include `phones`/`identityVerified` in the same test — an inconsistency with `/members/{handle}` worth noting but not load-bearing (this ADR only uses this endpoint for handle resolution, discarding the rest of the payload; see Decision 1).

**`GET /members/{handle}/stats`** — aggregate performance by track. Confirmed top-level keys `challenges`, `wins`, `maxRating`, plus one key per track the member has activity in (`DEVELOP`, `DESIGN`, `DATA_SCIENCE`, `QA` for Ghostar). **The per-track shape is not uniform**: `DEVELOP`/`DESIGN`/`QA` nest a `subTracks: [{ id, name, challenges, wins, mostRecentSubmission, mostRecentEventDate, submissions: {...}, rank: {...} }]` array, but **`DATA_SCIENCE` instead exposes its subtracks as direct object keys** (`Challenge`, `MARATHON_MATCH`, `SRM`), each shaped like a `subTracks` entry but never wrapped in an array. A tool that assumes a uniform `subTracks` array across all tracks will silently miss Data Science detail. Auth: secure/group-specific stats require profile-owner-or-`administrator` JWT, or M2M scope — same gap for `Talent Manager` as above, with no "autocomplete role" carve-out at all for this endpoint.

**`GET /members/{handle}/stats/roles`** — confirmed count-only, e.g. `{"copilot": {"challengeCount": 3067}, "reviewer": {"challengeCount": 2311}}` for Ghostar; a role key is omitted entirely when its count is zero (per the spec description — not just when the member has no activity). Tiny response (~70 bytes). **Public/anonymous-visible data only, per the spec's own Authorization section — no JWT-role tier exists for this endpoint at all**, only an M2M-scope mention (which doesn't change what's returned, since the summary is defined as anonymous-visible-challenge counts). Credential selection is a no-op here (see Decision 5).

**`GET /members/{handle}/stats/roles/{role}/challenges`** — `role` is a path enum, **confirmed by the spec to be exactly `['copilot', 'reviewer']`**, nothing else. Response shape: `{ role, total, challenges: [...], trackCounts?, fulfillment? }` — `trackCounts` (per-track counts) and `fulfillment` (`completed`/`cancelled`/`total`/`rate`) are populated **only for `copilot`** (confirmed: Ghostar's `reviewer` response has both fields `null`); `reviewer` has no status restriction per the spec, `copilot` counts only `COMPLETED`/`CANCELLED*`. **`page`/`perPage` are silently ignored — confirmed live, `?page=1&perPage=5` still returned all 3067 items.** Response size for a prolific member: **~1.25 MB** for 3067 challenge-summary objects (`id`, `name`, `status`, `track`, `type`, `startDate`, `endDate`, `resourceCreatedAt`). Same public/anonymous-visible-data posture as `/stats/roles` per the spec — no JWT-role tier, M2M scope doesn't change the result set, only whether the call is authenticated at all.

**`GET /members/{handle}/stats/history`** — per-track `subTracks: [{ id, name, history: [{ challengeId, challengeName, placement, ratingDate, mostRecent }] }]`. Confirmed **no pagination support** either (same silent-ignore behavior as above) — Ghostar's `DEVELOP.Task` subtrack alone returned 2149 history rows; full response **~484 KB**. Supports `trackId`/`typeId` query filters (documented, not yet exercised against non-default values in this session). Same profile-owner-or-administrator-JWT-or-M2M-scope authorization gap as `/stats`.

### Why this matters for design

Two upstream facts directly shape the decisions below, not just implementation detail:

1. **`Talent Manager` is not a privileged role anywhere in this API's own authorization model** — every endpoint that has an elevated tier at all gates it on `administrator`/profile-owner JWT or M2M scope, never on any other named role. The tool cannot get "comprehensive... full member visibility" for a Talent Manager caller by forwarding their JWT; it must force M2M, the same way ADR 0005 does, but this time the upstream API's own published docs confirm the gap directly rather than requiring the ADR to infer it in absence of documentation.
2. **Two of the five endpoints (`stats/roles`, `stats/roles/{role}/challenges`) return the same anonymous-visible dataset regardless of credential** — credential selection is a correctness no-op for those two specifically, but this ADR still applies it uniformly across all five calls in a single tool invocation (Decision 5) rather than special-casing two of them, for the same reason ADR 0005 kept its branch simple: one decision point per invocation is easier to reason about and test than a per-endpoint matrix, and the no-op cost is one extra `getM2MToken()` call, not a correctness risk.

## Scope

**In scope:**
- One new tool, `fetch-member-insights`, taking `handle` or `userId` (resolving `userId` → `handle` via `GET /members?userId=` first, per the user's requested pattern) and combining, in one call:
  - `GET /members/{handle}` — profile
  - `GET /members/{handle}/stats` — aggregate performance by track
  - `GET /members/{handle}/stats/roles` — copilot/reviewer summary counts
  - all three **always fetched** (cheap, small, aggregate-only calls — confirmed above) — see Decision 3.
- Two **on-demand** extensions to the same tool call, each gated behind an explicit input param so the two genuinely large, unpaginated endpoints are never fetched unless actually asked for:
  - `role: 'copilot' | 'reviewer'` → `GET /stats/roles/{role}/challenges`, capped to the 20 most recent + totals/aggregates (Decision 4).
  - `includeHistory: true` (optionally narrowed by `trackId`) → `GET /stats/history`, capped the same way (Decision 4). `typeId` is documented upstream but deliberately not exposed as an agent-fillable param yet — see Decision 1a.
- Output combines and normalizes all of the above into one interface (Decision 3) — including flattening `DATA_SCIENCE`'s irregular per-subtrack shape into the same `subTracks` array shape every other track uses, so the agent (and anyone reading the tool's output schema) doesn't have to special-case it.
- Skills default to the member's `principal` (showcased) list in full, plus `totalCount`/`verifiedCount`/`additionalCount` — not the full 799-entry taxonomy dump (confirmed decision, see Decisions confirmed below).
- No code-level PII filtering — `email`, `phones`, `addresses` pass through unfiltered when upstream returns them (confirmed decision below); the RBAC restriction (admin/Talent Manager only) is the control, not a field-level filter.
- An RBAC entry point per ADR 0004 (`withAccessPolicy(...)`), **`restricted`** — `roles: ['administrator', 'Talent Manager']`, no `scopes` — added to `DEFAULT_ACCESS_POLICIES['tool']`, identical to `fetch-challenge-resources`'s policy (ADR 0005).
- Credential selection identical in shape to ADR 0005's `shouldForceM2M`: `administrator` forwards their own JWT; anything else RBAC lets through (`Talent Manager`) forces tc-ai-api's own M2M token, applied uniformly to every upstream call the tool invocation makes.
- Wiring into `challengeSearchAgent`'s `tools` map and a new instructions section, extending the agent's existing `MEMBER_PROFILE_BASE_URL`/"Linking to member profiles" conventions rather than introducing a second linking scheme.

**Out of scope:**
- `groupIds` filtering on `/stats`/`/stats/history` (private-group-specific breakdowns) — no caller-supplied group context exists in this agent's flow, and no one asked for it. Can be added later as an explicit param if a real use case shows up.
- Any of the other Members API endpoints visible in the spec but not requested (`/skills`, `/traits`, `/change_handle`, `/photo`, `/profileCompleteness`, `/profileDownload`, `/sendgrid-emails`, `/verify`, and the `PUT`/`POST`/`PATCH`/`DELETE` mutators) — this ADR is read-only and limited to the five endpoints named in scope.
- Pagination/streaming for the two large on-demand endpoints beyond the fixed 20-item cap — if a future need requires "give me all 3067", that's a follow-up ADR, not this one (mirrors ADR 0005's `perPage=1000`-ceiling precedent for the same kind of tradeoff).

## Decisions confirmed (asked directly, before writing this ADR)

1. **No code-level PII stripping.** `phones`, `addresses`, `email` all pass through to the agent unfiltered when upstream returns them; the `restricted` RBAC policy (admin/Talent Manager only) is treated as the control, not a field-level filter on top of it. Note `phones`/`identityVerified` couldn't be filtered upstream via `fields=` even if this had gone the other way (see Context) — this decision means that fact is moot rather than worked around.
2. **On-demand endpoints (`role` challenges, `history`) cap at the 20 most-recent items per call**, plus whatever aggregate/total fields upstream provides (`total`, `trackCounts`, `fulfillment` for role-challenges; a `totalEntries` count for history) and a `truncated` boolean — same pattern as ADR 0005's `perPage=1000`/`truncated` precedent, scaled down because these two endpoints have no upstream cap at all (confirmed: 3067 and 2149+ items respectively for one real member).
3. **Skills default to the member's `principal` list in full, plus counts** (`totalCount`, `verifiedCount`, `additionalCount`) for everything else — not a full dump of up to ~800 taxonomy objects on every base call.
4. **The always-on bundle is profile + stats + the stats/roles summary**, all three in one tool call with no extra opt-in param — confirmed cheap and small enough (largest of the three, the profile, still under 400 KB for an extreme case, and typically far smaller) to not warrant gating.

## Decision

### 1. Handle resolution (`src/utils/tc-member-handle-resolver.ts`, new, or inlined in the tool — see Implementation plan)

```ts
async function resolveHandle(input: { handle?: string; userId?: string | number }, requestContext, forceM2M): Promise<string> {
  if (input.handle) return input.handle;
  // GET /v6/members?userId=<id> — confirmed: returns a JSON array, one element per match
  const res = await callTcApi({ toolId: TOOL_ID, url: `${MEMBERS_BASE_URL}?userId=${encodeURIComponent(String(input.userId))}`, init: { method: 'GET' }, requestContext, forceM2M });
  if (!res.ok) throw new Error(`Failed to resolve userId ${input.userId} to a handle (HTTP ${res.status})`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`No member found for userId ${input.userId}`);
  return rows[0].handle;
}
```

`handle` wins over `userId` when both are supplied (skips the extra round-trip) — same "more specific input wins" precedent as ADR 0005's `roleId`-over-`role`.

### 1a. Tool description and input schema — what the model actually sees

The `description` string and each param's `.describe()` text are what drives the model's tool-selection and argument-filling — they matter at least as much as the agent instructions in Decision 7, and are specified explicitly here rather than left to "whatever seems reasonable" at implementation time:

```ts
export const fetchMemberInsightsTool = withAccessPolicy(
  createTool({
    id: 'fetch-member-insights',
    description:
      'Fetches a single Topcoder member\'s profile, performance stats, and Copilot/Reviewer special-role ' +
      'summary — everything needed to answer "who is this member" / "tell me about this member" questions. ' +
      'Takes exactly one member, by handle or userId. Does NOT resolve a member from a full name or ' +
      'partial text — the caller must already have an exact handle or numeric userId. Does NOT answer ' +
      '"who is on this challenge" questions (use fetch-challenge-resources for that) — this tool is ' +
      'member-centric, not challenge-centric. Optionally also fetches a specific role\'s full challenge ' +
      'history (role) or the member\'s recent challenge history (includeHistory) — both are on-demand ' +
      'because they can be very large for prolific members; omit them unless the user actually asked for ' +
      'that level of detail.',
    inputSchema: z.object({
      handle: z.string().optional().describe(
        'Exact Topcoder member handle (case-insensitive), e.g. "Ghostar". Preferred over userId when both ' +
        'are known — skips an extra lookup. Provide this or userId, never neither.',
      ),
      userId: z.union([z.string(), z.number()]).optional().describe(
        'Numeric Topcoder member userId, e.g. from a challenge\'s "winners" array (fetch-challenge-by-id) ' +
        'or a resource list (fetch-challenge-resources). Resolved to a handle automatically. Provide this ' +
        'or handle, never neither.',
      ),
      role: z.enum(['copilot', 'reviewer']).optional().describe(
        'Only set this when the user specifically asks what challenges the member copiloted or reviewed. ' +
        'Returns up to the 20 most recent (see output "truncated"/"total"). Omit for a general profile ' +
        'question — the base response already says how many copilot/reviewer challenges the member has.',
      ),
      includeHistory: z.boolean().optional().describe(
        'Set true only when the user asks about the member\'s recent competition activity/history (as a ' +
        'competitor, not copilot/reviewer) — e.g. "what has X worked on lately", "X\'s recent submissions". ' +
        'Returns up to the 20 most recent entries across all tracks (see output "history.truncated").',
      ),
      trackId: z.enum(['DEVELOP', 'DESIGN', 'DATA_SCIENCE', 'QA']).optional().describe(
        'Only used together with includeHistory, to narrow history to one track. Note this uses the raw ' +
        'track codes (DEVELOP/DESIGN/DATA_SCIENCE/QA) — NOT the same casing/wording as ' +
        'challenge-vector-query\'s "track" filter ("Development"/"Design"/"Data Science"/"Quality ' +
        'Assurance"). Omit unless the user names a specific track.',
      ),
    }),
    // outputSchema: the MemberInsights shape from Decision 2/4, as a Zod schema.
  }),
);
```

`typeId` (documented upstream on `/stats` and `/stats/history`) is **deliberately not exposed** in this schema — its exact expected value format (`"CH"` vs `"Challenge"`, etc.) is an open Prerequisite, unconfirmed in this session. Exposing an unconfirmed-format enum to the model risks it guessing a plausible-looking value that upstream silently ignores or 400s on — the same failure mode ADR 0005 avoided by confirming `roleId`'s exact contract before shipping it as agent-fillable. Add it once Phase 4's live check confirms the real value set.

### 2. Always-on profile bundle (`fetchMemberInsights`, the tool's `execute`)

Three calls, all against the resolved `handle`, run in parallel (independent, no data dependency between them):

```ts
const [profile, stats, roles] = await Promise.all([
  callTcApi({ url: `${MEMBERS_BASE_URL}/${handle}`, ... }),          // GET /members/{handle}
  callTcApi({ url: `${MEMBERS_BASE_URL}/${handle}/stats`, ... }),     // GET /members/{handle}/stats
  callTcApi({ url: `${MEMBERS_BASE_URL}/${handle}/stats/roles`, ... }), // GET /members/{handle}/stats/roles
]);
```

Mapping, per the confirmed shapes in Context:

```ts
interface MemberInsights {
  member: {
    userId: string;
    handle: string;
    handleLower: string;
    firstName?: string;
    lastName?: string;
    status: string;               // e.g. "ACTIVE"
    verified: boolean;
    identityVerified?: boolean;
    tracks: string[];             // e.g. ["DESIGN", "DEVELOP", "DATA_SCIENCE"]
    description?: string;
    homeCountryCode?: string;
    competitionCountryCode?: string;
    photoURL?: string;
    email?: string;                                    // passthrough, unfiltered (Decisions confirmed #1)
    phones?: { type: string; number: string }[];        // passthrough, unfiltered
    addresses?: { streetAddr1?: string; streetAddr2?: string; city?: string; zip?: string; stateCode?: string; type?: string }[]; // passthrough
    availableForGigs?: boolean;
    loginCount?: number;
    lastLoginDate?: string;       // ISO
    createdAt?: string;           // ISO, converted from upstream epoch-ms
    maxRating?: { rating: number; track: string; subTrack: string; ratingColor: string };
    skills: {
      principal: { id: string; name: string; category: string }[]; // full list — displayMode === "principal"
      totalCount: number;
      verifiedCount: number;      // levels includes "verified"
      additionalCount: number;    // displayMode === "additional"
    };
  };
  activity: {
    totalChallenges: number;      // stats.challenges
    totalWins: number;            // stats.wins
    tracks: Record<string, {      // one entry per track key present in `stats` (DEVELOP/DESIGN/DATA_SCIENCE/QA)
      challenges: number;
      wins: number;
      mostRecentSubmission?: string;  // ISO
      mostRecentEventDate?: string;   // ISO
      subTracks: {                    // normalized — see below for DATA_SCIENCE
        id: string;
        name: string;
        challenges: number;
        wins?: number;
        mostRecentSubmission?: string;
        mostRecentEventDate?: string;
        submissions?: Record<string, number>; // passthrough of upstream `submissions` object
        rank?: Record<string, number>;         // passthrough of upstream `rank` object
      }[];
    }>;
  };
  specialRoles: {
    copilot?: { challengeCount: number };
    reviewer?: { challengeCount: number };
  };
  // Present only when the corresponding input param was supplied — Decision 4
  roleChallenges?: RoleChallenges;
  history?: MemberHistory;
}
```

**Normalizing `DATA_SCIENCE`:** since it exposes `Challenge`/`MARATHON_MATCH`/`SRM` as direct object keys instead of a `subTracks` array (confirmed in Context), the mapper does:

```ts
function normalizeTrack(trackData: any): NormalizedTrack {
  const { challenges, wins, mostRecentSubmission, mostRecentEventDate, subTracks, ...rest } = trackData;
  const normalizedSubTracks = Array.isArray(subTracks)
    ? subTracks
    : Object.entries(rest).map(([id, v]: [string, any]) => ({ id, name: id, ...v }));
  return { challenges, wins, mostRecentSubmission, mostRecentEventDate, subTracks: normalizedSubTracks };
}
```

Applied to every track key present on the `stats` response (`DEVELOP`, `DESIGN`, `DATA_SCIENCE`, `QA` — whichever the member has activity in), so the output's `activity.tracks` shape is uniform regardless of which upstream shape a given track happens to use.

### 3. Skills reduction

```ts
function reduceSkills(skills: RawSkill[]): MemberInsights['member']['skills'] {
  const principal = skills.filter((s) => s.displayMode.name === 'principal')
    .map((s) => ({ id: s.id, name: s.name, category: s.category.name }));
  const verifiedCount = skills.filter((s) => s.levels.some((l) => l.name === 'verified')).length;
  return {
    principal,
    totalCount: skills.length,
    verifiedCount,
    additionalCount: skills.length - principal.length,
  };
}
```

### 4. On-demand role challenges and history — capped, not paginated (upstream doesn't paginate at all)

```ts
interface RoleChallenges {
  role: 'copilot' | 'reviewer';
  total: number;             // upstream's true total (e.g. 3067) — never truncated
  truncated: boolean;        // true when `challenges.length < total`
  trackCounts?: Record<string, number>;   // copilot only, passthrough
  fulfillment?: { completed: number; cancelled: number; total: number; rate: number }; // copilot only, passthrough
  challenges: { id: string; name: string; status: string; track: string; type: string; startDate: string; endDate: string; resourceCreatedAt: string }[]; // capped to 20, upstream is already newest-first per the spec
}
```

Skip the upstream call entirely when `role` is requested but `specialRoles[role]` is absent or zero from the already-fetched `stats/roles` summary (Decision 2) — no point spending a ~1 MB round-trip to learn what the 70-byte summary already told us. Return `{ role, total: 0, truncated: false, challenges: [] }` directly in that case.

```ts
interface MemberHistory {
  trackId?: string;          // echoes the input filter, if any (typeId not yet exposed — see Decision 1a)
  totalEntries: number;      // sum across all matched subTracks' history arrays, pre-cap
  truncated: boolean;        // true when totalEntries > 20
  entries: { challengeId: string; challengeName: string; track: string; subTrack: string; placement: number; ratingDate: string; mostRecent: boolean }[]; // merged across all subTracks, sorted by ratingDate desc, capped to 20
}
```

`history` merges every subtrack's `history` array across every track present in the response (tagging each entry with which track/subtrack it came from, since the raw shape doesn't carry that on the entry itself), sorts by `ratingDate` descending, and caps to 20 — giving "most recent activity across the board" by default rather than an arbitrary per-subtrack slice.

### 5. Credential selection — reuses `callTcApi`'s existing `forceM2M`, no client change (extends ADR 0002/0005)

Unlike ADR 0005, `forceM2M` already exists on `CallTcApiOptions` (added by that ADR) — this tool is simply its second caller:

```ts
function shouldForceM2M(requestContext: RequestContext | undefined): boolean {
  const user = requestContext?.get('user') as Record<string, unknown> | undefined;
  if (!user) return true;
  return !toAuthenticatedCaller(user).roles.includes('administrator');
}
```

Applied identically to all five possible upstream calls in a given invocation (handle resolution, profile, stats, stats/roles, and whichever on-demand call was requested) — see Context's "why this matters" #2 for why this stays uniform even though it's a no-op for the two anonymous-visible-data endpoints.

### 6. RBAC wiring (ADR 0004) — `restricted`, matching `fetch-challenge-resources` exactly

```ts
tool: {
  'fetch-challenge-resources': { mode: 'restricted', roles: ['administrator', 'Talent Manager'] }, // ADR 0005, unchanged
  'fetch-member-insights': { mode: 'restricted', roles: ['administrator', 'Talent Manager'] },      // this ADR
},
```

No `scopes` key, for the same reason as ADR 0005 Decision 6: `checkAccess` checks an M2M caller only against `scopes`, so omitting it denies every M2M-authenticated *caller of tc-ai-api* by construction — distinct from, and not in tension with, this tool's own *outbound* M2M usage in Decision 5, which is tc-ai-api acting as an M2M client toward the Members API, not an M2M caller reaching tc-ai-api itself.

### 7. Agent wiring (`src/mastra/agents/challenge/challenge-search-agent.ts`)

- Import and add to `tools`: `fetchMemberInsightsTool`.
- New instructions section, placed after "Linking to member profiles" (the agent already resolves and links handles for challenge winners/resources, so this extends an existing convention rather than introducing a new one):

  > **Member profile, stats, and activity**
  > Use "fetch-member-insights" when the user asks about a *member themselves* — their rating, track record, skills, or special-role history. This is member-centric, not challenge-centric:
  > - "who copiloted/reviewed challenge X" → that's "fetch-challenge-resources", not this tool.
  > - "what challenges has member X copiloted" / "tell me about member X" / "what's X's rating" → this tool.
  > - If a question could be either ("who worked with X on challenge Y") and you already have a challengeId, prefer "fetch-challenge-resources" first to see who was actually on that challenge, then use this tool only if the user then asks about one of those people specifically.
  >
  > **Resolving who "X" is.** This tool takes exactly one member, by an exact "handle" or a numeric "userId" — it does **not** search by first/last name or partial text (that's a different, unbuilt capability). If the user gives a real name ("what's John Smith's rating") rather than a handle, and you don't already have that person's handle/userId from an earlier tool result in this conversation (e.g. a challenge's "winners" list or "fetch-challenge-resources" output, both of which carry a handle), say you'd need their Topcoder handle or userId to look them up, and ask for it — don't guess a handle from a name. When you already have a "userId" from a prior result (winners, resources) but no handle, pass "userId" directly — resolution to a handle happens inside the tool, you don't need a separate lookup step.
  >
  > **Choosing parameters:**
  > - General profile question ("tell me about X", "what's X's rating/track record/skills") → base call, no extra params. The response already includes copilot/reviewer challenge *counts* (not the challenge list itself) — that's usually enough unless the user asks for the actual list.
  > - "what challenges has X copiloted" / "what has X reviewed" → add `role: "copilot"` or `role: "reviewer"`. Only these two values are valid — if the user names some other role ("who managed as X"), that's not a role this tool tracks; say so rather than passing an invalid value.
  > - "X's recent activity/history" / "what has X worked on lately" / "X's submission history" → add `includeHistory: true`. If the user names a specific track ("X's recent design work"), add `trackId` using the raw upstream codes: `DEVELOP`, `DESIGN`, `DATA_SCIENCE`, `QA`. **These are not the same strings as "challenge-vector-query"'s "track" filter** ("Development"/"Design"/"Data Science"/"Quality Assurance") — don't reuse a value from that tool here or vice versa; map the user's wording to *this* tool's enum independently.
  > - `role` and `includeHistory` can both be set in the same call when the user's question needs both (e.g. "give me X's full picture including recent copilot work and recent competition history") — you don't need two separate tool calls.
  >
  > **Presenting the result:**
  > - Lead with identity and rating: handle (linked), status, "maxRating" (rating + which track/subtrack it's from), tracks they're active in.
  > - Summarize "activity" in prose per track (e.g. "2,786 Development challenges, 2,591 wins") rather than dumping the raw per-subtrack breakdown, unless the user asks for that level of detail.
  > - Always mention "specialRoles" when either "copilot" or "reviewer" is present — that's often exactly what a Talent Manager is asking about even when they didn't name the role explicitly ("is this person copilot material" → check "specialRoles.copilot"). If both are absent, say the member has no copilot/reviewer history rather than staying silent about it.
  > - Skills: mention the "principal" (showcased) skills by name; summarize the rest as a count ("plus 791 additional listed skills, 786 of them verified") rather than listing hundreds of skill names.
  > - When "roleChallenges" or "history" is present and "truncated" is true, say the list is the most recent 20 out of the stated "total"/"totalEntries" — never present a truncated list as exhaustive.
  > - If the tool errors because the handle/userId doesn't exist, say so plainly and ask the user to double-check the spelling or provide the userId instead, rather than guessing a close match.
  > - Always link the member's handle the same way you already do for winners (see "Linking to member profiles"): `[handle](${MEMBER_PROFILE_BASE_URL}/handle)`.
  > - Proactively offer this tool when it fits — e.g. after listing a challenge's winners or resources, ask "want more detail on any of these members?" — but don't call it unprompted for every handle that appears in a result.

## Implementation plan

### Phase 0 — Handle resolution + shared mapping helpers
- Handle resolution (`resolveHandle`) and the track/skills normalizers (Decisions 1–3) — inlined in the tool file (small enough not to warrant their own module, unlike ADR 0005's resource-roles cache, which needed cross-request memoization this doesn't).
- Unit tests: `handle` wins over `userId` when both given; `userId` resolves via a mocked `/members?userId=` array response; empty array / non-2xx throws; `DATA_SCIENCE`'s object-keyed shape normalizes to the same `subTracks` array shape as `DEVELOP`; skills reduction produces correct `principal`/counts against a mixed self-declared/verified/principal fixture.

### Phase 1 — The tool
- `src/mastra/tools/member/fetch-member-insights-tool.ts` (new), wrapped in `withAccessPolicy(...)`, issuing the three always-on calls in parallel plus the conditional on-demand call(s), with `shouldForceM2M` applied to every call in the invocation.
- Tests, mocking `fetch` per the `fetch-challenge-resources-tool.test.ts` pattern:
  - Base call maps profile + stats + stats/roles into the combined shape correctly, including the skills reduction and per-track normalization.
  - `role: "copilot"` with a non-zero `specialRoles.copilot` count triggers the challenges call; a zero/absent count short-circuits it (Decision 4's optimization) and asserts no second upstream call was made.
  - `roleChallenges.truncated` true when the mocked response has more items than the 20-item cap; `trackCounts`/`fulfillment` passthrough for `copilot`, absent for `reviewer`.
  - `includeHistory: true` merges multiple subtracks' history arrays, sorts by `ratingDate` descending, caps to 20, and reports the correct pre-cap `totalEntries`.
  - `shouldForceM2M`: `administrator` → `forceM2M: false`/omitted on every call; `Talent Manager` (no `administrator`) → `forceM2M: true` on every call, including handle resolution; no user on `requestContext` → `true`.
  - `withAccessPolicy`: a caller with neither `administrator` nor `Talent Manager` denied before `execute` runs.
  - Non-2xx from any of the three always-on calls throws with the handle and status in the message; a 404 on `/members/{handle}` surfaces the upstream "doesn't exist" message rather than a generic error.

### Phase 2 — Agent wiring
- `src/mastra/agents/challenge/challenge-search-agent.ts`: import, add to `tools`, add the instructions section (Decision 7).

### Phase 3 — RBAC config
- `src/config/access-control.config.ts`: add the `tool['fetch-member-insights']` entry (Decision 6).
- Extend the existing `DEFAULT_ACCESS_POLICIES`-resolution test to assert `resolveAccessPolicy('tool', 'fetch-member-insights')` resolves to the restricted policy with no env vars set, mirroring the equivalent test added for `fetch-challenge-resources`.

### Phase 4 — Validation
- `npx tsc --noEmit`, `npx eslint`, full `vitest run`.
- Manual smoke test against prod/dev: base call against a real handle and the equivalent `userId`, confirming both resolve to the same result; `role: "copilot"`/`"reviewer"` against a member known to have each; `includeHistory` with and without `trackId`.
- Manual smoke test, credential selection: with `DISABLE_AUTH=false`, confirm a `Talent Manager`-only token still gets `email`/secure fields on the profile (i.e. `forceM2M` is taking effect, not silently forwarding an insufficiently-privileged JWT) — this is the test that actually validates Decision 5, not just that the tool runs. Mirrors the equivalent open item already outstanding on ADR 0005 (see that ADR's Prerequisites) — both should ideally be confirmed together, since they need the same kind of token this session doesn't have.
- Manual smoke test, RBAC: a token with neither `administrator` nor `Talent Manager` gets `403`.
- Manual conversational smoke test on `challengeSearchAgent`: "tell me about &lt;handle&gt;", "what challenges has &lt;handle&gt; copiloted", "what's &lt;handle&gt;'s recent activity" — confirm the agent calls the tool with the expected params rather than inventing data or skipping the tool.

## File-level mapping

| File | Change |
| --- | --- |
| `src/mastra/tools/member/fetch-member-insights-tool.ts` | New — the tool, wrapped in `withAccessPolicy(...)`, includes handle resolution, track/skills normalization, and `shouldForceM2M` |
| `src/mastra/tools/member/fetch-member-insights-tool.test.ts` | New |
| `src/mastra/agents/challenge/challenge-search-agent.ts` | Modified — import + `tools` map entry + new instructions section |
| `src/config/access-control.config.ts` | Modified — adds the `tool['fetch-member-insights']` restricted policy |
| `docs/adr/0004-role-based-access-for-agents-workflows-tools.md` | Modified — Resource inventory table gains one row, same as ADR 0005 did |

## Consequences

**Positive**
- Closes a real capability gap: `challengeSearchAgent` can answer "who is this member" questions it currently cannot answer at all, complementing the existing "who's on this challenge" (ADR 0005) and challenge-winner-linking capabilities with the same handle-linking convention.
- One tool call for the common case (profile + stats + special-role summary) instead of three separate agent-orchestrated tool calls — cheaper and less likely for the model to forget one of the three.
- The two genuinely large, unpaginated upstream endpoints are never fetched unless the user's question actually needs them (Decisions confirmed #2 and #4), keeping the typical response small even though the underlying data can be enormous for a prolific member (confirmed: up to ~1.25 MB / 3067 items for one real endpoint).
- Normalizing `DATA_SCIENCE`'s irregular shape and reducing the 799-entry skills array to `principal` + counts means the agent (and this ADR's own readers) don't have to special-case upstream quirks discovered empirically rather than documented — the tool absorbs that complexity once instead of leaving it for every future consumer to rediscover.
- Ships already wired into ADR 0004's RBAC layer with the identical policy already shipped for `fetch-challenge-resources`, so operators managing access have one consistent mental model ("administrator + Talent Manager, no M2M") for both member-visibility tools rather than two similar-but-different ones.
- Credential selection (`forceM2M`) needs no client change — reuses the option ADR 0005 already added generically to `callTcApi`, confirming that addition was in fact reusable infrastructure rather than a one-off.

**Negative / risk**
- **The 20-item cap on `role` challenges and `history` is a real information loss for a prolific member**, not just a display truncation — a member with 3067 copilot challenges gets 20 back, full stop, no pagination path to see the rest through this tool. Acceptable for the "give the agent enough to answer a conversational question" use case this ADR targets; revisit with a follow-up (paginated variant, or a raise-the-cap param) if a real need for the full list surfaces.
- **No code-level PII filtering (Decisions confirmed #1) means `email`/`phones`/`addresses` reach the LLM/agent context for every base call, for every member an admin or Talent Manager asks about.** This was an explicit, deliberate choice to rely on the RBAC gate rather than add field-level filtering — but it does mean a compromised or over-broadly-granted Talent Manager credential exposes real contact PII (including a raw mobile number that upstream cannot even be asked to omit) through natural-language chat, not just through a dedicated admin screen with its own audit trail. Flagged here as the tradeoff it is, not hidden.
- **Two of the five endpoints (`stats/roles`, `stats/roles/{role}/challenges`) are anonymous-visible by upstream design** — this tool's RBAC restriction adds no actual data protection for those two specifically (their data is already public regardless of caller). The restriction still applies uniformly for simplicity (Context, "why this matters" #2); worth remembering during any future audit that "restricted" here is about the *profile/stats* endpoints' secure fields, not those two.
- **Every `Talent Manager` query now runs on tc-ai-api's own shared service M2M credential**, same audit-trail tradeoff already accepted and documented in ADR 0005 (Consequences) for the same reason — restated here rather than re-litigated.
- **`'Talent Manager'` as an exact role-string match is still not independently verified against a decoded JWT** — same open item as ADR 0005, not newly introduced by this ADR, but doubly relevant now that a second restricted tool depends on it.

## Prerequisites to confirm before implementation starts

- **All five endpoints' shapes were verified directly (prod) while writing this ADR**, against a real, high-activity member and cross-checked against the live OpenAPI spec at `{TC_API_BASE}/v6/members/api-docs.json` — not assumed from the Swagger UI's rendered HTML alone.
- **Not yet confirmed: a real `Talent Manager` JWT's actual behavior against `/members/{handle}`**, i.e., that forwarding it (without `forceM2M`) really does come back without secure fields, matching what the spec's authorization text states. This session had only an M2M token to test with. Do this alongside ADR 0005's equivalent open item (same missing credential) during Phase 4's smoke testing, before relying on `forceM2M` in production for either tool.
- **`trackId` was exercised only implicitly** (via the values already present on a real `/stats` response), not by round-tripping it back in as a query param in this session — confirm `trackId=DEVELOP` etc. actually narrows `/stats/history` as documented before shipping. **`typeId`'s value format is unconfirmed** (e.g. `"CH"` vs `"Challenge"`) and is deliberately excluded from the input schema for this reason (Decision 1a) — confirm the real format against a live call before adding it in a follow-up change, rather than guessing from the description text alone.
- **No new Auth0 provisioning required** — identical reasoning to ADR 0005: this policy only checks the existing member `roles` claim and configures no `scopes`.
