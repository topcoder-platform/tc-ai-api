import { core } from './core';
import { M2mConfig } from '../../config/m2m.config';

/** Supplies a cached, verified Keycloak service token for explicitly enabled downstream tool fallbacks. */
export class M2MService {
  private static m2m: ReturnType<typeof core.auth.m2m> | undefined;

  /**
   * Obtains the configured workload token, retaining one shared-core cache across instances.
   * Takes no arguments; returns the verified access token; configuration/issuance/verification errors propagate.
   */
  async getM2MToken(): Promise<string> {
    M2MService.m2m ??= core.auth.m2m(M2mConfig);
    return M2MService.m2m.getMachineToken();
  }
}
