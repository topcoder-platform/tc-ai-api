import { describe, it, expect, vi } from 'vitest';
import { getEncoding } from 'js-tiktoken';
import { chunkChallengeDescription } from './chunking';
import type { ChunkingOptions } from './types';

const enc = getEncoding('cl100k_base');

const OPTIONS: ChunkingOptions = { maxSize: 512, overlap: 50, contextWindow: 2048 };
const SAFE_CHAR_LIMIT = OPTIONS.contextWindow * 3; // 6144
const MAX_SAFE_TOKENS = Math.floor(OPTIONS.contextWindow * 0.97); // 1986

function buildProse(repetitions: number): string {
    return 'The quick brown fox jumps over the lazy dog near the riverbank. '.repeat(repetitions);
}

function buildCodeBlock(lines: number): string {
    const line = "const longVariableName = 'payload value here';\n";
    return `# Setup\n\n\`\`\`js\n${line.repeat(lines)}\`\`\`\n`;
}

function buildTable(rows: number): string {
    let table = '# Metrics\n\n| col a | col b | col c |\n| --- | --- | --- |\n';
    for (let i = 0; i < rows; i++) {
        table += `| value ${i} aaaaaaaaaaaa | value ${i} bbbbbbbbbbbb | value ${i} cccccccccccc |\n`;
    }
    return table;
}

function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

describe('chunking — chunkChallengeDescription', () => {
    // VAL-FOUND-020: returns { chunks, forceSplits }
    describe('return shape', () => {
        it('returns exactly the chunks and forceSplits keys', async () => {
            const result = await chunkChallengeDescription('a short description', OPTIONS);
            expect(Object.keys(result).sort()).toEqual(['chunks', 'forceSplits']);
            expect(Array.isArray(result.chunks)).toBe(true);
            expect(Array.isArray(result.forceSplits)).toBe(true);
        });

        it('gives every chunk a string-valued text property', async () => {
            const { chunks } = await chunkChallengeDescription(buildProse(32), OPTIONS);
            expect(chunks.length).toBeGreaterThan(0);
            for (const chunk of chunks) {
                expect(typeof chunk.text).toBe('string');
            }
        });

        it('returns no chunks for empty content', async () => {
            const result = await chunkChallengeDescription('', OPTIONS);
            expect(result.chunks).toEqual([]);
            expect(result.forceSplits).toEqual([]);
        });
    });

    // VAL-FOUND-011: small chunks pass through unchanged
    describe('small chunk passthrough', () => {
        it('returns a single unchanged chunk for content at or below maxSize', async () => {
            const content = buildProse(4).slice(0, 200);
            expect(content.length).toBe(200);

            const { chunks, forceSplits } = await chunkChallengeDescription(content, OPTIONS);

            expect(chunks).toHaveLength(1);
            expect(chunks[0].text).toContain(content);
            expect(chunks[0].text).toBe(content);
            expect(forceSplits).toHaveLength(0);
        });

        it('does not split a header-bearing chunk that is under maxSize', async () => {
            const content = '# Overview\n\nA compact challenge description that fits in one chunk.';
            const { chunks, forceSplits } = await chunkChallengeDescription(content, OPTIONS);

            expect(chunks).toHaveLength(1);
            expect(chunks[0].text).toContain('# Overview');
            expect(chunks[0].text).toContain('A compact challenge description that fits in one chunk.');
            expect(forceSplits).toHaveLength(0);
        });
    });

    // VAL-FOUND-012: oversized pure text is recursively split with maxSize and overlap
    describe('oversized pure text', () => {
        it('splits prose longer than maxSize into chunks bounded by maxSize', async () => {
            const content = buildProse(32);
            expect(content.length).toBeGreaterThan(2000);

            const { chunks, forceSplits } = await chunkChallengeDescription(content, OPTIONS);

            expect(chunks.length).toBeGreaterThan(1);
            for (const chunk of chunks) {
                expect(chunk.text.length).toBeLessThanOrEqual(OPTIONS.maxSize);
            }
            expect(forceSplits).toHaveLength(0);
        });

        it('carries overlap between consecutive chunks', async () => {
            const content = buildProse(32);
            const { chunks } = await chunkChallengeDescription(content, OPTIONS);

            const totalChunkChars = chunks.reduce((sum, c) => sum + c.text.length, 0);
            // Overlapping windows repeat context, so the chunks together exceed the source length.
            expect(totalChunkChars).toBeGreaterThan(content.length);
        });

        it('honours a smaller maxSize', async () => {
            const { chunks } = await chunkChallengeDescription(buildProse(32), {
                ...OPTIONS,
                maxSize: 200,
            });
            for (const chunk of chunks) {
                expect(chunk.text.length).toBeLessThanOrEqual(200);
            }
        });

        it('propagates header metadata onto recursive sub-chunks', async () => {
            const content = `# Requirements\n\n${buildProse(32)}`;
            const { chunks } = await chunkChallengeDescription(content, OPTIONS);

            expect(chunks.length).toBeGreaterThan(1);
            for (const chunk of chunks) {
                expect(chunk.metadata?.title).toBe('Requirements');
            }
        });
    });

    // VAL-FOUND-013 / VAL-FOUND-014: atomicity within the token safety limit
    describe('atomic code blocks and tables', () => {
        it('keeps an oversized-but-token-safe code block in a single chunk', async () => {
            const content = buildCodeBlock(13);
            expect(content.length).toBeGreaterThan(OPTIONS.maxSize);
            expect(enc.encode(content).length).toBeLessThan(MAX_SAFE_TOKENS);

            const { chunks, forceSplits } = await chunkChallengeDescription(content, OPTIONS);

            expect(chunks).toHaveLength(1);
            expect(chunks[0].text).toContain('```js');
            expect(countOccurrences(chunks[0].text, '```')).toBe(2);
            expect(countOccurrences(chunks[0].text, 'const longVariableName')).toBe(13);
            expect(forceSplits).toHaveLength(0);
        });

        it('keeps an oversized-but-token-safe table in a single chunk', async () => {
            const content = buildTable(10);
            expect(content.length).toBeGreaterThan(OPTIONS.maxSize);
            expect(enc.encode(content).length).toBeLessThan(MAX_SAFE_TOKENS);

            const { chunks, forceSplits } = await chunkChallengeDescription(content, OPTIONS);

            expect(chunks).toHaveLength(1);
            // One "cccccccccccc |" terminator per table row — all 10 rows intact.
            expect(countOccurrences(chunks[0].text, 'cccccccccccc |')).toBe(10);
            expect(chunks[0].text).toContain('| value 0 aaaaaaaaaaaa');
            expect(chunks[0].text).toContain('| value 9 aaaaaaaaaaaa');
            expect(forceSplits).toHaveLength(0);
        });
    });

    // VAL-FOUND-015 / VAL-FOUND-016: force-split at safeCharLimit, not maxSize
    describe('force-splitting oversized atomic blocks', () => {
        it('force-splits an over-token code block at safeCharLimit, not maxSize', async () => {
            const content = buildCodeBlock(210);
            expect(enc.encode(content).length).toBeGreaterThan(MAX_SAFE_TOKENS);

            const { chunks, forceSplits } = await chunkChallengeDescription(content, OPTIONS);

            expect(forceSplits.length).toBeGreaterThanOrEqual(1);
            expect(chunks.length).toBeGreaterThan(1);
            for (const chunk of chunks) {
                expect(chunk.text.length).toBeLessThanOrEqual(SAFE_CHAR_LIMIT);
            }
            // A chunk far larger than maxSize proves safeCharLimit (6144) was used, not 512.
            expect(Math.max(...chunks.map((c) => c.text.length))).toBeGreaterThan(OPTIONS.maxSize);
            expect(Math.max(...chunks.map((c) => c.text.length))).toBeGreaterThan(SAFE_CHAR_LIMIT / 2);
        });

        it('force-splits an over-token table at safeCharLimit, not maxSize', async () => {
            const content = buildTable(200);
            expect(enc.encode(content).length).toBeGreaterThan(MAX_SAFE_TOKENS);

            const { chunks, forceSplits } = await chunkChallengeDescription(content, OPTIONS);

            expect(forceSplits.length).toBeGreaterThanOrEqual(1);
            for (const chunk of chunks) {
                expect(chunk.text.length).toBeLessThanOrEqual(SAFE_CHAR_LIMIT);
            }
            expect(Math.max(...chunks.map((c) => c.text.length))).toBeGreaterThan(SAFE_CHAR_LIMIT / 2);
        });

        // VAL-FOUND-015: force-splits are tracked
        it('records each force-split with identifying information', async () => {
            const content = buildCodeBlock(210);
            const { chunks, forceSplits } = await chunkChallengeDescription(content, OPTIONS);

            expect(forceSplits).toHaveLength(1);
            const record = forceSplits[0];
            expect(record.chunkIndex).toBe(0);
            expect(record.originalTokens).toBeGreaterThan(MAX_SAFE_TOKENS);
            expect(record.resultingChunks).toBe(chunks.length);
            expect(record.reason).toBe('code-block');
        });

        it('labels a force-split table with the table reason', async () => {
            const { forceSplits } = await chunkChallengeDescription(buildTable(200), OPTIONS);
            expect(forceSplits[0].reason).toBe('table');
        });

        it('propagates header metadata onto force-split sub-chunks', async () => {
            const { chunks } = await chunkChallengeDescription(buildCodeBlock(210), OPTIONS);
            for (const chunk of chunks) {
                expect(chunk.metadata?.title).toBe('Setup');
            }
        });
    });

    // VAL-FOUND-017: markdown header pass splits on # and ## with stripHeaders: false
    describe('markdown header pass', () => {
        it('splits on # and ## boundaries and retains the header text', async () => {
            const { chunks } = await chunkChallengeDescription(
                '# A\npara1\n## B\npara2\n## C\npara3',
                OPTIONS,
            );

            expect(chunks).toHaveLength(3);
            const texts = chunks.map((c) => c.text);
            expect(texts.some((t) => t.includes('# A'))).toBe(true);
            expect(texts.some((t) => t.includes('## B'))).toBe(true);
            expect(texts.some((t) => t.includes('## C'))).toBe(true);

            // No chunk spans two distinct header sections.
            for (const text of texts) {
                expect(countOccurrences(text, '## ')).toBeLessThanOrEqual(1);
            }
            expect(texts.find((t) => t.includes('## B'))).not.toContain('para3');
            expect(texts.find((t) => t.includes('## C'))).not.toContain('para2');
        });

        it('exposes the header hierarchy as chunk metadata', async () => {
            const { chunks } = await chunkChallengeDescription(
                '# A\npara1\n## B\npara2\n## C\npara3',
                OPTIONS,
            );
            expect(chunks.map((c) => c.metadata)).toEqual([
                { title: 'A' },
                { title: 'A', section: 'B' },
                { title: 'A', section: 'C' },
            ]);
        });
    });

    // VAL-FOUND-018: cl100k_base with floor(contextWindow * 0.97) threshold
    describe('token safety threshold', () => {
        it('does not force-split content just below floor(contextWindow * 0.97)', async () => {
            const content = buildCodeBlock(185);
            const tokens = enc.encode(content).length;
            expect(tokens).toBeLessThan(MAX_SAFE_TOKENS);

            const { chunks, forceSplits } = await chunkChallengeDescription(content, OPTIONS);

            expect(forceSplits).toHaveLength(0);
            expect(chunks).toHaveLength(1);
        });

        it('force-splits content just above floor(contextWindow * 0.97)', async () => {
            const content = buildCodeBlock(210);
            expect(enc.encode(content).length).toBeGreaterThan(MAX_SAFE_TOKENS);

            const { forceSplits } = await chunkChallengeDescription(content, OPTIONS);
            expect(forceSplits).toHaveLength(1);
        });

        it('scales the threshold with contextWindow (8192 → 7946 tokens)', async () => {
            const content = buildCodeBlock(210);
            const tokens = enc.encode(content).length;
            expect(tokens).toBeGreaterThan(Math.floor(2048 * 0.97));
            expect(tokens).toBeLessThan(Math.floor(8192 * 0.97));

            // Same content, larger context window: no force-split, block stays atomic.
            const wide = await chunkChallengeDescription(content, {
                ...OPTIONS,
                contextWindow: 8192,
            });
            expect(wide.forceSplits).toHaveLength(0);
            expect(wide.chunks).toHaveLength(1);

            // Narrow context window: force-split triggers.
            const narrow = await chunkChallengeDescription(content, OPTIONS);
            expect(narrow.forceSplits).toHaveLength(1);
        });

        it('uses the contextWindow to derive safeCharLimit for force-splits', async () => {
            const content = buildTable(200);
            const { chunks } = await chunkChallengeDescription(content, {
                ...OPTIONS,
                contextWindow: 1024,
            });
            // safeCharLimit = 1024 * 3 = 3072
            for (const chunk of chunks) {
                expect(chunk.text.length).toBeLessThanOrEqual(3072);
            }
            expect(Math.max(...chunks.map((c) => c.text.length))).toBeGreaterThan(3072 / 2);
        });
    });

    // VAL-FOUND-019: pure — no I/O, no console, deterministic
    describe('purity', () => {
        it('writes nothing to the console', async () => {
            const swallow = () => undefined;
            const log = vi.spyOn(console, 'log').mockImplementation(swallow);
            const error = vi.spyOn(console, 'error').mockImplementation(swallow);
            const warn = vi.spyOn(console, 'warn').mockImplementation(swallow);
            const info = vi.spyOn(console, 'info').mockImplementation(swallow);
            const debug = vi.spyOn(console, 'debug').mockImplementation(swallow);

            await chunkChallengeDescription(buildCodeBlock(210), OPTIONS);
            await chunkChallengeDescription(buildProse(32), OPTIONS);

            expect(log).not.toHaveBeenCalled();
            expect(error).not.toHaveBeenCalled();
            expect(warn).not.toHaveBeenCalled();
            expect(info).not.toHaveBeenCalled();
            expect(debug).not.toHaveBeenCalled();
        });

        it('is deterministic for identical inputs', async () => {
            const content = `# Intro\n\n${buildProse(32)}\n\n${buildCodeBlock(210)}`;
            const first = await chunkChallengeDescription(content, OPTIONS);
            const second = await chunkChallengeDescription(content, OPTIONS);
            expect(first).toEqual(second);
        });

        it('does not mutate the input string', async () => {
            const content = buildProse(32);
            const copy = `${content}`;
            await chunkChallengeDescription(content, OPTIONS);
            expect(content).toBe(copy);
        });
    });
});
