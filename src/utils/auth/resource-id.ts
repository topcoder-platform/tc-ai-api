/**
 * Maps a verified principal to its isolated Mastra memory resource.
 * @param user Shared-core principal. Members retain their numeric ID as a string.
 * @returns Member ID or issuer/client-specific service resource, undefined for invalid identities.
 * Does not throw or infer identity from raw token claims; used by auth and resource middleware.
 */
export function mapUserToResourceId(user: Record<string, unknown>): string | undefined {
  if (user.kind === 'user' && user.isMachine === false && typeof user.userId === 'number' && user.userId > 0) {
    return String(user.userId);
  }
  if (user.kind === 'service' && user.isMachine === true && typeof user.iss === 'string' &&
      typeof user.clientId === 'string' && user.clientId) {
    return `service:${encodeURIComponent(user.iss)}:${encodeURIComponent(user.clientId)}`;
  }
  return undefined;
}
