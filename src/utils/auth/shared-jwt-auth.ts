import {
  MastraAuthProvider,
  type MastraAuthProviderOptions,
  type MastraAuthRequest,
} from '@mastra/core/server';
import {
  createJwtVerifier,
  type AuthUser,
  type JwtConfiguration,
  type JwtVerifier,
} from 'tc-core-library-js';
import { authorizeAccessPolicy } from './access-control';

/** Adapts the shared verifier to Mastra without changing route authorization. */
export class SharedJwtAuth extends MastraAuthProvider<AuthUser> {
  private readonly verifier: JwtVerifier;

  constructor(options: MastraAuthProviderOptions<AuthUser> & { jwt: JwtConfiguration }) {
    super({ name: options.name ?? 'topcoder-jwt' });
    this.verifier = createJwtVerifier(options.jwt);
    this.registerOptions(options);
  }

  async authenticateToken(token: string): Promise<AuthUser | null> {
    try {
      return await this.verifier.verify(token);
    } catch {
      return null;
    }
  }

  authorizeUser(user: AuthUser, request: MastraAuthRequest): boolean {
    return authorizeAccessPolicy(user, request);
  }
}
