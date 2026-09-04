/**
 * RAG configuration — resolved lazily (D5).
 *
 * This module NEVER throws at import time. All validation happens inside
 * getRagConfig() on first call. This is critical for server boot and Docker
 * build (pnpm test runs in an image with no network/DB/Ollama).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RagConfig {
    embedding: {
        provider: string;
        modelId: string;
        dimension: number;
        maxContextWindow: number;
    };
    vectorIndexName: string;
    vectorSearchThreshold: number;
    chunkMaxSize: number;
    chunkOverlap: number;
    topK: number;
    challengeSearchAI: {
        provider: string;
        modelId: string;
    };
    database: {
        connectionString: string | undefined;
        schemaName: string;
    };
    /** Informational only — not enforced as enums (D12) */
    knownTypes: string[];
    /** Informational only — not enforced as enums (D12) */
    knownTracks: string[];
}

// ---------------------------------------------------------------------------
// Provider/model → { dimension, maxContextWindow } map (D2)
// ---------------------------------------------------------------------------

const EMBEDDING_MODEL_MAP: Record<string, { dimension: number; maxContextWindow: number }> = {
    'TC-Ollama/nomic-embed-text': { dimension: 768, maxContextWindow: 2048 },
    'AWSBedrock/amazon.titan-embed-text-v2:0': { dimension: 1024, maxContextWindow: 8192 },
};

// ---------------------------------------------------------------------------
// Known values — documented for readability, NOT enforced as enums (D12)
// ---------------------------------------------------------------------------

const KNOWN_TYPES = ['Challenge', 'First2Finish', 'Marathon Match', 'Task'];

const KNOWN_TRACKS = [
    'Design',
    'Data Science',
    'Development',
    'Quality Assurance',
];

// ---------------------------------------------------------------------------
// SQL identifier validation
// ---------------------------------------------------------------------------

const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Guards any env value that ends up interpolated into SQL as an identifier
 * (table or schema name), which cannot be a bound parameter. Exported because
 * the RAG index admin queries interpolate both the index and schema names.
 */
export function validateSqlIdentifier(name: string, envVar: string): string {
    if (!SQL_IDENTIFIER_RE.test(name)) {
        throw new Error(
            `Invalid ${envVar}="${name}": must be a valid SQL identifier ` +
            '(matching ^[A-Za-z_][A-Za-z0-9_]*$). ' +
            `Set ${envVar} to a valid SQL identifier.`,
        );
    }
    return name;
}

// ---------------------------------------------------------------------------
// Numeric env var parsing
// ---------------------------------------------------------------------------

function parseNumber(value: string | undefined, envVar: string, defaultValue: number): number {
    if (value === undefined || value === '') {
        return defaultValue;
    }
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
        throw new Error(
            `Invalid ${envVar}="${value}": must be a number. ` +
            `Set ${envVar} to a valid numeric value.`,
        );
    }
    return parsed;
}

// ---------------------------------------------------------------------------
// getRagConfig — lazy, no module-load throw (D5)
// ---------------------------------------------------------------------------

export function getRagConfig(): RagConfig {
    const embeddingProvider = process.env.RAG_EMBEDDING_PROVIDER || 'TC-Ollama';
    const embeddingModelId = process.env.RAG_EMBEDDING_MODEL_ID || 'nomic-embed-text';

    const mapKey = `${embeddingProvider}/${embeddingModelId}`;
    const modelInfo = EMBEDDING_MODEL_MAP[mapKey];
    if (!modelInfo) {
        throw new Error(
            `Unsupported embedding provider/model combination: ` +
            `RAG_EMBEDDING_PROVIDER="${embeddingProvider}", ` +
            `RAG_EMBEDDING_MODEL_ID="${embeddingModelId}". ` +
            `Supported combinations: ${Object.keys(EMBEDDING_MODEL_MAP).join(', ')}. ` +
            `Set RAG_EMBEDDING_PROVIDER and RAG_EMBEDDING_MODEL_ID to a supported combination.`,
        );
    }

    const vectorIndexName = validateSqlIdentifier(
        process.env.VECTOR_INDEX_NAME || 'challenge_embeddings',
        'VECTOR_INDEX_NAME',
    );

    const vectorSearchThreshold = parseNumber(
        process.env.VECTOR_SEARCH_THRESHOLD,
        'VECTOR_SEARCH_THRESHOLD',
        0.25,
    );

    const chunkMaxSize = parseNumber(
        process.env.RAG_CHUNK_MAX_SIZE,
        'RAG_CHUNK_MAX_SIZE',
        512,
    );

    const chunkOverlap = parseNumber(
        process.env.RAG_CHUNK_OVERLAP,
        'RAG_CHUNK_OVERLAP',
        50,
    );

    const topK = parseNumber(
        process.env.RAG_TOP_K,
        'RAG_TOP_K',
        10,
    );

    const challengeSearchProvider =
        process.env.CHALLENGE_SEARCH_AI_PROVIDER || 'AWSBedrock';
    const challengeSearchModelId =
        process.env.CHALLENGE_SEARCH_AI_MODEL_ID || 'us.anthropic.claude-haiku-4-5';

    const connectionString = process.env.MASTRA_DB_CONNECTION;
    // Validated for the same reason as vectorIndexName: it is interpolated
    // into SQL as an identifier, which cannot be a bound parameter.
    const schemaName = validateSqlIdentifier(
        process.env.MASTRA_DB_SCHEMA || 'ai',
        'MASTRA_DB_SCHEMA',
    );

    return {
        embedding: {
            provider: embeddingProvider,
            modelId: embeddingModelId,
            dimension: modelInfo.dimension,
            maxContextWindow: modelInfo.maxContextWindow,
        },
        vectorIndexName,
        vectorSearchThreshold,
        chunkMaxSize,
        chunkOverlap,
        topK,
        challengeSearchAI: {
            provider: challengeSearchProvider,
            modelId: challengeSearchModelId,
        },
        database: {
            connectionString,
            schemaName,
        },
        knownTypes: KNOWN_TYPES,
        knownTracks: KNOWN_TRACKS,
    };
}
