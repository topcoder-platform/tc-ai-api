import { Mastra } from '@mastra/core';
import { PinoLogger } from '@mastra/loggers';
import { Observability, DefaultExporter, SensitiveDataFilter } from '@mastra/observability';
import { skillExtractionWorkflow } from './workflows/skills/skill-extraction-workflow';
// import { MastraAuthAuth0 } from "@mastra/auth-auth0";
import { skillsMatchingAgent } from './agents/skills/skills-matching-agent';
import { PostgresStore } from '@mastra/pg';
import {
  skillDiscoveryAnswerRelevancyScorer,
  skillDiscoveryPromptAlignmentScorer,
} from './scorers/skills-matching-scorers';

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
    studioBase: '/tc-ai-studio',
    // auth: new MastraAuthAuth0({
    //   domain: process.env.AUTH0_DOMAIN,
    //   audience: process.env.AUTH0_AUDIENCE,
    //   authorizeUser: async (...args) => {
    //     // Custom authorization logic
    //     console.log('Args are', args)
    //     return true;
    //   },
    // }),
    build: {
      apiReqLogs: true
    },
  },
});
