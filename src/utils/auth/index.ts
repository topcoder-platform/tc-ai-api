import { MastraAuthAuth0 } from '@mastra/auth-auth0';
import { CompositeAuth, type MastraAuthProvider } from '@mastra/core/server';
import type { HonoRequest } from 'hono';

const STUDIO_PUBLIC_PATHS = [
  /^\/studio(?:\/.*)?$/,
];

const REQUEST_CONTEXT_TOKEN_KEYS = [
  'jwt',
  'token',
  'authToken',
  'accessToken',
  'bearerToken',
  'authorization',
  'Authorization',
  'apiKey',
];

export class StudioBypassAuth extends CompositeAuth {
  constructor(providers: MastraAuthProvider[]) {
    super(providers);
    this.public = STUDIO_PUBLIC_PATHS;
  }

  override async authenticateToken(token: string, request: HonoRequest): Promise<unknown | null> {
    const rawRequest = this.toRawRequest(request);

    for (const candidate of await this.resolveCandidateTokens(rawRequest, token)) {
      const user = await super.authenticateToken(candidate, request);
      if (user) {
        return user;
      }
    }

    return null;
  }

  override async getCurrentUser(request: Request): Promise<any | null> {
    const user = await super.getCurrentUser(request);
    if (user) {
      return user;
    }

    for (const candidate of await this.resolveCandidateTokens(request)) {
      const tokenUser = await super.authenticateToken(candidate, request as unknown as HonoRequest);
      if (tokenUser) {
        return tokenUser;
      }
    }

    return null;
  }

  private toRawRequest(request: Request | HonoRequest): Request {
    return 'raw' in request ? request.raw : request;
  }

  private async resolveCandidateTokens(request: Request, explicitToken?: string): Promise<string[]> {
    const candidates = new Set<string>();

    for (const token of [
      explicitToken,
      this.readBearerToken(request.headers.get('authorization')),
      this.readBearerToken(request.headers.get('Authorization')),
      this.readQueryToken(request),
      await this.readRequestContextToken(request),
    ]) {
      if (token) {
        candidates.add(token);
      }
    }

    return [...candidates];
  }

  private readQueryToken(request: Request): string | undefined {
    const url = new URL(request.url);
    const queryToken = url.searchParams.get('apiKey');

    return queryToken?.trim() || undefined;
  }

  private async readRequestContextToken(request: Request): Promise<string | undefined> {
    const url = new URL(request.url);
    const encodedRequestContext = url.searchParams.get('requestContext');
    const queryContext = this.parseRequestContext(encodedRequestContext);
    const queryToken = this.extractRequestContextToken(queryContext);
    if (queryToken) {
      return queryToken;
    }

    const method = request.method.toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return undefined;
    }

    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return undefined;
    }

    try {
      const body = await request.clone().json();
      if (!body || typeof body !== 'object') {
        return undefined;
      }

      return this.extractRequestContextToken((body as Record<string, unknown>).requestContext);
    } catch {
      return undefined;
    }
  }

  private parseRequestContext(encodedRequestContext: string | null): unknown {
    if (!encodedRequestContext) {
      return undefined;
    }

    try {
      const decoded = Buffer.from(encodedRequestContext, 'base64').toString('utf8');
      return JSON.parse(decoded);
    } catch {
      return undefined;
    }
  }

  private extractRequestContextToken(requestContext: unknown): string | undefined {
    if (!requestContext || typeof requestContext !== 'object' || Array.isArray(requestContext)) {
      return undefined;
    }

    for (const key of REQUEST_CONTEXT_TOKEN_KEYS) {
      const rawValue = (requestContext as Record<string, unknown>)[key];
      if (typeof rawValue === 'string') {
        const token = this.readBearerToken(rawValue);
        if (token) {
          return token;
        }
      }
    }

    return undefined;
  }

  private readBearerToken(value: string | null | undefined): string | undefined {
    if (!value) {
      return undefined;
    }

    const trimmedValue = value.trim();
    if (!trimmedValue) {
      return undefined;
    }

    if (/^bearer\s+/i.test(trimmedValue)) {
      return trimmedValue.replace(/^bearer\s+/i, '').trim() || undefined;
    }

    return trimmedValue;
  }
}

export const apiAuthLayer = new StudioBypassAuth([
  // TC Member Auth0 JWTs
  new MastraAuthAuth0({
    domain: process.env.AUTH0_DOMAIN,
    audience: process.env.AUTH0_AUDIENCE,
  }),
  // TC M2M Auth0 JWTs
  new MastraAuthAuth0({
    domain: process.env.AUTH0_M2M_DOMAIN,
    audience: process.env.AUTH0_M2M_AUDIENCE,
  }),
]);
