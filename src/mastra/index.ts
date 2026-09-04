import { Mastra } from '@mastra/core';
import { skillExtractionWorkflow } from './workflows/skills/skill-extraction-workflow';
import { challengeContextWorkflow } from './workflows/challenge/challenge-context-workflow';
import { challengeIngestionWorkflow } from './workflows/challenge/challenge-ingestion-workflow';
import { challengeBulkIngestionWorkflow } from './workflows/challenge/challenge-bulk-ingestion-workflow';
import { challengeSearchWorkflow } from './workflows/challenge/challenge-search-workflow';
import { jdAutowriteWorkflow } from './workflows/jd/jd-autowrite-workflow';
import { skillsMatchingAgent } from './agents/skills/skills-matching-agent';
import { challengeParserAgent } from './agents/challenge/challenge-parser-agent';
import { challengeSearchAgent } from './agents/challenge/challenge-search-agent';
import { jdRewriterAgent } from './agents/jd/jd-rewriter-agent';
import { PostgresStore } from '@mastra/pg';
import {
  instanceAnswerRelevancyScorer,
  instancePromptAlignmentScorer,
} from './scorers/instance-scorers';
import { apiAuthLayer, middlewareConfig, tcAILogger } from '../utils';
import { API_PREFIX, CHAT_ROUTE_PATH } from '../utils/server-routes';
import { aiWorkspace } from './workspaces';
import { chatRoute } from '@mastra/ai-sdk';
import { ragIndexRoutes } from '../utils/routes/rag-index.routes';

export const mastra = new Mastra({
  workflows: {
    skillExtractionWorkflow,
    challengeContextWorkflow,
    challengeIngestionWorkflow,
    challengeBulkIngestionWorkflow,
    challengeSearchWorkflow,
    jdAutowriteWorkflow,
  },
  agents: { skillsMatchingAgent, challengeParserAgent, challengeSearchAgent, jdRewriterAgent },
  scorers: {
    instanceAnswerRelevancyScorer,
    instancePromptAlignmentScorer,
  },
  storage: new PostgresStore({
    id: 'tc-ai-api-store',
    connectionString: process.env.MASTRA_DB_CONNECTION!,
    schemaName: process.env.MASTRA_DB_SCHEMA || 'ai'
  }),
  logger: tcAILogger,
  workspace: aiWorkspace,
  server: {
    host: process.env.MASTRA_HOST || process.env.HOST || '0.0.0.0',
    port: Number(process.env.PORT || 3000),
    studioBase: '/studio',
    apiPrefix: API_PREFIX,
    auth: process.env.DISABLE_AUTH === 'true' ? undefined : apiAuthLayer,
    build: {
      apiReqLogs: true,
    },
    middleware: middlewareConfig,
    cors: {
      origin: '*',
      allowMethods: ['POST', 'GET', 'OPTIONS', 'HEAD', 'PUT', 'PATCH', 'DELETE'],
      exposeHeaders: [
        "X-Prev-Page",
        "X-Next-Page",
        "X-Page",
        "X-Per-Page",
        "X-Total",
        "X-Total-Pages",
        "Link",
      ],
      maxAge: 3600
    },
    apiRoutes: [
      chatRoute({
        path: CHAT_ROUTE_PATH,
        version: 'v7',
      }),
      // RAG index admin API (list/delete indexed challenges) — administrator
      // only, see ADR 0004's `route` policy category.
      ...ragIndexRoutes,
    ],
  },
  bundler: {
    externals: ["tc-core-library-js"],
    transpilePackages: [],
  },
});
