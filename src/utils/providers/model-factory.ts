import { ollama } from './ollama';
import { wipro } from './wipro';
import { bedrock } from './bedrock';
import { tcAILogger } from '../logger';
import { openai } from './openai';

export type SupportedProvider = 'TC-Ollama' | 'WiproAI' | 'AWSBedrock' | 'OpenAI';

export function createModel(providerName: string, modelName: string, agentId?: string) {
    tcAILogger.info(`[Model Factory] PROVIDER: ${providerName}, MODEL: ${modelName} for AGENT: ${agentId ?? 'N/A'}`);

    switch (providerName) {
        case 'TC-Ollama':
            return ollama(modelName);

        case 'WiproAI':
            return wipro.chatModel(modelName);

        case 'AWSBedrock':
            return bedrock(modelName);

        case 'OpenAI':
            return openai(modelName);

        default:
            tcAILogger.error(`[Model Factory] Unsupported LLM provider: ${providerName}. Supported providers: TC-Ollama, WiproAI, AWSBedrock, OpenAI`);
            throw new Error(`Unsupported LLM provider: ${providerName}. Supported providers: TC-Ollama, WiproAI, AWSBedrock, OpenAI`);
    }
}
