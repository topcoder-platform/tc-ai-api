# ADR 0010 — "Let's talk" inbound form classification (agent + tracked workflow)

- **Status:** **Accepted — implemented** (2026-10-20) on `PM-6624_letstalk-classificaiton-workflow`.
- **Date:** 2026-10-20
- **Revised:** 2026-10-22, revision 2 (class split, see below).
- **Related:** [ADR 0003](0003-bedrock-prompt-caching-by-default.md) (prompt caching), [ADR 0004](0004-role-based-access-for-agents-workflows-tools.md) (access policies and aliases), [ADR 0009](0009-system-one-tool.md) (tracked, service-triggered workflow; in-step input validation, W3)

## Revision 2 — `COMMUNITY_GENERAL` split (2026-10-22)

`COMMUNITY_GENERAL` was too wide: in the pseudonymized HubSpot sample, 145 of 206 submissions landed in it, so downstream routing could not act on it. It is split by the **direction** of the request:

| Class | Covers |
| --- | --- |
| `COMMUNITY_OPPORTUNITY` | Looking for work: jobs, gigs, internships, referrals, paid projects, ways to earn, or offering one's own skills to get work. |
| `COMMUNITY_SKILLS` | Learning or improving one's own skills: training, courses, certification, mentorship, practice. |
| `WIPRO_QUERIES` | Wipro employees and Wipro-internal matters: internal assignments, bench, Wipro accounts or projects. |
| `COMMUNITY_GENERAL` | Kept as the catch-all: general "how does Topcoder work" questions, or no defined direction. |

The default set is now `JUNK, COMMUNITY_OPPORTUNITY, COMMUNITY_SKILLS, COMMUNITY_SUPPORT, COMMUNITY_GENERAL, WIPRO_QUERIES, SALES_LEAD`, in that order.

- **Order matters.** Configured order is the tie-break order, so `COMMUNITY_GENERAL` comes after the specific community classes: an exact tie with the catch-all resolves to the specific class.
- **Community decision order.** The instructions check community submissions in this order: problem → `COMMUNITY_SUPPORT`, work → `COMMUNITY_OPPORTUNITY`, learning → `COMMUNITY_SKILLS`, otherwise `COMMUNITY_GENERAL`.
- **Wipro precedence.** `WIPRO_QUERIES` takes precedence over the `COMMUNITY_*` classes and `SALES_LEAD` when the submitter is a Wipro employee, or when the request is Wipro-internal. A Wipro team buying for a Wipro client account is `WIPRO_QUERIES`, not `SALES_LEAD`. `JUNK` still wins for spam and vendor pitches.
- **New model signal `isWiproDomain`.** It is computed in code from the email domain against `WIPRO_MAIL_DOMAINS` (`wipro.com` and its subdomains), next to `isFreeMailDomain` / `isDisposableDomain`. A Wipro employee writing from a free-mail address is still recognized from the message or `companyName`.
- **Contract change for the caller.** The output now has seven keys in `confidences`, and three new `classification` values. No consumer existed yet, so nothing downstream needed to change.
- **Not re-measured live.** The live result under *Tests* predates the split, and the eval must be re-run. The 206-sample real-traffic fixture (not yet committed) must be relabeled first, because its 145 `COMMUNITY_GENERAL` labels predate the split.

## Context

Submissions to the public "Let's talk" form are triaged by hand today. They need to be sorted automatically into predefined buckets, and an automated M2M caller (out of scope here) will act on the result. The requirements:

- the class set is predefined and configurable;
- submissions arrive in any language;
- the caller gets a confidence for every class, not only the winner;
- the model's structured output is verified and retried when broken, and the run never returns a guessed class;
- access is M2M-only;
- personal data sent to the model is kept to a minimum.

## Decision

### 1. Agent `lets-talk-classifier-agent` and workflow `lets-talk-classification`

| | |
| --- | --- |
| Agent | `src/mastra/agents/lets-talk/lets-talk-classifier-agent.ts`. Haiku 4.5 on Bedrock, `temperature: 0`, `maxOutputTokens` 1024, no memory, no tools. Scorers only under `LOCAL_DEV`. Model creation goes through `createModel(…, AGENT_ID)`, so Bedrock cost tags and prompt caching apply. |
| Workflow | `src/mastra/workflows/lets-talk/lets-talk-classification-workflow.ts`: `validate-submission → classify-submission → finalize-classification`, with `validateInputs: false` (ADR 0009 W3). |
| Schemas | `src/mastra/workflows/lets-talk/lets-talk-schemas.ts`: the input, the model output and the workflow output. |
| Config | `src/config/lets-talk-classification.config.ts`: classes, limits, retry knobs and the email-domain lists. |
| Processor | `src/mastra/processors/structured-output-validator.ts`: generic and reusable. |

**The model decides only `confidences`, `detectedLanguage` and `rationale`.** Code derives `classification` (the argmax, with ties going to the earlier configured class), `confidence`, `needsReview` and `submissionId`. As a result the model can't return a class that contradicts its own scores, and a prompt injection can't set the class directly.

**The message is optional.** "What can we help you with?" is the only form field without a `*`, and in real traffic it is empty in roughly half of the submissions. An empty or missing message is valid input. The model is shown `message: (left empty — the field is optional)` and classifies from the other fields with moderate confidence. Finalize then **always sets `needsReview: true`**, so a human checks every class that rests on names, company and email domain alone.

**Classes come from config.** `LETS_TALK_CLASSES_JSON` overrides the seven defaults (four before revision 2). It must hold 2–20 classes with unique `UPPER_SNAKE` ids, and each class has an optional `examples` / `counterExamples` list. The config is validated when the agent module is imported, so a bad value fails the boot. The output schemas (`z.enum(classIds)` and a confidence object keyed by every class) and the agent instructions are generated from the same list. **Changing the class set changes the caller-facing contract.**

**Security and personal data.** What the model receives:

- `isTopcoderMember`, never the member id;
- the email domain plus code-computed `isFreeMailDomain` / `isDisposableDomain` / `isWiproDomain` flags, never the address;
- the name, company, selector value and message.

It never receives the submission id, the timestamp or any UTM value. The schema strips UTM and other unknown keys before the run record is written. The submission is wrapped in `---BEGIN/END SUBMISSION---` delimiters, and the instructions treat embedded instructions as a JUNK signal. On top of the plan, two hardening steps:

- **Delimiter spoofing:** any `--- BEGIN/END SUBMISSION ---` look-alike inside a field is replaced with `[removed]`.
- **Fake labeled lines:** single-line fields are flattened, so a newline in `firstName` can't inject a fake `isTopcoderMember:` line.

### 2. Access: M2M-only, on both surfaces

The workflow `lets-talk-classification` and the agent `lets-talk-classifier-agent` each get the policy `{ mode: 'restricted', scopes: ['ai:letstalk:classify'] }`.

- Because the policy is scopes-only, every member token is denied, administrator included.
- The agent policy is required, otherwise `/agents/lets-talk-classifier-agent/generate` would be an ungated bypass of the workflow.
- `TARGET_ID_ALIASES` gains `letsTalkClassificationWorkflow` and `letsTalkClassifierAgent`.
- The usual `ACCESS_POLICY_{WORKFLOW,AGENT}_…_SCOPES` env keys override both.
- The scope is created in Auth0 and granted to the triggering client outside this repo.

### 3. Layered output verification (L0–L4)

| Layer | Where | Catches → action |
| --- | --- | --- |
| L0 | `modelSettings.maxRetries` (`LETS_TALK_CLASSIFIER_MAX_RETRIES`, 2) | Throttling, 5xx and network errors → AI SDK backoff retry |
| L1 | `z.preprocess` in the model schema | Numeric strings, percentages, key casing/spacing, language casing, unknown keys → coerced |
| L2 | `StructuredOutputValidator` output processor (`LETS_TALK_CLASSIFIER_MAX_PROCESSOR_RETRIES`, 2) | Invalid JSON, schema or semantic violations → `abort(feedback, { retry: true })` naming each defect |
| L3 | `generateWithStructuredOutputFallback` | A rejected or object-less strategy → next strategy, then plain-text recovery with JSON repair |
| L4 | `verifyModelOutput` in the classify step (`LETS_TALK_CLASSIFY_MAX_ATTEMPTS`, 2) | Repairable defects → fixed in finalize. Unrecoverable ones → one corrective re-run with a `PREVIOUS ATTEMPT WAS INVALID:` block. After that, `LETS_TALK_INVALID_MODEL_OUTPUT` (502) and a failed run |

**L4 classification of defects.**

- **Repairable** (no extra call): a missing class or a non-numeric value (set to 0), an out-of-range value (clamped), a sum that is off (renormalized), an invalid language code (set to `und`).
- **Unrecoverable:** no JSON object, `confidences` not an object, every confidence 0 / NaN / missing, or a missing or empty `rationale`.

**Call budget.** Typically 1 model call. The worst case is 2 attempts × 3 strategies × (1 + 2 processor retries) = **18 calls**, which a unit test pins. There is no workflow `retryConfig` and no step `retries`.

**Run record.** The classify step's output carries `meta`: `strategy`, `attempts`, `processorRetries`, `repaired`, `issuesFixedInCode` and `tokenUsage`. The public workflow output does not include it.

### 4. Spike (plan step 4a), probed on `@mastra/core` 1.74.0

The probes used `MockLanguageModelV3` from `ai/test` with a real `Agent`, run under vitest. They were throwaway and have been removed. The installed `node_modules` was still on 1.63 when work started, behind the lockfile's 1.74, and was re-synced with `pnpm install --frozen-lockfile` first.

- **(a) `processOutputStep` receives the JSON in `text` under both `native` and `jsonPromptInjection`.** On Bedrock, `native` is implemented with a forced `json` tool call, and `@ai-sdk/amazon-bedrock` maps that tool call back to a **text** part (`isJsonResponseFromTool`). So the processor sees the JSON there too. This was confirmed from the provider source, not yet live.
- **(b) A `retry: true` abort does not compose with `errorStrategy: 'strict'`.** The retry happens and the second answer is valid, but strict validation of the *rejected first* answer still throws `Structured output validation failed`. With `'warn'` (or `'fallback'`) the result is the corrected object. With `'warn'`, an answer that is still invalid after the processor gives up resolves with **no `object`**, which the wrapper already treats like a strict failure: it moves on to the next strategy. **Consequence:** `generateWithStructuredOutputFallback` gains an optional `errorStrategy` (default `'strict'`, so existing callers are unchanged), and this workflow passes `'warn'`.
- **(c) On retry, Mastra does not replay the rejected answer.** Only the feedback is sent, as a `<system-reminder>` user message. The feedback is therefore self-contained: it names each defect and says "Answer the original request again from scratch and return ONLY the corrected JSON object."
- **(d) `z.preprocess` is transparent to the JSON Schema sent to the model.** The model sees the inner schema, with every class required and in [0, 1]. So L1 tolerance costs no guidance.

### 5. Departures from the plan

1. **Wrapper `errorStrategy` option**, from spike (b). Without it, L2 retries would be thrown away.
2. **L4 also parses `response.text` when the wrapper returns no object.** The strict model schema requires every class, so a model that keeps omitting one would otherwise exhaust all three strategies and then need a corrective re-run. Running the tolerant L4 parse on the last text makes "missing class" repairable in code, as the plan intends.
3. **Missing or empty `rationale` is unrecoverable.** The plan did not classify this case. A placeholder would weaken the audit trail.
4. **Percentage rule refined.** The plan says to rescale "if *all* confidences fall in (1, 100]". The implementation rescales when every *non-zero* value is in [1, 100] and at least one is above 1. Otherwise `{SALES_LEAD: 100, others: 0}` would not be rescaled. A mix of fractions and percentages is still left alone.
5. **The processor does nothing on truncated (`finishReason: 'length'`) and tool-call steps.** Retrying under the same token budget truncates again, and the wrapper's repair path owns truncation. A truncation error the wrapper throws counts as an unrecoverable L4 attempt. Any other error, such as the provider being down after L0, fails the run with the provider's message.
6. **All numeric knobs are validated in the config** and fail fast, rather than being read with `Number(env || default)`.
7. **The agent imports `model-factory` and `logger` directly**, not through the `utils` barrel, which constructs Auth0 at import. This keeps the agent importable in tests.
8. **`message` is optional, and an empty one forces `needsReview`** (see Decision 1). The plan had it required, with "empty ⇒ JUNK with high confidence", which real traffic showed would send about half of the submissions to JUNK.
9. **Input limits match the Let's talk form** (2026-10-22): `firstName`, `lastName` and `companyName` up to 500 characters, `memberId` up to 200, in line with forms-api-v6's form definition. With the earlier 100/100/200/64 limits, a submission the form accepts could fail classification as `LETS_TALK_INVALID_INPUT`. The prompt view isn't affected: it only shows these fields as single lines. The caller is forms-processor-v6 (its ADR 0001).

## Consequences

- Every call is a persisted run. Its input contains the full form (including the email and the member id), so **run-record retention** is the same open follow-up as in ADR 0009.
- `meta.tokenUsage` sums the usage of the response each L4 attempt finally used. Calls on strategies the wrapper abandoned are not visible to the step, so in the rare fallback case the figure is a lower bound. Bedrock's `requestMetadata` cost tags (`role: agent-lets-talk-classifier-agent`) remain the authoritative cost source.
- `StructuredOutputValidator` is generic. Any agent can adopt it, but it must then be called with `errorStrategy: 'warn'`.
- A change to the class set is a contract change for the caller. The output always contains every configured class.
- **The system prompt is not cached.** Haiku 4.5 only caches a prefix of at least 4,096 tokens, and a whole run averaged 3,870 tokens in the live eval, so Bedrock caching (ADR 0003) silently never applies. Each run pays full input price: about $0.004 at Haiku 4.5 list price. Adding classes or examples could push the prompt over the minimum and turn caching on without a code change. Revision 2 adds three classes with examples, so the next live eval should check whether the prompt now crosses that minimum.

## Tests

Unit tests (`pnpm test`) cover the config, the schemas and L1, the processor, the pure helpers, access control and registration. The workflow tests run a real Mastra engine with in-memory LibSQL, the real agent, processor and wrapper, and a scripted model. That way L2 retries, L3 plain-text recovery, L4 repair, the corrective re-run, the 18-call ceiling, the run record and personal-data minimization in the prompt are all exercised end to end.

The live eval is `tests/integration/lets-talk/classification.test.ts` with `tests/fixtures/lets-talk-samples.json`: 42 samples in en/es/pt/fr/de/hi/zh plus mixed-language cases. Revision 2 added 12 of them, covering the new classes and their boundaries (a Wipro team buying for a client account, a big-company employee looking for side work, a Wipro employee asking about training, an empty message). The report now also breaks accuracy down per class. It is opt-in with `LETS_TALK_EVAL=true` and reports a table plus accuracy, L2/L4 rates and tokens per run.

**Live result (2026-10-20, Claude Haiku 4.5 on Bedrock, before revision 2 — four classes, 30 samples):** accuracy 29/30 (96.7%), 0 L2 processor retries, 0 L4 corrective re-runs, 3,870 tokens per run on average. That clears the ≥ 90% accuracy and < 2% L4 criteria. No retries occurred, so the run shows that well-formed answers pass through untouched. It does not exercise the retry path live; that remains covered by the scripted-model unit tests.

Done: live eval (see *Tests*); `ai:letstalk:classify` scope created in Auth0 and granted to the triggering M2M client (2026-10-20).
