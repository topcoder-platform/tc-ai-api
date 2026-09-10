/**
 * RAG index administration — read/delete over what challenge_embeddings holds.
 *
 * The ingestion path writes one row per chunk; an operator thinks in terms of
 * challenges. Everything here therefore aggregates by `metadata->>'challengeId'`.
 *
 * Retrieval goes through PgVector's similarity API, which cannot express
 * "list distinct challenges, filtered and paginated", so these queries run
 * directly on the shared pool (`PgVector.pool`) against the table @mastra/pg
 * creates: (id SERIAL, vector_id TEXT, embedding vector(N), metadata JSONB,
 * namespace VARCHAR). Deletion goes back through `deleteVectors({ filter })`
 * so metadata-filter translation stays in the library.
 */

import { getRagConfig, validateSqlIdentifier } from '../../config/rag.config';
import { tcAILogger } from '../../utils/logger';
import { getChallengeVectorStore } from '../vector/challenge-vector-store';

/** @mastra/pg writes every vector under this namespace unless told otherwise. */
const DEFAULT_NAMESPACE = 'default';

export const DEFAULT_PER_PAGE = 25;
export const MAX_PER_PAGE = 100;

export interface IndexedChallengeRow {
    challengeId: string;
    name: string | null;
    type: string | null;
    track: string | null;
    projectId: string | null;
    /** Number of indexed chunks for this challenge. */
    chunks: number;
    /** ISO-8601, most recent chunk. */
    ingestedAt: string | null;
}

export interface ListIndexedChallengesParams {
    page?: number;
    perPage?: number;
    projectId?: string;
    track?: string;
    type?: string;
    /** Case-insensitive substring match on challenge name or id. */
    search?: string;
}

export interface ListIndexedChallengesResult {
    rows: IndexedChallengeRow[];
    total: number;
    page: number;
    perPage: number;
    totalPages: number;
}

/** Positive integer, or the fallback. Guards NaN and out-of-range input. */
function clampInt(value: number | undefined, fallback: number, max?: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    const floored = Math.floor(value);
    if (floored < 1) return fallback;
    return max !== undefined ? Math.min(floored, max) : floored;
}

/** `"schema"."index_name"` — both validated as SQL identifiers, never bound params. */
function qualifiedTableName(): string {
    const config = getRagConfig();
    const indexName = validateSqlIdentifier(config.vectorIndexName, 'VECTOR_INDEX_NAME');
    return `"${config.database.schemaName}"."${indexName}"`;
}

/**
 * Shared WHERE for both the page query and its count, so the two can never
 * disagree about what is being filtered. Every value is a bound parameter;
 * an absent filter binds NULL and the corresponding clause short-circuits.
 */
const FILTER_SQL = `
        namespace = $1
    AND ($2::text IS NULL OR metadata->>'projectId' = $2)
    AND ($3::text IS NULL OR metadata->>'track' = $3)
    AND ($4::text IS NULL OR metadata->>'type' = $4)
    AND ($5::text IS NULL OR metadata->>'name' ILIKE '%' || $5 || '%'
                          OR metadata->>'challengeId' ILIKE '%' || $5 || '%')`;

function filterValues(params: ListIndexedChallengesParams): (string | null)[] {
    const trimmed = (value: string | undefined): string | null => {
        const next = value?.trim();
        return next ? next : null;
    };

    return [
        DEFAULT_NAMESPACE,
        trimmed(params.projectId),
        trimmed(params.track),
        trimmed(params.type),
        trimmed(params.search),
    ];
}

/**
 * One page of indexed challenges, newest ingestion first.
 *
 * `ingestedAt` is stored as ISO-8601 text, so MAX() orders chronologically
 * without a cast. `MIN()` on the descriptive columns is just "any value from
 * this challenge's chunks" — they are identical across a challenge's chunks,
 * since every chunk is written from the same source record in one run.
 */
export async function listIndexedChallenges(
    params: ListIndexedChallengesParams = {},
): Promise<ListIndexedChallengesResult> {
    const page = clampInt(params.page, 1);
    const perPage = clampInt(params.perPage, DEFAULT_PER_PAGE, MAX_PER_PAGE);
    const tableName = qualifiedTableName();
    const values = filterValues(params);
    const { pool } = getChallengeVectorStore();

    const countResult = await pool.query<{ total: string }>(
        `SELECT COUNT(DISTINCT metadata->>'challengeId')::text AS total
           FROM ${tableName}
          WHERE ${FILTER_SQL}`,
        values,
    );
    const total = Number(countResult.rows[0]?.total ?? 0);

    // Skip the page query entirely when the filter matched nothing.
    if (total === 0) {
        return { rows: [], total: 0, page, perPage, totalPages: 0 };
    }

    const pageResult = await pool.query<{
        challengeId: string;
        name: string | null;
        type: string | null;
        track: string | null;
        projectId: string | null;
        chunks: number;
        ingestedAt: string | null;
    }>(
        `SELECT metadata->>'challengeId'        AS "challengeId",
                MIN(metadata->>'name')          AS name,
                MIN(metadata->>'type')          AS type,
                MIN(metadata->>'track')         AS track,
                MIN(metadata->>'projectId')     AS "projectId",
                COUNT(*)::int                   AS chunks,
                MAX(metadata->>'ingestedAt')    AS "ingestedAt"
           FROM ${tableName}
          WHERE ${FILTER_SQL}
          GROUP BY metadata->>'challengeId'
          ORDER BY MAX(metadata->>'ingestedAt') DESC NULLS LAST,
                   metadata->>'challengeId' ASC
          LIMIT $6 OFFSET $7`,
        [...values, perPage, (page - 1) * perPage],
    );

    return {
        rows: pageResult.rows,
        total,
        page,
        perPage,
        totalPages: Math.ceil(total / perPage),
    };
}

export interface DeleteIndexedChallengeResult {
    challengeId: string;
    deletedChunks: number;
}

/**
 * Removes every chunk of one challenge from the index.
 *
 * Returns null when the challenge holds no vectors, so the caller can 404
 * rather than reporting a successful no-op. The count is taken first because
 * `deleteVectors` resolves to void.
 */
export async function deleteIndexedChallenge(
    challengeId: string,
): Promise<DeleteIndexedChallengeResult | null> {
    const store = getChallengeVectorStore();
    const indexName = getRagConfig().vectorIndexName;

    const countResult = await store.pool.query<{ chunks: string }>(
        `SELECT COUNT(*)::text AS chunks
           FROM ${qualifiedTableName()}
          WHERE namespace = $1 AND metadata->>'challengeId' = $2`,
        [DEFAULT_NAMESPACE, challengeId],
    );
    const deletedChunks = Number(countResult.rows[0]?.chunks ?? 0);

    if (deletedChunks === 0) {
        return null;
    }

    await store.deleteVectors({ indexName, filter: { challengeId } });
    tcAILogger.info('[rag-index-admin] deleted challenge from index', {
        challengeId,
        deletedChunks,
    });

    return { challengeId, deletedChunks };
}
