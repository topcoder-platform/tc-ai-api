import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { tcAILogger } from '../logger';

/**
 * Creates a Bedrock provider with optional per-agent request metadata header.
 *
 * When `agentId` is provided, every LLM request includes:
 *   X-Amzn-Bedrock-Request-Metadata: {"department":"ai_api","role":"agent-<agentId>"}
 *
 * The header is set at the provider level (AmazonBedrockProviderSettings.headers)
 * and is merged into every HTTP request via combineHeaders, surviving SigV4 signing.
 */
export function createBedrockProvider(agentId?: string) {
    const headers: Record<string, string> = {};

    if (agentId) {
        headers['X-Amzn-Bedrock-Request-Metadata'] = JSON.stringify({
            department: 'ai_api',
            role: `agent-${agentId}`,
        });
        tcAILogger.debug(`[Bedrock] Provider created with request metadata for agent: ${agentId}`);
    }

    return createAmazonBedrock({
        region: process.env.AWS_REGION || 'us-east-1',
        credentialProvider: fromNodeProviderChain(),
        headers,
    });
}

// Singleton export for backward compatibility (no metadata header)
export const bedrock = createBedrockProvider();
