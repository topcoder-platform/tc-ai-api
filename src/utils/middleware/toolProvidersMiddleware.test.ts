import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { toolProvidersMiddleware } from './toolProvidersMiddleware';

// Use the server's actual Hono dependency to test wildcard matching at the
// collection root as well as nested routes without adding a runtime dependency.
const require = createRequire(import.meta.url);
const { Hono } = createRequire(require.resolve('@mastra/server/package.json'))('hono');

describe('tool provider routes without an editor', () => {
    function appWithEditor(editor?: object) {
        const app = new Hono();
        const downstream = vi.fn((c: any) => c.json({ providers: [] }));
        app.use('*', async (c: any, next: () => Promise<void>) => {
            c.set('mastra', { getEditor: () => editor });
            await next();
        });
        app.use(toolProvidersMiddleware.path, toolProvidersMiddleware.handler);
        app.all('*', downstream);
        return { app, downstream };
    }

    it.each(['/v6/ai/tool-providers', '/v6/ai/tool-providers/', '/v6/ai/tool-providers/example/tools'])(
        'returns 404 for %s without invoking the built-in handler', async (path) => {
            const { app, downstream } = appWithEditor();
            const response = await app.request(path);
            expect(response.status).toBe(404);
            expect(await response.json()).toEqual({ error: 'Tool providers are not available' });
            expect(downstream).not.toHaveBeenCalled();
        },
    );

    it('preserves configured providers and unrelated routes', async () => {
        const configured = appWithEditor({});
        expect((await configured.app.request('/v6/ai/tool-providers')).status).toBe(200);
        expect(configured.downstream).toHaveBeenCalledOnce();
        const unconfigured = appWithEditor();
        expect((await unconfigured.app.request('/v6/ai/agents')).status).toBe(200);
        expect(unconfigured.downstream).toHaveBeenCalledOnce();
    });
});
