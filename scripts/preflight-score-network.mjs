import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateNetworkTarget, checkScoreNetwork } from './lib/score-network-preflight.mjs';

const [path, mode, ...extra] = process.argv.slice(2);
if (!path || (mode && mode !== '--check-aws') || extra.length)
  throw Error('Usage: node scripts/preflight-score-network.mjs TARGET.json [--check-aws]');
const target = validateNetworkTarget(JSON.parse(await readFile(path, 'utf8')));
if (!mode) console.log(JSON.stringify({ mode: 'preview', ...target, deploymentReady: false }));
else {
  const run = promisify(execFile);
  const aws = async args => {
    const { stdout } = await run('aws', [...args, '--region', target.region, '--output', 'json', '--no-cli-pager'],
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' } });
    return JSON.parse(stdout);
  };
  console.log(JSON.stringify(await checkScoreNetwork(target, aws), null, 2));
}
