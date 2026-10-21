import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { apiAuthLayer } from '../auth';
import { mapUserToResourceId } from '../auth/resource-id';
import { MASTRA_USER_CONTEXT_KEY } from '../auth/access-control';
import { tcAILogger } from '../logger';
import { API_PREFIX, CHAT_ROUTE_BASE_PATH } from '../server-routes';

/**
 * Enforces Mastra memory isolation from the reserved verified-principal context.
 * @param c Hono context. @param next Downstream continuation.
 * @returns A 401 response or the continuation result; authentication failures are sanitized.
 * Plain requestContext.user values cannot establish identity. If the reserved identity is
 * absent, the shared provider authenticates the bearer/legacy apiKey token before mapping.
 */
const resourceIdMiddlewareHandler = async (c: any, next: any) => {
    const requestContext = c.get('requestContext');
    let user = requestContext.get(MASTRA_USER_CONTEXT_KEY);

    if (!user) {
        const authHeader = c.req.header('authorization') || '';
        const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
        const apiKeyToken = c.req.query('apiKey') || '';
        const token = bearerToken || apiKeyToken;

        if (token) {
            try {
                user = await apiAuthLayer.authenticateToken(token, c.req.raw);
                if (user) {
                    requestContext.set('user', user);
                    requestContext.set(MASTRA_USER_CONTEXT_KEY, user);
                }
            } catch {
                tcAILogger.error('Failed to authenticate token in resource middleware');
            }
        }
    }

    if (!user) {
        tcAILogger.error('User object missing in context!');
        return c.json({ error: 'Unauthorized' }, 401);
    }

    const resourceId = mapUserToResourceId(user);
    if (!resourceId) {
        tcAILogger.error('Invalid normalized principal in resource middleware');
        return c.json({ error: 'Unauthorized' }, 401);
    }

    requestContext.set(MASTRA_RESOURCE_ID_KEY, resourceId);

    tcAILogger.info('Auth resolved for request', {
        authType: user.kind === 'user' ? 'member' : 'm2m',
        resourceId,
    });

    return next();
};

// Built-in Mastra routes (agents, workflows, memory, threads, ...) live under apiPrefix.
export const resourceIdMiddleware = {
    path: `${API_PREFIX}/*`,
    handler: resourceIdMiddlewareHandler,
};

// chatRoute() is a custom API route registered outside apiPrefix (see src/mastra/index.ts),
// so it needs its own entry to be covered.
export const chatResourceIdMiddleware = {
    path: `${CHAT_ROUTE_BASE_PATH}/*`,
    handler: resourceIdMiddlewareHandler,
};