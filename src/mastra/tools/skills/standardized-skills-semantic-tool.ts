// Standardized Skills API: POST /v5/standardized-skills/skills/semantic-search (body: { text })
// Response schema: array of objects { id: uuid, name: string, weighted_distance: number }
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

interface SkillSemanticMatchResponse {
    id: string;
    name: string;
    weighted_distance: number;
}

// const BASE_URL = `${process.env.TC_API_BASE}/v5/standardized-skills/skills/semantic-search`;
const BASE_URL = `http://localhost:3000/v5/standardized-skills/skills/semantic-search`;

export const standardizedSkillsSemanticTool = createTool({
    id: 'standardized-skills-semantic-search',
    description: "Semantic search Topcoder's standardized skills by text",
    inputSchema: z.object({
        text: z.string().min(1).describe('Text query used for semantic search'),
    }),
    outputSchema: z.object({
        matches: z.array(
            z.object({
                id: z.string().describe('UUID of the skill in the Topcoder system'),
                name: z.string().describe('Exact name/title of the skill in the Topcoder system'),
                weighted_distance: z.number().describe('Normalized semantic cosine distance score'),
            }),
        ),
    }),
    execute: async (inputData, context) => {
        const logger = context.mastra?.getLogger?.();
        logger?.info('Fetching semantic matches for text query');
        return await fetchSemanticMatches(inputData.text);
    },
});

const fetchSemanticMatches = async (text: string) => {
    const response = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch semantic matches (${response.status})`);
    }

    const data = (await response.json()) as SkillSemanticMatchResponse[];

    return { matches: data };
};
