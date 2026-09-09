import { z } from 'zod';
import { tcAILogger } from './logger';

export type StructuredOutputStrategy =
    | 'native'
    | 'jsonPromptInjection'
    | 'separate-structuring-model'
    | 'prepareStep'
    | 'plain-text';

export type CallTokenUsageSource = 'native' | 'mixed' | 'estimated' | 'none';

export interface TokenUsageMetrics {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    source: CallTokenUsageSource;
}

interface UsageTriplet {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
}

interface GenerateWithStructuredOutputFallbackParams<Schema extends z.ZodTypeAny> {
    agent: any;
    prompt: string;
    schema: Schema;
    sectionName: string;
    structuringModel?: string;
    generateOptions?: Record<string, unknown>;
}

interface GenerateWithStructuredOutputFallbackResult {
    response: any;
    strategy: StructuredOutputStrategy;
}

export function toNonNegativeInt(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.trunc(value));
    }
    if (typeof value === 'string') {
        const parsed = Number(value.trim());
        return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
    }
    return null;
}

export function estimateTokenCount(text: string): number {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
}

function usageFromRecord(usage: Record<string, unknown> | undefined): UsageTriplet {
    return {
        inputTokens: usage
            ? toNonNegativeInt(
                usage.inputTokens
                ?? usage.promptTokens
                ?? usage.input_tokens
                ?? usage.prompt_tokens,
            )
            : null,
        outputTokens: usage
            ? toNonNegativeInt(
                usage.outputTokens
                ?? usage.completionTokens
                ?? usage.output_tokens
                ?? usage.completion_tokens,
            )
            : null,
        totalTokens: usage
            ? toNonNegativeInt(
                usage.totalTokens
                ?? usage.total_tokens,
            )
            : null,
    };
}

function mergeUsageTriplets(usages: UsageTriplet[]): UsageTriplet {
    const merged: UsageTriplet = {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
    };

    for (const usage of usages) {
        if (usage.inputTokens != null) {
            merged.inputTokens = (merged.inputTokens ?? 0) + usage.inputTokens;
        }
        if (usage.outputTokens != null) {
            merged.outputTokens = (merged.outputTokens ?? 0) + usage.outputTokens;
        }
        if (usage.totalTokens != null) {
            merged.totalTokens = (merged.totalTokens ?? 0) + usage.totalTokens;
        }
    }

    return merged;
}

function extractStepUsage(response: unknown): UsageTriplet {
    const steps =
        response && typeof response === 'object' && 'steps' in response && Array.isArray((response as { steps?: unknown[] }).steps)
            ? (response as { steps: unknown[] }).steps
            : [];

    if (steps.length === 0) {
        return {
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
        };
    }

    const usageEntries: UsageTriplet[] = [];

    for (const step of steps) {
        if (!step || typeof step !== 'object') continue;
        const stepRecord = step as Record<string, unknown>;

        if (stepRecord.usage && typeof stepRecord.usage === 'object') {
            usageEntries.push(usageFromRecord(stepRecord.usage as Record<string, unknown>));
        }

        const responseRecord = stepRecord.response;
        if (responseRecord && typeof responseRecord === 'object') {
            const nested = responseRecord as Record<string, unknown>;
            if (nested.usage && typeof nested.usage === 'object') {
                usageEntries.push(usageFromRecord(nested.usage as Record<string, unknown>));
            }
        }
    }

    if (usageEntries.length === 0) {
        return {
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
        };
    }

    return mergeUsageTriplets(usageEntries);
}

function chooseRichestUsage(primary: UsageTriplet, steps: UsageTriplet): UsageTriplet {
    const inputTokens =
        steps.inputTokens != null
            ? Math.max(steps.inputTokens, primary.inputTokens ?? 0)
            : primary.inputTokens;
    const outputTokens =
        steps.outputTokens != null
            ? Math.max(steps.outputTokens, primary.outputTokens ?? 0)
            : primary.outputTokens;
    const totalTokens =
        steps.totalTokens != null
            ? Math.max(steps.totalTokens, primary.totalTokens ?? 0)
            : primary.totalTokens;

    return {
        inputTokens,
        outputTokens,
        totalTokens,
    };
}

export function buildTokenUsageMetrics(
    response: unknown,
    promptText: string,
    outputText: string,
): TokenUsageMetrics {
    const responseUsage =
        response && typeof response === 'object' && 'usage' in response
            ? usageFromRecord((response as { usage?: Record<string, unknown> }).usage)
            : { inputTokens: null, outputTokens: null, totalTokens: null };

    const stepUsage = extractStepUsage(response);
    const combinedUsage = chooseRichestUsage(responseUsage, stepUsage);

    const nativeInput = combinedUsage.inputTokens;
    const nativeOutput = combinedUsage.outputTokens;
    const nativeTotal = combinedUsage.totalTokens;

    if (nativeInput == null && nativeOutput == null && nativeTotal == null) {
        const estimatedInput = estimateTokenCount(promptText);
        const estimatedOutput = estimateTokenCount(outputText);
        return {
            inputTokens: estimatedInput,
            outputTokens: estimatedOutput,
            totalTokens: estimatedInput + estimatedOutput,
            source: 'estimated',
        };
    }

    const inputTokens = nativeInput
        ?? (nativeTotal != null && nativeOutput != null ? Math.max(0, nativeTotal - nativeOutput) : estimateTokenCount(promptText));
    const outputTokens = nativeOutput
        ?? (nativeTotal != null && nativeInput != null ? Math.max(0, nativeTotal - nativeInput) : estimateTokenCount(outputText));
    const totalTokens = nativeTotal ?? Math.max(0, inputTokens + outputTokens);

    const source: CallTokenUsageSource =
        nativeInput != null && nativeOutput != null && nativeTotal != null
            ? 'native'
            : 'mixed';

    return {
        inputTokens,
        outputTokens,
        totalTokens,
        source,
    };
}

function isLikelyMojoOrGemini(agent: any): boolean {
    const modelId = String(
        agent?.model?.modelId
        ?? agent?.model?.model
        ?? agent?.model?.id
        ?? '',
    ).toLowerCase();

    return modelId.includes('gemini') || modelId.includes('mojo');
}

/**
 * Best-effort extraction of a JSON object from free-form model text: tries a
 * direct parse first, then a fenced ```json ... ``` block, then the widest
 * `{ ... }` span in the text (handles leading/trailing commentary).
 */
function extractJsonObject(text: string): unknown | null {
    const candidates: string[] = [text];

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) candidates.push(fenced[1]);

    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        candidates.push(text.slice(firstBrace, lastBrace + 1));
    }

    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate.trim());
        } catch {
            // try next candidate
        }
    }
    return null;
}

export function isStructuredOutputCompatibilityError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();

    // Schema-shape failures are content issues, not provider compatibility issues.
    if (message.includes('validation failed') || message.includes('invalid input: expected')) {
        return false;
    }

    return (
        message.includes('response_format')
        || message.includes('structured output')
        || message.includes('response mime type')
        || message.includes('application/json')
        || message.includes('function calling')
        || message.includes('unsupported')
        || message.includes('json schema')
    );
}

/**
 * True when the model DID attempt structured output but the result failed
 * schema validation (e.g. a truncated array item missing required fields, or
 * a genuine type mismatch). Unlike a compatibility error this says nothing
 * about whether the provider supports structured output — but a different
 * strategy (different prompt shaping, a second unconstrained pass, or the
 * final plain-text JSON-recovery fallback) can still produce a valid object,
 * so it should be retried rather than immediately thrown.
 */
export function isStructuredOutputValidationError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();

    return (
        message.includes('validation failed')
        || message.includes('invalid input: expected')
        || error.name === 'ZodError'
    );
}

export async function generateWithStructuredOutputFallback<Schema extends z.ZodTypeAny>({
    agent,
    prompt,
    schema,
    sectionName,
    structuringModel,
    generateOptions,
}: GenerateWithStructuredOutputFallbackParams<Schema>): Promise<GenerateWithStructuredOutputFallbackResult> {
    const strictStructuredOutputBase = {
        schema,
        errorStrategy: 'strict' as const,
    };

    const attempts: {
        strategy: StructuredOutputStrategy;
        options?: Record<string, unknown>;
    }[] = [];

    const attemptedStrategies = new Set<StructuredOutputStrategy>();
    const pushAttempt = (
        strategy: StructuredOutputStrategy,
        options?: Record<string, unknown>,
    ): void => {
        if (attemptedStrategies.has(strategy)) return;
        attemptedStrategies.add(strategy);
        attempts.push({ strategy, options });
    };

    const preferPromptInjection = isLikelyMojoOrGemini(agent);

    if (preferPromptInjection) {
        pushAttempt('jsonPromptInjection', {
            structuredOutput: {
                ...strictStructuredOutputBase,
                jsonPromptInjection: true,
            },
        });
    }

    pushAttempt('native', {
        structuredOutput: strictStructuredOutputBase,
    });

    pushAttempt('jsonPromptInjection', {
        structuredOutput: {
            ...strictStructuredOutputBase,
            jsonPromptInjection: true,
        },
    });

    if (structuringModel) {
        pushAttempt('separate-structuring-model', {
            structuredOutput: {
                ...strictStructuredOutputBase,
                jsonPromptInjection: true,
                model: structuringModel,
            },
        });
    }

    pushAttempt('prepareStep', {
        maxSteps: 2,
        prepareStep: async ({ stepNumber }: { stepNumber: number }) => {
            if (stepNumber === 0) {
                return {
                    structuredOutput: undefined,
                };
            }

            return {
                tools: undefined,
                toolChoice: 'none',
                structuredOutput: {
                    ...strictStructuredOutputBase,
                    jsonPromptInjection: true,
                    ...(structuringModel ? { model: structuringModel } : {}),
                },
            };
        },
    });

    let lastAttemptError: unknown = null;

    for (const attempt of attempts) {
        try {
            tcAILogger.info(
                `[json-wrapper:structured-output] Section "${sectionName}" attempt: ${attempt.strategy}`,
            );

            const response = attempt.options
                ? await agent.generate(prompt, { ...(generateOptions ?? {}), ...attempt.options })
                : generateOptions
                    ? await agent.generate(prompt, generateOptions)
                    : await agent.generate(prompt);

            if (!response?.object) {
                // The call resolved (no thrown error) but produced no structured
                // object — e.g. the model's structured-output run was aborted by
                // mastra's "strict" errorStrategy (schema-validation failure) or
                // truncated (finishReason "length"). Treat this the same as a
                // thrown compatibility error and try the next strategy instead
                // of silently returning an empty result.
                tcAILogger.warn(
                    `[json-wrapper:structured-output] Section "${sectionName}" attempt ` +
                    `"${attempt.strategy}" resolved without a structured object ` +
                    `(finishReason: ${response?.finishReason ?? 'unknown'}); trying next strategy`,
                );
                continue;
            }

            return {
                response,
                strategy: attempt.strategy,
            };
        } catch (err: unknown) {
            const isCompatibilityError = isStructuredOutputCompatibilityError(err);
            const isValidationError = isStructuredOutputValidationError(err);
            if (!isCompatibilityError && !isValidationError) {
                throw err;
            }

            lastAttemptError = err;
            tcAILogger.warn(
                `[json-wrapper:structured-output] Section "${sectionName}" attempt ` +
                `"${attempt.strategy}" failed ${isValidationError ? 'schema validation' : 'compatibility checks'}: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    tcAILogger.warn(
        `[json-wrapper:structured-output] Section "${sectionName}" exhausted structured output strategies; ` +
        'falling back to plain-text generation for JSON recovery',
    );

    if (lastAttemptError instanceof Error) {
        tcAILogger.warn(
            `[json-wrapper:structured-output] Section "${sectionName}" last attempt error: ` +
            lastAttemptError.message,
        );
    }

    const response = await agent.generate(prompt);

    if (!response?.object && typeof response?.text === 'string') {
        const rawJson = extractJsonObject(response.text);
        const parsed = rawJson !== null ? schema.safeParse(rawJson) : null;
        if (parsed?.success) {
            tcAILogger.info(
                `[json-wrapper:structured-output] Section "${sectionName}" recovered a valid object ` +
                'from plain-text output',
            );
            response.object = parsed.data;
        } else {
            tcAILogger.error(
                `[json-wrapper:structured-output] Section "${sectionName}" plain-text JSON recovery failed ` +
                `(finishReason: ${response?.finishReason ?? 'unknown'}); ` +
                `raw text (truncated): ${response.text.slice(0, 500)}`,
            );
        }
    }

    return {
        response,
        strategy: 'plain-text',
    };
}
