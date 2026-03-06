// eslint-disable-next-line @typescript-eslint/no-require-imports
const m2mAuth = require('tc-core-library-js').auth.m2m;
import { M2mConfig } from '../../config/m2m.config';

/**
 * Service to get M2M token with auth0 configs
 */
export class M2MService {
  private static m2m: ReturnType<typeof m2mAuth> | null = null;

  constructor() {
    const config = M2mConfig.auth0;
    M2MService.m2m = m2mAuth({
      AUTH0_URL: config.url,
      AUTH0_AUDIENCE: config.audience,
      AUTH0_PROXY_SERVER_URL: config.proxyUrl,
    });
  }

  /**
   * Get M2M token.
   * @returns the M2M token
   */
  async getM2MToken() {
    const config = M2mConfig.auth0;
    return (await M2MService.m2m!.getMachineToken(
      config.clientId,
      config.clientSecret,
    )) as string;
  }
}
