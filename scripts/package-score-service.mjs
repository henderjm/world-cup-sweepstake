import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [revision, destination] = process.argv.slice(2);
if (!revision || !destination) throw Error('Usage: node scripts/package-score-service.mjs REVISION NEW_DIRECTORY');
const git = args => execFileSync('git', args, { cwd: root });
const commit = git(['rev-parse', '--verify', `${revision}^{commit}`]).toString().trim();
const output = resolve(destination);
// An existing directory may contain a previous release or secrets; never merge into it.
await mkdir(output);
const files = git(['ls-tree', '-r', '--name-only', commit, 'services/scores']).toString().trim().split('\n')
  .filter(path => /^services\/scores\/[^/]+\.mjs$/.test(path));
files.push('services/scores/Dockerfile', 'services/scores/package.json', 'services/scores/package-lock.json', ...[
  'apiFootballPayload', 'apiQuota', 'competitions', 'domain', 'fantasy',
  'fantasyExpectedPoints', 'fantasyHistoricalXp', 'fantasyPlayerTier', 'format',
  'mapApiFootball', 'matchDetailCache', 'scoreSnapshot', 'standingsRecovery',
].map(name => `src/${name}.js`));
const hashes = {};
for (const path of files.sort()) {
  const content = git(['show', `${commit}:${path}`]);
  await mkdir(dirname(resolve(output, path)), { recursive: true });
  await writeFile(resolve(output, path), content);
  hashes[path] = createHash('sha256').update(content).digest('hex');
}
await writeFile(resolve(output, 'package.json'), '{"private":true,"type":"module"}\n');
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: resolve(output, 'services/scores'), stdio: 'inherit',
});
await writeFile(resolve(output, 'release.json'), JSON.stringify({
  commit, node: process.version, sources: hashes,
  collector: 'services/scores/run-collector.mjs', lambdaHandler: 'services/scores/lambda.handler',
}, null, 2) + '\n');
await mkdir(resolve(output, 'artifacts'));
execFileSync('zip', ['-q', '-r', 'artifacts/reader.zip', 'package.json', 'release.json', 'src', 'services'], {
  cwd: output, stdio: 'inherit',
});
const archiveHash = createHash('sha256').update(await readFile(resolve(output, 'artifacts/reader.zip'))).digest('hex');
await writeFile(resolve(output, 'artifacts/reader.zip.sha256'), `${archiveHash}  reader.zip\n`);
console.log(`Packaged ${commit} in ${output}`);
