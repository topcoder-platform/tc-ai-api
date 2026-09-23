/**
 * Maps raw GET /v6/members/{handle}/stats payloads into the same track breakdown
 * the member profile page uses (platform-ui getActiveTracks).
 */
import {
    getTrackSummaryStats,
    type StatsHistoryPayload,
    type SubTrackWithMeta,
} from './member-stats-track-summary';

export type { SubTrackWithMeta };

export interface ProfileTrackActivity {
    challenges: number;
    wins: number;
    mostRecentSubmission?: string;
    mostRecentEventDate?: string;
    subTracks: SubTrackWithMeta[];
}

const NATIVE_DATA_SCIENCE_KEYS = new Set([
    'Challenge',
    'MARATHON_MATCH',
    'SRM',
    'challenges',
    'wins',
    'mostRecentSubmission',
    'mostRecentEventDate',
    'mostRecentEventName',
]);

const TESTING_SUBTRACK_NAMES = new Set(['BUG_HUNT', 'TEST_SCENARIOS', 'TEST_SUITES']);

const AI_ENGINEERING_DISPLAY_NAME = 'AI Engineering';

const aiEngineeringRatingPathNames = new Set(['AI', 'AI_ENGINEER', 'AI_ENGINEERING']);

function normalizeTrackToken(value?: string): string {
    return value?.trim().toUpperCase().replace(/[\s-]+/g, '_') ?? '';
}

function isAIEngineeringRatingPathName(ratingPathName?: string): boolean {
    return aiEngineeringRatingPathNames.has(normalizeTrackToken(ratingPathName));
}

function isAIEngineeringSubTrackName(name: string): boolean {
    return isAIEngineeringRatingPathName(name) || name === AI_ENGINEERING_DISPLAY_NAME;
}

function toIso(value: unknown): string | undefined {
    if (value == null || value === '') {
        return undefined;
    }
    if (typeof value === 'number') {
        return new Date(value).toISOString();
    }
    if (typeof value === 'string') {
        return value;
    }
    return undefined;
}

function finiteNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    return undefined;
}

function normalizeSubTrack(st: Record<string, unknown>, id?: string, meta?: Partial<SubTrackWithMeta>): SubTrackWithMeta {
    return {
        id: String(st.id ?? id ?? st.name ?? ''),
        name: String(st.name ?? id ?? st.id ?? ''),
        challenges: Number(st.challenges) || 0,
        wins: st.wins == null ? undefined : Number(st.wins) || 0,
        mostRecentSubmission: toIso(st.mostRecentSubmission),
        mostRecentEventDate: toIso(st.mostRecentEventDate),
        submissions: st.submissions as Record<string, number> | undefined,
        rank: st.rank as Record<string, number> | undefined,
        ...meta,
    };
}

function isRatingPathStats(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const row = value as Record<string, unknown>;
    return finiteNumber(row.challenges) !== undefined || finiteNumber(row.wins) !== undefined;
}

function isDataScienceRatingPathStats(statsEntry: unknown): boolean {
    return (
        typeof statsEntry === 'object'
        && statsEntry !== null
        && !Array.isArray(statsEntry)
        && finiteNumber((statsEntry as { rank?: { rating?: number } }).rank?.rating) !== undefined
    );
}

function attachDevelopSubTracks(subTracks: SubTrackWithMeta[]): SubTrackWithMeta[] {
    return subTracks.map((st) => ({
        ...st,
        parentTrack: 'DEVELOP',
        path: 'DEVELOP.subTracks',
    }));
}

function getDataScienceSummarySubTrack(candidates: SubTrackWithMeta[]): SubTrackWithMeta | undefined {
    if (candidates.length === 0) {
        return undefined;
    }
    return [...candidates].sort((a, b) => {
        const ratingA = finiteNumber((a.rank as { rating?: number } | undefined)?.rating) ?? 0;
        const ratingB = finiteNumber((b.rank as { rating?: number } | undefined)?.rating) ?? 0;
        if (ratingB !== ratingA) {
            return ratingB - ratingA;
        }
        return (b.challenges ?? 0) - (a.challenges ?? 0);
    })[0];
}

function buildDataScienceAIEngineeringSubTrack(stats: Record<string, unknown>): SubTrackWithMeta | undefined {
    const dataScienceStats = stats.DATA_SCIENCE as Record<string, unknown> | undefined;
    if (!dataScienceStats) {
        return undefined;
    }
    const candidates: SubTrackWithMeta[] = [];
    for (const [ratingPathName, ratingPathStats] of Object.entries(dataScienceStats)) {
        if (
            NATIVE_DATA_SCIENCE_KEYS.has(ratingPathName)
            || !isAIEngineeringRatingPathName(ratingPathName)
            || !isDataScienceRatingPathStats(ratingPathStats)
        ) {
            continue;
        }
        candidates.push(
            normalizeSubTrack(ratingPathStats as Record<string, unknown>, ratingPathName, {
                name: AI_ENGINEERING_DISPLAY_NAME,
                parentTrack: 'DATA_SCIENCE',
                path: 'DATA_SCIENCE',
            }),
        );
    }
    return getDataScienceSummarySubTrack(candidates);
}

function latestIso(subTracks: SubTrackWithMeta[], field: 'mostRecentSubmission' | 'mostRecentEventDate'): string | undefined {
    let best: string | undefined;
    for (const st of subTracks) {
        const value = st[field];
        if (!value) {
            continue;
        }
        if (!best || Date.parse(value) > Date.parse(best)) {
            best = value;
        }
    }
    return best;
}

function buildDisplayTrackFromSubTracks(
    subTracks: SubTrackWithMeta[],
    statsHistory?: StatsHistoryPayload,
    useHistorySummary = false,
): ProfileTrackActivity | undefined {
    const active = subTracks.filter((st) => st.challenges > 0);
    if (active.length === 0) {
        return undefined;
    }
    const totals = useHistorySummary
        ? getTrackSummaryStats(active, statsHistory)
        : {
              challenges: active.reduce((n, st) => n + st.challenges, 0),
              wins: active.reduce((n, st) => n + (st.wins ?? 0), 0),
          };
    return {
        ...totals,
        mostRecentSubmission: latestIso(active, 'mostRecentSubmission'),
        mostRecentEventDate: latestIso(active, 'mostRecentEventDate'),
        subTracks: active,
    };
}

function mapDevelopSubTracksFromStats(subTracksRaw: unknown): SubTrackWithMeta[] {
    if (!Array.isArray(subTracksRaw)) {
        return [];
    }
    return attachDevelopSubTracks(
        subTracksRaw.map((st) => normalizeSubTrack(st as Record<string, unknown>)),
    );
}

function displayNameForRatingPath(pathName: string): string {
    if (pathName === 'AI' || isAIEngineeringRatingPathName(pathName)) {
        return pathName === 'AI' ? 'AI' : AI_ENGINEERING_DISPLAY_NAME;
    }
    return pathName;
}

/**
 * Builds activity.tracks keys and totals to match members.topcoder.com profile stats cards.
 */
export function mapProfileAlignedActivityTracks(
    stats: Record<string, unknown>,
    statsHistory?: StatsHistoryPayload,
): Record<string, ProfileTrackActivity> {
    const tracks: Record<string, ProfileTrackActivity> = {};

    const developRaw = stats.DEVELOP as Record<string, unknown> | undefined;
    if (developRaw) {
        const developSubTracks = mapDevelopSubTracksFromStats(developRaw.subTracks);
        const forDevelopment = developSubTracks.filter(
            (st) =>
                !TESTING_SUBTRACK_NAMES.has(st.name)
                && !TESTING_SUBTRACK_NAMES.has(st.id)
                && !isAIEngineeringSubTrackName(st.name),
        );
        const forTesting = developSubTracks.filter(
            (st) => TESTING_SUBTRACK_NAMES.has(st.name) || TESTING_SUBTRACK_NAMES.has(st.id),
        );

        const aiEngineeringDevelopmentSubTrack = buildDataScienceAIEngineeringSubTrack(stats);
        const hasDevelopmentAIEngineeringSubTrack = forDevelopment.some((st) =>
            isAIEngineeringSubTrackName(st.name),
        );
        const developmentSubTracks = [
            ...forDevelopment,
            ...(hasDevelopmentAIEngineeringSubTrack || !aiEngineeringDevelopmentSubTrack
                ? []
                : [aiEngineeringDevelopmentSubTrack]),
        ];

        const development = buildDisplayTrackFromSubTracks(
            developmentSubTracks,
            statsHistory,
            true,
        );
        if (development) {
            tracks.Development = development;
        }

        if (forTesting.length > 0) {
            const testingFromDevelop = buildDisplayTrackFromSubTracks(forTesting);
            if (testingFromDevelop) {
                tracks.Testing = testingFromDevelop;
            }
        }
    }

    const designRaw = stats.DESIGN as Record<string, unknown> | undefined;
    if (designRaw && Array.isArray(designRaw.subTracks)) {
        const designSubTracks = (designRaw.subTracks as Record<string, unknown>[]).map((st) =>
            normalizeSubTrack(st, undefined, { parentTrack: 'DESIGN', path: 'DESIGN.subTracks' }),
        );
        const design = buildDisplayTrackFromSubTracks(designSubTracks);
        if (design) {
            tracks.Design = design;
        }
    }

    const qaRaw = stats.QA as Record<string, unknown> | undefined;
    if (qaRaw && Array.isArray(qaRaw.subTracks)) {
        const qaSubTracks = (qaRaw.subTracks as Record<string, unknown>[]).map((st) =>
            normalizeSubTrack(st, undefined, { parentTrack: 'QA', path: 'QA.subTracks' }),
        );
        if (qaSubTracks.length > 0) {
            const existing = tracks.Testing;
            const mergedSubTracks = [...(existing?.subTracks ?? []), ...qaSubTracks];
            const testing = buildDisplayTrackFromSubTracks(mergedSubTracks);
            if (testing) {
                tracks.Testing = testing;
            }
        }
    }

    const dsRaw = stats.DATA_SCIENCE as Record<string, unknown> | undefined;
    if (dsRaw) {
        const challenge = dsRaw.Challenge;
        const marathon = dsRaw.MARATHON_MATCH;
        const srm = dsRaw.SRM;
        const dsSubTracks: SubTrackWithMeta[] = [];
        if (isRatingPathStats(challenge)) {
            dsSubTracks.push(
                normalizeSubTrack(challenge, 'Challenge', {
                    parentTrack: 'DATA_SCIENCE',
                    path: 'DATA_SCIENCE',
                }),
            );
        }
        if (isRatingPathStats(marathon)) {
            dsSubTracks.push(
                normalizeSubTrack(marathon, 'MARATHON_MATCH', {
                    parentTrack: 'DATA_SCIENCE',
                    path: 'DATA_SCIENCE',
                }),
            );
        }
        const dataScience = buildDisplayTrackFromSubTracks(dsSubTracks);
        if (dataScience) {
            tracks['Data Science'] = dataScience;
        }

        if (isRatingPathStats(srm)) {
            const cp = buildDisplayTrackFromSubTracks([
                normalizeSubTrack(srm, 'SRM', { parentTrack: 'DATA_SCIENCE', path: 'DATA_SCIENCE' }),
            ]);
            if (cp) {
                tracks['Competitive Programming'] = cp;
            }
        }

        for (const [pathName, pathStats] of Object.entries(dsRaw)) {
            if (NATIVE_DATA_SCIENCE_KEYS.has(pathName) || !isRatingPathStats(pathStats)) {
                continue;
            }
            if (isAIEngineeringRatingPathName(pathName)) {
                continue;
            }
            const displayName = displayNameForRatingPath(pathName);
            const row = buildDisplayTrackFromSubTracks([
                normalizeSubTrack(pathStats as Record<string, unknown>, pathName, {
                    parentTrack: 'DATA_SCIENCE',
                    path: 'DATA_SCIENCE',
                }),
            ]);
            if (row) {
                tracks[displayName] = row;
            }
        }
    }

    return tracks;
}
