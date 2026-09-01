/**
 * Derives the member-facing Topcoder domain from TC_API_BASE (dev vs prod)
 * without a separate env var to keep in sync.
 *
 * Single source of truth for the snippet that used to be duplicated in
 * src/utils/auth/index.ts, src/utils/middleware/resourceIdMiddleware.ts and
 * src/mastra/agents/challenge/challenge-search-agent.ts. Used to build the
 * TC claim keys (`https://<domain>/userId`, `https://<domain>/roles`) and the
 * member-facing challenge/project URLs.
 *
 * e.g. TC_API_BASE=https://api.topcoder-dev.com -> "topcoder-dev.com"
 */
export function resolveTcDomain(): string {
    let domain = 'topcoder.com';
    try {
        const tcApiBase = process.env.TC_API_BASE || '';
        if (tcApiBase) {
            domain = new URL(tcApiBase).hostname.replace('api.', '');
        }
    } catch {
        // fall back to default domain
    }
    return domain;
}

/** The TC userId claim key, e.g. https://topcoder.com/userId */
export const tcUserIdClaimKey = (): string => `https://${resolveTcDomain()}/userId`;
