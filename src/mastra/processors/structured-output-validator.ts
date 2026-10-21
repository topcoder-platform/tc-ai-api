/**
 * StructuredOutputValidator — an output processor that verifies a model's JSON
 * answer and, when it is broken, asks the model to fix its OWN answer with
 * precise feedback (Mastra processor retry), instead of only switching
 * structured-output strategy. See docs/adr/0010-lets-talk-classification.md, L2.
 *
 * Generic: any agent can attach one with its own schema and semantic checks.
 *
 * Probed against @mastra/core 1.74 (ADR 0010, spike):
 *  - `processOutputStep` sees the JSON in `text` under both the `native` and
 *    the `jsonPromptInjection` strategies (Bedrock's forced `json` tool call is
 *    mapped back to a text part by the provider);
 *  - a retry composes with `structuredOutput.errorStrategy: 'warn'`, but NOT
 *    with 'strict': strict validation of the rejected first answer still throws
 *    after the retry produced a valid one. Agents using this processor must be
 *    called with errorStrategy 'warn' (see generateWithStructuredOutputFallback);
 *  - on retry the rejected answer is NOT replayed to the model — only the
 *    feedback is, as a user message — so the feedback must stand on its own.
 */
import type { ProcessOutputStepArgs, Processor } from '@mastra/core/processors';
import type { z } from 'zod';
import { extractJsonObject } from '../../utils/structured-output-wrapper';

/**
 * Request-context key under which a caller may place a
 * `StructuredOutputValidatorStats` object to read violation/retry counts back
 * after `agent.generate()` resolves.
 */
export const STRUCTURED_OUTPUT_VALIDATOR_STATS_KEY = 'structuredOutputValidator.stats';

export interface StructuredOutputValidatorStats {
    violations: number;
    retries: number;
    /** Issue lists of every rejected answer, in order. */
    issues: string[][];
}

export function createStructuredOutputValidatorStats(): StructuredOutputValidatorStats {
    return { violations: 0, retries: 0, issues: [] };
}

export interface StructuredOutputViolation {
    label: string;
    agentId?: string;
    retryCount: number;
    issues: string[];
    willRetry: boolean;
    requestContext?: ProcessOutputStepArgs['requestContext'];
}

export interface StructuredOutputValidatorOptions<Schema extends z.ZodTypeAny> {
    schema: Schema;
    /** Semantic checks beyond the schema; returns human-readable issues, empty when valid. */
    verify?: (data: z.infer<Schema>) => string[];
    /** Retry while `retryCount < maxRetries`; keep equal to the agent's `maxProcessorRetries`. */
    maxRetries: number;
    /** Identifies the processor in ids and logs. */
    label: string;
    onViolation?: (violation: StructuredOutputViolation) => void;
}

const MAX_REPORTED_ISSUES = 10;

function formatZodIssues(error: z.ZodError): string[] {
    return error.issues.map((issue) => {
        const path = issue.path.length ? issue.path.join('.') : '(root)';
        return `${path}: ${issue.message}`;
    });
}

export function buildRetryFeedback(issues: string[]): string {
    const listed = issues.slice(0, MAX_REPORTED_ISSUES);
    const more = issues.length > listed.length ? `; and ${issues.length - listed.length} more` : '';
    return (
        `Your previous answer was invalid: ${listed.join('; ')}${more}. ` +
        'Answer the original request again from scratch and return ONLY the corrected JSON object.'
    );
}

export class StructuredOutputValidator<Schema extends z.ZodTypeAny> implements Processor {
    readonly id: string;
    readonly name: string;

    constructor(private readonly options: StructuredOutputValidatorOptions<Schema>) {
        this.id = `structured-output-validator:${options.label}`;
        this.name = `Structured output validator (${options.label})`;
    }

    /** The issues with one model answer; empty when it is valid. Exposed for tests. */
    validate(text: string): string[] {
        const raw = extractJsonObject(text);
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
            return ['the response is not a valid JSON object'];
        }
        const parsed = this.options.schema.safeParse(raw);
        if (!parsed.success) return formatZodIssues(parsed.error);
        return this.options.verify?.(parsed.data) ?? [];
    }

    async processOutputStep(args: ProcessOutputStepArgs) {
        const { text, finishReason, toolCalls, retryCount, abort, messages, requestContext, agent } = args;

        // Nothing to judge: an empty step, a tool-call step, or a truncated
        // answer (retrying under the same token budget truncates again — the
        // structured-output wrapper's repair path handles that case).
        if (!text?.trim() || toolCalls?.length || finishReason === 'length') return messages;

        const issues = this.validate(text);
        if (issues.length === 0) return messages;

        const willRetry = retryCount < this.options.maxRetries;
        const stats = requestContext?.get(STRUCTURED_OUTPUT_VALIDATOR_STATS_KEY) as
            | StructuredOutputValidatorStats
            | undefined;
        if (stats) {
            stats.violations += 1;
            stats.issues.push(issues);
            if (willRetry) stats.retries += 1;
        }
        this.options.onViolation?.({
            label: this.options.label,
            agentId: agent?.id,
            retryCount,
            issues,
            willRetry,
            requestContext,
        });

        // Past the limit, let the answer through: the wrapper's strategy
        // fallback and the caller's own verification still get to act on it.
        if (!willRetry) return messages;
        return abort(buildRetryFeedback(issues), { retry: true, metadata: { issues } });
    }
}
