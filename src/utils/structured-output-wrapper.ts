import { z } from 'zod';
import { tcAILogger } from './logger';

export type StructuredOutputStrategy =
    | 'native'
    | 'jsonPromptInjection'
    | 'separate-structuring-model'
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
export function extractJsonObject(text: string): unknown | null {
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

/**
 * A point in a truncated JSON document where the document can be cut and then
 * closed to yield syntactically valid JSON: `index` is the cut offset (exclusive)
 * and `closers` the still-open brackets/braces, outermost first.
 */
interface JsonCutPoint {
    index: number;
    closers: string[];
}

/**
 * Scans a (possibly truncated) JSON document and records every offset at which
 * a value has just been completed: immediately before a separating comma, and
 * immediately after a nested `}` / `]`. Cutting at such an offset and appending
 * the outstanding closers always produces valid JSON, because neither token can
 * appear in the middle of a value.
 */
function collectJsonCutPoints(json: string): JsonCutPoint[] {
    const cutPoints: JsonCutPoint[] = [];
    const stack: string[] = [];
    let inString = false;
    let escaped = false;

    for (let i = 0; i < json.length; i++) {
        const char = json[i];

        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }

        if (char === '"') {
            inString = true;
        } else if (char === '{' || char === '[') {
            stack.push(char === '{' ? '}' : ']');
        } else if (char === '}' || char === ']') {
            stack.pop();
            // Only a nested close completes a value *within* a container; the
            // outermost close ends the document and needs no repair.
            if (stack.length > 0) cutPoints.push({ index: i + 1, closers: [...stack] });
        } else if (char === ',' && stack.length > 0) {
            cutPoints.push({ index: i, closers: [...stack] });
        }
    }

    return cutPoints;
}

// Bounds the backward walk over cut points. Truncation almost always lands
// inside the last element or two, so the valid cut is near the end; scanning the
// whole document would be quadratic in its length for no practical gain.
const MAX_REPAIR_ATTEMPTS = 200;

/**
 * Repair candidates for a truncated JSON document, longest (most data retained)
 * first. Each candidate drops whatever trailing fragment was cut off mid-write
 * and closes the containers that were still open.
 */
export function buildTruncatedJsonRepairs(text: string, limit = MAX_REPAIR_ATTEMPTS): string[] {
    const start = text.indexOf('{');
    if (start === -1) return [];

    const body = text.slice(start);
    const cutPoints = collectJsonCutPoints(body);
    const repairs: string[] = [];

    for (let i = cutPoints.length - 1; i >= 0 && repairs.length < limit; i--) {
        const { index, closers } = cutPoints[i];
        repairs.push(body.slice(0, index) + closers.reverse().join(''));
    }

    return repairs;
}

/**
 * Recovers a schema-valid object from free-form model text.
 *
 * First tries an exact parse. If that fails — or parses but does not satisfy the
 * schema, as happens when the response was cut off mid-JSON — walks the repair
 * candidates from longest to shortest and returns the first that validates. The
 * schema check is what makes the walk terminate on the right candidate: a cut
 * that leaves a half-written array element behind fails validation, so the walk
 * continues until that element is dropped entirely.
 */
export function recoverObjectFromText<Schema extends z.ZodTypeAny>(
    text: string,
    schema: Schema,
): { data: z.infer<Schema>; repaired: boolean } | null {
    const exact = extractJsonObject(text);
    if (exact !== null) {
        const parsed = schema.safeParse(exact);
        if (parsed.success) return { data: parsed.data, repaired: false };
    }

    for (const repair of buildTruncatedJsonRepairs(text)) {
        let candidate: unknown;
        try {
            candidate = JSON.parse(repair);
        } catch {
            continue;
        }
        const parsed = schema.safeParse(candidate);
        if (parsed.success) return { data: parsed.data, repaired: true };
    }

    return null;
}

/**
 * True when the provider stopped generating because the output token budget ran
 * out. The response then holds a JSON prefix rather than a JSON document, so no
 * other structured-output strategy can help — only a larger `maxOutputTokens`
 * (see each agent's `modelSettings`) or less output per call.
 */
export function isTruncatedByLength(response: unknown): boolean {
    return (
        !!response
        && typeof response === 'object'
        && (response as { finishReason?: unknown }).finishReason === 'length'
    );
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

    // NOTE: a 'prepareStep'-based two-step attempt (free-form step 0, then a
    // structured-output-only step 1) used to live here. It was removed because
    // step 0's assistant turn can end with a bare `thinking` block (extended
    // reasoning cut off before any text/tool_use, e.g. on Claude models with
    // thinking enabled) and Bedrock/Anthropic then rejects step 1 with
    // "messages.N: The final block in an assistant message cannot be
    // `thinking`" when that turn is replayed as history. Every remaining
    // strategy here is single-turn, so none can hit that replay failure.

    let lastAttemptError: unknown = null;
    let truncatedAttempt: { response: any; strategy: StructuredOutputStrategy } | null = null;

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
                    `(finishReason: ${response?.finishReason ?? 'unknown'})`,
                );

                if (isTruncatedByLength(response)) {
                    // Out of output tokens, not out of compatible strategies:
                    // every remaining attempt sends the same prompt to the same
                    // model under the same budget and would truncate at the same
                    // point, so stop burning calls and go straight to recovery.
                    tcAILogger.error(
                        `[json-wrapper:structured-output] Section "${sectionName}" output was TRUNCATED ` +
                        '(finishReason "length") — skipping remaining strategies and attempting JSON repair',
                    );
                    truncatedAttempt = { response, strategy: attempt.strategy };
                    break;
                }

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

    if (truncatedAttempt) {
        return recoverOrThrow(truncatedAttempt.response, truncatedAttempt.strategy, schema, sectionName);
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

    // Carry `generateOptions` through — it holds the caller's call settings
    // (token budget, temperature, …), which the last attempt needs just as much
    // as the structured ones did.
    const response = generateOptions
        ? await agent.generate(prompt, generateOptions)
        : await agent.generate(prompt);

    return recoverOrThrow(response, 'plain-text', schema, sectionName);
}

/**
 * Final step of every path that reaches the wrapper without a structured
 * object: recover one from the raw text if possible, and otherwise fail loudly —
 * with the truncation case named explicitly, since a bare "no structured output"
 * reads like a model formatting problem when it is really a token budget one.
 */
function recoverOrThrow<Schema extends z.ZodTypeAny>(
    response: any,
    strategy: StructuredOutputStrategy,
    schema: Schema,
    sectionName: string,
): GenerateWithStructuredOutputFallbackResult {
    if (!response?.object && typeof response?.text === 'string') {
        const recovered = recoverObjectFromText(response.text, schema);
        if (recovered) {
            tcAILogger.info(
                `[json-wrapper:structured-output] Section "${sectionName}" recovered a valid object ` +
                `from ${recovered.repaired ? 'TRUNCATED (repaired, trailing data dropped)' : 'plain-text'} output`,
            );
            response.object = recovered.data;
        } else {
            tcAILogger.error(
                `[json-wrapper:structured-output] Section "${sectionName}" JSON recovery failed ` +
                `(strategy: ${strategy}, finishReason: ${response?.finishReason ?? 'unknown'}, ` +
                `text length: ${response.text.length}); ` +
                `raw text (truncated): ${response.text.slice(0, 500)}`,
            );
        }
    }

    if (!response?.object && isTruncatedByLength(response)) {
        throw new Error(
            `Section "${sectionName}": model output was truncated by the output token limit ` +
            '(finishReason "length") and could not be repaired into a schema-valid object. ' +
            "Raise the agent's defaultOptions.modelSettings.maxOutputTokens or split the extraction into smaller calls.",
        );
    }

    return {
        response,
        strategy,
    };
}
