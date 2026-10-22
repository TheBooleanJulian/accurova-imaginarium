/**
 * Vercel Function entry (bundled to api/index.mjs by `npm run build:api`).
 * Static frontend from dist/, API here. Jobs submitted by a request run to
 * completion inside that invocation (waitUntil); Vercel Cron calls
 * /api/worker/tick to pick up anything left over (retries, restarts).
 */
import { handle } from 'hono/vercel';
import { waitUntil } from '@vercel/functions';
import { loadConfig } from './config';
import { createRuntime, type Runtime } from './runtime';

let rt: Promise<Runtime> | null = null;
const runtime = () => (rt ??= createRuntime(loadConfig(), { waitUntil }));

export const config = { maxDuration: 300 };

const handler = async (req: Request) => handle((await runtime()).app)(req);
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
