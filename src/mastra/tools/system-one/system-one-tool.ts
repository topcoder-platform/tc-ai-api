// Ollama System One (POST /v1/systemone) — typed decisions with probabilities.
// See docs/adr/0009-system-one-tool.md.
//
// Deliberately NOT registered on the Mastra instance and not attached to any
// agent: services reach it only through the tracked `system-one` workflow.
// Attaching it to an agent makes it HTTP-executable via findToolInAgents
// (ADR 0009 F1) — the "unreachable" test in system-one-workflow.test.ts fails
// on purpose so that change gets its own decision.
import { createTool } from '@mastra/core/tools';
import type { IMastraLogger } from '@mastra/core/logger';
import { z } from 'zod';
import { withAccessPolicy } from '../../../utils/auth/access-control';
import { tcAILogger } from '../../../utils/logger';
import { getSystemOneConfig } from '../../../config/system-one.config';
import {
    buildSystemOneInputSchema,
    getSystemOneProvider,
    resolveSystemOneRequest,
    systemOneResponseSchema,
    SystemOneError,
    type SystemOneModelInfo,
    type SystemOneRequest,
} from '../../../utils/providers/system-one';

const TOOL_ID = 'system-one';

export const SYSTEM_ONE_TOOL_DESCRIPTION =
    'Ask a small decision model to answer one or more classification, yes/no, or rubric-scoring ' +
    'questions about a single input, and get back probabilities rather than generated text. Use it to ' +
    'label, triage, filter, or grade content when the possible answers can be listed in advance. Do NOT ' +
    'use it to generate text, extract values, summarise, or answer open questions — it can only pick ' +
    'among the options you define. Put ALL the content being judged in `state` — every question sees ' +
    '`state` (and `images`) but never sees other questions or their answers, so do not write a question ' +
    'that depends on another\'s result. Batch every question about the same `state` into ONE call (up ' +
    'to 64). Write criteria as short, mutually exclusive, concrete descriptions; the model\'s accuracy ' +
    'depends on them. Results are probabilities: report the winning answer with its ' +
    'probability/confidence, and treat low confidence (< ~0.5) or near-tie probabilities as ' +
    '"uncertain" rather than as a firm answer.';

/**
 * The model list is read at load only to write the schema descriptions, so
 * the agent sees the real options. It must never throw here — module import
 * runs with an empty env in the Docker build.
 */
function modelInfoForDescriptions(): SystemOneModelInfo {
    try {
        const { defaultModel, allowedModels } = getSystemOneConfig();
        return { defaultModel, allowedModels };
    } catch {
        return { defaultModel: 'nimble', allowedModels: ['nimble'] };
    }
}

export const systemOneInputSchema = buildSystemOneInputSchema(modelInfoForDescriptions());

export const systemOneOutputSchema = systemOneResponseSchema.extend({
    provider: z.enum(['ollama']).describe('Which System One backend answered.'),
});
export type SystemOneOutput = z.infer<typeof systemOneOutputSchema>;

export interface ExecuteSystemOneOptions {
    abortSignal?: AbortSignal;
    logger?: IMastraLogger;
    /** Joins log lines to the workflow run that made the call. */
    runId?: string;
}

/**
 * Logs `{ provider, model, questionCount, hasImages, usage, latencyMs }` —
 * never `state`, `instructions` or images, which may be member content.
 */
export async function executeSystemOne(
    input: SystemOneRequest,
    { abortSignal, logger = tcAILogger, runId }: ExecuteSystemOneOptions = {},
): Promise<SystemOneOutput> {
    const startedAt = Date.now();
    const questionCount = Object.keys(input.questions ?? {}).length;
    const hasImages = !!input.images?.length;

    try {
        const provider = getSystemOneProvider();
        const request = resolveSystemOneRequest(input, getSystemOneConfig());
        const response = await provider.evaluate(request, { signal: abortSignal });

        logger.info('system-one: evaluated', {
            runId,
            provider: provider.name,
            model: request.model,
            questionCount,
            hasImages,
            usage: response.usage,
            latencyMs: Date.now() - startedAt,
        });
        return { provider: provider.name, ...response };
    } catch (error) {
        logger.warn('system-one: failed', {
            runId,
            model: input.model,
            questionCount,
            hasImages,
            status: error instanceof SystemOneError ? error.status : undefined,
            code: error instanceof SystemOneError ? error.code : undefined,
            latencyMs: Date.now() - startedAt,
        });
        throw error;
    }
}

export const systemOneTool = withAccessPolicy(
    createTool({
        id: TOOL_ID,
        description: SYSTEM_ONE_TOOL_DESCRIPTION,
        inputSchema: systemOneInputSchema,
        outputSchema: systemOneOutputSchema,
        execute: async (inputData, context) =>
            executeSystemOne(inputData, {
                abortSignal: context?.abortSignal,
                logger: context?.mastra?.getLogger?.(),
                runId: context?.workflow?.runId,
            }),
    }),
);
