/**
 * Unit tests for the RAG index admin queries.
 *
 * The pool is stubbed, so these assert the contract that matters at this
 * boundary: which SQL runs, which values are bound, how pagination maths and
 * empty results are handled, and that deletion goes through the library's
 * filter API rather than raw SQL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    query: vi.fn(),
    deleteVectors: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../vector/challenge-vector-store', () => ({
    getChallengeVectorStore: () => ({
        pool: { query: mocks.query },
        deleteVectors: mocks.deleteVectors,
    }),
}));

vi.mock('../../utils/logger', () => ({ tcAILogger: mocks.logger }));

import {
    DEFAULT_PER_PAGE,
    deleteIndexedChallenge,
    listIndexedChallenges,
    MAX_PER_PAGE,
} from './index-admin';

/** Queues the count response, then the page response. */
function stubQueries(total: number, rows: unknown[] = []): void {
    mocks.query.mockReset();
    mocks.query
        .mockResolvedValueOnce({ rows: [{ total: String(total) }] })
        .mockResolvedValueOnce({ rows });
}

const countCall = (): [string, unknown[]] => mocks.query.mock.calls[0] as [string, unknown[]];
const pageCall = (): [string, unknown[]] => mocks.query.mock.calls[1] as [string, unknown[]];

const ROW = {
    challengeId: 'c-1',
    name: 'Real-Time Chat Widget',
    type: 'Challenge',
    track: 'Development',
    projectId: '17423',
    chunks: 9,
    ingestedAt: '2026-08-25T10:00:00.000Z',
};

beforeEach(() => {
    // mockReset, not clearAllMocks: the latter leaves queued
    // mockResolvedValueOnce implementations behind for the next test.
    mocks.query.mockReset();
    mocks.deleteVectors.mockReset();
    mocks.logger.info.mockReset();
    process.env.MASTRA_DB_SCHEMA = 'ai';
    delete process.env.VECTOR_INDEX_NAME;
});

describe('listIndexedChallenges', () => {
    it('aggregates by challengeId and returns pagination metadata', async () => {
        stubQueries(1, [ROW]);

        const result = await listIndexedChallenges({ page: 1, perPage: 25 });

        expect(result).toEqual({
            rows: [ROW],
            total: 1,
            page: 1,
            perPage: 25,
            totalPages: 1,
        });
        expect(pageCall()[0]).toContain("GROUP BY metadata->>'challengeId'");
        expect(pageCall()[0]).toContain('COUNT(*)::int');
    });

    it('scopes both queries to the configured schema and index name', async () => {
        process.env.MASTRA_DB_SCHEMA = 'custom_schema';
        process.env.VECTOR_INDEX_NAME = 'custom_index';
        stubQueries(1, [ROW]);

        await listIndexedChallenges();

        for (const [sql] of [countCall(), pageCall()]) {
            expect(sql).toContain('"custom_schema"."custom_index"');
        }
    });

    it('binds every filter as a parameter, absent filters as null', async () => {
        stubQueries(1, [ROW]);

        await listIndexedChallenges({
            projectId: '17423',
            track: 'Development',
            type: 'Challenge',
            search: 'chat',
        });

        expect(countCall()[1]).toEqual(['default', '17423', 'Development', 'Challenge', 'chat']);
        // Same filter values on both queries, so count and page cannot disagree.
        expect(pageCall()[1].slice(0, 5)).toEqual(countCall()[1]);
    });

    it('treats blank and whitespace-only filters as absent', async () => {
        stubQueries(1, [ROW]);

        await listIndexedChallenges({ projectId: '   ', track: '', search: undefined });

        expect(countCall()[1]).toEqual(['default', null, null, null, null]);
    });

    it('matches search against both name and challenge id', async () => {
        stubQueries(1, [ROW]);

        await listIndexedChallenges({ search: 'chat' });

        expect(pageCall()[0]).toContain("metadata->>'name' ILIKE");
        expect(pageCall()[0]).toContain("metadata->>'challengeId' ILIKE");
    });

    it('converts page/perPage into LIMIT and OFFSET', async () => {
        stubQueries(100, [ROW]);

        const result = await listIndexedChallenges({ page: 3, perPage: 10 });

        expect(pageCall()[1].slice(5)).toEqual([10, 20]);
        expect(result.totalPages).toBe(10);
    });

    it('defaults page and perPage, and rejects nonsense values', async () => {
        for (const params of [{}, { page: 0, perPage: -5 }, { page: NaN, perPage: NaN }]) {
            stubQueries(1, [ROW]);
            const result = await listIndexedChallenges(params);
            expect(result.page).toBe(1);
            expect(result.perPage).toBe(DEFAULT_PER_PAGE);
            expect(pageCall()[1].slice(5)).toEqual([DEFAULT_PER_PAGE, 0]);
        }
    });

    it('caps perPage so one request cannot ask for the whole index', async () => {
        stubQueries(1, [ROW]);

        const result = await listIndexedChallenges({ perPage: 5000 });

        expect(result.perPage).toBe(MAX_PER_PAGE);
        expect(pageCall()[1][5]).toBe(MAX_PER_PAGE);
    });

    it('skips the page query entirely when nothing matches', async () => {
        stubQueries(0);

        const result = await listIndexedChallenges({ search: 'no-such-challenge' });

        expect(result).toEqual({ rows: [], total: 0, page: 1, perPage: DEFAULT_PER_PAGE, totalPages: 0 });
        expect(mocks.query).toHaveBeenCalledTimes(1);
    });

    it('orders by most recent ingestion, with a stable tiebreak', async () => {
        stubQueries(1, [ROW]);

        await listIndexedChallenges();

        expect(pageCall()[0]).toContain("ORDER BY MAX(metadata->>'ingestedAt') DESC NULLS LAST");
        expect(pageCall()[0]).toContain("metadata->>'challengeId' ASC");
    });

    it('propagates an invalid MASTRA_DB_SCHEMA instead of interpolating it', async () => {
        process.env.MASTRA_DB_SCHEMA = 'ai"; DROP TABLE x; --';
        stubQueries(1, [ROW]);

        await expect(listIndexedChallenges()).rejects.toThrow(/Invalid MASTRA_DB_SCHEMA/);
        expect(mocks.query).not.toHaveBeenCalled();
    });
});

describe('deleteIndexedChallenge', () => {
    it('counts the chunks, then deletes them through the library filter API', async () => {
        mocks.query.mockResolvedValueOnce({ rows: [{ chunks: '9' }] });

        const result = await deleteIndexedChallenge('c-1');

        expect(result).toEqual({ challengeId: 'c-1', deletedChunks: 9 });
        expect(mocks.query.mock.calls[0][1]).toEqual(['default', 'c-1']);
        expect(mocks.deleteVectors).toHaveBeenCalledWith({
            indexName: 'challenge_embeddings',
            filter: { challengeId: 'c-1' },
        });
    });

    it('returns null and deletes nothing when the challenge is not indexed', async () => {
        mocks.query.mockResolvedValueOnce({ rows: [{ chunks: '0' }] });

        await expect(deleteIndexedChallenge('missing')).resolves.toBeNull();
        expect(mocks.deleteVectors).not.toHaveBeenCalled();
    });

    it('logs one line per deletion', async () => {
        mocks.query.mockResolvedValueOnce({ rows: [{ chunks: '3' }] });

        await deleteIndexedChallenge('c-2');

        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.stringContaining('deleted challenge from index'),
            { challengeId: 'c-2', deletedChunks: 3 },
        );
    });
});
