/**
 * Challenge vector store — lazy PgVector singleton with dimension guard (D7).
 *
 * This module NEVER constructs PgVector at import time. The singleton is created
 * on first call to getChallengeVectorStore(), so that missing
 * MASTRA_DB_CONNECTION does not prevent server boot or Docker build (D5).
 *
 * No disconnect() is ever called on request paths — the singleton persists
 * for the lifetime of the process.
 */

import { PgVector } from '@mastra/pg';
import { getRagConfig } from '../../config/rag.config';
import { tcAILogger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// Lazy singleton (created on first call, not at module load)
// ---------------------------------------------------------------------------

let vectorStore: PgVector | null = null;

/**
 * Returns the shared PgVector instance (lazy singleton).
 *
 * The instance is created on first call, not at module load, so that
 * missing MASTRA_DB_CONNECTION does not prevent server boot or Docker build.
 *
 * No disconnect() is ever called on request paths — the singleton persists
 * for the lifetime of the process.
 */
export function getChallengeVectorStore(): PgVector {
    if (vectorStore === null) {
        vectorStore = new PgVector({
            id: 'tc-ai-api-rag-vector',
            connectionString: process.env.MASTRA_DB_CONNECTION!,
            schemaName: process.env.MASTRA_DB_SCHEMA || 'ai',
        });
        tcAILogger.info('[challenge-vector-store] Created PgVector singleton');
    }
    return vectorStore;
}

/**
 * Idempotently ensures the challenge vector index exists with the correct
 * dimension. Enforces the D7 dimension guard: if the index already exists
 * with a different dimension than the configured embedding model, throws
 * an actionable error naming both dimensions and pointing at
 * VECTOR_INDEX_NAME/reindex as remediation.
 *
 * @returns The shared PgVector instance
 */
export async function ensureChallengeIndex(): Promise<PgVector> {
    const config = getRagConfig();
    const store = getChallengeVectorStore();
    const indexName = config.vectorIndexName;
    const configuredDimension = config.embedding.dimension;

    // Check if the index already exists
    let existingDimension: number | null = null;
    try {
        const indexInfo = await store.describeIndex({ indexName });
        if (indexInfo.dimension > 0) {
            existingDimension = indexInfo.dimension;
        }
    } catch {
        // Index/table doesn't exist — describeIndex threw
    }

    if (existingDimension !== null) {
        // Index exists — D7 dimension guard
        if (existingDimension !== configuredDimension) {
            throw new Error(
                `Dimension mismatch: vector index "${indexName}" has ` +
                `dimension ${existingDimension}, but the configured embedding ` +
                `model (${config.embedding.provider}/${config.embedding.modelId}) ` +
                `requires dimension ${configuredDimension}. ` +
                `Set VECTOR_INDEX_NAME to use a new index name, or reindex ` +
                `the existing index to match the configured model dimension.`,
            );
        }
        // Index exists with correct dimension — idempotent, nothing to do
        tcAILogger.info(
            `[challenge-vector-store] Index "${indexName}" already exists ` +
            `with correct dimension ${configuredDimension}`,
        );
        return store;
    }

    // Index doesn't exist — create it with HNSW, cosine, and metadata indexes
    tcAILogger.info(
        `[challenge-vector-store] Creating index "${indexName}" ` +
        `with dimension ${configuredDimension}`,
    );

    await store.createIndex({
        indexName,
        dimension: configuredDimension,
        metric: 'cosine',
        indexConfig: { type: 'hnsw' },
        metadataIndexes: ['challengeId', 'projectId', 'track'],
    });

    return store;
}

// ---------------------------------------------------------------------------
// Testing exports — NOT for production use
// ---------------------------------------------------------------------------

export const _testing = {
    /** Resets the singleton — for unit tests only */
    resetSingleton(): void {
        vectorStore = null;
    },
};
