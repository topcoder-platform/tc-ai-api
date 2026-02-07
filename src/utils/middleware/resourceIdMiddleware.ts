import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { tcAILogger } from '../logger';

/**
 * Resource ID Middleware
 *
 * This middleware enforces resource isolation by setting the `MASTRA_RESOURCE_ID_KEY`
 * in the request context based on the authenticated user's ID.
 *
 * It performs the following steps:
 * 1. Checks for an authenticated `user` object in the request context.
 * 2. Determines the Topcoder domain (prod or dev) from `TC_API_BASE` to construct the userId claim key.
 * 3. Extracts the unique user identifier from the specific Topcoder claim (e.g., `https://topcoder-dev.com/userId`)
 *    or falls back to the `sub` claim for M2M tokens.
 * 4. Sets the `MASTRA_RESOURCE_ID_KEY` to ensure all subsequent Mastra operations are scoped to this user.
 *
 * @returns 401 Unauthorized if the user is missing or an ID cannot be extracted.
 */
export const resourceIdMiddleware = {
    path: '/api/*',
    handler: async (c: any, next: any) => {
        const requestContext = c.get('requestContext');
        const user = requestContext.get('user');

        if (!user) {
            tcAILogger.error('User object missing in context!');
            return c.json({ error: 'Unauthorized' }, 401);
        }

        // Logic to extract userId
        const tcApiBase = process.env.TC_API_BASE || '';
        let domain = 'topcoder.com';
        try {
            if (tcApiBase) {
                const url = new URL(tcApiBase);
                domain = url.hostname.replace('api.', '');
            }
        } catch (e) {
            console.error('Error parsing TC_API_BASE:', e);
        }

        const userIdKey = `https://${domain}/userId`;
        const userId = user[userIdKey];
        const sub = user['sub']; // M2M user

        if (!userId && !sub) {
            tcAILogger.error('Failed to identify userId/sub', { user });
            return c.json({ error: 'Failed to extract userId/sub from user object' }, 401);
        }

        // Force all API operations to use this user's ID
        // This takes precedence over any client-provided resourceId
        requestContext.set(MASTRA_RESOURCE_ID_KEY, userId || sub);

        return next();
    },
};