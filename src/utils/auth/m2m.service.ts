import { core } from './core';
import { M2mConfig } from '../../config/m2m.config';

/**
 * Supplies this workload's M2M token for explicitly enabled downstream tool fallbacks
 * (`tc-api-client`), from the provider selected by `USE_KEYCLOAK`.
 *
 * With `USE_KEYCLOAK=true` the core issues a verified Keycloak token using
 * `KEYCLOAK_TOKEN_URL`, `KEYCLOAK_AUDIENCE`, `KEYCLOAK_CLIENT_ID`/`SECRET` and optional
 * `KEYCLOAK_SCOPE`, and ignores the Auth0 options. Otherwise it requests an Auth0 token with
 * the `M2M_AUTH_*` settings from {@link M2mConfig}, as the service did before the migration.
 */
export class M2MService {
  private static m2m: ReturnType<typeof core.auth.m2m> | undefined;

  /**
   * Builds the options passed to `core.auth.m2m`: the KEYCLOAK_* settings plus the
   * `M2M_AUTH_*` Auth0 settings mapped to the core's AUTH0_* option names.
   * Takes no parameters; returns the options object; does not throw.
   */
  static options(): Record<string, string | undefined> {
    const { auth0, ...keycloak } = M2mConfig;
    return {
      ...keycloak,
      AUTH0_URL: auth0.url,
      AUTH0_AUDIENCE: auth0.audience,
      AUTH0_PROXY_SERVER_URL: auth0.proxyUrl,
      AUTH0_CLIENT_ID: auth0.clientId,
      AUTH0_CLIENT_SECRET: auth0.clientSecret,
    };
  }

  /**
   * Obtains the workload token from the active provider, retaining one shared-core cache
   * across instances. Takes no arguments; returns the access token.
   * @throws TypeError for an invalid USE_KEYCLOAK value or Keycloak settings; rejects for
   * missing credentials, issuance failures or (Keycloak) invalid returned tokens.
   */
  async getM2MToken(): Promise<string> {
    M2MService.m2m ??= core.auth.m2m(M2MService.options());
    return M2MService.m2m.getMachineToken();
  }
}
