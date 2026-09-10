import { MASTRA_AUTH_TOKEN_KEY, RequestContext } from '@mastra/core/request-context';
import { M2MService } from './auth/m2m.service';
import { TOOL_M2M_FALLBACK_CONFIG } from '../config/tool-auth-fallback.config';
import { tcAILogger } from './logger';

const m2mService = new M2MService();

const DEFAULT_HEADERS = {
    'Content-Type': 'application/json',
    'app-version': '2.0.0',
};

export interface CallTcApiOptions {
    /** Matches the Mastra tool's `createTool({ id })` — the fallback config key. */
    toolId: string;
    url: string;
    /** `Authorization` and default headers are added by this client — do not set them here. */
    init?: RequestInit;
    requestContext: RequestContext | undefined;
}

/**
 * Calls a Topcoder platform API (`TC_API_BASE`) authorized as the requestor —
 * whatever token authenticated the current request (TC member JWT or M2M
 * JWT) is forwarded as-is. Falls back to tc-ai-api's own service M2M token,
 * once, only when `toolId` is explicitly enabled in
 * `TOOL_M2M_FALLBACK_CONFIG` and the requestor-token attempt fails with
 * 401/403 (or there was no requestor token to try).
 *
 * See docs/adr/0002-tc-api-requestor-token-with-m2m-fallback.md.
 */
export async function callTcApi({ toolId, url, init, requestContext }: CallTcApiOptions): Promise<Response> {
    const requestorToken = requestContext?.get(MASTRA_AUTH_TOKEN_KEY) as string | undefined;
    const fallbackEnabled = TOOL_M2M_FALLBACK_CONFIG[toolId] === true;

    if (requestorToken) {
        const response = await fetchWithToken(url, init, requestorToken);
        if ((response.status !== 401 && response.status !== 403) || !fallbackEnabled) {
            return response;
        }
        tcAILogger.warn('Requestor token rejected by Topcoder platform API, falling back to service M2M token', {
            toolId,
            status: response.status,
        });
        return fetchWithToken(url, init, await m2mService.getM2MToken());
    }

    if (!fallbackEnabled) {
        throw new Error(
            `No requestor token available for tool "${toolId}" and M2M fallback is not enabled for it.`,
        );
    }

    tcAILogger.warn('No requestor token available for Topcoder platform API call, using service M2M token', {
        toolId,
    });
    return fetchWithToken(url, init, await m2mService.getM2MToken());
}

function fetchWithToken(url: string, init: RequestInit | undefined, token: string): Promise<Response> {
    return fetch(url, {
        ...init,
        headers: {
            ...DEFAULT_HEADERS,
            ...(init?.headers as Record<string, string> | undefined),
            Authorization: `Bearer ${token}`,
        },
    });
}
