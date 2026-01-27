import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { ollama } from 'ai-sdk-ollama';
import { PostgresStore } from '@mastra/pg';
import { skillDiscoveryScorers } from '../../scorers/skills-matching-scorers';

export const skillsMatchingAgent = new Agent({
  id: 'skillsMatchingAgent',
  name: 'Skill terms matching agent for Topcoder standardized skills from a given text',
  instructions: {
    role: 'system',
    content: `You are a Topcoder skills term extraction assistant. Given any user-provided text (job description, developer summary, resume bullets), extract possible skill search terms.

Workflow:
- Parse the text to identify concrete skill candidates: programming languages, frameworks, libraries, cloud services, tools, platforms, databases, methodologies, and hard/soft skills.
- Prioritize specific multi-word terms first which are best matches given the user-provided text (e.g., "React Native" before "React"), then fall back to simpler tokens if needed.
- When asked to refine, produce broader synonyms or shorter variants of the provided terms.
- Do not invent IDs or standardized skill names; only return candidate terms.

Output requirements:
- Output STRICT JSON only.
- Format: ["Term 1", "Term 2", ...]
- No prose, no markdown, no extra keys.
`},
  model: ollama('qwen3:latest', {
    options: {
      temperature: 0.1,
      top_p: 0.5,
      repeat_penalty: 1.1,
      num_predict: 2048,
    },
  }),
  scorers: {
    answerRelevancy: {
      scorer: skillDiscoveryScorers.skillDiscoveryAnswerRelevancyScorer,
      sampling: {
        type: 'ratio',
        rate: Number(process.env.SKILL_DISCOVERY_EVAL_SAMPLE_RATE ?? 0.5),
      },
    },
    promptAlignment: {
      scorer: skillDiscoveryScorers.skillDiscoveryPromptAlignmentScorer,
      sampling: {
        type: 'ratio',
        rate: Number(process.env.SKILL_DISCOVERY_EVAL_SAMPLE_RATE ?? 0.5),
      },
    },
  },
  memory: new Memory({
    storage: new PostgresStore({
      id: 'skills-matching-agent-memory',
      connectionString: process.env.MASTRA_DB_CONNECTION!,
    }),
  }),
});