# ADR 0003 — Enable AWS Bedrock prompt caching by default

- **Status:** **Accepted** (proposed 2026-08-26, refreshed 2026-08-28, accepted and implemented 2026-08-28) — implemented on this branch
- **Date:** 2026-08-26 (refreshed 2026-08-28 — see "Update" in Context)
- **Target branch:** `challenges-rag`
- **Related:** `src/utils/providers/bedrock.ts` / `src/utils/providers/model-factory.ts`
  already carry a `wrapLanguageModel`-based Bedrock **request-metadata** middleware
  (`createBedrockChatModel`), landed on this branch ahead of this ADR. See "Update"
  below — this ADR's caching middleware composes with that existing wrapper rather
  than wrapping a bare provider model.

## Context

### The problem

Every agent in this repo (`challengeSearchAgent`, `skillsMatchingAgent`,
`challengeParserAgent`, `jdRewriterAgent`) sends its full system-prompt instructions
to the model on **every single call**, unchanged. Some of these prompts are long,
multi-paragraph blocks (`challenge-search-agent.ts`'s instructions run to several
hundred words covering search strategy, filter rules, and project-separation
policy). For a multi-turn agent like `challengeSearchAgent` (`Memory.lastMessages:
25`), the growing conversation history is resent in full on every turn too. None of
this content is currently eligible for any form of reuse — each call is billed and
latency-charged for the entire prompt, every time.

AWS Bedrock supports **prompt caching**: a provider can mark a point in the prompt
as a cache checkpoint, and if a subsequent request's prompt matches the cached
prefix exactly up to that point, Bedrock serves the cached KV-state instead of
reprocessing it — cutting both cost and time-to-first-token for the cached portion.
The static system-prompt block in every one of this repo's agents is close to the
textbook case for this feature: identical bytes, sent on every request, easily
above Bedrock's per-checkpoint minimum-token threshold.

### What the AI SDK gives us (verified against installed `@ai-sdk/amazon-bedrock@4.0.121`, not just the docs page)

- Cache control is a **per-message** flag, not a provider- or model-construction-time
  setting: `providerOptions: { bedrock: { cachePoint: { type: 'default', ttl?: '5m'
  | '1h' } } }`, attached to a system/user/assistant message. `ttl` defaults to
  `'5m'`; `'1h'` costs more per cache write but survives longer idle gaps between
  requests.
- **No typed field exists for this in the installed SDK version.** It's read via
  untyped passthrough in the compiled provider
  (`providerMetadata?.bedrock?.cachePoint` — confirmed at 5 call sites in
  `node_modules/@ai-sdk/amazon-bedrock/dist/index.js`, covering system/user/assistant
  messages). `AmazonBedrockLanguageModelOptions`, the SDK's typed provider-options
  schema, has no cache field at all. This means there is no compile-time safety net
  from the package itself — any local wrapper has to define its own types and keep
  them honest by hand.
- **`createAmazonBedrock()`'s provider-construction settings have no cache option.**
  Caching cannot be a provider-factory default in the sense of "set once when the
  provider is created" — it has to be applied at the message-construction layer, on
  every call.
- **Model support is real and enforced, not advisory.** Only current-generation
  models accept `cachePoint` — modern Claude (3.5+, Sonnet 5, Haiku 4.5 — this
  repo's current defaults) and Amazon Nova. Sending it to an unsupported model
  (Claude 3 pre-3.5, Titan, Llama, Mistral, Cohere on Bedrock) is a **hard
  `ValidationException`** — not a silent no-op. Below the per-checkpoint minimum
  token threshold (~1024 tokens, model-dependent), Bedrock *does* silently skip
  caching rather than error — that half is safe to ignore.
- **Up to 4 cache checkpoints per request**, and checkpoint placement must be
  monotonic through the conversation. This ADR uses exactly one (the system
  message); a second checkpoint over conversation history is identified below as
  follow-on scope, not part of this decision.

### Why this can't be "just always on"

Every agent's provider and model are independently env-overridable
(`CHALLENGE_SEARCH_AI_PROVIDER` / `CHALLENGE_SEARCH_AI_MODEL_ID`, and the equivalent
pair per agent) to **any** Bedrock model ID string, or to a non-Bedrock provider
entirely (`TC-Ollama`, `WiproAI`, `OpenAI`). A middleware that unconditionally
stamps `cachePoint` onto every Bedrock call would turn an operator's routine model
swap (e.g. testing an older Claude 3 model, or a Titan-based experiment) into a hard
runtime failure on the very next request. The mechanism has to gate on which model
is actually in play.

### What Mastra itself provides — nothing automatic

Searched `@mastra/core`'s bundled docs (`node_modules/@mastra/core/dist/docs/**/*.md`)
for any built-in cache-injection feature. Mastra is aware of prompt caching as a
*concept* — `docs-guides-context-engineering.md` advises keeping stable prompt
content first so "the model provider may... reuse the same prompt cache prefix,"
and describes Observational Memory as cache-friendly because it folds history into
stable chunks instead of an ever-changing raw tail — but there is no Agent option,
Memory option, or built-in processor that sets `providerOptions.bedrock.cachePoint`
automatically. None of the four agents in this repo currently use Observational
Memory (they use plain `lastMessages`). This has to be built as model middleware.

### Update (2026-08-28) — a Bedrock request-metadata middleware landed first

Since this ADR was drafted, `src/utils/providers/bedrock.ts` and
`src/utils/providers/model-factory.ts` were changed to fix an unrelated bug: the
per-agent `X-Amzn-Bedrock-Request-Metadata` HTTP header set at provider-construction
time had no effect on chat calls, because Bedrock's Converse/ConverseStream API
(what `@ai-sdk/amazon-bedrock`'s chat model actually calls) reads request metadata
from a `requestMetadata` field in the JSON **body**, not from that HTTP header — the
header only applies to the InvokeModel/InvokeModelWithResponseStream API, which is
what this repo's embedding/image models use. The fix, already merged:

- `bedrock.ts` now exports `createBedrockChatModel(modelId, agentId?)`, which wraps
  `createBedrockProvider(agentId)(modelId)` in `wrapLanguageModel({ model,
  middleware: defaultSettingsMiddleware({ settings: { providerOptions: { bedrock: {
  requestMetadata: { department: 'ai_api', role: \`agent-${agentId}\` } } } } }) })`
  — i.e. exactly the `wrapLanguageModel`-based middleware pattern this ADR proposes
  to add for caching, already established for a different purpose.
- `model-factory.ts`'s `AWSBedrock` branch already calls `createBedrockChatModel(modelName,
  agentId)`, **not** `createBedrockProvider(agentId)(modelName)` directly. Every
  current agent's model is therefore already `wrapLanguageModel`-wrapped by the time
  this ADR's caching feature would be added — Decision items 1–2 below need to
  extend that existing wrapper, not introduce a second, separate one.
- A TypeScript workaround was needed and is now established precedent: `ai@6.0.209`'s
  own `LanguageModel`/`wrapLanguageModel` return type resolves against a different
  `@ai-sdk/provider` instance than the one Mastra vendors internally (its bundled
  `_types/@ai-sdk_provider-v5`), so TS treats them as structurally incompatible even
  though they implement the same interface at runtime. `bedrock.ts` anchors to
  `type BedrockLanguageModel = ReturnType<ReturnType<typeof createBedrockProvider>>`
  and casts the `wrapLanguageModel(...)` result back onto it. This ADR's caching
  middleware should reuse that same anchor type rather than re-derive its own.
- Practically, this **retires the specific risk the original Phase 1 plan called out
  for verification** ("confirm `wrapLanguageModel`'s wrapper doesn't break the
  agents' existing test suites") — that's no longer a hypothetical to check during
  this ADR's implementation, it's already true in production code today: all four
  agents already receive a `wrapLanguageModel`-wrapped model (for request-metadata
  tagging), and their existing test suites already pass against it unmodified.

## Scope

**In scope:**

- A shared, reusable mechanism that stamps a Bedrock cache checkpoint onto the
  **system/instructions message** of every model call, applied centrally so it
  covers all four existing agents without per-agent changes.
- A model-ID allowlist gating the mechanism to models confirmed to support prompt
  caching, so an operator overriding an agent's model to something else never hits
  the hard-error path.
- A global kill switch and TTL knob, both env-var configurable with the feature
  **on** by default.

**Out of scope (deferred, not rejected):**

- A second cache checkpoint over conversation history (the "stable prefix grows one
  turn at a time" pattern for long multi-turn threads like `challengeSearchAgent`'s
  25-message memory). Real value for long-running threads, but adds genuine
  complexity — checkpoint-placement bookkeeping that shifts every turn, staying
  under the 4-checkpoint limit, and its own test surface. Ship the system-prompt win
  first, observe it in practice, revisit this as a follow-up.
- Per-agent cache configuration (e.g. a `*_AI_CACHE_ENABLED` env var per agent
  mirroring the existing `*_AI_PROVIDER` / `*_AI_MODEL_ID` pattern). The global
  switch proposed here is simpler and matches "on by default everywhere"; nothing
  in the current agent set needs per-agent divergence. If that changes, promoting
  the global flag to a per-agent override is additive, not a breaking change.
- Anthropic's own cache-control shape (`providerOptions.anthropic.cacheControl`).
  That shape belongs to `@ai-sdk/amazon-bedrock`'s separate
  `createBedrockAnthropic` / `bedrockAnthropic` provider (native Anthropic API via
  Bedrock's `InvokeModel`, bypassing the Converse API). This repo's
  `createBedrockProvider()` (`src/utils/providers/bedrock.ts`) uses the standard
  `createAmazonBedrock` (Converse API) path, so the relevant shape is
  `providerOptions.bedrock.cachePoint`, not the Anthropic one.
- Embedding calls (`createEmbeddingModel`, used for RAG ingestion/retrieval) —
  prompt caching is a chat-completion concept; embeddings have no system prompt to
  cache.
- Any change to `TC-Ollama`, `WiproAI`, or `OpenAI` provider paths in
  `model-factory.ts` — this ADR only touches the `AWSBedrock` branch.

## Affected agents (all `AWSBedrock`-capable model consumers)

| Agent | Default provider | Default model ID | Cache-capable by default? |
| --- | --- | --- | --- |
| `challengeSearchAgent` | AWSBedrock | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Yes |
| `skillsMatchingAgent` | AWSBedrock (env-overridable) | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Yes |
| `challengeParserAgent` | AWSBedrock (env-overridable) | `us.anthropic.claude-sonnet-5` | Yes |
| `jdRewriterAgent` | AWSBedrock (env-overridable) | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Yes |

All four current defaults are cache-capable Claude models. Every one of these is
env-overridable per agent to a different provider or Bedrock model ID — the concrete
reason the allowlist guard in the Decision below is load-bearing, not defensive
boilerplate.

## Decision

1. **Add cache-eligibility and middleware logic to `src/utils/providers/bedrock.ts`**
   (the Bedrock-specific provider file — co-located with the rest of the
   Bedrock-only code, rather than in the provider-agnostic `model-factory.ts`):
   - `isCacheCapableBedrockModel(modelId: string): boolean` — an **allowlist**,
     matching known cache-capable model ID patterns (modern Claude 3.5+/Sonnet
     4-5/Haiku 4.5, Amazon Nova). Allowlist, not denylist, deliberately: a false
     negative here just means "no caching for this call" (silent, harmless); a
     false positive means a hard `ValidationException` that breaks the agent's
     next request outright. When in doubt, don't cache.
   - A cache middleware (`transformParams`) that locates the system message in
     `params.prompt` and, only when `isCacheCapableBedrockModel(modelName)` is true
     and the feature is enabled, returns a new params object with
     `providerOptions.bedrock.cachePoint = { type: 'default', ttl: <configured> }`
     merged onto that message's existing `providerOptions` (never clobbering
     anything already set there — this matters concretely now, since the
     request-metadata middleware already populates `providerOptions.bedrock` on
     every call). Otherwise returns `params` unchanged. `transformParams` returns a
     new object rather than mutating the input, matching the AI SDK middleware
     contract.
   - This middleware is added as a **second entry** in `createBedrockChatModel`'s
     existing `wrapLanguageModel({ model, middleware })` call (`middleware` becomes
     an array: `[requestMetadataMiddleware, cacheMiddleware]`, gated independently —
     the cache entry only activates for cache-capable models with the feature
     enabled, exactly as the request-metadata entry already only activates when
     `agentId` is provided). One `wrapLanguageModel` call, one `BedrockLanguageModel`
     cast, both concerns composed — not two nested wraps of the provider model.
2. **`src/utils/providers/model-factory.ts`'s `AWSBedrock` branch keeps calling
   `createBedrockChatModel(modelName, agentId)`** — unchanged from its current
   form. No factory-level plumbing changes; the caching behavior activates because
   `createBedrockChatModel` itself now composes the cache middleware alongside the
   request-metadata one. No agent file changes either way.
3. **Two new environment variables**, both optional with defaults, following this
   repo's existing env-var convention (`rag.config.ts`'s pattern of
   validated-with-sane-default):
   - `BEDROCK_PROMPT_CACHE_ENABLED` — default `true`. A global kill switch; set to
     `false` to fully disable without a deploy rollback if something unexpected
     shows up in production.
   - `BEDROCK_PROMPT_CACHE_TTL` — default `'5m'`, validated to `'5m' | '1h'`.
     Rejecting any other value the same way `rag.config.ts`'s `parseNumber` throws
     an actionable error for a bad numeric env var.
4. **Cache only the system/instructions message in this pass** (see Scope). No
   attempt to cache growing conversation history yet.
5. **Verify the flag is actually doing something, not just silently present.**
   During implementation, check whether the Bedrock Converse response surfaces
   cache read/write token counts through the AI SDK result (likely
   `result.providerMetadata.bedrock` or a dedicated field on `result.usage`) and, if
   so, log it at `tcAILogger.debug` (or `info`) per call — the same observability
   instinct as the existing `tcAILogger.warn` in
   `challenge-vector-query-tool.ts` when every result falls below threshold. A flag
   that "does nothing detectably" is not meaningfully different from a bug.

### Config surface

```ts
// src/utils/providers/bedrock.ts (additive — extends the existing
// createBedrockChatModel, does not replace or duplicate it)
export function isCacheCapableBedrockModel(modelId: string): boolean {
  // Allowlist of confirmed-capable model ID patterns — Claude 3.5+/Sonnet 4-5/
  // Haiku 4.5, Amazon Nova. Extend deliberately; a miss here just means no
  // caching, a wrong inclusion means a hard ValidationException on the next call.
}

// Inside createBedrockChatModel's existing wrapLanguageModel({ model, middleware })
// call: middleware becomes an array, e.g.
//   middleware: [
//     ...(agentId ? [requestMetadataMiddleware(agentId)] : []),
//     ...(cacheEnabled && isCacheCapableBedrockModel(modelId) ? [cacheMiddleware] : []),
//   ]
// still cast once to the existing BedrockLanguageModel anchor type.
```

```bash
# .env.sample (additive)
BEDROCK_PROMPT_CACHE_ENABLED="[true|false — default true]"
BEDROCK_PROMPT_CACHE_TTL="[5m|1h — default 5m]"
```

## Implementation plan

### Phase 0 — Middleware and eligibility check
- `src/utils/providers/bedrock.ts`: add `isCacheCapableBedrockModel()`, a cache
  `transformParams` middleware, and the local (untyped-upstream) TypeScript
  interface describing the `cachePoint` shape, since the installed SDK doesn't
  export one. Compose the middleware into `createBedrockChatModel`'s existing
  `wrapLanguageModel({ model, middleware })` call as an additional array entry
  (gated on `isCacheCapableBedrockModel(modelId)` and the enabled flag) rather than
  adding a second, separate wrapper function — `createBedrockChatModel` is already
  the one `wrapLanguageModel` choke point every agent goes through (see "Update" in
  Context), and it already resolves the `BedrockLanguageModel` type-cast this would
  otherwise need to re-derive.
- Read the two new env vars once (module scope or lazily, matching the existing
  style in this file) with validation matching `rag.config.ts`'s
  `parseNumber`/`validateSqlIdentifier` pattern — throw an actionable error for an
  invalid `BEDROCK_PROMPT_CACHE_TTL`, don't silently fall back.
- `src/utils/providers/bedrock.test.ts` (new — doesn't exist yet): unit tests for
  `isCacheCapableBedrockModel` — positive cases for the four model IDs actually in
  use today, negative cases for Titan/Llama/pre-3.5 Claude; and for the cache
  middleware's `transformParams` — cache point added for a capable model with the
  feature enabled, absent when disabled via env, absent for a non-capable model,
  existing `providerOptions` on the system message preserved rather than
  overwritten (this last case is no longer hypothetical — the request-metadata
  middleware already sets `providerOptions.bedrock` on every tagged call, so the
  non-clobbering behavior is exercised by real, existing traffic, not just a
  synthetic test fixture). Also add a case with both middleware entries present
  (agentId set *and* a cache-capable model) confirming both `requestMetadata` and
  `cachePoint` land in the final params.

### Phase 1 — Wire into the model factory
- No `model-factory.ts` changes needed — its `AWSBedrock` branch already calls
  `createBedrockChatModel(modelName, agentId)`; the caching behavior activates
  purely from Phase 0's change to that function's internals.
- The original risk here — "confirm `wrapLanguageModel`'s wrapper doesn't break the
  four agents' existing test suites" — is already resolved, not just de-risked: all
  four agents already run against a `wrapLanguageModel`-wrapped model today (for
  request-metadata tagging), and their test suites already pass unmodified against
  it. Nothing new to verify here beyond re-running that same suite after Phase 0.

### Phase 2 — Validation
- `npx tsc --noEmit`, `npx eslint`, full `vitest run`.
- Manual smoke test against real Bedrock: run `challenge-search-agent` twice in a
  row with the same conversation via Studio or `/chat/:agentId`, and confirm via
  the logging added in Decision item 5 that the second call reports a cache hit
  (non-zero cache-read tokens) for the system-prompt portion.
- Manual negative test: temporarily override `CHALLENGE_SEARCH_AI_MODEL_ID` to a
  known non-capable model (e.g. a Titan text model ID) and confirm the agent still
  responds normally — i.e. the allowlist guard actually prevents the
  `ValidationException` it exists to prevent, rather than that path being
  untested.

### Phase 3 — Documentation
- `README.md`: add `BEDROCK_PROMPT_CACHE_ENABLED` and `BEDROCK_PROMPT_CACHE_TTL` to
  the environment-variables table, plus a short paragraph (matching the existing
  "Retrieval" / agent-description sections in style) explaining what prompt
  caching is, that it's on by default for cache-capable Bedrock models, and how to
  disable it.
- `.env.sample`: the two new keys with the default-documented placeholder format
  already used throughout that file.

## File-level mapping

| File | Change |
| --- | --- |
| `src/utils/providers/bedrock.ts` | Modified further (already contains `createBedrockChatModel`/`requestMetadataFor`/`BedrockLanguageModel` from the request-metadata fix) — adds `isCacheCapableBedrockModel()`, a cache `transformParams` middleware composed into `createBedrockChatModel`'s existing `wrapLanguageModel` call, local cache-point type, env-var reads |
| `src/utils/providers/bedrock.test.ts` | New — doesn't exist yet; eligibility + middleware unit tests (including composition with the existing request-metadata middleware) |
| `src/utils/providers/model-factory.ts` | **Unchanged** — its `AWSBedrock` branch already calls `createBedrockChatModel(modelName, agentId)`; nothing here needs to change for caching |
| `README.md` | Modified — env var table + short explainer |
| `.env.sample` | Modified — two new keys |
| `src/mastra/agents/**` | **Unchanged** — the whole point of centralizing this in the provider factory |

## Consequences

**Positive**

- Every current and future Bedrock-backed agent gets prompt caching automatically,
  with no per-agent code — the same "one choke point" property ADR 0002 leaned on
  for outbound TC API auth, and the same property the request-metadata middleware
  already proved out in `createBedrockChatModel` for a different concern.
- Reduced cost and time-to-first-token on every call after the first, for the
  (often large, always-static) system-prompt portion of every agent's request —
  compounding with `challengeSearchAgent`'s `lastMessages: 25` memory, where the
  system prompt is resent unchanged on every turn of a long conversation.
- The allowlist guard means an operator's routine `*_AI_MODEL_ID` override to test
  a different model degrades gracefully (no caching) instead of breaking the agent.

**Negative / risk**

- **No compile-time type safety from the SDK for the `cachePoint` field itself.**
  It's read via untyped passthrough in the installed `@ai-sdk/amazon-bedrock`
  version — a local hand-written interface is the only thing keeping the shape
  honest, and it will silently go stale if a future SDK upgrade changes the field
  name or nesting. Mitigation: the unit tests in Phase 0 pin the expected shape, so
  an SDK upgrade that breaks it fails tests rather than failing silently in
  production. (This is a separate concern from the `wrapLanguageModel`-return-type
  skew against Mastra's vendored types — that one is already solved by the
  `BedrockLanguageModel` anchor type this ADR reuses; see "Update" in Context.)
- **The allowlist needs manual upkeep.** A new Claude/Nova model released on
  Bedrock with cache support won't benefit from this feature until someone adds it
  to `isCacheCapableBedrockModel()`. Accepted trade-off given the alternative (a
  denylist) risks a hard production error instead of a missed optimization.
- **System-prompt-only caching leaves value on the table for long conversations.**
  A 25-message thread's growing history is not cached at all in this pass — see
  Scope. Real but bounded: the system prompt is very likely the single largest
  static block in most calls regardless of history length, so this pass captures
  the majority of the available benefit even without the second checkpoint.
- **Below-threshold prompts pay for a cache write with no future reuse if the
  conversation never continues** (single-shot calls, or agents whose system prompt
  is short). Bounded cost, not a correctness issue — Bedrock still serves the
  response normally either way.

## Open questions

- Exact field name/shape for cache read/write token counts in the AI SDK's result
  object for Bedrock — needed for the observability step in Decision item 5 and the
  Phase 2 manual smoke test. Not confirmed during this ADR's research; resolve by
  inspecting a real response's `providerMetadata` during Phase 0/1 implementation.
- Whether `BEDROCK_PROMPT_CACHE_TTL: '1h'` is ever worth the higher cache-write
  cost for this repo's actual call patterns (bursty interactive chat vs. steady
  background workflow traffic) — no usage data exists yet to decide; `'5m'` default
  is the safe starting point and this can be revisited once the observability from
  item 5 gives real numbers.
- Whether the second (conversation-history) checkpoint from the Scope section is
  worth the added complexity — deferred until the system-prompt-only win has been
  observed in production for `challengeSearchAgent`'s long-running threads
  specifically.

## Prerequisites to confirm before implementation starts

- ~~Confirm the four model IDs currently in use are actually cache-enabled in the
  target AWS account/region for Bedrock~~ — **Confirmed 2026-08-28** by the repo
  owner: the two distinct model IDs actually in play
  (`us.anthropic.claude-haiku-4-5-20251001-v1:0`,
  `us.anthropic.claude-sonnet-5`) are cache-enabled in the target account/region.
  (Not independently re-verified against the live AWS account in this session — no
  AWS credentials were available in this environment to query Bedrock directly —
  this is an owner attestation, not a CLI-verified fact.)
- Reviewer sign-off on the allowlist-vs-denylist choice (Decision item 1) and the
  global-vs-per-agent config choice (Scope) — both are judgement calls made
  explicit here for review rather than settled facts.
