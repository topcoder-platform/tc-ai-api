# ADR 0009 — System One (`sys1`): provider-agnostic decision tool, exposed to services through a tracked workflow

- **Status:** **Accepted — implemented** (2026-10-05) on `sys1`; see *Implementation notes* at the end. Live verification against a real Ollama ≥ 0.35 (plan step 6) is still open.
- **Date:** 2026-10-05
- **Target branch:** `sys1`
- **Related:** [ADR 0004](0004-role-based-access-for-agents-workflows-tools.md) (agent/workflow/tool RBAC layer — this ADR adds a policy and **corrects two of its claims**, see Decision 6), [ADR 0008](0008-member-search-tool.md) (layout and "schema is the agent's manual" precedent), `src/mastra/workflows/challenge/challenge-ingestion-workflow.ts` (existing service-triggered workflow pattern), `src/utils/providers/model-factory.ts` (existing chat-model provider switch — deliberately *not* reused, see Decision 1), `src/utils/providers/ollama.ts`

## Revision 2 — what changed (2026-10-05)

The requester added a requirement: **services must trigger System One through a Mastra workflow, not the tool**, because a workflow run is persisted (input, every step's input/output/timing/error, final result, caller identity) and the tool route records nothing. Mastra's run model and behaviour were read from the installed version's embedded docs (`@mastra/core` 1.74.0 `dist/docs`, per the repo's `mastra` skill) and verified with local probes (Context → *Workflow runs*).

1. **New Decision 7 — workflow `system-one`** (validate → evaluate), the only service entry point: `POST /v6/ai/workflows/system-one/start-async`.
2. **The tool is no longer registered on the Mastra instance**, so `/v6/ai/tools/system-one/execute` returns `404`. This **supersedes** revision 1's confirmed decision "HTTP surface: Mastra tool route only". The tool remains the unit of logic (the workflow calls it) and the future agent-facing interface.
3. **Images are recorded as `{ sha256, bytes }`** in run snapshots via `pruneSnapshot`, not as base64.
4. **The workflow does its own input validation** (`validateInputs: false` + a first `validate-request` step), so invalid requests become *recorded failed runs* instead of an unrecorded HTTP 500.
5. RBAC gains a **workflow policy** (same roles/scopes) and a `TARGET_ID_ALIASES` entry; Decisions 5, 6 and the example are rewritten for the workflow surface.
6. Run-record **retention is a follow-up**, not part of this ADR.
7. **Tracking = run snapshots**; enabling Mastra observability/tracing is a separate follow-up ADR (W7).
8. Two Mastra behaviours found by probing are designed around: in-place snapshot redaction corrupts the live run (W2 → deep copy), and a reused `runId` overwrites another caller's record (W8 → `onStart` gate, `409`).

## Context

"System One" is Ollama's typed-decision API: instead of generating text, a small local *decision model* (Nimble, Tev1, Clef, Clef Flash) scores a fixed set of candidate answers and returns **probabilities**. It answers three question shapes — pick one of N labels (`choice`), yes/no (`noul`), and position on an ordered rubric (`score`) — in one cheap, deterministic-shaped, non-streaming call.

That is a capability this service does not have today. Every classification, triage, or rubric judgement in `tc-ai-api` currently costs a full chat-model generation plus structured-output parsing (`src/utils/structured-output-wrapper.ts`), and returns a single answer with no calibrated alternative. System One returns the whole distribution, so a caller can threshold, abstain, or escalate on low confidence.

The request is to expose it as **one tool** that:

1. is usable by agents (Mastra tool) **and** callable by other services over HTTP — services through a **workflow**, so every call is tracked (revision 2);
2. is restricted to the `administrator` member role and to M2M tokens carrying the `sys1:use` scope;
3. sits behind a provider wrapper, Ollama first and default, so the backend can change without changing callers;
4. takes Ollama's System One request as its input and returns its response as its output, with extensions only where the goals above need them (the *compatibility layer*);
5. has schemas descriptive enough that an agent can use it correctly from the schema alone.

### Upstream contract (Ollama `POST /v1/systemone`, read 2026-10-05)

Sources: `https://docs.ollama.com/api/systemone.md` (embeds the OpenAPI operation verbatim) and `https://docs.ollama.com/capabilities/decision.md`. **Requires Ollama v0.35.0+; Clef/Clef Flash (images) require v0.35.1+.** Local models only — cloud models are rejected with `400`.

Request `SystemOneRequest` (required: `model`, `state`, `questions`):

| Field | Type | Semantics |
| --- | --- | --- |
| `model` | string, non-blank | A local System One model, e.g. `nimble`. GGUF weights + scoring-capable runner; cloud and MLX/Safetensors not supported. |
| `state` | `SystemOneContent` | The shared input every question is asked about. A non-blank string, or an object/array that is serialized as JSON text. Not chat messages, not multimodal. |
| `images` | `string[]` (base64, `format: byte`) | Shared by all questions, in order. PNG/JPEG/WebP. **Clef / Clef Flash only.** URLs and data URLs rejected. `state` is still required. |
| `questions` | object, 1–64 entries | Named questions about `state`. **Answers are not passed to later questions** — each is evaluated independently against `state` (+ `images`). |
| `keep_alive` | string \| number | How long to keep the model loaded (`"5m"`, seconds; `0` unloads; negative keeps forever). Default = server setting. |

Question variants (discriminated on `type`; `instructions` is `SystemOneContent` in all three):

| `type` | `criteria` | Notes |
| --- | --- | --- |
| `choice` | **required** object, 2–26 entries: `optionKey → description \| null` | `null` uses the key itself as the description. Ties follow option order. |
| `noul` | optional `{ "false"?: string, "true"?: string }`, no other keys | Defaults `"No"` / `"Yes"`. |
| `score` | **required** array of 2–26 strings | Ordered **lowest (index 0) to highest**. Defines a 0…N-1 scale. |

Response `SystemOneResponse`: `{ model, answers: { [questionName]: Answer }, usage: { input_tokens, output_tokens } }`.

| Answer `type` | Fields | Semantics |
| --- | --- | --- |
| `choice` | `choice`, `probabilities`, `confidence` | `choice` = argmax key; `probabilities` keyed by option key, sum ≈ 1. |
| `noul` | `noul` | **P(true)** in [0,1]. A number, not a boolean. No `confidence`. |
| `score` | `score`, `legend`, `probabilities`, `confidence` | `score` = Σ index × P(index), in [0, N-1] — **not rounded, not normalized to 0–1**. `legend` and `probabilities` keyed by zero-based index *as strings*. |

`confidence` = `1 − H(p)/ln(N)`: 0 = uniform, ~1 = one candidate dominates. Upstream is explicit that it is **not calibrated correctness**.

Limits and errors: request ≤ **64 KiB** without images, ≤ **32 MiB** with images (incl. base64 + JSON); the whole input must fit the loaded context and is **never truncated**. `400` invalid request / unsupported model / prompt exceeds context; `404` model not pulled; `413` size; `500` load/render/score failure. Error body `{ "error": string }`. No streaming, tools, or generation controls.

### How this repo exposes tools over HTTP today (read from `@mastra/server` 1.74.0, 2026-10-05)

Mastra mounts `POST /v6/ai/tools/:toolId/execute`, body `{ "data": <tool input>, "requestContext"?: {...} }`, `requiresAuth: true`. The handler resolves the tool by `.id` from (1) server-registered tools, (2) `mastra.getToolById()` — i.e. `new Mastra({ tools })`, then (3) **`findToolInAgents()` — any tool attached to any registered agent**. It calls `tool.execute(data, { mastra, requestContext, ... })` with the server `RequestContext`, so `withAccessPolicy` sees the authenticated `user`. It returns the tool's result as the JSON body; a thrown error becomes `HTTPException(error.status ?? 500)`.

Findings that matter for this ADR:

- **F1. Agent-attached tools are already HTTP-executable.** `/v6/ai/tools/search-members/execute` resolves today via `findToolInAgents`. ADR 0004 and the comment on `TARGET_ID_ALIASES.tool` ("Tools are never addressed by URL") are wrong. RBAC still holds because the guard is inside `execute` (`withAccessPolicy`) — but nothing in `authorizeAccessPolicy`'s `parseTarget()` recognises `/tools/` paths.
- **F2. Tool denials surface as HTTP 500.** `ToolAccessDeniedError` has no `.status`, so `handleError` maps it to `500 { "error": "Access denied for tool \"…\"" }`. Correct outcome, wrong status for a service caller.
- **F3. Input-schema failures surface as HTTP 200.** Mastra's `validateToolInput` *returns* `{ error: true, message, validationErrors }` instead of throwing, so the route answers `200` with that body. The access guard wraps the validating `execute`, so a denied caller gets 403/500 before any schema detail is revealed.
- **F4. Request-body `requestContext.user` is not a reserved key.** `mergeRequestContext` drops only `mastra__*`/`organizationId`; plain `user` from the body lands in the context first. Middleware order is: context merge → `resourceIdMiddleware` (which trusts a present `user` and skips verification) → per-route `checkRouteAuth`, which unconditionally overwrites `user` **and** `mastra__resourceId` from the verified JWT. Net effect today: the tool sees the verified user — **safe, but only by ordering**. Pinned with a regression test (Decision 6).
- **F5. Default body limit is 4.5 MB** (`server.bodySizeLimit ?? 4.5 * 1024 * 1024` in `@mastra/deployer`), below Ollama's 32 MiB image ceiling. Base64 inflates ~33%, so ~3.3 MB of raw image per request is the effective cap — kept as is (*Decisions confirmed* 5).

### Workflow runs (`@mastra/core` / `@mastra/server` 1.74.0 — embedded docs + local probes, 2026-10-05)

- **W1. Runs are persisted in full by default.** `WorkflowOptions.pruneSnapshot` docs: *"user workflows persist full snapshots by default"*. The snapshot (Postgres `workflow_snapshots`, schema `MASTRA_DB_SCHEMA`) holds `runId`, `status`, `context.input`, per step `{ payload, output | error, startedAt, endedAt, status }`, `result`, and `requestContext`. Probe (LibSQL in-memory, successful run): the snapshot contained the input, the step payload, `resourceId` and the caller's `user` / `mastra__user` claims; **`mastra__authToken` (the raw bearer token) was not persisted**. Base64 images appear **twice or more** — in `context.input` and in every step `payload` that carries them.
- **W2. `pruneSnapshot` runs on every persist, including mid-run, and the snapshot shares references with the live run.** Probe (two steps, hook fired 6× for one run): a hook that rewrote `images` **in place** made step 2 receive `{sha256}` instead of the base64 — the live run was corrupted. The same hook operating on a `structuredClone` left step 2 with the real image and stored only hashes.
- **W3. `validateInputs` defaults to `true`**, and an invalid start input **throws** (`Invalid input data: …`, no `.status`) → `start-async` answers **HTTP 500** and the run outcome is never recorded. With `validateInputs: false`, nothing validates the input at all — a malformed input reaches the steps unchecked (probe).
- **W4. Step failures do not fail the HTTP call.** A step that throws `Object.assign(new Error('[SYS1_TIMEOUT] …'), { status: 504 })` produces `{ status: 'failed', error: { message, name, status: 504 } }` — `.status` and the message prefix survive — and `start-async` answers **HTTP 200**. The result envelope is `{ status, steps, input, stepExecutionPath, result | error, runId, traceId, spanId }`.
- **W5. Runs are owned by the caller.** `start-async`/`create-run` force `resourceId` from the authenticated context (`getEffectiveResourceId`) — userId for members, `sub` for M2M. `GET …/runs` lists only the caller's runs; `GET …/runs/:runId` and `DELETE` call `validateRunOwnership`. An administrator cannot read a service's runs through the API — Studio or the database can.
- **W6. `createStep(tool)` forwards `requestContext` and `abortSignal`** to `tool.execute` (`runToolEntry`), so `withAccessPolicy` runs inside a step exactly as over HTTP. But a tool's input-validation failure is a *returned* `{ error: true }` (F3), which a workflow without output validation would record as a **successful** step.
- **W7. No tracing exporter is configured.** `src/mastra/index.ts` sets no `observability` and no other file does (repo-wide search for `@opentelemetry|Observability(|DefaultExporter|instrumentation` hits only `README.md` and the unused `package.json` deps — the README's "OpenTelemetry via `@mastra/observability`" is stale), so `traceId`/`spanId` in results correlate to nothing today. **The run snapshot is the tracking record.**
- **W8. A reused `runId` overwrites another caller's record.** `start-async` calls `createRun({ runId, resourceId })` with no ownership check (only read/delete/`/start` check it). Probe: run `X` by A, then `start` with `runId: X` by B → the stored record became B's (`resourceId`, input, result). `createRun` alone did **not** clobber it; the overwrite happens on `start`. An `onStart` hook that loads the existing run and throws `{ status: 409 }` blocked B and left A's record intact (probe).

### Why this matters for design

- Services call a **workflow**, so "Ollama-compatible" means **`inputData`** is the Ollama body and **`result`** is the Ollama response; the URL and envelope are Mastra's (*Decisions confirmed* 1).
- W3/W4/W6 together mean the workflow must validate inside a step and turn every tool failure into a *thrown* error, or tracking records misleading outcomes.
- System One output is probabilities over **caller-defined** labels. An agent that writes vague criteria, splits context across questions, or reads `score` as 0–1 will get confidently wrong results. The schema descriptions must teach this — they are the only manual the model reads.
- `ai-sdk-ollama` / `createModel()` are chat-model factories; `/v1/systemone` is not a chat endpoint. The provider wrapper is a new, narrow interface.

## Scope

In scope:

- A provider-neutral System One contract (Zod), a `SystemOneProvider` interface, and an Ollama implementation.
- One tool, `system-one` — the unit of logic and the future agent interface, **not** registered on the Mastra instance (no direct HTTP route).
- One workflow, `system-one` — the **only service entry point**, persisted per run, images hashed.
- RBAC policy `administrator` / `sys1:use` on both the workflow and the tool, plus the ADR 0004 corrections C1–C3.
- Config via env, error→HTTP-status mapping, logging/usage.

Out of scope:

- Wiring the tool into any agent (*Decisions confirmed* 4) — follow-up ADRs.
- A custom Ollama-shaped route (`/v6/ai-api/sys1`) — rejected (*Decisions confirmed* 1).
- Run-record retention / `storage.prune()` scheduling (*Decisions confirmed* 11) — follow-up; it applies to every workflow.
- An admin-wide audit API over other callers' runs (W5) — follow-up if Studio/DB access is not enough.
- Enabling Mastra observability / a tracing exporter (W7, *Decisions confirmed* 12) — own ADR.
- A second provider implementation — the interface is designed for one; none is built.
- Fixing `resourceIdMiddleware`'s trust of an unverified body `user` (F4) — its `resourceId` is overwritten by verified auth today; tracked as a follow-up.

## Decisions confirmed (2026-10-05)

1. **HTTP surface: the `system-one` workflow only** *(revision 2 — supersedes "Mastra tool route only")*. `POST /v6/ai/workflows/system-one/start-async` with `{ "inputData": <SystemOneRequest> }`. The tool is not registered on Mastra, so the direct tool route `404`s. No custom route.
2. **Model choice: server allowlist.** `model` is optional (defaults to `SYS1_MODEL`); a caller-supplied model must be in `SYS1_ALLOWED_MODELS`. Provider is server-config only (`SYS1_PROVIDER`), never a request field.
3. **Images: accepted everywhere** — in the workflow input and in the agent-facing tool schema.
4. **No agent wiring in this ADR.**
5. **Body limit stays at Mastra's 4.5 MB default** — images capped at ~3.3 MB raw per request; revisit with a real image use case (F5).
6. **Answers are returned verbatim** — no derived fields; interpretation lives in the schema descriptions, thresholds with the caller.
7. **`keep_alive` is server-only** — stripped from input, set by `SYS1_KEEP_ALIVE`.
8. **Harden `withAccessPolicy` in this ADR** — read the reserved, non-injectable `mastra__user` key first, fall back to `user` (Decision 6, C3).
9. **Services use the workflow for full tracking** *(revision 2)* — every call is a persisted run (Decision 7).
10. **Images are recorded as `{ sha256, bytes }`** in run snapshots, never as base64 *(revision 2)*.
11. **Retention is a follow-up** *(revision 2)* — run records (incl. `state`) are kept indefinitely until a repo-wide retention policy lands.
12. **Tracking is the run snapshot** *(revision 2)* — Mastra observability/tracing stays off; enabling it repo-wide is its own ADR.
13. **Base URL: `OLLAMA_API_URL` by default, `SYS1_OLLAMA_BASE_URL` overrides it when set** *(revision 2)* (Decision 2).

## Decision

### 1. Provider abstraction (`src/utils/providers/system-one/`, new)

```ts
// types.ts — the canonical contract (Zod), shared by the tool and every provider.
export type SystemOneProviderRequest  = SystemOneRequest & { model: string };   // model resolved
export type SystemOneProviderResponse = SystemOneResponse;                      // Ollama shape, verbatim

// provider.ts
export interface SystemOneProvider {
    /** Stable id surfaced in tool output and logs, e.g. 'ollama'. */
    readonly name: SystemOneProviderName;
    evaluate(req: SystemOneProviderRequest, opts: { signal: AbortSignal }): Promise<SystemOneProviderResponse>;
}
export type SystemOneProviderName = 'ollama';
```

- **The canonical contract is Ollama's schema, verbatim** (including the name `noul`). It is the published, versioned spec we were asked to match; inventing a neutral dialect now would add a translation layer with one implementation and no second consumer to validate it against. A future provider adapts *to* this contract inside its own `evaluate()`.
- `providers/ollama.ts` — `OllamaSystemOneProvider`: `fetch(POST {baseUrl}/v1/systemone)`, JSON body, `AbortSignal.timeout(SYS1_TIMEOUT_MS)` merged with the caller's signal, parses the response with the **same Zod response schema** (provider contract drift → `502`, not a silent pass-through). `keep_alive` is set from config, never from the caller (Decision 3).
- `index.ts` — `getSystemOneProvider()`: memoised switch on `SYS1_PROVIDER` (default `ollama`); unknown value throws an actionable error on first use (never at import — mirrors `getRagConfig()`).
- **Not** added to `createModel()`/`SupportedProvider`: those return AI-SDK `LanguageModel`s; System One is a scoring RPC, not a chat model.

### 2. Configuration (`src/config/system-one.config.ts`, new)

Lazy, memoised `getSystemOneConfig()` (+ `_resetSystemOneConfigCache()` for tests):

| Env var | Default | Notes |
| --- | --- | --- |
| `SYS1_PROVIDER` | `ollama` | Only `ollama` accepted in v1. |
| `SYS1_OLLAMA_BASE_URL` | **`OLLAMA_API_URL`** | **Optional override.** By default System One uses the same Ollama host as the chat models (`OLLAMA_API_URL`); when `SYS1_OLLAMA_BASE_URL` is set it takes precedence, e.g. to point System One at a dedicated host. Resolution: `SYS1_OLLAMA_BASE_URL \|\| OLLAMA_API_URL`. The env var is read directly — the hard-coded *dev* host fallback inside `ollama.ts` is **not** inherited, so a prod deploy can't silently score against dev. Both unset ⇒ `503 SYS1_NOT_CONFIGURED`. |
| `SYS1_MODEL` | `nimble` | Default when the request omits `model`. |
| `SYS1_ALLOWED_MODELS` | `= SYS1_MODEL` | Comma list. `SYS1_MODEL` is always implicitly allowed. Add `clef-flash`/`clef` to enable image judging. |
| `SYS1_TIMEOUT_MS` | `30000` | Per provider call. |
| `SYS1_KEEP_ALIVE` | unset (server default, 5m) | Passed through as `keep_alive`. |

The allowlist is read at tool-module load **only to build the description text** (so the agent sees the real model list); enforcement re-reads config at execute time.

### 3. Tool input schema — the compatibility layer, input side

`src/mastra/tools/system-one/system-one-tool.ts`, `id: 'system-one'`. The input is `SystemOneRequest` with exactly these deviations:

| Field | vs. Ollama | Why |
| --- | --- | --- |
| `model` | **optional**; must be in `SYS1_ALLOWED_MODELS` | *Decisions confirmed* 2. Omitted ⇒ `SYS1_MODEL`. |
| `keep_alive` | **not accepted** (stripped if sent) | Model residency is a shared-infrastructure decision (a negative value pins a model in GPU memory forever). Server-controlled via `SYS1_KEEP_ALIVE` (*Decisions confirmed* 7). |
| everything else | identical, incl. bounds | `state`, `images`, `questions` (1–64), `choice` 2–26, `score` 2–26, `noul` `{false?, true?}` strict. |

Zod notes: question/answer unions are `z.discriminatedUnion('type', …)`; `questions` and `choice.criteria` are `z.record(...)` with `.refine` on key count and non-blank keys (Zod has no `minProperties`); `SystemOneContent = z.union([nonBlankString, z.record(z.string(), z.unknown()), z.array(z.unknown())])`. Bounds are enforced locally so a bad call fails at our boundary with a field path (F3), not as an opaque upstream `400`.

**Descriptions (what the model sees).** These are part of the decision, not decoration — draft text:

> **Tool description** — *Ask a small decision model to answer one or more classification, yes/no, or rubric-scoring questions about a single input, and get back probabilities rather than generated text. Use it to label, triage, filter, or grade content when the possible answers can be listed in advance. Do NOT use it to generate text, extract values, summarise, or answer open questions — it can only pick among the options you define. Put ALL the content being judged in `state` — every question sees `state` (and `images`) but never sees other questions or their answers, so do not write a question that depends on another's result. Batch every question about the same `state` into ONE call (up to 64). Write criteria as short, mutually exclusive, concrete descriptions; the model's accuracy depends on them. Results are probabilities: report the winning answer with its probability/confidence, and treat low confidence (< ~0.5) or near-tie probabilities as "uncertain" rather than as a firm answer.*

> **`state`** — *The content being judged: a non-empty string, or a JSON object/array (serialized to text). Include everything the questions need — questions cannot see each other. Not chat messages. Max ~64 KiB total request without images.*

> **`images`** — *Optional base64-encoded PNG/JPEG/WebP images (raw base64 — no `data:` prefix, no URLs), shared by all questions. Only image-capable models accept them ({list from config, e.g. clef-flash}); set `model` accordingly. `state` is still required and should say what the images are.*

> **`model`** — *Optional. One of: {allowed list}. Omit to use {default}. {If a vision model is allowed: "Use {vision model} when sending images."}*

> **`questions`** — *Map of your own question names (e.g. `"is_spam"`, `"priority"`) to question definitions; 1–64 entries. Answers come back under the same names. Each question is answered independently against `state`.*

> **`type: "choice"`** — *Pick exactly one of 2–26 named options. `criteria` maps option key → description (e.g. `{"bug":"Software errors","billing":"Payments and refunds"}`); null description = use the key. Include an `"other"`/`"none"` option when the input may fit none of them — the model must otherwise pick one.*

> **`type: "noul"`** — *Yes/no. Returns the probability that the answer is yes (true). Optional `criteria: {"false": "...", "true": "..."}` sharpens what yes and no mean (defaults "No"/"Yes"). Phrase `instructions` as a yes/no question.*

> **`type: "score"`** — *Place the input on an ordered scale. `criteria` is an array of 2–26 level descriptions ordered from LOWEST (index 0) to HIGHEST. Returns a weighted average index in [0, N-1] — e.g. 1.7 on a 0–2 scale — not a 0–1 or 0–100 value.*

> **`instructions`** — *The question, phrased for this type (e.g. "Which label fits this ticket?"). A string, or a JSON object/array.*

### 4. Tool output schema — the compatibility layer, output side

Output = `SystemOneResponse` **verbatim** plus one envelope field:

```ts
{
  provider: 'ollama',        // extension: which backend answered (Decision 1)
  model: string,             // the RESOLVED model (default applied), as returned upstream
  answers: Record<string, ChoiceAnswer | NoulAnswer | ScoreAnswer>,  // unchanged
  usage: { input_tokens: number; output_tokens: number },            // unchanged
}
```

Output-field descriptions carry the interpretation rules, so an agent reading the result (or a developer reading the OpenAPI) gets them without the docs: `noul` = P(yes), a number not a boolean; `score` = weighted index in [0, N-1], use `legend` to name the levels; `probabilities` for `score` are keyed by **string** indices; `confidence` = concentration of the distribution, **not** accuracy; `usage.output_tokens` is internal scoring work, not response length.

Answers are not enriched (no derived `level`, boolean, or threshold) — any threshold is a policy choice that belongs to the caller (*Decisions confirmed* 6).

### 5. Execution and error mapping

`execute(input)`:

1. Resolve config; base URL = `SYS1_OLLAMA_BASE_URL || OLLAMA_API_URL`; `503 SYS1_NOT_CONFIGURED` if neither is set.
2. Resolve `model` (default / allowlist) — `400 SYS1_MODEL_NOT_ALLOWED`, message lists allowed models.
3. Strip `keep_alive`; apply `SYS1_KEEP_ALIVE`.
4. Size pre-check on the serialized body: > 64 KiB without images or > 32 MiB with images ⇒ `413 SYS1_REQUEST_TOO_LARGE` (mirrors upstream; saves a round-trip). Mastra's 4.5 MB body limit (F5) applies first over HTTP.
5. `provider.evaluate(...)`; log `{ provider, model, questionCount, hasImages, usage, latencyMs }` at info — **never** `state`, `instructions`, or images (may be member PII/content).

Errors are thrown as `SystemOneError extends Error { status, code }`. Verified 2026-10-05: an error thrown inside a `createTool` `execute` propagates out of the Tool's validating wrapper with `.status` intact (only *validation* failures are returned as values), and `handleError` → `HTTPException(status)` → the deployer's `errorHandler` answers `{ "error": err.message }` with that status. The body carries **only the message**, so the code is prefixed into it — `"[SYS1_TIMEOUT] System One provider did not respond within 30000 ms"` — giving services a stable token to match and agents a readable error:

| Condition | HTTP | `code` |
| --- | --- | --- |
| Input schema violation | **200** `{error:true, validationErrors}` (Mastra behaviour, F3) | — |
| Access denied | **403** (after Decision 6 fix) | — |
| Model not in allowlist | 400 | `SYS1_MODEL_NOT_ALLOWED` |
| Local size pre-check | 413 | `SYS1_REQUEST_TOO_LARGE` |
| Upstream `400` (bad request, context overflow, image to non-vision model) | 400 | `SYS1_INVALID_REQUEST` (upstream `error` text passed through) |
| Upstream `404` (allowed model not pulled) | **503** | `SYS1_MODEL_UNAVAILABLE` — an ops fault, not the caller's |
| Upstream `413` | 413 | `SYS1_REQUEST_TOO_LARGE` |
| Upstream `5xx` / response fails schema | 502 | `SYS1_UPSTREAM_ERROR` |
| Network error / connection refused | 503 | `SYS1_PROVIDER_UNAVAILABLE` |
| Timeout | 504 | `SYS1_TIMEOUT` |
| Neither `SYS1_OLLAMA_BASE_URL` nor `OLLAMA_API_URL` set | 503 | `SYS1_NOT_CONFIGURED` |

No retries: a scoring call is cheap to repeat and the caller owns that choice; a retry on context-overflow or 4xx would be wrong.

The *HTTP* column applies wherever the tool's error reaches an HTTP handler directly. **Through the workflow (the service path) the same errors arrive as HTTP `200` with `{ status: "failed", error: { message: "[SYS1_…] …", status } }`** (W4) — services branch on `status`, then on the `[SYS1_…]` prefix or `error.status`. Decision 7 lists the workflow's own HTTP-level outcomes.

### 6. RBAC (ADR 0004) — policies, two corrections, one hardening

**Policies** — the same rule in two categories:

```ts
// DEFAULT_ACCESS_POLICIES.workflow — gates every /v6/ai/workflows/system-one/* route
// (start-async, start, stream, create-run, runs, runs/:runId, …) at the auth hook → 403.
'system-one': { mode: 'restricted', roles: ['administrator'], scopes: ['sys1:use'] },

// DEFAULT_ACCESS_POLICIES.tool — the in-execute guard; runs again inside the workflow's
// evaluate step (W6), and is the gate for any future agent that gets the tool.
'system-one': { mode: 'restricted', roles: ['administrator'], scopes: ['sys1:use'] },
```

Plus `TARGET_ID_ALIASES.workflow.systemOneWorkflow = 'system-one'` (registry key ≠ `.id`; ADR 0004 C1 — without it `/workflows/systemOneWorkflow/start-async` bypasses the policy). Env overrides: `ACCESS_POLICY_WORKFLOW_SYSTEM_ONE_*` and `ACCESS_POLICY_TOOL_SYSTEM_ONE_*`. **Overriding one without the other is a trap:** widening only the workflow policy yields runs that start and then fail in `evaluate` with `Access denied for tool "system-one"` — recorded, but confusing. Document both together. `DISABLE_AUTH=true` bypasses both.

**Registration** — `new Mastra({ workflows: { …, systemOneWorkflow } })`. The tool is **not** added to `new Mastra({ tools })` and no agent has it, so `/v6/ai/tools/system-one/execute` resolves nothing and returns `404` (*Decisions confirmed* 1). **A test asserts the tool is unreachable** (unit-level: not resolvable via `getToolById`, not on any registered agent): the day an agent is given this tool, `findToolInAgents` makes it HTTP-executable again (F1) — untracked — and the failing test forces that ADR to decide (e.g. a tool-path deny in `parseTarget`).

**Correction C1 (F1) — tools *are* URL-addressable.** Add `TOOL_PATH_RE = ^${API_PREFIX}/tools/([^/]+)` to `parseTarget()` → `{ category: 'tool' }`. This gives every restricted tool an early, cheap `403` at the auth hook (before body handling), in addition to the in-`execute` guard. `/agents/:agentId/tools/:toolId/execute` is still matched as an *agent* path first — the in-`execute` guard covers the tool there. Fix the `TARGET_ID_ALIASES.tool` comment and add an *Implementation note* to ADR 0004 pointing here.

**Correction C2 (F2) — denials return 403, not 500.** `ToolAccessDeniedError` gains `readonly status = 403`. This changes the HTTP status for **every** restricted tool reached over HTTP (500 → 403); in-agent behaviour is unchanged (still a thrown tool error). Existing access-control tests assert the error type, not a status — extend them.

**Hardening C3 (F4) — read the identity from a key the body cannot set.** `withAccessPolicy` resolves the caller as `requestContext.get('mastra__user') ?? requestContext.get('user')`. `mastra__user` (`MASTRA_USER_KEY`, `@mastra/server` constants) is in `RESERVED_CONTEXT_KEYS`, so `mergeRequestContext` never copies it from a body or query; Mastra sets it only from the verified token, alongside `user`. The `user` fallback keeps in-process callers (workflow steps, tests) that populate only `user` working. Applies to every tool. Import the constant if `@mastra/core` exports it; otherwise a local constant with a test asserting it matches the string the auth middleware writes.

**Regression test (F4).** Member token with no roles + body `requestContext: { user: { <rolesClaim>: ['administrator'] } }` → denied. Implemented unit-level (no HTTP harness exists): `withAccessPolicy` with `user` spoofed to admin and `mastra__user` clean must deny. With C3 this holds independent of middleware order; the test also guards against a Mastra upgrade that stops writing `mastra__user`.

### 7. Workflow `system-one` — the tracked service entry point (`src/mastra/workflows/system-one/system-one-workflow.ts`, new)

```ts
export const systemOneWorkflow = createWorkflow({
    id: 'system-one',
    description: '<the tool description from Decision 3, plus: "Each call is recorded as a workflow run.">',
    inputSchema: systemOneInputSchema,          // Decision 3 — published by GET /v6/ai/workflows/system-one
    outputSchema: systemOneOutputSchema,        // Decision 4
    options: {
        validateInputs: false,                  // W3 — validation happens in a recorded step instead
        autoRestartActiveRuns: false,           // see below
        pruneSnapshot: redactSystemOneImages,   // W1/W2 — Decisions confirmed 10; MUST deep-copy
        onStart: rejectRunIdReuse,              // W8
    },
})
    .then(validateRequestStep)                  // 'validate-request'
    .then(evaluateStep)                         // 'evaluate'
    .commit();
```

**Step `validate-request`** — `systemOneInputSchema.safeParse(inputData)`; on failure throws `SystemOneError(400, 'SYS1_INVALID_INPUT')` whose message lists each issue path (`questions.label.criteria: must have 2–26 options`). Then runs the shared `resolveSystemOneRequest()` (default/allowlisted `model`, strip `keep_alive`, size pre-check — the same function the tool's `execute` uses, so the two can't drift). Output: the **resolved** request — the run record therefore shows the effective model, not just what the caller sent.

**Step `evaluate`** — a plain `createStep` (not `createStep(systemOneTool)`) that calls `systemOneTool.execute(resolved, { mastra, requestContext, abortSignal })` and **throws** if the result is Mastra's `{ error: true }` value (W6). Re-entering through the tool keeps one implementation and one access guard; the re-validation inside the tool is cheap.

**Why two steps:** the record separates "your request was wrong" (`validate-request` failed) from "the provider failed" (`evaluate` failed), and isolates provider latency in `evaluate`'s `startedAt`/`endedAt`.

**Image redaction (`pruneSnapshot`)** — **must operate on a `structuredClone` of the snapshot and never mutate its argument**: the hook fires mid-run on objects shared with the live run, and an in-place rewrite sends hashes to the provider instead of images (W2, probed). On the copy it replaces every `images` array found in `context.input`, each step's `payload`, and each step's `output` with `[{ sha256, bytes }]` (hash of the decoded image; `bytes` decoded length). Runs on every persist (W2). What was sent stays provable; ~4.5 MB of base64 is not stored 2–3× per run. Consequences: a run with images **cannot be restarted or time-travelled** (the stored input is no longer valid input) — acceptable, as these are one-shot calls; and the `start-async` **HTTP response is not redacted** (it is built from the live result, W4), so callers get their own images echoed back in `input`/`steps`.

**`runId` reuse gate (`onStart`)** — callers may supply `?runId=` for correlation, but Mastra would let a second start with the same id overwrite the first caller's record (W8). `rejectRunIdReuse` loads the run by id; if it exists and is not this caller's freshly created `pending` run (`status !== 'pending'` or `resourceId` differs), it throws `SystemOneError(409, 'SYS1_RUN_ID_CONFLICT')` → `start-async` answers **409** and the original record is untouched (probed). `onStart` errors propagate and the run never executes. Residual: two *concurrent* starts with the same brand-new id can both pass the `pending` check — narrow, and only between callers who already share an id; documented, not engineered around.

**`autoRestartActiveRuns: false`** — on boot Mastra re-drives runs left `running` by a crash. For a synchronous scoring call the caller has already seen a dropped connection, and a redacted snapshot couldn't be replayed anyway. Such runs stay recorded as interrupted.

**What a run records (the tracking contract):** `runId`, `workflowName`, `resourceId` (member userId or M2M `sub`), `createdAt`/`updatedAt`, `status`; the input (images hashed); per step payload, output or error (`[SYS1_…]` message + `status`), timestamps; the final `result` (incl. `provider`, `model`, `usage`); and the caller's verified claims (`user`/`mastra__user` — roles or scopes) from `requestContext`. **Not** the bearer token (W1). `state`/`instructions` content **is** stored — that is the point of tracking, and it is why retention is a named follow-up. Logs carry `runId` alongside the Decision 5 fields so log lines join to runs.

**Service HTTP contract:**

| Call | Use |
| --- | --- |
| `POST /v6/ai/workflows/system-one/start-async[?runId=<uuid>]` `{ "inputData": … }` | **Recommended.** Runs to completion and returns the result envelope incl. `runId`. A supplied `runId` must be a fresh UUID; reuse → `409` (W8). |
| `POST …/create-run` then `POST …/start?runId=` | Fire-and-forget; poll `GET …/runs/:runId`. |
| `GET /v6/ai/workflows/system-one/runs/:runId` / `GET …/runs` | Read back own runs (W5). `?fields=result,steps` trims the payload. |

| Outcome | HTTP | Body |
| --- | --- | --- |
| Success | 200 | `{ status: "success", result: <SystemOneResponse + provider>, runId, … }` |
| Any tool/provider/validation failure (Decision 5 table, `SYS1_INVALID_INPUT`) | **200** | `{ status: "failed", error: { message: "[SYS1_…] …", status }, runId, … }` — **recorded** |
| Missing role/scope | 403 | `{ error }` — auth hook, before any run exists |
| Reused `runId` | 409 | `{ error: "[SYS1_RUN_ID_CONFLICT] …" }` — original run untouched |
| Body > 4.5 MB | 413 | Mastra body limit (F5) — before any run exists |
| Infrastructure fault (storage down, …) | 5xx | `{ error }` |

### 8. Example (service caller, M2M)

```bash
curl -X POST "$TC_AI_API/v6/ai/workflows/system-one/start-async?runId=$(uuidgen)" \
  -H "Authorization: Bearer $M2M_TOKEN_WITH_sys1:use" \
  -H 'Content-Type: application/json' \
  -d '{
    "inputData": {
      "state": {"ticket": "I was charged twice. Please refund the extra payment."},
      "questions": {
        "refund":  { "type": "noul",   "instructions": "Is the customer requesting a refund?" },
        "urgency": { "type": "score",  "instructions": "How urgently does this need a response?",
                     "criteria": ["Routine", "Soon: customer inconvenienced", "Immediate: service down"] },
        "label":   { "type": "choice", "instructions": "Which queue owns this ticket?",
                     "criteria": {"billing": "Payments and refunds", "bug": "Software errors", "other": null} }
      }
    }
  }'
# 200 → { "status":"success", "runId":"…",
#         "result": { "provider":"ollama", "model":"nimble",
#                     "answers": { "refund":{"type":"noul","noul":0.9989},
#                                  "urgency":{"type":"score","score":0.83,"legend":{"0":"Routine",…},"probabilities":{"0":…},"confidence":…},
#                                  "label":{"type":"choice","choice":"billing","probabilities":{…},"confidence":…} },
#                     "usage": {"input_tokens":…,"output_tokens":…} },
#         "steps": {…}, "input": {…} }
# failure → 200 { "status":"failed", "runId":"…", "error": { "message":"[SYS1_MODEL_UNAVAILABLE] …", "status":503 } }
```

### 9. Implementation plan

1. Contract + config: `types.ts` (Zod request/response, descriptions), `system-one.config.ts`, shared `resolveSystemOneRequest()`; tests for bounds, resolution and config parsing.
2. Provider: interface, Ollama adapter, factory; tests with mocked `fetch` covering every row of the Decision 5 table.
3. Tool: `system-one-tool.ts` wrapped in `withAccessPolicy` (not registered on Mastra); tests for output passthrough + `provider`, error propagation.
4. Workflow: `system-one-workflow.ts` + `redactSystemOneImages` + `rejectRunIdReuse`; register; tests (in-memory LibSQL, as in the probes) — success; invalid input → recorded failed run with `SYS1_INVALID_INPUT`; provider error → failed run with `status`; tool `{error:true}` → failed (not success); **`evaluate` receives the original base64 while the stored snapshot holds only hashes**; `redactSystemOneImages` does not mutate its argument; reused `runId` → `409` and the first record intact; tool unreachable (`mastra.getToolById('system-one')` fails and no registered agent's tools include it).
5. RBAC: both policies, workflow alias, C1, C2, C3; ADR 0004 implementation note. There is no HTTP/auth test harness (`tests/integration` covers extraction only), so RBAC tests are unit-level: `authorizeAccessPolicy` on both workflow spellings, and `withAccessPolicy` with `user` spoofed to admin but `mastra__user` clean → denied (F4).
6. Verify against a real Ollama ≥ 0.35 with `nimble` pulled (see *Prerequisites*), incl. one small Clef Flash image call; inspect the stored run in Studio.

## File-level mapping

| File | Change |
| --- | --- |
| `src/utils/providers/system-one/types.ts` | **New** — canonical Zod contract + descriptions, `resolveSystemOneRequest()` |
| `src/utils/providers/system-one/provider.ts` | **New** — `SystemOneProvider`, `SystemOneError` |
| `src/utils/providers/system-one/ollama.ts` | **New** — Ollama adapter |
| `src/utils/providers/system-one/index.ts` | **New** — `getSystemOneProvider()` |
| `src/utils/providers/system-one/*.test.ts` | **New** |
| `src/config/system-one.config.ts` (+ `.test.ts`) | **New** — Decision 2 |
| `src/mastra/tools/system-one/system-one-tool.ts` (+ `.test.ts`) | **New** — Decisions 3–5 |
| `src/mastra/workflows/system-one/system-one-workflow.ts` (+ `.test.ts`) | **New** — Decision 7, incl. `redactSystemOneImages` |
| `src/mastra/index.ts` | Modified — `workflows: { …, systemOneWorkflow }` (tool deliberately **not** registered) |
| `src/config/access-control.config.ts` | Modified — `'system-one'` workflow + tool policies; `systemOneWorkflow` alias; fix `TARGET_ID_ALIASES.tool` comment |
| `src/utils/auth/access-control.ts` | Modified — `TOOL_PATH_RE` in `parseTarget` (C1); `ToolAccessDeniedError.status = 403` (C2); `withAccessPolicy` reads `mastra__user` first (C3) |
| `src/utils/auth/access-control.test.ts` | Modified — tool-path targets, 403 status, F4 regression, both alias spellings of the workflow |
| `docs/adr/0004-…md` | Modified — implementation note referencing C1–C3 |
| `README.md` / env docs | Modified — `SYS1_*` vars, `sys1:use` scope, workflow service contract, stale observability claim (W7) |

## Consequences

- **+** A cheap, probability-returning decision primitive available to services now and to agents later.
- **+** Every service call is a persisted, caller-attributed run with per-step timing and errors — including rejected input — readable back by the caller and in Studio.
- **+** Provider is swappable behind one interface; callers and the tool schema don't change.
- **+** C1–C3 improve every restricted tool: correct `403`s, an early auth-hook check over HTTP, and a caller identity that cannot be injected through the request body.
- **−** The canonical contract is Ollama-shaped (`noul`, `keep_alive` semantics). A future provider with different semantics (e.g. no probabilities) would need lossy adaptation or a contract revision.
- **−** Not drop-in for an Ollama client: services use Mastra's `{ "inputData": … }` envelope, read `result`, and must branch on `status` — failures arrive as HTTP `200` (W4).
- **−** Run records grow without bound and contain caller content (`state`) and caller claims until retention lands (*Decisions confirmed* 11). Treat the `workflow_snapshots` table as holding member content.
- **−** Runs with images can't be restarted/time-travelled (redacted input), and the `start-async` response echoes images back un-redacted.
- **−** Two policies (workflow + tool) must be kept in step when overridden.
- **−** No span-level tracing (W7): a run shows step timings and errors, not the HTTP call to Ollama. Covered by the follow-up observability ADR.
- **Risk:** W2/W8 are Mastra behaviours, not documented contracts; the deep-copy and `409` tests are what catch a regression on upgrade.
- **−** Images are capped at ~3.3 MB raw per request by Mastra's global 4.5 MB body limit (*Decisions confirmed* 5), well below Ollama's 32 MiB.
- **−** C2 changes an observable status code (500 → 403) for existing restricted tools over HTTP; anything keying on 500 must adapt (none known).
- **Risk:** tool schemas with `z.record` + discriminated unions under `additionalProperties` may be reshaped by Mastra's schema-compat layer for some model providers. Not exercised until an agent is wired; check then with the target model.

## Review questions — resolved (2026-10-05)

1. Body limit for images → keep 4.5 MB (*Decisions confirmed* 5).
2. Derived answer fields → none, verbatim (*Decisions confirmed* 6).
3. `keep_alive` → server-only (*Decisions confirmed* 7).
4. `mastra__user` hardening → in this ADR, C3 (*Decisions confirmed* 8).
5. Direct tool route once the workflow exists → removed; tool not registered (*Decisions confirmed* 1, revision 2).
6. Images in run records → `{ sha256, bytes }` (*Decisions confirmed* 10).
7. Run-record retention → follow-up (*Decisions confirmed* 11).
8. Tracing → run snapshots only; observability is its own ADR (*Decisions confirmed* 12).

## Prerequisites

- [ ] **Ollama ≥ v0.35.0** (≥ v0.35.1 for Clef) on the target host, with **`nimble` pulled** (and `clef-flash` if images are to work). Not verified: `ollama.topcoder-dev.com:11434` was unreachable from the authoring machine on 2026-10-05.
- [ ] **`OLLAMA_API_URL`** set in every environment (System One uses it by default). Set **`SYS1_OLLAMA_BASE_URL`** only where System One should run on a different Ollama host than the chat models — decision models are small, but scoring 64 questions on a shared host competes with chat inference.
- [ ] **`sys1:use` scope** created on the M2M Auth0 API (`AUTH0_M2M_AUDIENCE`) and granted to the consuming service clients.
- [ ] Owner agreed for the **retention follow-up** (run records hold caller content indefinitely until then).

## Implementation notes (2026-10-05)

Implemented as designed. These details were settled while building it:

- **`runId` gate checks the verified caller, not `info.resourceId`.** `Workflow.createRun()` returns the *cached*
  in-process `Run` for a known `runId`, along with the first caller's `resourceId`. So `onStart`'s `info.resourceId`
  can't tell B apart from A when B reuses A's still-`pending` id. `rejectRunIdReuse` compares the stored run's
  `resourceId` with `requestContext.get(MASTRA_RESOURCE_ID_KEY)`, which verified auth sets per request, and falls
  back to `info.resourceId` for in-process callers. A test covers the pending case. It fails if the check uses
  `info.resourceId`.
  A run with no owner (always the case under `DISABLE_AUTH=true`) is stored with `resourceId` NULL in Postgres while
  the context has `undefined`. Both mean "no owner" and are compared as equal. The first version compared them
  strictly, so it rejected every such run with `409` (fixed 2026-10-06; regression tests added).
- **`mastra__user` is a local constant** (`MASTRA_USER_CONTEXT_KEY` in `access-control.ts`). Neither
  `@mastra/core/request-context` nor any public `@mastra/server` export provides it. A test resolves
  `@mastra/server` through `mastra` → `@mastra/deployer` and asserts that its `MASTRA_USER_KEY` still equals that
  string.
- **Response schemas are `z.looseObject`.** Additive upstream fields pass through verbatim (*Decisions confirmed* 6).
  A missing or mistyped required field is still a `502`.
- **`SYS1_KEEP_ALIVE`**: a purely numeric value is sent as a JSON number (seconds), anything else as a duration
  string. Ollama rejects a unitless duration string.
- **A caller abort is rethrown as-is.** Only the provider's own timeout maps to `504 SYS1_TIMEOUT`.
- **Blank question/option names** are rejected by a refine on the record, not by the key schema. Zod reports a
  failing key schema only as "Invalid key in record", with no useful path.
- **Image redaction** touches only the `images` field of `context.input` and of each step's `payload`/`output`. A
  caller's `state` may legitimately contain an `images` key and is left alone. A snapshot with no raw images is
  returned as-is, without a clone. Tests confirm that breaking the deep copy makes the live run fail, as W2 predicts.
- The **"tool unreachable" test** lives in `src/mastra/index.test.ts`. It imports the real Mastra instance with
  Postgres swapped for in-memory LibSQL and Auth0/workspace env stubbed.
