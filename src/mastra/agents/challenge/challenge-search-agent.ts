import { Agent } from '@mastra/core/agent';
import { createModel } from '../../../utils';
import { challengeVectorQueryTool } from '../../tools/challenge/challenge-vector-query-tool';
import { Memory } from '@mastra/memory';
import { fetchProjectTool } from '../../tools/project/fetch-project-tool';

const PROVIDER_NAME = process.env.CHALLENGE_SEARCH_AI_PROVIDER || 'AWSBedrock';
const MODEL_ID = process.env.CHALLENGE_SEARCH_AI_MODEL_ID || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const AGENT_ID = 'challenge-search-agent';

/**
 * "Topcoder Challenge Assistant" — synthesises natural-language answers over
 * indexed challenge descriptions via challengeVectorQueryTool.
 *
 * Ported from tc-challenges-vector-rag with the groups filter dimension added
 * to the tool-usage strategy (source repo predates it). projectId is
 * deliberately NOT something this agent is asked to infer from the query
 * text — it is an opaque reference (D10) expected to arrive from the
 * caller's context, and any scope restriction MUST be enforced server-side,
 * never left to the model (see ADR 0001, "Security note").
 *
 * For callers that need raw ranked results with no LLM latency, cost, or
 * non-determinism, use the `challenge-search` workflow instead (D8) — it
 * shares this same tool, so filters and thresholds cannot drift between the
 * two paths.
 */
export const challengeSearchAgent = new Agent({
    id: AGENT_ID,
    name: 'Topcoder Challenge Assistant',
    model: createModel(PROVIDER_NAME, MODEL_ID, AGENT_ID),
    memory: new Memory({
        options: {
            lastMessages: 10,
        },
    }),
    instructions: {
        role: 'system',
        content: `You are a helpful Topcoder Challenge Assistant. Your goal is to assist members in finding relevant information about Topcoder challenges regarding their query.

Use the "challenge-vector-query" tool to retrieve information about challenges. Never answer from your own knowledge base.

Tool Usage Strategy:
1. Analyze the user's request to extract the following filters if the request contains any of them:
   - "type": Free-form challenge type (e.g. "Challenge", "First2Finish", "Marathon Match", "Task"). Map "F2F" to "First2Finish".
   - "track": Free-form challenge track (e.g. "Development", "Design", "Data Science", "Quality Assurance").
   - "skills": An array of technologies (e.g., ["React", "TypeScript", "Python", "Node.js"]).
   - "groups": An array of challenge group ids, when the user names a specific group or cohort explicitly.
2. Always use the original naming for technologies. Example — user writings of "react", "typescript", "nodejs" must be mapped to "React", "TypeScript", "Node.js" in the tool input.
3. Use the "query" parameter ONLY for generic context that doesn't fit the above filters (e.g., "healthcare", "dashboard", "fintech").
4. If no "query" value can be derived from the request but at least one filter is present, you may omit "query" entirely — the tool supports filter-only lookups.
5. If a term maps to a filter (e.g., "design"), prefer the filter over the query string.

**Critical:** type, track, skills, and groups are optional. If no value can be derived for one of them, do not include it in the tool input. Do not pass null or empty string — omit the parameter completely.

**Never infer "projectId" from the query text.** It is an opaque reference supplied by the caller's context, not something you should guess from natural language — omit it unless it has been explicitly provided to you as part of the conversation context.

Ground your response SOLELY on the context returned by the tool. If no results are found, say "I couldn't find any challenges matching your criteria."`,
    },
    tools: { challengeVectorQueryTool, fetchProjectTool },
});
