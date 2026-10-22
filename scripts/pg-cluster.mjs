// Throwaway local Postgres cluster for tests and dev (no Docker needed).
// Uses the Postgres server binaries installed on the machine.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, chmodSync, chownSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import net from 'node:net';

export function findPgBin() {
  if (process.env.PG_BIN && existsSync(path.join(process.env.PG_BIN, 'pg_ctl'))) return process.env.PG_BIN;
  const which = spawnSync('sh', ['-c', 'command -v pg_ctl'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return path.dirname(which.stdout.trim());
  for (const base of ['/usr/lib/postgresql', '/opt/homebrew/opt', '/usr/local/opt']) {
    if (!existsSync(base)) continue;
    const versions = readdirSync(base).sort().reverse();
    for (const v of versions) {
      const bin = path.join(base, v, 'bin');
      if (existsSync(path.join(bin, 'pg_ctl'))) return bin;
    }
  }
  return null;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

/** Postgres refuses to run as root; fall back to the `postgres` system user when we are root. */
function runAs() {
  if (userInfo().uid !== 0) return null;
  const id = spawnSync('id', ['-u', 'postgres'], { encoding: 'utf8' });
  if (id.status === 0) return { name: 'postgres', uid: Number(id.stdout.trim()) };
  return { name: 'nobody', uid: 65534 };
}

export async function startCluster() {
  const bin = findPgBin();
  if (!bin) return null;
  const dir = mkdtempSync(path.join(tmpdir(), 'imaginarium-pg-'));
  const data = path.join(dir, 'data');
  const port = await freePort();
  const user = runAs();
  const run = (cmd, args) => {
    const full = path.join(bin, cmd);
    if (user) execFileSync('runuser', ['-u', user.name, '--', full, ...args], { stdio: 'pipe' });
    else execFileSync(full, args, { stdio: 'pipe' });
  };
  if (user) {
    chownSync(dir, user.uid, -1);
    chmodSync(dir, 0o700);
  }
  run('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-locale']);
  run('pg_ctl', ['-D', data, '-l', path.join(dir, 'log.txt'), '-w', '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`, 'start']);
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    port,
    stop() {
      try {
        run('pg_ctl', ['-D', data, '-m', 'immediate', 'stop']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
