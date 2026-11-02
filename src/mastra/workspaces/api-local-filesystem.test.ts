import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Mastra } from '@mastra/core';
import { Workspace } from '@mastra/core/workspace';
import { WORKSPACE_FS_READ_ROUTE } from '@mastra/server/handlers/workspace';
import { ApiLocalFilesystem } from './api-local-filesystem';

describe('workspace file reads through the built-in handler', () => {
    let directory: string;
    let mastra: Mastra;
    let workspace: Workspace;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'ai-workspace-read-'));
        await writeFile(join(directory, 'example.txt'), 'React and TypeScript');
        workspace = new Workspace({
            id: 'test-workspace',
            filesystem: new ApiLocalFilesystem({ basePath: directory, readOnly: true }),
        });
        mastra = new Mastra({ workspace });
    });

    afterEach(async () => {
        await workspace.destroy();
        await rm(directory, { recursive: true, force: true });
    });

    function read(path: string) {
        return WORKSPACE_FS_READ_ROUTE.handler({ mastra, workspaceId: workspace.id, path } as
            Parameters<typeof WORKSPACE_FS_READ_ROUTE.handler>[0]);
    }

    it('returns file contents', async () => {
        await expect(read('example.txt')).resolves.toMatchObject({ content: 'React and TypeScript', type: 'file' });
    });

    it('returns 400 for relative, absolute, and trailing-slash directory paths', async () => {
        for (const path of ['.', directory, `${directory}/`]) {
            await expect(read(path)).rejects.toMatchObject({ status: 400 });
        }
    });

    it('preserves 404 for missing files and 403 for paths outside the workspace', async () => {
        await expect(read('missing.txt')).rejects.toMatchObject({ status: 404 });
        await expect(read('../outside.txt')).rejects.toMatchObject({ status: 403 });
    });
});
