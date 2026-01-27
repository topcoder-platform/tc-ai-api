import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { standardizedSkillsFuzzyTool } from '../../tools/skills/standardized-skills-fuzzy-tool';
import { generateText } from 'ai';
import { ollama } from 'ai-sdk-ollama';

const skillMatchSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const scoredSkillSchema = skillMatchSchema.extend({
  score: z.number().min(0).max(1),
});

const discoveryStateSchema = z.object({
  jobDescription: z.string().min(1),
  matches: z.array(scoredSkillSchema),
  attemptedTerms: z.array(z.string()),
  unmatchedTerms: z.array(z.string()),
  iteration: z.number().int().nonnegative(),
  maxIterations: z.number().int().positive(),
  minMatches: z.number().int().positive(),
  size: z.number().int().positive(),
  noNewTerms: z.boolean(),
  minScore: z.number().min(0).max(1),
});

const termSearchItemSchema = z.object({
  term: z.string(),
  skip: z.boolean().optional(),
  state: discoveryStateSchema.optional(),
  limit: z.number().int().positive(),
  attemptedTerms: z.array(z.string()),
  newTerms: z.array(z.string()),
});

const termSearchResultSchema = termSearchItemSchema.extend({
  matches: z.array(skillMatchSchema),
});

const preprocessJobDescription = createStep({
  id: 'preprocess-job-description',
  description: 'Normalize and truncate the job description before extraction',
  inputSchema: z.object({
    jobDescription: z.string().min(1),
  }),
  outputSchema: z.object({
    jobDescription: z.string(),
  }),
  execute: async ({ inputData }) => {
    const maxChars = Number(process.env.JD_MAX_CHARS ?? 6000);
    const normalized = inputData.jobDescription.replace(/\s+/g, ' ').trim();
    return {
      jobDescription: normalized.slice(0, Math.max(0, maxChars)),
    };
  },
});

const initializeSkillDiscovery = createStep({
  id: 'initialize-skill-discovery',
  description: 'Initialize skill discovery state',
  inputSchema: z.object({
    jobDescription: z.string().min(1),
  }),
  outputSchema: discoveryStateSchema,
  execute: async ({ inputData }) => {
    const maxIterations = Math.max(
      1,
      Number(process.env.MAX_SKILL_LOOP_ITERATIONS ?? 3),
    );
    const minMatches = Math.max(1, Number(process.env.MIN_SKILL_MATCHES ?? 5));
    const size = Math.max(1, Number(process.env.SKILL_FUZZY_MATCH_SIZE ?? 5));
    const minScore = Math.max(
      0,
      Math.min(1, Number(process.env.SKILL_MATCH_SCORE_THRESHOLD ?? 0.4)),
    );
    return {
      jobDescription: inputData.jobDescription,
      matches: [],
      attemptedTerms: [],
      unmatchedTerms: [],
      iteration: 0,
      maxIterations,
      minMatches,
      size,
      noNewTerms: false,
      minScore,
    };
  },
});

const generateSkillTerms = createStep({
  id: 'generate-skill-terms',
  description: 'Generate new skill search terms from the job description',
  inputSchema: discoveryStateSchema,
  outputSchema: z.object({
    state: discoveryStateSchema,
    newTerms: z.array(z.string()),
  }),
  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger?.();
    const agent =
      mastra?.getAgentById?.('skillsMatchingAgent') ??
      mastra?.getAgent?.('skillsMatchingAgent');

    if (!agent) {
      throw new Error('Skills matching agent not found');
    }

    logger?.info('Generate skill terms {inputData}', {
      inputData,
    });

    const prompt = buildTermPrompt({
      jobDescription: inputData.jobDescription,
      attemptedTerms: inputData.attemptedTerms,
      unmatchedTerms: inputData.unmatchedTerms,
      iteration: inputData.iteration,
    });

    const termLimit = Math.max(
      1,
      Number(process.env.SKILL_DISCOVERY_TERM_LIMIT ?? 5),
    );

    const terms = await extractTermsFromAgent(agent, prompt);
    const newTerms = terms
      .map((term) => term.trim())
      .filter((term) => term.length > 0)
      .filter(
        (term) => !inputData.attemptedTerms.includes(normalizeTerm(term)),
      )
      .slice(0, termLimit);

    const attemptedTerms = [
      ...inputData.attemptedTerms,
      ...newTerms.map(normalizeTerm),
    ];

    return {
      state: {
        ...inputData,
        attemptedTerms,
      },
      newTerms,
    };
  },
});

const prepareTermSearch = createStep({
  id: 'prepare-term-search',
  description: 'Prepare terms for per-term fuzzy search',
  inputSchema: z.object({
    state: discoveryStateSchema,
    newTerms: z.array(z.string()),
  }),
  outputSchema: z.array(termSearchItemSchema),
  execute: async ({ inputData }) => {
    const { state, newTerms } = inputData;
    if (newTerms.length === 0) {
      return [
        {
          term: '',
          skip: true,
          limit: state.size,
          state,
          attemptedTerms: state.attemptedTerms,
          newTerms: [],
        },
      ];
    }

    return newTerms.map((term, index) => ({
      term,
      limit: state.size,
      state: index === 0 ? state : undefined,
      attemptedTerms: state.attemptedTerms,
      newTerms,
    }));
  },
});

const searchSkillCandidates = createStep({
  id: 'search-skill-candidates',
  description: 'Search standardized skills for a single term',
  inputSchema: termSearchItemSchema,
  outputSchema: termSearchResultSchema,
  execute: async ({
    inputData,
    mastra,
    requestContext,
    tracingContext,
    abortSignal,
    workflowId,
    runId,
    state,
    setState,
    suspend,
  }) => {
    const logger = mastra?.getLogger?.();

    const toolSuspend = async (
      suspendPayload: unknown,
      suspendOptions?: Parameters<typeof suspend>[1],
    ) => {
      await suspend(suspendPayload, suspendOptions);
    };

    if (inputData.skip || inputData.term.trim().length === 0) {
      return {
        ...inputData,
        matches: [],
      };
    }

    try {
      const toolResult = await standardizedSkillsFuzzyTool.execute?.(
        { term: inputData.term, size: inputData.limit },
        {
          mastra,
          requestContext,
          tracingContext,
          abortSignal,
          workflow: {
            runId,
            workflowId,
            state,
            setState,
            suspend: toolSuspend,
          },
        },
      );

      if (!toolResult || 'error' in toolResult || !toolResult.matches) {
        return {
          ...inputData,
          matches: [],
        };
      }

      return {
        ...inputData,
        matches: toolResult.matches,
      };
    } catch (error) {
      logger?.warn('Skill fuzzymatch failed for term {term}', {
        term: inputData.term,
        error,
      });
      return {
        ...inputData,
        matches: [],
      };
    }
  },
});

const rankAndEvaluateSkills = createStep({
  id: 'rank-and-evaluate-skills',
  description: 'Rank candidate skills, score them, and update discovery state',
  inputSchema: z.array(termSearchResultSchema),
  outputSchema: discoveryStateSchema,
  execute: async ({ inputData }) => {
    if (!inputData.length) {
      throw new Error('Missing skill search results');
    }

    const baseState = inputData.find(item => item.state)?.state;
    if (!baseState) {
      throw new Error('State not found in search results');
    }
    const newTerms = inputData[0].newTerms ?? [];

    if (newTerms.length === 0) {
      return {
        ...baseState,
        iteration: baseState.iteration + 1,
        noNewTerms: true,
      };
    }

    const matchesById = new Map<string, { id: string; name: string; score: number }>(
      baseState.matches.map((match) => [match.id, match]),
    );
    const unmatchedTerms: string[] = [];
    const termToMatches = new Map<string, { id: string; name: string }[]>();
    const hitCounts = new Map<string, number>();

    for (const result of inputData) {
      if (result.skip || result.term.trim().length === 0) {
        continue;
      }

      const uniqueMatches = Array.from(
        new Map(result.matches.map((match) => [match.id, match])).values(),
      );
      termToMatches.set(result.term, uniqueMatches);

      for (const match of uniqueMatches) {
        hitCounts.set(match.id, (hitCounts.get(match.id) ?? 0) + 1);
      }
    }

    const candidateMatches = Array.from(
      new Map(
        Array.from(termToMatches.values())
          .flat()
          .map((match) => [match.id, match]),
      ).values(),
    );

    const seedLimit = Math.max(
      1,
      Number(process.env.SKILL_DISCOVERY_SEED_LIMIT ?? 20),
    );

    const rankedCandidates = candidateMatches
      .sort((a, b) => {
        const hitDelta = (hitCounts.get(b.id) ?? 0) - (hitCounts.get(a.id) ?? 0);
        if (hitDelta !== 0) {
          return hitDelta;
        }
        return a.name.localeCompare(b.name);
      })
      .slice(0, seedLimit);

    if (rankedCandidates.length > 0) {
      const model = ollama(process.env.SKILL_SCORING_MODEL ?? 'qwen3:latest');
      const prompt = `You are scoring how relevant each standardized skill is to a job description.
Return ONLY a JSON array with objects in the form: {"id": string, "name": string, "score": number}.
Scores must be between 0 and 1. Use 1 for essential, 0 for unrelated.

Job Description:
"""
${baseState.jobDescription}
"""

Skills:
${JSON.stringify(rankedCandidates, null, 2)}
`;

      const { text } = await generateText({
        model,
        prompt,
      });

      const scored = parseJsonArray(text, z.array(scoredSkillSchema)).map(
        (skill) => ({
          ...skill,
          score: Math.max(0, Math.min(1, skill.score)),
        }),
      );

      for (const scoredSkill of scored) {
        const existing = matchesById.get(scoredSkill.id);
        if (!existing || scoredSkill.score > existing.score) {
          matchesById.set(scoredSkill.id, scoredSkill);
        }
      }
    }

    for (const [skillId, skill] of matchesById.entries()) {
      if (skill.score < baseState.minScore) {
        matchesById.delete(skillId);
      }
    }

    const matchedTerms = new Set<string>();
    for (const [term, matches] of termToMatches.entries()) {
      const hasGoodMatch = matches.some((match) => {
        const scored = matchesById.get(match.id);
        return scored && scored.score >= baseState.minScore;
      });

      if (hasGoodMatch) {
        matchedTerms.add(normalizeTerm(term));
      } else {
        unmatchedTerms.push(term);
      }
    }

    const prunedAttemptedTerms = baseState.attemptedTerms.filter(
      (term) => !matchedTerms.has(term),
    );

    const filteredMatches = Array.from(matchesById.values())
      .sort((a, b) => b.score - a.score);

    return {
      jobDescription: baseState.jobDescription,
      matches: filteredMatches,
      attemptedTerms: prunedAttemptedTerms,
      unmatchedTerms,
      iteration: baseState.iteration + 1,
      maxIterations: baseState.maxIterations,
      minMatches: baseState.minMatches,
      size: baseState.size,
      noNewTerms: false,
      minScore: baseState.minScore,
    };
  },
});

const skillDiscoveryIteration = createWorkflow({
  id: 'skill-discovery-iteration',
  inputSchema: discoveryStateSchema,
  outputSchema: discoveryStateSchema,
})
  .then(generateSkillTerms)
  .then(prepareTermSearch)
  .foreach(searchSkillCandidates, {
    concurrency: Math.max(
      1,
      Number(process.env.SKILL_FUZZY_MATCH_CONCURRENCY ?? 5),
    ),
  })
  .then(rankAndEvaluateSkills);

skillDiscoveryIteration.commit();

const skillExtractionWorkflow = createWorkflow({
  id: 'skill-extraction-workflow',
  inputSchema: z.object({
    jobDescription: z.string().min(1),
  }),
  outputSchema: z.object({
    skills: z.array(scoredSkillSchema),
  }),
})
  .then(preprocessJobDescription)
  .then(initializeSkillDiscovery)
  .dountil(skillDiscoveryIteration, async ({ inputData, iterationCount }) => {
    if (iterationCount >= inputData.maxIterations) {
      throw new Error('Maximum skill discovery iterations reached');
    }

    if (inputData.noNewTerms) {
      return true;
    }

    return inputData.matches.length >= inputData.minMatches;
  });

skillExtractionWorkflow.commit();

export { skillExtractionWorkflow };

const normalizeTerm = (term: string) => term.trim().toLowerCase();

const buildTermPrompt = ({
  jobDescription,
  attemptedTerms,
  unmatchedTerms,
  iteration,
}: {
  jobDescription: string;
  attemptedTerms: string[];  unmatchedTerms: string[]; 
  iteration: number;
}) => {
  const baseInstructions = `Extract concise skill search terms from the job description. Return a JSON array of strings only.`;
  const refinementInstructions = unmatchedTerms.length
    ? `Some terms did not match any standardized skills: ${JSON.stringify(unmatchedTerms)}. Provide broader synonyms or shorter variants.`
    : `Provide specific multi-word skill terms first, then simpler ones.`;
  const avoidInstructions = attemptedTerms.length
    ? `Avoid repeating these already attempted terms: ${JSON.stringify(
        attemptedTerms,
      )}.`
    : '';

  return `${baseInstructions}
Iteration: ${iteration + 1}

Job Description:
"""
${jobDescription}
"""

${refinementInstructions}
${avoidInstructions}
`;
};

const extractTermsFromAgent = async (
  agent: {
    stream: (messages: { role: 'user'; content: string }[]) => Promise<{
      textStream: AsyncIterable<string>;
    }>;
  },
  prompt: string,
): Promise<string[]> => {
  const response = await agent.stream([
    {
      role: 'user',
      content: prompt,
    },
  ]);

  let output = '';
  for await (const chunk of response.textStream) {
    output += chunk;
  }

  return parseJsonArray(output, z.array(z.string()));
};

const parseJsonArray = <T>(text: string, schema: z.ZodType<T[]>) => {
  const raw = extractJsonArray(text);
  if (!raw) {
    return [] as T[];
  }

  try {
    const parsed = JSON.parse(raw);
    return schema.parse(parsed);
  } catch {
    return [] as T[];
  }
};

const extractJsonArray = (text: string) => {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
};
