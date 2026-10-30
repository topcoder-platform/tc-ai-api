import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JwtConfiguration } from 'tc-core-library-js';

const transport = vi.hoisted(() => ({ jwksUri: '' }));

// Only redirect JWKS transport to a local server. The released library still
// verifies real RSA signatures and all production issuer/audience policies.
vi.mock('tc-core-library-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('tc-core-library-js')>();
  return {
    ...actual,
    createJwtVerifier: vi.fn((config: JwtConfiguration) =>
      actual.createJwtVerifier({
        ...config,
        issuers: config.issuers?.map((policy) => ({ ...policy, jwksUri: transport.jwksUri })),
      }),
    ),
  };
});
vi.mock('../logger', () => ({ tcAILogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const memberIssuer = 'https://members.example.test/';
const machineIssuer = 'https://machines.example.test/';
const userIdClaim = 'https://topcoder-dev.com/userId';
const rolesClaim = 'https://topcoder-dev.com/roles';
const now = () => Math.floor(Date.now() / 1000);
const request = (path = '/v6/ai/memory/threads') => new Request(`https://ai.example.test${path}`);
let auth: typeof import('./index').apiAuthLayer;
let jwksRequests = 0;
const server = createServer((_req, res) => {
  jwksRequests++;
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      keys: [
        { ...key.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' },
      ],
    }),
  );
});

function token(claims: Record<string, unknown> = {}, signingKey = key.privateKey, header = {}) {
  const encodedHeader = Buffer.from(
    JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT', ...header }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: memberIssuer,
      aud: 'member-api',
      sub: 'auth0|123',
      exp: now() + 300,
      [userIdClaim]: '123',
      [rolesClaim]: ['administrator'],
      ...claims,
    }),
  ).toString('base64url');
  const input = `${encodedHeader}.${payload}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), signingKey).toString('base64url')}`;
}

function machineToken(claims: Record<string, unknown> = {}) {
  return token({
    iss: machineIssuer,
    aud: 'machine-api',
    sub: 'service@clients',
    gty: 'client-credentials',
    [userIdClaim]: undefined,
    [rolesClaim]: undefined,
    scope: 'ai:letstalk:classify',
    ...claims,
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  transport.jwksUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/.well-known/jwks.json`;
  vi.stubEnv('AUTH0_DOMAIN', 'members.example.test');
  vi.stubEnv('AUTH0_AUDIENCE', 'member-api');
  vi.stubEnv('AUTH0_M2M_DOMAIN', 'machines.example.test');
  vi.stubEnv('AUTH0_M2M_AUDIENCE', 'machine-api');
  vi.stubEnv('TC_API_BASE', 'https://api.topcoder-dev.com');
  vi.stubEnv('SWAGGER_UI_ENABLED', 'false');
  auth = (await import('./index')).apiAuthLayer;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('shared JWT authentication through Mastra', () => {
  it('preserves member claims, resource isolation, and administrator access', async () => {
    const user = await auth.authenticateToken(token(), request());
    expect(user).toMatchObject({
      isMachine: false,
      userId: '123',
      [rolesClaim]: ['administrator'],
    });
    expect(auth.mapUserToResourceId?.(user)).toBe('123');
    expect(await auth.authorizeUser(user, request('/v6/ai-api/rag/challenges'))).toBe(true);
  });

  it('maps numeric member IDs to the same string resource ID', async () => {
    const user = await auth.authenticateToken(token({ [userIdClaim]: 123 }), request());
    expect(auth.mapUserToResourceId?.(user)).toBe('123');
  });

  it('accepts machine tokens from the second tenant with the required scope', async () => {
    const user = await auth.authenticateToken(machineToken(), request());
    expect(user).toMatchObject({ isMachine: true, scopes: ['ai:letstalk:classify'] });
    expect(auth.mapUserToResourceId?.(user)).toBe('service@clients');
    expect(
      await auth.authorizeUser(user, request('/v6/ai/workflows/lets-talk-classification')),
    ).toBe(true);
  });

  it('denies machine tokens without the required route scope', async () => {
    const user = await auth.authenticateToken(
      machineToken({ scope: 'read:challenges' }),
      request(),
    );
    expect(user).not.toBeNull();
    expect(
      await auth.authorizeUser(user, request('/v6/ai/workflows/lets-talk-classification')),
    ).toBe(false);
  });

  it('does not turn a human without a user ID into a machine based on scopes', async () => {
    const user = await auth.authenticateToken(
      token({
        [userIdClaim]: undefined,
        [rolesClaim]: undefined,
        scope: 'ai:letstalk:classify',
      }),
      request(),
    );
    expect(user).toMatchObject({ isMachine: false });
    expect(
      await auth.authorizeUser(user, request('/v6/ai/workflows/lets-talk-classification')),
    ).toBe(false);
  });

  it('preserves member role checks on protected chat and custom routes', async () => {
    for (const path of ['/v6/ai-chat/lets-talk-classifier-agent', '/v6/ai-api/rag/challenges']) {
      const user = await auth.authenticateToken(token({ [rolesClaim]: ['member'] }), request(path));
      expect(await auth.authorizeUser(user, request(path))).toBe(false);
    }
  });

  it.each([
    ['untrusted issuer', () => token({ iss: 'https://untrusted.example.test/' })],
    ['wrong audience', () => token({ aud: 'other-api' })],
    ['cross-tenant audience', () => token({ aud: 'machine-api' })],
    ['invalid signature', () => token({}, otherKey.privateKey)],
    ['expired token', () => token({ exp: now() - 60 })],
    ['missing expiry', () => token({ exp: undefined })],
    ['future not-before', () => token({ nbf: now() + 300 })],
    ['future issued-at', () => token({ iat: now() + 300 })],
    ['unsupported algorithm', () => token({}, key.privateKey, { alg: 'HS256' })],
    ['missing key ID', () => token({}, key.privateKey, { kid: undefined })],
    ['malformed token', () => 'invalid-token'],
    ['forged machine flag', () => token({ isMachine: true })],
    ['machine with human ID', () => machineToken({ [userIdClaim]: '123' })],
    ['machine with human roles', () => machineToken({ [rolesClaim]: ['administrator'] })],
    ['machine with browser audience', () => machineToken({ iss: memberIssuer, aud: 'member-api' })],
  ])('rejects %s', async (_name, makeToken) => {
    expect(await auth.authenticateToken(makeToken(), request())).toBeNull();
  });

  it('reuses each tenant JWKS cache across requests', async () => {
    await auth.authenticateToken(token(), request());
    await auth.authenticateToken(machineToken(), request());
    const before = jwksRequests;
    expect(before).toBe(2);
    await auth.authenticateToken(token(), request());
    await auth.authenticateToken(machineToken(), request());
    expect(jwksRequests).toBe(before);
  });

  it('protects every API surface and keeps docs private by default', () => {
    expect(auth.protected).toEqual(
      expect.arrayContaining(['/v6/ai/*', '/v6/ai-chat/*', '/v6/ai-api/*']),
    );
    expect(auth.public).not.toContain('/v6/ai-api/docs');
  });

  it('keeps Swagger UI public only when explicitly enabled', async () => {
    vi.stubEnv('SWAGGER_UI_ENABLED', 'true');
    vi.resetModules();
    const docsAuth = (await import('./index')).apiAuthLayer;
    expect(docsAuth.public).toEqual(
      expect.arrayContaining(['/v6/ai-api/docs', '/v6/ai-api/docs/openapi.json']),
    );
    vi.stubEnv('SWAGGER_UI_ENABLED', 'false');
  });

  it('fails at startup if a trusted tenant audience is missing', async () => {
    vi.stubEnv('AUTH0_M2M_AUDIENCE', '');
    vi.resetModules();
    await expect(import('./index')).rejects.toThrow('Auth0 domain and audience are required');
    vi.stubEnv('AUTH0_M2M_AUDIENCE', 'machine-api');
  });
});
