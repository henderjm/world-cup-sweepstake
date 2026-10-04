import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { storedOrigin } from '../worker/stored-read.js';

export function workerDeployArgs(configured = '', dryRun = false) {
  const origin = configured ? storedOrigin(configured) : '';
  if (origin && !origin.startsWith('https://')) throw Error('Worker deployment requires an HTTPS stored origin');
  // Pass the binding even in legacy mode so a rollback cannot retain an old origin.
  return ['--yes', 'wrangler@4', 'deploy', '--var', `SCORE_READ_ORIGIN:${origin}`, ...(dryRun ? ['--dry-run'] : [])];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...extra] = process.argv.slice(2);
  if (extra.length || (mode && !['--deploy', '--dry-run'].includes(mode)))
    throw Error('Usage: node scripts/deploy-score-worker.mjs [--dry-run | --deploy]');
  const args = workerDeployArgs(process.env.SCORE_READ_ORIGIN, mode === '--dry-run');
  if (!mode) console.log(JSON.stringify({ mode: 'preview', command: ['npx', ...args] }));
  else {
    const result = spawnSync('npx', args, { cwd: fileURLToPath(new URL('../worker', import.meta.url)), stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
