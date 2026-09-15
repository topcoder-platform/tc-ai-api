import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';
import type { LanguageModelMiddleware } from 'ai';
import { tcAILogger } from '../logger';

// `ai`'s own `LanguageModel` type (from wrapLanguageModel) resolves against a
// different `@ai-sdk/provider` instance than the one Mastra vendors internally,
// so TS sees them as structurally incompatible even though they're the same
// interface at runtime. Anchor to the provider's own return type instead, which
// Mastra already accepts, and cast the wrapped model back onto it below.
type BedrockLanguageModel = ReturnType<ReturnType<typeof createBedrockProvider>>;

function requestMetadataFor(agentId: string) {
    return { department: 'ai_api', role: `agent-${agentId}` };
}

/**
 * Creates a Bedrock provider with an optional per-agent request metadata header.
 *
 * This header is only honored by Bedrock's InvokeModel/InvokeModelWithResponseStream
 * API (used by the embedding and image models below). The Converse/ConverseStream API
 * (used by chat language models) ignores this header entirely and instead requires a
 * `requestMetadata` field in the JSON request body — see `createBedrockChatModel`.
 * https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-request-metadata.html
 *
 * When `agentId` is provided, every InvokeModel-based request includes:
 *   X-Amzn-Bedrock-Request-Metadata: {"department":"ai_api","role":"agent-<agentId>"}
 */
export function createBedrockProvider(agentId?: string) {
    const headers: Record<string, string> = {};

    if (agentId) {
        headers['X-Amzn-Bedrock-Request-Metadata'] = JSON.stringify(requestMetadataFor(agentId));
        tcAILogger.debug(`[Bedrock] Provider created with request metadata for agent: ${agentId}`);
    }

    return createAmazonBedrock({
        region: process.env.AWS_REGION || 'us-east-1',
        credentialProvider: fromNodeProviderChain(),
        headers,
    });
}

// ---------------------------------------------------------------------------
// Prompt caching (ADR 0003)
// ---------------------------------------------------------------------------

const CACHE_TTL_VALUES = ['5m', '1h'] as const;
type BedrockCacheTtl = (typeof CACHE_TTL_VALUES)[number];

// Not exported by the installed @ai-sdk/amazon-bedrock version — cachePoint is read
// via untyped passthrough there (providerOptions.bedrock.cachePoint). This keeps the
// shape honest locally; see ADR 0003's "No compile-time type safety" risk note.
interface BedrockCachePoint {
    type: 'default';
    ttl?: BedrockCacheTtl;
}

// Allowlist, not denylist: a false negative here just means "no caching for this
// call" (silent, harmless); a false positive means a hard `ValidationException` on
// the very next request. When in doubt, don't cache. Extend deliberately as new
// cache-capable models ship.
const CACHE_CAPABLE_MODEL_PATTERNS: RegExp[] = [
    // Claude 5 family (Sonnet/Opus/Haiku/Fable) — bare alias, no date suffix
    /^(?:[a-z]{2,5}\.)?anthropic\.claude-(?:sonnet|opus|haiku|fable)-5(?:[-:]|$)/,
    // Claude 4.x family (Opus/Sonnet/Haiku 4, 4-1 .. 4-8, incl. dated variants)
    /^(?:[a-z]{2,5}\.)?anthropic\.claude-(?:opus|sonnet|haiku)-4(?:-\d+)?(?:-|$)/,
    // Claude 3.5 / 3.7 — explicitly NOT bare Claude 3 (pre-3.5 doesn't support caching)
    /^(?:[a-z]{2,5}\.)?anthropic\.claude-3-(?:5|7)-(?:sonnet|haiku)(?:-|$)/,
    // Amazon Nova
    /^(?:[a-z]{2,5}\.)?amazon\.nova-(?:pro|lite|micro|premier)(?:-|$)/,
];

export function isCacheCapableBedrockModel(modelId: string): boolean {
    return CACHE_CAPABLE_MODEL_PATTERNS.some((pattern) => pattern.test(modelId));
}

function isPromptCacheEnabled(): boolean {
    const raw = process.env.BEDROCK_PROMPT_CACHE_ENABLED;
    if (raw === undefined || raw === '') {
        return true;
    }
    if (raw === 'true' || raw === 'false') {
        return raw === 'true';
    }
    throw new Error(`Invalid BEDROCK_PROMPT_CACHE_ENABLED: "${raw}". Expected "true" or "false".`);
}

function getPromptCacheTtl(): BedrockCacheTtl {
    const raw = process.env.BEDROCK_PROMPT_CACHE_TTL;
    if (raw === undefined || raw === '') {
        return '5m';
    }
    if ((CACHE_TTL_VALUES as readonly string[]).includes(raw)) {
        return raw as BedrockCacheTtl;
    }
    throw new Error(`Invalid BEDROCK_PROMPT_CACHE_TTL: "${raw}". Expected one of: ${CACHE_TTL_VALUES.join(', ')}.`);
}

// Structurally narrowed to just what's read here, rather than importing 'ai's own
// usage type — avoids depending on a type name that may not survive an SDK upgrade
// (see the cachePoint type-safety note above) while staying self-contained.
interface BedrockCacheUsage {
    inputTokens: { cacheRead?: number; cacheWrite?: number };
}

function logCacheUsage(agentId: string | undefined, modelId: string, usage: BedrockCacheUsage) {
    tcAILogger.debug(
        `[Bedrock cache] agent=${agentId ?? 'N/A'} model=${modelId} ` +
        `cacheReadTokens=${usage.inputTokens.cacheRead ?? 0} cacheWriteTokens=${usage.inputTokens.cacheWrite ?? 0}`,
    );
}

/**
 * Stamps a cache checkpoint onto the system/instructions message of every call, and
 * logs cache read/write token counts so the feature's effect is observable rather
 * than silently present. Only added to the middleware chain when the model is
 * cache-capable and the feature is enabled — see `isCacheCapableBedrockModel`.
 */
function createCacheMiddleware(ttl: BedrockCacheTtl, agentId: string | undefined, modelId: string): LanguageModelMiddleware {
    return {
        specificationVersion: 'v3',
        transformParams: async ({ params }) => {
            const systemIndex = params.prompt.findIndex((message) => message.role === 'system');
            if (systemIndex === -1) {
                return params;
            }

            const systemMessage = params.prompt[systemIndex];
            const prompt = [...params.prompt];
            prompt[systemIndex] = {
                ...systemMessage,
                providerOptions: {
                    ...systemMessage.providerOptions,
                    bedrock: {
                        ...systemMessage.providerOptions?.bedrock,
                        cachePoint: { type: 'default', ttl } satisfies BedrockCachePoint,
                    },
                },
            };

            return { ...params, prompt };
        },
        wrapGenerate: async ({ doGenerate }) => {
            const result = await doGenerate();
            logCacheUsage(agentId, modelId, result.usage);
            return result;
        },
        wrapStream: async ({ doStream }) => {
            const { stream, ...rest } = await doStream();
            return {
                ...rest,
                stream: stream.pipeThrough(
                    new TransformStream({
                        transform(chunk, controller) {
                            if (chunk.type === 'finish') {
                                logCacheUsage(agentId, modelId, chunk.usage);
                            }
                            controller.enqueue(chunk);
                        },
                    }),
                ),
            };
        },
    };
}

/**
 * Creates a Bedrock chat language model with per-agent request metadata and (for
 * cache-capable models, see ADR 0003) prompt-cache injection on the system message.
 *
 * Chat models call Bedrock's Converse/ConverseStream API, which reads request
 * metadata from a `requestMetadata` body field rather than an HTTP header. We inject
 * it via `providerOptions.bedrock.requestMetadata` on every call using
 * `defaultSettingsMiddleware`, so call sites (generateText/streamText/Agent.generate)
 * don't need to set it themselves. Prompt caching is injected the same way, as a
 * second middleware entry, composed into the same `wrapLanguageModel` call rather
 * than a separate wrapper — one choke point, one `BedrockLanguageModel` cast.
 */
export function createBedrockChatModel(modelId: string, agentId?: string): BedrockLanguageModel {
    const model = createBedrockProvider(agentId)(modelId);

    const shouldCache = isPromptCacheEnabled() && isCacheCapableBedrockModel(modelId);

    if (!agentId && !shouldCache) {
        return model;
    }

    return wrapLanguageModel({
        model,
        middleware: [
            ...(agentId
                ? [
                    defaultSettingsMiddleware({
                        settings: {
                            providerOptions: {
                                bedrock: { requestMetadata: requestMetadataFor(agentId) },
                            },
                        },
                    }),
                ]
                : []),
            ...(shouldCache ? [createCacheMiddleware(getPromptCacheTtl(), agentId, modelId)] : []),
        ],
    }) as BedrockLanguageModel;
}

// Singleton export for backward compatibility (no metadata header)
export const bedrock = createBedrockProvider();
