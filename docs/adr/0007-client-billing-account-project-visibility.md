# ADR 0007 — Client/billing-account work visibility (project enrichment + client project discovery)

- **Status:** **Accepted — implemented** (implemented on this branch as designed; see *Implementation notes* at the end)
- **Date:** 2026-09-21
- **Target branch:** `fetch-client-projects`
- **Related:** [ADR 0002](0002-tc-api-requestor-token-with-m2m-fallback.md) (requestor-token-first `callTcApi`, per-tool M2M fallback registry; the `forceM2M` option this ADR reuses), [ADR 0004](0004-role-based-access-for-agents-workflows-tools.md) (agent/workflow/tool RBAC layer — this ADR's two tools plug into it, not around it), [ADR 0005](0005-challenge-resources-tool-for-challenge-search-agent.md) (direct structural precedent: a restricted tool that branches outbound credential by caller role), `src/mastra/tools/project/fetch-project-tool.ts` and `src/mastra/agents/challenge/challenge-search-agent.ts` (the tool and agent this ADR modifies)

## Context

The business need is "easily get visibility to work delivered for a specific client." Today `challengeSearchAgent` can resolve a **project** (`fetchProjectTool` / `fetch-project-by-id`) and search challenges within it, but there is no path from a **client/customer name** down to "which projects did we deliver for them" — a caller has to already know a project id or name. Topcoder's v6 platform models this as a three-level hierarchy, `clients → billing accounts → projects`, and a billing account's own detail record carries the expanded `client` object inline, plus a separate `subcontractingEndCustomer` field.

All four endpoints' response shapes are now confirmed against real data (requester-supplied samples) — none were assumed at the time this ADR was finalized. **The three list endpoints do not share one pagination shape**, which matters directly for Decision 4's `truncated` derivation:

- `GET /v6/clients?codeName=&name=` — **envelope-paginated**: `{ page, perPage, total, totalPages, data: [...] }`. Each `data` row: `{ id, name, codeName, status, startDate, endDate, createdAt, updatedAt }` (`id` already a numeric-looking string, e.g. `"71000412"`).
  ```json
  { "page": 1, "perPage": 20, "total": 4, "totalPages": 1, "data": [
    { "id": "71000412", "name": "ANHEUSER-BUSCH", "codeName": "CUS-173826", "status": "ACTIVE", "startDate": "...", "endDate": "...", "createdAt": "...", "updatedAt": "..." }
  ] }
  ```
- `GET /v6/billing-accounts?clientId=` — **same envelope shape** (`page`/`perPage`/`total`/`totalPages`/`data`). Each row is the full billing-account record (`id` as a bare *number*, e.g. `70016070`, unlike client ids) — including a redundant nested `client` object and a `subcontractingEndCustomer` field (confirmed `null` when absent, string when present, per Decision 1's finding) — of which only `id`/`name` are needed for this ADR's purposes.
  ```json
  { "page": 1, "perPage": 20, "total": 3, "totalPages": 1, "data": [
    { "id": 70016070, "name": "RPC Rewrite", "clientId": "70014161", "subcontractingEndCustomer": null, "client": { "id": "70014161", "name": "..." }, /* ...budget/markup/locked-amount fields, unused */ }
  ] }
  ```
- `GET /v6/projects?billingAccountId=` — **NOT envelope-paginated** — the confirmed sample is a **bare JSON array**, with no `page`/`total`/`data` wrapper at all, unlike the two endpoints above:
  ```json
  [
    { "id": "15554", "directProjectId": "2278", "billingAccountId": "70016070", "name": "RPC Rewrite", "status": "completed", /* ... */ }
  ]
  ```
  This exact dual-shape ambiguity is already handled defensively by this tool's existing sibling, `fetchProjectTool`'s `searchProjectsByName()` (`fetch-project-tool.ts:170`: `Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []`) — `fetch-client-projects` reuses the same defensive parsing for this one call rather than assuming either shape.
- `GET /v6/billing-accounts/{billingAccountId}` (single detail, used by `fetchProjectTool`'s enrichment, not by `fetch-client-projects`) — a bare object, `client` expanded (`id`, `name`, `codeName`, `status`, `startDate`, `endDate`, `createdAt`, `updatedAt`), `subcontractingEndCustomer` a **plain string or `null`**, not an object — corrected from this ADR's original assumption that both were expanded objects:
  ```json
  {
    "id": 80004519,
    "clientId": "71000535",
    "subcontractingEndCustomer": "Ford India",
    "client": { "id": "71000535", "name": "Wipro Limited (NA subcontracting)", "codeName": "CUS-275117", "status": "ACTIVE", "startDate": "...", "endDate": "...", "createdAt": "...", "updatedAt": "..." }
    // ...plus billing/financial fields (budget, markup, lockedAmounts,
    // consumedAmounts, poNumber, salesTax, etc.) deliberately not surfaced —
    // see Decision 1.
  }
  ```

None of these four endpoints are called anywhere in this repo today (confirmed by grep for `clients`/`billing-accounts` under `src/`).

This ADR has two parts:

1. **Enrich `fetchProjectTool`** with the client (and subcontracting end-customer) behind a project's `billingAccountId`, via the new `GET /v6/billing-accounts/:id` call.
2. **Add a new tool** that walks `clients → billing accounts → projects` for a client search term, so the agent can answer "find me all the work done for client XYZ" and then hand off to the existing per-project tools (`fetch-project-by-id`, and `challenge-vector-query`'s existing `projectId` filter) once the user picks one project to dive into.

Both are locked to a privileged audience — `administrator` and `Talent Manager` — via the existing ADR 0004 RBAC layer, following the exact precedent ADR 0005 set for `fetch-challenge-resources`: a tool that used to be (or would otherwise default to) open is deliberately restricted because the data it surfaces (client/billing/financial context) is not meant for every authenticated member.

Next ADR number is **0007** — 0006 is in use on another, not-yet-merged branch, so this ADR skips it to avoid a collision.

### Confirmed with the requester before writing this ADR

**Restricting `fetchProjectTool` is total, not split.** `fetch-project-by-id` is public today, and `challengeSearchAgent`'s existing instructions rely on it for *any* authenticated member to resolve a project name to an id (e.g. "what's in the Acme project", "challenges on skproject1" — see `challenge-search-agent.ts`'s "Keep projects separate" section). Restricting the whole tool to `administrator`/`Talent Manager` means every other authenticated member loses that resolution entirely and gets an access-denied error instead of a result, the next time this ships. Asked directly, confirmed: restrict the whole tool as specified, not just the new client/billing enrichment — accepted as a deliberate behavior change on the existing, currently-public tool (see Consequences).

## Scope

**In scope:**
- Extending `fetchProjectTool`'s output with a `client` object and a `subcontractingEndCustomer` string, sourced from `GET /v6/billing-accounts/:id`, keyed off the project's existing `billingAccountId`.
- A new agent-callable tool, `fetch-client-projects`, walking `clients → billing accounts → projects` for a caller-supplied `codeName`/`name` search term.
- Restricting both tools' RBAC policy (ADR 0004) to `roles: ['administrator', 'Talent Manager']`, no `scopes` (M2M callers of tc-ai-api itself denied for both, matching ADR 0005's precedent of no current M2M consumer).
- Outbound-credential policy that **differs between the two tools**, per explicit instruction (see Decision 3 and 4): `fetch-project-by-id` never escalates to M2M, for any caller, ever; `fetch-client-projects` forwards the caller's own JWT only for `administrator` and forces tc-ai-api's service M2M token for every other RBAC-permitted role.
- Wiring `fetch-client-projects` into `challengeSearchAgent`'s tool map and instructions, teaching the agent to present results and then ask the user which project to dive into before falling back to the existing `fetch-project-by-id` / `challenge-vector-query` (`projectId` filter) tools for depth.

**Out of scope (explicitly deferred, not rejected):**
- Any UI/route-level gate mirroring this restriction on the consuming side (platform-ui) — out of this repo's control, same framing ADR 0005 used ("in addition to, not instead of").
- Mutating clients/billing-accounts/projects — this is read-only, matching every other tool in this repo.
- Full pagination past a bounded page size at any of the three `fetch-client-projects` levels — a `truncated` flag surfaces the "more exist" case instead (mirrors `fetch-challenge-resources`'s own `MAX_PER_PAGE`/`truncated` precedent), rather than an unbounded fan-out of follow-up pages.
- An M2M-callable path for either tool (no `scopes` configured) — no current M2M consumer of either tool exists; revisit if one appears.
- A general-purpose "any TC v6 entity by search term" tool — this ADR's new tool is purpose-built for the client → billing-account → project walk the requester described, not a generic client of the whole platform API surface.

## Decisions

### 1. `fetchProjectTool` — client/billing-account enrichment

`fetch-project-tool.ts`'s `PROJECT_SHAPE` gains two new optional fields, matching the confirmed response shape (see Context):
- `client`: an object (`id`, `name`, `codeName` — the fields relevant to identifying the client; `status`/`startDate`/`endDate`/`createdAt`/`updatedAt` and every billing/financial field on the billing account itself are deliberately left out, keeping this enrichment about "who the client is," not a billing-account dump). `id` is coerced to string defensively (`toStringOrUndefined`, the same helper `mapProject` already uses), even though the confirmed sample already returns it as a string — for resilience against a future/other environment returning it as a number, the same defensive posture `mapProject` already takes for `billingAccountId`/`directProjectId`.
- `subcontractingEndCustomer`: a plain optional string, copied through as-is — **not** the `PARTY_SHAPE`-style object this ADR originally assumed.

A new helper, `fetchBillingAccount(billingAccountId, requestContext)`, calls `GET /v6/billing-accounts/:id` through the existing shared `callTcApi` client (ADR 0002) — same `toolId` (`fetch-project-by-id`), same requestor-token-first behavior already in place for this tool.

Enrichment point: after the existing `fetchProject()` (numeric-id path) or `searchProjectsByName()` (name-search path) produces its result, if the resolved `project.billingAccountId` is set, call `fetchBillingAccount` and attach `client`/`subcontractingEndCustomer` onto that one `project` object. Only the primary `project` is enriched — never the `matches` array a name search can also return — keeping this to exactly one extra upstream call per invocation, consistent with the tool's existing "matches exist only for the caller to disambiguate, not for depth" design.

**Enrichment is fail-soft, not fail-closed.** A missing `billingAccountId`, a non-2xx response from the billing-account call, or a thrown error during enrichment must not fail the tool call — the project lookup remains the tool's primary contract, and enrichment is additive on top of it. On any of those cases, log a warning and return the project with `client`/`subcontractingEndCustomer` simply absent, rather than surfacing an error for a request that otherwise succeeded.

### 2. `fetchProjectTool` never escalates to M2M — explicit, confirmed instruction

Unlike `fetch-challenge-resources` (ADR 0005), which forces tc-ai-api's own service M2M credential for any caller who isn't `administrator` because the upstream Resources API silently degrades for an insufficiently-privileged JWT, `fetch-project-by-id` (both its existing project lookup and this ADR's new billing-account enrichment call) stays **requestor-JWT-only for every caller, including `Talent Manager`** — confirmed directly with the requester, not a default inherited from ADR 0005's shape. `TOOL_M2M_FALLBACK_CONFIG` already has no entry for `fetch-project-by-id` (ADR 0002 decision 8), so the *reactive* 401/403 fallback path is already off; this ADR adds no `forceM2M` argument to any `callTcApi` call this tool makes, so there is no *proactive* M2M path either.

Practical consequence: if a `Talent Manager`'s own JWT can resolve the project but genuinely cannot see the underlying billing account, the enrichment silently comes back without `client`/`subcontractingEndCustomer` (per Decision 1's fail-soft behavior) rather than the tool escalating privilege on their behalf to force a result. This is an accepted trade-off (correctness/least-privilege over completeness), the same trade-off ADR 0002 itself made for this tool originally.

### 3. RBAC — restrict `fetch-project-by-id`, add `fetch-client-projects` (`src/config/access-control.config.ts`)

Both tools get a `restricted` policy with the same two roles, no `scopes`:

```ts
tool: {
  'fetch-challenge-resources': { mode: 'restricted', roles: ['administrator', 'Talent Manager'] },
  'fetch-project-by-id': { mode: 'restricted', roles: ['administrator', 'Talent Manager'] },
  'fetch-client-projects': { mode: 'restricted', roles: ['administrator', 'Talent Manager'] },
},
```

No `scopes` on either entry means, per `checkAccess`'s existing, deliberate design (ADR 0004): every M2M caller of tc-ai-api itself is denied for both tools by construction — matching ADR 0005's own precedent (no M2M consumer of either tool exists today).

`fetchProjectTool` is already exported wrapped in `withAccessPolicy(createTool(...))` (`fetch-project-tool.ts:48`) — the RBAC *mechanism* is already wired; only the policy *entry* is new. `fetch-client-projects` ships wrapped the same way from its own export site, per every other tool in this repo.

Both tools reuse the same `'administrator'`/`'Talent Manager'` role strings ADR 0004/0005 already established for this codebase — no new role is introduced by this ADR.

ADR 0004's "Resource inventory" table gains/updates two rows to reflect this (`fetch-project-by-id` moves from `public` to `restricted`; `fetch-client-projects` is added), per that ADR's own stated requirement that the config registry track any future addition.

### 4. New tool — `fetch-client-projects`

A new tool, `fetch-client-projects` (`src/mastra/tools/client/fetch-client-projects-tool.ts`), walks the three-level hierarchy for a client search term:

- **Input:** `codeName` and/or `name` (at least one required — mirrors the requester's own example, which passed both together as a narrowing pair, not alternatives to OR together).
- **Step 1:** `GET /v6/clients?codeName=&name=&page=1&perPage=<cap>` — only the params actually supplied are forwarded. Response is the confirmed `{ page, perPage, total, totalPages, data }` envelope (see Context); `clientsTruncated = total > data.length`.
- **Step 2** (per client found): `GET /v6/billing-accounts?clientId=<id>&page=1&perPage=<cap>`. Same envelope shape; `billingAccountsTruncated = total > data.length` per client. Only `id`/`name` are read off each row — the nested `client` object and every budget/financial field in the confirmed sample are ignored (redundant with Step 1, and out of scope per Decision 1's "keep this about identity, not billing internals").
- **Step 3** (per billing account found): `GET /v6/projects?billingAccountId=<id>&page=1&perPage=<cap>`. The **body** is a bare array, no envelope (see Context) — parsed with the same defensive `Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []` `fetchProjectTool`'s `searchProjectsByName()` already uses. Pagination metadata instead comes from **response headers**, confirmed present on this endpoint (`X-Page`, `X-Per-Page`, `X-Total`, `X-Total-Pages`, `Link` — a live request against `billingAccountId=70016070` returned `X-Total: 1`, `X-Per-Page: 20`) — the exact same header set `GET /v6/resources` already uses (ADR 0005). `projectsTruncated = X-Total > returned.length`, matching `fetch-challenge-resources-tool.ts`'s existing `truncated` derivation exactly, not a proxy signal.
- Every call goes through the shared `callTcApi` client (ADR 0002), so credential handling, headers, and timeout stay centralized rather than a fourth hand-rolled `fetch`.

### 5. `fetch-client-projects` credential selection — M2M for everyone except `administrator`

Per the requester's explicit instruction ("For the API calls it should be using M2M for all other roles different than admin"): the caller's own JWT is forwarded only when they hold `administrator`; every other RBAC-permitted role (`Talent Manager`) — and the case of no user at all on the request context — forces tc-ai-api's own service M2M token for every call this tool makes. This is the same shape as ADR 0005's `shouldForceM2M` (fail-toward-the-privileged-credential rather than fail-open toward a possibly-insufficient JWT), and reuses `callTcApi`'s existing `forceM2M` option (ADR 0005) rather than adding a second mechanism.

This is a deliberate, explicit divergence from Decision 2 above: the same requester who ruled out M2M entirely for `fetch-project-by-id` asked for the opposite default here. The difference is defensible on the data shape involved — `fetch-project-by-id` returns one project a caller already has a specific reason to look up (and ADR 0002's original reasoning for that tool — never show a user data their own token can't see — still applies to a single project lookup); `fetch-client-projects` is explicitly a cross-project *discovery* tool for a privileged operational role, where an incomplete client/billing-account/project tree (because a `Talent Manager`'s own JWT can't see some of it) would silently undercount delivered work rather than fail loudly — the same completeness argument ADR 0005 made for `fetch-challenge-resources`.

### 6. Agent wiring (`challengeSearchAgent`)

- `fetch-client-projects` is added to `challengeSearchAgent`'s tool map alongside the existing four tools.
- A new instructions section teaches the natural-language trigger ("find me all the work done for client XYZ", "show me everything for customer ABC" → call the tool with `name`, or `codeName` when the phrasing looks like a client code), how to present the nested client → billing-account → project result (linking each project the same way the agent already links projects elsewhere), and — critically — that the agent should **ask the user which project to dive into** rather than picking one, then use the existing `fetch-project-by-id` and `challenge-vector-query` (`projectId` filter, already present in that tool's input schema) tools for depth, exactly as the requester specified. No new tool is introduced for the "dive deeper" step — it reuses what already exists.
- A small addition to the existing project-detail guidance notes that `fetch-project-by-id` can now also surface `client`/`subcontractingEndCustomer` when available, for "who is the client on this project" style questions, absent (not an error) when the caller's own JWT can't see the billing account or the project has none.

## File-level mapping

| File | Change |
| --- | --- |
| `src/mastra/tools/project/fetch-project-tool.ts` | Modified — `client`/`subcontractingEndCustomer` fields, `fetchBillingAccount()`, fail-soft enrichment; no `forceM2M` anywhere in this file |
| `src/mastra/tools/project/fetch-project-tool.test.ts` | Modified — enrichment success / absent-`billingAccountId` / fail-soft-on-error cases; asserts the billing-account call is never made with `forceM2M` |
| `src/config/access-control.config.ts` | Modified — restrict `fetch-project-by-id`; add `fetch-client-projects` |
| `docs/adr/0004-role-based-access-for-agents-workflows-tools.md` | Modified — Resource inventory rows for both tools |
| `src/mastra/tools/client/fetch-client-projects-tool.ts` | New — the client → billing-account → project tool, wrapped in `withAccessPolicy(...)` |
| `src/mastra/tools/client/fetch-client-projects-tool.test.ts` | New — pagination/`truncated` at each level, `shouldForceM2M` per role, input validation, RBAC denial |
| `src/mastra/agents/challenge/challenge-search-agent.ts` | Modified — import, `tools` map entry, new instructions section, client/enrichment note |
| `src/utils/auth/access-control.test.ts` | Modified — assert both new/changed tool policies resolve correctly with no env vars set (mirrors the existing `fetch-challenge-resources` assertion at line 249) |

## Consequences

**Positive**
- Closes the requested capability gap end-to-end: a client/customer name now resolves all the way down to the projects delivered for them, without requiring the caller to already know a project id or name.
- `fetch-project-by-id` answers "who is the client on this project" for the roles that need it, reusing the same tool and shape the agent already calls for every other project question.
- Both tools ship already wired into ADR 0004's RBAC layer, consistent with "the guard travels with the exported tool object" rather than bolted on after the fact.
- Credential selection is explicit and reviewable per tool, not inferred: `fetch-project-by-id` is single-caller-identity by design (Decision 2); `fetch-client-projects` is fail-safe toward completeness for a discovery tool (Decision 5) — the divergence is documented here rather than left as an inconsistency a future reader has to puzzle out.

**Negative / risk**
- **`fetch-project-by-id` going from `public` to `restricted` is a real, immediate loss of functionality for every non-`administrator`/`Talent Manager` caller of `challengeSearchAgent`.** Any such member's "what's in the Acme project" / "challenges on skproject1" style question, which resolves a project name to an id via this tool today, starts failing with an access-denied error the moment this ships. Confirmed and accepted directly with the requester (see Context) — flagged here because it is a behavior change on a *previously-open* tool, a different risk profile than ADR 0005's `fetch-challenge-resources`, which was restricted before it ever shipped open.
- **`fetch-project-by-id`'s enrichment can silently under-deliver for non-`administrator` callers.** Because this tool never escalates to M2M (Decision 2), a `Talent Manager` whose own JWT can't see a given billing account gets a project result with no `client`/`subcontractingEndCustomer` and no error — indistinguishable, from the tool's output alone, from "this project genuinely has no billing account." Mitigated by fail-soft logging (visible in server logs, not to the caller) but not by anything user-facing; revisit if this proves confusing in practice.
- **Two structurally similar tools now have opposite default outbound-credential postures** (`fetch-project-by-id`: never M2M; `fetch-client-projects`: M2M for everyone but `administrator`) — a future contributor extending either could reasonably assume the other's convention applies. Decision 5 documents the reasoning; nothing in the code itself prevents the assumption from being made incorrectly later.
- **`fetch-client-projects`'s fan-out is bounded per level, not globally** — a client search term matching several clients, each with several billing accounts, each with several projects, multiplies upstream calls (capped by the per-level page size, but not by a total call budget). Acceptable for the tool's intended narrow-search usage (a specific client name/code), revisit if a pathological broad search term proves this a problem in practice.

## Prerequisites to confirm before implementation starts

- ~~Live shape of `GET /v6/billing-accounts/:id`~~ — **Confirmed** (see Context): `client` is an expanded object, `subcontractingEndCustomer` is a plain string.
- ~~Live shapes of `GET /v6/clients`, `GET /v6/billing-accounts?clientId=`, and `GET /v6/projects?billingAccountId=`~~ — **Confirmed** (see Context, requester-supplied real samples for all three). `clients` and `billing-accounts?clientId=` both return the `{ page, perPage, total, totalPages, data }` envelope; `projects?billingAccountId=` returns a bare array body but the same `X-Page`/`X-Per-Page`/`X-Total`/`X-Total-Pages`/`Link` headers as `GET /v6/resources` (ADR 0005) — confirmed by a live request's response headers, not assumed. This asymmetry (envelope body vs. header-driven pagination) is accounted for directly in Decision 4, not glossed over as "paginated the same way."
- A live-deployment smoke test (post-implementation, non-blocking, same convention as every prior ADR's own Phase-N manual step): a non-privileged member gets `403` from both tools; a member holding either role succeeds; a `Talent Manager` querying `fetch-client-projects` gets complete (not silently truncated by their own JWT's visibility) results, confirming `forceM2M` is actually taking effect.

## Implementation notes (added at implementation time)

Shipped on this branch matching Decisions 1–6 as designed, no code-level deviations found on review:

- `src/mastra/tools/project/fetch-project-tool.ts` — `client`/`subcontractingEndCustomer` added to `PROJECT_SHAPE`, `fetchBillingAccount()` + `mapBillingAccountParty()` added, enrichment wired into `execute()` via `enrichWithClient()` (fail-soft: catches and logs, never throws), only the primary `project` enriched, never `matches`. No `forceM2M` anywhere in the file, matching Decision 2.
- `src/mastra/tools/client/fetch-client-projects-tool.ts` — new tool, matching Decision 4's three-step walk exactly, including the envelope-vs-header pagination asymmetry (`parseEnvelope()` for clients/billing-accounts, `X-Total` header for projects) and `shouldForceM2M()` matching Decision 5 (forces M2M for anyone not `administrator`, including no-user-on-context).
- `src/config/access-control.config.ts` — `fetch-project-by-id` and `fetch-client-projects` both added as `{ mode: 'restricted', roles: ['administrator', 'Talent Manager'] }`, no `scopes` (Decision 3).
- `docs/adr/0004-role-based-access-for-agents-workflows-tools.md` — Resource inventory table updated for both tools (Decision 3).
- `src/mastra/agents/challenge/challenge-search-agent.ts` — `fetchClientProjectsTool` imported and wired into the `tools` map; a new "Finding a client's work across projects" instructions section added ahead of "Keep projects separate"; the existing project-detail guidance extended with a note about `client`/`subcontractingEndCustomer` (Decision 6).
- Test coverage lands where the plan called for it: `fetch-project-tool.test.ts` gained an enrichment describe block (success, no-`billingAccountId`, non-2xx fail-soft, thrown-error fail-soft, matches-not-enriched, never-`forceM2M`) plus an explicit RBAC describe block; `fetch-client-projects-tool.test.ts` covers the happy path, truncation at each level, input validation, credential selection per role, and RBAC denial; `access-control.test.ts` asserts both new/changed policies resolve correctly with no env vars set. The existing `fetch-project-tool.test.ts` `minimalContext` fixture needed its stub user updated to carry the `administrator` role, since the tool is no longer `public` — the only test churn beyond new coverage.
- `README.md` — updated beyond this ADR's original Phase-4 scope (which only called for the ADR-0004 inventory table and no env var changes): the Access control shipped-defaults block, the Requestor Token Propagation table, the Agents table/section, the Tools section (count, table, and a new `fetch-client-projects` detail section, plus `fetch-project-by-id`'s expanded), the Retrieval section's `fetchProjectTool` bullet, and the External API Interactions table were all brought in sync, matching how ADR 0005's README additions were scoped in practice rather than the narrower Phase-4 text.
- Validation: `npx tsc --noEmit`, `npx eslint .`, and `npx vitest run` are all green (580/580 tests passing, up from 558 pre-ADR-0007).

**Still open (unchanged from the Prerequisites above):** the live-deployment smoke test — confirming a non-privileged member gets `403`, a privileged member succeeds, and `forceM2M` actually yields complete results for a non-`administrator` `fetch-client-projects` caller. Not run from this session; tracked as a follow-up before leaning on this in production, the same way ADR 0005 left its own equivalent smoke tests as a deploy-time step.
