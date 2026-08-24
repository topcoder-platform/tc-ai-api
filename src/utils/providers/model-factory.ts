import { ollama } from './ollama';
import { createBedrockProvider } from './bedrock';
import { tcAILogger } from '../logger';
import { openai } from './openai';

export type SupportedProvider = 'TC-Ollama' | 'WiproAI' | 'AWSBedrock' | 'OpenAI';

export function createModel(providerName: string, modelName: string, agentId?: string) {
    tcAILogger.info(`[Model Factory] PROVIDER: ${providerName}, MODEL: ${modelName} for AGENT: ${agentId ?? 'N/A'}`);

    switch (providerName) {
        case 'TC-Ollama':
            return ollama(modelName, {
                // options: {
                //     temperature: Number(process.env.OLLAMA_TEMPERATURE || 0.1),
                //     num_batch: Number(process.env.OLLAMA_NUM_BATCH || 1024),
                //     num_predict: Number(process.env.OLLAMA_NUM_PREDICT || 2048),
                // }
            });

        case 'AWSBedrock':
            return createBedrockProvider(agentId)(modelName);

        case 'OpenAI':
            return openai(modelName);

        default:
            tcAILogger.error(`[Model Factory] Unsupported LLM provider: ${providerName}. Supported providers: TC-Ollama, WiproAI, AWSBedrock, OpenAI`);
            throw new Error(`Unsupported LLM provider: ${providerName}. Supported providers: TC-Ollama, WiproAI, AWSBedrock, OpenAI`);
    }
}
