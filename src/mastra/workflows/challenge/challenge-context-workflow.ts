import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { tcAILogger } from '../../../utils/logger';
import { fetchChallengeTool } from '../../tools/challenge/fetch-challenge-tool';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const constraintSchema = z.object({
    id: z.string(),
    text: z.string(),
});

const requirementSchema = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    priority: z.enum(['high', 'medium', 'low']),
    constraints: z.array(constraintSchema),
});

const requirementGroupSchema = z.object({
    id: z.string().describe('Sequential group ID, e.g. GRP_01'),
    name: z.string().describe('Short name of the feature area / story, e.g. "Energy Monitoring"'),
    requirementIds: z.array(z.string()).describe('Ordered list of requirement IDs belonging to this group'),
});

const skillSchema = z.object({
    id: z.string(),
    name: z.string(),
});

const reviewerInfoSchema = z.object({
    scorecardId: z.string(),
    isMemberReview: z.boolean(),
    type: z.string().optional(),
    aiWorkflowId: z.string().optional(),
});

/**
 * Runtime environment **expectations** extracted solely from the challenge
 * specification (JSON).  At this stage no submission exists yet — every field
 * reflects what the challenge *requires or implies*, not what a submission
 * actually provides.
 */
const runtimeEnvironmentSchema = z.object({
    os: z.string().describe('Expected target operating system (e.g. "Linux", "Windows", "macOS", "any", "unknown")'),
    containerized: z.boolean().describe('Whether the challenge expects the solution to run inside a container (Docker, Podman, etc.)'),
    containerTool: z.string().optional().describe('Expected container tool if containerized (e.g. "Docker", "Docker Compose", "Podman", "Kubernetes")'),
    dockerfileExpected: z.boolean().optional().describe('Whether the challenge expects a Dockerfile / docker-compose file to be included in the submission'),
    runtimeEngine: z.string().describe('Expected primary runtime engine (e.g. "Node.js", "Python", "JVM", "Go", ".NET CLR", "browser", "unknown")'),
    runtimeVersion: z.string().optional().describe('Required runtime version if specified in the challenge (e.g. ">=18", "3.11", "21 LTS")'),
    programmingLanguages: z.array(z.string()).describe('Programming languages required by the challenge (e.g. ["TypeScript", "Python"])'),
    packageManager: z.string().optional().describe('Expected package manager if mentioned in the challenge (e.g. "npm", "pnpm", "yarn", "pip", "poetry", "maven")'),
    buildTool: z.string().optional().describe('Expected build tool if mentioned in the challenge (e.g. "webpack", "vite", "tsc", "gradle", "make")'),
    deploymentTarget: z.string().optional().describe('Expected deployment target if specified (e.g. "AWS Lambda", "Vercel", "Heroku", "on-premise", "local")'),
    serverType: z.string().optional().describe('Expected server framework or type if specified (e.g. "Express", "NestJS", "FastAPI", "Spring Boot")'),
    databaseEngine: z.string().optional().describe('Expected primary database if mentioned in the challenge (e.g. "PostgreSQL", "MongoDB", "DynamoDB")'),
    additionalServices: z.array(z.string()).optional().describe('Additional services expected by the challenge (e.g. ["Redis", "RabbitMQ", "Elasticsearch"])'),
    notes: z.string().optional().describe('Any other runtime / environment expectations inferred from the challenge spec'),
});

/**
 * Existing codebase / starting-point information extracted from the challenge
 * specification.  Captures whether the challenge provides pre-existing
 * artifacts (repos, starter code, documentation, designs, APIs, datasets)
 * or if the work is entirely greenfield.
 */
const existingArtifactSchema = z.object({
    type: z.enum([
        'repository', 'starter_code', 'boilerplate', 'documentation',
        'api_spec', 'design', 'dataset', 'database_dump', 'config',
        'library', 'other',
    ]).describe('Kind of pre-existing artifact'),
    description: z.string().describe('What this artifact contains or provides'),
    url: z.string().optional().describe('URL / link if mentioned (e.g. Git repo, Figma, Swagger)'),
    notes: z.string().optional().describe('Additional context about this artifact'),
});

const existingCodebaseSchema = z.object({
    isGreenfield: z.boolean().describe(
        'true if the challenge is entirely from scratch with no pre-existing code or artifacts to build upon',
    ),
    summary: z.string().describe(
        'Brief description of the existing codebase / starting-point status '
        + '(e.g. "Existing NestJS API with Prisma ORM — extend with new endpoints" '
        + 'or "Greenfield — build from scratch")',
    ),
    artifacts: z.array(existingArtifactSchema).describe(
        'List of pre-existing artifacts referenced by the challenge (repos, starter code, docs, designs, etc.). '
        + 'Empty array if greenfield.',
    ),
    repositoryUrl: z.string().optional().describe(
        'Primary Git repository URL if an existing codebase is provided',
    ),
    branchOrTag: z.string().optional().describe(
        'Branch, tag, or commit reference to use if specified',
    ),
    languages: z.array(z.string()).optional().describe(
        'Programming languages present in the existing codebase (may differ from challenge requirements)',
    ),
    frameworks: z.array(z.string()).optional().describe(
        'Frameworks / libraries already present in the existing codebase',
    ),
    notes: z.string().optional().describe(
        'Any other observations about the starting point inferred from the challenge spec',
    ),
});

/**
 * Structured submission guidelines extracted from the challenge specification.
 * Breaks down the free-form "what / how / where to submit" prose into
 * actionable fields for downstream review automation.
 */
const submissionGuidelinesSchema = z.object({
    summary: z.string().describe(
        'Brief overall summary of the submission requirements in 1-3 sentences',
    ),
    whatToSubmit: z.array(z.string()).describe(
        'List of deliverables the submitter must include '
        + '(e.g. "source code", "README.md", "Postman collection", "Docker setup", "unit tests", "demo video")',
    ),
    howToSubmit: z.string().describe(
        'Instructions on how to package / format the submission '
        + '(e.g. "ZIP archive", "Git patch file", "single commit on a branch")',
    ),
    whereToSubmit: z.string().describe(
        'Submission destination / platform '
        + '(e.g. "Topcoder challenge page", "GitHub pull request", "external URL")',
    ),
    submissionType: z.enum([
        'full_codebase', 'patch', 'link_to_repository',
        'link_to_deployment', 'file_upload', 'other',
    ]).describe(
        'Whether the challenge expects the entire codebase, a patch / diff of an existing codebase, '
        + 'a link to an external Git repository, a link to a running deployment, a file upload, or something else',
    ),
    submissionStorage: z.enum([
        'topcoder_upload', 'git_repository', 'external_file_storage',
        'cloud_deployment', 'other',
    ]).describe(
        'Where the final submission artifact lives — uploaded to Topcoder, '
        + 'pushed to a Git repo, hosted on external file storage (S3, Drive, etc.), '
        + 'deployed to a cloud environment, or other',
    ),
    isPatchOfExisting: z.boolean().describe(
        'true if the submission should be a patch / diff on top of an existing codebase '
        + 'rather than a standalone full codebase',
    ),
    eligibilityConditions: z.array(z.string()).optional().describe(
        'Any conditions that must be met for the submission to be eligible for review '
        + '(e.g. "must pass SAST scanner", "must include unit tests with ≥80% coverage")',
    ),
    notes: z.string().optional().describe(
        'Any additional submission-related information that does not fit the above fields',
    ),
});

const prizeSchema = z.object({
    placement: z.number(),
    value: z.number(),
    currency: z.string(),
});

// ---------------------------------------------------------------------------
// Scorecard Schemas (mirrors GET /v6/scorecards/:id response)
// ---------------------------------------------------------------------------

const scorecardQuestionSchema = z.object({
    id: z.string(),
    type: z.enum(['SCALE', 'YES_NO', 'TEST_CASE']),
    description: z.string(),
    guidelines: z.string(),
    weight: z.number(),
    requiresUpload: z.boolean().optional(),
    scaleMin: z.number().nullable().optional(),
    scaleMax: z.number().nullable().optional(),
    sortOrder: z.number(),
});

const scorecardSectionSchema = z.object({
    id: z.string(),
    name: z.string(),
    weight: z.number(),
    sortOrder: z.number(),
    questions: z.array(scorecardQuestionSchema),
});

const scorecardGroupSchema = z.object({
    id: z.string(),
    name: z.string(),
    weight: z.number(),
    sortOrder: z.number(),
    sections: z.array(scorecardSectionSchema),
});

const scorecardSchema = z.object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'DELETED']),
    type: z.enum([
        'SCREENING', 'REVIEW', 'APPROVAL', 'POST_MORTEM',
        'SPECIFICATION_REVIEW', 'CHECKPOINT_SCREENING',
        'CHECKPOINT_REVIEW', 'ITERATIVE_REVIEW',
    ]),
    challengeTrack: z.string(),
    challengeType: z.string(),
    minScore: z.number(),
    minimumPassingScore: z.number(),
    maxScore: z.number(),
    scorecardGroups: z.array(scorecardGroupSchema),
});

export type Scorecard = z.infer<typeof scorecardSchema>;

const unifiedContextSchema = z.object({
    challengeId: z.string(),
    title: z.string(),
    descriptionRaw: z.string(),
    privateDescription: z.string().optional(),
    descriptionFormat: z.string(),

    requirements: z.array(requirementSchema),
    requirement_groups: z.array(requirementGroupSchema),
    tech_stack: z.array(z.string()),
    skills: z.array(skillSchema),

    challenge_metadata: z.object({
        status: z.string(),
        track: z.string(),
        type: z.string(),
        totalPrizes: z.number(),
        numOfRegistrants: z.number(),
        numOfSubmissions: z.number(),
        isTask: z.boolean(),
    }),

    timeline: z.object({
        registrationStartDate: z.string(),
        registrationEndDate: z.string(),
        startDate: z.string(),
        endDate: z.string(),
        totalDurationDays: z.number(),
    }),

    prizes: z.array(prizeSchema),

    review_criteria: z.object({
        reviewType: z.string(),
        reviewers: z.array(reviewerInfoSchema),
        scorecard: scorecardSchema.nullable().describe(
            'The human review scorecard fetched from the Topcoder API. '
            + 'null if no human reviewer entry (isMemberReview: true) was found or the API call failed.',
        ),
    }),

    runtime_environment: runtimeEnvironmentSchema.describe(
        'Runtime / execution environment expectations extracted solely from the challenge specification. '
        + 'No submission exists at this point — all values reflect what the challenge requires or implies.',
    ),

    existing_codebase: existingCodebaseSchema.describe(
        'Status quo of the challenge: existing artifacts, codebase, documentation, or starting-point '
        + 'material referenced in the specification. If none, isGreenfield is true and artifacts is empty.',
    ),

    submission_guidelines: submissionGuidelinesSchema.describe(
        'Structured submission guidelines extracted from the challenge specification: '
        + 'what to deliver, how to package it, where to submit, and whether it is a patch or full codebase.',
    ),
    discussion_url: z.string().optional(),
});

// Re-export the output type for downstream consumers
export type UnifiedChallengeContext = z.infer<typeof unifiedContextSchema>;

// Schema for the AI-extracted portion of the context
const aiExtractedSchema = z.object({
    requirements: z.array(requirementSchema),
    requirement_groups: z.array(requirementGroupSchema),
    tech_stack: z.array(z.string()),
    runtime_environment: runtimeEnvironmentSchema,
    existing_codebase: existingCodebaseSchema,
    submission_guidelines: submissionGuidelinesSchema,
});

type AIExtracted = z.infer<typeof aiExtractedSchema>;

// ---------------------------------------------------------------------------
// Step 1 – Fetch challenge details by challenge ID
// ---------------------------------------------------------------------------

const fetchChallengeDetails = createStep({
    id: 'fetch-challenge-details',
    description: 'Fetches challenge details from Topcoder API using challenge ID',
    inputSchema: z.object({
        challengeId: z
            .string()
            .uuid()
            .describe('UUID of the challenge to fetch from Topcoder API'),
    }),
    outputSchema: z.object({
        challenge: z.any().describe('Challenge details object returned by the API'),
    }),
    execute: async ({ inputData, requestContext }) => {
        tcAILogger.info(`[challenge-context:fetch-challenge-details] Fetching challenge: ${inputData.challengeId}`);

        const toolResult = await fetchChallengeTool.execute?.(
            { challengeId: inputData.challengeId },
            { requestContext },
        );

        if (!toolResult || 'error' in toolResult || !toolResult.challenge) {
            throw new Error(`Failed to fetch challenge details for ID ${inputData.challengeId}`);
        }

        tcAILogger.info('[challenge-context:fetch-challenge-details] Challenge details fetched successfully');
        return { challenge: toolResult.challenge };
    },
});

// ---------------------------------------------------------------------------
// Step 2 – Use the challenge-parser-agent (AI) to extract requirements,
//           tech stack, and submission guidelines from the free-form
//           challenge description, then merge with deterministic fields.
// ---------------------------------------------------------------------------

const parseChallengeContext = createStep({
    id: 'parse-challenge-context',
    description:
        'Parses challenge JSON into a unified review context. ' +
        'Uses the challenge-parser-agent for AI-driven extraction of requirements, ' +
        'tech stack, and submission guidelines from the fuzzy markdown description.',
    inputSchema: z.object({
        challenge: z.any(),
    }),
    outputSchema: unifiedContextSchema,
    execute: async ({ inputData, mastra }) => {
        const data = inputData.challenge;
        tcAILogger.info(`[challenge-context:parse] Parsing challenge: "${data.name ?? 'Untitled'}" (ID: ${data.id ?? 'N/A'})`);

        // -- AI-powered extraction ------------------------------------------------
        tcAILogger.info('[challenge-context:parse] Starting AI-powered extraction of requirements, tech stack, and guidelines...');
        const aiExtracted = await extractWithAI(mastra!, data);
        tcAILogger.info(`[challenge-context:parse] AI extraction complete — ${aiExtracted.requirements.length} requirements, ${aiExtracted.tech_stack.length} tech stack items, ${aiExtracted.requirement_groups.length} groups`);

        // -- Skills with full category info (deterministic) -----------------------
        const skills: z.infer<typeof skillSchema>[] = (data.skills ?? []).map(
            (s: {
                id: string;
                name: string;
            }) => ({
                id: s.id,
                name: s.name,
            }),
        );

        // -- Timeline (deterministic) --------------------------------------------
        const startDate = data.startDate ?? data.registrationStartDate ?? '';
        const endDate = data.endDate ?? '';
        const totalDurationDays =
            startDate && endDate
                ? Math.round(
                    (new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000,
                )
                : 0;

        // -- Prizes (deterministic) -----------------------------------------------
        const placementPrizeSet = (data.prizeSets ?? []).find(
            (ps: { type: string }) => ps.type === 'PLACEMENT',
        );
        const prizes: z.infer<typeof prizeSchema>[] = (placementPrizeSet?.prizes ?? []).map(
            (p: { type: string; value: number }, idx: number) => ({
                placement: idx + 1,
                value: p.value,
                currency: p.type,
            }),
        );

        // -- Reviewers (deterministic) --------------------------------------------
        const reviewers: z.infer<typeof reviewerInfoSchema>[] = (data.reviewers ?? []).map(
            (r: {
                scorecardId: string;
                isMemberReview: boolean;
                type?: string;
                aiWorkflowId?: string;
            }) => ({
                scorecardId: r.scorecardId,
                isMemberReview: r.isMemberReview,
                type: r.type,
                aiWorkflowId: r.aiWorkflowId,
            }),
        );

        // -- Discussion URL -------------------------------------------------------
        const discussion = (data.discussions ?? [])[0];
        const discussionUrl: string | undefined = discussion?.url;

        // -- Scorecard (deterministic + API fetch) --------------------------------
        // Find the single human reviewer entry (isMemberReview: true)
        const humanReviewer = (data.reviewers ?? []).find(
            (r: { isMemberReview: boolean }) => r.isMemberReview === true,
        ) as { scorecardId: string } | undefined;

        let scorecard: z.infer<typeof scorecardSchema> | null = null;
        if (humanReviewer?.scorecardId) {
            tcAILogger.info(`[challenge-context:parse] Fetching scorecard: ${humanReviewer.scorecardId}`);
            scorecard = await fetchScorecard(humanReviewer.scorecardId);
            tcAILogger.info(`[challenge-context:parse] Scorecard fetch ${scorecard ? `succeeded: "${scorecard.name}" (${scorecard.scorecardGroups.length} groups)` : 'returned null'}`);
        } else {
            tcAILogger.info('[challenge-context:parse] No human reviewer found — skipping scorecard fetch');
        }

        // -- Assemble unified context ---------------------------------------------
        const context: UnifiedChallengeContext = {
            challengeId: data.id,
            title: data.name,
            descriptionRaw: data.description ?? '',
            privateDescription: data.privateDescription || undefined,
            descriptionFormat: data.descriptionFormat ?? 'markdown',

            requirements: aiExtracted.requirements,
            requirement_groups: aiExtracted.requirement_groups,
            tech_stack: aiExtracted.tech_stack,
            runtime_environment: aiExtracted.runtime_environment,
            existing_codebase: aiExtracted.existing_codebase,
            skills,

            challenge_metadata: {
                status: data.status ?? '',
                track: data.track?.name ?? '',
                type: data.type?.name ?? '',
                totalPrizes: data.overview?.totalPrizes ?? 0,
                numOfRegistrants: data.numOfRegistrants ?? 0,
                numOfSubmissions: data.numOfSubmissions ?? 0,
                isTask: data.task?.isTask ?? false,
            },

            timeline: {
                registrationStartDate: data.registrationStartDate ?? '',
                registrationEndDate: data.registrationEndDate ?? '',
                startDate,
                endDate,
                totalDurationDays,
            },

            prizes,

            review_criteria: {
                reviewType: data.legacy?.reviewType ?? 'UNKNOWN',
                reviewers,
                scorecard,
            },

            submission_guidelines: aiExtracted.submission_guidelines,
            discussion_url: discussionUrl,
        };

        tcAILogger.info(`[challenge-context:parse] Unified context assembled — challenge "${context.title}", track: ${context.challenge_metadata.track}, type: ${context.challenge_metadata.type}, prizes: ${context.prizes.length}, skills: ${context.skills.length}`);
        return context;
    },
});

// ---------------------------------------------------------------------------
// Scorecard Fetch Helper
// ---------------------------------------------------------------------------

const SCORECARD_API_BASE = process.env.TC_API_BASE_URL ?? 'https://api.topcoder.com/v6';

/**
 * Fetches the full scorecard (with groups → sections → questions) from the
 * Topcoder Review API:  GET /v6/scorecards/:id
 *
 * Returns `null` when the API is unreachable or returns a non-200 status so
 * that the workflow can continue gracefully without the scorecard.
 */
async function fetchScorecard(scorecardId: string): Promise<z.infer<typeof scorecardSchema> | null> {
    const url = `${SCORECARD_API_BASE}/scorecards/${encodeURIComponent(scorecardId)}`;
    try {
        tcAILogger.info(`[challenge-context:fetchScorecard] GET ${url}`);
        const res = await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
            tcAILogger.error(`[challenge-context:fetchScorecard] HTTP ${res.status} for ${url}`);
            return null;
        }
        const body = await res.json();
        // Validate against our schema — passthrough unknown fields silently
        const parsed = scorecardSchema.safeParse(body);
        if (!parsed.success) {
            tcAILogger.error(
                `[challenge-context:fetchScorecard] Schema validation failed: ${parsed.error.message}`,
            );
            return null;
        }
        return parsed.data;
    } catch (err) {
        tcAILogger.error(`[challenge-context:fetchScorecard] Failed to fetch from ${url}: ${err}`);
        return null;
    }
}

// ---------------------------------------------------------------------------
// AI Extraction Helper
// ---------------------------------------------------------------------------

/**
 * Builds a prompt from the challenge data and invokes the challenge-parser-agent
 * with structured output to extract requirements, tech stack, and submission
 * guidelines.  The output is validated against `aiExtractedSchema` by the AI SDK.
 */
async function extractWithAI(
    mastra: Parameters<
        NonNullable<Parameters<typeof createStep>[0]['execute']>
    > extends [infer P, ...unknown[]]
        ? P extends { mastra: infer M }
        ? NonNullable<M>
        : never
        : never,
    data: Record<string, unknown>,
): Promise<AIExtracted> {
    const agent = mastra.getAgentById('challenge-parser-agent');

    // Compose all textual content the agent should analyse
    const sections: string[] = [];

    sections.push(`# Challenge: ${(data.name as string) ?? 'Untitled'}`);
    sections.push(`## Challenge ID\n${(data.id as string) ?? 'N/A'}`);

    if (data.description) {
        sections.push(`## Public Description\n${data.description as string}`);
    }
    if (data.privateDescription) {
        sections.push(`## Private Description\n${data.privateDescription as string}`);
    }
    if (Array.isArray(data.skills) && data.skills.length) {
        const skillsList = data.skills
            .map((s: { id: string; name: string }) => `- ${s.name} (${s.id})`)
            .join('\n');
        sections.push(`## Registered Skills\n${skillsList}`);
    }
    if (Array.isArray(data.tags) && data.tags.length) {
        sections.push(`## Tags\n${data.tags.join(', ')}`);
    }

    const prompt = [
        'Analyse the following Topcoder challenge specification and extract:',
        '1. All individual requirements (with IDs, titles, descriptions, priorities, constraints)',
        '2. Requirement groups — cluster requirements by feature area / story / problem domain they belong to',
        '3. The full technology stack (languages, frameworks, tools, services, protocols, databases) implied or explicitly mentioned',
        '4. Runtime environment EXPECTATIONS — there is NO submission yet; extract only what the challenge REQUIRES or IMPLIES:',
        '   a. Expected target operating system (Linux, Windows, macOS, or any/unknown)',
        '   b. Whether the challenge expects the solution to run inside a container (Docker, Podman, etc.) and which container tool',
        '   c. Whether the challenge expects a Dockerfile / docker-compose file to be included',
        '   d. Expected primary runtime engine (Node.js, Python interpreter, JVM, Go, .NET CLR, browser, etc.)',
        '   e. Required runtime version if mentioned in the spec',
        '   f. Programming language(s) required by the challenge (TypeScript, JavaScript, Python, Java, etc.)',
        '   g. Expected package manager (npm, pnpm, yarn, pip, poetry, maven, etc.)',
        '   h. Expected build tool (webpack, vite, tsc, gradle, make, etc.)',
        '   i. Expected deployment target (AWS Lambda, Vercel, Heroku, on-premise, local, etc.)',
        '   j. Expected server framework or type (Express, NestJS, FastAPI, Spring Boot, etc.)',
        '   k. Expected primary database engine if applicable',
        '   l. Expected additional services (Redis, RabbitMQ, Elasticsearch, etc.)',
        '   m. Any other runtime / environment expectations inferred from the challenge spec',
        '5. Existing codebase / starting-point status — determine from the challenge spec:',
        '   a. Is this a GREENFIELD challenge (build from scratch) or does it build upon existing artifacts?',
        '   b. If existing artifacts are provided, list each one with its type (repository, starter_code,',
        '      boilerplate, documentation, api_spec, design, dataset, database_dump, config, library, other)',
        '   c. For each artifact: what it contains, any URL/link, and additional notes',
        '   d. Primary repository URL and branch/tag if an existing codebase is referenced',
        '   e. Programming languages and frameworks already present in the existing codebase',
        '   f. Write a brief summary of the starting-point status',
        '   g. If no existing artifacts are mentioned, set isGreenfield=true and artifacts=[]',
        '6. Submission guidelines — extract STRUCTURED information:',
        '   a. A brief overall summary of the submission requirements (1-3 sentences)',
        '   b. What to submit — list every deliverable (source code, README, Docker files, tests, demo video, etc.)',
        '   c. How to submit — packaging format (ZIP archive, Git patch, single commit, etc.)',
        '   d. Where to submit (Topcoder challenge page, GitHub PR, external URL, etc.)',
        '   e. Submission type — one of: full_codebase, patch, link_to_repository, link_to_deployment, file_upload, other',
        '   f. Submission storage — where the artifact lives: topcoder_upload, git_repository, external_file_storage, cloud_deployment, other',
        '   g. Is this a PATCH of an existing codebase or a standalone full codebase?',
        '   h. Eligibility conditions (e.g. "must pass SAST scanner", "≥80% test coverage")',
        '   i. Any additional notes',
        '',
        '---BEGIN CHALLENGE SPECIFICATION---',
        sections.join('\n\n'),
        '---END CHALLENGE SPECIFICATION---',
    ].join('\n');

    tcAILogger.info('[challenge-context:extractWithAI] Invoking challenge-parser-agent for structured extraction...');
    const response = await agent.generate(prompt, {
        structuredOutput: { schema: aiExtractedSchema },
    });

    if (!response.object) {
        tcAILogger.error('[challenge-context:extractWithAI] Agent returned no structured output');
        throw new Error('Challenge parser agent returned no structured output');
    }

    tcAILogger.info('[challenge-context:extractWithAI] Agent returned structured output successfully');
    return response.object;
}

// ---------------------------------------------------------------------------
// Workflow Definition
// ---------------------------------------------------------------------------

export const challengeContextWorkflow = createWorkflow({
    id: 'challenge-context',
    inputSchema: z.object({
        challengeId: z.string().uuid().describe('Challenge ID to fetch challenge details from API'),
    }),
    outputSchema: unifiedContextSchema,
})
    .then(fetchChallengeDetails)
    .then(parseChallengeContext)
    .commit();
