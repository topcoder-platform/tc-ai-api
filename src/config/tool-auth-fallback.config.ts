/**
 * Per-tool opt-in for falling back to the service M2M token when a
 * Topcoder platform call made with the requestor's own token fails with
 * 401/403. See docs/adr/0002-tc-api-requestor-token-with-m2m-fallback.md.
 *
 * A tool id absent from this map is treated as `false`. Off by default —
 * add an entry (`true`) only when a tool must keep working even if the
 * requestor's own token can't reach the endpoint it calls. Treat flipping
 * an entry to `true` as a reviewable privilege-escalation decision.
 */
export const TOOL_M2M_FALLBACK_CONFIG: Record<string, boolean> = {};
