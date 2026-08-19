import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// Mock the ollama provider so we can assert ollama.embedding was called
vi.mock('./ollama', () => ({
    ollama: {
        embedding: vi.fn(),
    },
}));

// Mock the bedrock provider factory
vi.mock('./bedrock', () => ({
    createBedrockProvider: vi.fn(),
}));

// Mock tcAILogger so we can assert logging behavior
vi.mock('../logger', () => ({
    tcAILogger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
    },
}));

// Mock auth modules so importing src/utils/index.ts does not throw
// (MastraAuthAuth0 requires AUTH0_DOMAIN/AUTH0_AUDIENCE env vars at import)
vi.mock('../auth', () => ({
    apiAuthLayer: undefined,
}));
vi.mock('../auth/m2m.service', () => ({
    M2MService: vi.fn(),
}));
vi.mock('../middleware', () => ({}));
vi.mock('../structured-output-wrapper', () => ({}));
// Mock other providers re-exported from index.ts that may throw without env vars
vi.mock('./wipro', () => ({
    wipro: { chatModel: vi.fn() },
}));
vi.mock('./openai', () => ({
    openai: vi.fn(),
}));
vi.mock('./model-factory', () => ({
    createModel: vi.fn(),
}));

// Import after mocks are set up
import { createEmbeddingModel } from './embedding-factory';
import { ollama } from './ollama';
import { createBedrockProvider } from './bedrock';
import { tcAILogger } from '../logger';

describe('embedding-factory — createEmbeddingModel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // VAL-FOUND-029: routes TC-Ollama to ollama.embedding
    describe('TC-Ollama routing', () => {
        it('calls ollama.embedding with the model id', () => {
            const mockModel = { modelId: 'nomic-embed-text', doEmbed: vi.fn() };
            vi.mocked(ollama.embedding).mockReturnValue(mockModel as any);

            const result = createEmbeddingModel('TC-Ollama', 'nomic-embed-text');

            expect(ollama.embedding).toHaveBeenCalledWith('nomic-embed-text');
            expect(result).toBe(mockModel);
        });

        it('returns an object usable with embed/embedMany (has doEmbed)', () => {
            const mockModel = { modelId: 'nomic-embed-text', doEmbed: vi.fn() };
            vi.mocked(ollama.embedding).mockReturnValue(mockModel as any);

            const result = createEmbeddingModel('TC-Ollama', 'nomic-embed-text');

            expect(result).toBeDefined();
            expect(typeof (result as any).doEmbed).toBe('function');
        });
    });

    // VAL-FOUND-030: routes AWSBedrock to createBedrockProvider().embedding()
    describe('AWSBedrock routing', () => {
        it('calls createBedrockProvider().embedding with the model id', () => {
            const mockEmbedding = vi.fn().mockReturnValue({
                modelId: 'amazon.titan-embed-text-v2:0',
                doEmbed: vi.fn(),
            });
            const mockProvider = { embedding: mockEmbedding };
            vi.mocked(createBedrockProvider).mockReturnValue(mockProvider as any);

            const result = createEmbeddingModel(
                'AWSBedrock',
                'amazon.titan-embed-text-v2:0',
            );

            expect(createBedrockProvider).toHaveBeenCalled();
            expect(mockEmbedding).toHaveBeenCalledWith(
                'amazon.titan-embed-text-v2:0',
            );
            expect(result).toBeDefined();
            expect(typeof (result as any).doEmbed).toBe('function');
        });
    });

    // VAL-FOUND-031: throws actionable error for unknown provider
    describe('unknown provider', () => {
        it('throws an error naming the provider and pointing at remediation', () => {
            expect(() => createEmbeddingModel('UnknownProvider', 'any-model')).toThrow(
                /(provider|supported|RAG_EMBEDDING)/i,
            );
        });

        it('error message contains the offending provider name', () => {
            expect(() =>
                createEmbeddingModel('UnknownProvider', 'any-model'),
            ).toThrow(/UnknownProvider/);
        });
    });

    // VAL-FOUND-032: logs via tcAILogger, not console
    describe('logging', () => {
        it('logs via tcAILogger.info with provider and model id', () => {
            vi.mocked(ollama.embedding).mockReturnValue({
                modelId: 'nomic-embed-text',
                doEmbed: vi.fn(),
            } as any);

            createEmbeddingModel('TC-Ollama', 'nomic-embed-text');

            expect(tcAILogger.info).toHaveBeenCalled();
            const logCall = vi.mocked(tcAILogger.info).mock.calls[0][0];
            expect(logCall).toMatch(/TC-Ollama/);
            expect(logCall).toMatch(/nomic-embed-text/);
        });

        it('does not call console.log', () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

            vi.mocked(ollama.embedding).mockReturnValue({
                modelId: 'nomic-embed-text',
                doEmbed: vi.fn(),
            } as any);

            createEmbeddingModel('TC-Ollama', 'nomic-embed-text');

            expect(consoleSpy).not.toHaveBeenCalled();
            consoleSpy.mockRestore();
        });

        it('logs error via tcAILogger.error for unknown provider', () => {
            expect(() =>
                createEmbeddingModel('BadProvider', 'any-model'),
            ).toThrow();

            expect(tcAILogger.error).toHaveBeenCalled();
        });
    });
});

// VAL-FOUND-033: re-exported from src/utils/index.ts
describe('embedding-factory re-export', () => {
    it('is importable from src/utils/index.ts', async () => {
        const mod = await import('../index');
        expect(mod.createEmbeddingModel).toBeDefined();
        expect(typeof mod.createEmbeddingModel).toBe('function');
    });
});
