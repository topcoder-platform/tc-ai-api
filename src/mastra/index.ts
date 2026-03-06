import { Mastra } from '@mastra/core';
import { Observability, DefaultExporter, SensitiveDataFilter } from '@mastra/observability';
import { skillExtractionWorkflow } from './workflows/skills/skill-extraction-workflow';
import { challengeContextWorkflow } from './workflows/challenge/challenge-context-workflow';
import { skillsMatchingAgent } from './agents/skills/skills-matching-agent';
import { challengeParserAgent } from './agents/challenge/challenge-parser-agent';
import { PostgresStore } from '@mastra/pg';
import {
  skillDiscoveryAnswerRelevancyScorer,
  skillDiscoveryPromptAlignmentScorer,
} from './scorers/skills-matching-scorers';
import { apiAuthLayer, middlewareConfig, tcAILogger } from '../utils';
import { aiWorkspace } from './workspaces';

export const mastra = new Mastra({
  workflows: { skillExtractionWorkflow, challengeContextWorkflow },
  agents: { skillsMatchingAgent, challengeParserAgent },
  scorers: {
    skillDiscoveryAnswerRelevancyScorer,
    skillDiscoveryPromptAlignmentScorer,
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
    port: Number(process.env.PORT || 3000),
    studioBase: '/studio',
    auth: process.env.DISABLE_AUTH === 'true' ? undefined : apiAuthLayer,
    build: {
      apiReqLogs: true,
    },
    middleware: middlewareConfig,
  },
});
