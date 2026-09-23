import { describe, it, expect } from 'vitest';
import { mapProfileAlignedActivityTracks } from './member-stats-profile-mapper';
import { unwrapStatsHistoryPayload } from './member-stats-track-summary';

/** Subset of live GET /v6/members/disna56/stats (groupId 10). */
const DISNA56_STATS = {
    challenges: 257,
    wins: 138,
    DEVELOP: {
        challenges: 156,
        wins: 90,
        subTracks: [
            { id: 'First2Finish', name: 'First2Finish', challenges: 27, wins: 14 },
            { id: 'Challenge', name: 'Challenge', challenges: 129, wins: 76 },
        ],
    },
    DESIGN: {
        challenges: 42,
        wins: 17,
        subTracks: [
            { id: 'First2Finish', name: 'First2Finish', challenges: 3, wins: 1 },
            { id: 'Challenge', name: 'Challenge', challenges: 39, wins: 16 },
        ],
    },
    DATA_SCIENCE: {
        challenges: 49,
        wins: 27,
        'AI Engineering': {
            challenges: 9,
            wins: 5,
            rank: { rating: 815 },
        },
        First2Finish: { challenges: 1, wins: null },
        AI: { challenges: 4, wins: 1, rank: { rating: 840 } },
        Challenge: { challenges: 5, wins: 2 },
        MARATHON_MATCH: { challenges: 30, wins: 19 },
    },
    QA: {
        challenges: 10,
        wins: 4,
        subTracks: [
            { id: 'First2Finish', name: 'First2Finish', challenges: 2, wins: 2 },
            { id: 'Challenge', name: 'Challenge', challenges: 8, wins: 2 },
        ],
    },
} as const;

describe('mapProfileAlignedActivityTracks', () => {
    it('matches profile Data Science (Challenge + Marathon only, not parent DATA_SCIENCE total)', () => {
        const tracks = mapProfileAlignedActivityTracks(DISNA56_STATS as Record<string, unknown>);
        expect(tracks['Data Science']).toEqual(
            expect.objectContaining({ challenges: 35, wins: 21 }),
        );
        expect(tracks['Data Science']!.subTracks.map((s) => s.name).sort()).toEqual([
            'Challenge',
            'MARATHON_MATCH',
        ]);
    });

    it('does not expose AI Engineering as a separate track (folded into Development on profile)', () => {
        const tracks = mapProfileAlignedActivityTracks(DISNA56_STATS as Record<string, unknown>);
        expect(tracks['AI Engineering']).toBeUndefined();
        expect(tracks.AI).toBeUndefined();
    });

    it('uses raw DEVELOP subtrack sums without history', () => {
        const tracks = mapProfileAlignedActivityTracks(DISNA56_STATS as Record<string, unknown>);
        expect(tracks.Development).toEqual(
            expect.objectContaining({ challenges: 160, wins: 91 }),
        );
    });

    it('maps QA into Testing alongside develop testing subtracks', () => {
        const tracks = mapProfileAlignedActivityTracks(DISNA56_STATS as Record<string, unknown>);
        expect(tracks.Testing).toEqual(expect.objectContaining({ challenges: 10, wins: 4 }));
    });
});

const liveIt = process.env.RUN_LIVE_MEMBER_STATS_TESTS === '1' ? it : it.skip;

describe('mapProfileAlignedActivityTracks — live disna56', () => {
    liveIt('matches profile Development 159 / 95 wins with stats history', async () => {
        const base = process.env.TC_API_BASE ?? 'https://api.topcoder-dev.com';
        const [statsRes, historyRes] = await Promise.all([
            fetch(`${base}/v6/members/disna56/stats`),
            fetch(`${base}/v6/members/disna56/stats/history`),
        ]);
        expect(statsRes.ok).toBe(true);
        expect(historyRes.ok).toBe(true);
        const statsArr = (await statsRes.json()) as unknown[];
        const stats = statsArr[0] as Record<string, unknown>;
        const history = unwrapStatsHistoryPayload(await historyRes.json());
        const tracks = mapProfileAlignedActivityTracks(stats, history);
        expect(tracks.Development).toEqual(
            expect.objectContaining({ challenges: 159, wins: 95 }),
        );
    }, 30_000);
});
