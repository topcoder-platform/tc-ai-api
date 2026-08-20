import { describe, it, expect, vi } from 'vitest';
import {
    generateDeterministicId,
    REQUIRED_COLUMNS,
    sleep,
    validateColumns,
    validateRecord,
    withRetry,
} from './ingestion-utils';
import type { ChallengeRecord } from './types';

/**
 * Replaces setTimeout with a synchronous stub that records the requested delay,
 * so backoff timings can be asserted without real waiting.
 */
function captureSleepDelays(): number[] {
    const delays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: () => void,
        ms?: number,
    ) => {
        delays.push(ms ?? 0);
        callback();
        return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    return delays;
}

describe('ingestion-utils — sleep', () => {
    it('resolves after the requested delay', async () => {
        const delays = captureSleepDelays();
        await sleep(1234);
        expect(delays).toEqual([1234]);
    });

    it('actually waits when timers are real', async () => {
        const start = Date.now();
        await sleep(10);
        expect(Date.now() - start).toBeGreaterThanOrEqual(5);
    });
});

describe('ingestion-utils — withRetry', () => {
    it('returns the result without sleeping when the first attempt succeeds', async () => {
        const delays = captureSleepDelays();
        const fn = vi.fn().mockResolvedValue('ok');

        await expect(withRetry(fn)).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
        expect(delays).toEqual([]);
    });

    // VAL-INGEST-067 / VAL-FOUND: linear backoff (delay * attempt), not exponential
    it('uses linear backoff delays of delay * attempt', async () => {
        const delays = captureSleepDelays();
        const fn = vi.fn().mockRejectedValue(new Error('boom'));

        await expect(withRetry(fn, 4, 1000)).rejects.toThrow('boom');

        // Linear: 1s, 2s, 3s. Exponential would have produced 1s, 2s, 4s.
        expect(delays).toEqual([1000, 2000, 3000]);
        expect(delays).not.toEqual([1000, 2000, 4000]);
        expect(fn).toHaveBeenCalledTimes(4);
    });

    it('sleeps delay * attempt for the default maxRetries of 3', async () => {
        const delays = captureSleepDelays();
        const fn = vi.fn().mockRejectedValue(new Error('boom'));

        await expect(withRetry(fn)).rejects.toThrow('boom');
        expect(delays).toEqual([1000, 2000]);
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('scales the linear backoff with a custom base delay', async () => {
        const delays = captureSleepDelays();
        const fn = vi.fn().mockRejectedValue(new Error('boom'));

        await expect(withRetry(fn, 4, 250)).rejects.toThrow('boom');
        expect(delays).toEqual([250, 500, 750]);
    });

    it('succeeds on a later attempt after a transient failure', async () => {
        const delays = captureSleepDelays();
        const fn = vi
            .fn()
            .mockRejectedValueOnce(new Error('transient'))
            .mockResolvedValue('recovered');

        await expect(withRetry(fn)).resolves.toBe('recovered');
        expect(fn).toHaveBeenCalledTimes(2);
        expect(delays).toEqual([1000]);
    });

    it('rethrows the error from the final attempt', async () => {
        captureSleepDelays();
        const fn = vi
            .fn()
            .mockRejectedValueOnce(new Error('first'))
            .mockRejectedValueOnce(new Error('second'))
            .mockRejectedValueOnce(new Error('third'));

        await expect(withRetry(fn)).rejects.toThrow('third');
    });

    it('does not retry when maxRetries is 1', async () => {
        const delays = captureSleepDelays();
        const fn = vi.fn().mockRejectedValue(new Error('boom'));

        await expect(withRetry(fn, 1)).rejects.toThrow('boom');
        expect(fn).toHaveBeenCalledTimes(1);
        expect(delays).toEqual([]);
    });
});

describe('ingestion-utils — REQUIRED_COLUMNS / validateColumns', () => {
    it('declares the seven required CSV columns', () => {
        expect(REQUIRED_COLUMNS).toEqual([
            'id',
            'name',
            'description',
            'descriptionFormat',
            'typeName',
            'trackName',
            'skills',
        ]);
    });

    it('returns no missing columns when all required headers are present', () => {
        expect(validateColumns([...REQUIRED_COLUMNS])).toEqual([]);
    });

    it('ignores extra headers', () => {
        expect(validateColumns([...REQUIRED_COLUMNS, 'projectId', 'groups'])).toEqual([]);
    });

    it('reports every missing column', () => {
        expect(validateColumns(['id', 'name', 'description'])).toEqual([
            'descriptionFormat',
            'typeName',
            'trackName',
            'skills',
        ]);
    });

    it('reports all required columns for an empty header list', () => {
        expect(validateColumns([])).toEqual([...REQUIRED_COLUMNS]);
    });
});

describe('ingestion-utils — validateRecord', () => {
    const base: ChallengeRecord = {
        id: 'c-1',
        name: 'Demo challenge',
        description: 'Some description',
    };

    // VAL-INGEST-068: checks only id, name, description
    it('accepts a record carrying only id, name and description', () => {
        expect(validateRecord(base)).toBeNull();
    });

    it('does not reject a record missing descriptionFormat, typeName, trackName or skills', () => {
        const record: ChallengeRecord = { ...base };
        delete record.descriptionFormat;
        delete record.typeName;
        delete record.trackName;
        delete record.skills;
        expect(validateRecord(record)).toBeNull();
    });

    it('rejects a missing id', () => {
        expect(validateRecord({ ...base, id: '' })).toBe('Missing id');
    });

    it('rejects a whitespace-only id', () => {
        expect(validateRecord({ ...base, id: '   ' })).toBe('Missing id');
    });

    it('rejects a missing name', () => {
        expect(validateRecord({ ...base, name: '' })).toBe('Missing name');
    });

    it('rejects an empty description', () => {
        expect(validateRecord({ ...base, description: '' })).toBe('Empty description');
    });

    it('rejects a whitespace-only description', () => {
        expect(validateRecord({ ...base, description: '  \n ' })).toBe('Empty description');
    });

    it('accepts records with unknown type and track values (D12)', () => {
        expect(
            validateRecord({
                ...base,
                typeName: 'Brand New Type',
                trackName: 'Emerging Track',
            }),
        ).toBeNull();
    });
});

describe('ingestion-utils — generateDeterministicId', () => {
    const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    // VAL-INGEST-069: UUID-shaped SHA-256 hash, deterministic
    it('returns a UUID-shaped string', () => {
        expect(generateDeterministicId('challenge-1-chunk text')).toMatch(UUID_SHAPE);
    });

    it('produces identical output for identical input', () => {
        const a = generateDeterministicId('challenge-1-chunk text');
        const b = generateDeterministicId('challenge-1-chunk text');
        expect(a).toBe(b);
    });

    it('produces different output for different input', () => {
        expect(generateDeterministicId('a')).not.toBe(generateDeterministicId('b'));
    });

    it('is a stable SHA-256 digest rendered as 8-4-4-4-12', () => {
        // sha256('abc') = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
        expect(generateDeterministicId('abc')).toBe('ba7816bf-8f01-cfea-4141-40de5dae2223');
    });

    it('handles empty input deterministically', () => {
        expect(generateDeterministicId('')).toMatch(UUID_SHAPE);
        expect(generateDeterministicId('')).toBe(generateDeterministicId(''));
    });

    it('distinguishes the same chunk text across different challenge ids', () => {
        const chunk = '# Challenge: Demo\n\nbody';
        expect(generateDeterministicId(`c-1-${chunk}`)).not.toBe(
            generateDeterministicId(`c-2-${chunk}`),
        );
    });
});
