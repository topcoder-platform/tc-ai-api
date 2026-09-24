# ADR 0008 — Member search tool (talent search by skills + profile filters) for `challengeSearchAgent`

- **Status:** **Accepted** (2026-09-24) — revision 3, all review questions confirmed and all blocking prerequisites met; ready for implementation, not yet implemented
- **Date:** 2026-09-24
- **Target branch:** `develop`
- **Related:** [ADR 0002](0002-tc-api-requestor-token-with-m2m-fallback.md) (requestor-token-first `callTcApi`, per-tool M2M fallback registry — this ADR deliberately opts **out** of it), [ADR 0004](0004-role-based-access-for-agents-workflows-tools.md) (agent/workflow/tool RBAC layer), [ADR 0006](0006-member-insights-tool-for-challenge-search-agent.md) (the single-member counterpart this tool hands off to), [ADR 0007](0007-client-billing-account-project-visibility.md) Decision 2 (precedent for "requestor JWT only, never escalate to M2M"), `src/mastra/workflows/skills/skill-extraction-workflow.ts` (existing fuzzy → semantic skill-mapping pattern), `src/mastra/tools/skills/standardized-skills-{fuzzy,semantic}-tool.ts` (the two skill-lookup tools reused as-is)

## Revision 3 — what changed (2026-09-24)

The requester supplied the preferred-role picker (screenshot of the Talent Search UI), asking for the list as an easy-to-modify constant. The screenshot shows 7 of the picker's options; the full list and its codes were taken from the picker's source, `topcoder-platform/platform-ui` `src/libs/shared/lib/constants/index.ts` (`preferredRoleOptions`, 12 roles). While there, the search endpoint's own source (`topcoder-platform/reports-api-v6` `src/reports/member/member-search.service.ts`, last changed 2026-08-31, `b4dc70d`) was read; it settles several things revision 2 inferred or left open. See Context → *Upstream implementation*.

1. **`preferredRoles` becomes an enum driven by one constant**, `MEMBER_SEARCH_PREFERRED_ROLES` in `src/config/member-search.config.ts` (new, Decision 8). Upstream matches role codes exactly (after upper-casing), so an unknown value silently returns zero results — the free-string-plus-normalization input from revision 2 is replaced.
2. **Countries are normalized to ISO alpha-3.** Upstream compares the input with the member's alpha-3 `homeCountryCode`/`competitionCountryCode`, or the stored country name. The spec's `"US"` example would not match a code; `"IND"` (Sample B) does. The tool converts names and alpha-2 codes with `i18n-iso-countries`, the library upstream already uses for the same codes (Decision 2).
3. **`wins` explained:** a requested skill counts for a member when `wins >= minWins OR submitted > 0`, so `minWins` only matters for members with no submissions in that skill (in practice never). Revision 2's handling (annotate, don't filter) stands; the prerequisite changes from "find out what happens" to "ask whether it's intended".
4. **`matchIndex` formula confirmed** (it matches Sample B exactly), and **no-skill ordering corrected**: with `preferredRoles` and no skills, upstream orders by recently active, then open to work, then handle — not alphabetically. Revision 2's "always send `sortBy: handle` when there are no skills" would have thrown that away; it now leaves sorting to upstream and reports the order it used (`rankedBy`).
5. **Filter descriptions corrected from the source:** `verifiedProfile` is "verified member flag **or** Trolley payment profile"; `recentlyActive` is "added as a resource on any challenge in the last 3 months"; `profileComplete` checks are listed; skill search only finds members with **platform activity** in the skill (self-declared skills alone never match).

## Revision 2 — what changed (2026-09-24)

Requester-supplied live responses from `POST /v6/reports/member/search`, plus direct probes of the standardized-skills API, contradicted three assumptions in revision 1:

1. **Fuzzy skill match results are returned in alphabetical order, not by relevance** (Context → *Standardized-skills API*). Revision 1's approved rule "take the top fuzzy result when there's no exact match" would resolve `react` → *Create React App*, `python` → *IPython (Python Package)*, `node` → *eNodeB (LTE Technology)*, `llm` → *Apple Device Enrollment Program (DEP)*. **That approval is superseded**; Decision 1 is rewritten around exact/alias matching plus semantic ranking, with an explicit `ambiguous` outcome instead of a guess. **Needs re-confirmation** — see *Review questions*.
2. **`skills[].wins` is not enforced upstream** as the spec describes: a search with `wins: 1` on both skills returned members whose only matched skill has `wins: 0` (Context → *Live responses*). The tool now annotates rather than trusts it (Decisions 3–4, 7), and it is raised as an upstream question (Prerequisites).
3. **Skill ids can be validated and named up front** via `GET /v5/standardized-skills/skills/{id}` (unauthenticated; `404` for an unknown id). UUID inputs are now looked up before searching, which removes the upstream "one or more skill IDs not found" `404` from the tool's failure modes and replaces revision 1's unreliable "backfill the name from `matchedSkills`" step (the live sample shows a requested skill that no returned member matched, so the name would never have been found).

Smaller refinements: no-skill searches sort by handle explicitly (Decision 3); `photoUrl` dropped from the output; `location` and `countries` descriptions corrected to observed formats; agent instructions updated for all of the above.

## Context

`challengeSearchAgent` can answer "who *is* member X" (`fetch-member-insights`, ADR 0006) and "who was on challenge/project Y" (`fetch-challenge-resources`, `fetch-project-by-id`), but it cannot answer the staffing question that starts most talent conversations: **"find me members who can do X"** — e.g. "find open-to-work React + Node.js developers in the US", "who are our AI/ML engineers in Australia", "find copilots who know Salesforce". Today a Talent Manager does that in the Talent Search portal by hand, including picking skills from a taxonomy.

The Reports API already exposes the endpoint behind that portal.

### Published contract (dev spec, 2026-09-24)

Source: `https://api.topcoder-dev.com/v6/reports/api-docs-json` (the JSON behind the linked Swagger UI; `api-docs.json` 404s).

**`POST /v6/reports/member/search`** — operation `MemberSearchController_search`, *"Search members for the Talent Search portal"*. Description: *"Returns a paginated list of members that satisfy the supplied filters, sorted by match index or handle… **Accessible by Administrator and Talent Manager roles only.**"* Responses: `200`, `400` (validation), `401`, `403` (insufficient role), `404` ("One or more skill IDs not found").

Request body (`MemberSearchBodyDto`, every field optional):

| Field | Type | Upstream semantics |
| --- | --- | --- |
| `skills` | `{ id: uuid (required), wins?: number ≥1 }[]` | Skill filter; `wins` documented as minimum wins for that skill, inclusive — **not enforced in practice, see below**. |
| `skillSearchType` | `'OR' \| 'AND'`, default `OR` | OR = any of the skills; AND = all. |
| `openToWork` | boolean | Only members with the open-to-work / available-for-gigs flag. |
| `recentlyActive` | boolean | Only members who registered for a challenge/work item in the past 3 months. |
| `verifiedProfile` | boolean | Spec: only members with a verified Trolley payment profile. Source: verified member flag **or** Trolley record (see below). |
| `profileComplete` | boolean | 100% profile completeness — applied after the lightweight filters (the expensive one). |
| `copilot` | boolean | Only members holding the platform Copilot role. |
| `preferredRoles` | `string[]` | Preferred-role values from the open-to-work trait, e.g. `AI_ML_ENGINEER`, `FULL_STACK_DEVELOPER`. No enum in the spec; the value set is platform-ui's picker (see *Preferred roles*). |
| `countries` | `string[]` | Spec: country names or codes, case-insensitive. Source: ISO alpha-3 codes or stored names (see below). |
| `sortBy` | `'matchIndex' \| 'handle'`, default `matchIndex` | |
| `sortOrder` | `'asc' \| 'desc'`, default `desc` | |
| `page` | number ≥1, default 1 | |
| `limit` | number 1–100, default 8 | |

Response (`MemberSearchResponseDto`): `{ total, page, limit, data: MemberResultDto[] }`; each member: `id` (userId, string), `handle`, `name`, `photoUrl` (nullable), `isRecentlyActive`, `isVerified` (Trolley), `openToWork`, `isCopilot`, `location`, `matchIndex` (0–100, ceiled), `matchedSkills: { id, name, isVerified, wins, submitted }[]`.

### Live responses (requester-supplied, dev, 2026-09-24)

**Sample A — filters only:** `{"limit":10,"page":1,"skills":[],"skillSearchType":"OR","copilot":true,"recentlyActive":true}` → `total: 40`, 10 members.
- Every member has `matchIndex: 0` and `matchedSkills: []`. With nothing to rank on, the order is **handle ascending, case-insensitive** (`billsedison`, `codebump`, `DaraK`, `darakcopilot1`, `dimkadimon`, … `Ghostar`) despite the default `sortBy: matchIndex, sortOrder: desc`. `matchIndex` carries no information in a no-skill search.
- An empty `skills: []` is accepted (the portal always sends it).

**Sample B — skills + country + filters:** `{"limit":10,"page":1,"skills":[{"id":"c8670c34-…","wins":1},{"id":"4458454c-…","wins":1}],"skillSearchType":"OR","countries":["IND"],"copilot":true,"recentlyActive":true}` (skills: *Salesforce Development (SFDC)* and *React.js*) → `total: 6`.
- **`wins: 1` is not applied as a per-skill minimum.** 5 of 6 members' only matched skill is React.js with `wins: 0` (e.g. `lal_g`: `wins: 0, submitted: 111`). The cause is in the upstream source (below): any submission in the skill qualifies the member.
- **No returned member matched the Salesforce skill** — `matchedSkills` only contains skills the member actually matched, so a requested skill's name cannot be reliably recovered from results.
- **`matchIndex` is not a win rate.** `codebump` (React.js 2 wins / 3 submitted) → `34`; every member with 0 wins → `25`, whether `submitted` is 1 or 111. The formula (below) reproduces both values exactly.
- Ties on `matchIndex` are again ordered by handle ascending.
- **`countries: ["IND"]` (ISO alpha-3) works.** The source shows why, and that the spec's `"US"` example would not (below).
- `location` is `"City, Country"` (`"Bengaluru, India"`) or just `"Country"` (`"India"`, `"Romania"`) — not the spec example's `"Sydney Australia"`.
- `name` is returned as members typed it (`"DANIELA PR"`, `"diji disna"`), or the handle when no name is set; `photoUrl` is null for many members.

### Upstream implementation (`reports-api-v6`, `member-search.service.ts` `search()`, read 2026-09-24)

Facts from the source, which the tool and the agent instructions rely on:

- **Members:** only `status = 'ACTIVE'`.
- **Skills:** unknown or disabled ids → `404 "Skill not found or is disabled: <id>"` (checked before searching). Duplicate ids are merged upstream too.
- **Which members a skill search finds:** a requested skill counts for a member when their `skills.user_skill_win_summary` row has `wins >= minWins OR submitted > 0`. `OR` needs at least 1 counted skill, `AND` needs all of them. So:
  - **Only members with platform activity (submissions/wins) in the skill are found**; a skill a member only self-declared on their profile never matches.
  - **`minWins` has no effect** for anyone with at least one submission in that skill, which is everyone with wins. The sample result is the code working as written; whether that's intended is an upstream question (Prerequisites).
- **`matchIndex`:** each matched skill scores `1 + min(wins / 100, 0.5) + (wins / submitted) × 0.5`, between 1 and 2; `matchIndex = ceil(min(sum / (2 × number of requested skills) × 100, 100))`. It measures **how many of the requested skills a member has activity in**, with a smaller bonus for win rate and win count. Check: `codebump` = ceil((1 + 0.02 + 0.333) / 4 × 100) = 34; 0 wins = 1 / 4 × 100 = 25. 0 when no skills are requested.
- **Ordering:**
  - `sortBy: 'handle'` → handle in the requested direction, then `matchIndex`.
  - No skills **and** `preferredRoles` set → recently active first, then open to work, then handle A→Z (ignores `sortOrder`).
  - Otherwise → `matchIndex` in the requested direction, then handle A→Z. With no skills every `matchIndex` is 0, so this is effectively handle A→Z (Sample A).
- **`countries`:** each value is trimmed and upper-cased, then matched against the member's `homeCountryCode` or `competitionCountryCode` (**ISO alpha-3**, e.g. `IND`, `USA`) or the upper-cased stored country name. An alpha-2 code like `US` matches neither. Response locations are built from the alpha-3 code with `i18n-iso-countries`.
- **`preferredRoles`:** upper-cased and matched **exactly** against the member's open-to-work `preferredRoles`. Unknown values match nobody and raise no error.
- **`openToWork`:** the member's `availableForGigs` flag.
- **`recentlyActive`:** the member was added as a resource (any role: submitter, reviewer, copilot, …) on some challenge in the last 3 months.
- **`verifiedProfile`** (and the `isVerified` output field): the member's `verified` flag **or** a Trolley payment recipient record exists.
- **`copilot`:** the member holds the identity role `copilot`.
- **`profileComplete`:** requires all of: a description, a home country, an address with a city, at least one work entry, at least one education entry, an open-to-work entry (with at least one preferred role if availability is set), and at least one principal and one additional skill.

### Preferred roles (platform-ui, read 2026-09-24)

The Talent Search "Preferred role" picker (requester's screenshot) is `preferredRoleOptions` in `platform-ui` `src/libs/shared/lib/constants/index.ts`; the Reports UI's display labels (`preferredRoleLabels`, `src/apps/reports/src/pages/talent/TalentPage.utils.ts`) list the same 12 codes:

| Code | Label |
| --- | --- |
| `AI_ML_ENGINEER` | AI / ML Engineer |
| `DATA_SCIENTIST_ENGINEER` | Data Scientist / Data Engineer |
| `CYBERSECURITY_ENGINEER` | Cybersecurity Analyst / Security Engineer |
| `CLOUD_ENGINEER` | Cloud Engineer / Solutions Architect |
| `DEVOPS_SRE` | DevOps Engineer / SRE |
| `FULL_STACK_DEVELOPER` | Full-Stack Developer |
| `QA_AUTOMATION_ENGINEER` | QA Lead / Automation Engineer |
| `UX_DESIGNER` | UX Designer |
| `TECHNICAL_PM` | Technical Project Manager |
| `DB_ADMIN` | Database Administrator |
| `AI_PROMPT_ENGINEER` | AI Prompt Engineer |
| `ENTERPRISE_ARCHITECT` | Enterprise Architect |

The list may change (requester), so it lives in one constant (Decision 8).

### Standardized-skills API (probed directly, dev, 2026-09-24)

`GET /v5/standardized-skills/skills/fuzzymatch?term=&size=` — **results are sorted alphabetically, not by relevance**, and matching is substring-like on the exact spelling:

| term | fuzzy results (in returned order) |
| --- | --- |
| `react` | Create React App, Flux (React.js), Isomorphic React, ReactiveSearch, React.js |
| `react.js` | Flux (React.js), React.js |
| `react js` | React Jsx |
| `reactjs`, `nodejs`, `node js`, `k8s` | *(empty)* |
| `node` (size 20) | eNodeB (LTE Technology), Inode, Linode, NameNode, Node B, **Node.js**, Node-RED, Nodes, npm (Node Package Manager) |
| `python` | IPython (Python Package), Luigi (Python Package), **Python**, … |
| `aws` | **Amazon Web Services (AWS)**, AWS Amplify, AWS AppSync, … |
| `sfdc` | **Salesforce Development (SFDC)** |
| `salesforce` | Salesforce Apex, Salesforce Development (SFDC), Salesforce Object Query Language (SOQL), … |
| `llm` | Apple Device Enrollment Program (DEP) |

`POST /v5/standardized-skills/skills/semantic-search {text}` — always returns 10 results **ranked by `weighted_distance`** (lower is closer):

| term | top results (distance) |
| --- | --- |
| `react js` / `reactjs` / `react` | React.js (0.379 / 0.513 / 0.763), then React Jsx (≥0.94) |
| `node js` / `nodejs` | Node.js (0.423 / 0.561) |
| `node` | **Nodes (0.592)**, Node.js (0.978) |
| `python` | Python (0.35) |
| `large language models` | Large Language Modeling (0.527) |
| `salesforce` | Salesforce Apex (0.864), Salesforce Security (0.958), Salesforce Development (SFDC) (0.984) |
| `aws` | Amazon Web Services (AWS) (0.963) |
| `k8s` | Amazon EKS (1.044), Kubernetes (1.086) |
| `llm`, `ml`, `xyzzy framework` | nothing below 1.05 |

`GET /v5/standardized-skills/skills/{id}` — returns `{ id, name, description, category, … }` without auth; unknown UUID → `404 {"message":"Skill with id … does not exist!"}`; non-UUID → `400`.

Takeaways that drive Decision 1:
- **Fuzzy is good at exact names and abbreviations in parentheses** (`python`, `machine learning`, `aws`, `sfdc`, `react.js`, `node.js`) and **useless as a ranker**.
- **Semantic is good at spelling variants** (`reactjs`, `react js`, `node js`, `nodejs`) and ranks properly, but its top hit can be wrong for short/ambiguous terms (`node` → *Nodes*), and the existing `0.85` threshold rejects some correct hits (`aws` 0.963) — which fuzzy already covers.
- **Some terms are genuinely ambiguous** (`salesforce` → five Salesforce skills) and **abbreviations like `k8s`, `llm`, `ml` resolve in neither** — the model should expand those before calling.

### Why this matters for design

1. **Skills are raw UUIDs upstream**; users and the model speak in terms. Translation happens inside the tool, but it has to be *correct*, and the data above shows neither lookup alone is — hence a combined, deterministic resolver with an honest "ambiguous" outcome.
2. **The upstream endpoint itself authorizes Administrator and Talent Manager** — the same roles this repo's RBAC admits for member tools — so the caller's own JWT is sufficient; the requester asked for no M2M use and no M2M fallback.
3. **An unfiltered search is valid upstream** (returns the whole member base), so the tool must require at least one real filter.
4. **Upstream's `wins` filter has no practical effect**, so the tool must not tell the agent (or the user) that results meet a win threshold they may not meet.
5. **`preferredRoles` and `countries` fail silently** on a value upstream doesn't know (zero results or a narrower search, never an error), so the tool must send only values upstream recognizes.

## Scope

**In scope:**
- One new tool, `search-members` (`src/mastra/tools/member/search-members-tool.ts`), wrapping `POST /v6/reports/member/search`, exposing every upstream filter.
- A skill resolver (`src/mastra/tools/skills/skill-term-resolver.ts`, new) that accepts skill **terms or UUIDs** and resolves them via fuzzy match → semantic search → (UUIDs) id lookup, entirely inside the tool call.
- Reporting how each skill was interpreted, which are ambiguous (with candidates for the agent to pick from) and which don't exist.
- The preferred-role list as one editable constant (`src/config/member-search.config.ts`), and country names/codes converted to the ISO alpha-3 codes upstream matches on.
- Requestor-JWT-only credentials: no `forceM2M`, no `TOOL_M2M_FALLBACK_CONFIG` entry.
- RBAC: `restricted`, `roles: ['administrator', 'Talent Manager']`, no `scopes`.
- `challengeSearchAgent` wiring and a new instructions section.
- ADR 0004's Resource inventory rows.

**Out of scope:**
- `GET /v6/reports/member/open-to-work` and `/open-to-work/export` (the export returns email/phone). Possible future source of the `preferredRoles` value set.
- Caching skill-term resolutions.
- Exposing the skill lookup tools directly to the agent.
- A dedicated talent agent (confirmed: stays on `challengeSearchAgent`).
- Client-side filtering of results by wins (would break `total` and paging; see Decision 3).

## Decisions confirmed

From the original request:
1. Skill terms and raw skill ids are both accepted; terms map to ids using `standardizedSkillsFuzzyTool` first and `standardizedSkillsSemanticTool` when fuzzy doesn't find a match; this happens behind the scenes.
2. Access for `administrator` and `Talent Manager` using the caller's own token — no M2M token, no M2M fallback.
3. Comprehensive tool description and schema descriptions, plus agent-instruction updates.
4. ADR only — no implementation until review.

From review of revision 1 (2026-09-24):
5. Tool lives on `challengeSearchAgent`.
6. Page size: default 10, max 50.
7. ~~Take the top fuzzy result when there's no exact match.~~ **Superseded by revision 2** — fuzzy results are alphabetical, so "top" is arbitrary. See Decision 1 and *Review questions*.

From the requester, revision 3 (2026-09-24):

8. The preferred-role list is the Talent Search picker's, and it may change — so it lives in one easy-to-edit constant that the tool derives everything from (Decision 8).

## Decision

### 1. Skill resolution (`src/mastra/tools/skills/skill-term-resolver.ts`, new)

```ts
export type SkillResolution =
  | { input: string; status: 'resolved'; id: string; name: string; matchedBy: 'id' | 'exact' | 'alias' | 'semantic'; minWins?: number }
  | { input: string; status: 'ambiguous'; candidates: { id: string; name: string }[] }   // 1–5 candidates
  | { input: string; status: 'unresolved'; reason: string };

export async function resolveSkillTerms(
  items: { skill: string; minWins?: number }[],
  ctx: { requestContext?: RequestContext; logger?: IMastraLogger },
): Promise<SkillResolution[]>;
```

**Name keys.** For comparison, every skill name yields up to three keys, all normalized as `lowercase → strip everything non-alphanumeric` (`"React.js"` → `reactjs`, `"Node.js"` → `nodejs`):
- **full** — the whole name (`Amazon Web Services (AWS)` → `amazonwebservicesaws`) and the name without its parenthetical (`amazonwebservices`);
- **paren** — the parenthetical content (`aws`; `Salesforce Development (SFDC)` → `sfdc`; `Flux (React.js)` → `reactjs`);
- **js** — for names whose full key ends in `js`, the key without it (`React.js` → `react`, `Node.js` → `node`). This handles the JavaScript-library naming convention users routinely drop.

A term's key is the same normalization of the input (`"react js"`, `"reactjs"`, `"React.JS"` → `reactjs`).

A candidate **matches** the term with tier: `full` (1) > `paren` (2) > `js` (3). Among candidates on the same best tier, the shortest name wins (so for `react.js`, *React.js* beats *Flux (React.js)*, which only matches on `paren`).

**Per input, in order, stopping at the first hit:**

1. **UUID** — `GET {TC_API_BASE}/v5/standardized-skills/skills/{id}` (plain `fetch`, no token, same as the two existing skill tools). `200` → `resolved`, `matchedBy: 'id'`, with the canonical `name`. `404` → `unresolved`, `"No Topcoder skill has this id"`. Other errors → `resolved` with `name` = the id and a logged warning (don't block a search on a transient lookup failure for an id the caller presumably got from a real record; upstream still validates it — see Decision 3's `404` mapping).
2. **Fuzzy key match** — `standardizedSkillsFuzzyTool.execute({ term, size: 20 })`. Best key match among results → `resolved`, `matchedBy: 'exact'` (tier 1) or `'alias'` (tiers 2–3). `size: 20` because results are alphabetical: the right answer can sit well past position 5 (`node` → *Node.js* is 6th).
3. **Semantic** — `standardizedSkillsSemanticTool.execute({ text: term })` (always 10 results, ranked).
   1. Best key match among the 10 → `resolved`, `'exact'`/`'alias'`. This is what fixes spelling variants (`react js`, `nodejs`) and keeps `node` from landing on *Nodes*: the `js`-key match on *Node.js* beats *Nodes*' closer distance.
   2. Else, the closest result if `weighted_distance ≤ SKILL_MATCHING_SEMANTIC_THRESHOLD` (default `0.85`, the extraction workflow's existing env var) → `resolved`, `matchedBy: 'semantic'` (`large language models` → *Large Language Modeling*).
4. **Ambiguous** — if either lookup produced plausible candidates, return `ambiguous` with up to 5, ordered semantic-distance-first then fuzzy:
   - fuzzy results whose name contains the term as a whole word (`salesforce` → *Salesforce Apex*, *Salesforce Development (SFDC)*, …; excludes *Visualforce*), and
   - semantic results with `weighted_distance ≤ 1.0`.
5. **Unresolved** — nothing plausible (`xyzzy framework`, `llm`, `k8s`), `reason: "No matching Topcoder skill"`.

This keeps the requested order (fuzzy first, semantic only when fuzzy doesn't produce a match) but defines a fuzzy "match" as a name/abbreviation match rather than "fuzzy returned anything", because fuzzy always returns *something* alphabetical.

Worked examples against the live data above:

| input | outcome |
| --- | --- |
| `python`, `machine learning` | fuzzy, `exact` |
| `aws` | fuzzy, `alias` (paren) → Amazon Web Services (AWS) |
| `sfdc` | fuzzy, `alias` (paren) → Salesforce Development (SFDC) |
| `react`, `node` | fuzzy, `alias` (js) → React.js / Node.js |
| `react.js`, `node.js` | fuzzy, `exact` |
| `react js`, `reactjs`, `nodejs`, `node js` | fuzzy empty or no key match → semantic, `exact` |
| `large language models` | semantic, `semantic` (0.527) |
| `salesforce` | `ambiguous`: Salesforce Apex, Salesforce Security, Salesforce Development (SFDC), SOQL, SOSL |
| `k8s`, `llm`, `xyzzy framework` | `unresolved` (agent is instructed to expand abbreviations before calling — Decision 7) |

Lookup failures (non-2xx, network) are caught per term and fall through to the next step; they never fail the search on their own. Terms resolve concurrently (≤10 per call). After resolution, `resolved` entries are **deduplicated by id**, keeping the larger `minWins`.

The two skill tools stay `public` (ADR 0004); the id lookup is a plain unauthenticated `fetch` like theirs. No token is involved in skill resolution at all.

### 2. Tool description and input schema — what the model sees

```ts
export const searchMembersTool = withAccessPolicy(
  createTool({
    id: 'search-members',
    description:
      'Searches the Topcoder member base for people matching skills and profile filters — the same search ' +
      'as the Talent Search portal. Use it to FIND candidates ("find React developers in the US who are open ' +
      'to work", "strong Python + AWS members", "copilots who know Salesforce"). Returns a ranked, paginated ' +
      'shortlist with each member\'s handle, name, location, availability flags, a match score and per-skill ' +
      'activity (wins, submissions). ' +
      'Skills can be plain names ("node.js", "react js", "machine learning") or Topcoder skill UUIDs; names are ' +
      'mapped to the Topcoder skills taxonomy automatically. If a skill name is ambiguous the search is NOT run ' +
      'and the result lists candidate skills to choose from — call again with the chosen candidate\'s id. ' +
      'At least one filter is required. ' +
      'Does NOT look up one known member (use fetch-member-insights) and does NOT say who worked on a specific ' +
      'challenge (use fetch-challenge-resources).',
    inputSchema: z
      .object({
        skills: z
          .array(
            z.object({
              skill: z.string().min(1).describe(
                'One skill: a technology/tool/domain name (e.g. "node.js", "React", "AWS Lambda", "machine ' +
                'learning") or an exact Topcoder skill UUID (e.g. from a challenge\'s "skills" in ' +
                'fetch-challenge-by-id, or a "candidates" entry from a previous search-members result). ' +
                'Write abbreviations out in full ("k8s" → "Kubernetes", "ML" → "machine learning", "LLM" → ' +
                '"large language models"). One skill per entry — split "React and Node" into two. Never ' +
                'invent UUIDs.',
              ),
              minWins: z.number().int().min(1).optional().describe(
                'Minimum challenge wins wanted for THIS skill. Set only when the user asks for proven / ' +
                'experienced / "has won" members or gives a number. The search service does NOT filter on ' +
                'it (any member with activity in the skill is returned): check each member\'s ' +
                'matchedSkills[].meetsMinWins in the result.',
              ),
            }),
          )
          .max(10)
          .optional()
          .describe('Skills to match. Omit entirely for a search by profile filters only.'),
        skillMatch: z.enum(['any', 'all']).optional().describe(
          'How multiple skills combine. "any" (default) = at least one of the skills, members matching more ' +
          'rank higher; "all" = must have every skill. Use "all" when the user needs one person with the full ' +
          'set ("React AND Node", "both").',
        ),
        openToWork: z.boolean().optional().describe(
          'true = only members who flagged themselves available for work. For "available", "open to work", ' +
          '"can start". Omit rather than passing false.',
        ),
        recentlyActive: z.boolean().optional().describe(
          'true = only members who took part in a challenge in any role (competitor, reviewer, copilot, …) ' +
          'in the past 3 months. For "active", "recent", "currently engaged". Omit rather than passing false.',
        ),
        verifiedProfile: z.boolean().optional().describe(
          'true = only verified members: a verified member account or a payment (Trolley) profile. Use for ' +
          '"verified" or "can be paid" members.',
        ),
        profileComplete: z.boolean().optional().describe(
          'true = only members with a fully filled-in profile (bio, location, work history, education, ' +
          'open-to-work preferences, showcased skills). Slowest filter — only when asked for.',
        ),
        copilot: z.boolean().optional().describe(
          'true = only members who hold the Topcoder Copilot role.',
        ),
        preferredRoles: z.array(preferredRoleEnum).max(MEMBER_SEARCH_PREFERRED_ROLES.length).optional().describe(
          // Generated from MEMBER_SEARCH_PREFERRED_ROLES (Decision 8) so the list is never out of sync:
          'Roles members said they WANT in their open-to-work preferences — only members who set ' +
          'open-to-work preferences can match. Pick the codes that fit the user\'s wording: ' +
          MEMBER_SEARCH_PREFERRED_ROLES.map((r) => `${r.value} (${r.label})`).join(', ') + '. ' +
          'For "people who can do X", use skills instead; use this for "people looking for X roles".',
        ),
        countries: z.array(z.string().min(1)).max(30).optional().describe(
          'Countries, as names or ISO codes, any case: "India", "IN", "IND", "United States", "US", "USA". ' +
          'Converted to Topcoder\'s country codes automatically. A member matches if they are in any of ' +
          'them. Expand regions ("EU", "LATAM") into countries yourself.',
        ),
        sortBy: z.enum(['matchIndex', 'handle']).optional().describe(
          '"matchIndex" (default) = best skill match first. "handle" = alphabetical; only when asked. ' +
          'Without skills, results come back alphabetically, or most active/available first when ' +
          'preferredRoles is set — see "rankedBy" in the result.',
        ),
        sortOrder: z.enum(['asc', 'desc']).optional().describe(
          'Leave unset: defaults to best-first for matchIndex and A→Z for handle.',
        ),
        page: z.number().int().min(1).optional().describe(
          '1-based page. For "show more", repeat the previous call with identical filters and page + 1.',
        ),
        limit: z.number().int().min(1).max(50).optional().describe(
          'Members per page, default 10, max 50. Raise only when the user asks for a longer list.',
        ),
      })
      .refine(hasAtLeastOneFilter, {
        message:
          'Provide at least one filter (skills, openToWork, recentlyActive, verifiedProfile, profileComplete, ' +
          'copilot, preferredRoles or countries) — an unfiltered search is not allowed.',
      }),
    outputSchema, // Decision 4
    execute,      // Decision 3
  }),
);
```

Mapping to the upstream body:

- `skills[].skill` → resolved `id`; `minWins` → `wins` (only when set).
- `skillMatch: 'any' | 'all'` → `skillSearchType: 'OR' | 'AND'`.
- `false` booleans are dropped, not forwarded.
- `preferredRoles`: `preferredRoleEnum = z.enum(MEMBER_SEARCH_PREFERRED_ROLES.map((r) => r.value))` — the model can only send codes upstream knows (Decision 8). Deduplicated, sent as-is.
- `countries`: each value → ISO alpha-3 with `i18n-iso-countries` (new dependency, the same library upstream uses): a valid alpha-3 code is kept, a valid alpha-2 → `alpha2ToAlpha3`, anything else → `getAlpha3Code(name, 'en')`. Checked against v7.14.0: `US`, `USA`, `United States`, `UK`, `United Kingdom`, `UAE`, `Russia`, `South Korea`, `Vietnam`, `Czechia`, `Türkiye`, `Ivory Coast`, `in`/`IN`/`IND`/`India` all convert. Not converted: `America`, `Britain`, `England`, `Korea`, `Viet Nam`, `Macedonia`, `Holland` — covered by a small alias map next to the conversion helper (`Korea` → `KOR`, the common intent). Deduplicated. **Values that don't convert are not sent**; they're reported in `unrecognizedCountries` (Decision 4) and the search runs with the rest. If none convert, the search is not run (`searched: false`) — dropping the country filter would widen the search.
- `limit`: default 10, max 50 (confirmed). `page`: default 1.
- **Sorting:** `sortBy` is sent only when the caller set it; `sortOrder` defaults to `desc` for `matchIndex` and `asc` for `handle`. No override for no-skill searches: upstream already orders those by handle, or by activity/availability when `preferredRoles` is set, which is more useful than alphabetical. `rankedBy` (Decision 4) reports which order applies, derived with the same rules as upstream.
- `hasAtLeastOneFilter`: non-empty `skills`, any `true` boolean, non-empty `preferredRoles`/`countries`. Sorting/paging alone is not a filter.

### 3. Execution (`execute`)

1. `resolveSkillTerms(input.skills)` (Decision 1).
2. **Any `ambiguous`** → do not search. Return `searched: false`, `message: 'Some skills matched several Topcoder skills — pick one and search again.'`, and `skillResolution` with the candidates. Searching without the skill, or with a guess, would answer a different question than the one asked.
3. **Skills requested and none `resolved`** (all `unresolved`) → do not search; `searched: false`, `message: 'None of the requested skills exist in the Topcoder skills taxonomy.'` Searching anyway would silently drop the skill constraint.
4. **Some `resolved`, some `unresolved`** → search with the resolved ones; unresolved stay in `skillResolution`. `appliedFilters.skills` shows exactly what was searched (this matters for `skillMatch: 'all'`).
5. **Countries** converted (Decision 2); none converted → do not search, `searched: false`, `message: 'None of the requested countries were recognized.'`. Some converted → search with those, the rest in `unrecognizedCountries`.
6. Build the body (Decision 2) and call `callTcApi({ toolId: 'search-members', url: `${TC_API_BASE}/v6/reports/member/search`, init: { method: 'POST', body }, requestContext })` — **no `forceM2M`** (Decision 5).
7. Error mapping (thrown `Error`s, messages written for the agent):
   - `400` → `"Member search rejected the filters: <upstream message>"`.
   - `401`/`403` → `"Your account is not permitted to use member search (Administrator or Talent Manager role required)."` — never retried.
   - `404` → `"Skill not found or disabled: <id from upstream message>"` — only reachable if an id lookup in Decision 1 step 1 failed transiently, or the skill is disabled (upstream also rejects disabled skills).
   - other non-2xx / network → `"Member search is unavailable right now (HTTP <status>)."`
8. Map the response (Decision 4). For every `matchedSkills` entry whose skill had a `minWins`, set `meetsMinWins = wins >= minWins`. **No client-side filtering** — dropping members from a page would make `total`, `hasMore` and paging wrong. `minWinsEnforced: false` is reported whenever any `minWins` was sent, so the agent doesn't have to know the upstream behaviour from memory.
9. `rankedBy`, using upstream's ordering rules (Context → *Upstream implementation*): `sortBy === 'handle'` → `'handle'`; no resolved skills and `preferredRoles` set → `'activity'`; no resolved skills → `'handle'`; otherwise `'matchIndex'`.

### 4. Output schema

```ts
const outputSchema = z.object({
  searched: z.boolean().describe(
    'false = the search was NOT run (ambiguous or unknown skills) — see "message" and "skillResolution". ' +
    'Never report this as "no members found".',
  ),
  message: z.string().optional().describe('Why the search was not run, when searched is false.'),
  total: z.number().describe('Members matching the filters across all pages (0 when searched is false).'),
  page: z.number(),
  limit: z.number(),
  hasMore: z.boolean().describe('true when more members exist beyond this page.'),
  rankedBy: z.enum(['matchIndex', 'handle', 'activity']).describe(
    'How members are ordered. "matchIndex" = best skill match first. "handle" = alphabetical. "activity" = ' +
    'recently active first, then open to work, then alphabetical (preferredRoles search without skills). ' +
    'Only "matchIndex" is a best-first ranking — never call "handle"/"activity" results the "best" or "top".',
  ),
  unrecognizedCountries: z.array(z.string()).optional().describe(
    'Countries from the call that could not be recognized and were left out of the search.',
  ),
  minWinsEnforced: z.boolean().optional().describe(
    'Present when minWins was requested. false = the search service did not guarantee it; use ' +
    'matchedSkills[].meetsMinWins to tell which members actually meet it.',
  ),
  skillResolution: z.array(
    z.object({
      input: z.string().describe('The skill exactly as provided in the call.'),
      status: z.enum(['resolved', 'ambiguous', 'unresolved']),
      id: z.string().optional().describe('Topcoder skill UUID searched (resolved only).'),
      name: z.string().optional().describe('Canonical Topcoder skill name — use this name with the user.'),
      matchedBy: z.enum(['id', 'exact', 'alias', 'semantic']).optional().describe(
        '"id"/"exact" = certain. "alias" = matched an abbreviation or a ".js" form (e.g. "aws" → Amazon Web ' +
        'Services (AWS), "react" → React.js). "semantic" = closest meaning — mention the interpretation.',
      ),
      candidates: z.array(z.object({ id: z.string(), name: z.string() })).optional().describe(
        'Ambiguous only: possible skills. Pick the one that fits the user\'s request and call again with its ' +
        'id; ask the user only if you genuinely cannot tell.',
      ),
      reason: z.string().optional().describe('Unresolved only: why.'),
    }),
  ).describe('How each requested skill was interpreted. Empty when no skills were requested.'),
  appliedFilters: z.object({
    skills: z.array(z.object({ id: z.string(), name: z.string(), minWins: z.number().optional() })),
    skillMatch: z.enum(['any', 'all']),
    openToWork: z.boolean().optional(),
    recentlyActive: z.boolean().optional(),
    verifiedProfile: z.boolean().optional(),
    profileComplete: z.boolean().optional(),
    copilot: z.boolean().optional(),
    preferredRoles: z.array(z.object({ value: z.string(), label: z.string() })).optional().describe(
      'Roles searched; use "label" with the user.',
    ),
    countries: z.array(z.string()).optional().describe('ISO alpha-3 codes searched.'),
    sortBy: z.enum(['matchIndex', 'handle']),
    sortOrder: z.enum(['asc', 'desc']),
  }).optional().describe(
    'Filters actually sent (after skill resolution). Absent when searched is false. For "show more", call ' +
    'again with these (skills by id) and page + 1.',
  ),
  members: z.array(
    z.object({
      userId: z.string().describe('Topcoder user id; can be passed to fetch-member-insights as "userId".'),
      handle: z.string().describe('Topcoder handle — link it to the profile; pass to fetch-member-insights.'),
      name: z.string().optional().describe('Name as the member entered it.'),
      location: z.string().optional().describe('"City, Country" or just "Country".'),
      matchIndex: z.number().describe(
        'Skill-match score 0-100, mostly driven by how many of the requested skills the member has activity ' +
        'in, with a small bonus for wins. 0 for everyone when no skills were searched. For ranking only — ' +
        'not a percentage fit or win rate; describe strength with matchedSkills wins/submitted instead.',
      ),
      openToWork: z.boolean().describe('Flagged themselves available for work.'),
      isRecentlyActive: z.boolean().describe('Took part in a challenge in any role in the past 3 months.'),
      isVerified: z.boolean().describe('Verified member account or payment (Trolley) profile.'),
      isCopilot: z.boolean().describe('Holds the Topcoder Copilot role.'),
      matchedSkills: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          wins: z.number().describe('Challenge wins with this skill.'),
          submitted: z.number().describe('All platform activity events with this skill (submissions, wins, …).'),
          meetsMinWins: z.boolean().optional().describe('Present when minWins was requested for this skill.'),
        }),
      ).describe(
        'Requested skills this member has platform activity (submissions/wins) in; may cover only some of ' +
        'the requested skills. Skills a member only listed on their profile never appear here.',
      ),
    }),
  ),
});
```

Mapping from upstream: `id → userId`; `photoUrl` **dropped** (no use in a chat answer, often null); empty `name`/`location` → omitted; `matchedSkills[].isVerified` dropped (always true — upstream only returns skills with activity); `name` equal to `handle` → omitted (upstream substitutes the handle when no name is set). No email/phone exists on this endpoint; the `restricted` RBAC policy is the control for the name/location PII, as in ADR 0006.

### 5. Credentials — requestor JWT only, no M2M in any form

The one token-protected call (member search) goes through `callTcApi` with the caller's own JWT:

- **No `forceM2M`.**
- **No `TOOL_M2M_FALLBACK_CONFIG` entry** — a 401/403 surfaces as an access error, never retried with the service token.
- No requestor token → `callTcApi` already throws; RBAC (Decision 6) denies before that anyway.

Tests assert the M2M service mock is never called: admin caller, Talent Manager caller, and a 403 upstream response.

Rationale: upstream authorizes exactly the roles our RBAC admits, so every permitted caller has a JWT upstream accepts. M2M would only add privilege for callers who shouldn't have got in, and would erase the caller's identity from the Reports API's audit trail for a search over personal data (same reasoning as ADR 0007 Decision 2).

### 6. RBAC (ADR 0004)

`src/config/access-control.config.ts`, `DEFAULT_ACCESS_POLICIES.tool`:

```ts
'search-members': {
    mode: 'restricted',
    roles: ['administrator', 'Talent Manager'],
},
```

No `scopes` → M2M callers of tc-ai-api are denied. Internal calls to the two `public` skill tools pass their own `withAccessPolicy` checks with the same `requestContext`.

ADR 0004's Resource inventory gains:

| Tool | `searchMembersTool` | `search-members` | Agent-callable (`challengeSearchAgent`) — **default-restricted (ADR 0008)**: `roles: ['administrator', 'Talent Manager']`, no `scopes` (M2M denied); requestor JWT only, no M2M fallback |

and the two skill-tool rows change to "Internal only (`skill-extraction-workflow` step; `search-members` skill resolution)".

### 7. Agent wiring (`src/mastra/agents/challenge/challenge-search-agent.ts`)

- Add `searchMembersTool` to `tools`.
- Add `"search-members"` to the grounding sentence at the top of the instructions.
- Extend "Linking to member profiles" to include `search-members` results.
- Add to "Member profile, stats, and activity": *"If the user describes the kind of member they want rather than naming one, use "search-members" instead."*
- New section, before "Member profile, stats, and activity":

```text
Finding members (talent search)
Use "search-members" when the user wants to FIND people by what they can do or their availability — "find me React developers", "who could build this", "open-to-work data scientists in India", "copilots who know Salesforce". If they name one specific member, use "fetch-member-insights"; if they ask who worked on a specific challenge, use "fetch-challenge-resources".

Building the search
- Put technologies, tools and domains into "skills", one per entry, as plain words ("node.js", "react js", "computer vision") — the tool maps them to Topcoder skills. Write abbreviations out in full first: "k8s" → "Kubernetes", "ML" → "machine learning", "LLM" → "large language models", "GCP" → "Google Cloud Platform". Never make up a skill id. If you already have skill ids from a tool result (a challenge's "skills" from "fetch-challenge-by-id", or "candidates" from an earlier search), pass those ids.
- Several skills: skillMatch "all" when the user needs one person with every skill ("React AND Node", "both"); otherwise leave the default "any", which still ranks members matching more skills higher. Ask only if the choice is unclear and changes the answer a lot.
- Skill search only finds members who have actually competed or submitted work with that skill on Topcoder, not members who merely list it on their profile. If the user asks about listed/self-declared skills, say that this search can't show those.
- Only add profile filters the user asked for or clearly implied: "available"/"can start now" → openToWork; "active"/"recent" → recentlyActive; "verified"/"can be paid" → verifiedProfile; "copilots" → copilot; a country or region → countries. Each extra filter silently removes people — suggest one after showing results instead of adding it unasked.
- preferredRoles is the role a member said they WANT, and only members who filled in open-to-work preferences have one. Use it for "people looking for Full-Stack roles", "who wants to work as a UX designer"; for "people who can do X", use skills. Pick codes from the list in the tool's description that fit the user's wording ("ML engineers looking for work" → AI_ML_ENGINEER), and use the role labels, not the codes, when talking to the user.
- Countries can be names or codes as the user says them. Regions ("Europe", "LATAM", "APAC") aren't countries: expand them into a list of countries and tell the user which you used. If "unrecognizedCountries" comes back, say those were left out.
- The tool refuses a search with no filters. If the request is too vague ("find me some good members"), ask what skills or kind of work they need.
- Staffing a challenge ("who could do this challenge?"): get it with "fetch-challenge-by-id", pass its "skills" ids, and ask whether they want only available (openToWork) members.

When the search didn't run ("searched": false)
- A skill with status "ambiguous": look at its "candidates". If one clearly fits what the user asked (e.g. "Salesforce developers" → "Salesforce Development (SFDC)"), call again with that candidate's id and tell the user which skill you used. If you can't tell, list the candidate names and ask which they mean. Never show skill ids to the user.
- Skills with status "unresolved" only: tell the user those aren't Topcoder skills and suggest a different wording or a close alternative. Don't say "no members found" — no search ran.
- No recognizable countries: say which weren't recognized and ask the user to rephrase them.

Reading the result
- If a skill was matched by "alias" or "semantic", say how you read it ("searched **Amazon Web Services (AWS)** for 'aws'"). If some skills were "unresolved" but the search still ran, say which were left out.
- Only "rankedBy": "matchIndex" is a best-first list. "handle" is alphabetical; "activity" is recently active and available members first. For those two, don't call anyone the "top" or "best" match. "matchIndex" mostly reflects how many of the requested skills a member has worked with; don't quote it as a percentage or win rate — describe strength with the "wins" and "submitted" numbers in "matchedSkills".
- If you set minWins, the search doesn't filter on it: only present members whose matched skills have "meetsMinWins": true as meeting the requirement; say how many on this page did, and that the others have activity in the skill but fewer wins.
- Present a short ranked list: linked handle, name, location, then what matters for this request — per-skill wins/submissions, and whichever of openToWork / isRecentlyActive / isVerified / isCopilot are relevant. Don't dump every field.
- Always give the total ("Showing 10 of 143 members"). When "hasMore" is true, offer more; for "show more", call again with the same "appliedFilters" (skills by id) and page + 1.
- No results: say which filters were applied and suggest relaxing the most likely culprit (skillMatch "all", profileComplete, a narrow country list, one of several skills). Retry with a relaxed filter only if the user agrees or it clearly wasn't what they asked.
- Too many loose matches: suggest a narrowing filter (openToWork, recentlyActive, a country, skillMatch "all").
- After a shortlist, offer "fetch-member-insights" for specific members (pass "handle" or "userId"); don't call it for every member unasked.
- Results include personal data (names, locations). Show only what the user needs; never invent details the tool didn't return.
```

### 8. Preferred roles constant (`src/config/member-search.config.ts`, new)

The role list changes independently of this code (requester), so it lives in one plain constant, following the repo's existing `src/config/*.config.ts` convention (`challenge-resource-roles.config.ts`, `tool-auth-fallback.config.ts`):

```ts
/**
 * Open-to-work preferred roles accepted by POST /v6/reports/member/search `preferredRoles`.
 * See docs/adr/0008-member-search-tool.md.
 *
 * Source of truth: platform-ui `preferredRoleOptions`
 * (src/libs/shared/lib/constants/index.ts) — the Talent Search "Preferred role" picker.
 * Upstream matches `value` exactly (upper-cased); a value it doesn't know returns no
 * members and no error, so keep this list in sync with the picker.
 *
 * To add, rename or remove a role, edit this list only: the search-members tool's input
 * enum, its description, and the labels in its output are all derived from it.
 */
export const MEMBER_SEARCH_PREFERRED_ROLES = [
    { value: 'AI_ML_ENGINEER', label: 'AI / ML Engineer' },
    { value: 'DATA_SCIENTIST_ENGINEER', label: 'Data Scientist / Data Engineer' },
    { value: 'CYBERSECURITY_ENGINEER', label: 'Cybersecurity Analyst / Security Engineer' },
    { value: 'CLOUD_ENGINEER', label: 'Cloud Engineer / Solutions Architect' },
    { value: 'DEVOPS_SRE', label: 'DevOps Engineer / SRE' },
    { value: 'FULL_STACK_DEVELOPER', label: 'Full-Stack Developer' },
    { value: 'QA_AUTOMATION_ENGINEER', label: 'QA Lead / Automation Engineer' },
    { value: 'UX_DESIGNER', label: 'UX Designer' },
    { value: 'TECHNICAL_PM', label: 'Technical Project Manager' },
    { value: 'DB_ADMIN', label: 'Database Administrator' },
    { value: 'AI_PROMPT_ENGINEER', label: 'AI Prompt Engineer' },
    { value: 'ENTERPRISE_ARCHITECT', label: 'Enterprise Architect' },
] as const satisfies readonly { value: string; label: string }[];
```

In the tool:

```ts
const preferredRoleValues = MEMBER_SEARCH_PREFERRED_ROLES.map((r) => r.value) as [string, ...string[]];
const preferredRoleEnum = z.enum(preferredRoleValues);
const preferredRoleLabel = new Map(MEMBER_SEARCH_PREFERRED_ROLES.map((r) => [r.value, r.label]));
```

Design points:
- **Codes only as input, labels for display.** The model picks from the enum; the description lists `CODE (Label)` pairs so it can map "machine learning engineers" or "SREs" to a code without a separate synonym table. An enum makes a stale or made-up code fail validation instead of silently returning nobody.
- **Adding a role is a one-line change** with no other edits. A unit test asserts the list is non-empty, codes are unique and upper-snake-case, and the input schema's enum equals the constant's values (catches someone hard-coding a value in the tool).
- **No env-var override.** The list is small and changes with a platform-ui release, not per environment; a code change keeps it reviewable. (If it starts changing often, the follow-up is fetching it at runtime from `GET /v6/reports/member/open-to-work` `roleCounts`, which only lists roles members have actually picked, so it's not a drop-in replacement.)

### 9. Implementation plan

- **Phase 0 — Remaining non-blocking checks**: `profileComplete` latency (Prerequisite 7); raise the `wins` question with the Reports API owners (Prerequisite 5).
- **Phase 1 — Skill resolver** (`skill-term-resolver.ts` + test). Use the probe tables above as fixtures, including the alphabetical fuzzy ordering. Cases: every row of Decision 1's worked-examples table; UUID `200` / `404` / transient error; fuzzy throws → semantic still tried; both throw → `unresolved`; `size: 20` sent to fuzzy; dedupe by id keeps max `minWins`; tier and shortest-name tie-breaks (`react.js` → React.js, not Flux (React.js)).
- **Phase 2 — Tool** (`member-search.config.ts`, `search-members-tool.ts` + tests; add `i18n-iso-countries` to `package.json`). Cases: refine rejects no-filter input; body mapping (`skillMatch`, `minWins → wins`, dropped `false`s, defaults); `preferredRoles` enum rejects unknown codes, output carries labels; preferred-roles constant test (Decision 8); countries: every value from Decision 2's checked list, alias map entries, unknown → `unrecognizedCountries`, all unknown → `searched: false` with no upstream call; `sortBy` only sent when set; `rankedBy` for all four rule branches; `sortOrder` defaults per `sortBy`; any ambiguous → `searched: false` and **no upstream call**; all unresolved → same; partial → search with resolved only; `meetsMinWins` / `minWinsEnforced` using Sample B as a fixture; `photoUrl`/`isVerified`-on-skill dropped, `id → userId`; `hasMore`; 400/401/403/404/5xx messages; **M2M service never called**. Samples A and B are the response fixtures.
- **Phase 3 — RBAC**: policy entry + `access-control.test.ts` case.
- **Phase 4 — Agent**: registration + instructions (Decision 7).
- **Phase 5 — Docs**: ADR 0004 inventory; this ADR → Accepted with implementation notes.
- **Phase 6 — Manual validation on dev** through the agent: "find React and Node.js developers open to work in the US" (alpha-2 country → `USA`), "who's looking for DevOps or cloud roles" (preferredRoles only → `rankedBy: 'activity'`), "find copilots in India who know React" (reproduces Sample B), "Salesforce developers" (ambiguous path), "k8s engineers" (abbreviation expansion), "xyzzy framework developers" (unresolved), "members with 3+ Python wins" (minWins annotation), "show more", and one prompt as a member with neither role (clean denial, no M2M log line).

## File-level mapping

| File | Change |
| --- | --- |
| `src/mastra/tools/skills/skill-term-resolver.ts` | **New** — skill resolution (Decision 1) |
| `src/mastra/tools/skills/skill-term-resolver.test.ts` | **New** |
| `src/config/member-search.config.ts` | **New** — `MEMBER_SEARCH_PREFERRED_ROLES` (Decision 8) |
| `src/config/member-search.config.test.ts` | **New** — list shape / uniqueness |
| `src/mastra/tools/member/search-members-tool.ts` | **New** — the tool (Decisions 2–5), incl. country conversion helper + alias map |
| `src/mastra/tools/member/search-members-tool.test.ts` | **New** — Samples A/B as fixtures |
| `package.json` / `pnpm-lock.yaml` | Add `i18n-iso-countries` (same library as `reports-api-v6`) |
| `src/config/access-control.config.ts` | `search-members` restricted policy (Decision 6) |
| `src/utils/auth/access-control.test.ts` | Policy-resolution case |
| `src/config/tool-auth-fallback.config.ts` | **Unchanged — intentionally no entry** (Decision 5) |
| `src/mastra/agents/challenge/challenge-search-agent.ts` | Register tool; instructions (Decision 7) |
| `docs/adr/0004-role-based-access-for-agents-workflows-tools.md` | Resource inventory rows |
| `.env.sample` | No new vars — reuses `TC_API_BASE`, `SKILL_MATCHING_SEMANTIC_THRESHOLD` |

## Consequences

**Positive**
- Talent Managers and admins run portal-grade searches in plain words, and chain into `fetch-member-insights` or start from a challenge's skills.
- Skill mapping is deterministic and tested against real lookup behaviour, not assumed behaviour; the common forms (`react`, `reactjs`, `react js`, `aws`, `sfdc`, `node`) resolve correctly without guessing.
- Ambiguity and unknown skills are explicit outcomes, so the agent never presents a search for the wrong skill, or for no skill, as the answer.
- No new privilege path: the caller's own token and upstream's role check decide access.
- The upstream `wins` gap is surfaced to the agent per member rather than hidden.

**Negative / trade-offs**
- Up to three skill lookups per term (id or fuzzy, then semantic) before the search; concurrent and small, but adds latency.
- The `ambiguous` outcome costs an extra tool round-trip (and sometimes a question to the user) for broad terms like "salesforce". Accepted: the alternative is a confidently wrong search.
- Abbreviation handling for terms neither lookup knows (`k8s`, `llm`) depends on the model expanding them per the instructions.
- The `js` key is a naming-convention heuristic; it could match an unrelated `<term>JS` library for some term. It only applies when no `full`/`paren` match exists, and the result is reported as `alias`.
- With a `minWins` request, pages can contain members who don't meet it (upstream counts any submission as qualifying); the agent leaves them out of its answer, so a page of 10 may present fewer.
- The preferred-roles constant is a copy of platform-ui's list; if platform-ui adds a role and this constant isn't updated, the agent simply can't search for that role (it can't send a wrong one). Keeping them in sync is a manual step.
- One new runtime dependency (`i18n-iso-countries`), chosen because upstream uses the same library for the same codes.

## Review questions — resolved (2026-09-24)

All confirmed by the requester as proposed:

1. **Skill resolution** — Decision 1 as written: exact/alias match via fuzzy, then semantic, then `ambiguous` with candidates (search not run; the agent picks the obvious candidate itself or asks the user). This replaces revision 1's "take the top fuzzy result".
2. **`minWins`** — kept, with the per-member `meetsMinWins` annotation and `minWinsEnforced: false` (Decisions 3–4, 7).
3. **Country conversion** — `i18n-iso-countries` dependency plus the small alias map (Decision 2).

## Prerequisites

| # | Item | Status |
| --- | --- | --- |
| 1 | Response shape and behaviour of member search | **Done** — Samples A and B (Context). |
| 2 | `200` for both a real `administrator` JWT and a real `Talent Manager` JWT | **Done** — confirmed by the requester (2026-09-24). Decision 5 (requestor JWT only, no M2M) holds for both roles. |
| 3 | Upstream `404` body for an unknown skill id | **No longer blocking** — the tool validates ids first via the skills API (Decision 1). |
| 4 | `matchIndex` / ordering without skills | **Done** — formula and ordering rules read from the upstream source; match Samples A and B. |
| 5 | `skills[].wins` semantics | **Behaviour known; intent open** — a skill counts when `wins >= minWins OR submitted > 0` (source), so `minWins` has no practical effect. Ask the Reports API owners whether that's intended; the tool's `meetsMinWins` annotation works either way. |
| 6 | `preferredRoles` value set | **Done** — 12 roles from platform-ui's picker (requester's screenshot + source), in `MEMBER_SEARCH_PREFERRED_ROLES` (Decision 8). |
| 6a | `countries` format | **Done** — ISO alpha-3 or stored name (source); the tool converts (Decision 2). |
| 7 | Latency of `profileComplete: true` on a broad search | **Open** — check during Phase 0; decides whether the "slowest filter" note is enough. |
