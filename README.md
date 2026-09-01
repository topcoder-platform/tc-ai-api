# tc-ai-api — Comprehensive Technical Documentation

## Table of Contents

1. [Overview](#overview)
2. [Technology Stack](#technology-stack)
3. [Project Structure](#project-structure)
4. [Environment Variables](#environment-variables)
5. [Framework Setup — Mastra](#framework-setup--mastra)
6. [Database Layer](#database-layer)
7. [Authentication & Middleware](#authentication--middleware)
8. [Observability & Logging](#observability--logging)
9. [AI Model Provider — Ollama](#ai-model-provider--ollama)
10. [Agents](#agents)
11. [Tools](#tools)
12. [Scorers (Evaluation)](#scorers-evaluation)
13. [Workflows — Skill Extraction](#workflows--skill-extraction)
14. [Challenges Vector RAG](#challenges-vector-rag)
15. [Sequence Diagrams](#sequence-diagrams)
16. [External API Interactions](#external-api-interactions)
17. [CI/CD Pipeline](#cicd-pipeline)
18. [Deployment](#deployment)

---

## Overview

**tc-ai-api** is a Topcoder AI microservice built on the [Mastra](https://mastra.ai) AI orchestration framework. Its primary capability today is **Skill Extraction** — given a free-text job description, it identifies and matches relevant skills against Topcoder's Standardized Skills taxonomy using a multi-stage pipeline that combines LLM-based term extraction, fuzzy matching, and semantic search.

The service exposes a Hono-based HTTP API (managed by Mastra's built-in server), is authenticated via Auth0 JWTs, uses PostgreSQL for storage and agent memory, runs local LLM inference through Ollama, and ships with built-in observability and evaluation scorers.

---

## Technology Stack

| Layer               | Technology                                                  |
| ------------------- | ----------------------------------------------------------- |
| **Runtime**         | Node.js ≥ 22.13.0 (`.nvmrc`: v24.13.0)                      |
| **Language**        | TypeScript 5.9+ (ES2022, ESM)                               |
| **Package Manager** | pnpm 10.28.0                                                |
| **AI Framework**    | Mastra (`@mastra/core` ^1.2.0)                              |
| **AI SDK**          | Vercel AI SDK (`ai` ^6.0.71)                                |
| **LLM Provider**    | Ollama via `ai-sdk-ollama` ^3.4.0                           |
| **HTTP Server**     | Hono (embedded in Mastra)                                   |
| **Database**        | PostgreSQL via `@mastra/pg` ^1.2.0                          |
| **Auth**            | Auth0 via `@mastra/auth-auth0` ^1.0.0                       |
| **Observability**   | OpenTelemetry via `@mastra/observability` ^1.2.0            |
| **Logging**         | Pino via `@mastra/loggers` ^1.0.1                           |
| **Evals**           | `@mastra/evals` ^1.1.0 (Answer Relevancy, Prompt Alignment) |
| **Schema**          | Zod 4.3+                                                    |
| **Linting**         | ESLint 9 + typescript-eslint                                |
| **Formatting**      | Prettier 3.8+                                               |
| **CI/CD**           | CircleCI → AWS ECS (Fargate)                                |
| **Container**       | Docker (node:24.13.0-alpine)                                |

---

## Project Structure

```
tc-ai-api/
├── .circleci/config.yml          # CircleCI build/deploy pipeline
├── .github/workflows/            # GitHub Actions (code reviewer)
├── .mastra/                      # Mastra build artifacts (git-ignored)
├── src/
│   ├── mastra/
│   │   ├── index.ts              # ★ Mastra instance — wires everything together
│   │   ├── agents/
│   │   │   └── skills/
│   │   │       └── skills-matching-agent.ts   # LLM agent for term extraction
│   │   ├── tools/
│   │   │   └── skills/
│   │   │       ├── standardized-skills-fuzzy-tool.ts    # Fuzzy-match API tool
│   │   │       └── standardized-skills-semantic-tool.ts # Semantic-search API tool
│   │   ├── workflows/
│   │   │   └── skills/
│   │   │       └── skill-extraction-workflow.ts  # ★ Main orchestration workflow
│   │   ├── scorers/
│   │   │   └── skills-matching-scorers.ts        # Evaluation scorers
│   │   └── public/                               # Static assets (empty)
│   ├── config/
│   │   └── tool-auth-fallback.config.ts  # Per-tool M2M fallback opt-in (off by default)
│   └── utils/
│       ├── index.ts              # Barrel re-exports
│       ├── logger.ts             # Pino logger configuration
│       ├── server-routes.ts      # API_PREFIX / CHAT_ROUTE_PATH — shared by auth + middleware
│       ├── tc-api-client.ts      # Requestor-token-first TC_API_BASE client, with M2M fallback
│       ├── auth/
│       │   ├── index.ts          # Auth0 composite auth setup (protected paths, mapUserToResourceId)
│       │   └── m2m.service.ts    # Service M2M token acquisition
│       ├── middleware/
│       │   ├── index.ts          # Middleware registration
│       │   └── resourceIdMiddleware.ts  # Resource isolation middleware
│       └── providers/
│           └── ollama.ts         # Ollama AI provider config
├── docs/
│   └── adr/                      # Architecture decision records
├── Dockerfile                    # Production container image
├── appStartUp.sh                 # Container entrypoint
├── package.json
├── tsconfig.json
├── eslint.config.mjs
├── .prettierrc / .prettierignore
└── .env                          # Local environment variables
```

---

## Environment Variables

| Variable                            | Required | Default                                | Description                                                      |
| ----------------------------------- | -------- | -------------------------------------- | ---------------------------------------------------------------- |
| `PORT`                              | No       | `3000`                                 | HTTP server port                                                 |
| `MASTRA_DB_CONNECTION`              | **Yes**  | —                                      | PostgreSQL connection string for Mastra storage and agent memory |
| `MASTRA_DB_SCHEMA`                  | No       | `ai`                                   | PostgreSQL schema name for Mastra tables                         |
| `TC_API_BASE`                       | **Yes**  | —                                      | Topcoder API base URL (e.g. `https://api.topcoder-dev.com`)      |
| `OLLAMA_API_URL`                    | No       | `http://ollama.topcoder-dev.com:11434` | Ollama API endpoint for LLM inference                            |
| `MASTRA_EVAL_MODEL`                 | No       | `mistral:latest`                       | Ollama model used for evaluation scorers                         |
| `AUTH0_DOMAIN`                      | Yes\*    | —                                      | Auth0 domain for member JWT validation                           |
| `AUTH0_AUDIENCE`                    | Yes\*    | —                                      | Auth0 audience (client ID) for member tokens                     |
| `AUTH0_M2M_DOMAIN`                  | Yes\*    | —                                      | Auth0 domain for M2M JWT validation                              |
| `AUTH0_M2M_AUDIENCE`                | Yes\*    | —                                      | Auth0 audience for M2M tokens                                    |
| `DISABLE_AUTH`                      | No       | `false`                                | Set to `"true"` to disable all authentication (dev mode)         |
| `M2M_AUTH_CLIENT_ID`                | No\*\*   | —                                       | Client id for tc-ai-api's own service M2M credential (`M2MService`) |
| `M2M_AUTH_CLIENT_SECRET`            | No\*\*   | —                                       | Client secret for tc-ai-api's own service M2M credential            |
| `M2M_AUTH_URL`                      | No       | `https://topcoder-dev.auth0.com/oauth/token` | Token endpoint used to obtain the service M2M token             |
| `M2M_AUTH_DOMAIN`                   | No       | `topcoder-dev.auth0.com`               | Auth0 domain for the service M2M credential                        |
| `M2M_AUTH_AUDIENCE`                 | No       | `https://m2m.topcoder-dev.com/`        | Auth0 audience for the service M2M credential                      |
| `M2M_AUTH_PROXY_SERVER_URL`         | No       | `https://auth0proxy.topcoder-dev.com/token` | Proxy used to request the service M2M token                    |
| `JD_MAX_CHARS`                      | No       | `6000`                                 | Max character length for job description preprocessing           |
| `SKILL_MATCHING_FUZZY_MATCH_SIZE`   | No       | `3`                                    | Number of candidates returned per fuzzy-match query              |
| `SKILL_MATCHING_CONCURRENCY`        | No       | `5`                                    | Concurrency limit for parallel skill-matching requests           |
| `SKILL_MATCHING_SEMANTIC_THRESHOLD` | No       | `0.45`                                 | Max cosine distance for semantic matches (lower = stricter)      |
| `SKILL_DISCOVERY_EVAL_SAMPLE_RATE`  | No       | -                                      | Fraction of agent interactions sampled for evaluation scoring    |
| `RAG_EMBEDDING_PROVIDER`            | No       | `TC-Ollama`                            | Embedding provider for challenge RAG (`TC-Ollama` \| `AWSBedrock`) |
| `RAG_EMBEDDING_MODEL_ID`            | No       | `nomic-embed-text`                     | Embedding model id (768d locally; `amazon.titan-embed-text-v2:0`, 1024d, in prod) |
| `VECTOR_INDEX_NAME`                 | No       | `challenge_embeddings`                 | Vector table name (SQL-identifier validated) — override per environment when reindexing |
| `VECTOR_SEARCH_THRESHOLD`           | No       | `0.25`                                 | Minimum similarity score, applied after retrieval                |
| `RAG_CHUNK_MAX_SIZE`                | No       | `512`                                  | Max characters per chunk before recursive splitting               |
| `RAG_CHUNK_OVERLAP`                 | No       | `50`                                   | Character overlap between recursively-split chunks                |
| `RAG_TOP_K`                         | No       | `10`                                   | Default result count for challenge vector search                  |
| `CHALLENGE_SEARCH_AI_PROVIDER`      | No       | `AWSBedrock`                           | Model provider for `challenge-search-agent`                       |
| `CHALLENGE_SEARCH_AI_MODEL_ID`      | No       | `us.anthropic.claude-haiku-4-5`        | Model id for `challenge-search-agent`                              |
| `BEDROCK_PROMPT_CACHE_ENABLED`      | No       | `true`                                 | Global kill switch for Bedrock prompt caching (see below)         |
| `BEDROCK_PROMPT_CACHE_TTL`          | No       | `5m`                                   | Bedrock cache checkpoint TTL — `5m` or `1h`                       |
| `ACCESS_CONTROL_DEFAULT_POLICY`     | No       | `public`                               | Global fallback policy for any agent/workflow/tool with no explicit policy — `public` or `deny` |
| `ACCESS_CONTROL_ROLES_CLAIM`        | No       | `https://<TC_API_BASE domain>/roles`   | JWT claim key carrying member role names — override only if a tenant diverges from the convention |
| `ACCESS_POLICY_<CATEGORY>_<TARGET_KEY>_MODE` | No | —                              | Per-target override: `public` or `deny`. See [Access control](#access-control) |
| `ACCESS_POLICY_<CATEGORY>_<TARGET_KEY>_ROLES` | No | —                             | Per-target override: comma-separated member roles (implies `restricted`) |
| `ACCESS_POLICY_<CATEGORY>_<TARGET_KEY>_SCOPES` | No | —                            | Per-target override: comma-separated M2M scopes (implies `restricted`) |

> \* Auth0 variables are required unless `DISABLE_AUTH=true`.
> \*\* `M2M_AUTH_CLIENT_ID`/`M2M_AUTH_CLIENT_SECRET` are only exercised if a tool is explicitly opted into `TOOL_M2M_FALLBACK_CONFIG` (`src/config/tool-auth-fallback.config.ts`) — no tool is today, so these aren't required for the currently-shipped behavior, only for future fallback use.

---

## Framework Setup — Mastra

The application is bootstrapped in `src/mastra/index.ts` by instantiating a single `Mastra` object that wires together every subsystem:

```typescript
export const mastra = new Mastra({
  workflows:    { skillExtractionWorkflow },
  agents:       { skillsMatchingAgent },
  scorers:      { ...evalScorers },
  storage:      new PostgresStore({ connectionString, schemaName }),
  logger:       tcAILogger,          // Pino
  observability: new Observability({...}),  // OpenTelemetry
  server: {
    port: 3000,
    apiPrefix: API_PREFIX,            // '/v6/ai' — built-in Mastra routes live here
    auth: apiAuthLayer,               // CompositeAuth (Auth0)
    middleware: middlewareConfig,     // resourceIdMiddleware, registered per-route (see below)
    apiRoutes: [
      chatRoute({ path: CHAT_ROUTE_PATH }),  // '/chat/:agentId' — NOT under apiPrefix
    ],
  },
});
```

`API_PREFIX` and `CHAT_ROUTE_PATH` come from `src/utils/server-routes.ts` — the single source of truth both the auth config and the middleware paths are built from, so they can't drift out of sync (see [Authentication & Middleware](#authentication--middleware)).

### NPM Scripts

| Script         | Command              | Description                                                     |
| -------------- | -------------------- | --------------------------------------------------------------- |
| `dev`          | `mastra dev`         | Start dev server with hot-reload and Mastra Studio at `/studio` |
| `build`        | `mastra build`       | Production build (bundles into `.mastra/output/`)               |
| `start`        | `mastra start`       | Start production server from build output                       |
| `studio`       | `mastra studio`      | Launch Mastra Studio UI standalone                              |
| `lint`         | `eslint .`           | Run ESLint across the project                                   |
| `lint:fix`     | `eslint . --fix`     | Auto-fix lint issues                                            |
| `format`       | `prettier . --write` | Format all files                                                |
| `format:check` | `prettier . --check` | Check formatting without writing                                |

---

## Database Layer

### Storage Backend: PostgreSQL (`@mastra/pg`)

The application uses a **single PostgreSQL database** with a configurable schema (default: `ai`). Two `PostgresStore` instances are created:

1. **Global Mastra Storage** (`src/mastra/index.ts`)
   - ID: `tc-ai-api-store`
   - Stores: workflow run state, step execution logs, evaluation results, and general Mastra metadata.

2. **Agent Memory Storage** (`src/mastra/agents/skills/skills-matching-agent.ts`)
   - ID: `skills-matching-agent-memory`
   - Stores: conversation threads and message history for the `skillsMatchingAgent`, enabling multi-turn memory when interacting with the agent directly.

Both point to the same connection string (`MASTRA_DB_CONNECTION`) and schema (`MASTRA_DB_SCHEMA`), but are logically separate stores within Mastra's storage abstraction.

### Schema Management

Mastra automatically manages table creation and migrations within the configured PostgreSQL schema. No manual migration steps are required.

### Connection String Format

```
postgresql://<user>:<password>@<host>:<port>/<database>?schema=<schema>
```

---

## Authentication & Middleware

> See [ADR 0002](docs/adr/0002-tc-api-requestor-token-with-m2m-fallback.md) for the design rationale behind the outbound tool-call token flow described below.

### Auth0 Composite Authentication

Authentication is handled by `CompositeAuth` from `@mastra/core/server` (`src/utils/auth/index.ts`), which evaluates incoming JWTs against **two** Auth0 tenants, in order:

1. **Member tokens** — issued by `AUTH0_DOMAIN` with audience `AUTH0_AUDIENCE`
2. **M2M (machine-to-machine) tokens** — issued by `AUTH0_M2M_DOMAIN` with audience `AUTH0_M2M_AUDIENCE`

A request is authorized if it passes validation against **either** tenant. Both providers declare `protected: ['/v6/ai/*', '/v6/ai-chat/*']` (the server's `apiPrefix` plus the `chatRoute()` base path — see [Framework Setup](#framework-setup--mastra)); Mastra's built-in `protected`/`public` defaults only cover `/api/*`, so without this override every built-in route would be silently unauthenticated once `apiPrefix` is changed from the default. `/v6/ai-chat/*` has to be listed explicitly because `chatRoute()` is registered outside `apiPrefix` and never sets `requiresAuth`, so Mastra's `isProtectedPath` check would otherwise skip it — including its authorization step (see [Access control](#access-control)).

Both providers also set `mapUserToResourceId`, deriving the caller's Topcoder user id from the JWT claim `https://<domain>/userId` (member tokens) or `sub` (M2M tokens) — see `tcUserIdClaimKey()` / `mapUserToResourceId` in `src/utils/auth/index.ts`. Mastra's core auth flow stores that value under `MASTRA_RESOURCE_ID_KEY` in the request context automatically, and it takes precedence over any client-supplied `resourceId`/`memory.resource` — this is what actually enforces per-user memory/thread isolation; the `Resource ID Middleware` below is a belt-and-suspenders check on top of it, not the primary mechanism.

The same core auth flow also stores the **raw bearer token** that authenticated the request under `MASTRA_AUTH_TOKEN_KEY` in the request context. This is the "requestor token" referenced throughout this section and in ADR 0002 — see [Requestor Token Propagation to Topcoder Platform Tools](#requestor-token-propagation-to-topcoder-platform-tools) below.

Authentication can be fully disabled by setting `DISABLE_AUTH=true` (useful for local development).

### Resource ID Middleware

`resourceIdMiddleware` (`src/utils/middleware/resourceIdMiddleware.ts`) is a secondary, explicit check on top of `mapUserToResourceId` above. When auth is enabled it's registered against the two real route surfaces the server actually exposes (`src/utils/server-routes.ts` is the single source of truth for both):

- `${API_PREFIX}/*` (i.e. `/v6/ai/*`) — the built-in Mastra routes (agents, workflows, memory, threads)
- `${CHAT_ROUTE_BASE_PATH}/*` (i.e. `/v6/ai-chat/*`) — `chatRoute()`, which is registered *outside* `apiPrefix` (custom API routes aren't prefixed by Mastra), so it needs its own entry

For each matching request it:

1. Extracts the authenticated `user` object from the request context (or authenticates the bearer/`apiKey` token itself if the framework hasn't populated it yet).
2. Derives the Topcoder domain from `TC_API_BASE` (e.g., `topcoder-dev.com`).
3. Reads the user ID from the JWT claim `https://<domain>/userId`, falling back to `sub` for M2M tokens.
4. Sets `MASTRA_RESOURCE_ID_KEY` in the request context (redundant with `mapUserToResourceId`, but fails the request with a `401` if no user/id can be resolved at all).
5. Logs `'Auth resolved for request'` at `info` level with `authType` (`member`/`m2m`) and the resolved `resourceId`, for auth verification during rollout.

This ensures **resource isolation** — each user's agent memory and workflow state are segregated.

### Access control

> See [ADR 0004](docs/adr/0004-role-based-access-for-agents-workflows-tools.md) for the design rationale.

Authentication answers *"is this a valid caller?"*; access control answers *"may **this** caller invoke **this** agent / workflow / tool?"*. Both are off the same policy core in `src/utils/auth/access-control.ts`.

**Policy model** — every target resolves to exactly one policy:

| Mode | Meaning |
| --- | --- |
| `public` | Any authenticated caller (the default) |
| `deny` | Nobody, regardless of role or scope |
| `restricted` | Member callers must hold one of `roles`; M2M callers must hold one of `scopes` |

`restricted` keeps the two dimensions **separate**: a member token is checked only against `roles`, an M2M token only against `scopes`. A policy that configures just one dimension therefore implicitly denies the other credential type.

**Three-layer resolution**, per `(category, targetId)`, resolved lazily and memoised:

1. **Env override** — `ACCESS_POLICY_<CATEGORY>_<TARGET_KEY>_MODE` / `_ROLES` / `_SCOPES`
2. **Code default** — `DEFAULT_ACCESS_POLICIES` in `src/config/access-control.config.ts`
3. **Global default** — `ACCESS_CONTROL_DEFAULT_POLICY` (`public` unless set to `deny`)

`<CATEGORY>` is `AGENT`, `WORKFLOW` or `TOOL`. `<TARGET_KEY>` is the resource's own **`.id`**, upper-snake-cased — `challenge-bulk-ingestion` → `CHALLENGE_BULK_INGESTION`, `skillsMatchingAgent` → `SKILLS_MATCHING_AGENT`. Always the `.id` passed to `new Agent`/`createWorkflow`/`createTool`, **never** the object-property name it's registered under in `src/mastra/index.ts` — 9 of the 10 registrations differ, and a policy keyed on the wrong one silently never matches. An invalid `_MODE` throws an actionable error on first resolution rather than falling back silently.

**Shipped defaults.** Only two targets are restricted out of the box — both rewrite the shared challenge vector index:

```
challenge-ingestion        roles: [administrator]  scopes: [challengesRAG:admin]
challenge-bulk-ingestion   roles: [administrator]  scopes: [challengesRAG:admin]
```

Everything else is `public`, i.e. unchanged from pre-ADR-0004 behavior. Note that `challengesRAG:admin` must exist as a permission on the `AUTH0_M2M_AUDIENCE` API resource in Auth0 and be granted to the relevant M2M client(s), otherwise every M2M caller is denied on those two workflows.

**Two enforcement points:**

- **Agents & workflows** — `authorizeAccessPolicy` is supplied as `authorizeUser` to both Auth0 providers. Mastra's own `coreAuthMiddleware` already invokes that hook on every protected request and returns **403** when it returns `false`. It parses the request path into `('agent', id)` / `('workflow', id)`, covering `/v6/ai/agents/:id/*`, `/v6/ai/workflows/:id/*` and `/v6/ai-chat/:agentId`. Non-invocation paths (memory, threads, telemetry, scorers) are out of scope and pass through. Mastra Studio uses these same paths, so it gets no bypass.
- **Tools** — tools have no HTTP route of their own, so `withAccessPolicy()` wraps each tool's `execute` at its **export site** (e.g. the last line of `challenge-vector-query-tool.ts`). The guard travels with the exported tool object, so a future agent that adds the tool to its `tools:` map can't forget it. It reads the `user` already on `RequestContext` and throws `ToolAccessDeniedError` on denial — surfaced to the LLM as a failed tool call, or to a workflow step as a rejected `execute()`.

Nested, in-process invocations (`challenge-bulk-ingestion` → `challenge-ingestion`, `challenge-context` → `challenge-parser-agent`) are **not** re-gated: they never re-enter the HTTP router, and you can't reach them without passing the outer check first.

Every denial logs one `tcAILogger.warn` line with the category, target id and whether a user was present.

**Common operations, all zero-code-change:**

```bash
# Loosen ingestion for a staging environment
ACCESS_POLICY_WORKFLOW_CHALLENGE_INGESTION_MODE="public"

# Lock down a currently-open workflow
ACCESS_POLICY_WORKFLOW_CHALLENGE_SEARCH_ROLES="administrator,copilot"

# Temporarily hard-block a tool
ACCESS_POLICY_TOOL_SEARCH_CHALLENGES_MODE="deny"

# Flip the whole system to closed-by-default
ACCESS_CONTROL_DEFAULT_POLICY="deny"
```

Access control is inert when `DISABLE_AUTH=true` — there is no authenticated caller to check.

### Requestor Token Propagation to Topcoder Platform Tools

Mastra tools that call `TC_API_BASE` (fetching challenges/projects) are authorized as the **requesting user**, not a shared service account, by default. The mechanism (`src/utils/tc-api-client.ts`, `callTcApi()`):

1. Reads the requestor's own token from `context.requestContext.get(MASTRA_AUTH_TOKEN_KEY)` — the same value the core auth flow set (see above). This works uniformly for a TC member JWT or an M2M JWT; the client makes no distinction between token types, it just forwards whatever authenticated the caller of `tc-ai-api`.
2. Calls the Topcoder platform endpoint with `Authorization: Bearer <requestor token>`.
3. Optionally, **only for a tool id explicitly listed as `true`** in `TOOL_M2M_FALLBACK_CONFIG` (`src/config/tool-auth-fallback.config.ts`, off/empty by default), retries **once** with tc-ai-api's own service M2M token (`M2MService.getM2MToken()`) if the requestor-token attempt came back `401`/`403`. Every fallback attempt is logged at `warn` level with the tool id and status code.

| Tool | Auth |
| --- | --- |
| `fetch-challenge-by-id` | Requestor token only — no fallback configured |
| `search-challenges` | Requestor token only — no fallback configured |
| `fetch-project-by-id` | Requestor token only — no fallback configured |
| `standardized-skills-fuzzy-match` | Unauthenticated (public endpoint) — unaffected by this mechanism |
| `standardized-skills-semantic-search` | Unauthenticated (public endpoint) — unaffected by this mechanism |

`TOOL_M2M_FALLBACK_CONFIG` currently has **no entries** — every tool above uses only whichever token the requestor authenticated with. The fallback path exists as reusable infrastructure for a future tool that needs it (see ADR 0002's "Resolution of open questions" for why the three existing Challenge/Project tools deliberately ship without a safety net: correctness of authorization was prioritized over availability).

---

## Observability & Logging

### Logging

A Pino logger (`@mastra/loggers`) is configured at `info` level with the service name `TC AI API`. It is injected into the Mastra instance and made available to all agents, tools, and workflow steps via context.

### Observability (OpenTelemetry)

The `@mastra/observability` package provides:

- **DefaultExporter** — exports spans to the configured OTLP endpoint.
- **SensitiveDataFilter** — a span output processor that redacts sensitive data from telemetry.
- Service name: `tc-ai-api`

All agent interactions, tool executions, and workflow step runs are automatically instrumented.

---

## AI Model Provider — Ollama

LLM inference runs through a self-hosted [Ollama](https://ollama.com) instance. The provider is configured in `src/utils/providers/ollama.ts`:

```typescript
export const ollama = createOllama({
  baseURL: process.env.OLLAMA_API_URL || 'http://ollama.topcoder-dev.com:11434',
});
```

The default model is `mistral:latest` with conservative generation parameters:

| Parameter        | Value | Purpose                                                   |
| ---------------- | ----- | --------------------------------------------------------- |
| `temperature`    | 0.1   | Near-deterministic output for consistent skill extraction |
| `top_p`          | 0.5   | Nucleus sampling cutoff                                   |
| `repeat_penalty` | 1.1   | Reduces repetitive outputs                                |
| `num_predict`    | 2048  | Maximum tokens to generate                                |

---

## Agents

Four agents are registered in `src/mastra/index.ts`, all built via the shared `createModel(provider, modelId, agentId)` factory (`src/utils/providers/model-factory.ts`), which switches on `TC-Ollama` / `AWSBedrock` / `OpenAI`.

| Agent (registry key) | ID | Default model | Memory | Tools |
| --- | --- | --- | --- | --- |
| `skillsMatchingAgent` | `skillsMatchingAgent` | AWSBedrock `us.anthropic.claude-haiku-4-5-20251001-v1:0` | PostgreSQL-backed | — (workflow calls skill tools directly) |
| `challengeParserAgent` | `challenge-parser-agent` | AWSBedrock `us.anthropic.claude-sonnet-5` | — | — (structured-output extractor) |
| `challengeSearchAgent` | `challenge-search-agent` | AWSBedrock `us.anthropic.claude-haiku-4-5` | In-memory, last 10 messages | `challengeVectorQueryTool`, `fetchProjectTool` |
| `jdRewriterAgent` | `jd-rewriter-agent` | AWSBedrock `us.anthropic.claude-haiku-4-5-20251001-v1:0` | — | — (structured-output rewriter) |

Every default is overridable per-agent via `<AGENT>_AI_PROVIDER` / `<AGENT>_AI_MODEL_ID` env vars (e.g. `SKILLS_EXTRACTOR_AI_PROVIDER`, `CHALLENGE_PARSER_AI_PROVIDER`, `CHALLENGE_SEARCH_AI_PROVIDER`, `JD_REWRITER_AI_PROVIDER`).

**Bedrock prompt caching:** every agent's static system-prompt instructions are cached automatically via AWS Bedrock prompt caching, applied centrally by `createBedrockChatModel` (`src/utils/providers/bedrock.ts`) — no per-agent code. This cuts cost and time-to-first-token for the (often large) system-prompt portion on every call after the first cached one. It's gated by an allowlist of confirmed cache-capable model IDs (current-generation Claude 3.5+/Sonnet 4-5/Haiku 4.5 and Amazon Nova), so overriding an agent's model to something else (e.g. an older Claude 3 model, or Titan) degrades gracefully to no caching rather than erroring. Set `BEDROCK_PROMPT_CACHE_ENABLED=false` to disable it globally, or `BEDROCK_PROMPT_CACHE_TTL=1h` to trade a higher cache-write cost for a longer idle window between requests (default `5m`). Cache read/write token counts are logged at `debug` level per call (`[Bedrock cache] agent=... model=... cacheReadTokens=... cacheWriteTokens=...`).

### `skillsMatchingAgent`

| Property    | Value                                        |
| ----------- | -------------------------------------------- |
| **ID**      | `skillsMatchingAgent`                        |
| **Model**   | `createModel('AWSBedrock', 'us.anthropic.claude-haiku-4-5-20251001-v1:0')` by default |
| **Memory**  | PostgreSQL-backed conversation memory        |
| **Scorers** | Answer Relevancy, Prompt Alignment — sampled, only when `LOCAL_DEV=true` |

**System Prompt Behavior:**

The agent is instructed to:

- Parse free text (job descriptions, resumes, etc.) to identify skill candidates.
- Prioritize specific multi-word terms (e.g., "React Native" over "React").
- Aggressively split combined technologies (e.g., "PostgreSQL with Prisma ORM" → two separate terms).
- Output strict JSON arrays of strings — no prose, no markdown.

The agent is used within the workflow's `generateSkillCandidateTerms` step via its `.stream()` method, producing incremental text output that is then parsed into a JSON array.

### `challengeParserAgent`

| Property   | Value                                                          |
| ---------- | --------------------------------------------------------------- |
| **ID**     | `challenge-parser-agent`                                       |
| **Model**  | `createModel('AWSBedrock', 'us.anthropic.claude-sonnet-5')` by default |
| **Memory** | None                                                            |
| **Tools**  | None — pure structured-output extractor                        |

Reads a full challenge specification (public + private description, skills, metadata) and returns structured JSON: requirements (grouped), tech stack, runtime environment, existing-codebase status, and submission guidelines. Used by `challenge-context-workflow`'s `parse-challenge-context` step, invoked as four focused, partly-parallel extraction calls (requirements+grouping, then tech/runtime + codebase + guidelines in parallel) via `generateWithStructuredOutputFallback`, each validated against the source text afterward to prune hallucinated items.

### `challengeSearchAgent` ("Topcoder Challenge Assistant")

| Property   | Value                                                          |
| ---------- | --------------------------------------------------------------- |
| **ID**     | `challenge-search-agent`                                       |
| **Model**  | `createModel('AWSBedrock', 'us.anthropic.claude-haiku-4-5')` by default |
| **Memory** | In-memory only (`Memory({ options: { lastMessages: 10 } })`) — no persistent storage backend, unlike `skillsMatchingAgent` |
| **Tools**  | `challengeVectorQueryTool`, `fetchProjectTool`                 |

Answers natural-language questions about indexed Topcoder challenges. Infers `skills`/`type`/`track`/`groups` filters from the query and calls `challenge-vector-query`; never infers `projectId` from query text (it must arrive from the caller's context — see [Challenges Vector RAG](#challenges-vector-rag)). Grounds every answer solely in tool results. For callers needing raw ranked results with no LLM latency/cost/non-determinism, the `challenge-search` workflow shares the same underlying tool.

### `jdRewriterAgent`

| Property   | Value                                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| **ID**     | `jd-rewriter-agent`                                                          |
| **Model**  | `createModel('AWSBedrock', 'us.anthropic.claude-haiku-4-5-20251001-v1:0')` by default |
| **Memory** | None                                                                         |
| **Tools**  | None — pure structured-output rewriter                                      |

Rewrites a raw/rough job description into Topcoder's canonical structured format (formatted description + extracted skill keywords) for `jd-autowrite-workflow`.

---

## Tools

Six tools are defined under `src/mastra/tools/`, each a `createTool()` with a Zod input/output schema. The three Challenge/Project tools call `TC_API_BASE` authorized as the requesting user (see [Requestor Token Propagation to Topcoder Platform Tools](#requestor-token-propagation-to-topcoder-platform-tools)); the two Skills tools call unauthenticated public endpoints.

| Tool ID | Purpose | Called by |
| --- | --- | --- |
| `standardized-skills-fuzzy-match` | Fuzzy-match skill names | `skill-extraction-workflow` |
| `standardized-skills-semantic-search` | Vector-based skill search | `skill-extraction-workflow` |
| `fetch-challenge-by-id` | Fetch one challenge by UUID | `challenge-context-workflow`, `challenge-ingestion-workflow` |
| `search-challenges` | Paginated/filtered challenge search | `challenge-bulk-ingestion-workflow` |
| `challenge-vector-query` | Semantic + metadata-filtered vector search | `challengeSearchAgent`, `challenge-search` workflow |
| `fetch-project-by-id` | Resolve a `projectId` reference to project detail | `challengeSearchAgent` (on-demand enrichment) |

### `standardized-skills-fuzzy-match`

| Property   | Value                                                        |
| ---------- | ------------------------------------------------------------ |
| **ID**     | `standardized-skills-fuzzy-match`                            |
| **API**    | `GET {TC_API_BASE}/v5/standardized-skills/skills/fuzzymatch` |
| **Input**  | `{ term: string, size?: number }`                            |
| **Output** | `{ matches: [{ id: string, name: string }] }`                |

Performs fuzzy string matching against Topcoder's standardized skills taxonomy. Returns up to `size` matches for the given term.

### `standardized-skills-semantic-search`

| Property   | Value                                                                    |
| ---------- | ------------------------------------------------------------------------ |
| **ID**     | `standardized-skills-semantic-search`                                    |
| **API**    | `POST {TC_API_BASE}/v5/standardized-skills/skills/semantic-search`       |
| **Input**  | `{ text: string }`                                                       |
| **Output** | `{ matches: [{ id: string, name: string, weighted_distance: number }] }` |

Performs vector-based semantic search against the skills taxonomy. Returns matches ranked by cosine distance.

### `fetch-challenge-by-id`

| Property   | Value                                                              |
| ---------- | -------------------------------------------------------------------- |
| **ID**     | `fetch-challenge-by-id`                                             |
| **API**    | `GET {TC_API_BASE}/v6/challenges/:challengeId` (requestor token)    |
| **Input**  | `{ challengeId: uuid }`                                             |
| **Output** | Full challenge object — `name`, `description`, `privateDescription`, `descriptionFormat`, `status`, `track`, `type`, `tags`, `skills`, `projectId`, `groups`, timeline dates, `prizeSets`, `reviewers`, `discussions`, `overview`, `task`, `legacy` |

Fetches one challenge's full detail, including the reviewer-only `privateDescription` (consumers must be deliberate about never embedding or exposing it — the RAG ingestion path explicitly discards it).

### `search-challenges`

| Property   | Value                                                              |
| ---------- | -------------------------------------------------------------------- |
| **ID**     | `search-challenges`                                                  |
| **API**    | `GET {TC_API_BASE}/v6/challenges` (requestor token)                  |
| **Input**  | `{ projectId?, projectIds?, status?, approvalStatus?, types?, tracks?, tags?, groups?, updatedDateStart?, updatedDateEnd?, ids?, page?, perPage?, sortBy?, sortOrder? }` |
| **Output** | `{ challenges: [...], total, page, perPage }`                       |

Wraps the v6 endpoint's bare JSON array into a paginated envelope. Always requests `isLightweight: false` (the lightweight form omits `description`). `privateDescription` is intentionally excluded from every mapped result.

### `challenge-vector-query`

| Property   | Value                                                              |
| ---------- | -------------------------------------------------------------------- |
| **ID**     | `challenge-vector-query`                                             |
| **Input**  | `{ query?: string, skills?: string[], type?: string, track?: string, groups?: string[], projectId?: string \| string[], topK?: number, minScore?: number }` |
| **Output** | `{ success: boolean, count?: number, results?: [{ text, score, metadata }], error?: string }` |

The shared retrieval primitive behind both the search agent and the deterministic `challenge-search` workflow — see [Challenges Vector RAG → Retrieval](#challenges-vector-rag) for filter composition and the metadata-only lookup path.

### `fetch-project-by-id`

| Property   | Value                                                              |
| ---------- | -------------------------------------------------------------------- |
| **ID**     | `fetch-project-by-id`                                                |
| **API**    | `GET {TC_API_BASE}/v6/projects/:projectId` (requestor token)         |
| **Input**  | `{ projectId: string, fields?: string }`                            |
| **Output** | `{ project: { id, name?, status?, type?, billingAccountId?, directProjectId?, techStack? } }` |

Retrieval-time enrichment only (not used by ingestion): resolves the opaque `projectId` a challenge-search hit carries into project name/status/tech stack, under the caller's own authorization.

---

## Scorers (Evaluation)

Two LLM-based scorers evaluate agent output quality at runtime (sampled):

### `skillDiscoveryAnswerRelevancyScorer`

Uses `createAnswerRelevancyScorer` from `@mastra/evals`. Measures whether the agent's response is relevant to the user's input query.

### `skillDiscoveryPromptAlignmentScorer`

Uses `createPromptAlignmentScorerLLM` from `@mastra/evals`. Measures whether the agent's response adheres to the system prompt instructions (evaluation mode: `user`).

Both scorers run on the same Ollama model (`MASTRA_EVAL_MODEL`, default `mistral:latest`) and are sampled at a configurable rate (`SKILL_DISCOVERY_EVAL_SAMPLE_RATE`, default 50%).

---

## Workflows — Skill Extraction

The core business logic lives in `skill-extraction-workflow.ts`, organized as a **main workflow** with **nested sub-workflows**.

### Workflow: `skill-extraction-workflow` (Main)

**Input:** `{ jobDescription: string }`  
**Output:** `{ jobDescription, matches: [{ id, name, score }], skillCandidateTerms: string[] }`

#### Step Pipeline

| #   | Step ID                                            | Description                                                                   |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | `preprocess-job-description`                       | Normalize whitespace and truncate to `JD_MAX_CHARS` (default 6000)            |
| 2   | `generate-skill-candidate-terms`                   | Use `skillsMatchingAgent` (LLM) to extract skill search terms as a JSON array |
| 3   | `fuzzy-match-term-skills` (foreach)                | For each candidate term, call the fuzzy-match API tool (concurrency: 5)       |
| 4   | `skill-selection-and-refinement-workflow` (nested) | Split results into direct matches vs. terms needing semantic search           |
| 5   | `output-final-state`                               | Sort all matches by score (descending) and return final state                 |

### Sub-Workflow: `skill-selection-and-refinement-workflow`

Runs two branches **in parallel**:

| Branch              | Steps                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| **Direct Match**    | `map-direct-matches-to-state` — Skills with exact name match get `score: 1.0`                         |
| **Semantic Search** | `filter-out-direct-matches` → `foreach(semantic-match-term-skills)` → `map-semantic-matches-to-state` |

### Scoring Logic

- **Direct matches** (fuzzy match name === search term, case-insensitive): `score = 1.0`
- **Semantic matches**: `score = max(0, min(1, 1 - (weighted_distance / threshold)))` where threshold defaults to `0.45`. Matches above the threshold are discarded.

---

## Challenges Vector RAG

Retrieval-Augmented Generation over Topcoder challenge descriptions: an ingestion pipeline that chunks and embeds challenge text into `pgvector`, and a retrieval surface exposed both as an LLM-backed agent and as a deterministic, LLM-free workflow. Ported from the `tc-challenges-vector-rag` prototype (see [ADR 0001](docs/adr/0001-integrate-challenges-vector-rag.md) for the full design record and rationale — decisions below are cited as `D#`).

### Overview

| Concern | Summary |
| --- | --- |
| **Vector store** | `PgVector` (`@mastra/pg`), same `MASTRA_DB_CONNECTION` database and `MASTRA_DB_SCHEMA` as the rest of Mastra (D3) — no new infrastructure. |
| **Embeddings** | Provider-switched: Ollama `nomic-embed-text` (768d) locally, AWS Bedrock `amazon.titan-embed-text-v2:0` (1024d) in production (D2). |
| **Ingestion source** | Primary: the Challenge Search API (`GET /v6/challenges`), via `searchChallengesTool` and the `challenge-bulk-ingestion` workflow (D11). Secondary: CSV backfill CLI, for offline/air-gapped environments. |
| **Retrieval** | Two paths sharing one tool (`challengeVectorQueryTool`) so they cannot diverge: `challenge-search-agent` (synthesised NL answers) and `challenge-search` workflow (raw ranked results, no LLM) (D8). |
| **Project scoping** | Vector metadata carries only an opaque `projectId` reference — no project attributes are denormalized in. Callers resolve project detail via a separate `GET /v6/projects/:projectId` call (D10). |

### Ingestion

**`challenge-ingestion`** (workflow) — ingests one challenge, by `challengeId` (fetched via `fetchChallengeTool`) or an inline record:

1. `resolve-challenge` — fetch or validate the inline record; `projectId` is carried through as a string reference only, never dereferenced (D10).
2. `chunk-and-embed` — `processDescription` (line-ending normalization, BOM-aware trim, HTML→Markdown, frontmatter strip) → `chunkChallengeDescription` (two-pass chunking, see below) → `enrichChunksWithChallengeName` → `embedMany` via the embedding-provider factory, wrapped in retry-with-backoff.
3. `upsert-vectors` — `ensureChallengeIndex()` (idempotent create/dimension-guard, D7), then `upsert({ deleteFilter: { challengeId } })` — delete-then-insert as one transaction, so a challenge is never left partially indexed.

Only the challenge's **public** `description` is ever embedded — `privateDescription` is never read by the ingestion path.

**`challenge-bulk-ingestion`** (workflow, D11) — paginates `searchChallengesTool` (filterable by `projectId`/`projectIds`, `status`, `types`, `tracks`, `tags`, `groups`, `updatedDateStart` for incremental sync) and fans out to `challenge-ingestion` per challenge with bounded concurrency (default 3). One bad challenge cannot abort the run — failures are captured per-challenge in the aggregated report.

**CLI (secondary path, D11):**

```bash
# CSV backfill — offline/air-gapped environments, or CSV exports that predate the search API
pnpm run ingest -- --file path/to/challenges.csv [--dry-run]
pnpm run ingest -- --folder path/to/csvs
pnpm run ingest -- --clear-all --folder path/to/csvs   # confirms, then drops the vector index

# Incremental sync / project-scoped backfill — thin wrapper around challenge-bulk-ingestion
pnpm run sync -- --project-id 17423 [--dry-run]
pnpm run sync -- --status ACTIVE --updated-since 2026-08-01 --concurrency 5
```

Both CLIs invoke the same workflows the API exposes (via `mastra.getWorkflowById(...).createRun().start(...)`), so the CLI and API paths cannot drift onto separate implementations. `ingest-challenges.ts` writes per-run logs to `logs/ingestion-<timestamp>/{output.log,error.log,report.json}` (git-ignored).

### Retrieval

- **`challengeVectorQueryTool`** — the shared retrieval primitive. Composes an `$and` metadata filter from `skills` (`$in`), `type`/`track` (`$eq`, free-form strings per D12 — not enums), `groups` (`$in`), and `projectId` (`$in`, D10). `query` is optional: with at least one filter and no query text, it performs a metadata-only lookup (`query({ filter })`, no `queryVector`) — e.g. "everything indexed for project 17423". The relevance threshold (`VECTOR_SEARCH_THRESHOLD`) is applied **after** retrieval in application code rather than passed to `query({ minScore })`, because passing `minScore` forces `@mastra/pg` off the HNSW ANN fast path onto a full exact scan.
- **`challenge-search-agent`** ("Topcoder Challenge Assistant") — infers `skills`/`type`/`track`/`groups` filters from natural language and calls the tool. Never infers `projectId` from the query text — that must come from the caller's context, and **scope filters must be enforced server-side**, not left to the model (see the ADR's security note).
- **`challenge-search`** (workflow, D8) — the deterministic, LLM-free path: same tool, same filter composition, so results cannot diverge from the agent path. Input adds `groupBy` (`chunk` | `challenge` | `project`, default `challenge`): `chunk` returns raw hits ungrouped; `challenge` groups hits by `challengeId` (best chunk score becomes the challenge score, contributing chunks listed underneath); `project` rolls the same hits up by `projectId`.
- **`fetchProjectTool`** (optional, D10) — retrieval-time enrichment: resolves a `projectId` from a hit to project name/status/tech stack via `GET /v6/projects/:projectId`, under the caller's own authorization. Not used by, and nothing in, the ingestion or retrieval path depends on it.

### Chunking strategy

Two-pass, mirroring the source prototype:

1. **Markdown-header pass** — splits on `#`/`##` headers, keeping code blocks and tables as atomic units.
2. **Size-based pass** — chunks over `RAG_CHUNK_MAX_SIZE` (default 512 chars) are recursively split (`RAG_CHUNK_OVERLAP`, default 50). Atomic blocks (code/tables) are kept intact if they fit the embedding model's context window; if an atomic block still exceeds it, it is force-split and reported (`forceSplits` in every ingestion report) — a rare safety fallback, not expected in real Topcoder data.

### Metadata schema

Every row is one challenge chunk. There is no separate text column — the chunk text lives in `metadata.text` (named `text`, not the prototype's `content`, to match `@mastra/rag`'s convention — see ADR 0001 for the full rationale):

| Field | Type | Notes |
| --- | --- | --- |
| `challengeId` | `string` | The `deleteFilter` key for per-challenge replacement. |
| `name` | `string` | Challenge title. |
| `type` | `string` | Free-form (`ChallengeType` reference table, D12) — not an enum. |
| `track` | `string` | Free-form (`ChallengeTrack.name`, D12) — not an enum. |
| `skills` | `string[]` | Filterable via `$in`. |
| `groups` | `string[]` | Filterable via `$in`. |
| `projectId` | `string \| null` | The **only** project field (D10). Stored as a string — `@mastra/pg` compares metadata scalars as text. |
| `chunkIndex` / `totalChunks` | `number` | 1-based position / total chunk count, for reassembly. |
| `text` | `string` | The chunk text, prefixed with `# Challenge: <name>`. |
| `ingestedAt` | `string` | ISO-8601. Compensates for Mastra's table having no `created_at` column. |

### Embedding models

| Provider | Model | Dimension | Context window | Use |
| --- | --- | --- | --- | --- |
| `TC-Ollama` | `nomic-embed-text` | 768 | 2048 | Local development default |
| `AWSBedrock` | `amazon.titan-embed-text-v2:0` | 1024 | 8192 | Production default |

Switching a given environment's embedding provider requires a full reindex — `VECTOR_INDEX_NAME` is environment-overridable, and `ensureChallengeIndex()` throws an actionable error if the configured model's dimension doesn't match an existing index (D7).

### Database bootstrap

Per D3, there is **no hand-maintained DDL script** — `PgVector.createIndex()` performs all schema/table/index creation on first use (schema, table, HNSW vector index, and btree `metadataIndexes` on `challengeId`/`projectId`/`track`). This assumes the `vector` extension is enabled and the runtime database role holds DDL privileges. Local development uses the same `docker/docker-compose.yml` (`pgvector/pgvector:pg16`) as the rest of the project — no separate `init-db` step.

---

## Sequence Diagrams

### Skill Extraction Workflow — End-to-End

```mermaid
sequenceDiagram
    participant Client
    participant MastraServer as Mastra HTTP Server
    participant Auth as Auth0 Middleware
    participant ResID as Resource ID Middleware
    participant WF as skill-extraction-workflow
    participant PreProc as preprocess-job-description
    participant Agent as skillsMatchingAgent (LLM)
    participant FuzzyStep as fuzzy-match-term-skills
    participant FuzzyAPI as TC Standardized Skills API<br/>(Fuzzy Match)
    participant DirectMap as map-direct-matches-to-state
    participant FilterStep as filter-out-direct-matches
    participant SemanticStep as semantic-match-term-skills
    participant SemanticAPI as TC Standardized Skills API<br/>(Semantic Search)
    participant SemanticMap as map-semantic-matches-to-state
    participant Output as output-final-state

    Client->>MastraServer: POST /api/workflows/skill-extraction-workflow/start<br/>{ jobDescription: "..." }
    MastraServer->>Auth: Validate JWT (Auth0 Member or M2M)
    Auth-->>MastraServer: ✓ Authenticated user
    MastraServer->>ResID: Extract userId from JWT claims
    ResID-->>MastraServer: Set MASTRA_RESOURCE_ID_KEY
    MastraServer->>WF: Trigger workflow with input

    Note over WF: Step 1 — Preprocess
    WF->>PreProc: { jobDescription }
    PreProc-->>WF: Normalized & truncated JD (≤6000 chars)

    Note over WF: Step 2 — LLM Term Extraction
    WF->>Agent: Stream prompt with JD
    Agent->>Agent: Ollama mistral:latest inference
    Agent-->>WF: JSON array of skill candidate terms<br/>["React Native", "PostgreSQL", "Prisma ORM", ...]

    Note over WF: Step 3 — Fuzzy Match (parallel foreach)
    loop For each candidate term (concurrency: 5)
        WF->>FuzzyStep: term
        FuzzyStep->>FuzzyAPI: GET /v5/standardized-skills/skills/fuzzymatch?term=...&size=3
        FuzzyAPI-->>FuzzyStep: [{ id, name }, ...]
        FuzzyStep-->>WF: { term, matches }
    end

    Note over WF: Step 4 — Selection & Refinement (parallel branches)

    par Direct Match Branch
        WF->>DirectMap: All fuzzy results
        DirectMap->>DirectMap: Filter exact name matches → score: 1.0
        DirectMap-->>WF: Direct matches added to state
    and Semantic Search Branch
        WF->>FilterStep: All fuzzy results
        FilterStep-->>WF: Terms without direct matches
        loop For each unmatched term (concurrency: 5)
            WF->>SemanticStep: term
            SemanticStep->>SemanticAPI: POST /v5/standardized-skills/skills/semantic-search<br/>{ text: term }
            SemanticAPI-->>SemanticStep: [{ id, name, weighted_distance }, ...]
            SemanticStep-->>WF: { term, matches }
        end
        WF->>SemanticMap: All semantic results
        SemanticMap->>SemanticMap: Filter by threshold (0.45)<br/>Score = 1 - (distance/threshold)
        SemanticMap-->>WF: Semantic matches added to state
    end

    Note over WF: Step 5 — Output
    WF->>Output: Merge & sort all matches by score desc
    Output-->>WF: Final state

    WF-->>MastraServer: { jobDescription, skillCandidateTerms, matches }
    MastraServer-->>Client: 200 OK — Workflow result
```

### Authentication Flow

```mermaid
sequenceDiagram
    participant Client
    participant Server as Mastra HTTP Server
    participant CoreAuth as Mastra core auth flow
    participant MemberAuth as Auth0 (Member)
    participant M2MAuth as Auth0 (M2M)
    participant ResMiddleware as resourceIdMiddleware

    Client->>Server: Request to /v6/ai/* or /chat/:agentId<br/>Authorization: Bearer <JWT>
    Server->>CoreAuth: checkRouteAuth() — CompositeAuth

    alt Member Token
        CoreAuth->>MemberAuth: Verify JWT (domain: AUTH0_DOMAIN)
        MemberAuth-->>CoreAuth: ✓ Valid — user claims
    else M2M Token
        CoreAuth->>M2MAuth: Verify JWT (domain: AUTH0_M2M_DOMAIN)
        M2MAuth-->>CoreAuth: ✓ Valid — M2M claims
    end

    CoreAuth->>CoreAuth: mapUserToResourceId(user)<br/>→ set MASTRA_RESOURCE_ID_KEY
    CoreAuth->>CoreAuth: Store raw token<br/>→ set MASTRA_AUTH_TOKEN_KEY
    CoreAuth-->>Server: Authenticated — requestContext populated

    Server->>ResMiddleware: /v6/ai/* or /chat/* interceptor
    ResMiddleware->>ResMiddleware: Extract userId from<br/>https://<domain>/userId<br/>or fallback to 'sub' claim
    ResMiddleware->>ResMiddleware: Confirm/set MASTRA_RESOURCE_ID_KEY<br/>log authType + resourceId
    ResMiddleware-->>Server: Continue to handler
```

### Topcoder Platform Tool Call — Requestor Token Flow

`MASTRA_AUTH_TOKEN_KEY`, set once during authentication above, is threaded automatically by Mastra core all the way from the HTTP request into every tool a triggered agent run calls — no extra plumbing required. This is what lets `callTcApi()` forward the requestor's own token instead of a shared service credential:

```mermaid
sequenceDiagram
    participant Client
    participant ChatRoute as chatRoute() handler
    participant Agent as Mastra Agent
    participant Tool as fetch-challenge-by-id /<br/>search-challenges /<br/>fetch-project-by-id
    participant TcApiClient as callTcApi()
    participant TC as Topcoder Platform API
    participant M2M as M2MService (fallback only)

    Client->>ChatRoute: POST /chat/:agentId<br/>Authorization: Bearer <requestor JWT>
    Note over ChatRoute: MASTRA_AUTH_TOKEN_KEY already set<br/>on requestContext by core auth
    ChatRoute->>Agent: stream(messages, { requestContext })
    Agent->>Tool: execute(inputData, { requestContext })
    Tool->>TcApiClient: callTcApi({ toolId, url, requestContext })
    TcApiClient->>TcApiClient: token = requestContext.get(MASTRA_AUTH_TOKEN_KEY)
    TcApiClient->>TC: GET/POST ... Authorization: Bearer <requestor JWT>

    alt 2xx / non-401/403
        TC-->>TcApiClient: Response
    else 401 or 403 AND toolId listed in TOOL_M2M_FALLBACK_CONFIG
        TcApiClient->>TcApiClient: log warn (toolId, status)
        TcApiClient->>M2M: getM2MToken()
        M2M-->>TcApiClient: service M2M token
        TcApiClient->>TC: Retry once — Authorization: Bearer <M2M token>
        TC-->>TcApiClient: Response
    end

    TcApiClient-->>Tool: Response
    Tool-->>Agent: Mapped result
```

`fetch-challenge-by-id`, `search-challenges`, and `fetch-project-by-id` are **not** listed in `TOOL_M2M_FALLBACK_CONFIG` today, so for them the "else" branch never fires — a 401/403 from the requestor's own token is returned as-is.

### Agent Interaction — Term Extraction Detail

```mermaid
sequenceDiagram
    participant WorkflowStep as generate-skill-candidate-terms
    participant Mastra as Mastra Runtime
    participant Agent as skillsMatchingAgent
    participant Ollama as Ollama (mistral:latest)
    participant Memory as PostgreSQL Memory Store
    participant Scorer as Eval Scorers (sampled)

    WorkflowStep->>Mastra: getAgent('skillsMatchingAgent')
    Mastra-->>WorkflowStep: Agent instance

    WorkflowStep->>Agent: stream([{ role: 'user', content: prompt }])
    Agent->>Ollama: POST /api/chat (streaming)

    loop Streaming tokens
        Ollama-->>Agent: token chunk
        Agent-->>WorkflowStep: text stream chunk
    end

    WorkflowStep->>WorkflowStep: Concatenate chunks → full output
    WorkflowStep->>WorkflowStep: Extract JSON array from text
    WorkflowStep->>WorkflowStep: Parse with Zod schema

    Note over Agent,Memory: Conversation stored for future context
    Agent->>Memory: Save thread messages

    opt Sampled (50% rate)
        Agent->>Scorer: Evaluate answer relevancy
        Agent->>Scorer: Evaluate prompt alignment
        Scorer-->>Agent: Scores logged to storage
    end

    WorkflowStep-->>WorkflowStep: Return string[] of candidate terms
```

---

## External API Interactions

The service communicates with the following external systems:

### 1. Topcoder Standardized Skills API

| Endpoint                                                             | Method | Purpose                                           | Called By                        |
| -------------------------------------------------------------------- | ------ | ------------------------------------------------- | -------------------------------- |
| `{TC_API_BASE}/v5/standardized-skills/skills/fuzzymatch?term=&size=` | `GET`  | Fuzzy string matching against the skills taxonomy | `standardizedSkillsFuzzyTool`    |
| `{TC_API_BASE}/v5/standardized-skills/skills/semantic-search`        | `POST` | Vector-based semantic search (`{ text }` body)    | `standardizedSkillsSemanticTool` |

These are **unauthenticated** calls (no bearer token forwarded). The API base URL is configured via `TC_API_BASE`.

### 2. Topcoder Challenges & Projects API (v6)

| Endpoint                                   | Method | Purpose                            | Called By              |
| ------------------------------------------- | ------ | ------------------------------------ | ----------------------- |
| `{TC_API_BASE}/v6/challenges/:challengeId` | `GET`  | Fetch full challenge detail          | `fetchChallengeTool`   |
| `{TC_API_BASE}/v6/challenges`              | `GET`  | Filtered/paginated challenge search  | `searchChallengesTool` |
| `{TC_API_BASE}/v6/projects/:projectId`     | `GET`  | Resolve a `projectId` reference      | `fetchProjectTool`     |

Authorized as the **requesting user** — the bearer token that authenticated the caller of `tc-ai-api` (member or M2M) is forwarded as-is via `callTcApi()`. See [Requestor Token Propagation to Topcoder Platform Tools](#requestor-token-propagation-to-topcoder-platform-tools) and [ADR 0002](docs/adr/0002-tc-api-requestor-token-with-m2m-fallback.md). No M2M fallback is configured for these three today.

### 3. Ollama LLM API

| Endpoint                    | Method | Purpose                                         | Called By                          |
| --------------------------- | ------ | ----------------------------------------------- | ---------------------------------- |
| `{OLLAMA_API_URL}/api/chat` | `POST` | Streaming chat completion with `mistral:latest` | `skillsMatchingAgent` (via AI SDK) |
| `{OLLAMA_API_URL}/api/chat` | `POST` | Evaluation model inference                      | Evaluation scorers                 |

### 4. Auth0

| Endpoint                                                   | Purpose                                                                                                                              |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `https://{AUTH0_DOMAIN}/.well-known/jwks.json`             | JWKS for member token verification                                                                                                  |
| `https://{AUTH0_M2M_DOMAIN}/.well-known/jwks.json`         | JWKS for M2M token verification                                                                                                     |
| `{M2M_AUTH_URL}` (proxied via `M2M_AUTH_PROXY_SERVER_URL`) | Issues tc-ai-api's own service M2M token (`M2MService`) — used only as an unconfigured fallback credential, not the default for any tool today |

### 5. PostgreSQL

| Purpose                                 | Connection                                          |
| --------------------------------------- | --------------------------------------------------- |
| Workflow state, step logs, eval results | `MASTRA_DB_CONNECTION` (schema: `MASTRA_DB_SCHEMA`) |
| Agent conversation memory (threads)     | Same connection, same schema                        |

---

## CI/CD Pipeline

### CircleCI (`.circleci/config.yml`)

The project uses CircleCI for automated builds and deployments:

| Job          | Branch    | Environment | Target          |
| ------------ | --------- | ----------- | --------------- |
| `build-dev`  | `develop` | DEV         | AWS ECS Fargate |
| `build-prod` | `master`  | PROD        | AWS ECS Fargate |

**Pipeline Steps:**

1. Checkout code
2. Set up remote Docker
3. Install AWS CLI and Topcoder deploy scripts (`tc-deploy-scripts` v1.4.19)
4. Build Docker image: `docker buildx build --no-cache=true -t tc-ai-api:latest .`
5. Configure AWS environment
6. Process parameter store variables
7. Deploy to ECS Fargate via `master_deploy.sh`

### GitHub Actions (`.github/workflows/code_reviewer.yml`)

A code review automation workflow (details in the workflow file).

---

## Deployment

### Docker

The production Dockerfile:

```dockerfile
FROM node:24.13.0-alpine
WORKDIR /app
COPY . .
RUN npm install pnpm -g
RUN pnpm install
RUN pnpm run lint
RUN pnpm run build
CMD ./appStartUp.sh    # → pnpm start → mastra start
```

The container runs the Mastra production server on the configured `PORT` (default 3000).

### Infrastructure

- **Compute:** AWS ECS Fargate
- **Configuration:** AWS Systems Manager Parameter Store (`/config/tc-ai-api/`)
- **Scaling:** Managed by ECS service configuration
- **LLM:** Self-hosted Ollama instance (internal network at `ollama.topcoder-dev.com:11434` or local)

---

## API Surface (Auto-generated by Mastra)

Mastra automatically exposes the following REST endpoints:

| Endpoint                                          | Method | Description                              |
| ------------------------------------------------- | ------ | ---------------------------------------- |
| `/api/workflows/skill-extraction-workflow/start`  | `POST` | Start the skill extraction workflow      |
| `/api/workflows/skill-extraction-workflow/:runId` | `GET`  | Get workflow run status/result           |
| `/api/agents/skillsMatchingAgent/generate`        | `POST` | Direct agent text generation             |
| `/api/agents/skillsMatchingAgent/stream`          | `POST` | Direct agent streaming generation        |
| `/api/workflows/challenge-ingestion/start`        | `POST` | Ingest one challenge by id or inline record |
| `/api/workflows/challenge-bulk-ingestion/start`   | `POST` | Paginated bulk / incremental-sync ingestion |
| `/api/workflows/challenge-search/start`           | `POST` | Deterministic ranked challenge search (no LLM) |
| `/api/agents/challengeSearchAgent/generate`       | `POST` | Synthesised NL challenge search           |
| `/api/agents/challengeSearchAgent/stream`         | `POST` | Synthesised NL challenge search (streaming) |
| `/studio/*`                                       | `GET`  | Mastra Studio UI (development/debugging) |

All `/api/*` endpoints are protected by Auth0 authentication (unless `DISABLE_AUTH=true`) and scoped by the resource ID middleware.
