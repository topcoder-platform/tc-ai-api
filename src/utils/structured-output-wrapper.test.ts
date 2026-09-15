import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

vi.mock('./logger', () => ({
    tcAILogger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
    },
}));

import {
    buildTruncatedJsonRepairs,
    generateWithStructuredOutputFallback,
    isTruncatedByLength,
    recoverObjectFromText,
} from './structured-output-wrapper';

// Mirrors the shape that actually truncates in production: an unbounded array of
// objects with several required fields, plus a sibling array.
const requirementSchema = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    priority: z.enum(['high', 'medium', 'low']),
    constraints: z.array(z.object({ id: z.string(), text: z.string() })),
});

const requirementsAndGroupsSchema = z.object({
    requirements: z.array(requirementSchema),
    requirement_groups: z.array(z.object({ id: z.string(), requirementIds: z.array(z.string()) })),
});

function requirement(id: string) {
    return {
        id,
        title: `Title ${id}`,
        description: `Description for ${id}`,
        priority: 'high' as const,
        constraints: [{ id: 'CONSTR_01', text: 'must compile' }],
    };
}

const completeDocument = {
    requirements: [requirement('REQ_01'), requirement('REQ_02')],
    requirement_groups: [{ id: 'GRP_01', requirementIds: ['REQ_01', 'REQ_02'] }],
};

/** Cuts serialized JSON at the given fraction of its length, as a length-capped response would. */
function truncateAt(value: unknown, fraction: number): string {
    const json = JSON.stringify(value, null, 2);
    return json.slice(0, Math.floor(json.length * fraction));
}

describe('isTruncatedByLength', () => {
    it('recognises a length-capped response', () => {
        expect(isTruncatedByLength({ finishReason: 'length' })).toBe(true);
    });

    it.each([{ finishReason: 'stop' }, { finishReason: undefined }, {}, null, undefined, 'length'])(
        'returns false for %s',
        (response) => {
            expect(isTruncatedByLength(response)).toBe(false);
        },
    );
});

describe('buildTruncatedJsonRepairs', () => {
    it('returns candidates that are all syntactically valid JSON', () => {
        const repairs = buildTruncatedJsonRepairs(truncateAt(completeDocument, 0.6));

        expect(repairs.length).toBeGreaterThan(0);
        for (const repair of repairs) {
            expect(() => JSON.parse(repair)).not.toThrow();
        }
    });

    it('does not cut inside a string containing JSON punctuation', () => {
        const tricky = '{"a": [{"text": "closes } and ] and , inside"}, {"text": "partial';
        const repairs = buildTruncatedJsonRepairs(tricky);

        expect(repairs.length).toBeGreaterThan(0);
        expect(JSON.parse(repairs[0])).toEqual({ a: [{ text: 'closes } and ] and , inside' }] });
    });

    it('handles escaped quotes and backslashes without losing string state', () => {
        const tricky = '{"a": [{"text": "escaped \\" quote and \\\\"}, {"text": "partial';
        const repairs = buildTruncatedJsonRepairs(tricky);

        expect(JSON.parse(repairs[0])).toEqual({ a: [{ text: 'escaped " quote and \\' }] });
    });

    it('returns nothing when the text has no JSON object at all', () => {
        expect(buildTruncatedJsonRepairs('I cannot answer that.')).toEqual([]);
    });

    it.each([
        ['after a primitive, with no cut point available', '{"a": 1', { a: 1 }],
        ['inside a string', '{"a": "x', { a: 'x' }],
        ['on a dangling escape inside a string', '{"a": "x\\', { a: 'x' }],
        ['after a nested value with no comma yet', '{"a": {"b": true', { a: { b: true } }],
        ['after a complete array element', '{"a": ["x"', { a: ['x'] }],
    ])('closes the open containers when truncation lands %s', (_label, text, expected) => {
        const repairs = buildTruncatedJsonRepairs(text);

        expect(repairs.length).toBeGreaterThan(0);
        expect(JSON.parse(repairs[repairs.length - 1])).toEqual(expected);
    });

    it('prefers provable cut points over the best-effort end-of-text close', () => {
        // `"desc": "part` may be a truncated sentence, so every cut that keeps
        // only provably-complete values must be tried before trusting it.
        const repairs = buildTruncatedJsonRepairs('{"a": [{"id": "A"}, {"id": "B", "desc": "part');

        expect(JSON.parse(repairs[0])).toEqual({ a: [{ id: 'A' }, { id: 'B' }] });
        expect(JSON.parse(repairs[repairs.length - 1])).toEqual({
            a: [{ id: 'A' }, { id: 'B', desc: 'part' }],
        });
    });

    it.each([
        ['a key with no value yet', '{"a": [{"id": "A"}, {"id": '],
        ['a separating comma', '{"a": [{"id": "A"}, '],
        ['an opening bracket', '{"a": [{"id": "A"}, ['],
    ])('omits the end-of-text candidate when the text ends at %s', (_label, text) => {
        // Nothing to salvage beyond what the cut points already cover.
        expect(buildTruncatedJsonRepairs(text)).toEqual(['{"a": [{"id": "A"}]}']);
    });

    it('does not fabricate an empty container for a document truncated before any data', () => {
        // Recovering `{"requirements": []}` here would turn a truncation into a
        // silent zero-requirement success.
        expect(buildTruncatedJsonRepairs('{"requirements": [')).toEqual([]);
        expect(
            recoverObjectFromText('{"requirements": [', z.object({ requirements: z.array(z.string()) })),
        ).toBeNull();
    });

    it('deduplicates the identical cuts a nested close and its trailing comma produce', () => {
        const repairs = buildTruncatedJsonRepairs('{"a": [{"id": "A"}, {"id": "B"}, {"id":');

        expect(new Set(repairs).size).toBe(repairs.length);
    });

    it('recovers a schema-valid object when truncation lands after a primitive', () => {
        // The whole document is one object whose last field is a primitive, so
        // there is no cut point at all — only the end-of-text close works.
        const schema = z.object({ total: z.number(), label: z.string() });

        expect(recoverObjectFromText('{"label": "x", "total": 7', schema)).toEqual({
            data: { label: 'x', total: 7 },
            repaired: true,
        });
    });

    it('respects the candidate limit', () => {
        expect(buildTruncatedJsonRepairs(truncateAt(completeDocument, 0.9), 2)).toHaveLength(2);
    });
});

describe('recoverObjectFromText', () => {
    it('parses complete output without repairing it', () => {
        const recovered = recoverObjectFromText(JSON.stringify(completeDocument), requirementsAndGroupsSchema);

        expect(recovered).toEqual({ data: completeDocument, repaired: false });
    });

    it('parses complete output wrapped in a markdown fence', () => {
        const text = `Here you go:\n\`\`\`json\n${JSON.stringify(completeDocument)}\n\`\`\``;

        expect(recoverObjectFromText(text, requirementsAndGroupsSchema)?.repaired).toBe(false);
    });

    it('drops a half-written trailing element to recover a schema-valid object', () => {
        // Truncated inside the second element of the only array in the schema.
        const schema = z.object({ requirements: z.array(requirementSchema) });
        const full = JSON.stringify({ requirements: [requirement('REQ_01'), requirement('REQ_02')] }, null, 2);
        const truncated = full.slice(0, full.indexOf('"title": "Title REQ_02"'));

        const recovered = recoverObjectFromText(truncated, schema);

        expect(recovered?.repaired).toBe(true);
        expect(recovered?.data).toEqual({ requirements: [requirement('REQ_01')] });
    });

    it('returns null when a required sibling field never made it into the output', () => {
        // Truncation inside `requirements` means `requirement_groups` is absent,
        // and no cut point can conjure it back.
        const truncated = truncateAt(completeDocument, 0.5);

        expect(recoverObjectFromText(truncated, requirementsAndGroupsSchema)).toBeNull();
    });

    it('returns null for text that holds no JSON', () => {
        expect(recoverObjectFromText('no json here', requirementsAndGroupsSchema)).toBeNull();
    });
});

describe('generateWithStructuredOutputFallback — truncation handling', () => {
    const schema = z.object({ requirements: z.array(requirementSchema) });
    const singleRequirement = { requirements: [requirement('REQ_01')] };

    function fakeAgent(generate: ReturnType<typeof vi.fn>) {
        return { model: { modelId: 'us.anthropic.claude-sonnet-5' }, generate };
    }

    it('stops after the first truncated attempt instead of retrying other strategies', async () => {
        const generate = vi.fn().mockResolvedValue({ finishReason: 'length', text: '{"requirements": [' });
        const agent = fakeAgent(generate);

        await expect(
            generateWithStructuredOutputFallback({ agent, prompt: 'p', schema, sectionName: 'sec' }),
        ).rejects.toThrow(/truncated by the output token limit/);

        expect(generate).toHaveBeenCalledTimes(1);
    });

    it('recovers a repaired object from truncated text rather than failing', async () => {
        const full = JSON.stringify({ requirements: [requirement('REQ_01'), requirement('REQ_02')] });
        const generate = vi.fn().mockResolvedValue({
            finishReason: 'length',
            text: full.slice(0, full.indexOf('"title":"Title REQ_02"')),
        });

        const { response, strategy } = await generateWithStructuredOutputFallback({
            agent: fakeAgent(generate),
            prompt: 'p',
            schema,
            sectionName: 'sec',
        });

        expect(strategy).toBe('native');
        expect(response.object).toEqual(singleRequirement);
    });

    it('still walks the strategy ladder when the failure is not truncation', async () => {
        const generate = vi
            .fn()
            .mockResolvedValueOnce({ finishReason: 'stop', text: 'not json' })
            .mockResolvedValueOnce({ finishReason: 'stop', object: singleRequirement });

        const { strategy } = await generateWithStructuredOutputFallback({
            agent: fakeAgent(generate),
            prompt: 'p',
            schema,
            sectionName: 'sec',
        });

        expect(strategy).toBe('jsonPromptInjection');
        expect(generate).toHaveBeenCalledTimes(2);
    });

    it('passes generateOptions to the final plain-text attempt', async () => {
        const generate = vi
            .fn()
            .mockResolvedValueOnce({ finishReason: 'stop', text: 'not json' })
            .mockResolvedValueOnce({ finishReason: 'stop', text: 'not json' })
            .mockResolvedValueOnce({ finishReason: 'stop', text: JSON.stringify(singleRequirement) });

        const generateOptions = { modelSettings: { maxOutputTokens: 32_000 } };
        const { response, strategy } = await generateWithStructuredOutputFallback({
            agent: fakeAgent(generate),
            prompt: 'p',
            schema,
            sectionName: 'sec',
            generateOptions,
        });

        expect(strategy).toBe('plain-text');
        expect(response.object).toEqual(singleRequirement);
        expect(generate).toHaveBeenLastCalledWith('p', generateOptions);
    });
});
