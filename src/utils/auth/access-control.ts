/**
 * Role/scope-based access control enforcement for agents, workflows and tools.
 * See docs/adr/0004-role-based-access-for-agents-workflows-tools.md.
 *
 * Two enforcement points, one shared policy core:
 *
 *  - Agents & workflows: `authorizeAccessPolicy` is passed as `authorizeUser`
 *    to both MastraAuthAuth0 providers in `apiAuthLayer`. Mastra's own
 *    `coreAuthMiddleware` already invokes that hook on every protected request
 *    and 403s when it returns false.
 *  - Tools: `withAccessPolicy` wraps a tool's `execute` at its export site.
 *    Tools have no HTTP route of their own, so enforcement uses the `user`
 *    that coreAuthMiddleware/resourceIdMiddleware already put on RequestContext
 *    before any agent or workflow body runs.
 */
import { getWebRequest, type MastraAuthRequest } from '@mastra/core/server';
import {
    DEFAULT_ACCESS_POLICIES,
    toEnvKey,
    type AccessCategory,
    type AccessPolicy,
} from '../../config/access-control.config';
import { tcAILogger } from '../logger';
import { API_PREFIX, CHAT_ROUTE_BASE_PATH } from '../server-routes';
import { resolveTcDomain, tcUserIdClaimKey } from './tc-domain';

// ---------------------------------------------------------------------------
// Claim extraction
// ---------------------------------------------------------------------------

/**
 * JWT claim key carrying the member's role names. Confirmed against a real
 * decoded prod member token: `https://topcoder.com/roles`, a plain string
 * array including "administrator". ACCESS_CONTROL_ROLES_CLAIM overrides it if
 * a tenant ever diverges from the convention.
 */
const rolesClaimKey = (): string =>
    process.env.ACCESS_CONTROL_ROLES_CLAIM || `https://${resolveTcDomain()}/roles`;

export interface AuthenticatedCaller {
    /** M2M tokens don't carry the TC userId claim (mirrors resourceIdMiddleware). */
    isM2M: boolean;
    /** Member role names, [] when absent or not a string array. */
    roles: string[];
    /** OAuth `scope` claim, space-delimited, [] when absent. */
    scopes: string[];
}

export function toAuthenticatedCaller(user: Record<string, unknown>): AuthenticatedCaller {
    const isM2M = !user[tcUserIdClaimKey()];
    const rawRoles = user[rolesClaimKey()];
    const roles = Array.isArray(rawRoles)
        ? rawRoles.filter((r): r is string => typeof r === 'string')
        : [];
    const scopes = typeof user.scope === 'string' ? user.scope.split(' ').filter(Boolean) : [];
    return { isM2M, roles, scopes };
}

// ---------------------------------------------------------------------------
// The shared check
// ---------------------------------------------------------------------------

/**
 * Each credential type is checked against its own dimension only: an M2M
 * caller against `scopes`, a member caller against `roles`. A `restricted`
 * policy configuring only one dimension implicitly denies the other credential
 * type — this is the intended design, not an oversight.
 */
export function checkAccess(caller: AuthenticatedCaller, policy: AccessPolicy): boolean {
    if (policy.mode === 'public') return true;
    if (policy.mode === 'deny') return false;
    if (caller.isM2M) {
        return !!policy.scopes?.length && policy.scopes.some((s) => caller.scopes.includes(s));
    }
    return !!policy.roles?.length && policy.roles.some((r) => caller.roles.includes(r));
}

// ---------------------------------------------------------------------------
// Policy resolution — env override -> code default -> global default
// ---------------------------------------------------------------------------

const policyCache = new Map<string, AccessPolicy>();

/** Test-only: clears the memoised policies after mutating process.env. */
export function _resetAccessPolicyCache(): void {
    policyCache.clear();
}

function parseList(value: string | undefined): string[] | undefined {
    if (value === undefined) return undefined;
    const items = value.split(',').map((v) => v.trim()).filter(Boolean);
    return items.length ? items : [];
}

function parseMode(value: string, envVar: string): 'public' | 'deny' {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'public' || normalized === 'deny') return normalized;
    throw new Error(
        `Invalid ${envVar}="${value}": must be "public" or "deny". ` +
        `Set ${envVar} to a supported mode, or unset it and use the ` +
        `_ROLES/_SCOPES variants for a restricted policy.`,
    );
}

/** Global fallback for any target with no env override and no code default. */
function globalDefaultPolicy(): AccessPolicy {
    const raw = process.env.ACCESS_CONTROL_DEFAULT_POLICY;
    if (!raw) return { mode: 'public' };
    return { mode: parseMode(raw, 'ACCESS_CONTROL_DEFAULT_POLICY') };
}

function envPolicy(category: AccessCategory, targetId: string): AccessPolicy | undefined {
    const prefix = `ACCESS_POLICY_${category.toUpperCase()}_${toEnvKey(targetId)}`;
    const rawMode = process.env[`${prefix}_MODE`];
    const roles = parseList(process.env[`${prefix}_ROLES`]);
    const scopes = parseList(process.env[`${prefix}_SCOPES`]);

    if (rawMode !== undefined && rawMode !== '') {
        return { mode: parseMode(rawMode, `${prefix}_MODE`) };
    }
    if (roles === undefined && scopes === undefined) return undefined;
    return { mode: 'restricted', roles, scopes };
}

/**
 * Resolves the effective policy for a target. Lazy and memoised — this module
 * never throws at import time, mirroring getRagConfig()'s convention. An
 * invalid _MODE throws an actionable error on first resolution.
 */
export function resolveAccessPolicy(category: AccessCategory, targetId: string): AccessPolicy {
    const cacheKey = `${category}:${targetId}`;
    const cached = policyCache.get(cacheKey);
    if (cached) return cached;

    const policy =
        envPolicy(category, targetId) ??
        DEFAULT_ACCESS_POLICIES[category][targetId] ??
        globalDefaultPolicy();

    policyCache.set(cacheKey, policy);
    return policy;
}

// ---------------------------------------------------------------------------
// Enforcement — agents & workflows (Mastra's authorizeUser hook)
// ---------------------------------------------------------------------------

const AGENT_PATH_RE = new RegExp(`^${API_PREFIX}/agents/([^/]+)`);
const WORKFLOW_PATH_RE = new RegExp(`^${API_PREFIX}/workflows/([^/]+)`);
// chatRoute() is CHAT_ROUTE_BASE_PATH/:agentId — an agent by another path.
const CHAT_PATH_RE = new RegExp(`^${CHAT_ROUTE_BASE_PATH}/([^/]+)`);

/** null when the path isn't an agent/workflow invocation (memory, threads, telemetry, ...). */
function parseTarget(pathname: string): { category: AccessCategory; targetId: string } | null {
    const agent = AGENT_PATH_RE.exec(pathname);
    if (agent) return { category: 'agent', targetId: decodeURIComponent(agent[1]) };

    const workflow = WORKFLOW_PATH_RE.exec(pathname);
    if (workflow) return { category: 'workflow', targetId: decodeURIComponent(workflow[1]) };

    const chat = CHAT_PATH_RE.exec(pathname);
    if (chat) return { category: 'agent', targetId: decodeURIComponent(chat[1]) };

    return null;
}

/**
 * Passed as `authorizeUser` to both MastraAuthAuth0 providers in apiAuthLayer.
 * Mastra `.bind(this)`s it onto the provider, so it must never read `this`.
 *
 * Note: supplying `authorizeUser` in the provider options SHADOWS
 * MastraAuthAuth0's own prototype authorizeUser, so its baseline sub/exp
 * checks are re-asserted here rather than lost.
 */
export function authorizeAccessPolicy(
    user: Record<string, unknown> | null | undefined,
    request: MastraAuthRequest,
): boolean {
    // Baseline checks inherited from MastraAuthAuth0.authorizeUser.
    if (!user || !(user.sub || user.id)) return false;
    if (typeof user.exp === 'number' && user.exp * 1000 < Date.now()) return false;

    // authorizeUser receives a MastraAuthRequest (`{ raw, headers, header() }`),
    // NOT a Request — `request.url` is undefined on it. getWebRequest() is
    // Mastra's own helper for recovering the underlying Request.
    const url = getWebRequest(request)?.url;
    if (!url) {
        tcAILogger.warn('[access-control] denied: could not resolve request URL');
        return false;
    }

    let pathname: string;
    try {
        pathname = new URL(url).pathname;
    } catch {
        tcAILogger.warn('[access-control] denied: unparseable request URL', { url });
        return false;
    }

    const target = parseTarget(pathname);
    // Not an agent/workflow invocation — out of this ADR's scope, unaffected.
    if (!target) return true;

    const policy = resolveAccessPolicy(target.category, target.targetId);
    const allowed = checkAccess(toAuthenticatedCaller(user), policy);

    if (!allowed) {
        tcAILogger.warn(
            `[access-control] denied ${target.category} "${target.targetId}"`,
            { category: target.category, targetId: target.targetId, hasUser: true },
        );
    }
    return allowed;
}

// ---------------------------------------------------------------------------
// Enforcement — tools (in-process, via RequestContext)
// ---------------------------------------------------------------------------

export class ToolAccessDeniedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ToolAccessDeniedError';
    }
}

interface ToolLike {
    id: string;
    execute?: (...args: any[]) => any;
}

interface ToolExecuteContext {
    requestContext?: { get(key: string): unknown };
}

/**
 * Wraps a tool's execute with its access policy. Applied at each tool's own
 * export site so the guard travels with the exported tool object — a future
 * agent that imports the tool can't forget to wrap it.
 *
 * The `{...tool, execute}` shallow clone is safe: createTool returns a Tool
 * instance whose fields — including the Symbol.for('mastra.core.tool.Tool')
 * marker — are all own enumerable properties, the class has no prototype
 * methods, and Mastra's isMastraTool() accepts the marker without requiring
 * `instanceof Tool`. The wrapped execute is the instance's own validating
 * wrapper, so input/output/requestContext validation still runs.
 */
export function withAccessPolicy<T extends ToolLike>(tool: T): T {
    const originalExecute = tool.execute;
    if (!originalExecute) return tool;

    return {
        ...tool,
        execute: async (inputData: unknown, context: ToolExecuteContext) => {
            if (process.env.DISABLE_AUTH === 'true') {
                return originalExecute(inputData, context);
            }

            const user = context?.requestContext?.get('user') as
                | Record<string, unknown>
                | undefined;
            const policy = resolveAccessPolicy('tool', tool.id);

            if (!user || !checkAccess(toAuthenticatedCaller(user), policy)) {
                tcAILogger.warn(`[access-control] denied tool "${tool.id}"`, {
                    category: 'tool',
                    targetId: tool.id,
                    hasUser: !!user,
                });
                throw new ToolAccessDeniedError(`Access denied for tool "${tool.id}"`);
            }

            return originalExecute(inputData, context);
        },
    };
}
