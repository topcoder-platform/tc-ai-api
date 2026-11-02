import type { Mastra } from '@mastra/core';
import type { Middleware } from '@mastra/core/server';
import { API_PREFIX } from '../server-routes';

/** The optional editor is not configured in this service. Avoid Mastra's 500. */
export const toolProvidersMiddleware = {
    path: `${API_PREFIX}/tool-providers/*`,
    handler: async (c, next) => {
        const mastra: Mastra = c.get('mastra');
        if (!mastra.getEditor()) {
            return c.json({ error: 'Tool providers are not available' }, 404);
        }
        await next();
    },
} satisfies Middleware;
