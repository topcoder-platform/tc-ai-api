/**
 * RemoteAssetGuard: an input processor that blocks SSRF through message
 * attachments.
 *
 * Before calling the model, @mastra/core (1.74, `downloadAssetsFromMessages`)
 * fetches every `image`/`file` part whose data is a URL the model can't take
 * directly. It does this server side, with a bare `fetch()`: no scheme, host or
 * IP filtering. A caller can therefore make this service request any URL it can
 * reach, such as the ECS credentials endpoint (169.254.170.2) or
 * host.docker.internal. This was seen in production in Nov 2026.
 *
 * None of our agents takes attachments, so every non-`data:` URL in an
 * attachment slot is refused. Inline `data:` URLs and raw base64 are allowed
 * because they make no network request.
 *
 * Why `processInputStep` and not `processInput` or an HTTP middleware: the step
 * hook receives `messageList.get.all.db()`, which includes history recalled from
 * thread memory (messages can be saved through the memory API, not only sent to
 * /generate). It also runs before every LLM step, and the runner calls it before
 * the prompt conversion that does the download.
 */
import type { ProcessInputStepArgs, Processor } from '@mastra/core/processors';
import type { MastraDBMessage } from '@mastra/core/agent';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { tcAILogger } from '../../utils/logger';

export const REMOTE_ASSET_GUARD_ID = 'remote-asset-guard';
export const REMOTE_ASSET_REJECTION_REASON =
    'Attachments referenced by URL are not supported. Send text only, or inline the file as base64 data.';

/** Same parse Mastra applies before deciding to download; `data:` needs no network. */
function asRemoteUrl(value: unknown): URL | undefined {
    if (value instanceof URL) return value.protocol === 'data:' ? undefined : value;
    if (typeof value !== 'string') return undefined;
    try {
        const url = new URL(value.trim());
        return url.protocol === 'data:' ? undefined : url;
    } catch {
        return undefined;
    }
}

/** Every attachment slot that Mastra may turn into a model `image`/`file` part. */
function attachmentValues(message: MastraDBMessage): unknown[] {
    const content = message.content as unknown as Record<string, unknown> | undefined;
    if (!content || typeof content !== 'object') return [];

    const values: unknown[] = [];
    const parts = Array.isArray(content.parts) ? content.parts : [];
    for (const part of parts as Record<string, unknown>[]) {
        if (part?.type === 'file' || part?.type === 'image') {
            values.push(part.data, part.url, part.image);
        }
    }
    const attachments = Array.isArray(content.experimental_attachments) ? content.experimental_attachments : [];
    for (const attachment of attachments as Record<string, unknown>[]) {
        values.push(attachment?.url);
    }
    return values;
}

export function findRemoteAssetUrls(messages: MastraDBMessage[]): URL[] {
    return messages.flatMap((message) =>
        attachmentValues(message)
            .map(asRemoteUrl)
            .filter((url): url is URL => url !== undefined),
    );
}

export class RemoteAssetGuard implements Processor<typeof REMOTE_ASSET_GUARD_ID> {
    readonly id = REMOTE_ASSET_GUARD_ID;
    readonly name = 'Remote asset guard';

    processInputStep({ messages, abort, requestContext }: ProcessInputStepArgs): void {
        const urls = findRemoteAssetUrls(messages);
        if (urls.length === 0) return;

        // Origin + path only: query strings can carry tokens.
        tcAILogger.warn('Blocked attachment URL(s) in agent input (possible SSRF)', {
            resourceId: requestContext?.get(MASTRA_RESOURCE_ID_KEY),
            urls: urls.map((url) => `${url.protocol}//${url.host}${url.pathname}`),
        });
        abort(REMOTE_ASSET_REJECTION_REASON);
    }
}

export const remoteAssetGuard = new RemoteAssetGuard();
