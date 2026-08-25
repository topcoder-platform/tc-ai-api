/**
 * Content processing for the challenge RAG pipeline.
 *
 * Pure functions only — no I/O, no logging. Handles line-ending normalization,
 * BOM-aware trimming, YAML frontmatter stripping, HTML→Markdown conversion,
 * skills parsing and chunk enrichment.
 */

import TurndownService from 'turndown';

const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
});

const BOM = '\uFEFF';

/**
 * Normalizes all line endings to Unix-style \n, handling Windows (\r\n) and
 * old Mac (lone \r).
 */
export function normalizeLineEndings(content: string): string {
    return content.replace(/\r\n?/g, '\n');
}

/**
 * BOM-aware trim. Removes leading and trailing spaces, newlines, tabs,
 * carriage returns and BOM characters.
 *
 * String.prototype.trim does not strip \uFEFF in all runtimes, so the scan is
 * done by hand.
 */
export function trim(content: string): string {
    const isTrimChar = (ch: string) =>
        ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === BOM;

    let start = 0;
    let end = content.length - 1;

    while (start <= end && isTrimChar(content[start])) {
        start++;
    }

    while (end >= start && isTrimChar(content[end])) {
        end--;
    }

    return start > end ? '' : content.substring(start, end + 1);
}

/**
 * Strips a leading YAML frontmatter block. The block must start at position 0.
 * Returns the input verbatim when no well-formed frontmatter is present.
 */
export function stripFrontmatter(content: string): string {
    if (!content.startsWith('---\n')) {
        return content;
    }

    const endIndex = content.indexOf('\n---\n', 4);
    if (endIndex === -1) {
        return content;
    }

    return content.slice(endIndex + 5);
}

/**
 * Converts HTML to Markdown, preserving structure (ATX headings, fenced code
 * blocks, lists) while dropping layout noise.
 */
export function htmlToMarkdown(html: string): string {
    return turndown.turndown(html);
}

/**
 * Parses a comma-separated skills string into a trimmed, deduplicated list
 * with empty entries removed. First-seen order is preserved.
 */
export function parseSkills(skillsString: string): string[] {
    if (!skillsString || !skillsString.trim()) {
        return [];
    }

    return Array.from(
        new Set(
            skillsString
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
        ),
    );
}

/**
 * Prepends `# Challenge: <name>` as a header to every chunk's text.
 *
 * Called AFTER chunking so the header becomes part of the embedded text and of
 * the deterministic vector id hash input.
 */
export function enrichChunksWithChallengeName<T extends { text: string }>(
    chunks: T[],
    challengeName: string,
): T[] {
    const header = `# Challenge: ${challengeName}\n\n`;
    return chunks.map((chunk) => ({ ...chunk, text: header + chunk.text }));
}

/**
 * Runs a raw challenge description through the full content pipeline:
 * normalize line endings → BOM-aware trim → HTML→Markdown (html format only)
 * → strip frontmatter.
 *
 * The order is significant: frontmatter is stripped from the CONVERTED
 * Markdown, not from the raw HTML.
 *
 * @param description - Raw description
 * @param format - Description format; only 'html' (case-insensitive) triggers conversion
 */
export function processDescription(description: string, format?: string): string {
    let content = normalizeLineEndings(description);

    content = trim(content);

    if (format?.toLowerCase() === 'html') {
        content = htmlToMarkdown(content);
    }

    return stripFrontmatter(content);
}
