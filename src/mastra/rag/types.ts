/**
 * Shared types for the challenge RAG pipeline.
 *
 * Numeric/dimensional types are derived from the lazily-resolved RagConfig
 * (see getRagConfig in src/config/rag.config.ts) so that the two never drift.
 */

import type { RagConfig } from '../../config/rag.config';

// ---------------------------------------------------------------------------
// Challenge classification (D12)
// ---------------------------------------------------------------------------

/**
 * Free-form challenge type. Known values are documented in
 * `getRagConfig().knownTypes` for readability but are never enforced (D12).
 */
export type ChallengeType = string;

/**
 * Free-form challenge track. Known values are documented in
 * `getRagConfig().knownTracks` for readability but are never enforced (D12).
 */
export type ChallengeTrack = string;

// ---------------------------------------------------------------------------
// Source records
// ---------------------------------------------------------------------------

/**
 * A challenge as supplied to the ingestion pipeline — either a CSV row or an
 * inline record. Only `id`, `name` and `description` are required
 * (see validateRecord).
 */
export interface ChallengeRecord {
    id: string;
    name: string;
    description: string;
    descriptionFormat?: string;
    typeName?: ChallengeType;
    trackName?: ChallengeTrack;
    /** Comma-separated in CSV, array when supplied inline */
    skills?: string | string[];
    projectId?: string | number | null;
    groups?: string[];
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/** Chunking parameters, derived from the resolved RagConfig. */
export interface ChunkingOptions {
    maxSize: RagConfig['chunkMaxSize'];
    overlap: RagConfig['chunkOverlap'];
    contextWindow: RagConfig['embedding']['maxContextWindow'];
}

/** A chunk of challenge content. The text field is named `text`, not `content`. */
export interface ChallengeChunk {
    text: string;
    metadata?: Record<string, unknown>;
}

/** Reason an atomic block had to be force-split. */
export type ForceSplitReason = 'code-block' | 'table';

/** Record of an atomic block that exceeded the token limit and was force-split. */
export interface ForceSplitRecord {
    /** Zero-based index of the header-pass chunk that was force-split */
    chunkIndex: number;
    originalTokens: number;
    resultingChunks: number;
    reason: ForceSplitReason;
}

/** Result of chunkChallengeDescription. */
export interface ChunkingResult {
    chunks: ChallengeChunk[];
    forceSplits: ForceSplitRecord[];
}

// ---------------------------------------------------------------------------
// Vector metadata
// ---------------------------------------------------------------------------

/**
 * Metadata stored alongside each vector embedding.
 *
 * `projectId` is a string (or null) because @mastra/pg compares metadata
 * scalars as text — a numeric value would silently fail to match a filter.
 */
export interface ChunkMetadata {
    challengeId: string;
    name: string;
    type: ChallengeType;
    track: ChallengeTrack;
    skills: string[];
    groups: string[];
    projectId: string | null;
    /** 1-based */
    chunkIndex: number;
    totalChunks: number;
    /** Chunk text including the `# Challenge: <name>` header */
    text: string;
    /** ISO-8601 */
    ingestedAt: string;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** A force-split attributed to the challenge record it came from. */
export interface ReportedForceSplit extends ForceSplitRecord {
    recordId: string;
}

/** Structure of the CLI ingestion report (report.json). */
export interface IngestionReport {
    startTime: string;
    endTime: string;
    totals: {
        files: number;
        records: number;
        chunks: number;
        errors: number;
        forceSplits: number;
    };
    files: Record<
        string,
        {
            records: number;
            chunks: number;
            errors: { recordId: string; message: string; stack?: string }[];
            forceSplits: ReportedForceSplit[];
        }
    >;
}

/** CLI options for the ingestion script. */
export interface IngestOptions {
    folder?: string;
    file?: string;
    dryRun: boolean;
    clearAll: boolean;
}
