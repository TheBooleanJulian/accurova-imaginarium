// Full stack in development: API + worker on :8787 and Vite on :5173 in server mode.
import { spawn } from 'node:child_process';

const procs = [
  spawn('npx', ['tsx', 'watch', '--tsconfig', 'tsconfig.server.json', 'server/index.ts'], { stdio: 'inherit', env: { ...process.env } }),
  spawn('npx', ['vite'], { stdio: 'inherit', env: { ...process.env, VITE_BACKEND: 'server' } }),
];
const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
