import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { ObservabilityStorage } from '@mastra/core/storage';
import { optionalCapabilitiesMiddleware } from './optionalCapabilitiesMiddleware';

const require = createRequire(import.meta.url);
const { Hono } = createRequire(require.resolve('@mastra/server/package.json'))('hono');

describe('optional capability routes', () => {
    function appWithCapabilities(editor?: object, store?: object) {
        const app = new Hono();
        const downstream = vi.fn((c: any) => c.json({ ok: true }));
        app.use('*', async (c: any, next: () => Promise<void>) => {
            c.set('mastra', {
                getEditor: () => editor,
                getStorage: () => ({ getStore: async () => store }),
            });
            await next();
        });
        for (const middleware of optionalCapabilitiesMiddleware) {
            app.use(middleware.path, middleware.handler);
        }
        app.all('*', downstream);
        return { app, downstream };
    }

    it.each(['tool-providers', 'tool-providers/', 'tool-providers/example/tools',
        'processor-providers', 'processor-providers/', 'processor-providers/example'])(
        'returns 404 for unavailable %s without executing the handler', async (path) => {
            const { app, downstream } = appWithCapabilities();
            expect((await app.request(`/v6/ai/${path}`)).status).toBe(404);
            expect(downstream).not.toHaveBeenCalled();
        },
    );

    it.each(['logs', 'branches'])('returns 404 for unsupported %s', async (route) => {
        for (const store of [undefined, new ObservabilityStorage()]) {
            const { app, downstream } = appWithCapabilities(undefined, store);
            expect((await app.request(`/v6/ai/observability/${route}`)).status).toBe(404);
            expect(downstream).not.toHaveBeenCalled();
        }
    });

    it('preserves supported capabilities and unrelated routes', async () => {
        const { app } = appWithCapabilities({}, {
            listLogs: async () => ({ logs: [] }),
            listBranches: async () => ({ branches: [] }),
        });
        for (const path of ['tool-providers', 'processor-providers', 'observability/logs',
            'observability/branches', 'observability/traces', 'agents']) {
            expect((await app.request(`/v6/ai/${path}`)).status).toBe(200);
        }
    });
});
