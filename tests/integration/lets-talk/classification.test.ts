/**
 * Live eval of the lets-talk-classification workflow against real Bedrock
 * (Claude Haiku 4.5 by default). Opt-in — it costs money and needs AWS
 * credentials:
 *
 *   LETS_TALK_EVAL=true AWS_REGION=us-east-1 pnpm test:integration tests/integration/lets-talk
 *
 * Pass criteria (docs/adr/0010-lets-talk-classification.md):
 *  - accuracy ≥ 90% on tests/fixtures/lets-talk-samples.json;
 *  - every output passes the workflow output schema;
 *  - detectedLanguage is correct for the non-English samples;
 *  - L4 corrective re-run rate < 2%. The L2 retry rate is reported.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { RequestContext } from '@mastra/core/request-context';
import type { WorkflowRunState } from '@mastra/core/workflows';

// Local-dev-only scorers; their module pulls in the Auth0-dependent utils barrel.
vi.mock('../../../src/mastra/scorers/instance-scorers', () => ({ instanceScorers: {} }));

const { letsTalkClassifierAgent } = await import('../../../src/mastra/agents/lets-talk/lets-talk-classifier-agent');
const { letsTalkClassificationWorkflow } = await import(
    '../../../src/mastra/workflows/lets-talk/lets-talk-classification-workflow'
);
const { letsTalkClassificationOutputSchema } = await import('../../../src/mastra/workflows/lets-talk/lets-talk-schemas');

interface Sample {
    id: string;
    expected: string;
    language: string;
    member?: boolean;
    submission: Record<string, string>;
}

interface Outcome {
    sample: Sample;
    output?: Record<string, any>;
    meta?: Record<string, any>;
    error?: string;
}

const samples = JSON.parse(
    readFileSync(resolve(__dirname, '../../fixtures/lets-talk-samples.json'), 'utf-8'),
) as Sample[];

const ENABLED = process.env.LETS_TALK_EVAL === 'true';
const CONCURRENCY = Number(process.env.LETS_TALK_EVAL_CONCURRENCY || 4);

describe.skipIf(!ENABLED)("lets-talk classification — live eval", () => {
    let mastra: Mastra;
    const outcomes: Outcome[] = [];

    beforeAll(async () => {
        mastra = new Mastra({
            workflows: { letsTalkClassificationWorkflow },
            agents: { letsTalkClassifierAgent },
            storage: new LibSQLStore({ id: 'lets-talk-eval', url: ':memory:' }),
            logger: false,
        });

        const queue = [...samples];
        const worker = async () => {
            for (let sample = queue.shift(); sample; sample = queue.shift()) {
                outcomes.push(await classify(sample));
            }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    }, 600_000);

    afterAll(async () => {
        await mastra?.shutdown?.();
    });

    async function classify(sample: Sample): Promise<Outcome> {
        const runId = randomUUID();
        const run = await mastra.getWorkflow('letsTalkClassificationWorkflow').createRun({ runId });
        const result = await run.start({
            inputData: {
                submissionId: randomUUID(),
                submittedAt: new Date().toISOString(),
                ...(sample.member ? { memberId: '40000001' } : {}),
                ...sample.submission,
            } as never,
            requestContext: new RequestContext(),
        });

        const store = await mastra.getStorage()!.getStore('workflows');
        const row = await store!.getWorkflowRunById({ runId, workflowName: 'lets-talk-classification' });
        const snapshot = (typeof row!.snapshot === 'string' ? JSON.parse(row!.snapshot) : row!.snapshot) as WorkflowRunState;
        const meta = (snapshot.context['classify-submission'] as { output?: { meta?: Record<string, any> } } | undefined)
            ?.output?.meta;

        if (result.status !== 'success') {
            return { sample, meta, error: (result as { error?: { message?: string } }).error?.message ?? result.status };
        }
        return { sample, meta, output: (result as { result: Record<string, any> }).result };
    }

    it('reports the eval', () => {
        const rows = outcomes.map(({ sample, output, meta, error }) => ({
            id: sample.id,
            expected: sample.expected,
            got: output?.classification ?? `ERROR ${error}`,
            confidence: output?.confidence,
            review: output?.needsReview,
            lang: `${sample.language}/${output?.detectedLanguage ?? '-'}`,
            attempts: meta?.attempts,
            l2: meta?.processorRetries,
            tokens: meta?.tokenUsage?.totalTokens,
        }));
        console.table(rows);

        // Per expected class, so a weak class can't hide behind the overall rate.
        const perClass = new Map<string, { ok: number; total: number }>();
        for (const o of outcomes) {
            const entry = perClass.get(o.sample.expected) ?? { ok: 0, total: 0 };
            entry.total += 1;
            if (o.output?.classification === o.sample.expected) entry.ok += 1;
            perClass.set(o.sample.expected, entry);
        }
        console.table([...perClass].map(([expected, { ok, total }]) => ({ expected, ok, total })));

        const ok = outcomes.filter((o) => o.output?.classification === o.sample.expected).length;
        const l2 = outcomes.reduce((sum, o) => sum + (o.meta?.processorRetries ?? 0), 0);
        const l4 = outcomes.filter((o) => (o.meta?.attempts ?? 1) > 1).length;
        const tokens = outcomes.reduce((sum, o) => sum + (o.meta?.tokenUsage?.totalTokens ?? 0), 0);
        console.log(
            `accuracy ${ok}/${outcomes.length} (${((100 * ok) / outcomes.length).toFixed(1)}%), ` +
            `L2 retries ${l2} (${(l2 / outcomes.length).toFixed(2)}/run), ` +
            `L4 re-runs ${l4} (${((100 * l4) / outcomes.length).toFixed(1)}%), ` +
            `avg tokens/run ${Math.round(tokens / outcomes.length)}`,
        );
        expect(outcomes).toHaveLength(samples.length);
    });

    it('produces a schema-valid output for every sample', () => {
        for (const outcome of outcomes) {
            expect(outcome.error, outcome.sample.id).toBeUndefined();
            expect(letsTalkClassificationOutputSchema.safeParse(outcome.output).success, outcome.sample.id).toBe(true);
        }
    });

    it('classifies at least 90% of the samples correctly', () => {
        const ok = outcomes.filter((o) => o.output?.classification === o.sample.expected).length;
        expect(ok / outcomes.length).toBeGreaterThanOrEqual(0.9);
    });

    it('detects the language of every non-English sample', () => {
        for (const { sample, output } of outcomes.filter((o) => o.sample.language !== 'en')) {
            expect(output?.detectedLanguage, sample.id).toBe(sample.language);
        }
    });

    it('needs a corrective L4 re-run for fewer than 2% of the samples', () => {
        const l4 = outcomes.filter((o) => (o.meta?.attempts ?? 1) > 1).length;
        expect(l4 / outcomes.length).toBeLessThan(0.02);
    });
});
