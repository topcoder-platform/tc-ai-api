/**
 * Hierarchical file logger for the CSV backfill CLI.
 *
 * Ported from tc-challenges-vector-rag's src/lib/logger.ts. Preserves the
 * dual output (console + file) and per-run log directory
 * (logs/ingestion-<ts>/{output.log,error.log,report.json}), but drops
 * `interceptConsole()` entirely (D6) — the server path never touches this
 * module, and this CLI-only logger has no reason to rewrite `console`
 * globally to get contextual prefixes; every call site logs through an
 * explicit IngestionLogger instance instead.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IngestionReport } from '../mastra/rag/types';

export class IngestionLogger {
    // Shared streams across all logger instances created from the same root
    private static logDir: string;
    private static outputStream: fs.WriteStream;
    private static errorStream: fs.WriteStream | null = null;

    // Context for log prefixing (e.g., "file.csv] [challengeId")
    private readonly context: string;

    private constructor(context = '') {
        this.context = context;
    }

    /** Creates the root logger and initializes the shared per-run streams. */
    static create(baseDir: string): IngestionLogger {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        IngestionLogger.logDir = path.join(baseDir, `ingestion-${timestamp}`);
        fs.mkdirSync(IngestionLogger.logDir, { recursive: true });
        IngestionLogger.outputStream = fs.createWriteStream(path.join(IngestionLogger.logDir, 'output.log'));
        // Reset so the lazy errorStream getter creates a fresh stream under
        // the new logDir, rather than reusing a prior run's (possibly closed) one.
        IngestionLogger.errorStream = null;
        return new IngestionLogger();
    }

    /** Creates a child logger with appended context (e.g. filename, then challenge id). */
    child(context: string): IngestionLogger {
        const newContext = this.context ? `${this.context}] [${context}` : context;
        return new IngestionLogger(newContext);
    }

    /** Lazy-initialized error stream — created only when the first error is logged. */
    private get errorStream(): fs.WriteStream {
        if (!IngestionLogger.errorStream) {
            IngestionLogger.errorStream = fs.createWriteStream(path.join(IngestionLogger.logDir, 'error.log'));
        }
        return IngestionLogger.errorStream;
    }

    private formatLine(message: string, level: 'log' | 'error' | 'warn' = 'log'): string {
        const prefix = this.context ? `[${this.context}] ` : '';
        const marker = level === 'error' ? '[ERROR] ' : level === 'warn' ? '[WARN] ' : '';
        return `[${new Date().toISOString()}] ${marker}${prefix}${message}`;
    }

    log(message: string): void {
        const line = this.formatLine(message);
        console.log(line);
        IngestionLogger.outputStream.write(line + '\n');
    }

    warn(message: string): void {
        const line = this.formatLine(message, 'warn');
        console.warn(line);
        IngestionLogger.outputStream.write(line + '\n');
    }

    error(message: string, error?: Error): void {
        const fullMessage = message ? (error ? `${message}: ${error.message}` : message) : error?.message || 'Unknown error';
        const line = this.formatLine(fullMessage, 'error');
        console.error(line);
        IngestionLogger.outputStream.write(line + '\n');
        this.errorStream.write(line + '\n');
        if (error?.stack) {
            this.errorStream.write(error.stack + '\n');
        }
    }

    writeReport(report: IngestionReport): void {
        fs.writeFileSync(path.join(IngestionLogger.logDir, 'report.json'), JSON.stringify(report, null, 2));
    }

    /** Ends the underlying streams and resolves once they have fully flushed to disk. */
    close(): Promise<void> {
        const streams = [IngestionLogger.outputStream, IngestionLogger.errorStream].filter(
            (s): s is fs.WriteStream => Boolean(s),
        );
        return Promise.all(streams.map((stream) => new Promise<void>((resolve) => stream.end(resolve)))).then(
            () => undefined,
        );
    }

    getLogDir(): string {
        return IngestionLogger.logDir;
    }
}
