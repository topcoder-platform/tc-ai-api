import { describe, it, expect } from 'vitest';
import { getTrackSummaryStats, type SubTrackWithMeta } from './member-stats-track-summary';

describe('getTrackSummaryStats', () => {
    it('de-duplicates overlapping challenge history across subtracks', () => {
        const subTracks: SubTrackWithMeta[] = [
            {
                id: 'Challenge',
                name: 'Challenge',
                challenges: 2,
                wins: 1,
                parentTrack: 'DEVELOP',
                path: 'DEVELOP.subTracks',
            },
            {
                id: 'AI Engineering',
                name: 'AI Engineering',
                challenges: 2,
                wins: 1,
                parentTrack: 'DATA_SCIENCE',
                path: 'DATA_SCIENCE',
            },
        ];
        const statsHistory = {
            DEVELOP: {
                subTracks: [
                    {
                        name: 'Challenge',
                        history: [
                            { challengeId: 'a', challengeName: 'A', placement: 1, ratingDate: '2024-01-01' },
                            { challengeId: 'b', challengeName: 'B', placement: 2, ratingDate: '2024-01-02' },
                        ],
                    },
                ],
            },
            DATA_SCIENCE: {
                'AI Engineering': {
                    history: [
                        { challengeId: 'a', challengeName: 'A', placement: 1, ratingDate: '2024-01-01' },
                        { challengeId: 'c', challengeName: 'C', placement: 1, ratingDate: '2024-01-03' },
                    ],
                },
            },
        };

        const totals = getTrackSummaryStats(subTracks, statsHistory);
        expect(totals.challenges).toBe(3);
        expect(totals.wins).toBe(2);
    });
});
