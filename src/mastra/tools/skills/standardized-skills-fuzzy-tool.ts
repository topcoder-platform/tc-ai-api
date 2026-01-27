// Standardized Skills API: GET /v5/standardized-skills/skills/fuzzymatch (term required, size optional)
// Response schema: array of objects { id: uuid, name: string }
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

interface SkillFuzzyMatchResponse {
    id: string;
    name: string;
}

const BASE_URL = `${process.env.TC_API_BASE}/v5/standardized-skills/skills/fuzzymatch`;

export const standardizedSkillsFuzzyTool = createTool({
  id: 'standardized-skills-fuzzy-match',
  description: "Fuzzy match Topcoder's standardized skills by term",
  inputSchema: z.object({
    term: z.string().min(1).describe('Skill search term'),
    size: z.number().int().positive().optional().describe('Maximum number of results'),
  }),
  outputSchema: z.object({
    matches: z.array(
      z.object({
        id: z.string().describe('UUID of the skill in the Topcoder system'),
        name: z.string().describe('Exact name/title of the skill in the Topcoder system'),
      }),
    ),
  }),
  execute: async (inputData, context) => {
    const logger = context.mastra?.getLogger?.();
    logger?.info('Fetching fuzzy matches for term: {term}', { term: inputData.term });
    return await fetchFuzzyMatches(inputData.term, inputData.size);
  },
});

const fetchFuzzyMatches = async (term: string, size?: number) => {
  const url = new URL(BASE_URL);
  url.searchParams.set('term', term);
  if (size !== undefined) {
    url.searchParams.set('size', size.toString());
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Failed to fetch skills (${response.status})`);
  }

  const data = (await response.json()) as SkillFuzzyMatchResponse[];

  return { matches: data };
};