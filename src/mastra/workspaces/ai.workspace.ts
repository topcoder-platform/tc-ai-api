import { Workspace, LocalFilesystem } from '@mastra/core/workspace';

export const aiWorkspace = new Workspace({
    filesystem: new LocalFilesystem({
        basePath: process.env.WORKSPACE_PATH!,
        readOnly: true
    }),
    bm25: true,
    autoIndexPaths: [''],
    skills: ['skills'],
});

await aiWorkspace.init();