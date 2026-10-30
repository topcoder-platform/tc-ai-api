import { execFileSync } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const output = new URL('.mastra/output/', root);
const sourceManifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const outputManifestUrl = new URL('package.json', output);
const outputManifest = JSON.parse(await readFile(outputManifestUrl, 'utf8'));

// Mastra preserves registry ranges but replaces GitHub references with the
// installed package version. This release is distributed through GitHub only.
outputManifest.dependencies['tc-core-library-js'] = sourceManifest.dependencies['tc-core-library-js'];
await writeFile(outputManifestUrl, `${JSON.stringify(outputManifest, null, 2)}\n`);

// Seed the output install with the same lockfile Mastra normally copies, so
// unrelated runtime dependencies retain the versions tested by the service.
await copyFile(new URL('pnpm-lock.yaml', root), new URL('pnpm-lock.yaml', output));
execFileSync('pnpm', ['install', '--no-frozen-lockfile'], {
  cwd: fileURLToPath(output),
  stdio: 'inherit',
});
