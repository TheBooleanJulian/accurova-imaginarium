// Starts a production-like server for the Playwright "server" project:
// builds the frontend in server mode, bundles the API, and runs it on PGlite in a temp dir.
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const port = process.env.E2E_SERVER_PORT ?? '8790';
execSync('npx vite build --outDir .e2e/dist --emptyOutDir', { stdio: 'inherit', env: { ...process.env, VITE_BACKEND: 'server' } });
execSync('npm run build:server', { stdio: 'inherit' });
const dataDir = mkdtempSync(path.join(tmpdir(), 'imaginarium-e2e-'));
const child = spawn('node', ['dist-server/index.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, PORT: port, DATA_DIR: dataDir, STATIC_DIR: '.e2e/dist', MOCK_LATENCY_MS: '250', AUTH_MODE: 'dev', STORAGE: 'local', DATABASE_URL: '' },
});
const stop = () => child.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
