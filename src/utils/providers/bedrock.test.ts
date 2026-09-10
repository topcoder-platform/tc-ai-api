import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const { mockCreateAmazonBedrock, mockWrapLanguageModel, mockDefaultSettingsMiddleware } = vi.hoisted(() => ({
    mockCreateAmazonBedrock: vi.fn(),
    mockWrapLanguageModel: vi.fn(),
    mockDefaultSettingsMiddleware: vi.fn(),
}));

vi.mock('@ai-sdk/amazon-bedrock', () => ({
    createAmazonBedrock: (...args: unknown[]) => mockCreateAmazonBedrock(...args),
}));

vi.mock('@aws-sdk/credential-providers', () => ({
    fromNodeProviderChain: vi.fn(() => 'mock-credential-provider'),
}));

vi.mock('ai', () => ({
    wrapLanguageModel: (...args: unknown[]) => mockWrapLanguageModel(...args),
    defaultSettingsMiddleware: (...args: unknown[]) => mockDefaultSettingsMiddleware(...args),
}));

vi.mock('../logger', () => ({
    tcAILogger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
    },
}));

import { createBedrockChatModel, isCacheCapableBedrockModel } from './bedrock';
import { tcAILogger } from '../logger';

const REQUEST_METADATA_MARKER = '__requestMetadataMiddleware';

describe('bedrock — isCacheCapableBedrockModel', () => {
    it.each([
        'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        'us.anthropic.claude-sonnet-5',
        'anthropic.claude-sonnet-5',
        'us.anthropic.claude-opus-4-20250514-v1:0',
        'us.anthropic.claude-opus-4-1-20250805-v1:0',
        'anthropic.claude-3-5-sonnet-20241022-v2:0',
        'anthropic.claude-3-5-haiku-20241022-v1:0',
        'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
        'us.amazon.nova-pro-v1:0',
        'amazon.nova-lite-v1:0',
    ])('returns true for cache-capable model %s', (modelId) => {
        expect(isCacheCapableBedrockModel(modelId)).toBe(true);
    });

    it.each([
        'anthropic.claude-v2',
        'anthropic.claude-v2:1',
        'anthropic.claude-instant-v1',
        'us.anthropic.claude-3-sonnet-20240229-v1:0',
        'anthropic.claude-3-haiku-20240307-v1:0',
        'anthropic.claude-3-opus-20240229-v1:0',
        'amazon.titan-text-express-v1',
        'meta.llama3-70b-instruct-v1:0',
        'mistral.mistral-large-2402-v1:0',
        'cohere.command-r-v1:0',
    ])('returns false for non-cache-capable model %s', (modelId) => {
        expect(isCacheCapableBedrockModel(modelId)).toBe(false);
    });
});

describe('bedrock — createBedrockChatModel middleware composition', () => {
    const CACHE_CAPABLE_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
    const NON_CACHE_CAPABLE_MODEL = 'amazon.titan-text-express-v1';

    let originalCacheEnabled: string | undefined;
    let originalCacheTtl: string | undefined;
    let fakeModel: { modelId: string };

    beforeEach(() => {
        vi.clearAllMocks();
        originalCacheEnabled = process.env.BEDROCK_PROMPT_CACHE_ENABLED;
        originalCacheTtl = process.env.BEDROCK_PROMPT_CACHE_TTL;
        delete process.env.BEDROCK_PROMPT_CACHE_ENABLED;
        delete process.env.BEDROCK_PROMPT_CACHE_TTL;

        mockCreateAmazonBedrock.mockImplementation(() => (modelId: string) => {
            fakeModel = { modelId };
            return fakeModel;
        });
        mockWrapLanguageModel.mockImplementation((opts: { model: unknown; middleware: unknown[] }) => ({
            __wrapped: true,
            ...opts,
        }));
        mockDefaultSettingsMiddleware.mockImplementation((opts: unknown) => ({
            [REQUEST_METADATA_MARKER]: true,
            opts,
        }));
    });

    afterEach(() => {
        if (originalCacheEnabled === undefined) {
            delete process.env.BEDROCK_PROMPT_CACHE_ENABLED;
        } else {
            process.env.BEDROCK_PROMPT_CACHE_ENABLED = originalCacheEnabled;
        }
        if (originalCacheTtl === undefined) {
            delete process.env.BEDROCK_PROMPT_CACHE_TTL;
        } else {
            process.env.BEDROCK_PROMPT_CACHE_TTL = originalCacheTtl;
        }
    });

    it('returns the raw model, unwrapped, when there is no agentId and the model is not cache-capable', () => {
        const result = createBedrockChatModel(NON_CACHE_CAPABLE_MODEL);

        expect(mockWrapLanguageModel).not.toHaveBeenCalled();
        expect(result).toBe(fakeModel);
    });

    it('wraps with only the request-metadata middleware when agentId is set but the model is not cache-capable', () => {
        createBedrockChatModel(NON_CACHE_CAPABLE_MODEL, 'test-agent');

        expect(mockWrapLanguageModel).toHaveBeenCalledTimes(1);
        const { middleware } = mockWrapLanguageModel.mock.calls[0][0];
        expect(middleware).toHaveLength(1);
        expect(middleware[0]).toHaveProperty(REQUEST_METADATA_MARKER, true);
    });

    it('wraps with only the cache middleware when the model is cache-capable but no agentId is set', () => {
        createBedrockChatModel(CACHE_CAPABLE_MODEL);

        expect(mockWrapLanguageModel).toHaveBeenCalledTimes(1);
        const { middleware } = mockWrapLanguageModel.mock.calls[0][0];
        expect(middleware).toHaveLength(1);
        expect(middleware[0]).not.toHaveProperty(REQUEST_METADATA_MARKER);
        expect(middleware[0]).toHaveProperty('transformParams');
        expect(middleware[0]).toHaveProperty('wrapGenerate');
        expect(middleware[0]).toHaveProperty('wrapStream');
    });

    it('composes both middleware entries — request-metadata then cache — when agentId is set and the model is cache-capable', () => {
        createBedrockChatModel(CACHE_CAPABLE_MODEL, 'test-agent');

        expect(mockWrapLanguageModel).toHaveBeenCalledTimes(1);
        const { middleware } = mockWrapLanguageModel.mock.calls[0][0];
        expect(middleware).toHaveLength(2);
        expect(middleware[0]).toHaveProperty(REQUEST_METADATA_MARKER, true);
        expect(middleware[1]).toHaveProperty('transformParams');
    });

    it('omits the cache middleware entirely when BEDROCK_PROMPT_CACHE_ENABLED=false, even for a cache-capable model', () => {
        process.env.BEDROCK_PROMPT_CACHE_ENABLED = 'false';

        const result = createBedrockChatModel(CACHE_CAPABLE_MODEL);

        expect(mockWrapLanguageModel).not.toHaveBeenCalled();
        expect(result).toBe(fakeModel);
    });

    it('throws an actionable error for an invalid BEDROCK_PROMPT_CACHE_ENABLED value', () => {
        process.env.BEDROCK_PROMPT_CACHE_ENABLED = 'yes';

        expect(() => createBedrockChatModel(CACHE_CAPABLE_MODEL)).toThrow(
            /BEDROCK_PROMPT_CACHE_ENABLED/,
        );
    });

    it('throws an actionable error for an invalid BEDROCK_PROMPT_CACHE_TTL value', () => {
        process.env.BEDROCK_PROMPT_CACHE_TTL = '15m';

        expect(() => createBedrockChatModel(CACHE_CAPABLE_MODEL)).toThrow(
            /BEDROCK_PROMPT_CACHE_TTL/,
        );
    });

    it('accepts BEDROCK_PROMPT_CACHE_TTL=1h and uses it as the cachePoint ttl', async () => {
        process.env.BEDROCK_PROMPT_CACHE_TTL = '1h';

        createBedrockChatModel(CACHE_CAPABLE_MODEL);

        const { middleware } = mockWrapLanguageModel.mock.calls[0][0];
        const cacheMiddleware = middleware[0];
        const params = { prompt: [{ role: 'system', content: 'instructions' }] };

        const result = await cacheMiddleware.transformParams({ params });

        expect(result.prompt[0].providerOptions.bedrock.cachePoint).toEqual({
            type: 'default',
            ttl: '1h',
        });
    });
});

describe('bedrock — cache middleware behavior', () => {
    const CACHE_CAPABLE_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.BEDROCK_PROMPT_CACHE_ENABLED;
        delete process.env.BEDROCK_PROMPT_CACHE_TTL;

        mockCreateAmazonBedrock.mockImplementation(() => (modelId: string) => ({ modelId }));
        mockWrapLanguageModel.mockImplementation((opts: unknown) => opts);
        mockDefaultSettingsMiddleware.mockImplementation((opts: unknown) => opts);
    });

    function getCacheMiddleware(agentId?: string) {
        createBedrockChatModel(CACHE_CAPABLE_MODEL, agentId);
        const { middleware } = mockWrapLanguageModel.mock.calls[0][0] as { middleware: any[] };
        return middleware[middleware.length - 1];
    }

    it('adds a cachePoint to the system message, defaulting ttl to 5m', async () => {
        const cacheMiddleware = getCacheMiddleware();
        const params = {
            prompt: [
                { role: 'system', content: 'be helpful' },
                { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            ],
        };

        const result = await cacheMiddleware.transformParams({ params });

        expect(result.prompt[0].providerOptions.bedrock.cachePoint).toEqual({
            type: 'default',
            ttl: '5m',
        });
        // Untouched messages pass through unchanged
        expect(result.prompt[1]).toBe(params.prompt[1]);
    });

    it('preserves existing providerOptions on the system message rather than overwriting them', async () => {
        const cacheMiddleware = getCacheMiddleware();
        const params = {
            prompt: [
                {
                    role: 'system',
                    content: 'be helpful',
                    providerOptions: {
                        bedrock: { requestMetadata: { department: 'ai_api', role: 'agent-test' } },
                        anthropic: { someOtherFlag: true },
                    },
                },
            ],
        };

        const result = await cacheMiddleware.transformParams({ params });
        const systemProviderOptions = result.prompt[0].providerOptions;

        expect(systemProviderOptions.bedrock.requestMetadata).toEqual({
            department: 'ai_api',
            role: 'agent-test',
        });
        expect(systemProviderOptions.bedrock.cachePoint).toEqual({ type: 'default', ttl: '5m' });
        expect(systemProviderOptions.anthropic).toEqual({ someOtherFlag: true });
    });

    it('returns params unchanged when there is no system message', async () => {
        const cacheMiddleware = getCacheMiddleware();
        const params = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };

        const result = await cacheMiddleware.transformParams({ params });

        expect(result).toBe(params);
    });

    it('logs cache read/write token counts after a non-streaming call', async () => {
        const cacheMiddleware = getCacheMiddleware('test-agent');
        const doGenerate = vi.fn().mockResolvedValue({
            usage: { inputTokens: { cacheRead: 120, cacheWrite: 0 } },
            text: 'ok',
        });

        const result = await cacheMiddleware.wrapGenerate({ doGenerate });

        expect(result.text).toBe('ok');
        expect(tcAILogger.debug).toHaveBeenCalledWith(
            expect.stringMatching(/agent=test-agent.*cacheReadTokens=120 cacheWriteTokens=0/),
        );
    });

    it('logs cache read/write token counts from the finish chunk of a streamed call, passing chunks through unchanged', async () => {
        const cacheMiddleware = getCacheMiddleware('test-agent');
        const chunks = [
            { type: 'text-delta', id: '1', delta: 'hi' },
            { type: 'finish', usage: { inputTokens: { cacheRead: 0, cacheWrite: 340 } }, finishReason: 'stop' },
        ];
        const sourceStream = new ReadableStream({
            start(controller) {
                for (const chunk of chunks) {
                    controller.enqueue(chunk);
                }
                controller.close();
            },
        });
        const doStream = vi.fn().mockResolvedValue({ stream: sourceStream });

        const { stream } = await cacheMiddleware.wrapStream({ doStream });

        const seen: unknown[] = [];
        const reader = stream.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            seen.push(value);
        }

        expect(seen).toEqual(chunks);
        expect(tcAILogger.debug).toHaveBeenCalledWith(
            expect.stringMatching(/agent=test-agent.*cacheReadTokens=0 cacheWriteTokens=340/),
        );
    });
});
