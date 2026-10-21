/**
 * System One provider factory. See docs/adr/0009-system-one-tool.md, Decision 1.
 *
 * Deliberately separate from createModel()/SupportedProvider: those return
 * AI-SDK LanguageModels, and System One is a scoring RPC, not a chat model.
 */
import { getSystemOneConfig } from '../../../config/system-one.config';
import { OllamaSystemOneProvider } from './ollama';
import { SystemOneError, type SystemOneProvider } from './provider';

export * from './provider';
export * from './types';

let cached: SystemOneProvider | undefined;

/** Test-only: drops the memoised provider after mutating process.env. */
export function _resetSystemOneProviderCache(): void {
    cached = undefined;
}

/**
 * Memoised on success only, so a configuration error is re-evaluated on the
 * next call instead of being cached. Never called at import time.
 */
export function getSystemOneProvider(): SystemOneProvider {
    if (cached) return cached;

    const config = getSystemOneConfig();
    switch (config.provider) {
        case 'ollama': {
            if (!config.ollamaBaseUrl) {
                throw new SystemOneError(
                    503,
                    'SYS1_NOT_CONFIGURED',
                    'System One is not configured: set OLLAMA_API_URL (or SYS1_OLLAMA_BASE_URL).',
                );
            }
            cached = new OllamaSystemOneProvider({
                baseUrl: config.ollamaBaseUrl,
                timeoutMs: config.timeoutMs,
            });
            return cached;
        }
        default:
            throw new SystemOneError(
                503,
                'SYS1_NOT_CONFIGURED',
                `Unsupported SYS1_PROVIDER="${config.provider}". Supported providers: ollama. ` +
                'Set SYS1_PROVIDER to a supported provider, or unset it to use ollama.',
            );
    }
}
