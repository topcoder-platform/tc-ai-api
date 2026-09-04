/**
 * Unit tests for the role/scope access-control layer.
 * See docs/adr/0004-role-based-access-for-agents-workflows-tools.md.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
    canonicalTargetId,
    DEFAULT_ACCESS_POLICIES,
    TARGET_ID_ALIASES,
    toEnvKey,
    type AccessCategory,
    type AccessPolicy,
} from '../../config/access-control.config';
import {
    _resetAccessPolicyCache,
    authorizeAccessPolicy,
    checkAccess,
    resolveAccessPolicy,
    toAuthenticatedCaller,
    ToolAccessDeniedError,
    withAccessPolicy,
} from './access-control';

vi.mock('../logger', () => ({
    tcAILogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const ROLES_CLAIM = 'https://topcoder.com/roles';
const USERID_CLAIM = 'https://topcoder.com/userId';

/** Env keys this suite sets; wiped before and after every test. */
const MANAGED_ENV = [
    'TC_API_BASE',
    'DISABLE_AUTH',
    'ACCESS_CONTROL_DEFAULT_POLICY',
    'ACCESS_CONTROL_ROLES_CLAIM',
];
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const key of Object.keys(process.env)) {
        if (key.startsWith('ACCESS_POLICY_')) delete process.env[key];
    }
    for (const key of MANAGED_ENV) {
        originalEnv[key] = process.env[key];
        delete process.env[key];
    }
    _resetAccessPolicyCache();
});

afterEach(() => {
    for (const key of Object.keys(process.env)) {
        if (key.startsWith('ACCESS_POLICY_')) delete process.env[key];
    }
    for (const key of MANAGED_ENV) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
    _resetAccessPolicyCache();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function memberUser(roles: string[] = []): Record<string, unknown> {
    return { sub: 'auth0|123', [USERID_CLAIM]: '88774433', [ROLES_CLAIM]: roles };
}

function m2mUser(scopes: string[] = []): Record<string, unknown> {
    return { sub: 'client-id@clients', scope: scopes.join(' ') };
}

/**
 * Mirrors what coreAuthMiddleware actually hands authorizeUser:
 * adaptToMastraAuthRequest() returns a HonoRequestLike ({ raw, headers, header }),
 * NOT a Request — so `request.url` is undefined and getWebRequest() is required.
 */
function authRequest(path: string) {
    const raw = new Request(`http://localhost${path}`);
    return { raw, headers: raw.headers, header: (n: string) => raw.headers.get(n) ?? undefined };
}

// ---------------------------------------------------------------------------
// toAuthenticatedCaller
// ---------------------------------------------------------------------------

describe('toAuthenticatedCaller', () => {
    it('reads member roles from the TC roles claim', () => {
        const caller = toAuthenticatedCaller(memberUser(['administrator', 'copilot']));
        expect(caller).toEqual({
            isM2M: false,
            roles: ['administrator', 'copilot'],
            scopes: [],
        });
    });

    it('treats a token without the TC userId claim as M2M and splits the scope claim', () => {
        const caller = toAuthenticatedCaller(m2mUser(['challengesRAG:admin', 'read:challenges']));
        expect(caller).toEqual({
            isM2M: true,
            roles: [],
            scopes: ['challengesRAG:admin', 'read:challenges'],
        });
    });

    it('ignores a non-array roles claim and non-string entries', () => {
        expect(toAuthenticatedCaller({ [USERID_CLAIM]: '1', [ROLES_CLAIM]: 'admin' }).roles).toEqual([]);
        expect(
            toAuthenticatedCaller({ [USERID_CLAIM]: '1', [ROLES_CLAIM]: ['ok', 42, null] }).roles,
        ).toEqual(['ok']);
    });

    it('honours ACCESS_CONTROL_ROLES_CLAIM as an override', () => {
        process.env.ACCESS_CONTROL_ROLES_CLAIM = 'custom/roles';
        const caller = toAuthenticatedCaller({
            [USERID_CLAIM]: '1',
            [ROLES_CLAIM]: ['ignored'],
            'custom/roles': ['administrator'],
        });
        expect(caller.roles).toEqual(['administrator']);
    });

    it('derives the claim domain from TC_API_BASE', () => {
        process.env.TC_API_BASE = 'https://api.topcoder-dev.com';
        const caller = toAuthenticatedCaller({
            'https://topcoder-dev.com/userId': '1',
            'https://topcoder-dev.com/roles': ['administrator'],
        });
        expect(caller).toMatchObject({ isM2M: false, roles: ['administrator'] });
    });
});

// ---------------------------------------------------------------------------
// checkAccess — the truth table
// ---------------------------------------------------------------------------

describe('checkAccess', () => {
    const restricted: AccessPolicy = {
        mode: 'restricted',
        roles: ['administrator'],
        scopes: ['challengesRAG:admin'],
    };

    it('public always allows', () => {
        expect(checkAccess(toAuthenticatedCaller(memberUser()), { mode: 'public' })).toBe(true);
        expect(checkAccess(toAuthenticatedCaller(m2mUser()), { mode: 'public' })).toBe(true);
    });

    it('deny always denies', () => {
        expect(
            checkAccess(toAuthenticatedCaller(memberUser(['administrator'])), { mode: 'deny' }),
        ).toBe(false);
        expect(
            checkAccess(toAuthenticatedCaller(m2mUser(['challengesRAG:admin'])), { mode: 'deny' }),
        ).toBe(false);
    });

    it('restricted allows a member with a matching role', () => {
        expect(
            checkAccess(toAuthenticatedCaller(memberUser(['copilot', 'administrator'])), restricted),
        ).toBe(true);
    });

    it('restricted denies a member without a matching role', () => {
        expect(checkAccess(toAuthenticatedCaller(memberUser(['copilot'])), restricted)).toBe(false);
    });

    it('restricted allows M2M with a matching scope', () => {
        expect(
            checkAccess(toAuthenticatedCaller(m2mUser(['challengesRAG:admin'])), restricted),
        ).toBe(true);
    });

    it('restricted denies M2M without a matching scope', () => {
        expect(checkAccess(toAuthenticatedCaller(m2mUser(['read:challenges'])), restricted)).toBe(
            false,
        );
    });

    it('restricted with only roles configured denies every M2M caller', () => {
        const rolesOnly: AccessPolicy = { mode: 'restricted', roles: ['administrator'] };
        expect(checkAccess(toAuthenticatedCaller(m2mUser(['challengesRAG:admin'])), rolesOnly)).toBe(
            false,
        );
        expect(checkAccess(toAuthenticatedCaller(memberUser(['administrator'])), rolesOnly)).toBe(
            true,
        );
    });

    it('restricted with only scopes configured denies every member caller', () => {
        const scopesOnly: AccessPolicy = { mode: 'restricted', scopes: ['challengesRAG:admin'] };
        expect(checkAccess(toAuthenticatedCaller(memberUser(['administrator'])), scopesOnly)).toBe(
            false,
        );
        expect(checkAccess(toAuthenticatedCaller(m2mUser(['challengesRAG:admin'])), scopesOnly)).toBe(
            true,
        );
    });
});

// ---------------------------------------------------------------------------
// toEnvKey — every id in the resource inventory
// ---------------------------------------------------------------------------

describe('toEnvKey', () => {
    it.each([
        ['challenge-search-agent', 'CHALLENGE_SEARCH_AGENT'],
        ['challenge-parser-agent', 'CHALLENGE_PARSER_AGENT'],
        ['jd-rewriter-agent', 'JD_REWRITER_AGENT'],
        ['skillsMatchingAgent', 'SKILLS_MATCHING_AGENT'],
        ['challenge-ingestion', 'CHALLENGE_INGESTION'],
        ['challenge-bulk-ingestion', 'CHALLENGE_BULK_INGESTION'],
        ['challenge-search', 'CHALLENGE_SEARCH'],
        ['challenge-context', 'CHALLENGE_CONTEXT'],
        ['skill-extraction-workflow', 'SKILL_EXTRACTION_WORKFLOW'],
        ['jd-autowrite', 'JD_AUTOWRITE'],
        ['challenge-vector-query', 'CHALLENGE_VECTOR_QUERY'],
        ['fetch-challenge-by-id', 'FETCH_CHALLENGE_BY_ID'],
        ['fetch-project-by-id', 'FETCH_PROJECT_BY_ID'],
        ['search-challenges', 'SEARCH_CHALLENGES'],
        ['standardized-skills-fuzzy-match', 'STANDARDIZED_SKILLS_FUZZY_MATCH'],
        ['standardized-skills-semantic-search', 'STANDARDIZED_SKILLS_SEMANTIC_SEARCH'],
    ])('maps %s -> %s', (id, expected) => {
        expect(toEnvKey(id)).toBe(expected);
    });
});

// ---------------------------------------------------------------------------
// resolveAccessPolicy
// ---------------------------------------------------------------------------

describe('resolveAccessPolicy', () => {
    it('resolves both ingestion workflows to the baked-in restricted policy with no env set', () => {
        for (const id of ['challenge-ingestion', 'challenge-bulk-ingestion']) {
            expect(resolveAccessPolicy('workflow', id)).toEqual({
                mode: 'restricted',
                roles: ['administrator'],
                scopes: ['challengesRAG:admin'],
            });
        }
    });

    it('defaults an unconfigured target to public', () => {
        expect(resolveAccessPolicy('agent', 'challenge-search-agent')).toEqual({ mode: 'public' });
        expect(resolveAccessPolicy('tool', 'challenge-vector-query')).toEqual({ mode: 'public' });
    });

    it('honours ACCESS_CONTROL_DEFAULT_POLICY=deny as the global default', () => {
        process.env.ACCESS_CONTROL_DEFAULT_POLICY = 'deny';
        expect(resolveAccessPolicy('agent', 'challenge-search-agent')).toEqual({ mode: 'deny' });
        // ...but a code default still beats the global default.
        expect(resolveAccessPolicy('workflow', 'challenge-ingestion').mode).toBe('restricted');
    });

    it('lets an env override beat the code default', () => {
        process.env.ACCESS_POLICY_WORKFLOW_CHALLENGE_INGESTION_MODE = 'public';
        expect(resolveAccessPolicy('workflow', 'challenge-ingestion')).toEqual({ mode: 'public' });
    });

    it('comma-splits and trims _ROLES / _SCOPES', () => {
        process.env.ACCESS_POLICY_WORKFLOW_CHALLENGE_SEARCH_ROLES = ' administrator , copilot ';
        process.env.ACCESS_POLICY_WORKFLOW_CHALLENGE_SEARCH_SCOPES = 'a:b, c:d';
        expect(resolveAccessPolicy('workflow', 'challenge-search')).toEqual({
            mode: 'restricted',
            roles: ['administrator', 'copilot'],
            scopes: ['a:b', 'c:d'],
        });
    });

    it('throws an actionable error on an invalid _MODE', () => {
        process.env.ACCESS_POLICY_TOOL_SEARCH_CHALLENGES_MODE = 'restricted';
        expect(() => resolveAccessPolicy('tool', 'search-challenges')).toThrow(
            /ACCESS_POLICY_TOOL_SEARCH_CHALLENGES_MODE/,
        );
    });

    it('throws on an invalid ACCESS_CONTROL_DEFAULT_POLICY', () => {
        process.env.ACCESS_CONTROL_DEFAULT_POLICY = 'open';
        expect(() => resolveAccessPolicy('agent', 'jd-rewriter-agent')).toThrow(
            /ACCESS_CONTROL_DEFAULT_POLICY/,
        );
    });
});

// ---------------------------------------------------------------------------
// authorizeAccessPolicy — the HTTP boundary
// ---------------------------------------------------------------------------

describe('authorizeAccessPolicy', () => {
    const INGEST = '/v6/ai/workflows/challenge-ingestion/start-async';

    it('denies a member lacking the administrator role', () => {
        expect(authorizeAccessPolicy(memberUser(['copilot']), authRequest(INGEST))).toBe(false);
    });

    it('allows a member with the administrator role', () => {
        expect(authorizeAccessPolicy(memberUser(['administrator']), authRequest(INGEST))).toBe(true);
    });

    it('denies M2M lacking challengesRAG:admin', () => {
        expect(authorizeAccessPolicy(m2mUser(['read:challenges']), authRequest(INGEST))).toBe(false);
    });

    it('allows M2M with challengesRAG:admin', () => {
        expect(authorizeAccessPolicy(m2mUser(['challengesRAG:admin']), authRequest(INGEST))).toBe(
            true,
        );
    });

    it('allows an agent path with no configured policy, regardless of role/scope', () => {
        expect(
            authorizeAccessPolicy(memberUser([]), authRequest('/v6/ai/agents/challenge-search-agent/generate')),
        ).toBe(true);
    });

    it('resolves the chatRoute path to category agent and applies that agent policy', () => {
        process.env.ACCESS_POLICY_AGENT_CHALLENGE_SEARCH_AGENT_ROLES = 'administrator';
        const chat = () => authRequest('/v6/ai-chat/challenge-search-agent');
        expect(authorizeAccessPolicy(memberUser(['copilot']), chat())).toBe(false);
        expect(authorizeAccessPolicy(memberUser(['administrator']), chat())).toBe(true);
        // ...and matches its native /v6/ai/agents/:agentId counterpart.
        expect(
            authorizeAccessPolicy(
                memberUser(['copilot']),
                authRequest('/v6/ai/agents/challenge-search-agent/stream'),
            ),
        ).toBe(false);
    });

    it('allows out-of-scope apiPrefix paths (memory, threads, telemetry)', () => {
        expect(authorizeAccessPolicy(memberUser([]), authRequest('/v6/ai/memory/threads'))).toBe(true);
        expect(authorizeAccessPolicy(memberUser([]), authRequest('/v6/ai/telemetry'))).toBe(true);
    });

    it('re-asserts the MastraAuthAuth0 baseline checks it shadows', () => {
        // No sub/id at all.
        expect(authorizeAccessPolicy({ [USERID_CLAIM]: '1' }, authRequest(INGEST))).toBe(false);
        expect(authorizeAccessPolicy(null, authRequest(INGEST))).toBe(false);
        // Expired.
        const expired = { ...memberUser(['administrator']), exp: Math.floor(Date.now() / 1000) - 60 };
        expect(authorizeAccessPolicy(expired, authRequest(INGEST))).toBe(false);
    });

    it('fails closed when the request URL cannot be recovered', () => {
        // A HonoRequestLike with no `raw` Request — getWebRequest() returns undefined.
        const headerOnly = { header: () => undefined } as any;
        expect(authorizeAccessPolicy(memberUser(['administrator']), headerOnly)).toBe(false);
    });

    it('works when handed a bare Request too (the other MastraAuthRequest shape)', () => {
        expect(
            authorizeAccessPolicy(memberUser(['administrator']), new Request(`http://localhost${INGEST}`)),
        ).toBe(true);
        expect(
            authorizeAccessPolicy(memberUser(['copilot']), new Request(`http://localhost${INGEST}`)),
        ).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// withAccessPolicy — the tool boundary
// ---------------------------------------------------------------------------

describe('withAccessPolicy', () => {
    const TOOL_ID = 'search-challenges';

    function fakeTool(id = TOOL_ID) {
        const execute = vi.fn(async (input: unknown) => ({ ok: true, input }));
        return { tool: withAccessPolicy({ id, execute } as any), execute };
    }

    function ctx(user?: Record<string, unknown>) {
        return { requestContext: { get: (k: string) => (k === 'user' ? user : undefined) } };
    }

    it('leaves a tool with no execute untouched', () => {
        const tool = { id: 'noop' } as any;
        expect(withAccessPolicy(tool)).toBe(tool);
    });

    it('preserves the Mastra tool marker on the clone', () => {
        const marker = Symbol.for('mastra.core.tool.Tool');
        const source: any = { id: 'x', execute: async () => 1 };
        source[marker] = true;
        expect(marker in (withAccessPolicy(source) as any)).toBe(true);
    });

    it('allows any caller for a public-policy tool', async () => {
        const { tool, execute } = fakeTool();
        await expect(tool.execute!({ q: 1 }, ctx(memberUser([])))).resolves.toEqual({
            ok: true,
            input: { q: 1 },
        });
        expect(execute).toHaveBeenCalledOnce();
    });

    it('bypasses the check entirely when DISABLE_AUTH=true, even with no user', async () => {
        process.env.DISABLE_AUTH = 'true';
        process.env.ACCESS_POLICY_TOOL_SEARCH_CHALLENGES_MODE = 'deny';
        const { tool, execute } = fakeTool();
        await expect(tool.execute!({}, ctx(undefined))).resolves.toEqual({ ok: true, input: {} });
        expect(execute).toHaveBeenCalledOnce();
    });

    it('denies when there is no user on the request context', async () => {
        const { tool, execute } = fakeTool();
        await expect(tool.execute!({}, ctx(undefined))).rejects.toBeInstanceOf(
            ToolAccessDeniedError,
        );
        expect(execute).not.toHaveBeenCalled();
    });

    it('denies a member without the required role and allows one with it', async () => {
        process.env.ACCESS_POLICY_TOOL_SEARCH_CHALLENGES_ROLES = 'administrator';
        const { tool } = fakeTool();
        await expect(tool.execute!({}, ctx(memberUser(['copilot'])))).rejects.toThrow(
            /Access denied for tool "search-challenges"/,
        );
        await expect(tool.execute!({}, ctx(memberUser(['administrator'])))).resolves.toMatchObject({
            ok: true,
        });
    });

    it('denies M2M without the required scope and allows one with it', async () => {
        process.env.ACCESS_POLICY_TOOL_SEARCH_CHALLENGES_SCOPES = 'challengesRAG:admin';
        const { tool } = fakeTool();
        await expect(tool.execute!({}, ctx(m2mUser(['read:challenges'])))).rejects.toBeInstanceOf(
            ToolAccessDeniedError,
        );
        await expect(
            tool.execute!({}, ctx(m2mUser(['challengesRAG:admin']))),
        ).resolves.toMatchObject({ ok: true });
    });
});

// ---------------------------------------------------------------------------
// Registry-key aliases — both spellings of a target must resolve identically,
// or a restriction is bypassable by addressing it the other way.
// ---------------------------------------------------------------------------

describe('registry-key aliases', () => {
    const aliasEntries = (['agent', 'workflow', 'tool', 'route'] as AccessCategory[])
        .flatMap(category => Object.entries(TARGET_ID_ALIASES[category])
            .map(([registryKey, canonicalId]) => ({ canonicalId, category, registryKey })));

    it.each(aliasEntries)(
        '$category: $registryKey resolves to the $canonicalId policy',
        ({ category, registryKey, canonicalId }) => {
            expect(canonicalTargetId(category, registryKey)).toBe(canonicalId);
            expect(resolveAccessPolicy(category, registryKey)).toEqual(
                resolveAccessPolicy(category, canonicalId),
            );
        },
    );

    it('leaves an id that is already canonical untouched', () => {
        expect(canonicalTargetId('agent', 'skillsMatchingAgent')).toBe('skillsMatchingAgent');
        expect(canonicalTargetId('workflow', 'challenge-ingestion')).toBe('challenge-ingestion');
    });

    it('denies the registry-key spelling of a restricted workflow over HTTP', () => {
        // The regression this map exists for: platform-ui's default workflow id
        // was the registry key, which used to resolve to "no policy" -> public.
        const byRegistryKey = '/v6/ai/workflows/challengeIngestionWorkflow/start';
        const byId = '/v6/ai/workflows/challenge-ingestion/start';

        for (const path of [byRegistryKey, byId]) {
            expect(authorizeAccessPolicy(memberUser(['copilot']), authRequest(path))).toBe(false);
            expect(authorizeAccessPolicy(memberUser(['administrator']), authRequest(path))).toBe(true);
        }
    });

    it('keeps every env override reachable from the registry-key spelling', () => {
        process.env.ACCESS_POLICY_WORKFLOW_CHALLENGE_SEARCH_ROLES = 'administrator';
        _resetAccessPolicyCache();

        expect(resolveAccessPolicy('workflow', 'challengeSearchWorkflow')).toEqual({
            mode: 'restricted',
            roles: ['administrator'],
            scopes: undefined,
        });
    });

    it('has an alias entry for every restricted code default whose key differs', () => {
        // Guards the standing footgun: adding a restricted entry keyed on `.id`
        // without registering its registry key leaves the alias open.
        const restrictedWorkflowIds = Object.entries(DEFAULT_ACCESS_POLICIES.workflow)
            .filter(([, policy]) => policy.mode !== 'public')
            .map(([id]) => id);
        const aliasTargets = Object.values(TARGET_ID_ALIASES.workflow);

        for (const id of restrictedWorkflowIds) {
            expect(aliasTargets).toContain(id);
        }
    });
});

// ---------------------------------------------------------------------------
// The `route` category — this repo's own custom API routes
// ---------------------------------------------------------------------------

describe('route policies', () => {
    const LIST = '/v6/ai-rag/challenges';
    const DELETE_ONE = '/v6/ai-rag/challenges/9f1c2e4a-7b3d';

    it('ships the RAG index admin API restricted, with no env vars set', () => {
        expect(resolveAccessPolicy('route', 'rag-challenges')).toEqual({
            mode: 'restricted',
            roles: ['administrator'],
            scopes: ['challengesRAG:admin'],
        });
    });

    it.each([LIST, DELETE_ONE])('denies a non-administrator on %s', path => {
        expect(authorizeAccessPolicy(memberUser(['copilot']), authRequest(path))).toBe(false);
        expect(authorizeAccessPolicy(m2mUser(['read:challenges']), authRequest(path))).toBe(false);
    });

    it.each([LIST, DELETE_ONE])('allows an administrator and a scoped M2M client on %s', path => {
        expect(authorizeAccessPolicy(memberUser(['administrator']), authRequest(path))).toBe(true);
        expect(authorizeAccessPolicy(m2mUser(['challengesRAG:admin']), authRequest(path))).toBe(true);
    });

    it('does not match a path that merely starts with the same prefix', () => {
        // /challenges-export would be a different route and must not inherit
        // the policy by accident.
        expect(
            authorizeAccessPolicy(memberUser(['copilot']), authRequest('/v6/ai-rag/challenges-export')),
        ).toBe(true);
    });

    it('is overridable by env like any other category', () => {
        process.env.ACCESS_POLICY_ROUTE_RAG_CHALLENGES_MODE = 'deny';
        _resetAccessPolicyCache();

        expect(authorizeAccessPolicy(memberUser(['administrator']), authRequest(LIST))).toBe(false);
    });
});
