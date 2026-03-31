import { Mastra } from '@mastra/core';
import { Observability, DefaultExporter, SensitiveDataFilter } from '@mastra/observability';
import { skillExtractionWorkflow } from './workflows/skills/skill-extraction-workflow';
import { challengeContextWorkflow } from './workflows/challenge/challenge-context-workflow';
import { jdAutowriteWorkflow } from './workflows/jd/jd-autowrite-workflow';
import { skillsMatchingAgent } from './agents/skills/skills-matching-agent';
import { challengeParserAgent } from './agents/challenge/challenge-parser-agent';
import { jdRewriterAgent } from './agents/jd/jd-rewriter-agent';
import { PostgresStore } from '@mastra/pg';
import {
  instanceAnswerRelevancyScorer,
  instancePromptAlignmentScorer,
} from './scorers/instance-scorers';
import { apiAuthLayer, middlewareConfig, tcAILogger } from '../utils';
import { aiWorkspace } from './workspaces';

export const mastra = new Mastra({
  workflows: { skillExtractionWorkflow, challengeContextWorkflow, jdAutowriteWorkflow },
  agents: { skillsMatchingAgent, challengeParserAgent, jdRewriterAgent },
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
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'tc-ai-api',
        exporters: [new DefaultExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
  workspace: aiWorkspace,
  server: {
    host: process.env.MASTRA_HOST || process.env.HOST || '0.0.0.0',
    port: Number(process.env.PORT || 3000),
    studioBase: '/v6/studio',
    auth: process.env.DISABLE_AUTH === 'true' ? undefined : apiAuthLayer,
    build: {
      apiReqLogs: true,
    },
    middleware: middlewareConfig,
  },
  bundler: {
    externals: ["tc-core-library-js"],
    transpilePackages: ['@topcoder/wipro-ai-sdk-provider'],
  },
});
