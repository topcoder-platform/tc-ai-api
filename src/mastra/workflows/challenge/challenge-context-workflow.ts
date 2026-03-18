import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { tcAILogger } from '../../../utils/logger';
import { generateWithStructuredOutputFallback } from '../../../utils/structured-output-wrapper';
import { fetchChallengeTool } from '../../tools/challenge/fetch-challenge-tool';
import { M2MService } from '../../../utils/auth/m2m.service';

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
const _aiExtractedSchema = z.object({
    requirements: z.array(requirementSchema),
    requirement_groups: z.array(requirementGroupSchema),
    tech_stack: z.array(z.string()),
    runtime_environment: runtimeEnvironmentSchema,
    existing_codebase: existingCodebaseSchema,
    submission_guidelines: submissionGuidelinesSchema,
});

type AIExtracted = z.infer<typeof _aiExtractedSchema>;

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
// AI Extraction — Decomposed & Validated
// ---------------------------------------------------------------------------

// Focused sub-schemas for decomposed extraction calls
const requirementsAndGroupsSchema = z.object({
    requirements: z.array(requirementSchema),
    requirement_groups: z.array(requirementGroupSchema),
});

const techAndRuntimeSchema = z.object({
    tech_stack: z.array(z.string()),
    runtime_environment: runtimeEnvironmentSchema,
});

const codebaseExtractedSchema = z.object({
    existing_codebase: existingCodebaseSchema,
});

const guidelinesExtractedSchema = z.object({
    submission_guidelines: submissionGuidelinesSchema,
});

// ---------------------------------------------------------------------------
// Review API – Challenge Review Context Persistence
// ---------------------------------------------------------------------------

const REVIEW_API_BASE = process.env.TC_API_BASE ? `${process.env.TC_API_BASE}/v6` : 'https://api.topcoder.com/v6';
const m2mService = new M2MService();

async function upsertChallengeReviewContext(context: UnifiedChallengeContext): Promise<void> {
    const challengeId = context.challengeId;
    const token = await m2mService.getM2MToken();

    const commonHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
    };

    const createBody = {
        challengeId,
        context,
        status: 'AI_GENERATED' as const,
    };

    const createUrl = `${REVIEW_API_BASE}/ai-review/context`;

    try {
        tcAILogger.info(
            `[challenge-context:review-api] Creating challenge review context via POST ${createUrl} for challenge ${challengeId}`,
        );
        const createRes = await fetch(createUrl, {
            method: 'POST',
            headers: commonHeaders,
            body: JSON.stringify(createBody),
            signal: AbortSignal.timeout(15_000),
        });

        if (createRes.ok) {
            tcAILogger.info(
                `[challenge-context:review-api] Created challenge review context for challenge ${challengeId} (HTTP ${createRes.status})`,
            );
            return;
        }

        if (createRes.status !== 409) {
            const createErrorBody = await createRes.text().catch(() => '<failed to read body>');
            tcAILogger.error(
                `[challenge-context:review-api] Failed to create challenge review context for challenge ${challengeId} (HTTP ${createRes.status}) — body: ${createErrorBody}`,
            );
            return;
        }

        // Context already exists – fall back to update semantics
        const updateUrl = `${REVIEW_API_BASE}/ai-review/context/${encodeURIComponent(challengeId)}`;
        const updateBody = {
            context,
            status: 'AI_GENERATED' as const,
        };

        tcAILogger.info(
            `[challenge-context:review-api] Context already exists, updating via PUT ${updateUrl} for challenge ${challengeId}`,
        );
        const updateRes = await fetch(updateUrl, {
            method: 'PUT',
            headers: commonHeaders,
            body: JSON.stringify(updateBody),
            signal: AbortSignal.timeout(15_000),
        });

        if (!updateRes.ok) {
            tcAILogger.error(
                `[challenge-context:review-api] Failed to update challenge review context for challenge ${challengeId} (HTTP ${updateRes.status})`,
            );
            return;
        }

        tcAILogger.info(
            `[challenge-context:review-api] Updated challenge review context for challenge ${challengeId} (HTTP ${updateRes.status})`,
        );
    } catch (err) {
        tcAILogger.error(
            `[challenge-context:review-api] Error while upserting challenge review context for challenge ${challengeId}: ${err}`,
        );
    }
}

// ---------------------------------------------------------------------------
// Persistence Step – Save Unified Context into Review API
// ---------------------------------------------------------------------------

const persistChallengeContext = createStep({
    id: 'persist-challenge-review-context',
    description:
        'Persists the unified challenge review context into the Topcoder Review API using M2M authentication. '
        + 'Creates a new context if none exists, otherwise updates the existing record.',
    inputSchema: unifiedContextSchema,
    outputSchema: unifiedContextSchema,
    execute: async ({ inputData }) => {
        await upsertChallengeReviewContext(inputData);
        return inputData;
    },
});

/**
 * Assembles the plain-text challenge specification from the raw API data.
 * Shared by all focused extraction calls.
 */
function buildChallengeText(data: Record<string, unknown>): string {
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

    return sections.join('\n\n');
}

// -- Focused extraction: Requirements + Grouping ----------------------------

async function extractRequirementsAndGroups(
    agent: any,
    challengeText: string,
): Promise<z.infer<typeof requirementsAndGroupsSchema>> {
    const prompt = [
        'Analyse the following Topcoder challenge specification and extract:',
        '1. All individual requirements (with sequential IDs REQ_01, REQ_02, …; concise titles ≤12 words;',
        '   thorough descriptions preserving technical detail; priority high/medium/low; constraints with IDs CONSTR_01, CONSTR_02, …)',
        '2. Requirement groups — cluster related requirements by feature area or problem domain',
        '   (with sequential IDs GRP_01, GRP_02, …). Every requirement must appear in exactly one group.',
        '',
        'Follow the spec-requirements-extraction and requirement-grouping parsing protocols from your instructions.',
        '',
        '---BEGIN CHALLENGE SPECIFICATION---',
        challengeText,
        '---END CHALLENGE SPECIFICATION---',
    ].join('\n');

    tcAILogger.info('[challenge-context:extractRequirements] Invoking agent for requirements + grouping...');
    const { response } = await generateWithStructuredOutputFallback({
        agent,
        prompt,
        schema: requirementsAndGroupsSchema,
        sectionName: 'extractRequirements',
    });
    if (!response.object) throw new Error('Agent returned no structured output for requirements');
    tcAILogger.info(
        `[challenge-context:extractRequirements] Done — ${response.object.requirements.length} requirements, ${response.object.requirement_groups.length} groups`,
    );
    return response.object;
}

// -- Focused extraction: Tech Stack + Runtime Environment -------------------

async function extractTechAndRuntime(
    agent: any,
    challengeText: string,
): Promise<z.infer<typeof techAndRuntimeSchema>> {
    const prompt = [
        'Analyse the following Topcoder challenge specification and extract:',
        '1. The full technology stack as a flat array of canonical-cased names',
        '   (languages, frameworks, tools, services, protocols, databases — both explicit and implied)',
        '2. Runtime environment EXPECTATIONS — there is NO submission yet; extract only what the challenge REQUIRES or IMPLIES:',
        '   - Target OS, containerization expectations (tool, Dockerfile), runtime engine + version',
        '   - Programming languages, package manager, build tool',
        '   - Deployment target, server type, database engine, additional services',
        '   - Any other runtime / environment notes',
        '',
        'Follow the tech-stack-extraction parsing protocol from your instructions.',
        '',
        '---BEGIN CHALLENGE SPECIFICATION---',
        challengeText,
        '---END CHALLENGE SPECIFICATION---',
    ].join('\n');

    tcAILogger.info('[challenge-context:extractTechRuntime] Invoking agent for tech stack + runtime...');
    const { response } = await generateWithStructuredOutputFallback({
        agent,
        prompt,
        schema: techAndRuntimeSchema,
        sectionName: 'extractTechRuntime',
    });
    if (!response.object) throw new Error('Agent returned no structured output for tech/runtime');
    tcAILogger.info(`[challenge-context:extractTechRuntime] Done — ${response.object.tech_stack.length} tech stack items`);
    return response.object;
}

// -- Focused extraction: Existing Codebase Detection ------------------------

async function extractExistingCodebase(
    agent: any,
    challengeText: string,
): Promise<z.infer<typeof codebaseExtractedSchema>> {
    const prompt = [
        'Analyse the following Topcoder challenge specification and determine:',
        '1. Whether the challenge is GREENFIELD (build from scratch) or builds upon existing artifacts',
        '2. List all pre-existing artifacts with type (repository, starter_code, boilerplate, documentation,',
        '   api_spec, design, dataset, database_dump, config, library, other), description, URL, and notes',
        '3. Primary repository URL and branch/tag if an existing codebase is referenced',
        '4. Languages and frameworks already present in any existing codebase',
        '5. A brief summary of the starting-point status',
        '',
        'If no existing artifacts are mentioned, set isGreenfield=true and artifacts=[].',
        '',
        'Follow the codebase-detection parsing protocol from your instructions.',
        '',
        '---BEGIN CHALLENGE SPECIFICATION---',
        challengeText,
        '---END CHALLENGE SPECIFICATION---',
    ].join('\n');

    tcAILogger.info('[challenge-context:extractCodebase] Invoking agent for codebase detection...');
    const { response } = await generateWithStructuredOutputFallback({
        agent,
        prompt,
        schema: codebaseExtractedSchema,
        sectionName: 'extractCodebase',
    });
    if (!response.object) throw new Error('Agent returned no structured output for codebase');
    tcAILogger.info(`[challenge-context:extractCodebase] Done — greenfield: ${response.object.existing_codebase.isGreenfield}`);
    return response.object;
}

// -- Focused extraction: Submission Guidelines ------------------------------

async function extractSubmissionGuidelines(
    agent: any,
    challengeText: string,
): Promise<z.infer<typeof guidelinesExtractedSchema>> {
    const prompt = [
        'Analyse the following Topcoder challenge specification and extract STRUCTURED submission information:',
        '1. A brief overall summary of the submission requirements (1-3 sentences)',
        '2. What to submit — list ONLY deliverables EXPLICITLY requested in the specification',
        '3. How to submit — packaging format (ZIP archive, Git patch, single commit, etc.)',
        '4. Where to submit (Topcoder challenge page, GitHub PR, external URL, etc.)',
        '5. Submission type (full_codebase, patch, link_to_repository, link_to_deployment, file_upload, other)',
        '6. Submission storage (topcoder_upload, git_repository, external_file_storage, cloud_deployment, other)',
        '7. Whether this is a patch of an existing codebase or standalone',
        '8. Eligibility conditions (e.g. "must pass SAST scanner")',
        '9. Any additional notes',
        '',
        'CRITICAL RULES for whatToSubmit:',
        '- Include ONLY deliverables the specification EXPLICITLY asks the submitter to deliver or include.',
        '- Do NOT add deliverables inferred from evaluation criteria, review processes, or general best practices.',
        '- Do NOT include "test cases" or "unit tests" unless the spec explicitly says to submit them.',
        '- Do NOT list "documentation" as a separate item when a README is already listed.',
        '- If in doubt whether something is a required deliverable, leave it out.',
        '',
        'Follow the submission-guidelines-extraction parsing protocol from your instructions.',
        '',
        '---BEGIN CHALLENGE SPECIFICATION---',
        challengeText,
        '---END CHALLENGE SPECIFICATION---',
    ].join('\n');

    tcAILogger.info('[challenge-context:extractGuidelines] Invoking agent for submission guidelines...');
    const { response } = await generateWithStructuredOutputFallback({
        agent,
        prompt,
        schema: guidelinesExtractedSchema,
        sectionName: 'extractGuidelines',
    });
    if (!response.object) throw new Error('Agent returned no structured output for submission guidelines');
    tcAILogger.info(`[challenge-context:extractGuidelines] Done — ${response.object.submission_guidelines.whatToSubmit.length} deliverables`);
    return response.object;
}

// -- Post-extraction validation: whatToSubmit --------------------------------

const SUBMISSION_CONTEXT_TERMS = [
    'submit', 'include', 'provide', 'deliver', 'attach', 'upload',
    'should contain', 'must contain', 'must include', 'should include',
    'submission should', 'submission must', 'please submit', 'you should include',
];

const STOP_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'of', 'for', 'with', 'in', 'to',
    'is', 'it', 'on', 'at', 'by', 'be', 'as', 'do', 'no', 'not',
]);

// Canonical deliverable names that are always valid — these are standard
// submission artifacts that any code challenge implicitly requires.
const ALWAYS_VALID_DELIVERABLES = new Set([
    'source code',
    'code',
    'readme',
    'readme.md',
]);

/**
 * Validates each whatToSubmit item against the challenge description.
 * Removes items whose keywords are absent from the spec or appear only
 * outside a submission context (e.g. evaluation criteria, review rubrics).
 */
function validateWhatToSubmit(items: string[], descriptionText: string): string[] {
    if (!descriptionText) return items;

    const desc = descriptionText.toLowerCase();

    const validated = items.filter(item => {
        const normalized = item.toLowerCase().trim();

        // Canonical deliverables are always valid
        if (ALWAYS_VALID_DELIVERABLES.has(normalized)) return true;

        // Direct phrase match — the deliverable name appears verbatim
        if (desc.includes(normalized)) return true;

        // Extract significant words (skip stop words and short tokens)
        const words = normalized
            .split(/\s+/)
            .filter(w => !STOP_WORDS.has(w) && w.length > 2);

        if (words.length === 0) return true;

        // All significant words must appear somewhere in the description
        if (!words.every(w => desc.includes(w))) {
            tcAILogger.warn(
                `[challenge-context:validate] Removing "${item}" from whatToSubmit — keyword(s) missing from spec`,
            );
            return false;
        }

        // At least one word must appear near a submission-related verb/phrase
        const inSubmissionContext = words.some(word => {
            let searchFrom = 0;
            while (searchFrom < desc.length) {
                const idx = desc.indexOf(word, searchFrom);
                if (idx === -1) break;
                const windowStart = Math.max(0, idx - 200);
                const windowEnd = Math.min(desc.length, idx + word.length + 200);
                const window = desc.substring(windowStart, windowEnd);
                if (SUBMISSION_CONTEXT_TERMS.some(term => window.includes(term))) {
                    return true;
                }
                searchFrom = idx + 1;
            }
            return false;
        });

        if (!inSubmissionContext) {
            tcAILogger.warn(
                `[challenge-context:validate] Removing "${item}" from whatToSubmit — not in submission context`,
            );
            return false;
        }

        return true;
    });

    // Safety net: if everything was filtered out, keep the originals
    return validated.length > 0 ? validated : items;
}

// -- Post-extraction validation: tech_stack ---------------------------------

/**
 * Patterns that indicate a tech_stack item is platform infrastructure,
 * a review tool, or a generic category rather than a build technology.
 * Each entry is tested case-insensitively against the item.
 */
const TECH_STACK_EXCLUDE_PATTERNS: RegExp[] = [
    // Review / CI / quality-gate tooling
    /\bsast\b/i,
    /\bvulnerability\s*scanner/i,
    /\bcode\s*quality\s*gate/i,
    /\bstatic\s*analysis/i,
    /\breview\s*(bot|tool|workflow|system)/i,
    // Topcoder platform internals
    /\bcopilot\b/i,
    /\bscorecard\b/i,
    /\btopcoder\b/i,
    // Generic non-technology categories
    /^security$/i,
    /^testing$/i,
    /^ci\/cd$/i,
    /^documentation$/i,
];

/**
 * Strips tech_stack items that are platform review infrastructure,
 * Topcoder internal tooling, or generic non-technology categories.
 */
function validateTechStack(items: string[]): string[] {
    const validated = items.filter(item => {
        if (TECH_STACK_EXCLUDE_PATTERNS.some(pat => pat.test(item))) {
            tcAILogger.warn(
                `[challenge-context:validate] Removing "${item}" from tech_stack — platform/review infrastructure`,
            );
            return false;
        }
        return true;
    });
    return validated.length > 0 ? validated : items;
}

// -- Post-extraction validation: runtime_environment ------------------------

type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>;

/**
 * Heuristic signals in the challenge description that indicate the
 * submission is a CLI / command-line application, not a server.
 */
const CLI_INDICATORS: RegExp[] = [
    /\bcommand[\s-]*line\s*(app|application|tool|utility|program)\b/i,
    /\bcli\s*(app|application|tool|utility|program)?\b/i,
    /\bconsole\s*(app|application|tool|utility|program)\b/i,
    /\bscript\b.*\boutput\b/i,
];

/**
 * Patterns that indicate the deployment target was incorrectly set to a
 * submission/upload destination rather than where the code actually runs.
 */
const UPLOAD_NOT_DEPLOY_PATTERNS: RegExp[] = [
    /\btopcoder[\s_-]*(platform|upload|submission|page)\b/i,
    /\bsubmission[\s_-]*(platform|portal|page)\b/i,
];

/**
 * Applies heuristic corrections to the AI-extracted runtime environment
 * by cross-referencing against the challenge description text.
 */
function validateRuntimeEnvironment(
    env: RuntimeEnvironment,
    descriptionText: string,
): RuntimeEnvironment {
    if (!descriptionText) return env;
    const desc = descriptionText.toLowerCase();
    const corrected = { ...env };

    // If the description signals a CLI app, serverType should not be an API type
    const isCli = CLI_INDICATORS.some(pat => pat.test(descriptionText));
    if (isCli) {
        const serverLower = (corrected.serverType ?? '').toLowerCase();
        // Only override if the current value looks like a web server/API
        if (serverLower && !['none', 'cli', 'n/a', ''].includes(serverLower)) {
            tcAILogger.info(
                `[challenge-context:validate] Overriding serverType "${corrected.serverType}" → "CLI" (description indicates command-line app)`,
            );
            corrected.serverType = 'CLI';
        }
    }

    // deploymentTarget should not be a submission upload destination
    if (corrected.deploymentTarget) {
        if (UPLOAD_NOT_DEPLOY_PATTERNS.some(pat => pat.test(corrected.deploymentTarget!))) {
            const replacement = isCli ? 'local' : 'unknown';
            tcAILogger.info(
                `[challenge-context:validate] Overriding deploymentTarget "${corrected.deploymentTarget}" → "${replacement}" (was a submission destination, not a runtime target)`,
            );
            corrected.deploymentTarget = replacement;
        }
    }

    // os: if the description never mentions the OS value, reset to "unknown"
    if (corrected.os && corrected.os.toLowerCase() !== 'unknown' && corrected.os.toLowerCase() !== 'any') {
        // Split compound values like "Linux/macOS" and check each part
        const osParts = corrected.os.split(/[/,\s]+/).filter(Boolean);
        const anyMentioned = osParts.some(part => {
            const p = part.toLowerCase();
            // Check for the OS name in the description, but exclude matches
            // inside URLs (e.g. "linux-gnu" in a user-agent or URL path)
            const idx = desc.indexOf(p);
            if (idx === -1) return false;
            // Verify it's not embedded in a URL or path-like context
            const surroundStart = Math.max(0, idx - 30);
            const surroundEnd = Math.min(desc.length, idx + p.length + 30);
            const surround = desc.substring(surroundStart, surroundEnd);
            return !surround.includes('http') && !surround.includes('://');
        });
        if (!anyMentioned) {
            tcAILogger.info(
                `[challenge-context:validate] Overriding os "${corrected.os}" → "unknown" (not mentioned in spec)`,
            );
            corrected.os = 'unknown';
        }
    }

    return corrected;
}

// -- Orchestrator: parallel decomposed extraction + validation --------------

/**
 * Runs four focused AI extraction calls in parallel (requirements+grouping,
 * tech+runtime, codebase detection, submission guidelines), then validates
 * the whatToSubmit field against the source text to prune hallucinations.
 *
 * Note: Ollama processes requests sequentially by default.  Set
 * OLLAMA_NUM_PARALLEL > 1 to benefit from true parallel inference.
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
    const challengeText = buildChallengeText(data);

    tcAILogger.info('[challenge-context:extractWithAI] Starting decomposed extraction (4 focused calls)...');

    const [reqResult, techResult, codebaseResult, guidelinesResult] = await Promise.all([
        extractRequirementsAndGroups(agent, challengeText),
        extractTechAndRuntime(agent, challengeText),
        extractExistingCodebase(agent, challengeText),
        extractSubmissionGuidelines(agent, challengeText),
    ]);

    // -- Post-extraction validations ------------------------------------------
    const descriptionText = (data.description as string) ?? '';

    // Validate whatToSubmit
    const rawDeliverables = guidelinesResult.submission_guidelines.whatToSubmit;
    const validatedDeliverables = validateWhatToSubmit(rawDeliverables, descriptionText);
    if (validatedDeliverables.length !== rawDeliverables.length) {
        tcAILogger.info(
            `[challenge-context:extractWithAI] whatToSubmit pruned from ${rawDeliverables.length} to ${validatedDeliverables.length} items`,
        );
    }

    // Validate tech_stack
    const rawTechStack = techResult.tech_stack;
    const validatedTechStack = validateTechStack(rawTechStack);
    if (validatedTechStack.length !== rawTechStack.length) {
        tcAILogger.info(
            `[challenge-context:extractWithAI] tech_stack pruned from ${rawTechStack.length} to ${validatedTechStack.length} items`,
        );
    }

    // Validate runtime_environment
    const validatedRuntime = validateRuntimeEnvironment(
        techResult.runtime_environment,
        descriptionText,
    );

    tcAILogger.info('[challenge-context:extractWithAI] All extractions complete — assembling result');

    return {
        requirements: reqResult.requirements,
        requirement_groups: reqResult.requirement_groups,
        tech_stack: validatedTechStack,
        runtime_environment: validatedRuntime,
        existing_codebase: codebaseResult.existing_codebase,
        submission_guidelines: {
            ...guidelinesResult.submission_guidelines,
            whatToSubmit: validatedDeliverables,
        },
    };
}

// ---------------------------------------------------------------------------
// Testing Exports
// ---------------------------------------------------------------------------

export const _testing = {
    buildChallengeText,
    extractRequirementsAndGroups,
    extractTechAndRuntime,
    extractExistingCodebase,
    extractSubmissionGuidelines,
    validateWhatToSubmit,
    validateTechStack,
    validateRuntimeEnvironment,
};

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
    .then(persistChallengeContext)
    .commit();
