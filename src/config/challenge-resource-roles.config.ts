/**
 * Caller-facing role categories, mapped to the actual `GET /v6/resource-roles`
 * `name` values each one covers. Verified against the live resource-roles
 * list (26 entries, prod, 2026-09-16) — see ADR 0005. A category name absent
 * here, or a listed role name that no longer exists upstream, is a code
 * change (this map), not a runtime guess: resolution fails loud (Decision 2)
 * rather than silently returning nothing.
 *
 * Flipping/extending an entry is a reviewable decision, same convention as
 * TOOL_M2M_FALLBACK_CONFIG and DEFAULT_ACCESS_POLICIES.
 */
export const CHALLENGE_RESOURCE_ROLE_CATEGORIES = {
    copilot: ['Copilot'],
    reviewers: [
        'Reviewer',
        'Iterative Reviewer',
        'Final Reviewer',
        'Screener',
        'Primary Screener',
        'Checkpoint Screener',
        'Checkpoint Reviewer',
        'Accuracy Reviewer',
        'Stress Reviewer',
        'Specification Reviewer',
        'Post-Mortem Reviewer',
        'Failure Reviewer',
        'Aggregator',
        'Approver',
    ],
    registrants: ['Submitter'], // no role is literally named "Registrant" (verified)
    managers: ['Manager', 'Client Manager'], // Payment Manager deliberately excluded — billing role, not a challenge-run role
    observers: ['Observer'],
} as const;

export type ChallengeResourceCategory = keyof typeof CHALLENGE_RESOURCE_ROLE_CATEGORIES;
