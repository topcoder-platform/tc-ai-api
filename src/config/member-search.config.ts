/**
 * Open-to-work preferred roles accepted by POST /v6/reports/member/search `preferredRoles`.
 * See docs/adr/0008-member-search-tool.md.
 *
 * Source of truth: platform-ui `preferredRoleOptions`
 * (src/libs/shared/lib/constants/index.ts) — the Talent Search "Preferred role" picker.
 * Upstream matches `value` exactly (upper-cased); a value it doesn't know returns no
 * members and no error, so keep this list in sync with the picker.
 *
 * To add, rename or remove a role, edit this list only: the search-members tool's input
 * enum, its description, and the labels in its output are all derived from it.
 */
export const MEMBER_SEARCH_PREFERRED_ROLES = [
    { value: 'AI_ML_ENGINEER', label: 'AI / ML Engineer' },
    { value: 'DATA_SCIENTIST_ENGINEER', label: 'Data Scientist / Data Engineer' },
    { value: 'CYBERSECURITY_ENGINEER', label: 'Cybersecurity Analyst / Security Engineer' },
    { value: 'CLOUD_ENGINEER', label: 'Cloud Engineer / Solutions Architect' },
    { value: 'DEVOPS_SRE', label: 'DevOps Engineer / SRE' },
    { value: 'FULL_STACK_DEVELOPER', label: 'Full-Stack Developer' },
    { value: 'QA_AUTOMATION_ENGINEER', label: 'QA Lead / Automation Engineer' },
    { value: 'UX_DESIGNER', label: 'UX Designer' },
    { value: 'TECHNICAL_PM', label: 'Technical Project Manager' },
    { value: 'DB_ADMIN', label: 'Database Administrator' },
    { value: 'AI_PROMPT_ENGINEER', label: 'AI Prompt Engineer' },
    { value: 'ENTERPRISE_ARCHITECT', label: 'Enterprise Architect' },
] as const satisfies readonly { value: string; label: string }[];
