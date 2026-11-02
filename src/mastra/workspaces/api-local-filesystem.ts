import { IsDirectoryError, LocalFilesystem, type ReadOptions } from '@mastra/core/workspace';

/** Keep Mastra's containment checks; classify a directory read as bad input. */
export class ApiLocalFilesystem extends LocalFilesystem {
    override async readFile(path: string, options?: ReadOptions): Promise<string | Buffer> {
        try {
            return await super.readFile(path, options);
        } catch (error) {
            if (error instanceof IsDirectoryError) {
                // The built-in workspace handler forwards status to handleError.
                // Catch the actual read error rather than stat first (avoids a race).
                throw Object.assign(error, { status: 400 });
            }
            throw error;
        }
    }
}
