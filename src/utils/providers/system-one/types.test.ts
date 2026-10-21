import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SystemOneError } from './provider';
import {
    buildSystemOneInputSchema,
    formatSystemOneIssues,
    resolveSystemOneRequest,
    SYS1_LIMITS,
    systemOneRequestSchema,
    systemOneResponseSchema,
    type SystemOneRequest,
} from './types';

const config = { defaultModel: 'nimble', allowedModels: ['nimble', 'clef-flash'], keepAlive: undefined };

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        state: 'I was charged twice.',
        questions: { refund: { type: 'noul', instructions: 'Is a refund requested?' } },
        ...overrides,
    };
}

function options(n: number): Record<string, null> {
    return Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, null]));
}

function issues(input: unknown): string {
    const result = systemOneRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
    return formatSystemOneIssues((result as { error: z.ZodError }).error);
}

describe('system-one request schema — bounds', () => {
    it('accepts the three question types', () => {
        const result = systemOneRequestSchema.safeParse(
            request({
                state: { ticket: 'x' },
                questions: {
                    refund: { type: 'noul', instructions: 'Refund?', criteria: { true: 'Asks for money back' } },
                    urgency: { type: 'score', instructions: 'How urgent?', criteria: ['Low', 'High'] },
                    label: { type: 'choice', instructions: ['Which queue?'], criteria: { billing: 'Payments', other: null } },
                },
            }),
        );
        expect(result.success).toBe(true);
    });

    it.each([
        ['blank string', '   '],
        ['number', 42],
        ['null', null],
    ])('rejects a %s state', (_, state) => {
        expect(issues(request({ state }))).toMatch(/^state:/);
    });

    it('requires 1–64 questions', () => {
        expect(issues(request({ questions: {} }))).toMatch(/questions: must have 1–64 questions/);
        const many = Object.fromEntries(
            Array.from({ length: SYS1_LIMITS.maxQuestions + 1 }, (_, i) => [
                `q${i}`,
                { type: 'noul', instructions: 'Yes?' },
            ]),
        );
        expect(issues(request({ questions: many }))).toMatch(/must have 1–64 questions/);
    });

    it('rejects a blank question name', () => {
        expect(issues(request({ questions: { ' ': { type: 'noul', instructions: 'x' } } }))).toMatch(
            /^questions: keys must not be blank$/,
        );
        expect(
            issues(request({ questions: { l: { type: 'choice', instructions: 'x', criteria: { a: null, '': null } } } })),
        ).toMatch(/^questions\.l\.criteria: keys must not be blank$/);
    });

    it('requires 2–26 choice options, with a field path', () => {
        const q = (criteria: unknown) => ({ questions: { label: { type: 'choice', instructions: 'x', criteria } } });
        expect(issues(request(q(options(1))))).toMatch(/^questions\.label\.criteria: must have 2–26 options/);
        expect(issues(request(q(options(27))))).toMatch(/must have 2–26 options/);
        expect(systemOneRequestSchema.safeParse(request(q(options(26)))).success).toBe(true);
    });

    it('requires 2–26 score levels', () => {
        const q = (criteria: unknown) => ({ questions: { s: { type: 'score', instructions: 'x', criteria } } });
        expect(issues(request(q(['only'])))).toMatch(/^questions\.s\.criteria:/);
        expect(issues(request(q(Array.from({ length: 27 }, (_, i) => `L${i}`))))).toMatch(/criteria/);
    });

    it('rejects extra keys in noul criteria', () => {
        expect(
            issues(request({ questions: { n: { type: 'noul', instructions: 'x', criteria: { maybe: 'x' } } } })),
        ).toMatch(/questions\.n\.criteria/);
    });

    it('rejects an unknown question type', () => {
        expect(issues(request({ questions: { n: { type: 'rank', instructions: 'x' } } }))).toMatch(
            /questions\.n/,
        );
    });

    it('accepts raw base64 images and rejects data URLs and URLs', () => {
        expect(systemOneRequestSchema.safeParse(request({ images: ['aGVsbG8='] })).success).toBe(true);
        expect(issues(request({ images: ['data:image/png;base64,aGVsbG8='] }))).toMatch(/^images\.0:/);
        expect(issues(request({ images: ['https://example.com/a.png'] }))).toMatch(/^images\.0:/);
    });

    it('strips keep_alive instead of rejecting it', () => {
        const result = systemOneRequestSchema.parse(request({ keep_alive: -1 }));
        expect(result).not.toHaveProperty('keep_alive');
    });
});

describe('system-one request schema — descriptions', () => {
    it('lists the allowed models and the vision model in the descriptions', () => {
        const schema = buildSystemOneInputSchema({
            defaultModel: 'nimble',
            allowedModels: ['nimble', 'clef-flash'],
        });
        const json = z.toJSONSchema(schema) as {
            properties: Record<string, { description?: string }>;
        };
        expect(json.properties.model.description).toBe(
            'Optional. One of: nimble, clef-flash. Omit to use nimble. Use clef-flash when sending images.',
        );
        expect(json.properties.images.description).toContain('(clef-flash)');
    });

    it('says when no image-capable model is enabled', () => {
        const json = z.toJSONSchema(systemOneRequestSchema) as {
            properties: Record<string, { description?: string }>;
        };
        expect(json.properties.images.description).toContain('none is enabled on this server');
    });
});

describe('resolveSystemOneRequest', () => {
    const parse = (input: Record<string, unknown>): SystemOneRequest => systemOneRequestSchema.parse(input);

    it('applies the default model', () => {
        expect(resolveSystemOneRequest(parse(request()), config).model).toBe('nimble');
    });

    it('accepts an allowlisted model and rejects any other with the allowed list', () => {
        expect(resolveSystemOneRequest(parse(request({ model: 'clef-flash' })), config).model).toBe(
            'clef-flash',
        );
        try {
            resolveSystemOneRequest(parse(request({ model: 'llama3' })), config);
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(SystemOneError);
            expect(error).toMatchObject({ status: 400, code: 'SYS1_MODEL_NOT_ALLOWED' });
            expect((error as Error).message).toBe(
                '[SYS1_MODEL_NOT_ALLOWED] Model "llama3" is not allowed. Allowed models: nimble, clef-flash.',
            );
        }
    });

    it('takes keep_alive from config only', () => {
        const input = { ...parse(request()), keep_alive: -1 } as SystemOneRequest;
        expect(resolveSystemOneRequest(input, config)).not.toHaveProperty('keep_alive');
        expect(resolveSystemOneRequest(input, { ...config, keepAlive: '5m' }).keep_alive).toBe('5m');
    });

    it('drops an empty images array', () => {
        const input = { ...parse(request()), images: [] };
        expect(resolveSystemOneRequest(input, config)).not.toHaveProperty('images');
    });

    it('rejects a request over 64 KiB without images', () => {
        const input = parse(request({ state: 'x'.repeat(SYS1_LIMITS.maxBytesWithoutImages) }));
        expect(() => resolveSystemOneRequest(input, config)).toThrow(
            expect.objectContaining({ status: 413, code: 'SYS1_REQUEST_TOO_LARGE' }),
        );
    });

    it('allows up to 32 MiB once images are present', () => {
        const input = parse(
            request({ state: 'x'.repeat(SYS1_LIMITS.maxBytesWithoutImages), images: ['aGVsbG8='] }),
        );
        expect(resolveSystemOneRequest(input, config).images).toEqual(['aGVsbG8=']);
    });
});

describe('system-one response schema', () => {
    const response = {
        model: 'nimble',
        answers: {
            refund: { type: 'noul', noul: 0.99 },
            urgency: {
                type: 'score',
                score: 0.83,
                legend: { '0': 'Routine', '1': 'Soon' },
                probabilities: { '0': 0.17, '1': 0.83 },
                confidence: 0.3,
            },
            label: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9, other: 0.1 }, confidence: 0.5 },
        },
        usage: { input_tokens: 120, output_tokens: 9 },
    };

    it('passes the upstream response through verbatim, including additive fields', () => {
        const withExtras = {
            ...response,
            created_at: '2026-10-05T00:00:00Z',
            answers: { ...response.answers, refund: { type: 'noul', noul: 0.99, margin: 0.4 } },
        };
        expect(systemOneResponseSchema.parse(withExtras)).toEqual(withExtras);
    });

    it('rejects a response that breaks the contract', () => {
        expect(
            systemOneResponseSchema.safeParse({ ...response, answers: { refund: { type: 'noul', noul: true } } })
                .success,
        ).toBe(false);
        expect(systemOneResponseSchema.safeParse({ model: 'nimble', answers: {} }).success).toBe(false);
    });
});
