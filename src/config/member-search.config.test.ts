import { describe, it, expect } from 'vitest';
import { MEMBER_SEARCH_PREFERRED_ROLES } from './member-search.config';

describe('MEMBER_SEARCH_PREFERRED_ROLES', () => {
    it('is non-empty with unique upper-snake-case codes', () => {
        expect(MEMBER_SEARCH_PREFERRED_ROLES.length).toBeGreaterThan(0);
        const values = MEMBER_SEARCH_PREFERRED_ROLES.map((r) => r.value);
        expect(new Set(values).size).toBe(values.length);
        for (const value of values) {
            expect(value).toMatch(/^[A-Z][A-Z0-9_]*$/);
        }
    });

    it('matches the search-members preferredRole enum values', async () => {
        const { preferredRoleEnumValues } = await import('../mastra/tools/member/search-members-tool');
        const fromConstant = MEMBER_SEARCH_PREFERRED_ROLES.map((r) => r.value).sort();
        expect([...preferredRoleEnumValues].sort()).toEqual(fromConstant);
    });
});
