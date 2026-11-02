import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, TripWire } from '@mastra/core/agent';
import type { MastraDBMessage } from '@mastra/core/agent';
import { MockLanguageModelV3 } from 'ai/test';

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock('../../utils/logger', () => ({
    tcAILogger: { info: vi.fn(), warn: warnMock, error: vi.fn(), debug: vi.fn() },
}));

import {
    findRemoteAssetUrls,
    REMOTE_ASSET_REJECTION_REASON,
    RemoteAssetGuard,
    remoteAssetGuard,
} from './remote-asset-guard';

function dbMessage(content: Record<string, unknown>, role: MastraDBMessage['role'] = 'user'): MastraDBMessage {
    return {
        id: `m-${Math.random()}`,
        role,
        createdAt: new Date(),
        content: { format: 2, parts: [], ...content },
    } as unknown as MastraDBMessage;
}

function abort(reason?: string): never {
    throw new TripWire(reason ?? '');
}

describe('findRemoteAssetUrls', () => {
    it.each([
        ['ECS credentials endpoint', 'http://169.254.170.2/v2/credentials'],
        ['docker host', 'http://host.docker.internal/'],
        ['public https', 'https://example.com/a.png'],
        ['file scheme', 'file:///etc/passwd'],
    ])('flags a file part pointing at %s', (_label, url) => {
        const messages = [dbMessage({ parts: [{ type: 'file', data: url, mimeType: 'image/png' }] })];
        expect(findRemoteAssetUrls(messages).map(String)).toEqual([new URL(url).toString()]);
    });

    it('flags image parts, url fields and experimental_attachments', () => {
        const messages = [
            dbMessage({ parts: [{ type: 'image', image: 'http://10.0.0.1/x' }] }),
            dbMessage({ parts: [{ type: 'file', url: 'http://127.0.0.1/y', mediaType: 'image/png' }] }),
            dbMessage({ experimental_attachments: [{ url: 'http://169.254.169.254/latest/meta-data/' }] }),
        ];
        expect(findRemoteAssetUrls(messages)).toHaveLength(3);
    });

    it('allows text, inline data URLs and raw base64', () => {
        const messages = [
            dbMessage({ parts: [{ type: 'text', text: 'see http://169.254.170.2/v2/credentials' }] }),
            dbMessage({ parts: [{ type: 'file', data: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' }] }),
            dbMessage({ parts: [{ type: 'file', data: 'iVBORw0KGgoAAAANSUhEUg==', mimeType: 'image/png' }] }),
            dbMessage({ experimental_attachments: [{ url: 'data:text/plain;base64,aGk=' }] }),
        ];
        expect(findRemoteAssetUrls(messages)).toEqual([]);
    });
});

describe('RemoteAssetGuard.processInputStep', () => {
    beforeEach(() => warnMock.mockClear());

    it('aborts and logs origin + path only (no query string)', () => {
        const messages = [
            dbMessage({ parts: [{ type: 'file', data: 'http://169.254.170.2/v2/credentials?token=secret', mimeType: 'image/png' }] }),
        ];
        expect(() =>
            new RemoteAssetGuard().processInputStep({ messages, abort } as never),
        ).toThrow(REMOTE_ASSET_REJECTION_REASON);
        expect(warnMock).toHaveBeenCalledTimes(1);
        const logged = JSON.stringify(warnMock.mock.calls[0]);
        expect(logged).toContain('http://169.254.170.2/v2/credentials');
        expect(logged).not.toContain('secret');
    });

    it('passes text-only input through', () => {
        const messages = [dbMessage({ parts: [{ type: 'text', text: 'Java, React' }] })];
        expect(new RemoteAssetGuard().processInputStep({ messages, abort } as never)).toBeUndefined();
        expect(warnMock).not.toHaveBeenCalled();
    });
});

/**
 * End to end on a real Agent: proves the guard runs BEFORE Mastra's asset
 * download, so the URL is never fetched and the model is never called.
 */
describe('RemoteAssetGuard on a real agent', () => {
    const fetchSpy = vi.fn(async () => new Response('{"AccessKeyId":"leak"}', { status: 200 }));
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchSpy.mockClear();
        globalThis.fetch = fetchSpy as never;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function makeAgent(withGuard: boolean) {
        const doGenerate = vi.fn(async () => ({
            content: [{ type: 'text', text: 'ok' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } },
            warnings: [],
        }));
        const model = new MockLanguageModelV3({ doGenerate: doGenerate as never });
        const agent = new Agent({
            id: 'guard-test-agent',
            name: 'guard-test-agent',
            instructions: 'test',
            model,
            ...(withGuard ? { inputProcessors: [remoteAssetGuard] } : {}),
        });
        return { agent, doGenerate };
    }

    const ssrfInput = [
        {
            role: 'user' as const,
            content: [
                { type: 'text' as const, text: 'match skills' },
                { type: 'image' as const, image: 'http://169.254.170.2/v2/credentials', mediaType: 'image/png' },
            ],
        },
    ];

    it('without the guard, Mastra fetches the attacker URL (the vulnerability)', async () => {
        const { agent } = makeAgent(false);
        await agent.generate(ssrfInput as never).catch(() => undefined);
        expect(fetchSpy.mock.calls.map((c) => String((c as unknown[])[0]))).toContain(
            'http://169.254.170.2/v2/credentials',
        );
    });

    it('with the guard, nothing is fetched and the model is not called', async () => {
        const { agent, doGenerate } = makeAgent(true);
        const result = await agent.generate(ssrfInput as never).catch((error: unknown) => ({ error }));
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(doGenerate).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).toContain(REMOTE_ASSET_REJECTION_REASON);
    });

    it('with the guard, text-only input still reaches the model', async () => {
        const { agent, doGenerate } = makeAgent(true);
        const result = await agent.generate('Java, React');
        expect(doGenerate).toHaveBeenCalledTimes(1);
        expect(result.text).toBe('ok');
    });
});
