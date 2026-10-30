import { createM2MClient, type M2MClient } from 'tc-core-library-js';
import { M2mConfig } from '../../config/m2m.config';

/**
 * Service to get M2M token with auth0 configs
 */
export class M2MService {
  private static m2m: M2MClient | undefined;

  constructor() {
    const config = M2mConfig.auth0;
    M2MService.m2m ??= createM2MClient({
      AUTH0_URL: config.url,
      AUTH0_AUDIENCE: config.audience,
      AUTH0_PROXY_SERVER_URL: config.proxyUrl,
    });
  }

  /**
   * Get M2M token.
   * @returns the M2M token
   */
  async getM2MToken(): Promise<string> {
    const config = M2mConfig.auth0;
    if (!config.clientId || !config.clientSecret) {
      throw new Error('M2M_AUTH_CLIENT_ID and M2M_AUTH_CLIENT_SECRET are required');
    }
    return M2MService.m2m!.getMachineToken(config.clientId, config.clientSecret);
  }
}
