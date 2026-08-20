/**
 * Two-pass chunking for challenge descriptions.
 *
 * Pass 1 splits on Markdown headers (semantic boundaries). Pass 2 sizes each
 * resulting chunk, keeping code blocks and tables atomic unless they exceed the
 * embedding model's token budget.
 *
 * chunkChallengeDescription is pure: no network, filesystem or console access,
 * and deterministic for a given input.
 */

import { MDocument } from '@mastra/rag';
import { getEncoding } from 'js-tiktoken';
import type {
    ChallengeChunk,
    ChunkingOptions,
    ChunkingResult,
    ForceSplitReason,
} from './types';

/** Fenced code block delimited by ``` or ~~~ */
const CODE_BLOCK_RE = /```[^\n]*\n[\s\S]*?\n```|~~~[^\n]*\n[\s\S]*?\n~~~/m;

/** A line that starts (with optional indent) with | and contains a further | */
const TABLE_RE = /^\s*\|.*\|/m;

type Encoding = ReturnType<typeof getEncoding>;

let encoding: Encoding | null = null;

/** Lazily loads the cl100k_base encoding — the standard for modern embeddings. */
function getTokenEncoding(): Encoding {
    if (encoding === null) {
        encoding = getEncoding('cl100k_base');
    }
    return encoding;
}

function toChallengeChunk(
    chunk: { text: string; metadata?: Record<string, unknown> },
    parentMetadata?: Record<string, unknown>,
): ChallengeChunk {
    return {
        text: chunk.text,
        metadata: { ...chunk.metadata, ...parentMetadata },
    };
}

/**
 * Chunks a processed challenge description.
 *
 * @param content - Markdown content, already run through processDescription
 * @param options - maxSize / overlap / contextWindow, normally from getRagConfig()
 * @returns The final chunks plus a record of any atomic block that had to be force-split
 */
export async function chunkChallengeDescription(
    content: string,
    options: ChunkingOptions,
): Promise<ChunkingResult> {
    const { maxSize, overlap, contextWindow } = options;

    const chunks: ChallengeChunk[] = [];
    const forceSplits: ChunkingResult['forceSplits'] = [];

    if (content.length === 0) {
        return { chunks, forceSplits };
    }

    // 3% margin absorbs tokenizer differences and characters the embedding API adds.
    const maxSafeTokens = Math.floor(contextWindow * 0.97);
    // ~4 chars per token, so 3x the context window stays well under the token
    // ceiling while keeping force-split fragments large enough to stay useful.
    // This is deliberately NOT maxSize.
    const safeCharLimit = contextWindow * 3;

    // Pass 1 — split on header boundaries, keeping the headers for semantic context.
    const initialChunks = await MDocument.fromMarkdown(content).chunk({
        strategy: 'markdown',
        headers: [
            ['#', 'title'],
            ['##', 'section'],
        ],
        stripHeaders: false,
    });

    // Pass 2 — size each header chunk.
    for (let chunkIndex = 0; chunkIndex < initialChunks.length; chunkIndex++) {
        const chunk = initialChunks[chunkIndex];
        const parentMetadata = chunk.metadata as Record<string, unknown> | undefined;

        if (chunk.text.length <= maxSize) {
            chunks.push(toChallengeChunk(chunk));
            continue;
        }

        const hasCodeBlock = CODE_BLOCK_RE.test(chunk.text);
        const hasTable = TABLE_RE.test(chunk.text);

        if (hasCodeBlock || hasTable) {
            const originalTokens = getTokenEncoding().encode(chunk.text).length;

            if (originalTokens <= maxSafeTokens) {
                // Atomic content that still fits the model — keep it intact even
                // though it is longer than maxSize.
                chunks.push(toChallengeChunk(chunk));
                continue;
            }

            const forced = await MDocument.fromText(chunk.text).chunk({
                strategy: 'recursive',
                maxSize: safeCharLimit,
                overlap: 0,
            });

            const reason: ForceSplitReason = hasCodeBlock ? 'code-block' : 'table';
            forceSplits.push({
                chunkIndex,
                originalTokens,
                resultingChunks: forced.length,
                reason,
            });

            for (const miniChunk of forced) {
                chunks.push(toChallengeChunk(miniChunk, parentMetadata));
            }
            continue;
        }

        // Pure text above maxSize — split recursively for retrieval precision.
        const textChunks = await MDocument.fromText(chunk.text).chunk({
            strategy: 'recursive',
            maxSize,
            overlap,
        });

        for (const miniChunk of textChunks) {
            chunks.push(toChallengeChunk(miniChunk, parentMetadata));
        }
    }

    return { chunks, forceSplits };
}
