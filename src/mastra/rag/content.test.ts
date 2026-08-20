import { describe, it, expect } from 'vitest';
import {
    enrichChunksWithChallengeName,
    htmlToMarkdown,
    normalizeLineEndings,
    parseSkills,
    processDescription,
    stripFrontmatter,
    trim,
} from './content';

describe('content — normalizeLineEndings', () => {
    // VAL-FOUND-001: converts CRLF to LF
    it('converts every CRLF sequence to a single LF', () => {
        const result = normalizeLineEndings('line1\r\nline2\r\n');
        expect(result).toBe('line1\nline2\n');
        expect(result).not.toContain('\r\n');
    });

    // VAL-FOUND-002: converts lone CR to LF
    it('converts lone CR (old Mac endings) to LF', () => {
        const result = normalizeLineEndings('line1\rline2\r');
        expect(result).toBe('line1\nline2\n');
        expect(result).not.toContain('\r');
    });

    it('handles mixed CRLF, lone CR, and LF without doubling newlines', () => {
        const result = normalizeLineEndings('a\r\nb\rc\nd');
        expect(result).toBe('a\nb\nc\nd');
        expect(result).not.toContain('\r');
    });

    it('leaves LF-only content unchanged', () => {
        expect(normalizeLineEndings('a\nb\n')).toBe('a\nb\n');
    });
});

describe('content — trim', () => {
    // VAL-FOUND-003: BOM-aware trim
    it('strips a leading BOM together with surrounding whitespace', () => {
        expect(trim('\uFEFF  hello world  \n')).toBe('hello world');
    });

    it('returns an empty string for BOM-only input', () => {
        expect(trim('\uFEFF')).toBe('');
    });

    it('strips trailing BOM characters', () => {
        expect(trim('hello\uFEFF')).toBe('hello');
    });

    it('strips newlines, tabs and carriage returns from both ends', () => {
        expect(trim('\n\t\r hello \r\t\n')).toBe('hello');
    });

    it('preserves interior BOM and whitespace', () => {
        expect(trim('  a\uFEFFb  ')).toBe('a\uFEFFb');
    });

    it('returns an empty string for whitespace-only input', () => {
        expect(trim('   \n\t  ')).toBe('');
    });

    it('leaves already-trimmed content unchanged', () => {
        expect(trim('hello')).toBe('hello');
    });
});

describe('content — stripFrontmatter', () => {
    // VAL-FOUND-004: removes a leading YAML frontmatter block
    it('removes the frontmatter block including both delimiters', () => {
        const result = stripFrontmatter('---\ntitle: x\ntags: [a]\n---\n# Body');
        expect(result).toBe('# Body');
        expect(result).not.toContain('---');
        expect(result).not.toContain('title:');
    });

    // VAL-FOUND-005: returns original when no frontmatter present
    it('returns the input verbatim when there is no frontmatter', () => {
        const input = '# Heading\nbody';
        expect(stripFrontmatter(input)).toBe(input);
    });

    it('returns the input verbatim when the frontmatter is not at position 0', () => {
        const input = 'preamble\n---\ntitle: x\n---\nbody';
        expect(stripFrontmatter(input)).toBe(input);
    });

    it('returns the input verbatim when the closing delimiter is missing', () => {
        const input = '---\ntitle: x\nbody without close';
        expect(stripFrontmatter(input)).toBe(input);
    });
});

describe('content — htmlToMarkdown', () => {
    // VAL-FOUND-006: ATX headings and fenced code blocks
    it('produces ATX headings and fenced code blocks', () => {
        const result = htmlToMarkdown('<h1>Title</h1><pre><code>code</code></pre>');
        expect(result).toContain('# Title');
        expect(result).toContain('```');
        // Not Setext headings
        expect(result).not.toContain('Title\n=');
        // Not indented code blocks
        expect(result).not.toMatch(/^ {4}code/m);
    });

    it('converts h2 headings to ## and drops HTML tags', () => {
        const result = htmlToMarkdown('<h1>A</h1><h2>B</h2><p>text</p>');
        expect(result).toContain('# A');
        expect(result).toContain('## B');
        expect(result).not.toContain('<h1>');
        expect(result).not.toContain('<p>');
    });

    it('preserves the body of a fenced code block verbatim', () => {
        const result = htmlToMarkdown('<pre><code>const a = 1;\nconst b = 2;</code></pre>');
        expect(result).toContain('const a = 1;\nconst b = 2;');
    });
});

describe('content — parseSkills', () => {
    // VAL-FOUND-007: splits, trims, deduplicates, filters empty
    it('splits, trims, deduplicates and filters empty segments', () => {
        expect(parseSkills('React, React , , TypeScript,')).toEqual(['React', 'TypeScript']);
    });

    it('returns an empty array for an empty string', () => {
        expect(parseSkills('')).toEqual([]);
    });

    it('returns an empty array for whitespace-only input', () => {
        expect(parseSkills('   ')).toEqual([]);
    });

    it('returns an empty array for a comma-only string', () => {
        expect(parseSkills(',,,')).toEqual([]);
    });

    it('preserves first-seen order of distinct skills', () => {
        expect(parseSkills('Node.js, React, Node.js, Go')).toEqual(['Node.js', 'React', 'Go']);
    });
});

describe('content — enrichChunksWithChallengeName', () => {
    // VAL-FOUND-008: prepends "# Challenge: <name>\n\n" to each chunk
    it('prepends the challenge header and preserves other fields', () => {
        const result = enrichChunksWithChallengeName([{ text: 'body', chunkIndex: 1 }], 'Demo');
        expect(result[0].text).toBe('# Challenge: Demo\n\nbody');
        expect(result[0].chunkIndex).toBe(1);
    });

    it('prefixes every chunk, not just the first', () => {
        const result = enrichChunksWithChallengeName(
            [{ text: 'one' }, { text: 'two' }, { text: 'three' }],
            'Demo',
        );
        expect(result).toHaveLength(3);
        for (const chunk of result) {
            expect(chunk.text.startsWith('# Challenge: Demo\n\n')).toBe(true);
        }
    });

    it('preserves chunk metadata unchanged', () => {
        const metadata = { title: 'A', section: 'B' };
        const result = enrichChunksWithChallengeName([{ text: 'body', metadata }], 'Demo');
        expect(result[0].metadata).toEqual({ title: 'A', section: 'B' });
    });

    it('does not mutate the input chunks', () => {
        const input = [{ text: 'body' }];
        enrichChunksWithChallengeName(input, 'Demo');
        expect(input[0].text).toBe('body');
    });

    it('returns an empty array for no chunks', () => {
        expect(enrichChunksWithChallengeName([], 'Demo')).toEqual([]);
    });
});

describe('content — processDescription', () => {
    // VAL-FOUND-009: normalize → trim → htmlToMarkdown → stripFrontmatter, in order
    it('normalizes, trims, converts HTML and strips frontmatter for the html path', () => {
        const description =
            '\uFEFF  <h1>Title</h1>\r\n<h2>Section</h2>\r\n<p>Body text</p>\r\n' +
            '<pre><code>const a = 1;</code></pre>  \r\n';

        const result = processDescription(description, 'html');

        // (a) LF-only line endings
        expect(result).not.toContain('\r');
        // (b) no BOM
        expect(result).not.toContain('\uFEFF');
        // (c) HTML converted to Markdown
        expect(result).toContain('# Title');
        expect(result).toContain('## Section');
        expect(result).toContain('```');
        expect(result).not.toContain('<h1>');
        expect(result).not.toContain('<p>');
        // (d) no leading YAML frontmatter block survives
        expect(result).not.toMatch(/^---\n[\s\S]*?\n---\n/);
        expect(result.startsWith('---')).toBe(false);
        // trimmed
        expect(result).toBe(result.trim());
    });

    it('strips frontmatter produced after conversion, not before it', () => {
        // Turndown escapes a bare "---" line, so a frontmatter block present in the
        // RAW HTML is no longer a leading "---\n" delimiter once converted. Its YAML
        // body therefore survives on the html path — direct evidence that
        // stripFrontmatter runs on the converted Markdown, not on the raw input.
        const html = '---\ntitle: raw\n---\n<h1>Body</h1>';
        const htmlResult = processDescription(html, 'html');
        expect(htmlResult).toContain('title: raw');
        expect(htmlResult).toContain('# Body');

        // The same input on the plain path IS a leading frontmatter block and is stripped.
        const plainResult = processDescription(html, 'markdown');
        expect(plainResult).toBe('<h1>Body</h1>');
    });

    it('strips a frontmatter block that leads the converted markdown', () => {
        const markdown = '---\ntitle: x\ntags: [a]\n---\n# Body';
        expect(processDescription(markdown, 'markdown')).toBe('# Body');
    });

    // VAL-FOUND-010: plain-text path skips htmlToMarkdown
    it('does not convert HTML when the format is not html', () => {
        const description = '\uFEFF---\ntitle: x\n---\nHello <b>bold</b>\r\nsecond line  ';
        const result = processDescription(description, 'markdown');

        // htmlToMarkdown NOT applied — the tag passes through verbatim
        expect(result).toContain('<b>bold</b>');
        // normalize / trim / stripFrontmatter still applied
        expect(result).not.toContain('\r');
        expect(result).not.toContain('\uFEFF');
        expect(result).not.toContain('title: x');
        expect(result).toBe('Hello <b>bold</b>\nsecond line');
    });

    it('skips HTML conversion for the text format', () => {
        expect(processDescription('plain <i>text</i>', 'text')).toBe('plain <i>text</i>');
    });

    it('skips HTML conversion when the format is omitted', () => {
        expect(processDescription('plain <i>text</i>')).toBe('plain <i>text</i>');
    });

    it('treats the format as case-insensitive for the html path', () => {
        const result = processDescription('<h1>Title</h1>', 'HTML');
        expect(result).toContain('# Title');
        expect(result).not.toContain('<h1>');
    });

    it('returns an empty string for whitespace-only input', () => {
        expect(processDescription('  \r\n\t ', 'html')).toBe('');
    });
});
