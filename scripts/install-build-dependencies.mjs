import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const output = new URL('.mastra/output/', root);
const sourceManifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const outputManifestUrl = new URL('package.json', output);
const outputManifest = JSON.parse(await readFile(outputManifestUrl, 'utf8'));

// Mastra replaces non-registry references with the installed version. Preserve
// the immutable shared-client reference and the package manager used to test it.
outputManifest.dependencies['tc-core-library-js'] =
  sourceManifest.dependencies['tc-core-library-js'];
outputManifest.packageManager = sourceManifest.packageManager;
await writeFile(outputManifestUrl, `${JSON.stringify(outputManifest, null, 2)}\n`);

// The generated server has its own dependency graph. Apply the same security
// overrides and seed its production install with the tested root lockfile.
for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
  await copyFile(new URL(file, root), new URL(file, output));
}
await mkdir(new URL('tools/minimatch-compat/', output), { recursive: true });
for (const file of ['index.cjs', 'package.json']) {
  const relative = `tools/minimatch-compat/${file}`;
  await copyFile(new URL(relative, root), new URL(relative, output));
}
execFileSync('pnpm', ['install', '--prod', '--no-frozen-lockfile'], {
  cwd: fileURLToPath(output),
  stdio: 'inherit',
});
