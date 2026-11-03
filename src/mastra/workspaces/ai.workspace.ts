import { Workspace } from '@mastra/core/workspace';
import { ApiLocalFilesystem } from './api-local-filesystem';

export const aiWorkspace = new Workspace({
    filesystem: new ApiLocalFilesystem({
        basePath: process.env.WORKSPACE_PATH!,
        readOnly: true
    }),
    bm25: true,
    autoIndexPaths: [''],
    skills: ['skills'],
});

await aiWorkspace.init();
