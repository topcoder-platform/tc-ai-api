import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { standardizedSkillsFuzzyTool } from '../../tools/skills/standardized-skills-fuzzy-tool';
import { standardizedSkillsSemanticTool } from '../../tools/skills/standardized-skills-semantic-tool';

const skillMatchSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const semanticMatchSchema = skillMatchSchema.extend({
  weighted_distance: z.number().min(0),
});

const scoredSkillSchema = skillMatchSchema.extend({
  score: z.number().min(0).max(1),
});

const extractionWorkflowStateSchema = z.object({
  jobDescription: z.string().min(1).optional().default('Test Job Description'),
  matches: z.array(scoredSkillSchema).optional().default([]),
  skillCandidateTerms: z.array(z.string()).optional().default([]),
});

// Step 1
// Preprocess Job Description and truncate if necessary to max length (JD_MAX_CHARS)
const preprocessJobDescription = createStep({
  id: 'preprocess-job-description',
  description: 'Normalize and truncate the job description before extraction',
  inputSchema: z.object({
    jobDescription: z.string().min(1),
  }),
  outputSchema: z.object({
    jobDescription: z.string().min(1),
  }),
  execute: async ({ inputData }) => {
    const maxChars = Number(process.env.JD_MAX_CHARS ?? 6000);
    const normalized = inputData.jobDescription.replace(/\s+/g, ' ').trim();
    const jobDescription = normalized.slice(0, Math.max(0, maxChars));

    return {
      jobDescription,
    };
  },
});

// Step 2
// Generate Skill Candidate Terms from Job Description for Skill Matching using the Skills Matching Agent
const generateSkillCandidateTerms = createStep({
  id: 'generate-skill-candidate-terms',
  description: 'Generate skill search candidate terms from the job description',
  inputSchema: z.object({
    jobDescription: z.string().min(1),
  }),
  outputSchema: z.array(z.string()),
  execute: async ({ inputData, mastra, setState }) => {
    const agent =
      mastra?.getAgentById?.('skillsMatchingAgent') ?? mastra?.getAgent?.('skillsMatchingAgent');

    if (!agent) {
      throw new Error('Skills matching agent not found');
    }

    const prompt = buildCandidateTermsPrompt({
      jobDescription: inputData.jobDescription,
    });

    const candidateTerms = await extractCandidateTermsFromAgent(agent, prompt);
    const searchTerms = candidateTerms
      .map((term) => term.trim())
      .filter((term) => term.length > 0)
      .filter((term) => !candidateTerms.includes(normalizeTerm(term)));

    setState({
      ...inputData,
      skillCandidateTerms: searchTerms,
    });

    return searchTerms;
  },
});

// Step Iterator used in loops
// Fuzzy Match a skill terms against Topcoder Standardized Skills
const fuzzyMatchTermSkills = createStep({
  id: 'fuzzy-match-term-skills',
  description: "Fuzzy match a search term against Topcoder's standardized skills",
  inputSchema: z.string().min(1),
  outputSchema: z.object({
    term: z.string().min(1),
    matches: z.array(skillMatchSchema),
  }),
  execute: async ({ inputData: searchTerm, mastra, requestContext }) => {
    const logger = mastra?.getLogger?.();
    const matchSize = Number(process.env.SKILL_MATCHING_FUZZY_MATCH_SIZE ?? 3);

    logger.info('Fuzzy matching skill term {term}', { term: searchTerm });

    try {
      const toolResult = await standardizedSkillsFuzzyTool.execute?.(
        { term: searchTerm, size: matchSize },
        { requestContext },
      );

      if (!toolResult || 'error' in toolResult || !toolResult.matches) {
        return {
          term: searchTerm,
          matches: [],
        };
      }

      return {
        term: searchTerm,
        matches: toolResult.matches,
      };
    } catch (error) {
      logger?.error('Skill fuzzymatch failed for term {term}', {
        term: searchTerm,
        error,
      });
      return {
        term: searchTerm,
        matches: [],
      };
    }
  },
});

// Step Iterator used in loops
// Semantic search a skill term against Topcoder Standardized Skills
const semanticMatchTermSkills = createStep({
  id: 'semantic-match-term-skills',
  description: "Semantic search a term against Topcoder's standardized skills",
  inputSchema: z.string().min(1),
  outputSchema: z.object({
    term: z.string().min(1),
    matches: z.array(semanticMatchSchema),
  }),
  execute: async ({ inputData: searchTerm, mastra, requestContext }) => {
    const logger = mastra?.getLogger?.();
    logger?.info('Semantic searching skill term {term}', { term: searchTerm });

    try {
      const toolResult = await standardizedSkillsSemanticTool.execute?.(
        { text: searchTerm },
        { requestContext },
      );

      if (!toolResult || 'error' in toolResult || !toolResult.matches) {
        return {
          term: searchTerm,
          matches: [],
        };
      }

      return {
        term: searchTerm,
        matches: toolResult.matches,
      };
    } catch (error) {
      logger?.warn('Skill semantic search failed for term {term}', {
        term: searchTerm,
        error,
      });
      return {
        term: searchTerm,
        matches: [],
      };
    }
  },
});

const mapDirectMatchesToState = createStep({
  id: 'map-direct-matches-to-state',
  description: 'Map direct skill matches to the workflow state',
  inputSchema: z.array(
    z.object({
      term: z.string().min(1),
      matches: z.array(skillMatchSchema),
    }),
  ),
  outputSchema: z.array(scoredSkillSchema),
  stateSchema: extractionWorkflowStateSchema,
  execute: async ({ inputData, mastra, state, setState }) => {
    const logger = mastra?.getLogger?.();

    const allMatches: z.infer<typeof scoredSkillSchema>[] = [];
    inputData.forEach(({ term, matches }) => {
      matches.forEach((match) => {
        if (
          normalizeTerm(match.name) === normalizeTerm(term) &&
          !allMatches.find((m) => m.id === match.id)
        ) {
          allMatches.push({ ...match, score: 1.0 });
        }
      });
    });

    setState({
      ...state,
      matches: [...(state.matches || []), ...allMatches],
    });

    logger?.info('Mapped direct skill matches', {
      totalMatches: allMatches.length,
    });

    return allMatches;
  },
});

const mapSemanticMatchesToState = createStep({
  id: 'map-semantic-matches-to-state',
  description: 'Map semantic skill matches to the workflow state',
  inputSchema: z.array(
    z.object({
      term: z.string().min(1),
      matches: z.array(semanticMatchSchema),
    }),
  ),
  outputSchema: z.array(scoredSkillSchema),
  stateSchema: extractionWorkflowStateSchema,
  execute: async ({ inputData, mastra, state, setState }) => {
    const logger = mastra?.getLogger?.();
    const threshold = Number(process.env.SKILL_MATCHING_SEMANTIC_THRESHOLD ?? 0.45);

    const allMatches: z.infer<typeof scoredSkillSchema>[] = [];
    inputData.forEach(({ matches }) => {
      matches.forEach((match) => {
        if (match.weighted_distance > threshold) {
          return;
        }

        const normalized = threshold > 0 ? match.weighted_distance / threshold : 1;
        const score = Math.max(0, Math.min(1, 1 - normalized));

        if (!allMatches.find((m) => m.id === match.id)) {
          allMatches.push({ id: match.id, name: match.name, score });
        }
      });
    });

    setState({
      ...state,
      matches: [...(state.matches || []), ...allMatches],
    });

    logger?.info('Mapped semantic skill matches', {
      totalMatches: allMatches.length,
    });

    return allMatches;
  },
});

const filterOutDirectMatches = createStep({
  id: 'filter-out-direct-matches',
  description: 'Filter out direct skill matches and pass remaining terms to semantic search',
  inputSchema: z.array(
    z.object({
      term: z.string().min(1),
      matches: z.array(skillMatchSchema),
    }),
  ),
  outputSchema: z.array(z.string().min(1)),
  stateSchema: extractionWorkflowStateSchema,
  execute: async ({ inputData }) => {
    const nonDirectTerms = inputData
      .filter(
        ({ term, matches }) =>
          matches.length === 0 ||
          !matches.some((match) => normalizeTerm(match.name) === normalizeTerm(term)),
      )
      .map(({ term }) => term);

    return nonDirectTerms;
  },
});

const semanticSearchWorkflow = createWorkflow({
  id: 'semantic-terms-workflow',
  description: 'Execute semantic search on term candidates not directly matching any TC skills',
  inputSchema: z.array(
    z.object({
      term: z.string().min(1),
      matches: z.array(skillMatchSchema),
    }),
  ),
  outputSchema: z.array(scoredSkillSchema),
  stateSchema: extractionWorkflowStateSchema,
})
  .then(filterOutDirectMatches)
  .foreach(semanticMatchTermSkills, {
    concurrency: Number(process.env.SKILL_MATCHING_CONCURRENCY ?? 5),
  })
  .then(mapSemanticMatchesToState)
  .commit();

const skillRefinementOutputSchema = z.object({
  'map-direct-matches-to-state': z.array(scoredSkillSchema),
  'semantic-terms-workflow': z.array(scoredSkillSchema),
});

// Nested Workflow
const skillSelectionAndRefinementWorkflow = createWorkflow({
  id: 'skill-selection-and-refinement-workflow',
  description:
    'Select directly matching skills and execute semantic search for the rest of skill candidates',
  inputSchema: z.array(
    z.object({
      term: z.string().min(1),
      matches: z.array(skillMatchSchema),
    }),
  ),
  outputSchema: skillRefinementOutputSchema,
  stateSchema: extractionWorkflowStateSchema,
})
  .parallel([mapDirectMatchesToState, semanticSearchWorkflow])
  .commit();

// Final step to deduplicate, filter, and output results from the working state
const outputFinalState = createStep({
  id: 'output-final-state',
  description: 'Deduplicate, filter low-confidence matches, and output the final workflow state',
  inputSchema: skillRefinementOutputSchema,
  outputSchema: extractionWorkflowStateSchema,
  stateSchema: extractionWorkflowStateSchema,
  execute: async ({ state, mastra }) => {
    const logger = mastra?.getLogger?.();
    const minScore = Number(process.env.SKILL_MATCHING_MIN_SCORE ?? 0.15);

    if (!state.matches) {
      return state;
    }

    // Build set of normalized candidate terms for validation
    const candidateTermsSet = new Set(
      (state.skillCandidateTerms || []).map(normalizeTerm)
    );

    // Deduplicate by skill ID, keeping highest score for each
    const skillMap = new Map<string, z.infer<typeof scoredSkillSchema>>();
    for (const match of state.matches) {
      const existing = skillMap.get(match.id);
      if (!existing || match.score > existing.score) {
        skillMap.set(match.id, match);
      }
    }

    // Filter out low-confidence matches and validate relevance
    const dedupedMatches = Array.from(skillMap.values())
      .filter((match) => {
        // Always keep high-confidence matches
        if (match.score >= minScore) {
          return true;
        }
        return false;
      })
      // For score=1 matches (direct), verify they relate to a candidate term
      .filter((match) => {
        if (match.score === 1) {
          const matchNameNorm = normalizeTerm(match.name);
          // Check if any candidate term matches or contains this skill name
          const isRelevant = Array.from(candidateTermsSet).some(
            (term) => term === matchNameNorm || 
                      term.includes(matchNameNorm) || 
                      matchNameNorm.includes(term)
          );
          if (!isRelevant) {
            logger?.debug('Filtering irrelevant direct match: {name}', { name: match.name });
          }
          return isRelevant;
        }
        return true;
      })
      .sort((a, b) => b.score - a.score);

    logger?.info('Deduplicated and filtered skill matches', {
      before: state.matches.length,
      after: dedupedMatches.length,
      filtered: state.matches.length - dedupedMatches.length,
    });

    return {
      ...state,
      matches: dedupedMatches,
    };
  },
});

// Main Workflow
// Skill Extraction Workflow to extract and match Topcoder standardized skills from a given job description
export const skillExtractionWorkflow = createWorkflow({
  id: 'skill-extraction-workflow',
  description:
    'Skill Extraction Workflow to extract and match Topcoder standardized skills from a given job description using iterative term generation and fuzzy matching with AI.',
  inputSchema: z.object({
    jobDescription: z.string().min(1),
  }),
  outputSchema: extractionWorkflowStateSchema,
  stateSchema: extractionWorkflowStateSchema,
})
  .then(preprocessJobDescription)
  .then(generateSkillCandidateTerms)
  .foreach(fuzzyMatchTermSkills, {
    concurrency: Number(process.env.SKILL_MATCHING_CONCURRENCY ?? 5),
  })
  .then(skillSelectionAndRefinementWorkflow)
  .then(outputFinalState)
  .commit();

const normalizeTerm = (term: string) => term.trim().toLowerCase();

const buildCandidateTermsPrompt = ({ jobDescription }: { jobDescription: string }) => {
  const baseInstructions = `Extract concise hard & soft capability skill search candidate terms from the job description. Return a JSON array of strings only.`;
  const refinementInstructions = `In priority order related to the job description, extract specific multi-word skill terms first, then simpler ones.`;

  return `${baseInstructions}

Job Description:
"""
${jobDescription}
"""

${refinementInstructions}
`;
};

const extractCandidateTermsFromAgent = async (
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
