import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { createOllama } from 'ai-sdk-ollama';
import { _testing } from '../../../src/mastra/workflows/challenge/challenge-context-workflow';

const {
    buildChallengeText,
    extractRequirementsAndGroups,
    extractTechAndRuntime,
    extractExistingCodebase,
    extractSubmissionGuidelines,
    validateWhatToSubmit,
    validateTechStack,
    validateRuntimeEnvironment,
} = _testing;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OLLAMA_URL = process.env.OLLAMA_API_URL || 'http://localhost:11434';
const MODEL = process.env.TEST_MODEL || 'mistral:latest';
const CALL_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

interface Fixture {
    data: Record<string, any>;
    challengeText: string;
    description: string;
    expected: {
        techStackMustIncludeAny: string[];
        whatToSubmitMustNotInclude: string[];
        minRequirements: number;
        maxRequirements: number;
    };
}

function loadFixture(name: string): Fixture {
    const raw = readFileSync(
        resolve(__dirname, '../../fixtures', `${name}.json`),
        'utf-8',
    );
    const data = JSON.parse(raw);
    const expected = data._expectedContext;
    return {
        data,
        challengeText: buildChallengeText(data),
        description: data.description ?? '',
        expected,
    };
}

// ---------------------------------------------------------------------------
// Agent factory — uses local Ollama, same config as production agent
// ---------------------------------------------------------------------------

function createTestAgent(): Agent {
    const ollama = createOllama({ baseURL: OLLAMA_URL });
    return new Agent({
        id: 'test-challenge-parser-agent',
        name: 'Test Challenge Parser',
        model: ollama(MODEL, {
            options: {
                temperature: 0.1,
                top_k: 40,
                top_p: 0.9,
                repeat_penalty: 1.15,
                repeat_last_n: 192,
                num_ctx: 16384,
                num_predict: 8192,
                num_batch: 256,
            },
        }),
        instructions: {
            role: 'system',
            content: `You are an expert Topcoder challenge specification analyst.
Your sole job is to read the FULL challenge specification and produce a structured JSON
object that captures every requirement, technology, and submission guideline.

STRICT OUTPUT CONTRACT: Return ONLY the JSON object matching the provided schema.
Do NOT add commentary, markdown fences, or extra keys.
Every field is mandatory per the schema — never omit a key.

CRITICAL — submission guidelines:
- List ONLY deliverables the spec EXPLICITLY asks the submitter to deliver.
- Do NOT add deliverables inferred from evaluation criteria or review rubrics.
- Do NOT include "test cases" or "unit tests" unless the spec explicitly says to submit them.
- Do NOT list "documentation" separately when "README" is already listed.
/no_think`,
        },
    });
}

// ---------------------------------------------------------------------------
// Ollama connectivity check
// ---------------------------------------------------------------------------

let ollamaAvailable = false;

beforeAll(async () => {
    try {
        const res = await fetch(`${OLLAMA_URL}/api/tags`, {
            signal: AbortSignal.timeout(5_000),
        });
        ollamaAvailable = res.ok;
    } catch {
        ollamaAvailable = false;
    }

    if (!ollamaAvailable) {
        console.warn(
            `\n  Ollama not reachable at ${OLLAMA_URL} — AI integration tests will be skipped.\n`
            + '   Start Ollama or set OLLAMA_API_URL to run these tests.\n',
        );
    }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('challenge-context extraction (integration)', () => {
    let agent: Agent;
    let fixture: Fixture;

    beforeAll(() => {
        fixture = loadFixture('github-skills-import');
        if (ollamaAvailable) {
            agent = createTestAgent();
        }
    });

    // -- Requirements + Grouping -----------------------------------------------

    describe('extractRequirementsAndGroups', () => {
        it('extracts requirements with valid IDs and structure', async () => {
            if (!ollamaAvailable) return;

            const t0 = performance.now();
            const result = await extractRequirementsAndGroups(agent, fixture.challengeText);
            const elapsed = performance.now() - t0;
            console.log(`  extractRequirementsAndGroups: ${(elapsed / 1000).toFixed(1)}s`);
            console.log(`  requirements: ${result.requirements.length}, groups: ${result.requirement_groups.length}`);

            expect(result.requirements.length).toBeGreaterThanOrEqual(fixture.expected.minRequirements);
            expect(result.requirements.length).toBeLessThanOrEqual(fixture.expected.maxRequirements);

            for (const req of result.requirements) {
                expect(req.id).toMatch(/^REQ_\d+$/);
                expect(req.title).toBeTruthy();
                expect(req.description).toBeTruthy();
                expect(['high', 'medium', 'low']).toContain(req.priority);
                expect(Array.isArray(req.constraints)).toBe(true);
            }

            // Every requirement appears in exactly one group
            const allGroupedReqIds = result.requirement_groups.flatMap(g => g.requirementIds);
            const reqIds = result.requirements.map(r => r.id);
            expect(new Set(allGroupedReqIds).size).toBe(allGroupedReqIds.length);
            for (const id of reqIds) {
                expect(allGroupedReqIds).toContain(id);
            }

            for (const group of result.requirement_groups) {
                expect(group.id).toMatch(/^GRP_\d+$/);
                expect(group.name).toBeTruthy();
                expect(group.requirementIds.length).toBeGreaterThan(0);
            }
        }, CALL_TIMEOUT_MS);
    });

    // -- Tech Stack + Runtime --------------------------------------------------

    describe('extractTechAndRuntime', () => {
        it('extracts at least one expected technology', async () => {
            if (!ollamaAvailable) return;

            const t0 = performance.now();
            const result = await extractTechAndRuntime(agent, fixture.challengeText);
            const elapsed = performance.now() - t0;
            console.log(`  extractTechAndRuntime: ${(elapsed / 1000).toFixed(1)}s`);
            console.log(`  tech_stack: [${result.tech_stack.join(', ')}]`);

            expect(result.tech_stack.length).toBeGreaterThan(0);

            // At least one of the expected techs must appear (case-insensitive)
            const techLower = result.tech_stack.map(t => t.toLowerCase());
            const found = fixture.expected.techStackMustIncludeAny.some(
                expected => techLower.some(t => t.includes(expected.toLowerCase())),
            );
            expect(found).toBe(true);

            // No exact duplicates
            expect(new Set(result.tech_stack).size).toBe(result.tech_stack.length);

            // Runtime environment basic structure
            expect(result.runtime_environment.programmingLanguages.length).toBeGreaterThan(0);
            expect(result.runtime_environment.os).toBeTruthy();
        }, CALL_TIMEOUT_MS);
    });

    // -- Codebase Detection ----------------------------------------------------

    describe('extractExistingCodebase', () => {
        it('returns valid codebase structure with a summary', async () => {
            if (!ollamaAvailable) return;

            const t0 = performance.now();
            const result = await extractExistingCodebase(agent, fixture.challengeText);
            const elapsed = performance.now() - t0;
            console.log(`  extractExistingCodebase: ${(elapsed / 1000).toFixed(1)}s`);
            console.log(`  greenfield: ${result.existing_codebase.isGreenfield}, artifacts: ${result.existing_codebase.artifacts.length}`);

            expect(typeof result.existing_codebase.isGreenfield).toBe('boolean');
            expect(result.existing_codebase.summary).toBeTruthy();
            expect(Array.isArray(result.existing_codebase.artifacts)).toBe(true);
        }, CALL_TIMEOUT_MS);
    });

    // -- Submission Guidelines -------------------------------------------------

    describe('extractSubmissionGuidelines', () => {
        it('does not include hallucinated deliverables', async () => {
            if (!ollamaAvailable) return;

            const t0 = performance.now();
            const result = await extractSubmissionGuidelines(agent, fixture.challengeText);
            const elapsed = performance.now() - t0;
            console.log(`  extractSubmissionGuidelines: ${(elapsed / 1000).toFixed(1)}s`);
            console.log(`  whatToSubmit: [${result.submission_guidelines.whatToSubmit.join(', ')}]`);

            const guidelines = result.submission_guidelines;
            expect(guidelines.summary).toBeTruthy();
            expect(guidelines.whatToSubmit.length).toBeGreaterThan(0);

            const deliverablesLower = guidelines.whatToSubmit.map(d => d.toLowerCase());

            for (const mustNot of fixture.expected.whatToSubmitMustNotInclude) {
                expect(
                    deliverablesLower.some(d => d.includes(mustNot.toLowerCase())),
                ).toBe(false);
            }
        }, CALL_TIMEOUT_MS);
    });

    // -- validateWhatToSubmit (deterministic, no Ollama needed) -----------------

    describe('validateWhatToSubmit', () => {
        it('prunes hallucinated deliverables', () => {
            const items = ['Source code', 'README.md', 'Test cases', 'Documentation'];
            const result = validateWhatToSubmit(items, fixture.description);

            const resultLower = result.map(r => r.toLowerCase());
            expect(resultLower).not.toContain('test cases');
        });

        it('keeps canonical deliverables even if not literally in spec', () => {
            const items = ['Source code', 'README.md'];
            const result = validateWhatToSubmit(items, fixture.description);
            expect(result.length).toBe(2);
        });

        it('returns original list when all items would be pruned', () => {
            const items = ['Completely fabricated item'];
            const result = validateWhatToSubmit(items, fixture.description);
            expect(result).toEqual(items);
        });

        it('handles empty description gracefully', () => {
            const items = ['Source code', 'Test cases'];
            const result = validateWhatToSubmit(items, '');
            expect(result).toEqual(items);
        });
    });

    // -- validateTechStack (deterministic, no Ollama needed) -------------------

    describe('validateTechStack', () => {
        it('removes platform review infrastructure items', () => {
            const items = ['TypeScript', 'SAST Scanner', 'Node.js', 'Vulnerability Scanner'];
            const result = validateTechStack(items);
            expect(result).toEqual(['TypeScript', 'Node.js']);
        });

        it('removes Topcoder platform tooling', () => {
            const items = ['React', 'Topcoder Review Bot', 'PostgreSQL'];
            const result = validateTechStack(items);
            expect(result).toEqual(['React', 'PostgreSQL']);
        });

        it('removes generic non-technology categories', () => {
            const items = ['TypeScript', 'Security', 'Testing', 'Docker', 'Documentation'];
            const result = validateTechStack(items);
            expect(result).toEqual(['TypeScript', 'Docker']);
        });

        it('keeps legitimate technologies untouched', () => {
            const items = ['TypeScript', 'GitHub API', 'OAuth 2.0', 'REST', 'Node.js'];
            const result = validateTechStack(items);
            expect(result).toEqual(items);
        });

        it('returns original list if all items would be pruned', () => {
            const items = ['SAST Scanner'];
            const result = validateTechStack(items);
            expect(result).toEqual(items);
        });
    });

    // -- validateRuntimeEnvironment (deterministic, no Ollama needed) ----------

    describe('validateRuntimeEnvironment', () => {
        const baseEnv = {
            os: 'Linux/macOS',
            containerized: false,
            runtimeEngine: 'Node.js',
            programmingLanguages: ['TypeScript'],
            packageManager: 'npm',
            buildTool: 'tsc',
            deploymentTarget: 'topcoder_platform',
            serverType: 'REST API',
            databaseEngine: 'none',
            additionalServices: [],
        };

        it('overrides serverType to CLI when description says "command line app"', () => {
            const desc = 'Build a simple command line app that does X.';
            const result = validateRuntimeEnvironment(baseEnv, desc);
            expect(result.serverType).toBe('CLI');
        });

        it('overrides deploymentTarget from topcoder_platform to local for CLI app', () => {
            const desc = 'Build a command line application that processes data.';
            const result = validateRuntimeEnvironment(baseEnv, desc);
            expect(result.deploymentTarget).toBe('local');
        });

        it('overrides os to unknown when not mentioned in description', () => {
            const desc = 'Build a CLI tool that analyzes GitHub repos.';
            const result = validateRuntimeEnvironment(baseEnv, desc);
            expect(result.os).toBe('unknown');
        });

        it('keeps os when explicitly mentioned in description', () => {
            const desc = 'This app must run on Linux servers.';
            const env = { ...baseEnv, os: 'Linux' };
            const result = validateRuntimeEnvironment(env, desc);
            expect(result.os).toBe('Linux');
        });

        it('does not override serverType when app is not a CLI', () => {
            const desc = 'Build a REST API service that exposes endpoints.';
            const result = validateRuntimeEnvironment(baseEnv, desc);
            expect(result.serverType).toBe('REST API');
        });

        it('overrides deploymentTarget from submission_platform even for non-CLI', () => {
            const desc = 'Build a web API.';
            const env = { ...baseEnv, serverType: 'Express', deploymentTarget: 'Topcoder submission page' };
            const result = validateRuntimeEnvironment(env, desc);
            expect(result.deploymentTarget).toBe('unknown');
        });

        it('handles empty description gracefully', () => {
            const result = validateRuntimeEnvironment(baseEnv, '');
            expect(result).toEqual(baseEnv);
        });

        it('does not match OS names inside URLs', () => {
            const desc = 'Check https://docs.example.com/linux-setup for details. Build a CLI tool.';
            const env = { ...baseEnv, os: 'Linux' };
            const result = validateRuntimeEnvironment(env, desc);
            // "linux" appears but inside a URL-like context — should reset
            expect(result.os).toBe('unknown');
        });
    });

    // -- Determinism check -----------------------------------------------------

    describe('determinism', () => {
        it('produces consistent tech stack across two runs', async () => {
            if (!ollamaAvailable) return;

            const [run1, run2] = await Promise.all([
                extractTechAndRuntime(agent, fixture.challengeText),
                extractTechAndRuntime(agent, fixture.challengeText),
            ]);

            console.log(`  run1 tech_stack: [${run1.tech_stack.join(', ')}]`);
            console.log(`  run2 tech_stack: [${run2.tech_stack.join(', ')}]`);

            // Same count (allow +-2 for minor nondeterminism)
            expect(
                Math.abs(run1.tech_stack.length - run2.tech_stack.length),
            ).toBeLessThanOrEqual(2);
        }, CALL_TIMEOUT_MS * 2);

        it('produces consistent codebase detection across two runs', async () => {
            if (!ollamaAvailable) return;

            const [cb1, cb2] = await Promise.all([
                extractExistingCodebase(agent, fixture.challengeText),
                extractExistingCodebase(agent, fixture.challengeText),
            ]);

            expect(cb1.existing_codebase.isGreenfield).toBe(cb2.existing_codebase.isGreenfield);
        }, CALL_TIMEOUT_MS * 2);
    });
});
