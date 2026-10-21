/**
 * Role/scope-based access control enforcement for agents, workflows and tools.
 * See docs/adr/0004-role-based-access-for-agents-workflows-tools.md.
 *
 * Two enforcement points, one shared policy core:
 *
 *  - Agents & workflows: `authorizeAccessPolicy` is passed as `authorizeUser`
 *    to the shared CoreAuthProvider in `apiAuthLayer`. Mastra's own
 *    `coreAuthMiddleware` already invokes that hook on every protected request
 *    and 403s when it returns false.
 *  - Tools: `withAccessPolicy` wraps a tool's `execute` at its export site, so
 *    the guard holds however the tool is reached — from an agent, a workflow
 *    step, or Mastra's `POST /tools/:toolId/execute` route (which resolves any
 *    agent-attached tool, ADR 0009 F1). That route is additionally matched by
 *    `authorizeAccessPolicy` for an early 403 at the auth hook (ADR 0009 C1).
 */
import { getWebRequest, type MastraAuthRequest } from '@mastra/core/server';
import {
    canonicalTargetId,
    DEFAULT_ACCESS_POLICIES,
    toEnvKey,
    type AccessCategory,
    type AccessPolicy,
} from '../../config/access-control.config';
import { tcAILogger } from '../logger';
import { API_PREFIX, CHAT_ROUTE_BASE_PATH, RAG_ADMIN_ROUTE_BASE_PATH } from '../server-routes';
import type { Principal } from 'tc-core-library-js';
import { core } from './core';

// ---------------------------------------------------------------------------
// Claim extraction
// ---------------------------------------------------------------------------

/** The service policy view of a shared-core principal; raw claims never determine identity. */
export interface AuthenticatedCaller {
    isM2M: boolean;
    roles: string[];
    scopes: string[];
    principal?: Principal;
}

/**
 * Converts a shared normalized principal into the policy view.
 * @param user Verified caller from Mastra; raw/unknown identities are denied.
 * @returns Roles for members, scopes for services, and the original principal; does not throw.
 */
export function toAuthenticatedCaller(user: Record<string, unknown>): AuthenticatedCaller {
    const isM2M = user.kind === 'service' && user.isMachine === true;
    const isMember = user.kind === 'user' && user.isMachine === false;
    const roles = isMember && Array.isArray(user.roles) ? user.roles.filter((r): r is string => typeof r === 'string') : [];
    const scopes = isM2M && Array.isArray(user.scopes) ? user.scopes.filter((s): s is string => typeof s === 'string') : [];
    return { isM2M, roles, scopes, principal: isM2M || isMember ? user as Principal : undefined };
}

/** Case-insensitive role match — aligns with member-api `hasSensitiveDataRole` and JWT variance. */
export function callerHasRole(roles: string[], role: string): boolean {
    const target = role.toLowerCase();
    return roles.some((r) => r.toLowerCase() === target);
}

export function callerHasAnyRole(roles: string[], allowedRoles: string[]): boolean {
    return allowedRoles.some((role) => callerHasRole(roles, role));
}

// ---------------------------------------------------------------------------
// The shared check
// ---------------------------------------------------------------------------

/**
 * Each credential type is checked against its own dimension only: an M2M
 * caller against `scopes`, a member caller against `roles`. A `restricted`
 * policy configuring only one dimension implicitly denies the other credential
 * type — this is the intended design, not an oversight.
 * @param caller View of the shared verified principal. @param policy Resolved target policy.
 * @returns Allow/deny; service alternatives delegate exact matching to core.hasScopes.
 * @throws Error for malformed required scopes (configuration error).
 */
export function checkAccess(caller: AuthenticatedCaller, policy: AccessPolicy): boolean {
    if (!caller.principal) return false;
    if (policy.mode === 'public') return true;
    if (policy.mode === 'deny') return false;
    if (caller.isM2M) {
        return !!policy.scopes?.length && core.auth.hasScopes(caller.principal, policy.scopes, 'any');
    }
    return (
        !!policy.roles?.length &&
        policy.roles.some((policyRole) => callerHasRole(caller.roles, policyRole))
    );
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
    // A caller can address an agent/workflow by either its `.id` or its
    // registry key; both must resolve to the same policy, or a restriction is
    // bypassable by spelling the target the other way.
    const canonicalId = canonicalTargetId(category, targetId);
    const cacheKey = `${category}:${canonicalId}`;
    const cached = policyCache.get(cacheKey);
    if (cached) return cached;

    const policy =
        envPolicy(category, canonicalId) ??
        DEFAULT_ACCESS_POLICIES[category][canonicalId] ??
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
// GET /tools/:toolId and POST /tools/:toolId/execute (ADR 0009 C1).
// /agents/:agentId/tools/:toolId/execute matches AGENT_PATH_RE first; the
// in-execute guard (withAccessPolicy) covers the tool on that path.
const TOOL_PATH_RE = new RegExp(`^${API_PREFIX}/tools/([^/]+)`);

/**
 * This repo's own custom API routes, which are neither agents nor workflows and
 * so match none of the patterns above. Each entry maps a path prefix to the
 * DEFAULT_ACCESS_POLICIES.route slug that governs it; a custom route absent
 * here falls through to "no target" and stays open to any authenticated caller.
 */
const ROUTE_PATH_TARGETS: { prefix: string; targetId: string }[] = [
    { prefix: `${RAG_ADMIN_ROUTE_BASE_PATH}/challenges`, targetId: 'rag-challenges' },
];

/** null when the path addresses none of the four categories (memory, threads, telemetry, ...). */
function parseTarget(pathname: string): { category: AccessCategory; targetId: string } | null {
    const agent = AGENT_PATH_RE.exec(pathname);
    if (agent) return { category: 'agent', targetId: decodeURIComponent(agent[1]) };

    const workflow = WORKFLOW_PATH_RE.exec(pathname);
    if (workflow) return { category: 'workflow', targetId: decodeURIComponent(workflow[1]) };

    const chat = CHAT_PATH_RE.exec(pathname);
    if (chat) return { category: 'agent', targetId: decodeURIComponent(chat[1]) };

    const tool = TOOL_PATH_RE.exec(pathname);
    if (tool) return { category: 'tool', targetId: decodeURIComponent(tool[1]) };

    const route = ROUTE_PATH_TARGETS.find(
        r => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`),
    );
    if (route) return { category: 'route', targetId: route.targetId };

    return null;
}

/**
 * Passed as `authorizeUser` to the shared CoreAuthProvider in apiAuthLayer.
 * Mastra `.bind(this)`s it onto the provider, so it must never read `this`.
 *
 * Requires normalized identity and unexpired claims; signature/issuer/audience are validated by core.
 * @param user Verified principal. @param request Mastra request containing the URL.
 * @returns Allow/deny; malformed policy settings throw during resolution.
 */
export function authorizeAccessPolicy(
    user: Record<string, unknown> | null | undefined,
    request: MastraAuthRequest,
): boolean {
    if (!user || !toAuthenticatedCaller(user).principal) return false;
    if (typeof user.exp !== 'number' || user.exp * 1000 <= Date.now()) return false;

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
    // Not an agent/workflow/tool/route invocation — out of this ADR's scope, unaffected.
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
    /**
     * Read by Mastra's handleError, so a denial reached over HTTP answers 403
     * instead of 500 (ADR 0009 C2). In-agent behaviour is unchanged.
     */
    readonly status = 403;

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
 * Mastra's reserved RequestContext key for the verified user (`MASTRA_USER_KEY`
 * in @mastra/server, which this repo doesn't depend on directly — and
 * @mastra/core/request-context doesn't export it). Mastra sets it only from the
 * verified token, and mergeRequestContext never copies a `mastra__*` key from a
 * request body — unlike plain `user` (ADR 0009 F4).
 */
export const MASTRA_USER_CONTEXT_KEY = 'mastra__user';

/**
 * The verified caller: the reserved, non-injectable key first (ADR 0009 C3),
 * then `user` for in-process callers (workflow steps, tests) that set only it.
 */
function contextUser(context: ToolExecuteContext | undefined): Record<string, unknown> | undefined {
    const requestContext = context?.requestContext;
    return (requestContext?.get(MASTRA_USER_CONTEXT_KEY) ?? requestContext?.get('user')) as
        | Record<string, unknown>
        | undefined;
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

            const user = contextUser(context);
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
