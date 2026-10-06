/**
 * Registration guards for src/mastra/index.ts. See docs/adr/0009-system-one-tool.md.
 */
import { describe, expect, it, vi } from 'vitest';

// The real instance needs Postgres, Auth0 and a workspace path; none of that
// matters for what is registered where.
vi.mock('@mastra/pg', async () => {
    const { LibSQLStore } = await import('@mastra/libsql');
    return {
        PostgresStore: class extends LibSQLStore {
            constructor() {
                super({ id: 'registration-test', url: ':memory:' });
            }
        },
    };
});
vi.stubEnv('WORKSPACE_PATH', './workspace');
vi.stubEnv('AUTH0_DOMAIN', 'example.auth0.com');
vi.stubEnv('AUTH0_AUDIENCE', 'https://example.test/');
vi.stubEnv('AUTH0_M2M_DOMAIN', 'example.auth0.com');
vi.stubEnv('AUTH0_M2M_AUDIENCE', 'https://example.test/');

describe('System One registration (ADR 0009)', () => {
    it('registers the system-one workflow', async () => {
        const { mastra } = await import('./index');
        expect(mastra.getWorkflowById('system-one').id).toBe('system-one');
    });

    it('keeps the system-one tool unreachable over HTTP', async () => {
        // POST /tools/:toolId/execute resolves Mastra-registered tools, then any
        // tool on any registered agent (findToolInAgents, ADR 0009 F1). Either
        // would make System One callable WITHOUT a tracked run. If this fails
        // because an agent was given the tool, that change needs its own ADR
        // decision (e.g. a tool-path deny), not a test update.
        const { mastra } = await import('./index');

        expect(() => mastra.getToolById('system-one')).toThrow();

        for (const agent of Object.values(mastra.listAgents())) {
            const tools = await agent.listTools({});
            const ids = Object.values(tools ?? {}).map((tool) => (tool as { id?: string }).id);
            expect(ids, `agent "${agent.id}"`).not.toContain('system-one');
        }
    });
});
