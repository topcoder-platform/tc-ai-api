/**
 * Schemas of the lets-talk-classification workflow and its agent.
 * See docs/adr/0010-lets-talk-classification.md.
 *
 * Three shapes:
 *  - the INPUT — the Let's talk form fields (unknown keys / UTMs are stripped);
 *  - the MODEL OUTPUT — only what the model decides (confidences, language,
 *    rationale), with tolerant L1 coercions;
 *  - the WORKFLOW OUTPUT — the model output plus what code derives from it
 *    (classification, confidence, needsReview, submissionId).
 *
 * Output schemas depend on the configured class set, so they are built by
 * functions; the module-level instances use the active config.
 */
import { z } from 'zod';
import { getLetsTalkClassificationConfig } from '../../../config/lets-talk-classification.config';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const letsTalkSubmissionSchema = z.object({
    submissionId: z
        .uuid({ version: 'v4' })
        .describe('Caller-assigned UUID v4 of the form submission. Echoed back in the output for correlation; never sent to the model.'),
    submittedAt: z
        .iso.datetime()
        .describe('ISO-8601 UTC timestamp of the submission (must end in "Z"). Informational only; not sent to the model.'),
    memberId: z
        .string().trim().min(1).max(64).optional()
        .describe('Topcoder member id when the submitter was logged in. Its presence is a strong signal for a COMMUNITY_* class. The model only receives isTopcoderMember: true/false, never the id.'),
    interestedIn: z
        .string().trim().min(1).max(200)
        .describe('Value of the "What are you interested in?" selector. A hint only — the free-text message wins on conflict.'),
    firstName: z
        .string().trim().min(1).max(100)
        .describe('Submitter first name as typed. Gibberish or keyboard-mash names are a JUNK signal.'),
    lastName: z
        .string().trim().min(1).max(100)
        .describe('Submitter last name as typed. Gibberish or keyboard-mash names are a JUNK signal.'),
    workEmail: z
        .email().max(254)
        .describe('Submitter work email. Only the domain reaches the model, with code-computed free-mail / disposable / Wipro flags. A corporate domain is a weak SALES_LEAD signal; a disposable domain is a JUNK signal; a Wipro domain is a strong WIPRO_QUERIES signal.'),
    companyName: z
        .string().trim().min(1).max(200)
        .describe('Company or organization name. A real company combined with a buying intent signals SALES_LEAD.'),
    message: z
        .string().trim().max(20_000).optional()
        .describe('Free-text answer to "What can we help you with" — the only optional form field, empty in about half of real submissions. The primary classification signal when present; any language. Truncated to LETS_TALK_MAX_MESSAGE_CHARS (default 5000) before the model call. Missing or empty ⇒ classified from the other fields and always needsReview: true.'),
}).describe("A \"Let's talk\" form submission. Unknown keys (e.g. UTM parameters) are accepted and silently dropped.");

export type LetsTalkSubmission = z.infer<typeof letsTalkSubmissionSchema>;

// ---------------------------------------------------------------------------
// Model output — L1 tolerant coercions
// ---------------------------------------------------------------------------

function toNumberIfNumeric(value: unknown): unknown {
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value.trim().replace(/%$/, ''));
        return Number.isFinite(parsed) ? parsed : value;
    }
    return value;
}

function toClassKey(key: string): string {
    return key.trim().replace(/[\s-]+/g, '_').toUpperCase();
}

/**
 * L1 coercion of the model's `confidences` object:
 *  - keys trimmed and upper-snake-cased (`"sales lead"` → `SALES_LEAD`);
 *  - numeric strings become numbers (`"0.8"` → `0.8`);
 *  - percentages are rescaled: when every non-zero value is in [1, 100] and at
 *    least one is above 1 (`{A: 80, B: 20}`), every value is divided by 100.
 *    A mix of fractions and percentages (`{A: 0.8, B: 20}`) is left alone;
 *  - keys that are not configured classes are dropped.
 *
 * Anything that is not a plain object is returned unchanged so the schema
 * reports it.
 */
export function normalizeConfidences(value: unknown, classIds: readonly string[]): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

    const known = new Set(classIds);
    const entries = Object.entries(value as Record<string, unknown>)
        .map(([key, raw]) => [toClassKey(key), toNumberIfNumeric(raw)] as const)
        .filter(([key]) => known.has(key));

    const numbers = entries.map(([, v]) => v).filter((v): v is number => typeof v === 'number');
    const nonZero = numbers.filter((v) => v !== 0);
    const isPercent =
        numbers.length === entries.length &&
        nonZero.some((v) => v > 1) &&
        nonZero.every((v) => v >= 1 && v <= 100);

    return Object.fromEntries(
        entries.map(([key, v]) => [key, isPercent && typeof v === 'number' ? v / 100 : v]),
    );
}

function normalizeLanguage(value: unknown): unknown {
    return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/** What the model must return. Every class is required, so the model is told to score each one. */
export function buildModelOutputSchema(classIds: readonly string[]) {
    const confidenceShape = Object.fromEntries(
        classIds.map((id) => [
            id,
            z.number().min(0).max(1).describe(`Probability (0–1) that the submission is ${id}.`),
        ]),
    );

    return z.object({
        confidences: z
            .preprocess((v) => normalizeConfidences(v, classIds), z.object(confidenceShape))
            .describe('A probability 0–1 for EVERY class listed in your instructions. The values must sum to 1.'),
        detectedLanguage: z
            .preprocess(normalizeLanguage, z.string())
            .describe('ISO 639-1 code of the submission language, e.g. "en", "es", "pt".'),
        rationale: z
            .string()
            .describe('One or two sentences IN ENGLISH explaining the scores, regardless of the submission language.'),
    });
}

export type LetsTalkModelOutput = z.infer<ReturnType<typeof buildModelOutputSchema>>;

export const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}$/;
export const CONFIDENCE_SUM_TOLERANCE = 0.02;

/**
 * Semantic checks the schema can't express — the L2 processor's `verify`.
 * Takes a schema-parsed object, so presence/range are re-checked only
 * defensively; the sum, language code and rationale are the real checks.
 */
export function checkModelOutputSemantics(output: LetsTalkModelOutput, classIds: readonly string[]): string[] {
    const issues: string[] = [];
    const confidences = output.confidences as Record<string, unknown>;
    let sum = 0;
    for (const id of classIds) {
        const value = confidences[id];
        if (value === undefined) {
            issues.push(`confidences.${id} missing`);
        } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
            issues.push(`confidences.${id} must be a number between 0 and 1 (got ${JSON.stringify(value)})`);
        } else {
            sum += value;
        }
    }
    if (issues.length === 0 && Math.abs(sum - 1) > CONFIDENCE_SUM_TOLERANCE) {
        issues.push(`confidences must sum to 1 (got ${Number(sum.toFixed(4))})`);
    }
    if (!LANGUAGE_CODE_PATTERN.test(output.detectedLanguage)) {
        issues.push(`detectedLanguage must be an ISO 639-1 code such as "en" (got ${JSON.stringify(output.detectedLanguage)})`);
    }
    if (!output.rationale.trim()) {
        issues.push('rationale must be a non-empty English sentence');
    }
    return issues;
}

// ---------------------------------------------------------------------------
// Workflow output
// ---------------------------------------------------------------------------

export function buildClassificationOutputSchema(classIds: readonly string[]) {
    const ids = classIds as [string, ...string[]];
    return z.object({
        submissionId: z.string().describe('Echo of the input submissionId.'),
        classification: z.enum(ids).describe('The winning class — the one with the highest confidence. Ties go to the earlier configured class.'),
        confidence: z.number().min(0).max(1).describe('Confidence of the winning class (= confidences[classification]).'),
        confidences: z
            .object(Object.fromEntries(classIds.map((id) => [id, z.number().min(0).max(1)])))
            .describe('Confidence 0–1 for EVERY configured class; values sum to 1 (±0.01).'),
        needsReview: z
            .boolean()
            .describe('true when the message was empty, when the top confidence is below LETS_TALK_MIN_CONFIDENCE (default 0.5), or when the top two are within 0.1 of each other.'),
        detectedLanguage: z.string().describe('ISO 639-1 code of the submission language, e.g. "en", "es"; "und" when the model returned no usable code.'),
        rationale: z.string().max(500).describe('One- or two-sentence explanation in English, regardless of submission language.'),
    }).describe("Classification of one Let's talk submission into the configured buckets.");
}

export type LetsTalkClassification = z.infer<ReturnType<typeof buildClassificationOutputSchema>>;

const { classIds } = getLetsTalkClassificationConfig();

export const letsTalkModelOutputSchema = buildModelOutputSchema(classIds);
export const letsTalkClassificationOutputSchema = buildClassificationOutputSchema(classIds);
