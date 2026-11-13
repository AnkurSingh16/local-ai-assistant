// Starts SearXNG with a fresh random secret, so no secret is stored on disk.
// Mock providers need no search engine, so it does nothing in that mode.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

if (process.env.PROVIDERS === 'mock') {
  process.stdout.write('PROVIDERS=mock: SearXNG not needed, not starting it.\n');
  process.exit(0);
}

const result = spawnSync('docker', ['compose', 'up', '-d', '--wait', 'searxng'], {
  stdio: 'inherit',
  env: { ...process.env, SEARXNG_SECRET: randomBytes(32).toString('hex') },
});
if (result.error !== undefined) {
  process.stderr.write(
    `Could not run docker (${result.error.message}).\nfix: install and start Docker Desktop, or run with PROVIDERS=mock.\n`,
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
