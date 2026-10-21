/**
 * The canonical System One contract (Zod), shared by the tool, the workflow
 * and every provider. It is Ollama's `POST /v1/systemone` schema verbatim
 * (incl. the name `noul`), with the deviations listed in
 * docs/adr/0009-system-one-tool.md, Decisions 3 and 4:
 *
 *  - `model` is optional (server default) and must be allowlisted;
 *  - `keep_alive` is not accepted from callers (stripped) — server-controlled.
 *
 * The descriptions are the agent's only manual — edit them as carefully as code.
 */
import { z } from 'zod';
import type { SystemOneConfig } from '../../../config/system-one.config';
import { visionModels } from '../../../config/system-one.config';
import { SystemOneError } from './provider';

// ---------------------------------------------------------------------------
// Limits (mirroring upstream, so a bad call fails here with a field path)
// ---------------------------------------------------------------------------

export const SYS1_LIMITS = {
    minQuestions: 1,
    maxQuestions: 64,
    minOptions: 2,
    maxOptions: 26,
    /** Serialized request body without images. */
    maxBytesWithoutImages: 64 * 1024,
    /** Serialized request body with images (incl. base64 + JSON). */
    maxBytesWithImages: 32 * 1024 * 1024,
} as const;

/** Zod reports a failing record KEY schema only as "Invalid key in record" — check keys here instead. */
const NON_BLANK_KEYS = [
    (record: Record<string, unknown>) => Object.keys(record).every((key) => /\S/.test(key)),
    { message: 'keys must not be blank' },
] as const;

function keyCountBetween(min: number, max: number, what: string) {
    return [
        (record: Record<string, unknown>) => {
            const count = Object.keys(record).length;
            return count >= min && count <= max;
        },
        { message: `must have ${min}–${max} ${what}` },
    ] as const;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const systemOneContentSchema = z.union([
    z.string().regex(/\S/, 'must not be blank'),
    z.record(z.string(), z.unknown()),
    z.array(z.unknown()),
]);

const instructionsSchema = systemOneContentSchema.describe(
    'The question, phrased for this type (e.g. "Which label fits this ticket?"). ' +
    'A string, or a JSON object/array.',
);

const choiceQuestionSchema = z
    .object({
        type: z.literal('choice'),
        instructions: instructionsSchema,
        criteria: z
            .record(z.string(), z.string().nullable())
            .refine(...keyCountBetween(SYS1_LIMITS.minOptions, SYS1_LIMITS.maxOptions, 'options'))
            .refine(...NON_BLANK_KEYS)
            .describe(
                'Option key → description, e.g. {"bug":"Software errors","billing":"Payments and refunds"}. ' +
                'null description = use the key. 2–26 options; ties follow option order.',
            ),
    })
    .describe(
        'Pick exactly one of 2–26 named options. `criteria` maps option key → description ' +
        '(e.g. {"bug":"Software errors","billing":"Payments and refunds"}); null description = use the key. ' +
        'Include an "other"/"none" option when the input may fit none of them — the model must otherwise pick one.',
    );

const noulQuestionSchema = z
    .object({
        type: z.literal('noul'),
        instructions: instructionsSchema,
        criteria: z
            .strictObject({
                false: z.string().optional().describe('What "no" means. Default "No".'),
                true: z.string().optional().describe('What "yes" means. Default "Yes".'),
            })
            .optional()
            .describe('Optional {"false": "...", "true": "..."}; no other keys.'),
    })
    .describe(
        'Yes/no. Returns the probability that the answer is yes (true). Optional ' +
        'criteria: {"false": "...", "true": "..."} sharpens what yes and no mean (defaults "No"/"Yes"). ' +
        'Phrase `instructions` as a yes/no question.',
    );

const scoreQuestionSchema = z
    .object({
        type: z.literal('score'),
        instructions: instructionsSchema,
        criteria: z
            .array(z.string())
            .min(SYS1_LIMITS.minOptions)
            .max(SYS1_LIMITS.maxOptions)
            .describe('2–26 level descriptions ordered from LOWEST (index 0) to HIGHEST.'),
    })
    .describe(
        'Place the input on an ordered scale. `criteria` is an array of 2–26 level descriptions ordered ' +
        'from LOWEST (index 0) to HIGHEST. Returns a weighted average index in [0, N-1] — e.g. 1.7 on a ' +
        '0–2 scale — not a 0–1 or 0–100 value.',
    );

export const systemOneQuestionSchema = z.discriminatedUnion('type', [
    choiceQuestionSchema,
    noulQuestionSchema,
    scoreQuestionSchema,
]);

const STATE_DESCRIPTION =
    'The content being judged: a non-empty string, or a JSON object/array (serialized to text). ' +
    'Include everything the questions need — questions cannot see each other. Not chat messages. ' +
    'Max ~64 KiB total request without images.';

const QUESTIONS_DESCRIPTION =
    'Map of your own question names (e.g. "is_spam", "priority") to question definitions; 1–64 entries. ' +
    'Answers come back under the same names. Each question is answered independently against `state`.';

export interface SystemOneModelInfo {
    defaultModel: string;
    allowedModels: string[];
}

function modelDescription({ defaultModel, allowedModels }: SystemOneModelInfo): string {
    const vision = visionModels(allowedModels);
    return (
        `Optional. One of: ${allowedModels.join(', ')}. Omit to use ${defaultModel}.` +
        (vision.length ? ` Use ${vision.join(' or ')} when sending images.` : '')
    );
}

function imagesDescription({ allowedModels }: SystemOneModelInfo): string {
    const vision = visionModels(allowedModels);
    return (
        'Optional base64-encoded PNG/JPEG/WebP images (raw base64 — no `data:` prefix, no URLs), shared ' +
        'by all questions. Only image-capable models accept them (' +
        (vision.length ? vision.join(', ') : 'none is enabled on this server; e.g. clef-flash') +
        '); set `model` accordingly. `state` is still required and should say what the images are.'
    );
}

/**
 * Builds the caller-facing request schema. The model list is baked into the
 * descriptions so an agent sees the real options; enforcement happens in
 * resolveSystemOneRequest() against the config read at execute time.
 *
 * A plain z.object: unknown keys — notably `keep_alive` — are stripped, not rejected.
 */
export function buildSystemOneInputSchema(models: SystemOneModelInfo) {
    return z.object({
        model: z.string().trim().min(1).optional().describe(modelDescription(models)),
        state: systemOneContentSchema.describe(STATE_DESCRIPTION),
        images: z.array(z.base64()).min(1).optional().describe(imagesDescription(models)),
        questions: z
            .record(z.string(), systemOneQuestionSchema)
            .refine(
                ...keyCountBetween(SYS1_LIMITS.minQuestions, SYS1_LIMITS.maxQuestions, 'questions'),
            )
            .refine(...NON_BLANK_KEYS)
            .describe(QUESTIONS_DESCRIPTION),
    });
}

/** Schema with the server defaults' descriptions — for typing and tests. */
export const systemOneRequestSchema = buildSystemOneInputSchema({
    defaultModel: 'nimble',
    allowedModels: ['nimble'],
});
export type SystemOneRequest = z.infer<typeof systemOneRequestSchema>;

/** A request after resolveSystemOneRequest(): model resolved, keep_alive from config only. */
export const systemOneProviderRequestSchema = systemOneRequestSchema.extend({
    model: z.string().min(1).describe('The resolved System One model.'),
    keep_alive: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Server-controlled (SYS1_KEEP_ALIVE); never taken from the caller.'),
});
export type SystemOneProviderRequest = z.infer<typeof systemOneProviderRequestSchema>;

// ---------------------------------------------------------------------------
// Response — loose objects, so additive upstream fields pass through verbatim
// ---------------------------------------------------------------------------

const probabilitiesDescription = 'Probability per candidate; sums to ≈ 1.';
const confidenceDescription =
    '1 − H(p)/ln(N): 0 = uniform, ~1 = one candidate dominates. Concentration of the ' +
    'distribution, NOT calibrated correctness.';

export const systemOneChoiceAnswerSchema = z
    .looseObject({
        type: z.literal('choice'),
        choice: z.string().describe('The most probable option key.'),
        probabilities: z
            .record(z.string(), z.number())
            .describe(`Keyed by option key. ${probabilitiesDescription}`),
        confidence: z.number().describe(confidenceDescription),
    })
    .describe('Answer to a `choice` question.');

export const systemOneNoulAnswerSchema = z
    .looseObject({
        type: z.literal('noul'),
        noul: z
            .number()
            .describe('P(yes) in [0, 1] — a probability, not a boolean. No `confidence` field.'),
    })
    .describe('Answer to a `noul` (yes/no) question.');

export const systemOneScoreAnswerSchema = z
    .looseObject({
        type: z.literal('score'),
        score: z
            .number()
            .describe(
                'Σ index × P(index), in [0, N-1] — a weighted index, NOT rounded and NOT normalized ' +
                'to 0–1. Use `legend` to name the levels.',
            ),
        legend: z
            .record(z.string(), z.string())
            .describe('Level description keyed by zero-based index as a STRING ("0", "1", …).'),
        probabilities: z
            .record(z.string(), z.number())
            .describe(`Keyed by zero-based index as a STRING. ${probabilitiesDescription}`),
        confidence: z.number().describe(confidenceDescription),
    })
    .describe('Answer to a `score` question.');

export const systemOneAnswerSchema = z.discriminatedUnion('type', [
    systemOneChoiceAnswerSchema,
    systemOneNoulAnswerSchema,
    systemOneScoreAnswerSchema,
]);

export const systemOneResponseSchema = z.looseObject({
    model: z.string().describe('The model that answered (the resolved model).'),
    answers: z
        .record(z.string(), systemOneAnswerSchema)
        .describe('One answer per question, under the question names you sent.'),
    usage: z
        .looseObject({
            input_tokens: z.number(),
            output_tokens: z
                .number()
                .describe('Internal scoring work, not response length.'),
        })
        .describe('Token usage of the scoring call.'),
});
export type SystemOneResponse = z.infer<typeof systemOneResponseSchema>;
export type SystemOneProviderResponse = SystemOneResponse;

// ---------------------------------------------------------------------------
// Resolution — shared by the tool's execute and the workflow's validate step,
// so the two can't drift.
// ---------------------------------------------------------------------------

/**
 * Applies the server-side rules to a schema-valid request: default/allowlisted
 * model, keep_alive from config only, and the upstream size limits.
 */
export function resolveSystemOneRequest(
    input: SystemOneRequest,
    config: Pick<SystemOneConfig, 'defaultModel' | 'allowedModels' | 'keepAlive'>,
): SystemOneProviderRequest {
    const model = input.model ?? config.defaultModel;
    if (!config.allowedModels.includes(model)) {
        throw new SystemOneError(
            400,
            'SYS1_MODEL_NOT_ALLOWED',
            `Model "${model}" is not allowed. Allowed models: ${config.allowedModels.join(', ')}.`,
        );
    }

    // Built field by field: nothing the caller sent beyond the contract
    // (keep_alive in particular) reaches the provider.
    const resolved: SystemOneProviderRequest = {
        model,
        state: input.state,
        ...(input.images?.length ? { images: input.images } : {}),
        questions: input.questions,
        ...(config.keepAlive !== undefined ? { keep_alive: config.keepAlive } : {}),
    };

    const bytes = Buffer.byteLength(JSON.stringify(resolved));
    const limit = resolved.images
        ? SYS1_LIMITS.maxBytesWithImages
        : SYS1_LIMITS.maxBytesWithoutImages;
    if (bytes > limit) {
        throw new SystemOneError(
            413,
            'SYS1_REQUEST_TOO_LARGE',
            `Request is ${bytes} bytes; the limit is ${limit} bytes ` +
            `${resolved.images ? 'with' : 'without'} images.`,
        );
    }

    return resolved;
}

/** "questions.label.criteria: must have 2–26 options; state: …" */
export function formatSystemOneIssues(error: z.ZodError): string {
    return error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
}
