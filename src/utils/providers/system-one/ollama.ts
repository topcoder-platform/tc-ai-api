/**
 * Ollama System One adapter — `POST {baseUrl}/v1/systemone`.
 * See docs/adr/0009-system-one-tool.md, Decisions 1 and 5.
 *
 * No retries: a scoring call is cheap to repeat and the caller owns that
 * choice; retrying a context overflow or another 4xx would be wrong.
 */
import { SystemOneError, type SystemOneProvider } from './provider';
import {
    systemOneResponseSchema,
    formatSystemOneIssues,
    type SystemOneProviderRequest,
    type SystemOneProviderResponse,
} from './types';

const MAX_UPSTREAM_ERROR_CHARS = 500;

/** The upstream `{ "error": string }` text, or the raw body when it isn't JSON. */
async function readUpstreamError(res: Response): Promise<string> {
    const text = await res.text().catch(() => '');
    let message = text;
    try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed?.error === 'string') message = parsed.error;
    } catch {
        // not JSON — keep the raw text
    }
    message = message.trim() || res.statusText || 'no error body';
    return message.length > MAX_UPSTREAM_ERROR_CHARS
        ? `${message.slice(0, MAX_UPSTREAM_ERROR_CHARS)}…`
        : message;
}

async function toSystemOneError(res: Response): Promise<SystemOneError> {
    const upstream = await readUpstreamError(res);
    switch (res.status) {
        case 400:
            return new SystemOneError(400, 'SYS1_INVALID_REQUEST', upstream);
        case 404:
            // The model is allowlisted, so a 404 is an ops fault (model not
            // pulled, or an Ollama < 0.35 with no /v1/systemone) — not the
            // caller's. The upstream text tells the two apart.
            return new SystemOneError(
                503,
                'SYS1_MODEL_UNAVAILABLE',
                `System One provider returned 404: ${upstream}`,
            );
        case 413:
            return new SystemOneError(413, 'SYS1_REQUEST_TOO_LARGE', upstream);
        default:
            return new SystemOneError(
                502,
                'SYS1_UPSTREAM_ERROR',
                `System One provider returned ${res.status}: ${upstream}`,
            );
    }
}

export class OllamaSystemOneProvider implements SystemOneProvider {
    readonly name = 'ollama' as const;

    constructor(
        private readonly options: { baseUrl: string; timeoutMs: number },
    ) {}

    async evaluate(
        req: SystemOneProviderRequest,
        { signal }: { signal?: AbortSignal } = {},
    ): Promise<SystemOneProviderResponse> {
        const timeout = AbortSignal.timeout(this.options.timeoutMs);
        const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;

        let res: Response;
        let body: unknown;
        try {
            res = await fetch(`${this.options.baseUrl}/v1/systemone`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(req),
                signal: combined,
            });
            if (!res.ok) throw await toSystemOneError(res);
            body = await res.json().catch(() => {
                if (combined.aborted) throw combined.reason;
                throw new SystemOneError(
                    502,
                    'SYS1_UPSTREAM_ERROR',
                    'System One provider returned a non-JSON response',
                );
            });
        } catch (error) {
            if (error instanceof SystemOneError) throw error;
            // A caller abort (e.g. the run was cancelled) is not a provider fault.
            if (signal?.aborted) throw error;
            if (timeout.aborted) {
                throw new SystemOneError(
                    504,
                    'SYS1_TIMEOUT',
                    `System One provider did not respond within ${this.options.timeoutMs} ms`,
                );
            }
            throw new SystemOneError(
                503,
                'SYS1_PROVIDER_UNAVAILABLE',
                `System One provider is unreachable: ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        // Contract drift is a 502, never a silent pass-through.
        const parsed = systemOneResponseSchema.safeParse(body);
        if (!parsed.success) {
            throw new SystemOneError(
                502,
                'SYS1_UPSTREAM_ERROR',
                `System One provider response does not match the contract: ${formatSystemOneIssues(parsed.error)}`,
            );
        }
        return parsed.data;
    }
}
