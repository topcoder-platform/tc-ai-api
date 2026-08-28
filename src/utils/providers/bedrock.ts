import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';
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

/**
 * Creates a Bedrock chat language model with per-agent request metadata.
 *
 * Chat models call Bedrock's Converse/ConverseStream API, which reads request
 * metadata from a `requestMetadata` body field rather than an HTTP header. We inject
 * it via `providerOptions.bedrock.requestMetadata` on every call using
 * `defaultSettingsMiddleware`, so call sites (generateText/streamText/Agent.generate)
 * don't need to set it themselves.
 */
export function createBedrockChatModel(modelId: string, agentId?: string): BedrockLanguageModel {
    const model = createBedrockProvider(agentId)(modelId);

    if (!agentId) {
        return model;
    }

    return wrapLanguageModel({
        model,
        middleware: defaultSettingsMiddleware({
            settings: {
                providerOptions: {
                    bedrock: { requestMetadata: requestMetadataFor(agentId) },
                },
            },
        }),
    }) as BedrockLanguageModel;
}

// Singleton export for backward compatibility (no metadata header)
export const bedrock = createBedrockProvider();
