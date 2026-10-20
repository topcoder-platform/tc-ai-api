import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    buildClassificationOutputSchema,
    buildModelOutputSchema,
    checkModelOutputSemantics,
    letsTalkSubmissionSchema,
    normalizeConfidences,
} from './lets-talk-schemas';

const CLASS_IDS = ['JUNK', 'COMMUNITY_GENERAL', 'COMMUNITY_SUPPORT', 'SALES_LEAD'];

const submission = {
    submissionId: '3f1c2a9e-6b7d-4e8f-9a01-2b3c4d5e6f70',
    submittedAt: '2026-10-20T06:15:57Z',
    memberId: '88774411',
    interestedIn: 'Hiring talent',
    firstName: 'Ana',
    lastName: 'García',
    workEmail: 'ana.garcia@acme.es',
    companyName: 'Acme S.L.',
    message: 'Buscamos un equipo de desarrolladores React para un proyecto de 6 meses.',
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

describe('letsTalkSubmissionSchema', () => {
    it('accepts a full submission', () => {
        expect(letsTalkSubmissionSchema.parse(submission)).toEqual(submission);
    });

    it('strips UTM parameters and other unknown keys', () => {
        const parsed = letsTalkSubmissionSchema.parse({
            ...submission,
            utm_source: 'google',
            utm_campaign: 'q4',
            honeypot: '',
        });
        expect(parsed).toEqual(submission);
        expect(parsed).not.toHaveProperty('utm_source');
    });

    it('accepts a missing memberId', () => {
        const { memberId: _memberId, ...anonymous } = submission;
        expect(letsTalkSubmissionSchema.safeParse(anonymous).success).toBe(true);
    });

    it('accepts a missing, empty or whitespace-only message — the only optional form field', () => {
        const { message: _message, ...noMessage } = submission;
        expect(letsTalkSubmissionSchema.safeParse(noMessage).success).toBe(true);
        expect(letsTalkSubmissionSchema.parse({ ...submission, message: '' }).message).toBe('');
        expect(letsTalkSubmissionSchema.parse({ ...submission, message: '  \n ' }).message).toBe('');
    });

    it.each([
        'submissionId',
        'submittedAt',
        'interestedIn',
        'firstName',
        'lastName',
        'workEmail',
        'companyName',
    ])('rejects a missing %s', (key) => {
        const { [key as keyof typeof submission]: _omitted, ...rest } = submission;
        const result = letsTalkSubmissionSchema.safeParse(rest);
        expect(result.success).toBe(false);
        expect(result.error?.issues[0].path).toEqual([key]);
    });

    it.each([
        ['a non-v4 UUID', '3f1c2a9e-6b7d-1e8f-9a01-2b3c4d5e6f70'],
        ['a malformed id', 'submission-42'],
    ])('rejects %s as submissionId', (_label, submissionId) => {
        expect(letsTalkSubmissionSchema.safeParse({ ...submission, submissionId }).success).toBe(false);
    });

    it('rejects a submittedAt with a non-UTC offset', () => {
        expect(
            letsTalkSubmissionSchema.safeParse({ ...submission, submittedAt: '2026-10-20T08:15:57+02:00' }).success,
        ).toBe(false);
        expect(
            letsTalkSubmissionSchema.safeParse({ ...submission, submittedAt: '2026-10-20T06:15:57.123Z' }).success,
        ).toBe(true);
    });

    it('rejects a malformed workEmail', () => {
        expect(letsTalkSubmissionSchema.safeParse({ ...submission, workEmail: 'ana at acme' }).success).toBe(false);
    });

    it.each([
        ['firstName', 101],
        ['lastName', 101],
        ['companyName', 201],
        ['interestedIn', 201],
        ['memberId', 65],
        ['message', 20_001],
    ])('rejects an over-long %s', (key, length) => {
        expect(letsTalkSubmissionSchema.safeParse({ ...submission, [key]: 'x'.repeat(length) }).success).toBe(false);
    });

    it('trims fields and rejects whitespace-only required values', () => {
        expect(letsTalkSubmissionSchema.parse({ ...submission, firstName: '  Ana  ' }).firstName).toBe('Ana');
        expect(letsTalkSubmissionSchema.safeParse({ ...submission, companyName: '   ' }).success).toBe(false);
    });
});

describe('letsTalkSubmissionSchema — real form traffic (tests/fixtures/lets-talk-samples.json)', () => {
    const { samples } = JSON.parse(
        readFileSync(resolve(__dirname, '../../../../tests/fixtures/lets-talk-samples.json'), 'utf-8'),
    ) as { samples: { id: string; submittedAt?: string; submission: Record<string, string> }[] };

    it('has samples, including empty-message ones', () => {
        expect(samples.length).toBeGreaterThan(100);
        expect(samples.some((s) => !s.submission.message)).toBe(true);
    });

    it.each(samples.map((s) => [s.id, s] as const))('accepts %s', (_id, sample) => {
        const result = letsTalkSubmissionSchema.safeParse({
            submissionId: randomUUID(),
            submittedAt: sample.submittedAt ?? '2026-10-20T00:00:00Z',
            ...sample.submission,
        });
        expect(result.error?.issues).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Model output — L1 coercions
// ---------------------------------------------------------------------------

describe('normalizeConfidences (L1)', () => {
    it('turns numeric strings into numbers', () => {
        expect(normalizeConfidences({ JUNK: '0.8', SALES_LEAD: '0.2' }, CLASS_IDS)).toEqual({ JUNK: 0.8, SALES_LEAD: 0.2 });
    });

    it('upper-snake-cases class keys and drops unknown ones', () => {
        expect(
            normalizeConfidences({ ' sales_lead ': 0.6, 'community general': 0.4, OTHER: 0.1 }, CLASS_IDS),
        ).toEqual({ SALES_LEAD: 0.6, COMMUNITY_GENERAL: 0.4 });
    });

    it('rescales percentages, including "%" strings and zeros', () => {
        expect(normalizeConfidences({ JUNK: 80, SALES_LEAD: '20%', COMMUNITY_GENERAL: 0 }, CLASS_IDS)).toEqual({
            JUNK: 0.8,
            SALES_LEAD: 0.2,
            COMMUNITY_GENERAL: 0,
        });
        expect(normalizeConfidences({ JUNK: 100, SALES_LEAD: 0 }, CLASS_IDS)).toEqual({ JUNK: 1, SALES_LEAD: 0 });
    });

    it('does not rescale a mix of fractions and percentages', () => {
        expect(normalizeConfidences({ JUNK: 0.8, SALES_LEAD: 20 }, CLASS_IDS)).toEqual({ JUNK: 0.8, SALES_LEAD: 20 });
    });

    it('does not rescale plain fractions', () => {
        expect(normalizeConfidences({ JUNK: 1, SALES_LEAD: 0 }, CLASS_IDS)).toEqual({ JUNK: 1, SALES_LEAD: 0 });
    });

    it('returns non-objects unchanged', () => {
        expect(normalizeConfidences('JUNK', CLASS_IDS)).toBe('JUNK');
        expect(normalizeConfidences([0.5], CLASS_IDS)).toEqual([0.5]);
    });
});

describe('buildModelOutputSchema', () => {
    const schema = buildModelOutputSchema(CLASS_IDS);

    it('applies the coercions and lower-cases the language', () => {
        expect(
            schema.parse({
                confidences: { junk: '5', community_general: '5', COMMUNITY_SUPPORT: 10, sales_lead: 80 },
                detectedLanguage: ' ES ',
                rationale: 'Asks for a React team.',
                extra: 'dropped',
            }),
        ).toEqual({
            confidences: { JUNK: 0.05, COMMUNITY_GENERAL: 0.05, COMMUNITY_SUPPORT: 0.1, SALES_LEAD: 0.8 },
            detectedLanguage: 'es',
            rationale: 'Asks for a React team.',
        });
    });

    it('requires every class', () => {
        const result = schema.safeParse({
            confidences: { JUNK: 0.5, SALES_LEAD: 0.5 },
            detectedLanguage: 'en',
            rationale: 'x',
        });
        expect(result.success).toBe(false);
        expect(result.error?.issues.map((i) => i.path.join('.'))).toEqual([
            'confidences.COMMUNITY_GENERAL',
            'confidences.COMMUNITY_SUPPORT',
        ]);
    });
});

describe('checkModelOutputSemantics', () => {
    const valid = {
        confidences: { JUNK: 0.1, COMMUNITY_GENERAL: 0.1, COMMUNITY_SUPPORT: 0.1, SALES_LEAD: 0.7 },
        detectedLanguage: 'es',
        rationale: 'Requests a development team.',
    };

    it('passes a valid output', () => {
        expect(checkModelOutputSemantics(valid, CLASS_IDS)).toEqual([]);
    });

    it('names each defect', () => {
        expect(
            checkModelOutputSemantics(
                {
                    confidences: { ...valid.confidences, SALES_LEAD: 0.5 },
                    detectedLanguage: 'spanish',
                    rationale: ' ',
                },
                CLASS_IDS,
            ),
        ).toEqual([
            'confidences must sum to 1 (got 0.8)',
            'detectedLanguage must be an ISO 639-1 code such as "en" (got "spanish")',
            'rationale must be a non-empty English sentence',
        ]);
    });

    it('tolerates rounding within ±0.02', () => {
        expect(
            checkModelOutputSemantics({ ...valid, confidences: { ...valid.confidences, SALES_LEAD: 0.71 } }, CLASS_IDS),
        ).toEqual([]);
    });
});

describe('buildClassificationOutputSchema', () => {
    it('only accepts a configured class and requires every confidence', () => {
        const schema = buildClassificationOutputSchema(CLASS_IDS);
        const output = {
            submissionId: submission.submissionId,
            classification: 'SALES_LEAD',
            confidence: 0.7,
            confidences: { JUNK: 0.1, COMMUNITY_GENERAL: 0.1, COMMUNITY_SUPPORT: 0.1, SALES_LEAD: 0.7 },
            needsReview: false,
            detectedLanguage: 'es',
            rationale: 'x',
        };
        expect(schema.safeParse(output).success).toBe(true);
        expect(schema.safeParse({ ...output, classification: 'OTHER' }).success).toBe(false);
        expect(schema.safeParse({ ...output, confidences: { JUNK: 1 } }).success).toBe(false);
    });
});
