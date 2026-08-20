/**
 * Shared ingestion utilities: retry, CSV/record validation and deterministic
 * vector id generation.
 *
 * Pure functions plus timer-based sleep — no network, filesystem or console use.
 */

import { createHash } from 'node:crypto';
import type { ChallengeRecord } from './types';

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/** Resolves after the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries an async operation with LINEAR backoff (`delay * attempt`:
 * 1s, 2s, 3s), not exponential.
 *
 * @param fn - Operation to retry
 * @param maxRetries - Total number of attempts (default 3)
 * @param delay - Base delay in ms (default 1000)
 * @throws The error thrown by the final attempt
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    maxRetries = 3,
    delay = 1000,
): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            if (attempt === maxRetries) {
                throw error;
            }
            await sleep(delay * attempt);
        }
    }
    // Unreachable: the loop either returns or throws.
    throw new Error('withRetry: exhausted attempts without a result');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Required CSV columns for ingestion. */
export const REQUIRED_COLUMNS = [
    'id',
    'name',
    'description',
    'descriptionFormat',
    'typeName',
    'trackName',
    'skills',
];

/**
 * Returns the required columns missing from the supplied CSV headers.
 */
export function validateColumns(headers: string[]): string[] {
    return REQUIRED_COLUMNS.filter((col) => !headers.includes(col));
}

/**
 * Validates a challenge record. Only `id`, `name` and `description` are
 * required — `type`, `track`, `descriptionFormat` and `skills` are optional
 * and never rejected (D12).
 *
 * @returns An error message, or null when the record is valid
 */
export function validateRecord(record: ChallengeRecord): string | null {
    if (!record.id?.trim()) return 'Missing id';
    if (!record.name?.trim()) return 'Missing name';
    if (!record.description?.trim()) return 'Empty description';
    return null;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Generates a deterministic, UUID-shaped (8-4-4-4-12) id from a SHA-256 digest
 * of the content, so identical content always maps to the same vector id.
 *
 * @param content - String to hash (e.g. `${challengeId}-${chunkText}`)
 */
export function generateDeterministicId(content: string): string {
    const hash = createHash('sha256').update(content).digest('hex');
    return [
        hash.substring(0, 8),
        hash.substring(8, 12),
        hash.substring(12, 16),
        hash.substring(16, 20),
        hash.substring(20, 32),
    ].join('-');
}
