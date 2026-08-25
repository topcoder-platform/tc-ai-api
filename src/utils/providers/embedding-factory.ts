import { ollama } from './ollama';
import { createBedrockProvider } from './bedrock';
import { tcAILogger } from '../logger';

/**
 * Creates an embedding model instance for the given provider, mirroring the
 * createModel pattern. Uses ollama.embedding() for TC-Ollama and
 * createBedrockProvider().embedding() for AWSBedrock.
 *
 * @param provider - Provider name (e.g. 'TC-Ollama', 'AWSBedrock')
 * @param modelId - Embedding model ID (e.g. 'nomic-embed-text')
 * @returns An AI SDK v6 embedding model usable with embed/embedMany
 */
export function createEmbeddingModel(provider: string, modelId: string) {
    tcAILogger.info(
        `[Embedding Factory] PROVIDER: ${provider}, MODEL: ${modelId}`,
    );

    switch (provider) {
        case 'TC-Ollama':
            return ollama.embedding(modelId);

        case 'AWSBedrock':
            return createBedrockProvider().embedding(modelId);

        default:
            tcAILogger.error(
                `[Embedding Factory] Unsupported embedding provider: ${provider}. ` +
                `Supported providers: TC-Ollama, AWSBedrock. ` +
                `Set RAG_EMBEDDING_PROVIDER to a supported value.`,
            );
            throw new Error(
                `Unsupported embedding provider: ${provider}. ` +
                `Supported providers: TC-Ollama, AWSBedrock. ` +
                `Set RAG_EMBEDDING_PROVIDER to a supported value.`,
            );
    }
}
