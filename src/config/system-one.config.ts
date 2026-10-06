/**
 * System One configuration — resolved lazily.
 * See docs/adr/0009-system-one-tool.md, Decision 2.
 *
 * This module NEVER throws at import time (Docker build runs `pnpm test` with
 * no env). getSystemOneConfig() only throws for a malformed SYS1_TIMEOUT_MS;
 * an unknown provider or a missing base URL surfaces as a SystemOneError at
 * execute time (see src/utils/providers/system-one/index.ts).
 */

export interface SystemOneConfig {
    /** Raw SYS1_PROVIDER — validated by getSystemOneProvider(), not here. */
    provider: string;
    /** SYS1_OLLAMA_BASE_URL || OLLAMA_API_URL, trailing slash stripped; undefined when neither is set. */
    ollamaBaseUrl: string | undefined;
    /** Used when the request omits `model`. */
    defaultModel: string;
    /** Always contains defaultModel. */
    allowedModels: string[];
    timeoutMs: number;
    /** Passed through as `keep_alive`; numeric strings become numbers (seconds). */
    keepAlive: string | number | undefined;
}

const DEFAULT_PROVIDER = 'ollama';
const DEFAULT_MODEL = 'nimble';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Model-name prefixes of the image-capable System One models (Clef, Clef Flash).
 * Used only to tell the agent which allowed model to pick for images.
 */
const VISION_MODEL_PREFIXES = ['clef'];

let cached: SystemOneConfig | undefined;

/** Test-only: clears the memoised config after mutating process.env. */
export function _resetSystemOneConfigCache(): void {
    cached = undefined;
}

function parseTimeout(value: string | undefined): number {
    if (value === undefined || value === '') return DEFAULT_TIMEOUT_MS;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(
            `Invalid SYS1_TIMEOUT_MS="${value}": must be a positive integer (milliseconds). ` +
            'Set SYS1_TIMEOUT_MS to a valid value, or unset it to use the 30000 ms default.',
        );
    }
    return parsed;
}

/**
 * Ollama reads a JSON number as seconds and a string as a Go duration, which
 * needs a unit — so a bare "300" or "-1" from the environment must be sent as
 * a number, not as the string "300".
 */
function parseKeepAlive(value: string | undefined): string | number | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    return /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : trimmed;
}

function parseModelList(value: string | undefined): string[] {
    return (value ?? '').split(',').map((m) => m.trim()).filter(Boolean);
}

export function getSystemOneConfig(): SystemOneConfig {
    if (cached) return cached;

    const defaultModel = process.env.SYS1_MODEL?.trim() || DEFAULT_MODEL;
    // SYS1_MODEL is always implicitly allowed.
    const allowedModels = [
        ...new Set([defaultModel, ...parseModelList(process.env.SYS1_ALLOWED_MODELS)]),
    ];
    // OLLAMA_API_URL is read directly: the dev-host fallback in
    // src/utils/providers/ollama.ts is deliberately NOT inherited, so a prod
    // deploy can't silently score against dev.
    const rawBaseUrl =
        process.env.SYS1_OLLAMA_BASE_URL?.trim() || process.env.OLLAMA_API_URL?.trim();

    cached = {
        provider: process.env.SYS1_PROVIDER?.trim().toLowerCase() || DEFAULT_PROVIDER,
        ollamaBaseUrl: rawBaseUrl ? rawBaseUrl.replace(/\/+$/, '') : undefined,
        defaultModel,
        allowedModels,
        timeoutMs: parseTimeout(process.env.SYS1_TIMEOUT_MS),
        keepAlive: parseKeepAlive(process.env.SYS1_KEEP_ALIVE),
    };
    return cached;
}

/** The allowed models that accept `images`. */
export function visionModels(models: string[]): string[] {
    return models.filter((model) => {
        const name = (model.split('/').pop() ?? model).toLowerCase();
        return VISION_MODEL_PREFIXES.some((prefix) => name.startsWith(prefix));
    });
}
