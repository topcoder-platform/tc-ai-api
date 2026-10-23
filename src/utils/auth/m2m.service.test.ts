import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth0Env = {
  M2M_AUTH_URL: 'https://tenant.example/oauth/token',
  M2M_AUTH_AUDIENCE: 'https://m2m.example/',
  M2M_AUTH_PROXY_SERVER_URL: 'https://proxy.example/token',
  M2M_AUTH_CLIENT_ID: 'auth0-ai',
  M2M_AUTH_CLIENT_SECRET: 'auth0-secret',
};

/** Stubs both providers' settings plus `env`, then loads M2MService fresh so M2mConfig re-reads them. */
async function load(env: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries({
    ...auth0Env,
    KEYCLOAK_CLIENT_ID: 'm2m-ai',
    KEYCLOAK_CLIENT_SECRET: 'keycloak-secret',
    AUTH_SCOPE: undefined,
    ...env,
  })) {
    vi.stubEnv(name, value);
  }
  vi.resetModules();
  const { core } = await import('./core');
  const { M2MService } = await import('./m2m.service');
  return { core, service: new M2MService() };
}

/** Returns an unsigned token-shaped fixture; the Auth0 provider only decodes exp for caching. */
function token(): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ exp: Math.floor(Date.now() / 1000) + 900 })}.fixture`;
}

describe('USE_KEYCLOAK outbound provider selection', () => {
  beforeEach(() => nock.disableNetConnect());
  afterEach(() => {
    vi.unstubAllEnvs();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('requests an Auth0 token with the M2M_AUTH_* settings when USE_KEYCLOAK=false', async () => {
    const { service } = await load({ USE_KEYCLOAK: 'false' });
    const jwt = token();
    const auth0 = nock('https://proxy.example')
      .post('/token', {
        grant_type: 'client_credentials',
        client_id: 'auth0-ai',
        client_secret: 'auth0-secret',
        auth0_url: auth0Env.M2M_AUTH_URL,
        audience: auth0Env.M2M_AUTH_AUDIENCE,
      })
      .reply(200, { access_token: jwt });
    expect(await service.getM2MToken()).toBe(jwt);
    expect(auth0.isDone()).toBe(true);
  });

  it('keeps the pre-migration Auth0 defaults when USE_KEYCLOAK is unset', async () => {
    const { core, service } = await load({
      USE_KEYCLOAK: undefined,
      M2M_AUTH_URL: undefined,
      M2M_AUTH_AUDIENCE: undefined,
      M2M_AUTH_PROXY_SERVER_URL: undefined,
    });
    const provider = { getMachineToken: vi.fn().mockResolvedValue('token'), clearCache: vi.fn() };
    const m2m = vi.spyOn(core.auth, 'm2m').mockReturnValue(provider);
    expect(await service.getM2MToken()).toBe('token');
    expect(core.auth.useKeycloak()).toBe(false);
    expect(m2m).toHaveBeenCalledWith(
      expect.objectContaining({
        AUTH0_URL: 'https://topcoder-dev.auth0.com/oauth/token',
        AUTH0_AUDIENCE: 'https://m2m.topcoder-dev.com/',
        AUTH0_PROXY_SERVER_URL: 'https://auth0proxy.topcoder-dev.com/token',
        AUTH0_CLIENT_ID: 'auth0-ai',
        AUTH0_CLIENT_SECRET: 'auth0-secret',
      }),
    );
    expect(provider.getMachineToken).toHaveBeenCalledWith();
  });

  it('requests a Keycloak token with the KEYCLOAK_* settings when USE_KEYCLOAK=true', async () => {
    const { service } = await load({ USE_KEYCLOAK: 'true' });
    const endpoint = new URL(process.env.KEYCLOAK_TOKEN_URL!);
    const keycloak = nock(endpoint.origin)
      .post(endpoint.pathname, {
        grant_type: 'client_credentials',
        client_id: 'm2m-ai',
        client_secret: 'keycloak-secret',
        audience: process.env.KEYCLOAK_AUDIENCE!,
      })
      .reply(500);
    await expect(service.getM2MToken()).rejects.toThrow(/^Keycloak M2M token request failed$/);
    expect(keycloak.isDone()).toBe(true);
  });
});
