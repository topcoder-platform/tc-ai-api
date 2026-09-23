/**
 * Profile Development track totals — ports platform-ui getTrackSummaryStats /
 * getSubTrackSummaryStats / getTrackHistoryFromStats (useFetchActiveTracks, useTrackHistory).
 */
export interface SubTrackWithMeta {
    id: string;
    name: string;
    challenges: number;
    wins?: number;
    mostRecentSubmission?: string;
    mostRecentEventDate?: string;
    submissions?: Record<string, number>;
    rank?: Record<string, number>;
    parentTrack?: string;
    path?: string;
}

export interface StatsHistoryRow {
    challengeId?: string | number;
    challengeName?: string;
    placement?: number;
    ratingDate?: string;
    date?: string;
}

export type StatsHistoryPayload = Record<string, unknown>;

const AI_ENGINEERING_HISTORY_NAMES = [
    'AI Engineering',
    'AI',
    'AI_ENGINEER',
    'AI_ENGINEERING',
];

const AI_ENGINEERING_TRACK_TOKENS = new Set(['AI', 'AI_ENGINEER', 'AI_ENGINEERING']);

const AI_ENGINEERING_HISTORY_PATHS = [
    'DATA_SCIENCE',
    'DEVELOP.subTracks',
    'AI_ENGINEERING',
    'AI',
    'AI_ENGINEER',
];

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeTrackToken(value?: string): string {
    return value?.trim().toUpperCase().replace(/[\s-]+/g, '_') ?? '';
}

function getAtPath(obj: unknown, path: string): unknown {
    let cur: unknown = obj;
    for (const segment of path.split('.')) {
        if (cur == null || typeof cur !== 'object') {
            return undefined;
        }
        cur = (cur as Record<string, unknown>)[segment];
    }
    return cur;
}

function getNonEmptyHistory(history: unknown): StatsHistoryRow[] | undefined {
    return Array.isArray(history) && history.length > 0 ? (history as StatsHistoryRow[]) : undefined;
}

function getFirstMatchingHistory(
    statsHistory: StatsHistoryPayload | undefined,
    paths: string[],
    trackNames: string[],
): StatsHistoryRow[] | undefined {
    if (!statsHistory) {
        return undefined;
    }
    for (const path of paths) {
        const subTracks = getAtPath(statsHistory, path);
        if (Array.isArray(subTracks)) {
            for (const subTrack of subTracks as { name?: string; history?: StatsHistoryRow[] }[]) {
                if (subTrack.name && trackNames.includes(subTrack.name)) {
                    const history = getNonEmptyHistory(subTrack.history);
                    if (history) {
                        return history;
                    }
                }
            }
        }
        for (const trackName of trackNames) {
            const history = getNonEmptyHistory(getAtPath(statsHistory, `${path}.${trackName}.history`));
            if (history) {
                return history;
            }
        }
    }
    return undefined;
}

function isAIEngineeringTrackData(trackData: SubTrackWithMeta): boolean {
    return (
        AI_ENGINEERING_TRACK_TOKENS.has(normalizeTrackToken(trackData.name))
        || AI_ENGINEERING_TRACK_TOKENS.has(normalizeTrackToken(trackData.parentTrack))
    );
}

export function getTrackHistoryFromStats(
    statsHistory: StatsHistoryPayload | undefined,
    trackData: SubTrackWithMeta,
): StatsHistoryRow[] {
    if (!statsHistory) {
        return [];
    }
    const defaultHistory =
        getFirstMatchingHistory(statsHistory, [trackData.path ?? ''], [trackData.name]) ?? [];
    if (defaultHistory.length > 0 || !isAIEngineeringTrackData(trackData)) {
        return defaultHistory;
    }
    const paths = [trackData.path, ...AI_ENGINEERING_HISTORY_PATHS].filter(
        (path): path is string => !!path,
    );
    return getFirstMatchingHistory(statsHistory, paths, AI_ENGINEERING_HISTORY_NAMES) ?? [];
}

function getSubTrackSubmissionCount(subTrack: SubTrackWithMeta): number | undefined {
    const raw = subTrack.submissions?.submissions ?? subTrack.submissions;
    return typeof raw === 'number' ? raw : undefined;
}

function getSubTrackDisplaySubmissionCount(subTrack: SubTrackWithMeta): number | undefined {
    const submissionCount = getSubTrackSubmissionCount(subTrack);
    if (submissionCount !== undefined && submissionCount > 0) {
        return submissionCount;
    }
    const challengeCount = finiteNumber(subTrack.challenges);
    return challengeCount !== undefined && challengeCount > 0 ? challengeCount : submissionCount;
}

function getSubTrackSummaryStats(
    subTrack: SubTrackWithMeta,
    trackHistory: StatsHistoryRow[],
): { submissions: number; wins: number } {
    const aggregateWins = finiteNumber(subTrack.wins);
    const statWins = aggregateWins ?? 0;
    const historyWithPlacements = trackHistory.filter((h) => finiteNumber(h.placement) !== undefined);
    const historyWins = historyWithPlacements.filter((h) => h.placement === 1).length;
    const displaySubmissions = getSubTrackDisplaySubmissionCount(subTrack) ?? 0;
    const historySubmissions = trackHistory.length;
    const hasAuthoritativeAggregateWins =
        subTrack.name === 'MARATHON_MATCH' && aggregateWins !== undefined;

    return {
        submissions: Math.max(displaySubmissions, historySubmissions),
        wins:
            historyWithPlacements.length > 0 && !hasAuthoritativeAggregateWins ? historyWins : statWins,
    };
}

function getHistoryChallengeKey(history: StatsHistoryRow): string {
    return [history.challengeId, history.challengeName, history.ratingDate ?? history.date]
        .map((value) => String(value ?? ''))
        .join('::');
}

interface SubTrackHistorySummary {
    history: StatsHistoryRow[];
    stats: { submissions: number; wins: number };
    subTrack: SubTrackWithMeta;
}

function getSubTrackDisplayChallengeCount(subTrack: SubTrackWithMeta): number {
    return finiteNumber(subTrack.challenges) ?? 0;
}

function hasPlacementHistory(summary: SubTrackHistorySummary): boolean {
    return summary.history.some((h) => finiteNumber(h.placement) !== undefined);
}

function sumBy<T>(items: T[], fn: (item: T) => number): number {
    return items.reduce((acc, item) => acc + fn(item), 0);
}

function getSubTrackHistorySummaries(
    subTracks: SubTrackWithMeta[],
    statsHistory?: StatsHistoryPayload,
): SubTrackHistorySummary[] {
    return subTracks.map((subTrack) => {
        const history = statsHistory ? getTrackHistoryFromStats(statsHistory, subTrack) : [];
        return {
            history,
            stats: getSubTrackSummaryStats(subTrack, history),
            subTrack,
        };
    });
}

function getFallbackTrackSummaryStats(summaries: SubTrackHistorySummary[]): {
    challenges: number;
    submissions: number;
    wins: number;
} {
    return {
        challenges: sumBy(summaries, (s) => getSubTrackDisplayChallengeCount(s.subTrack)),
        submissions: sumBy(summaries, (s) => s.stats.submissions),
        wins: sumBy(summaries, (s) => s.stats.wins),
    };
}

/**
 * Parent track totals with history de-duplication (profile Development card).
 */
export function getTrackSummaryStats(
    subTracks: SubTrackWithMeta[],
    statsHistory?: StatsHistoryPayload,
): { challenges: number; wins: number } {
    const summaries = getSubTrackHistorySummaries(subTracks, statsHistory);

    if (!statsHistory) {
        const fallback = getFallbackTrackSummaryStats(summaries);
        return { challenges: fallback.challenges, wins: fallback.wins };
    }

    const historySummaries = summaries.filter((s) => s.history.length > 0);
    if (historySummaries.length === 0) {
        const fallback = getFallbackTrackSummaryStats(summaries);
        return { challenges: fallback.challenges, wins: fallback.wins };
    }

    const uniqueHistoryByChallenge = new Map<string, StatsHistoryRow>();
    let hasDuplicateHistory = false;

    historySummaries.forEach((summary) => {
        summary.history.forEach((history) => {
            const key = getHistoryChallengeKey(history);
            const existingHistory = uniqueHistoryByChallenge.get(key);
            if (existingHistory) {
                hasDuplicateHistory = true;
            }
            if (!existingHistory || existingHistory.placement !== 1) {
                uniqueHistoryByChallenge.set(key, history);
            }
        });
    });

    const uniqueHistory = Array.from(uniqueHistoryByChallenge.values());
    const noHistorySummaryStats = getFallbackTrackSummaryStats(
        summaries.filter((s) => s.history.length === 0),
    );
    const historyChallengeExtras = sumBy(historySummaries, (summary) =>
        Math.max(0, getSubTrackDisplayChallengeCount(summary.subTrack) - summary.history.length),
    );
    const placementHistorySummaries = historySummaries.filter(hasPlacementHistory);
    const uniqueHistoryWins = uniqueHistory.filter((h) => h.placement === 1).length;
    const historyStatsWins = hasDuplicateHistory
        ? Math.max(0, ...placementHistorySummaries.map((s) => s.stats.wins))
        : sumBy(placementHistorySummaries, (s) => s.stats.wins);
    const statsOnlyHistoryWins = sumBy(
        historySummaries.filter((s) => !hasPlacementHistory(s)),
        (s) => s.stats.wins,
    );

    const wins =
        (uniqueHistoryWins > 0 ? uniqueHistoryWins : historyStatsWins)
        + statsOnlyHistoryWins
        + noHistorySummaryStats.wins;

    return {
        challenges:
            uniqueHistory.length + historyChallengeExtras + noHistorySummaryStats.challenges,
        wins,
    };
}

/** GET /stats/history returns the same array envelope as /stats. */
export function unwrapStatsHistoryPayload(history: unknown): StatsHistoryPayload {
    if (Array.isArray(history)) {
        if (history.length === 0) {
            return {};
        }
        const row = history[0];
        if (row && typeof row === 'object') {
            return row as StatsHistoryPayload;
        }
        return {};
    }
    if (history && typeof history === 'object') {
        return history as StatsHistoryPayload;
    }
    return {};
}
