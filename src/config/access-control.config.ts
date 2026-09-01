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

export type AccessCategory = 'agent' | 'workflow' | 'tool';

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
};

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
