/**
 * System One provider interface and error type.
 * See docs/adr/0009-system-one-tool.md, Decisions 1 and 5.
 */
import type { SystemOneProviderRequest, SystemOneProviderResponse } from './types';

export type SystemOneProviderName = 'ollama';

export interface SystemOneProvider {
    /** Stable id surfaced in tool output and logs, e.g. 'ollama'. */
    readonly name: SystemOneProviderName;
    evaluate(
        req: SystemOneProviderRequest,
        opts: { signal?: AbortSignal },
    ): Promise<SystemOneProviderResponse>;
}

export type SystemOneErrorCode =
    | 'SYS1_INVALID_INPUT'
    | 'SYS1_MODEL_NOT_ALLOWED'
    | 'SYS1_REQUEST_TOO_LARGE'
    | 'SYS1_INVALID_REQUEST'
    | 'SYS1_MODEL_UNAVAILABLE'
    | 'SYS1_UPSTREAM_ERROR'
    | 'SYS1_PROVIDER_UNAVAILABLE'
    | 'SYS1_TIMEOUT'
    | 'SYS1_NOT_CONFIGURED'
    | 'SYS1_RUN_ID_CONFLICT';

/**
 * Mastra's error handler answers `{ "error": err.message }` with `err.status`,
 * and a failed workflow run keeps `message` and `status` — so the code is
 * prefixed into the message to give callers a stable token to match on.
 */
export class SystemOneError extends Error {
    readonly status: number;
    readonly code: SystemOneErrorCode;

    constructor(status: number, code: SystemOneErrorCode, message: string) {
        super(`[${code}] ${message}`);
        this.name = 'SystemOneError';
        this.status = status;
        this.code = code;
    }
}
