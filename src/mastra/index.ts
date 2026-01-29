import { Mastra } from '@mastra/core';
import { PinoLogger } from '@mastra/loggers';
import { Observability, DefaultExporter, SensitiveDataFilter } from '@mastra/observability';
import { skillExtractionWorkflow } from './workflows/skills/skill-extraction-workflow';
import { skillsMatchingAgent } from './agents/skills/skills-matching-agent';
import { PostgresStore } from '@mastra/pg';
import {
  skillDiscoveryAnswerRelevancyScorer,
  skillDiscoveryPromptAlignmentScorer,
} from './scorers/skills-matching-scorers';
import { apiAuthLayer } from '../utils/auth';

export const mastra = new Mastra({
  workflows: { skillExtractionWorkflow },
  agents: { skillsMatchingAgent },
  scorers: {
    skillDiscoveryAnswerRelevancyScorer,
    skillDiscoveryPromptAlignmentScorer,
  },
  storage: new PostgresStore({
    id: 'tc-ai-api-store',
    connectionString: process.env.MASTRA_DB_CONNECTION!,
  }),
  logger: new PinoLogger({
    name: 'TC AI API',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'tc-ai-api',
        exporters: [new DefaultExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
  server: {
    port: Number(process.env.PORT || 3000),
    studioBase: '/studio',
    auth: process.env.DISABLE_AUTH === 'true' ? undefined : apiAuthLayer,
    build: {
      apiReqLogs: true,
    },
  },
});
