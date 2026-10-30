import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  url: 'https://auth.example.test/oauth/token',
  audience: 'https://api.example.test/',
  proxyUrl: '',
  clientId: 'service-client',
  clientSecret: 'test-client-secret',
}));
vi.mock('../../config/m2m.config', () => ({ M2mConfig: { auth0: config } }));

const requests: Record<string, unknown>[] = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  res.setHeader('Content-Type', 'application/json');
  if (body.client_id === 'rejected-client') {
    res.writeHead(401);
    res.end(JSON.stringify({ message: `Sensitive upstream body: ${body.client_secret}` }));
    return;
  }
  res.end(JSON.stringify({ access_token: `token-for-${body.client_id}`, expires_in: 3600 }));
});
let M2MService: typeof import('./m2m.service').M2MService;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  config.proxyUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
  M2MService = (await import('./m2m.service')).M2MService;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('shared outbound M2M client', () => {
  it('deduplicates concurrent requests and retains its cache across service instances', async () => {
    const first = new M2MService();
    const second = new M2MService();
    expect(await Promise.all([first.getM2MToken(), second.getM2MToken()])).toEqual([
      'token-for-service-client',
      'token-for-service-client',
    ]);
    expect(await new M2MService().getM2MToken()).toBe('token-for-service-client');
    expect(requests).toEqual([
      {
        grant_type: 'client_credentials',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        audience: config.audience,
        auth0_url: config.url,
      },
    ]);
  });

  it('isolates cached tokens by credentials', async () => {
    config.clientId = 'second-client';
    expect(await new M2MService().getM2MToken()).toBe('token-for-second-client');
    expect(requests).toHaveLength(2);
  });

  it('rejects missing credentials without making an OAuth request', async () => {
    config.clientSecret = '';
    const before = requests.length;
    await expect(new M2MService().getM2MToken()).rejects.toThrow(
      'M2M_AUTH_CLIENT_ID and M2M_AUTH_CLIENT_SECRET are required',
    );
    expect(requests).toHaveLength(before);
    config.clientSecret = 'test-client-secret';
  });

  it('propagates sanitized OAuth errors without credentials or upstream bodies', async () => {
    config.clientId = 'rejected-client';
    const error = await new M2MService().getM2MToken().catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(config.clientSecret);
    expect(String(error)).not.toContain('Sensitive upstream body');
  });
});
