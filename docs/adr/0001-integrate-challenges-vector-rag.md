# ADR 0001 — Integrate the TC Challenges Vector RAG ingestion pipeline and retrieval into tc-ai-api

- **Status:** **Accepted**
- **Date:** 2026-08-18 (accepted 2026-08-19)
- **Target branch:** `challenges-rag`
- **Source repository:** `TC-challenges-vector-rag` (`https://git.topcoder.com/Topcoder-Platform/TC-challenges-vector-rag.git`, branch `ch1`)

## Context

`tc-challenges-vector-rag` is a standalone prototype that ingests Topcoder challenge
descriptions from CSV files into PostgreSQL/pgvector and exposes a Mastra agent
("Topcoder Challenge Assistant") that answers challenge questions through a
`vectorQuery` tool. It contains three separable pieces of value:

1. A content-processing and chunking pipeline (HTML→Markdown, BOM/frontmatter
   handling, two-pass markdown-header + size-based chunking with code-block and
   table atomicity, token-safety force-splitting).
2. An idempotent embedding/upsert pipeline (deterministic vector IDs, per-challenge
   delete-then-insert as one transaction, retry with backoff, structured run reports).
3. A retrieval tool with metadata filtering (`skills`, `type`, `track`) plus the
   agent instructions that drive it.

The goal is to move all three into `tc-ai-api` without regressing the existing
`skill-extraction`, `challenge-context`, and `jd-autowrite` workflows.

### Constraints discovered during analysis

| Concern | `tc-challenges-vector-rag` | `tc-ai-api` |
| --- | --- | --- |
| `@mastra/core` | 0.24.3 | 1.57.0 |
| `@mastra/pg` | 0.17.8 | 1.19.0 |
| `@mastra/rag` | 1.3.4 | not installed |
| `zod` | 3.x | 4.x |
| Embeddings | `ollama` client, `nomic-embed-text` (768d) | `ai-sdk-ollama`, `@ai-sdk/amazon-bedrock`, `ai` v6 |
| Config loading | `dotenv` in every module | env injected by `mastra dev` / ECS task definition |
| TypeScript execution | `ts-node` | `mastra` CLI (no `ts-node`/`tsx`) |
| Logging | custom hierarchical logger + `console` interception | `PinoLogger` (`tcAILogger`) |

API verification against the versions actually installed in `tc-ai-api`:

- `upsert({ ..., deleteFilter })` still exists in core 1.57
  (`@mastra/core/dist/vector/types.d.ts`), so the atomic per-challenge replace
  semantics survive the upgrade.
- `MDocument.chunk({ strategy: 'markdown', headers, stripHeaders, maxSize, overlap })`
  matches the current documented signature.
- `PgVector` in pg 1.19 now **requires** an `id`, and additionally supports
  `schemaName`, `disableInit`, `metadataIndexes`, and a native `minScore` on
  `query()`.
- `@mastra/rag@2.5.0` is the release compatible with core 1.57
  (peers: `@mastra/core >=1.0.0 <2.0.0`, `zod ^3.25 || ^4`).
- `@ai-sdk/amazon-bedrock` exposes `.embedding('amazon.titan-embed-text-v2:0')`
  and `ai-sdk-ollama` exposes `.embedding('nomic-embed-text')`, so
  provider-switched embeddings need no new packages; `ai` v6 exports
  `embed`/`embedMany`.

### Two hazards in a verbatim port

1. `src/lib/config.ts` runs `validateConfig()` at module load and **throws** when
   `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` are absent. Imported into the
   `tc-ai-api` server graph, a missing RAG variable would prevent the whole service
   from booting.
2. `Logger.interceptConsole()` globally replaces `console`, which would corrupt
   Pino's structured server logs for every request, not just ingestion.

Neither can be copied as-is.

## Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | Ingestion is primarily a **Mastra workflow** (`challenge-ingestion`) triggered by challenge ID, with a thin CSV CLI wrapping the same workflow for bulk backfill. | `tc-ai-api`'s API surface is auto-generated from registered workflows; a CSV-only CLI is unreachable on ECS Fargate. `fetchChallengeTool` (M2M `GET /v6/challenges/:id`) already returns exactly the fields the CSV supplied, so the Challenge API replaces CSV as the production source while CSV remains available for backfill. One code path serves both. |
| D2 | **Provider-switched embeddings** behind a `createEmbeddingModel` factory mirroring the existing `createModel`: production uses **`amazon.titan-embed-text-v2:0` at 1024 dimensions** (Bedrock), local development uses Ollama `nomic-embed-text` at 768. | Matches how every existing agent selects its provider, and avoids adding the `ollama` package. Titan v2's default 1024 dimensions are kept rather than the reduced 512/256 variants, trading storage for retrieval quality. |
| D3 | Vectors live in the **existing `MASTRA_DB_CONNECTION` database, `ai` schema** (`PgVector` `schemaName`). The `vector` extension is assumed enabled and the runtime role is assumed to hold DDL rights, so `PgVector.createIndex()` performs all schema/table/index creation. | One database, one credential, one backup story; no new connection string to provision per environment, and no hand-maintained DDL script to keep in sync with Mastra's expected table shape. |
| D4 | **Plain port** of the source files, refactored into `tc-ai-api` conventions, as new commits on `challenges-rag`. No `git subtree` merge. | A subtree merge introduces an unrelated root plus a nested layout that would be refactored away immediately; the original history remains available in the source repository. |
| D5 | RAG configuration is resolved and validated **lazily**, never at module load. | Directly mitigates hazard 1: absent RAG variables must not be able to break service startup. |
| D6 | `console` interception is confined to the CLI script and dropped from the server path; the workflow logs through `tcAILogger` and returns a structured report. | Directly mitigates hazard 2. |
| D7 | Index dimension is guarded at runtime via `describeIndex()`, and the index name is environment-overridable (`VECTOR_INDEX_NAME`). | D2 + D3 together mean local (768d Ollama) and production (1024d Titan) write into the same schema; a mismatch must fail loudly rather than corrupt the index. |
| D8 | Retrieval is exposed **twice**: the `challenge-search-agent` for synthesised natural-language answers, and a deterministic `challenge-search` workflow returning **raw ranked results with no LLM synthesis**. | Callers that only need ranked challenges (list UIs, other services, evaluation harnesses) should not pay LLM latency, cost, or non-determinism. Both paths share one tool, so filters and thresholds cannot drift. |
| D9 | Event-driven ingestion (triggering on challenge activation/update) is **deferred**; the first release is on-demand invocation only. | Keeps the initial surface small; the workflow is already idempotent per challenge, so an event trigger can be layered on later without reworking it. |
| D10 | Metadata carries **only `projectId`** as an opaque project reference (nullable, stored as a string). No project attributes are denormalized into metadata, no project text is indexed, and ingestion makes no call to projects-api. Consumers that need project detail resolve it in a **subsequent** call to `GET /v6/projects/:projectId`. | Keeps ingestion dependent on a single upstream API, and eliminates the denormalization staleness problem outright: there is no copied project field that can drift when a project is renamed, re-typed, or reassigned to a different billing account, so no refresh mechanism, no re-ingestion trigger, and no staleness signal are needed. It also keeps customer-identifying commercial data out of a store searched by similarity, leaving authorization where it belongs — on the projects-api call, which is already scope-guarded. `projectId` alone still supports project-scoped filtering (`{ projectId: { $in: [...] } }`) and roll-up of challenge hits by project. |
| D11 | The **Challenge Search API** (`GET /v6/challenges`) is the primary bulk ingestion source, not CSV. It supports `projectId`/`projectIds`, `status`, `approvalStatus`, `types`/`tracks`, `tags`/`groups`, `updatedDateStart`/`updatedDateEnd`, and `page`/`perPage` pagination, enabling project-scoped fan-out, status-filtered corpus building, and incremental sync by `updatedDateStart`. CSV backfill remains as a secondary path for offline/air-gapped environments. | The search endpoint is already M2M-authenticated (`scopes: [READ]`) and returns the full challenge payload (including `description`) when `isLightweight` is false (the default). It eliminates the need to export and ship CSV files, and its `updatedDateStart` filter makes incremental sync a single paginated call rather than a full re-export. |
| D12 | `type` and `track` are stored as **free-form strings**, not Zod enums. `ChallengeType` is a reference table (`model ChallengeType` with `name`, `isActive`, `isTask`, `isLegacy`), not an enum — new types can be added at runtime. `ChallengeTrackEnum` has four values (`DESIGN`, `DATA_SCIENCE`, `DEVELOPMENT`, `QUALITY_ASSURANCE`) but the API returns `track.name` (human-readable, e.g. "Quality Assurance"), not the enum value, and tracks can be deactivated via `isActive`. **Amended (2026-08-27):** both the `type` and `track` *query filters* (on `challengeVectorQueryTool` and the `challenge-search` workflow input) are now Zod enums — `type` restricted to `['Challenge', 'Marathon Match']`, `track` restricted to `['Data Science', 'Design', 'Quality Assurance', 'Development']` — a deliberate reversal of the free-form-filter half of this decision for those two callers. Storage/ingestion is unaffected: it still accepts and indexes any `ChallengeType` value (including `First2Finish`, `Task`) and any `track.name`. | The prototype hardcoded `['Challenge', 'First2Finish', 'Marathon Match']` as a Zod enum for type and `['Data Science', 'Design', 'Development']` for track, missing `Quality Assurance` and rejecting any future type. Treating both as strings (with the known values documented for reference but not enforced) is forward-compatible with the reference-table model and avoids ingestion failures when a new type or track is added. The amendment narrows the *query* surface to the values users actually filter by in practice, accepting that a future new `ChallengeType` (or `First2Finish`/`Task`) becomes unfilterable via `type` until the enum is revisited, and that a deactivated or renamed track (`ChallengeTrackEnum`'s `isActive` flag) would need the same revisit for `track` — it does not touch ingestion, so no re-indexing risk. |

## Implementation plan

### Phase 0 — Baseline and dependencies

1. Record a green baseline on `challenges-rag`: `pnpm lint`, `pnpm test`, `pnpm run build`.
2. `pnpm add @mastra/rag@^2.5.0 turndown js-tiktoken csv-parse`
   and `pnpm add -D @types/turndown tsx`.
   Deliberately **not** added: `ollama` (use `ai-sdk-ollama`'s `.embedding()` with
   `embedMany` from `ai`), `dotenv` (Node `--env-file`), `commander`
   (use `node:util` `parseArgs`).
3. Confirm against the freshly installed `@mastra/rag` types and embedded docs
   (`node_modules/@mastra/rag/dist/*.d.ts`, `dist/docs`) that `MDocument.chunk()`
   returns an **array of chunks, each exposing `.text`** — the documented pipeline is
   `chunks.map(chunk => chunk.text)`, which is also why the stored metadata field is
   named `text` (see Data model) — and that the package is zod-4 compatible. Adjust
   the ported chunking code to whatever the installed version actually returns.

### Phase 1 — Config and embedding provider (additive)

- **`src/config/rag.config.ts`** — replaces `src/lib/config.ts`. Exports
  `getRagConfig()`, resolved and validated on first RAG use (per D5); **no
  module-load throw**. Holds a provider/model → `{ dimension, maxContextWindow }`
  map keyed `provider/modelId` — `TC-Ollama/nomic-embed-text` → 768/2048 (local
  default) and `AWSBedrock/amazon.titan-embed-text-v2:0` → 1024/8192 (production
  default, per D2) — chunk sizes,
  `VECTOR_SEARCH_THRESHOLD`, `VECTOR_INDEX_NAME` (SQL-identifier validated, as in
  the original), `RAG_TOP_K`. Per D12, `type` and `track` are **not** hardcoded
  enums at the storage/config layer — the config documents the known
  `ChallengeTrackEnum` values (`DESIGN`, `DATA_SCIENCE`, `DEVELOPMENT`,
  `QUALITY_ASSURANCE`) and the current `ChallengeType` reference-table names for
  readability but does not enforce them at the storage/config layer. The `type`
  and `track` query filters are Zod enums restricted to `['Challenge', 'Marathon
  Match']` and `['Data Science', 'Design', 'Quality Assurance', 'Development']`
  respectively (D12 amendment, 2026-08-27) — narrower than storage on purpose.
  Database settings reuse `MASTRA_DB_CONNECTION` and `MASTRA_DB_SCHEMA` (default
  `ai`).
- **`src/utils/providers/embedding-factory.ts`** — `createEmbeddingModel(provider, modelId)`
  switch mirroring `createModel`, using `ollama.embedding(modelId)` and
  `createBedrockProvider().embedding(modelId)`, logging via `tcAILogger`. Re-exported
  from `src/utils/index.ts`.

New environment keys, all optional with defaults: `RAG_EMBEDDING_PROVIDER`,
`RAG_EMBEDDING_MODEL_ID`, `VECTOR_INDEX_NAME`, `VECTOR_SEARCH_THRESHOLD`,
`RAG_CHUNK_MAX_SIZE`, `RAG_CHUNK_OVERLAP`, `RAG_TOP_K`,
`CHALLENGE_SEARCH_AI_PROVIDER`, `CHALLENGE_SEARCH_AI_MODEL_ID`.

### Phase 2 — Vector store

- **`src/mastra/vector/challenge-vector-store.ts`** — lazy singleton
  `getChallengeVectorStore()` returning
  `new PgVector({ id: 'tc-ai-api-rag-vector', connectionString: process.env.MASTRA_DB_CONNECTION!, schemaName: process.env.MASTRA_DB_SCHEMA || 'ai' })`
  (pg 1.19 requires `id`), plus `ensureChallengeIndex()` which idempotently calls
  `createIndex({ indexName, dimension, metric: 'cosine', indexConfig: { type: 'hnsw' }, metadataIndexes: ['challengeId', 'projectId', 'track'] })`
  and enforces the D7 dimension guard: compare `describeIndex().dimension` against
  the configured model's dimension and throw an actionable error
  ("index X is 768-dim, configured model is 1024-dim — set `VECTOR_INDEX_NAME` or
  reindex"). No `disconnect()` on request paths (singleton, as in the original).
- Per D3, all DDL (schema, `vector` extension, table, indexes) is delegated to
  `PgVector.createIndex()`; the source repository's `docker/init-db.sh` and
  `init-db.sql` are **not ported**. HNSW replaces the original IVFFlat (better recall
  at this data size, and `createIndex` manages its lifecycle). The library still
  honours `MASTRA_DISABLE_STORAGE_INIT` should an environment ever need DDL
  suppressed, but no code path depends on it.
- `docker/docker-compose.yml` is carried over unchanged for local development
  (`pgvector/pgvector:pg16`), minus the `init-db` volume mounts.

### Phase 3 — Port the pure library code, with unit tests

Straight ports (pure, no I/O, no `console`):

- **`src/mastra/rag/content.ts`** ← `src/lib/content.ts` — `normalizeLineEndings`,
  BOM-aware `trim`, `stripFrontmatter`, `htmlToMarkdown` (Turndown), `parseSkills`,
  `enrichChunksWithChallengeName`.
- **`src/mastra/rag/chunking.ts`** ← the two-pass chunking currently inlined in
  `ingest.ts`, extracted as
  `chunkChallengeDescription(content, { maxSize, overlap, contextWindow })`
  returning `{ chunks, forceSplits }` instead of mutating a report and writing to
  `console`. Preserves the markdown-header pass, the code-block/table atomicity
  check, the `js-tiktoken` `cl100k_base` safety check, and the force-split fallback.
- **`src/mastra/rag/ingestion-utils.ts`** ← `src/lib/utils.ts` minus `confirmAction`
  (readline belongs to the CLI): `withRetry`, `sleep`, `REQUIRED_COLUMNS`,
  `validateColumns`, `validateRecord`, `generateDeterministicId`.
- **`src/mastra/rag/types.ts`** ← `src/lib/types.ts`, with types derived from
  `getRagConfig()`.

**Rename to apply while porting:** the metadata field holding the chunk text is
`text`, not the prototype's `content`. It appears in the chunk-metadata builder, the
query tool, and every test fixture, so it is a mechanical rename applied once here and
carried through Phases 4 and 5 — see "Why the chunk text field is `text`, not
`content`" under Data model for the reasoning. There is no populated table to migrate,
so this must be settled before the first ingestion run rather than after.

Unit tests colocated as `src/**/*.test.ts` (matching `vitest.config.ts`): content
pipeline edge cases (CRLF, BOM, frontmatter, HTML→Markdown, skills dedup); chunking
(small-chunk passthrough, oversized text split, code block kept atomic, oversized
code block force-split); `generateDeterministicId` stability; validators;
`withRetry` backoff; config dimension mapping including the unknown-model error.

### Phase 4 — Ingestion workflow (production API surface)

**`src/mastra/workflows/challenge/challenge-ingestion-workflow.ts`**, id
`challenge-ingestion`, registered in `src/mastra/index.ts` under `workflows`:

- Input `{ challengeId?: uuid, challenge?: <inline record>, dryRun?: boolean }`;
  exactly one source required.
- Step `resolve-challenge` — for `challengeId`, reuse `fetchChallengeTool` and
  normalise its output (`name`, `description`, `descriptionFormat`, `track`, `type`,
  `skills[]`, `projectId`, `groups[]`) into the `ChallengeRecord` shape the
  CSV produced; for an inline `challenge`, validate with `validateRecord`.
  Per D10, `projectId` is carried through as a **string reference only** — the step
  makes no call to projects-api and denormalizes no project attributes.
  `Challenge.projectId` is `Int?` in challenge-api-v6, so it is nullable: a challenge
  with no project is still indexed and searchable, just not project-filterable.
- Step `chunk-and-embed` — `processDescription` → `chunkChallengeDescription` →
  `enrichChunksWithChallengeName` →
  `embedMany({ model: createEmbeddingModel(...), values })` wrapped in `withRetry`,
  retaining the original's error-context enrichment (embedding vs database failure,
  chunk count, total characters, longest chunk). The embedded text is the challenge's
  public `description` only — `privateDescription` is not indexed, and per D10 no
  project text is concatenated in.
- Step `upsert-vectors` — `ensureChallengeIndex()`, then
  `upsert({ indexName, vectors, metadata, ids, deleteFilter: { challengeId } })`,
  preserving atomic per-challenge replacement. Skipped when `dryRun`.
- Output — a per-challenge report (`chunks`, `forceSplits`, `dryRun`, `skipped`,
  `projectId`) the CLI aggregates into the same `report.json` structure.
- Logging — `tcAILogger` with `[challenge-ingestion:<step>]` prefixes, matching
  `challenge-context-workflow`. No `console` interception (D6).

Supporting changes:

- **`src/mastra/tools/challenge/fetch-challenge-tool.ts`** (modified) — its output
  schema currently drops `projectId`. Add `projectId: z.number().optional()` and
  `groups: z.array(z.string()).optional()` and pass them through. Additive and
  optional, so `challenge-context-workflow`, its only other consumer, is unaffected.
- **`src/mastra/tools/challenge/search-challenges-tool.ts`** (new, per D11) — wraps
  `GET /v6/challenges` with M2M auth from the existing `M2MService`. Accepts the
  search filters the ingestion pipeline needs: `projectId` / `projectIds`,
  `status`, `approvalStatus`, `types` / `tracks`, `tags`, `groups`,
  `updatedDateStart` / `updatedDateEnd`, `ids`, `page`, `perPage`, `sortBy`,
  `sortOrder`. Always sets `isLightweight: false`, because the lightweight response
  omits `description`, which is the field being indexed. Note that this also returns
  `privateDescription`; the ingestion workflow **discards it** and embeds only the
  public `description`. Returns `{ challenges: [...], total, page, perPage }` so
  callers can paginate. This tool is the backbone of bulk ingestion and incremental
  sync, replacing the CSV file as the primary challenge source.
- **`src/mastra/workflows/challenge/challenge-bulk-ingestion-workflow.ts`** (new),
  id `challenge-bulk-ingestion`, per D11 — paginates through `searchChallengesTool`
  results and invokes `challenge-ingestion` for each challenge, optionally filtering
  by `status` (default: only `ACTIVE` and `COMPLETED`), `projectId`, `types`,
  `tracks`, `tags`, `groups`, or `updatedDateStart` (for incremental sync). Supports
  `dryRun` and `concurrency` (default 3, bounded to avoid overwhelming the embedding
  provider). Aggregates per-challenge reports into the same `report.json` structure
  the CLI produces. This is the production bulk-ingestion surface; the CSV CLI
  becomes secondary. Passing `projectId` makes this the natural bulk unit for a
  project-wide backfill, replacing the need for a separate project-ingestion
  workflow.

### Phase 5 — Retrieval: shared tool, deterministic workflow, and agent

- **`src/mastra/tools/challenge/challenge-vector-query-tool.ts`** ← `src/lib/tools.ts`.
  The original `query` / `skills` / `type` / `track` inputs plus `projectId` (the
  only project dimension, per D10) and the challenge dimension `groups` —
  all composed into the same `$and` filter array, embedding through the factory
  and store through the shared singleton.
  Per D12, `type` and `track` are `z.string().optional()` (not enums), since the
  set of valid values is dynamic (reference tables, not fixed enums).
  The relevance threshold stays **post-filtered in the tool** rather than passed as
  `query({ minScore })` — see "Query planning consequences" below, where passing
  `minScore` is shown to forfeit the HNSW fast path. The original's warning when
  every result falls below threshold is kept. The
  `z.preprocess` workaround for the Ollama `optional`→`nullable` schema-compat issue
  is re-tested under zod 4 + core 1.57 and kept only if the failure still
  reproduces, with a comment explaining the constraint.
- **`src/mastra/agents/challenge/challenge-search-agent.ts`** ← the "Topcoder
  Challenge Assistant" instructions verbatim, constructed the `tc-ai-api` way:
  `createModel(process.env.CHALLENGE_SEARCH_AI_PROVIDER || 'AWSBedrock', process.env.CHALLENGE_SEARCH_AI_MODEL_ID || <haiku default>, 'challenge-search-agent')`,
  `tools: { challengeVectorQueryTool }`. The agent instructions are updated from the
  prototype to mention the added `groups` filter dimension in the
  tool-usage strategy, so the LLM can infer it from natural language. `projectId`
  is deliberately *not* something the LLM is asked to guess — it is an opaque
  identifier, so it is expected to arrive from the caller's context rather than from
  the query text. Registered under `agents` (adds routes only; no effect on
  existing agents).
- **`src/mastra/workflows/challenge/challenge-search-workflow.ts`**, id
  `challenge-search`, registered under `workflows` — the deterministic path from D8,
  with no agent and no LLM call:
  - Input `{ query?: string, skills?: string[], type?: 'Challenge' | 'Marathon Match', track?: 'Data Science' | 'Design' | 'Quality Assurance' | 'Development', groups?: string[], projectId?: string | string[], groupBy?: 'chunk' | 'challenge' | 'project', topK?: number, minScore?: number }` (`type`/`track` enums per the D12 amendment above).
    Filters are supplied explicitly by the caller; unlike the agent path, nothing is
    inferred from natural language.
  - Single step `search-challenges` executing `challengeVectorQueryTool` with the
    same store, embedding factory, and `$and` filter composition, so agent and
    workflow retrieval cannot diverge.
  - Output: ranked `results[]` (`text`, `score`, `metadata`) plus `count`,
    ordered by descending score and passed through verbatim — no summarisation,
    reranking, or rewriting. `topK` / `minScore` default from `getRagConfig()`.
  - `groupBy` controls aggregation, defaulting to `challenge`: chunk-level hits are
    grouped by `challengeId` (best chunk score becomes the challenge score,
    contributing chunks listed underneath) so list consumers get one entry per
    challenge; `project` rolls the same hits up by `projectId`, which is the
    project-based results path from D10 — the grouping key is the bare reference, so
    a consumer that needs project names resolves them once per distinct `projectId`
    in a follow-up projects-api call rather than reading them from the vector
    metadata; `chunk` returns raw hits ungrouped.
  - Because a `projectId` filter alone answers "everything indexed for this
    project", the workflow permits `query` to be omitted when at least one filter
    is present, falling back to `query({ filter })` without a `queryVector` —
    `@mastra/pg` supports metadata-only retrieval, ordered by `vector_id` with
    `score: 0`.
- **`src/mastra/tools/project/fetch-project-tool.ts`** (new, optional) — the
  "subsequent call" side of D10: `GET ${TC_API_BASE}/v6/projects/:projectId` with an
  M2M token from the existing `M2MService`, 15 s timeout, and a zod output schema.
  It is a **retrieval-time enrichment** tool, not part of ingestion: a caller (or the
  search agent) that has a `projectId` from a hit and needs the project's name,
  status, or tech stack fetches it here, on demand and under the caller's own
  authorization. Verified against projects-api-v6: the endpoint's Prisma query
  already includes `details.projectData` and `techstack` in the default response, and
  the optional `fields` query parameter can narrow it. Note that `Project.id`,
  `billingAccountId`, and `directProjectId` are Prisma `BigInt`, which **throws on
  `JSON.stringify`** ("Do not know how to serialize a BigInt"), so the tool must
  convert them to strings explicitly. Ship this only if a consumer actually needs it;
  nothing in the ingestion or retrieval path depends on it.

### Phase 6 — CSV backfill CLI (secondary path, per D11)

The CSV CLI is now the **secondary** ingestion path. The primary bulk path is the
`challenge-bulk-ingestion` workflow (Phase 4), which paginates the Challenge Search
API. The CLI remains for offline/air-gapped environments and for importing
historical CSV exports that predate the search API.

- **`src/scripts/ingestion-logger.ts`** ← `src/lib/logger.ts`. Hierarchical child
  loggers and per-run `logs/ingestion-<ts>/{output.log,error.log,report.json}`
  preserved; `interceptConsole` dropped.
- **`src/scripts/ingest-challenges.ts`** — `node:util` `parseArgs` for `--folder`,
  `--file`, `--dry-run`, `--clear-all` (readline confirmation, then
  `deleteVectors({ filter })` instead of the original's raw `pool.query` behind a
  `@ts-ignore`), CSV streaming via `csv-parse`, column validation on the first
  record, and per-record invocation of `challenge-ingestion` through
  `createRunAsync()` so CLI and API share one code path. Aggregates per-file stats
  into the same `report.json` shape.
- **`src/scripts/sync-challenges.ts`** (new, per D11) — a thin CLI wrapper around
  `challenge-bulk-ingestion` that accepts `--project-id`, `--status`, `--types`,
  `--tracks`, `--updated-since`, `--dry-run`, `--concurrency`. This is the
  incremental-sync and project-scoped backfill script for operators who prefer CLI
  over API calls.
- `package.json`: `"ingest": "tsx --env-file=.env src/scripts/ingest-challenges.ts"`
  and `"sync": "tsx --env-file=.env src/scripts/sync-challenges.ts"`.
  Add `logs/` to `.gitignore`. Trim one small CSV into `tests/fixtures/` for tests;
  bulk CSVs stay out of git.

### Phase 7 — Configuration surface, documentation, validation

- `.env.sample` and `.env.sh` — add the new keys with safe local defaults.
- `README.md` — new sections in the existing style: RAG overview, ingestion
  (workflow and CLI), retrieval tool and agent, metadata schema, chunking strategy,
  embedding-model/dimension table, database bootstrap, plus added rows under
  **Environment Variables** and **API Surface**. Adapted from the source README
  rather than rewritten.
- `Dockerfile` / `.circleci` — expected to need no change (the image build already
  runs lint, test, and build). Verify `turndown` and `@mastra/rag` bundle cleanly
  into `.mastra/output`; only if the build breaks, add them to `bundler.externals` /
  `transpilePackages` in `src/mastra/index.ts`.
- Validation gate — `pnpm lint`, `pnpm test`, `pnpm run build`; then `pnpm dev` and
  in Studio: (a) run `challenge-ingestion` for one real challenge ID, (b) run
  `challenge-bulk-ingestion` with `status: 'ACTIVE'` and a small `perPage` to confirm
  search-API pagination and per-challenge ingestion, (c) run `challenge-search` with
  explicit filters (including `projectId` and `skills`) and confirm identical
  ranked results across repeated runs, (d) query via `challenge-search-agent` with a
  natural-language query that implies a track and skill filter (e.g. "QA challenges
  about React"), (e) re-run `skill-extraction`, `challenge-context`, and `jd-autowrite` to
  confirm no regression; then `pnpm run ingest -- --file <csv> --dry-run` followed by
  a live run against a local pgvector container, and `pnpm run sync -- --project-id
  <id> --dry-run` to exercise the search-API path.

## File-level mapping

| Source (`tc-challenges-vector-rag`) | Destination (`tc-ai-api`) | Change |
| --- | --- | --- |
| `src/lib/config.ts` | `src/config/rag.config.ts` | Lazy `getRagConfig()`, no module-load throw; reuses `MASTRA_DB_*`; provider-keyed model map |
| `src/lib/llm.ts` | `src/utils/providers/embedding-factory.ts` | Replaced by a `createModel`-style factory; `ollama` package dropped |
| `src/lib/db.ts` | `src/mastra/vector/challenge-vector-store.ts` | Adds `id`, `schemaName`, `ensureChallengeIndex()`, dimension guard |
| `src/lib/content.ts` | `src/mastra/rag/content.ts` | Verbatim (pure) |
| `src/lib/utils.ts` | `src/mastra/rag/ingestion-utils.ts` | `confirmAction` moved to the CLI |
| `src/lib/types.ts` | `src/mastra/rag/types.ts` | zod 4 / config-derived types |
| `src/lib/tools.ts` | `src/mastra/tools/challenge/challenge-vector-query-tool.ts` | Embedding factory, shared store, post-filtered `minScore`; chunk text field renamed `content` → `text`; shared by the agent and the deterministic workflow |
| — (new, D8) | `src/mastra/workflows/challenge/challenge-search-workflow.ts` | Deterministic raw ranked retrieval, no LLM |
| — (new, D10, optional) | `src/mastra/tools/project/fetch-project-tool.ts` | Retrieval-time enrichment only: resolves a `projectId` from a hit to project detail on demand; **not** used during ingestion |
| existing | `src/mastra/tools/challenge/fetch-challenge-tool.ts` | **Modified**: pass through `projectId`, `groups` (additive, optional) |
| — (new, D11) | `src/mastra/tools/challenge/search-challenges-tool.ts` | M2M `GET /v6/challenges` with filters and pagination |
| — (new, D11) | `src/mastra/workflows/challenge/challenge-bulk-ingestion-workflow.ts` | Paginated bulk ingestion via search API; incremental sync via `updatedDateStart`; `projectId` gives project-wide backfill |
| `src/lib/logger.ts` | `src/scripts/ingestion-logger.ts` | `interceptConsole` removed; CLI-only |
| `src/scripts/ingest.ts` (chunking) | `src/mastra/rag/chunking.ts` | Extracted as a pure, testable function |
| `src/scripts/ingest.ts` (pipeline) | `src/mastra/workflows/challenge/challenge-ingestion-workflow.ts` | Becomes a Mastra workflow; CSV source replaced by `fetchChallengeTool`; chunk metadata written under `text` |
| `src/scripts/ingest.ts` (CLI) | `src/scripts/ingest-challenges.ts` | `parseArgs`, invokes the workflow |
| `src/mastra/index.ts` (agent) | `src/mastra/agents/challenge/challenge-search-agent.ts` | Instructions kept; `createModel` provider pattern |
| `src/scripts/ask.ts` | — | Dropped; the `challenge-search` workflow, Studio, and the generated API replace it |
| `docker/init-db.{sh,sql}` | — | Dropped; `PgVector.createIndex()` performs all DDL (D3) |
| `docker/docker-compose.yml` | `docker/docker-compose.yml` | Local pgvector for development only, without the `init-db` mounts |
| `.env`, `data/*.csv` | — | Not copied (credentials / bulk data) |

## Data model — the table that stores the embeddings

Because D3 delegates DDL to `PgVector.createIndex()`, the physical table is defined
by `@mastra/pg` 1.19, **not** by the prototype's `docker/init-db.sql`. The statement
issued (verified in `node_modules/@mastra/pg/dist/index.js`) is:

```sql
CREATE TABLE IF NOT EXISTS "ai"."challenge_embeddings" (
  id        SERIAL PRIMARY KEY,
  vector_id TEXT UNIQUE NOT NULL,
  embedding vector(1024),          -- 768 locally with nomic-embed-text
  metadata  JSONB DEFAULT '{}'::jsonb
);
```

One table holds one index. The table name **is** the `indexName` passed to
`createIndex()` / `upsert()` / `query()`, qualified by `MASTRA_DB_SCHEMA` (`ai`), so
`VECTOR_INDEX_NAME` names a table rather than an index. Both identifiers pass through
`parseSqlIdentifier`, which is why the config keeps the original's SQL-identifier
validation.

### Columns

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `SERIAL PRIMARY KEY` | Surrogate key, unused by application code. Added by Mastra; the prototype had no such column. |
| `vector_id` | `TEXT UNIQUE NOT NULL` | The application key and the `ON CONFLICT` target. Populated exactly as the prototype did, by `generateDeterministicId()` over `<challengeId>-<chunkText>` — a SHA-256 hash rendered UUID-shaped — so identical content re-ingests to the same row. Demoted from primary key to unique constraint relative to the prototype; semantics are unchanged. |
| `embedding` | `vector(N)` | N is fixed at table creation from the configured model: 1024 for `amazon.titan-embed-text-v2:0`, 768 for `nomic-embed-text`. This is the column the D7 guard protects. |
| `metadata` | `JSONB DEFAULT '{}'` | Everything else, including the chunk text. |

**There is no `created_at` column.** The prototype's
`created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP` does not exist in Mastra's schema
and there is no hook to add one without taking over the DDL. To preserve the ability
to audit and re-ingest by age, the ingestion workflow therefore adds an
`ingestedAt` (ISO-8601 string) field to `metadata`.

### Metadata document

There is no separate text column, so the chunk text lives in `metadata.text`, renamed
from the prototype's `metadata.content` for the reasons given after the example. Every
row is a challenge chunk, and the document is a single flat set of fields — the chunk,
the challenge, and (per D10) a bare `projectId` reference:

| Field | Type | Purpose |
| --- | --- | --- |
| `challengeId` | `string` | Challenge UUID. The `deleteFilter` key for per-challenge replacement. |
| `name` | `string` | Challenge title. |
| `type` | `string` | Free-form from the `ChallengeType` reference table (per D12). Known: "Challenge", "First2Finish", "Marathon Match", "Task", etc. Filterable. |
| `track` | `string` | `ChallengeTrack.name` (human-readable, per D12). Known: "Design", "Data Science", "Development", "Quality Assurance". Filterable. |
| `skills` | `string[]` | Filterable via `$in`. |
| `groups` | `string[]` | Challenge groups. Filterable via `$in`. |
| `projectId` | `string \| null` | The **only** project field (D10), from `Challenge.projectId`. `null` when the challenge has no project. Filterable, including `{ projectId: { $in: [...] } }` for a set of projects. |
| `chunkIndex` | `number` | 1-based position within the challenge description. |
| `totalChunks` | `number` | Chunk count for the challenge, for reassembly. |
| `text` | `string` | The chunk text, prefixed with `# Challenge: <name>`. Named `text`, **not** `content`, to match the Mastra convention. |
| `ingestedAt` | `string` | ISO-8601. **New**, compensating for the missing `created_at`. |

One type-mapping rule matters: `projectId` is stored as a **string**, not a number,
because `@mastra/pg` compares scalars as text (`metadata#>>'{key}' = $n`), so a
numeric literal in a filter would silently fail to match a JSON number. Callers
therefore always filter with a string value.

Example row:

```json
{
  "vector_id": "a3f1c8d2-9b4e-7c15-2f8a-6d0e4b1c9a72",
  "embedding": "[0.0231, -0.0114, ...]",
  "metadata": {
    "challengeId": "30401234-0000-4000-8000-000000000001",
    "name": "Build a Realtime Energy Dashboard",
    "type": "Challenge",
    "track": "Development",
    "skills": ["React", "TypeScript", "Node.js"],
    "groups": ["acme-internal"],
    "chunkIndex": 3,
    "totalChunks": 11,
    "text": "# Challenge: Build a Realtime Energy Dashboard\n\n## Requirements\nThe dashboard must ...",
    "ingestedAt": "2026-08-18T09:14:02.511Z",
    "projectId": "17423"
  }
}
```

Everything a consumer might want about project `17423` — its name, status, type,
billing account, customer, and tech stack — is deliberately absent. It is one
`GET /v6/projects/17423` away, resolved once per distinct `projectId` in a result
set rather than stored redundantly on every chunk of every challenge in the project.

#### Why the chunk text field is `text`, not `content`

The prototype stores the chunk in `metadata.content`. This plan renames it to
`metadata.text` when the code is ported, for three reasons:

- **`rerank()` requires it.** The `@mastra/rag` reference states that for semantic
  scoring during reranking, "each result must include the text content in its
  `metadata.text` field". Reranking is out of scope for this release, but a field
  name is the cheapest possible thing to get right up front — under `content` the
  feature would silently score against nothing rather than fail loudly.
- **It matches the rest of the ecosystem.** `MDocument.chunk()` returns chunks whose
  text is on `chunk.text`, and every documented pipeline reads
  `chunks.map(chunk => chunk.text)`. Storing that under a different key means every
  ingestion and retrieval site has to cross the two names over.
- **It is free right now.** `tc-ai-api` creates its own index under
  `VECTOR_INDEX_NAME`, so there is no populated table to migrate and no consumer
  outside this plan reading the field. The same rename after go-live would mean
  either rewriting every row's metadata or carrying a mapping shim permanently.

The rename is applied consistently: `challengeVectorQueryTool` and the
`challenge-search` workflow also return `text` in their result objects, so there is
no point in the pipeline where the two names have to be mapped onto each other.

### Indexes actually created

| Index | Definition | Created by |
| --- | --- | --- |
| `challenge_embeddings_pkey` | btree on `id` | `SERIAL PRIMARY KEY` |
| `challenge_embeddings_vector_id_key` | unique btree on `vector_id` | `UNIQUE` constraint |
| `"challenge_embeddings_vector_idx"` | `USING hnsw (embedding vector_cosine_ops) WITH (m = 8, ef_construction = 32)` | `createIndex({ indexConfig: { type: 'hnsw' } })`; the name is always `<indexName>_vector_idx` |
| `"challenge_embeddi..._md_<hash>_idx"` | one btree per field on `((metadata->>'<field>'))`, built `CONCURRENTLY` | `metadataIndexes: ['challengeId', 'projectId', 'track']`; each name is truncated to 55 chars plus an h32 hash of the field |

`challengeId` is indexed because it is the `deleteFilter` key on every upsert, so it
is touched by every write. `projectId` is indexed because it drives the maintenance
and reporting paths — per-project delete, per-project re-ingest, per-project counting
— where a btree genuinely helps. `track` is indexed as the most common low-cardinality
retrieval filter. None of them speed up filtered vector *search* (the filter still
runs inside the CTE before the vector index), for the reason given next.

Two deviations from the prototype's index set are deliberate and worth noting:

- The prototype's **GIN index on `metadata`** is not created. Mastra's
  `metadataIndexes` option only emits btree indexes on `(metadata->>'field')`.
- The prototype's **GIN index on `metadata->'skills'` would be dead weight** under
  Mastra's filter builder. A `{ skills: { $in: [...] } }` filter compiles to a
  correlated subquery — `EXISTS (SELECT 1 FROM jsonb_array_elements_text(metadata->'skills') elem WHERE elem = ANY($n::text[]))`
  — rather than an indexable containment operator such as `@>` or `?|`, so no GIN
  index can serve it. Porting that index would add write cost for zero read benefit,
  so it is dropped.

### Query planning consequences

Reading the SQL that `@mastra/pg` generates shows `query()` has two shapes, and which
one you get is not obvious from the API:

1. **ANN fast path**, used only when the index is HNSW **and** no `filter` is given
   **and** `minScore <= 0`: `ORDER BY <distance operator> LIMIT $2` inside the CTE, so
   the HNSW index drives the scan.
2. **Exact scan**, used in every other case: the CTE computes the score for *all*
   rows matching the metadata filter with no inner `LIMIT`, and ordering happens on
   the computed `score` alias in the outer query, so the vector index cannot be used.

Two implications:

- Passing `minScore` — even a small positive threshold — pushes an otherwise
  unfiltered query off the fast path onto a full scan. Hence the tool applies the
  threshold in application code after retrieval (Phase 5) instead of delegating it
  to `query()`.
- Any metadata-filtered search is an exact scan by construction. That is acceptable
  at the expected corpus size (a few thousand challenges × ~10 chunks, so tens of
  thousands of rows), and the `challengeId` btree index only helps the
  `deleteFilter` path, not filtered search. If the corpus grows by an order of
  magnitude, filtered search latency should be re-measured before adding
  partitioning or a pre-filter strategy.

### Write path

`upsert()` wraps everything in a single transaction:

```
BEGIN
  DELETE FROM "ai"."challenge_embeddings" WHERE <deleteFilter>   -- challengeId = $1
  INSERT ... ON CONFLICT (vector_id) DO UPDATE SET embedding = ..., metadata = ...
  -- one INSERT statement per vector
COMMIT
```

This confirms the prototype's atomicity claim survives the upgrade: a failed insert
rolls the delete back, so a challenge is never left partially indexed. Note that
vectors are inserted one statement per row rather than in a single batched
statement, which is the dominant cost in bulk backfill; the CLI should therefore
size its per-challenge batches with that round-trip cost in mind.

### No metadata refresh path is needed

Because `projectId` is an immutable reference rather than a copy of project state
(D10), the update problem the denormalized design would have created does not exist:
renaming a project, changing its status, or reassigning it to a different billing
account leaves nothing in the vector store to fix. Metadata is only ever rewritten by
re-ingesting the challenge, which the `deleteFilter` upsert already handles atomically.

Worth recording for anyone who later reconsiders this: `updateVector({ filter, update: { metadata } })`
would **not** have been a usable refresh mechanism. It compiles to
`UPDATE ... SET metadata = $1::jsonb WHERE <filter>`, replacing the entire document on
every matching row — destroying `text`, `chunkIndex`, and `challengeId` — so a
partial metadata update would have required dropping to raw SQL
(`SET metadata = metadata || $1::jsonb`) through the `pgVector.pool` escape hatch.
Avoiding that is part of the value of D10.

### Sizing

At 1024 dimensions a vector occupies ~4 KB (`4 bytes × 1024`), and a chunk's
metadata is dominated by `text` — roughly 0.6–0.8 KB given the 512-character chunk
target, with the scalar fields (including `projectId`) adding well under 0.1 KB.
Budget ~5 KB per chunk, so ~50 KB per challenge at ~10 chunks, or ~500 MB per 10,000
challenges before HNSW index overhead (which roughly adds another 20–40% for
`m = 8`).

## Consequences

**Positive**

- Ingestion becomes reachable in production over the authenticated API and reuses
  the existing M2M Challenge API integration instead of manually exported CSVs.
- One vector store, one database credential, one deployment; no new
  infrastructure component.
- The chunking and content pipeline become pure, unit-tested functions rather than
  logic embedded in a script.
- CLI and API share a single ingestion implementation, so backfill and incremental
  ingestion cannot drift.
- Retrieval serves both synthesised answers and raw ranked results from one tool,
  so consumers that cannot tolerate LLM latency or non-determinism are covered
  without a second retrieval implementation.
- Project-scoped retrieval needs no join and no denormalization: a `projectId` filter
  (or `{ projectId: { $in: [...] } }` for a set of projects) answers "everything
  indexed for this project", and challenge hits roll up by `projectId`. Anything
  richer resolves through projects-api on demand, so the vector store never holds a
  stale copy of project state (D10).
- The vector store holds only challenge content plus identifiers, so no
  customer-identifying or commercial data (billing account, SOW number, cost centre)
  enters a store that is queried by similarity. Authorization for project data stays
  on the projects-api call that already enforces it.
- No hand-maintained DDL script: the vector table and index shape stay whatever the
  installed `@mastra/pg` expects, removing a class of upgrade breakage.
- Bulk ingestion and incremental sync work through the existing Challenge Search
  API (D11), so no CSV export/import pipeline is needed in production. The
  `updatedDateStart` filter makes incremental sync a single paginated call.
- `type` and `track` are forward-compatible with the reference-table model (D12):
  adding a new `ChallengeType` or reactivating a retired `ChallengeTrack` does not
  require a code change or redeployment.

**Negative / accepted costs**

- Ollama (768d) and Bedrock Titan (1024d) produce incompatible indexes in the same
  schema. Mitigated by an environment-specific `VECTOR_INDEX_NAME` and the runtime
  dimension guard, but switching a given environment's embedding provider requires
  a full reindex.
- Delegating DDL to `createIndex()` means the runtime database role must keep its
  DDL privileges; if they are ever revoked, first startup against a fresh index
  fails until the table is created out of band.
- Titan v2 at 1024 dimensions costs ~33% more index storage than the local 768d
  model and ~2x the 512d reduced variant; accepted for retrieval quality.
- Mastra's table has no `created_at`; ingestion recency is tracked in
  `metadata.ingestedAt` instead, which is not indexed and so is unsuitable for
  range queries without an added expression index.
- Metadata-filtered search is an exact scan (no ANN index usage) by construction in
  `@mastra/pg`. Acceptable at the expected corpus size, but a scaling ceiling to
  revisit rather than ignore.
- Project attributes are not filterable in the vector query (D10). Answering
  "everything Topcoder built for this customer" becomes a two-step operation: resolve
  the customer's projects from projects-api, then filter the vector query with
  `{ projectId: { $in: [...] } }`. That is more work for the caller than a single
  `billingAccountId` filter would have been, and the `$in` list grows with the
  customer's project count.
- Project text (`Project.description`, `projectFullText`) is not semantically
  searchable at all. If project-level semantic search turns out to be a requirement,
  it needs its own decision — indexing projects as a second document kind was
  considered and rejected here as unnecessary scope.
- Consumers that render project names alongside results must make N extra API calls
  (one per distinct `projectId` in a page of results). Cheap and cacheable, but it is
  latency the denormalized design would not have had.
- Original commit history from the prototype is not carried over (D4).
- Four new runtime dependencies (`@mastra/rag`, `turndown`, `js-tiktoken`,
  `csv-parse`) enter the production bundle.

**Out of scope**

Everything below is deliberately deferred rather than rejected. `@mastra/rag` is
already entering the dependency set for `MDocument.chunk()`, so adopting the first two
later is a retrieval-logic change — no new dependency, no schema change.

**Reranking.** `rerank(results, query, model, { weights, topK })` from `@mastra/rag`
takes the top-N results of a vector search and re-scores them by blending LLM-judged
semantic relevance with the original vector similarity and rank position (weights must
sum to 1; Cohere's `rerank-v3.5` uses that model's native reranking instead). It
reliably corrects the case where a chunk carries the right vocabulary but is not the
right challenge. It is excluded because it needs an LLM call per query, which
contradicts D8: the deterministic `challenge-search` workflow exists precisely to
return ranked results with no LLM latency, cost, or non-determinism. Enabling
reranking on only the agent path would make the two paths rank differently, which D8
avoids by having them share one tool; enabling it on both turns the deterministic path
into an LLM path. Two supporting reasons: reranker model access is not in the
prerequisites (only Titan embed is), and tuning those weights is meaningless without a
retrieval quality baseline, which this ADR does not build — see below. The one
structural prerequisite has been handled up front: the chunk text is stored under
`metadata.text`, which is where `rerank()` reads it from.

**Graph RAG.** `new GraphRAG(dimension, threshold)` builds an in-memory knowledge
graph in which nodes are chunks and edges join chunks whose embeddings exceed a
similarity threshold, then answers a query by combining direct similarity with a
random walk with restart (`randomWalkSteps`, `restartProb`) so it surfaces content
*connected* to the match rather than only the match. It is excluded on three concrete
grounds, not just scope. First, it is incompatible with the store D3 chooses: the graph
lives in process memory rather than in pgvector, and construction is **O(n²) in
chunks** — at the corpus this ADR sizes for (tens of thousands of chunks) that is on
the order of 10⁹ pair comparisons. Second, persisting it is a second unsolved problem:
snapshots are plain JSON carrying every node's full embedding, documented at ~20 MB per
1,000 nodes at 1536 dimensions, so hundreds of megabytes here, with nowhere in the
current design to put them. Third, snapshots are not incremental — a changed document
means rebuilding the graph — which is the direct opposite of the per-challenge
idempotent upsert (`deleteFilter: { challengeId }`) this pipeline is built around.
Beyond cost, the demand is absent: the access patterns in scope are single-hop lookups,
whereas graph traversal earns its keep on multi-hop synthesis across a linked corpus.

**Retrieval quality baseline.** A fixed set of queries, each paired with the challenge
IDs that should come back, plus a script that scores retrieval against them — recall@k
as the primary metric (a miss is invisible to the user), MRR/nDCG@k for whether the
right hit lands near the top, precision@k as a secondary signal. Deferred because there
is nothing to measure until Phase 4 has populated an index, and because realistic
queries are best curated from real usage rather than invented up front. Two things make
it cheap when it is picked up: `@mastra/evals` (already a dependency, 1.7.0) ships
`createContextPrecisionScorer` and `createContextRecallScorer` for the LLM-judged tier,
and D8's deterministic `challenge-search` workflow — which already names "evaluation
harnesses" as a consumer — is the right surface to measure, because it is reproducible
and LLM-free, so a score change reflects a retrieval change rather than model sampling.

Its value is that it converts guesses in this ADR into decisions. The following are
currently chosen by judgement and unmeasured: chunk `maxSize` 512 and `overlap` 50 and
the force-split fallback (chunk size is usually the largest single lever on quality);
Titan v2 at 1024 dimensions, where the Consequences above accept ~33% more storage than
768 and ~2x the 512 variant explicitly "for retrieval quality"; the parity between the
local 768-dimension Ollama model and production Titan at 1024 (D2), which nothing
currently establishes; `RAG_TOP_K` and the post-filtered `minScore` threshold, which
silently drops results when set too high; HNSW `m = 8` / `ef_construction = 32`,
including the counterintuitive asymmetry that filtered searches are exact scans at full
recall while unfiltered searches go through the ANN index; and whether
`enrichChunksWithChallengeName` actually helps, since it exists only to improve
retrieval. It would also make the deferred reranking decision adjudicable, and would
de-risk any future embedding-provider switch, which D7's dimension guard already forces
into a full reindex.

A sensible progression for the next iteration, cheapest first: (1) **known-item
retrieval** — query with a challenge's title plus skills and assert its own chunks rank
in the top k; zero labelling cost, deterministic, cheap enough for CI, and it catches
every gross regression (wrong dimensions, broken chunking, a filter that excludes
everything); (2) **paraphrased queries** generated once by an LLM and committed as
fixtures, so the eval stays deterministic while testing semantic rather than keyword
matching; (3) **~50 human-curated realistic queries** with labelled relevant
challenges, which is the tier that can actually settle reranking and chunk-size
questions. Worth noting alongside this: the Phase 7 validation gate checks that
`challenge-search` returns *identical* results across runs, which is a determinism
check, not a relevance one — a system that consistently returns the wrong challenges
passes it today.

**Also out of scope:** wiring `PgVector` into `Memory` `semanticRecall` for existing
agents; event-driven ingestion on challenge lifecycle events (deferred per D9); and
any change to existing agents, workflows, authentication, or middleware.

## Questions settled during review

Four questions were raised and answered while this ADR was under review. They are
recorded here because the answers are assumptions the implementation depends on:

1. **Production embedding model** — `amazon.titan-embed-text-v2:0` at 1024
   dimensions (D2).
2. **Database prerequisites** — the `vector` extension is enabled and the runtime
   role will be granted the required privileges, so `PgVector.createIndex()` owns all
   DDL and the prototype's `init-db` scripts are dropped (D3).
3. **Event-driven ingestion** — not needed for this release; deferred until a
   concrete trigger is required (D9).
4. **Deterministic retrieval** — in scope; a `challenge-search` workflow returns raw
   ranked results with no LLM synthesis, alongside the agent (D8).

## Security note — tenant scoping of challenge content

D10 keeps commercial and customer-identifying project data out of the vector store
entirely, so the disclosure surface is limited to challenge content. That still leaves
one rule:

**Scope filters must be enforced server-side, not by the model.** In the agent path
the LLM decides which filters to pass, so it cannot be relied on to restrict results.
Any endpoint serving a scoped audience must inject the `projectId` (or `groups`)
filter from the authenticated request context — the existing `resourceIdMiddleware`
already extracts the caller identity — rather than accepting it as model-chosen
input. `resourceIdMiddleware` does not solve this on its own: it scopes Mastra
resources such as memory threads by user, whereas the vector table has no per-user
partition, so an unrestricted `challenge-search` call can retrieve any indexed
challenge.

Two content-level notes bound the exposure: only the challenge's public
`description` is embedded (`privateDescription` is never indexed), and `groups` is
carried in metadata so group-restricted challenges *can* be filtered out — but
nothing enforces that automatically today. Until a tenant-scoping decision exists,
the search surface should stay restricted to internal M2M callers. A follow-up ADR
should decide whether isolation is achieved by injected filters, by per-tenant
`VECTOR_INDEX_NAME` tables, or by `PgVector` `schemaName` partitioning (the
multi-tenant resolver pattern that `@mastra/rag` documents).

## Prerequisites to confirm before implementation starts

- The runtime database role for each environment has been granted DDL privileges on
  the `ai` schema (assumed by D3).
- Bedrock access to `amazon.titan-embed-text-v2:0` is enabled for the deployment's
  AWS region and task role.
- The M2M client used by `M2MService` holds the **challenge `READ`** scope required by
  `GET /v6/challenges` (challenge-api-v6 guards it with `scopes: [READ, ALL]`). The
  existing `fetchChallengeTool` already uses it for single-challenge fetches; the new
  `searchChallengesTool` (D11) uses the same scope for bulk search. No projects-api
  scope is required by the ingestion or retrieval path — **`projects:read`** is needed
  only if the optional `fetchProjectTool` enrichment tool is shipped (projects-api-v6
  guards `GET /v6/projects/:projectId` with `@Scopes(M2M_SCOPES.PROJECTS.READ)`).
Tracked as a follow-up rather than a gate: which of the tenant-scoping options in the
security note applies to the challenge search surface. Implementation can proceed
because the interim mitigation — restricting the search surface to internal M2M
callers — is part of this decision, but the question must be closed before the surface
is exposed to any customer-scoped audience.
