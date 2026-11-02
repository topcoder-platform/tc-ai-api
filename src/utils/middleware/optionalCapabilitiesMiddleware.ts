import type { Mastra } from '@mastra/core';
import type { Middleware } from '@mastra/core/server';
import { ObservabilityStorage } from '@mastra/core/storage';
import { API_PREFIX } from '../server-routes';

/** Hide optional endpoints that the configured service cannot provide. */
export const optionalCapabilitiesMiddleware: Middleware[] = [
    ...['tool-providers', 'processor-providers'].map((route): Middleware => ({
        path: `${API_PREFIX}/${route}/*`,
        handler: async (c, next) => {
            const mastra: Mastra = c.get('mastra');
            if (!mastra.getEditor()) {
                return c.json({ error: 'Provider catalog is not available' }, 404);
            }
            await next();
        },
    })),
    ...(['logs', 'branches'] as const).map((route): Middleware => ({
        path: `${API_PREFIX}/observability/${route}`,
        handler: async (c, next) => {
            const mastra: Mastra = c.get('mastra');
            const store = await mastra.getStorage()?.getStore('observability');
            const method = route === 'logs' ? 'listLogs' : 'listBranches';
            // The base implementation throws NotImplemented. Other routes and
            // adapters overriding these methods retain their normal behavior.
            if (!store || store[method] === ObservabilityStorage.prototype[method]) {
                return c.json({ error: 'Observability capability is not available' }, 404);
            }
            await next();
        },
    })),
];
