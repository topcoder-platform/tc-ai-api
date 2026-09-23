import type { RequestContext } from '@mastra/core/request-context';
import { callTcApi } from './tc-api-client';

interface ResourceRole {
    id: string;
    name: string;
}

let cached: Promise<ResourceRole[]> | undefined;

/** Clears the memoized resource-roles promise — test hook only. */
export function resetResourceRolesCacheForTests(): void {
    cached = undefined;
}

/** Fetches GET /v6/resource-roles once per process; concurrent first callers
 * share the same in-flight promise (no duplicate-fetch race). */
function loadResourceRoles(requestContext: RequestContext | undefined): Promise<ResourceRole[]> {
    if (!cached) {
        cached = callTcApi({
            toolId: 'fetch-challenge-resources',
            url: `${process.env.TC_API_BASE}/v6/resource-roles`,
            init: { method: 'GET', signal: AbortSignal.timeout(15_000) },
            requestContext,
        })
            .then(async (res) => {
                if (!res.ok) {
                    throw new Error(`Failed to fetch resource roles (HTTP ${res.status})`);
                }
                return (await res.json()) as ResourceRole[];
            })
            .catch((err) => {
                cached = undefined;
                throw err;
            });
    }
    return cached;
}

/** Resolves a category to its set of role ids, by name, against the live
 * resource-roles list. Throws (not silent-empty) if a configured role name
 * no longer exists upstream — an actionable signal that
 * CHALLENGE_RESOURCE_ROLE_CATEGORIES is stale, not "no matches". */
export async function resolveCategoryRoleIds(
    category: string,
    roleNames: readonly string[],
    requestContext: RequestContext | undefined,
): Promise<Set<string>> {
    const roles = await loadResourceRoles(requestContext);
    const byName = new Map(roles.map((r) => [r.name, r.id]));
    const ids = roleNames.map((name) => {
        const id = byName.get(name);
        if (!id) {
            throw new Error(
                `Resource role "${name}" (category "${category}") not found in /v6/resource-roles — check CHALLENGE_RESOURCE_ROLE_CATEGORIES against the live role list.`,
            );
        }
        return id;
    });
    return new Set(ids);
}
