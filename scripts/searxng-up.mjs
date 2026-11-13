// Starts SearXNG with a fresh random secret, so no secret is stored on disk.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const result = spawnSync('docker', ['compose', 'up', '-d', '--wait', 'searxng'], {
  stdio: 'inherit',
  env: { ...process.env, SEARXNG_SECRET: randomBytes(32).toString('hex') },
});
process.exit(result.status ?? 1);
