import { describe, it, expect, beforeEach, vi } from 'vitest';

const { fuzzyExecute, semanticExecute } = vi.hoisted(() => ({
    fuzzyExecute: vi.fn(),
    semanticExecute: vi.fn(),
}));

vi.mock('./standardized-skills-fuzzy-tool', () => ({
    standardizedSkillsFuzzyTool: { execute: fuzzyExecute },
}));
vi.mock('./standardized-skills-semantic-tool', () => ({
    standardizedSkillsSemanticTool: { execute: semanticExecute },
}));

import {
    dedupeResolvedSkills,
    findBestKeyMatch,
    getKeyMatchTier,
    normalizeSkillKey,
    resolveSkillTerms,
} from './skill-term-resolver';

const REACT_JS = { id: '4458454c-9a97-4332-a545-6546e240dab6', name: 'React.js' };
const FLUX_REACT = { id: 'flux-id', name: 'Flux (React.js)' };
const NODE_JS = { id: 'node-id', name: 'Node.js' };
const NODES = { id: 'nodes-id', name: 'Nodes' };
const AWS = { id: 'aws-id', name: 'Amazon Web Services (AWS)' };
const SFDC = { id: 'c8670c34-1020-4255-9296-6ea4fb8893e1', name: 'Salesforce Development (SFDC)' };
const PYTHON = { id: 'python-id', name: 'Python' };

describe('normalizeSkillKey and key tiers', () => {
    it('normalizes react js variants to reactjs', () => {
        expect(normalizeSkillKey('react js')).toBe('reactjs');
        expect(normalizeSkillKey('React.JS')).toBe('reactjs');
    });

    it('prefers React.js over Flux (React.js) for react.js via tier and name length', () => {
        expect(getKeyMatchTier('reactjs', 'React.js')).toBe(1);
        expect(getKeyMatchTier('reactjs', 'Flux (React.js)')).toBe(2);
        const best = findBestKeyMatch('react.js', [FLUX_REACT, REACT_JS]);
        expect(best?.candidate.name).toBe('React.js');
    });

    it('maps react and node via js tier', () => {
        expect(getKeyMatchTier('react', 'React.js')).toBe(3);
        expect(getKeyMatchTier('node', 'Node.js')).toBe(3);
    });
});

describe('resolveSkillTerms', () => {
    beforeEach(() => {
        fuzzyExecute.mockReset();
        semanticExecute.mockReset();
        vi.stubGlobal('fetch', vi.fn());
    });

    it('resolves aws and sfdc via fuzzy alias (paren tier)', async () => {
        fuzzyExecute.mockImplementation(async ({ term }: { term: string }) => {
            if (term === 'aws') return { matches: [AWS, { id: 'x', name: 'AWS Amplify' }] };
            if (term === 'sfdc') return { matches: [SFDC] };
            return { matches: [] };
        });
        semanticExecute.mockResolvedValue({ matches: [] });

        const results = await resolveSkillTerms([{ skill: 'aws' }, { skill: 'sfdc' }]);
        expect(results[0]).toMatchObject({ status: 'resolved', name: AWS.name, matchedBy: 'alias' });
        expect(results[1]).toMatchObject({ status: 'resolved', name: SFDC.name, matchedBy: 'alias' });
        expect(fuzzyExecute).toHaveBeenCalledWith(
            expect.objectContaining({ term: 'aws', size: 20 }),
            expect.anything(),
        );
    });

    it('resolves react and node via fuzzy js tier', async () => {
        fuzzyExecute.mockImplementation(async ({ term }: { term: string }) => {
            if (term === 'react') {
                return {
                    matches: [
                        { id: '1', name: 'Create React App' },
                        FLUX_REACT,
                        REACT_JS,
                    ],
                };
            }
            if (term === 'node') {
                return {
                    matches: [
                        { id: '1', name: 'eNodeB (LTE Technology)' },
                        { id: '2', name: 'Inode' },
                        { id: '3', name: 'Linode' },
                        { id: '4', name: 'NameNode' },
                        { id: '5', name: 'Node B' },
                        NODE_JS,
                    ],
                };
            }
            return { matches: [] };
        });
        semanticExecute.mockResolvedValue({ matches: [] });

        const results = await resolveSkillTerms([{ skill: 'react' }, { skill: 'node' }]);
        expect(results[0]).toMatchObject({ status: 'resolved', name: 'React.js', matchedBy: 'alias' });
        expect(results[1]).toMatchObject({ status: 'resolved', name: 'Node.js', matchedBy: 'alias' });
    });

    it('falls back to semantic for reactjs when fuzzy has no key match', async () => {
        fuzzyExecute.mockResolvedValue({ matches: [] });
        semanticExecute.mockResolvedValue({
            matches: [{ ...REACT_JS, weighted_distance: 0.379 }],
        });

        const [result] = await resolveSkillTerms([{ skill: 'reactjs' }]);
        expect(result).toMatchObject({ status: 'resolved', name: 'React.js', matchedBy: 'exact' });
    });

    it('uses semantic key match so node resolves to Node.js not Nodes', async () => {
        fuzzyExecute.mockResolvedValue({ matches: [] });
        semanticExecute.mockResolvedValue({
            matches: [
                { ...NODES, weighted_distance: 0.592 },
                { ...NODE_JS, weighted_distance: 0.978 },
            ],
        });

        const [result] = await resolveSkillTerms([{ skill: 'node' }]);
        expect(result).toMatchObject({ status: 'resolved', name: 'Node.js', matchedBy: 'alias' });
    });

    it('resolves large language models via semantic threshold', async () => {
        fuzzyExecute.mockResolvedValue({ matches: [] });
        semanticExecute.mockResolvedValue({
            matches: [{ id: 'llm-id', name: 'Large Language Modeling', weighted_distance: 0.527 }],
        });

        const [result] = await resolveSkillTerms([{ skill: 'large language models' }]);
        expect(result).toMatchObject({ status: 'resolved', matchedBy: 'semantic' });
    });

    it('returns ambiguous for salesforce with multiple word matches', async () => {
        fuzzyExecute.mockResolvedValue({
            matches: [
                { id: 'a', name: 'Salesforce Apex' },
                SFDC,
                { id: 'c', name: 'Salesforce Object Query Language (SOQL)' },
            ],
        });
        semanticExecute.mockResolvedValue({
            matches: [
                { id: 'a', name: 'Salesforce Apex', weighted_distance: 0.864 },
                { id: 'b', name: 'Salesforce Security', weighted_distance: 0.958 },
                SFDC,
            ],
        });

        const [result] = await resolveSkillTerms([{ skill: 'salesforce' }]);
        expect(result.status).toBe('ambiguous');
        if (result.status === 'ambiguous') {
            expect(result.candidates.length).toBeGreaterThan(1);
            expect(result.candidates.some((c) => c.name === SFDC.name)).toBe(true);
        }
    });

    it('returns unresolved for xyzzy framework', async () => {
        fuzzyExecute.mockResolvedValue({ matches: [] });
        semanticExecute.mockResolvedValue({ matches: [] });

        const [result] = await resolveSkillTerms([{ skill: 'xyzzy framework' }]);
        expect(result).toMatchObject({ status: 'unresolved' });
    });

    it('looks up UUID via skills API', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ name: 'React.js' }),
        } as Response);
        fuzzyExecute.mockResolvedValue({ matches: [] });
        semanticExecute.mockResolvedValue({ matches: [] });

        const [result] = await resolveSkillTerms([{ skill: REACT_JS.id }]);
        expect(result).toMatchObject({ status: 'resolved', matchedBy: 'id', name: 'React.js' });
    });

    it('dedupes resolved skills keeping max minWins', () => {
        const resolutions = [
            {
                input: 'react',
                status: 'resolved' as const,
                id: REACT_JS.id,
                name: REACT_JS.name,
                matchedBy: 'alias' as const,
                minWins: 2,
            },
            {
                input: 'reactjs',
                status: 'resolved' as const,
                id: REACT_JS.id,
                name: REACT_JS.name,
                matchedBy: 'exact' as const,
                minWins: 5,
            },
        ];
        const deduped = dedupeResolvedSkills(resolutions);
        expect(deduped).toHaveLength(1);
        expect(deduped[0].minWins).toBe(5);
    });

    it('still tries semantic when fuzzy throws', async () => {
        fuzzyExecute.mockRejectedValue(new Error('network'));
        semanticExecute.mockResolvedValue({
            matches: [{ ...PYTHON, weighted_distance: 0.35 }],
        });

        const [result] = await resolveSkillTerms([{ skill: 'python' }]);
        expect(result).toMatchObject({ status: 'resolved', name: 'Python' });
    });
});
