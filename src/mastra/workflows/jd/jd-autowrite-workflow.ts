import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { tcAILogger } from '../../../utils/logger';
import { generateWithStructuredOutputFallback } from '../../../utils/structured-output-wrapper';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

function normalizeListField(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value
            .map((item) => String(item).trim())
            .filter(Boolean);
    }

    if (typeof value !== 'string') {
        return value;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return [];
    }

    const byLine = trimmed
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
        .filter(Boolean);

    if (byLine.length > 1) {
        return byLine;
    }

    return trimmed
        .split(/\s*[;,]\s*/)
        .map((entry) => entry.trim())
        .filter(Boolean);
}

const normalizedStringArrayField = z.preprocess(
    normalizeListField,
    z.array(z.string().min(1)),
);

const rewrittenJdSchema = z.object({
    title: z.string().describe('Concise, descriptive job title'),
    overview: z.string().describe('2-4 sentence summary of the opportunity'),
    responsibilities: normalizedStringArrayField.describe('Action-oriented bullet list of tasks and deliverables'),
    requirements: normalizedStringArrayField.describe('Mandatory qualifications, skills, and experience'),
    niceToHaves: normalizedStringArrayField.describe('Preferred but non-mandatory qualifications'),
    skills: normalizedStringArrayField.describe('Key technical and soft skill keywords'),
    formattedDescription: z.string().describe('Full markdown-formatted job description ready to post'),
});

export type RewrittenJobDescription = z.infer<typeof rewrittenJdSchema>;

// ---------------------------------------------------------------------------
// Step 1 – Preprocess the raw job description
// ---------------------------------------------------------------------------

const preprocessJobDescription = createStep({
    id: 'preprocess-raw-jd',
    description: 'Normalize whitespace and truncate the raw job description',
    inputSchema: z.object({
        rawDescription: z.string().min(1).describe('Raw job description text from the talent manager'),
    }),
    outputSchema: z.object({
        rawDescription: z.string().min(1),
    }),
    execute: async ({ inputData }) => {
        const maxChars = Number(process.env.JD_AUTOWRITE_MAX_CHARS ?? 8000);
        const normalized = inputData.rawDescription.replace(/\s+/g, ' ').trim();
        const rawDescription = normalized.slice(0, Math.max(0, maxChars));

        tcAILogger.info(`[jd-autowrite:preprocess] Preprocessed JD — ${rawDescription.length} chars (max: ${maxChars})`);
        return { rawDescription };
    },
});

// ---------------------------------------------------------------------------
// Step 2 – Rewrite the job description using AI
// ---------------------------------------------------------------------------

const rewriteJobDescription = createStep({
    id: 'rewrite-job-description',
    description: 'Uses the JD rewriter agent to produce a structured, professional job description',
    inputSchema: z.object({
        rawDescription: z.string().min(1),
    }),
    outputSchema: rewrittenJdSchema,
    execute: async ({ inputData, mastra }) => {
        tcAILogger.info('[jd-autowrite:rewrite] Starting AI-powered JD rewrite...');

        const agent = mastra!.getAgentById('jd-rewriter-agent');

        const prompt = [
            'Rewrite the following raw job description into a well-structured, professional format.',
            'Follow the formatting standards in your instructions exactly.',
            'After extracting the structured fields (title, overview, responsibilities, requirements,',
            'niceToHaves, skills), also produce a "formattedDescription" field that is the complete',
            'Markdown-formatted job posting assembled from those sections, ready to copy-paste.',
            '',
            '---BEGIN RAW JOB DESCRIPTION---',
            inputData.rawDescription,
            '---END RAW JOB DESCRIPTION---',
        ].join('\n');

        const { response } = await generateWithStructuredOutputFallback({
            agent,
            prompt,
            schema: rewrittenJdSchema,
            sectionName: 'rewriteJobDescription',
        });

        if (!response.object) {
            tcAILogger.error('[jd-autowrite:rewrite] Agent returned no structured output');
            throw new Error('JD rewriter agent returned no structured output');
        }

        const result = response.object;

        tcAILogger.info(
            `[jd-autowrite:rewrite] JD rewrite complete — title: "${result.title}", ` +
            `${result.responsibilities.length} responsibilities, ` +
            `${result.requirements.length} requirements, ` +
            `${result.skills.length} skills`,
        );

        return result;
    },
});

// ---------------------------------------------------------------------------
// Workflow Definition
// ---------------------------------------------------------------------------

export const jdAutowriteWorkflow = createWorkflow({
    id: 'jd-autowrite',
    inputSchema: z.object({
        rawDescription: z.string().min(1).describe('Raw job description text to rewrite'),
    }),
    outputSchema: rewrittenJdSchema,
})
    .then(preprocessJobDescription)
    .then(rewriteJobDescription)
    .commit();
