import { describe, it, expect, vi } from 'vitest';
import { MastraAuthProvider } from '@mastra/core/server';
import type { HonoRequest } from 'hono';

// Prevent module-level MastraAuthAuth0 instantiation from failing without env vars
vi.mock('@mastra/auth-auth0', () => ({
    MastraAuthAuth0: class {
        name = 'mock-auth0';
        authenticateToken = vi.fn().mockResolvedValue(null);
        authorizeUser = vi.fn().mockResolvedValue(false);
    },
}));

import { StudioBypassAuth } from './index';

class FakeAuthProvider extends MastraAuthProvider<Record<string, string>> {
    constructor(private readonly usersByToken: Record<string, Record<string, string>>) {
        super({ name: 'fake-auth' });
    }

    async authenticateToken(token: string): Promise<Record<string, string> | null> {
        return this.usersByToken[token] ?? null;
    }

    async authorizeUser(): Promise<boolean> {
        return true;
    }
}

describe('StudioBypassAuth', () => {
    it('marks Studio routes as public', () => {
        const auth = new StudioBypassAuth([new FakeAuthProvider({})]);

        expect(auth.public).toHaveLength(1);
        expect(auth.public?.[0]).toBeInstanceOf(RegExp);
        expect((auth.public?.[0] as RegExp).test('/studio')).toBe(true);
        expect((auth.public?.[0] as RegExp).test('/studio/assets/main.js')).toBe(true);
        expect((auth.public?.[0] as RegExp).test('/api/agents')).toBe(false);
    });

    it('hydrates the current user from requestContext query params', async () => {
        const auth = new StudioBypassAuth([
            new FakeAuthProvider({
                'query-token': { sub: 'query-user' },
            }),
        ]);
        const requestContext = Buffer.from(JSON.stringify({ jwt: 'query-token' }), 'utf8').toString('base64');
        const request = new Request(`https://example.com/api/agents?requestContext=${encodeURIComponent(requestContext)}`);

        const user = await auth.getCurrentUser(request);

        expect(user).toEqual({ sub: 'query-user' });
    });

    it('hydrates the current user from requestContext body payloads', async () => {
        const auth = new StudioBypassAuth([
            new FakeAuthProvider({
                'body-token': { sub: 'body-user' },
            }),
        ]);
        const request = new Request('https://example.com/api/agents/skillsMatchingAgent/generate', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                requestContext: {
                    authorization: 'Bearer body-token',
                },
            }),
        });

        const user = await auth.getCurrentUser(request);

        expect(user).toEqual({ sub: 'body-user' });
    });

    it('falls back to apiKey query params during authentication', async () => {
        const auth = new StudioBypassAuth([
            new FakeAuthProvider({
                'query-api-key': { sub: 'api-key-user' },
            }),
        ]);
        const request = new Request('https://example.com/api/agents?apiKey=query-api-key');

        const user = await auth.authenticateToken('', request as unknown as HonoRequest);

        expect(user).toEqual({ sub: 'api-key-user' });
    });
});