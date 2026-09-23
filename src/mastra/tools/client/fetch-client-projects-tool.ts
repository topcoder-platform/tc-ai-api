// Clients/Billing-Accounts/Projects APIs: GET /v6/clients, GET /v6/billing-accounts,
// GET /v6/projects — walks clients -> billing accounts -> projects for a client
// search term, so a caller can answer "what work have we delivered for client X".
// See docs/adr/0007-client-billing-account-project-visibility.md.
//
// Credential policy is the OPPOSITE of fetch-project-by-id's (which never
// escalates to M2M): here, only an `administrator` caller's own JWT is
// forwarded — every other RBAC-permitted role (currently just `Talent
// Manager`) forces tc-ai-api's own service M2M token for every call this tool
// makes. This is a discovery tool where an incomplete client/billing-account/
// project tree (because a caller's own JWT can't see some of it) would
// silently undercount delivered work — the same completeness argument
// fetch-challenge-resources (ADR 0005) makes for its own forced-M2M branch.
import { createTool } from '@mastra/core/tools';
import { toAuthenticatedCaller, withAccessPolicy } from '../../../utils/auth/access-control';
import { z } from 'zod';
import type { RequestContext } from '@mastra/core/request-context';
import { callTcApi } from '../../../utils/tc-api-client';

const TOOL_ID = 'fetch-client-projects';
const CLIENTS_BASE_URL = `${process.env.TC_API_BASE}/v6/clients`;
const BILLING_ACCOUNTS_BASE_URL = `${process.env.TC_API_BASE}/v6/billing-accounts`;
const PROJECTS_BASE_URL = `${process.env.TC_API_BASE}/v6/projects`;

// Bounds upstream fan-out per invocation: at most this many rows are pulled
// per level (clients, billing accounts per client, projects per billing
// account). A `...Truncated` flag on each level tells the caller when more
// exists than was shown, rather than looping through further pages.
const PAGE_CAP = 50;
const ADMIN_ROLE = 'administrator';

const PROJECT_ROW_SHAPE = z.object({
    id: z.string(),
    name: z.string().optional(),
    status: z.string().optional(),
    lastActivityAt: z.string().optional().describe('ISO timestamp of the most recent activity on the project'),
    lastActivityUserId: z.string().optional().describe('Topcoder user id of whoever performed that last activity'),
});

const BILLING_ACCOUNT_SHAPE = z.object({
    id: z.string(),
    name: z.string().optional(),
    projectsTruncated: z.boolean().describe(`true if this billing account has more than ${PAGE_CAP} projects`),
    projects: z.array(PROJECT_ROW_SHAPE),
});

const CLIENT_SHAPE = z.object({
    id: z.string(),
    name: z.string().optional(),
    codeName: z.string().optional(),
    billingAccountsTruncated: z.boolean().describe(`true if this client has more than ${PAGE_CAP} billing accounts`),
    billingAccounts: z.array(BILLING_ACCOUNT_SHAPE),
});

export const fetchClientProjectsTool = withAccessPolicy(
    createTool({
        id: TOOL_ID,
        description:
            'Finds the work delivered for a Topcoder client/customer by walking the v6 Clients, ' +
            'Billing Accounts, and Projects APIs: client search -> that client\'s billing accounts -> ' +
            'each billing account\'s projects. Takes a codeName and/or name search term (at least one ' +
            'required) and returns every matching client with its billing accounts and projects nested ' +
            'underneath. Use this to answer "find me all the work done for client X" — then let the ' +
            'caller pick one project and resolve it further with fetch-project-by-id.',
        inputSchema: z.object({
            codeName: z.string().optional().describe('Client code to search for, e.g. "CUS-173826"'),
            name: z.string().optional().describe('Client name (or fragment) to search for, case-insensitive'),
        }),
        outputSchema: z.object({
            clients: z.array(CLIENT_SHAPE),
            clientsTruncated: z.boolean().describe(`true if more than ${PAGE_CAP} clients matched the search`),
        }),
        execute: async (inputData, context) => {
            const logger = context.mastra?.getLogger?.();
            if (!inputData.codeName && !inputData.name) {
                throw new Error('Provide at least one of codeName or name');
            }
            logger?.info('Searching clients: codeName={codeName} name={name}', {
                codeName: inputData.codeName,
                name: inputData.name,
            });
            return await fetchClientProjects(inputData, context.requestContext);
        },
    }),
);

interface Input {
    codeName?: string;
    name?: string;
}

/**
 * `withAccessPolicy` has already confirmed the caller holds `administrator`
 * or `Talent Manager` by the time this runs — this only decides *which*
 * credential to forward for the outbound TC API calls, not whether to allow
 * the call at all. Mirrors fetch-challenge-resources-tool.ts's own
 * shouldForceM2M (ADR 0005): fail toward the credential that works.
 */
function shouldForceM2M(requestContext: RequestContext | undefined): boolean {
    const user = requestContext?.get('user') as Record<string, unknown> | undefined;
    if (!user) {
        return true;
    }
    return !toAuthenticatedCaller(user).roles.includes(ADMIN_ROLE);
}

function toStringOrUndefined(value: unknown): string | undefined {
    return value === null || value === undefined ? undefined : String(value);
}

/** GET /v6/clients envelope shape: { page, perPage, total, totalPages, data }. */
function parseEnvelope(body: any): { total: number; data: any[] } {
    const data: any[] = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    const total = typeof body?.total === 'number' ? body.total : data.length;
    return { total, data };
}

const fetchClients = async (input: Input, requestContext: RequestContext | undefined, forceM2M: boolean) => {
    const params = new URLSearchParams();
    if (input.codeName) params.set('codeName', input.codeName);
    if (input.name) params.set('name', input.name);
    params.set('page', '1');
    params.set('perPage', String(PAGE_CAP));

    const response = await callTcApi({
        toolId: TOOL_ID,
        url: `${CLIENTS_BASE_URL}?${params.toString()}`,
        init: { method: 'GET', signal: AbortSignal.timeout(15_000) },
        requestContext,
        forceM2M,
    });
    if (!response.ok) {
        throw new Error(`Failed to search clients (HTTP ${response.status})`);
    }

    const { total, data } = parseEnvelope(await response.json());
    const clients = data
        .map((row) => ({
            id: toStringOrUndefined(row?.id) ?? '',
            name: row?.name ?? undefined,
            codeName: row?.codeName ?? undefined,
        }))
        .filter((client) => client.id.length > 0);

    return { clients, truncated: total > data.length };
};

const fetchBillingAccountsForClient = async (
    clientId: string,
    requestContext: RequestContext | undefined,
    forceM2M: boolean,
) => {
    const response = await callTcApi({
        toolId: TOOL_ID,
        url: `${BILLING_ACCOUNTS_BASE_URL}?clientId=${encodeURIComponent(clientId)}&page=1&perPage=${PAGE_CAP}`,
        init: { method: 'GET', signal: AbortSignal.timeout(15_000) },
        requestContext,
        forceM2M,
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch billing accounts for client ${clientId} (HTTP ${response.status})`);
    }

    const { total, data } = parseEnvelope(await response.json());
    const billingAccounts = data
        .map((row) => ({ id: toStringOrUndefined(row?.id) ?? '', name: row?.name ?? undefined }))
        .filter((billingAccount) => billingAccount.id.length > 0);

    return { billingAccounts, truncated: total > data.length };
};

/**
 * Unlike the two list endpoints above, GET /v6/projects?billingAccountId=
 * returns a bare array with no page/total envelope in its body — confirmed
 * against a live response (see ADR 0007). Pagination metadata instead comes
 * from the same X-Total/X-Page/X-Per-Page headers GET /v6/resources already
 * uses (ADR 0005), also confirmed live for this endpoint.
 */
const fetchProjectsForBillingAccount = async (
    billingAccountId: string,
    requestContext: RequestContext | undefined,
    forceM2M: boolean,
) => {
    const response = await callTcApi({
        toolId: TOOL_ID,
        url: `${PROJECTS_BASE_URL}?billingAccountId=${encodeURIComponent(billingAccountId)}&page=1&perPage=${PAGE_CAP}`,
        init: { method: 'GET', signal: AbortSignal.timeout(15_000) },
        requestContext,
        forceM2M,
    });
    if (!response.ok) {
        throw new Error(
            `Failed to fetch projects for billing account ${billingAccountId} (HTTP ${response.status})`,
        );
    }

    const body = await response.json();
    const rows: any[] = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    const totalHeader = Number(response.headers.get('x-total') ?? rows.length);

    const projects = rows
        .map((row) => ({
            id: toStringOrUndefined(row?.id) ?? '',
            name: row?.name ?? undefined,
            status: row?.status ?? undefined,
            lastActivityAt: toStringOrUndefined(row?.lastActivityAt),
            lastActivityUserId: toStringOrUndefined(row?.lastActivityUserId),
        }))
        .filter((project) => project.id.length > 0);

    return { projects, truncated: totalHeader > rows.length };
};

const fetchClientProjects = async (input: Input, requestContext: RequestContext | undefined) => {
    const forceM2M = shouldForceM2M(requestContext);

    const { clients, truncated: clientsTruncated } = await fetchClients(input, requestContext, forceM2M);

    const clientResults = await Promise.all(
        clients.map(async (client) => {
            const { billingAccounts, truncated: billingAccountsTruncated } = await fetchBillingAccountsForClient(
                client.id,
                requestContext,
                forceM2M,
            );

            const billingAccountResults = await Promise.all(
                billingAccounts.map(async (billingAccount) => {
                    const { projects, truncated: projectsTruncated } = await fetchProjectsForBillingAccount(
                        billingAccount.id,
                        requestContext,
                        forceM2M,
                    );
                    return {
                        id: billingAccount.id,
                        name: billingAccount.name,
                        projectsTruncated,
                        projects,
                    };
                }),
            );

            return {
                id: client.id,
                name: client.name,
                codeName: client.codeName,
                billingAccountsTruncated,
                billingAccounts: billingAccountResults,
            };
        }),
    );

    return { clients: clientResults, clientsTruncated };
};
