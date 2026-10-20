import { describe, expect, it, vi } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import { TripWire } from '@mastra/core/agent';
import { z } from 'zod';
import {
    createStructuredOutputValidatorStats,
    STRUCTURED_OUTPUT_VALIDATOR_STATS_KEY,
    StructuredOutputValidator,
} from './structured-output-validator';
import { buildModelOutputSchema, checkModelOutputSemantics } from '../workflows/lets-talk/lets-talk-schemas';

const CLASS_IDS = ['JUNK', 'COMMUNITY_GENERAL', 'COMMUNITY_SUPPORT', 'SALES_LEAD'];
const VALID = {
    confidences: { JUNK: 0.05, COMMUNITY_GENERAL: 0.05, COMMUNITY_SUPPORT: 0.1, SALES_LEAD: 0.8 },
    detectedLanguage: 'en',
    rationale: 'Asks for a development team.',
};

function makeValidator(maxRetries = 2) {
    const onViolation = vi.fn();
    const validator = new StructuredOutputValidator({
        label: 'test',
        schema: buildModelOutputSchema(CLASS_IDS),
        verify: (output) => checkModelOutputSemantics(output, CLASS_IDS),
        maxRetries,
        onViolation,
    });
    return { validator, onViolation };
}

/** Mirrors Mastra's abort(): throws a TripWire. */
function abort(reason?: string, options?: { retry?: boolean; metadata?: unknown }): never {
    throw new TripWire(reason ?? '', options);
}

function step(text: string | undefined, overrides: Record<string, unknown> = {}) {
    const messages = [{ id: 'm1' }];
    return {
        args: {
            text,
            retryCount: 0,
            abort,
            messages,
            finishReason: 'stop',
            toolCalls: [],
            ...overrides,
        } as never,
        messages,
    };
}

async function tripwireOf(promise: Promise<unknown>): Promise<TripWire> {
    try {
        await promise;
    } catch (err) {
        if (err instanceof TripWire) return err;
        throw err;
    }
    throw new Error('expected a TripWire');
}

describe('StructuredOutputValidator', () => {
    it('passes a valid output through untouched', async () => {
        const { validator, onViolation } = makeValidator();
        const { args, messages } = step(JSON.stringify(VALID));
        await expect(validator.processOutputStep(args)).resolves.toBe(messages);
        expect(onViolation).not.toHaveBeenCalled();
    });

    it('accepts JSON wrapped in a fence or prose', async () => {
        const { validator } = makeValidator();
        const { args, messages } = step(`Here it is:\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``);
        await expect(validator.processOutputStep(args)).resolves.toBe(messages);
    });

    it.each([
        ['invalid JSON', '{"confidences": {', 'the response is not a valid JSON object'],
        [
            'a missing class',
            JSON.stringify({ ...VALID, confidences: { JUNK: 0.2, COMMUNITY_GENERAL: 0.2, SALES_LEAD: 0.6 } }),
            'confidences.COMMUNITY_SUPPORT',
        ],
        [
            'a sum that is off',
            JSON.stringify({ ...VALID, confidences: { ...VALID.confidences, SALES_LEAD: 0.5 } }),
            'confidences must sum to 1 (got 0.7)',
        ],
        ['an empty rationale', JSON.stringify({ ...VALID, rationale: '' }), 'rationale must be a non-empty English sentence'],
    ])('requests a retry naming the issue for %s', async (_label, text, issue) => {
        const { validator, onViolation } = makeValidator();
        const tripwire = await tripwireOf(validator.processOutputStep(step(text).args));

        expect(tripwire.options.retry).toBe(true);
        expect(tripwire.message).toMatch(/^Your previous answer was invalid: /);
        expect(tripwire.message).toContain(issue);
        expect(tripwire.message).toMatch(/return ONLY the corrected JSON object\.$/);
        expect(onViolation).toHaveBeenCalledWith(expect.objectContaining({ label: 'test', retryCount: 0, willRetry: true }));
    });

    it('stops requesting retries once retryCount reaches maxRetries', async () => {
        const { validator, onViolation } = makeValidator(2);
        const { args, messages } = step('not json', { retryCount: 2 });
        await expect(validator.processOutputStep(args)).resolves.toBe(messages);
        expect(onViolation).toHaveBeenCalledWith(expect.objectContaining({ retryCount: 2, willRetry: false }));
    });

    it('never retries with maxRetries 0', async () => {
        const { validator } = makeValidator(0);
        const { args, messages } = step('not json');
        await expect(validator.processOutputStep(args)).resolves.toBe(messages);
    });

    it.each([
        ['empty text', step('')],
        ['undefined text', step(undefined)],
        ['a tool-call step', step('not json', { toolCalls: [{ toolName: 't', toolCallId: '1', args: {} }] })],
        ['a truncated answer', step('{"confidences": {', { finishReason: 'length' })],
    ])('does nothing for %s', async (_label, { args, messages }) => {
        const { validator, onViolation } = makeValidator();
        await expect(validator.processOutputStep(args)).resolves.toBe(messages);
        expect(onViolation).not.toHaveBeenCalled();
    });

    it('records violations and retries on the request-context stats object', async () => {
        const { validator } = makeValidator(1);
        const stats = createStructuredOutputValidatorStats();
        const requestContext = new RequestContext();
        requestContext.set(STRUCTURED_OUTPUT_VALIDATOR_STATS_KEY, stats);

        await tripwireOf(validator.processOutputStep(step('nope', { requestContext }).args));
        await validator.processOutputStep(step('nope', { requestContext, retryCount: 1 }).args);

        expect(stats).toEqual({
            violations: 2,
            retries: 1,
            issues: [['the response is not a valid JSON object'], ['the response is not a valid JSON object']],
        });
    });

    it('works with any schema and no verify callback', async () => {
        const validator = new StructuredOutputValidator({ label: 'generic', schema: z.object({ a: z.number() }), maxRetries: 1 });
        expect(validator.validate('{"a": 1}')).toEqual([]);
        expect(validator.validate('{"a": "x"}')).toEqual(['a: Invalid input: expected number, received string']);
        expect(validator.validate('[1]')).toEqual(['the response is not a valid JSON object']);
        expect(validator.id).toBe('structured-output-validator:generic');
    });
});
