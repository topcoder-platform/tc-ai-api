import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { bedrock } from '../../../utils';
import { PostgresStore } from '@mastra/pg';
import { instanceScorers } from '../../scorers/instance-scorers';

const MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';

export const skillsMatchingAgent = new Agent({
  id: 'skillsMatchingAgent',
  name: 'Skill terms matching agent for Topcoder standardized skills from a given text',
  instructions: {
    role: 'system',
    content: `You are a Topcoder skills term extraction assistant. Given any user-provided text (job description, developer summary, resume bullets), extract possible skill search terms.

Workflow:
- Parse the text to identify concrete skill candidates: programming languages, frameworks, libraries, cloud services, tools, platforms, databases, methodologies, and hard/soft skills.
- Prioritize specific multi-word terms first which are best matches given the user-provided text (e.g., "React Native" before "React"), then fall back to simpler tokens if needed.
- AGGRESSIVELY SPLIT combined technologies. Do not output phrases like "X with Y" or "X/Y" as a single skill.
  - Example: "PostgreSQL with Prisma ORM" must be extracted as "PostgreSQL" and "Prisma ORM" separately.
  - Example: "OpenAPI/Swagger" must be extracted as "OpenAPI" and "Swagger" separately.
- When asked to refine, produce broader synonyms or shorter variants of the provided terms.
- Do not invent IDs or standardized skill names; only return candidate terms.

Output requirements:
- Output STRICT JSON only.
- Format: ["Term 1", "Term 2", ...]
- No prose, no markdown, no extra keys.
`,
  },
  model: bedrock(MODEL_ID),
  scorers: {
    answerRelevancy: {
      scorer: instanceScorers.instanceAnswerRelevancyScorer,
      sampling: {
        type: 'ratio',
        rate: Number(process.env.EVAL_SAMPLE_RATE || 0),
      },
    },
    promptAlignment: {
      scorer: instanceScorers.instancePromptAlignmentScorer,
      sampling: {
        type: 'ratio',
        rate: Number(process.env.EVAL_SAMPLE_RATE || 0),
      },
    },
  },
  memory: new Memory({
    storage: new PostgresStore({
      id: 'skills-matching-agent-memory',
      connectionString: process.env.MASTRA_DB_CONNECTION!,
      schemaName: process.env.MASTRA_DB_SCHEMA || 'ai'
    }),
  }),
});
