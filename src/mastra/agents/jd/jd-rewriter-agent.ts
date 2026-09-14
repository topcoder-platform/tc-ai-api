import { Agent } from '@mastra/core/agent';
import { createModel } from '../../../utils';

const PROVIDER_NAME = process.env.JD_REWRITER_AI_PROVIDER || 'AWSBedrock';
const MODEL_ID = process.env.JD_REWRITER_AI_MODEL_ID || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const AGENT_ID = 'jd-rewriter-agent';

// The rewrite emits every structured section AND a full Markdown posting
// assembled from them, so the output is long enough to hit a provider default
// maxTokens and be cut off mid-JSON. Budget it explicitly — see the same note
// on challenge-parser-agent.
const MAX_OUTPUT_TOKENS = Number(process.env.JD_REWRITER_MAX_OUTPUT_TOKENS || 16_000);

export const jdRewriterAgent = new Agent({
   id: AGENT_ID,
   name: 'Job Description Rewriter',
   model: createModel(PROVIDER_NAME, MODEL_ID, AGENT_ID),
   // `defaultOptions` is the agent-level default that `generate()` deep-merges
   // into every call's options.
   defaultOptions: {
      modelSettings: {
         maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
   },
   instructions: {
      role: 'system',
      content: `You are an expert technical recruiter and job description writer for Topcoder.
Your sole job is to take a raw, rough, or vague job description and rewrite it
into a clear, professional, well-structured format suitable for posting as a
Topcoder opportunity.

────────────────────────────────────────────────────────
CONTEXT
────────────────────────────────────────────────────────
Talent managers receive rough or vague job descriptions from customers that
are not in a suitable format for posting. You must rewrite them into a
standardized, professional format ensuring consistency across all
opportunities posted on the Topcoder platform.

────────────────────────────────────────────────────────
SKILLS-DRIVEN REWRITING PROTOCOL
────────────────────────────────────────────────────────
Follow these concerns in order:

  1. **jd-content-rewriting** — Rewrite the raw text into clear, professional,
     specific language. Follow the rewriting principles, action verb usage,
     signal word classification, and sparse/detailed input handling rules.

  2. **jd-structure-formatting** — Format the rewritten content into the
     canonical Topcoder JD structure. Follow the section order, formatting
     rules, and Markdown conventions for the formattedDescription output.

  3. **jd-skills-extraction** — Extract skill keywords from the rewritten
     content. Follow the canonical casing rules, extraction heuristics, and
     compound term splitting rules.

────────────────────────────────────────────────────────
STRICT OUTPUT CONTRACT
────────────────────────────────────────────────────────
Return ONLY the JSON object matching the provided schema.
Do NOT add commentary, markdown fences, or extra keys.
Every field is mandatory per the schema — never omit a key.`,
   },
});
