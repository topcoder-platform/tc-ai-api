/**
 * Role/scope-based access control policy model and code-level defaults.
 * See docs/adr/0004-role-based-access-for-agents-workflows-tools.md.
 *
 * Policies are keyed on the resource's OWN `.id` (the value passed to
 * `new Agent({ id })` / `createWorkflow({ id })` / `createTool({ id })`) —
 * NOT the object-property name it happens to be registered under in
 * src/mastra/index.ts. Mastra's getAgentById/getWorkflowById resolve by `.id`
 * first, and 9 of the 10 registrations in this repo differ from their key.
 * A policy keyed on the wrong one silently never matches.
 */

export type AccessPolicy =
    /** Any authenticated caller. */
    | { mode: 'public' }
    /** Nobody, regardless of role/scope. */
    | { mode: 'deny' }
    /**
     * Member callers are checked against `roles` only, M2M callers against
     * `scopes` only. A policy configuring only one dimension implicitly
     * denies the other credential type.
     */
    | { mode: 'restricted'; roles?: string[]; scopes?: string[] };

/**
 * `route` covers this repo's own custom API routes (registerApiRoute entries
 * that are neither an agent nor a workflow), keyed on a stable slug rather
 * than a resource id — see ROUTE_PATH_TARGETS in ../utils/auth/access-control.
 */
export type AccessCategory = 'agent' | 'workflow' | 'tool' | 'route';

/**
 * Code-level defaults, mirroring TOOL_M2M_FALLBACK_CONFIG's convention:
 * a target id absent here falls through to ACCESS_CONTROL_DEFAULT_POLICY
 * (public unless overridden). Flipping an existing entry, or adding a new
 * `deny`/`restricted` entry, is a reviewable privilege decision.
 *
 * Env vars (ACCESS_POLICY_<CATEGORY>_<TARGET_KEY>_MODE/_ROLES/_SCOPES) take
 * precedence over anything here — see resolveAccessPolicy().
 */
export const DEFAULT_ACCESS_POLICIES: Record<AccessCategory, Record<string, AccessPolicy>> = {
    agent: {},
    workflow: {
        // Both rewrite the shared vector index — restricted out of the box so a
        // fresh deploy is safe before any operator sets an env var.
        'challenge-ingestion': {
            mode: 'restricted',
            roles: ['administrator'],
            scopes: ['challengesRAG:admin'],
        },
        'challenge-bulk-ingestion': {
            mode: 'restricted',
            roles: ['administrator'],
            scopes: ['challengesRAG:admin'],
        },
    },
    tool: {},
    route: {
        // The RAG index admin API (list/delete indexed challenges) mutates the
        // same shared vector index as the ingestion workflows above, so it
        // ships behind the same credential requirements.
        'rag-challenges': {
            mode: 'restricted',
            roles: ['administrator'],
            scopes: ['challengesRAG:admin'],
        },
    },
};

/**
 * Registry key -> canonical `.id`, per category.
 *
 * Mastra's getAgentById/getWorkflowById resolve by `.id` FIRST and then fall
 * back to the object-property name a resource is registered under in
 * src/mastra/index.ts, so BOTH spellings address the same resource over HTTP:
 *
 *   POST /v6/ai/workflows/challenge-ingestion/start        <- .id
 *   POST /v6/ai/workflows/challengeIngestionWorkflow/start <- registry key
 *
 * Policies are keyed on `.id`, so without this map the second spelling
 * resolves to "no policy configured" and silently defaults to public — i.e.
 * any restriction is bypassable by spelling the target the other way. This is
 * not hypothetical: platform-ui's RAG_CHALLENGE_INGESTION_WORKFLOW_ID default
 * was the registry key. resolveAccessPolicy() canonicalises through this map
 * before looking anything up.
 *
 * Every registration whose key differs from its `.id` MUST appear here; the
 * unit tests assert both spellings resolve identically.
 */
export const TARGET_ID_ALIASES: Record<AccessCategory, Record<string, string>> = {
    agent: {
        challengeParserAgent: 'challenge-parser-agent',
        challengeSearchAgent: 'challenge-search-agent',
        jdRewriterAgent: 'jd-rewriter-agent',
        // skillsMatchingAgent's key and .id already match.
    },
    workflow: {
        challengeBulkIngestionWorkflow: 'challenge-bulk-ingestion',
        challengeContextWorkflow: 'challenge-context',
        challengeIngestionWorkflow: 'challenge-ingestion',
        challengeSearchWorkflow: 'challenge-search',
        jdAutowriteWorkflow: 'jd-autowrite',
        skillExtractionWorkflow: 'skill-extraction-workflow',
    },
    // Tools are never addressed by URL — they're invoked in-process by `.id`.
    tool: {},
    // Route slugs are assigned by this repo, so there is no second spelling.
    route: {},
};

/** Resolves a registry key to the canonical `.id` a policy is keyed on. */
export function canonicalTargetId(category: AccessCategory, targetId: string): string {
    return TARGET_ID_ALIASES[category][targetId] ?? targetId;
}

/**
 * Upper-snake-cases a target's `.id` into the env var fragment used by the
 * per-target override keys.
 *
 * toEnvKey('challenge-bulk-ingestion') === 'CHALLENGE_BULK_INGESTION'
 * toEnvKey('skillsMatchingAgent')      === 'SKILLS_MATCHING_AGENT'
 */
export function toEnvKey(targetId: string): string {
    return targetId
        // camelCase / PascalCase boundaries -> underscore
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        // any run of non-alphanumerics (-, :, ., space, ...) -> single underscore
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toUpperCase();
}
