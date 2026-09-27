import type { IMastraLogger } from '@mastra/core/logger';
import type { RequestContext } from '@mastra/core/request-context';
import { noopObserve } from '@mastra/core/tools';
import { standardizedSkillsFuzzyTool } from './standardized-skills-fuzzy-tool';
import { standardizedSkillsSemanticTool } from './standardized-skills-semantic-tool';

const SKILLS_BASE = `${process.env.TC_API_BASE}/v5/standardized-skills/skills`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FUZZY_SIZE = 20;
const SEMANTIC_AMBIGUOUS_MAX_DISTANCE = 1.0;
const MAX_AMBIGUOUS_CANDIDATES = 5;
const MAX_CONCURRENT_TERMS = 10;

export type SkillResolution =
    | {
          input: string;
          status: 'resolved';
          id: string;
          name: string;
          matchedBy: 'id' | 'exact' | 'alias' | 'semantic';
          minWins?: number;
      }
    | { input: string; status: 'ambiguous'; candidates: { id: string; name: string }[]; minWins?: number }
    | { input: string; status: 'unresolved'; reason: string; minWins?: number };

interface SkillCandidate {
    id: string;
    name: string;
    weighted_distance?: number;
}

export function normalizeSkillKey(text: string): string {
    return text.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function skillNameKeys(name: string): { full: string; fullWithoutParen: string; paren?: string; js?: string } {
    const full = normalizeSkillKey(name);
    const parenMatch = name.match(/\(([^)]+)\)/);
    const paren = parenMatch ? normalizeSkillKey(parenMatch[1]) : undefined;
    const fullWithoutParen = normalizeSkillKey(name.replace(/\([^)]*\)/g, '').trim());
    let js: string | undefined;
    if (full.endsWith('js')) {
        js = full.slice(0, -2);
    }
    return { full, fullWithoutParen, paren, js };
}

/** Lower tier number = stronger match (1 full, 2 paren, 3 js). */
export function getKeyMatchTier(termKey: string, skillName: string): number | null {
    const keys = skillNameKeys(skillName);
    if (keys.full === termKey || keys.fullWithoutParen === termKey) {
        return 1;
    }
    if (keys.paren === termKey) {
        return 2;
    }
    if (keys.js === termKey) {
        return 3;
    }
    return null;
}

export function findBestKeyMatch(
    term: string,
    candidates: SkillCandidate[],
): { candidate: SkillCandidate; tier: number; matchedBy: 'exact' | 'alias' } | null {
    const termKey = normalizeSkillKey(term);
    let best: { candidate: SkillCandidate; tier: number; nameLen: number } | null = null;

    for (const candidate of candidates) {
        const tier = getKeyMatchTier(termKey, candidate.name);
        if (tier === null) {
            continue;
        }
        const nameLen = candidate.name.length;
        if (
            !best ||
            tier < best.tier ||
            (tier === best.tier && nameLen < best.nameLen)
        ) {
            best = { candidate, tier, nameLen };
        }
    }

    if (!best) {
        return null;
    }
    return {
        candidate: best.candidate,
        tier: best.tier,
        matchedBy: best.tier === 1 ? 'exact' : 'alias',
    };
}

function nameContainsWholeWord(name: string, term: string): boolean {
    const trimmed = term.trim();
    if (!trimmed) {
        return false;
    }
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(name);
}

function semanticThreshold(): number {
    return Number(process.env.SKILL_MATCHING_SEMANTIC_THRESHOLD ?? 0.85);
}

async function fetchSkillById(id: string): Promise<{ ok: true; name: string } | { ok: false; status: number }> {
    const response = await fetch(`${SKILLS_BASE}/${id}`);
    if (response.status === 404) {
        return { ok: false, status: 404 };
    }
    if (!response.ok) {
        return { ok: false, status: response.status };
    }
    const data = (await response.json()) as { name?: string };
    return { ok: true, name: data.name ?? id };
}

async function runFuzzy(term: string, requestContext?: RequestContext): Promise<SkillCandidate[]> {
    try {
        const toolResult = await standardizedSkillsFuzzyTool.execute?.(
            { term, size: FUZZY_SIZE },
            { requestContext, observe: noopObserve },
        );
        if (!toolResult || 'error' in toolResult || !toolResult.matches) {
            return [];
        }
        return toolResult.matches;
    } catch {
        return [];
    }
}

async function runSemantic(term: string, requestContext?: RequestContext): Promise<SkillCandidate[]> {
    try {
        const toolResult = await standardizedSkillsSemanticTool.execute?.(
            { text: term },
            { requestContext, observe: noopObserve },
        );
        if (!toolResult || 'error' in toolResult || !toolResult.matches) {
            return [];
        }
        return toolResult.matches.map((m) => ({
            id: m.id,
            name: m.name,
            weighted_distance: m.weighted_distance,
        }));
    } catch {
        return [];
    }
}

function buildAmbiguousCandidates(
    term: string,
    fuzzy: SkillCandidate[],
    semantic: SkillCandidate[],
): { id: string; name: string }[] {
    const seen = new Set<string>();
    const out: { id: string; name: string }[] = [];

    const semanticPlausible = semantic
        .filter((m) => (m.weighted_distance ?? Infinity) <= SEMANTIC_AMBIGUOUS_MAX_DISTANCE)
        .sort((a, b) => (a.weighted_distance ?? 0) - (b.weighted_distance ?? 0));

    for (const m of semanticPlausible) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.push({ id: m.id, name: m.name });
        if (out.length >= MAX_AMBIGUOUS_CANDIDATES) return out;
    }

    for (const m of fuzzy) {
        if (!nameContainsWholeWord(m.name, term)) continue;
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.push({ id: m.id, name: m.name });
        if (out.length >= MAX_AMBIGUOUS_CANDIDATES) return out;
    }

    return out;
}

async function resolveOneSkillTerm(
    skill: string,
    minWins: number | undefined,
    ctx: { requestContext?: RequestContext; logger?: IMastraLogger },
): Promise<SkillResolution> {
    const input = skill.trim();
    const base = { input, minWins };

    if (UUID_RE.test(input)) {
        const lookup = await fetchSkillById(input);
        if (lookup.ok) {
            return { ...base, status: 'resolved', id: input, name: lookup.name, matchedBy: 'id' };
        }
        if (lookup.status === 404) {
            return { ...base, status: 'unresolved', reason: 'No Topcoder skill has this id' };
        }
        ctx.logger?.warn('Skill id lookup failed transiently; proceeding with raw id', {
            id: input,
            status: lookup.status,
        });
        return { ...base, status: 'resolved', id: input, name: input, matchedBy: 'id' };
    }

    const fuzzy = await runFuzzy(input, ctx.requestContext);
    const fuzzyKey = findBestKeyMatch(input, fuzzy);
    if (fuzzyKey) {
        return {
            ...base,
            status: 'resolved',
            id: fuzzyKey.candidate.id,
            name: fuzzyKey.candidate.name,
            matchedBy: fuzzyKey.matchedBy,
        };
    }

    const semantic = await runSemantic(input, ctx.requestContext);
    const semanticKey = findBestKeyMatch(input, semantic);
    if (semanticKey) {
        return {
            ...base,
            status: 'resolved',
            id: semanticKey.candidate.id,
            name: semanticKey.candidate.name,
            matchedBy: semanticKey.matchedBy,
        };
    }

    const threshold = semanticThreshold();
    const semanticSorted = [...semantic].sort(
        (a, b) => (a.weighted_distance ?? Infinity) - (b.weighted_distance ?? Infinity),
    );
    const closest = semanticSorted[0];
    if (closest && (closest.weighted_distance ?? Infinity) <= threshold) {
        return {
            ...base,
            status: 'resolved',
            id: closest.id,
            name: closest.name,
            matchedBy: 'semantic',
        };
    }

    const ambiguousCandidates = buildAmbiguousCandidates(input, fuzzy, semantic);
    if (ambiguousCandidates.length > 0) {
        return { ...base, status: 'ambiguous', candidates: ambiguousCandidates };
    }

    return { ...base, status: 'unresolved', reason: 'No matching Topcoder skill' };
}

export async function resolveSkillTerms(
    items: { skill: string; minWins?: number }[],
    ctx: { requestContext?: RequestContext; logger?: IMastraLogger } = {},
): Promise<SkillResolution[]> {
    if (items.length === 0) {
        return [];
    }

    const results: SkillResolution[] = new Array(items.length);
    let index = 0;

    async function worker() {
        while (index < items.length) {
            const i = index++;
            const item = items[i];
            results[i] = await resolveOneSkillTerm(item.skill, item.minWins, ctx);
        }
    }

    const workers = Array.from({ length: Math.min(MAX_CONCURRENT_TERMS, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

/** Merge resolved skills by id, keeping the larger minWins when duplicated. */
export function dedupeResolvedSkills(
    resolutions: SkillResolution[],
): { id: string; name: string; minWins?: number; resolutions: SkillResolution[] }[] {
    const byId = new Map<string, { id: string; name: string; minWins?: number; resolutions: SkillResolution[] }>();

    for (const r of resolutions) {
        if (r.status !== 'resolved') continue;
        const existing = byId.get(r.id);
        const minWins =
            existing?.minWins !== undefined && r.minWins !== undefined
                ? Math.max(existing.minWins, r.minWins)
                : r.minWins ?? existing?.minWins;
        if (!existing) {
            byId.set(r.id, { id: r.id, name: r.name, minWins, resolutions: [r] });
        } else {
            existing.minWins = minWins;
            existing.resolutions.push(r);
        }
    }
    return [...byId.values()];
}
