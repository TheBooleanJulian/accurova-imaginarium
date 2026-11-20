# Accurova Imaginarium: progress

Last updated: 2026-11-20. Tracked here, not in `zeabur-migration/` (this app was never on Zeabur).

| | |
|---|---|
| Live (browser-only demo) | https://imaginarium.accurova.com |
| Repo (public) | https://github.com/TheBooleanJulian/accurova-imaginarium |
| Host | Cloudflare Workers (static assets), account `accurova`, Worker `accurova-imaginarium` |
| Worker dashboard | https://dash.cloudflare.com/c580c4403524273d1bece674117472dd/workers/services/view/accurova-imaginarium/production |
| CI | https://github.com/TheBooleanJulian/accurova-imaginarium/actions (typecheck, lint, unit + server tests, builds, Playwright e2e) |
| Deploy | Manual: `npx wrangler deploy` from a non-Drive copy (see "How to deploy") |

## What is live

The **browser-only demo**: mock AI placeholders, projects stored in the visitor's own browser (IndexedDB), no accounts, no server.
It is labelled as a demo in three places: a banner on every page, the `DEMO ACCOUNT` user, and the `MOCK AI · OFFLINE` badge.

**Not deployed: server mode** (real sign-in, Postgres/Supabase, OpenAI, client invites that work across devices).
It needs credentials and a host decision, see tasks 3 and 4.

## Done

- [x] Domain core, job engine, local backend, mock AI (2026-10-22)
- [x] Editor, inspectors, sharing, client review, PDF export (2026-10-23)
- [x] Server mode: Postgres/Supabase, RLS, durable job queue, OpenAI adapter (2026-10-23)
- [x] Browser e2e tests, docs, CI config (2026-10-23)
- [x] GitHub repo, `main` + `dev`, branching workflow (2026-11-20), now public; history scanned, no secrets
- [x] Cloudflare Workers deploy + `imaginarium.accurova.com` custom domain (2026-11-20)
- [x] Julian Unified UI: tokens, Chakra Petch / IBM Plex Sans / JetBrains Mono, cyan + magenta, dark default + light + System toggle (2026-11-20)
- [x] Demo labelling: `DEMO ACCOUNT`, banner, "demo" wording (2026-11-20)

## Pending tasks

Ordered by what unblocks the most. `[you]` = needs you (a click, a key or a decision), `[claude]` = I can do it when asked.

### 1. Ship the Unified UI + demo-label PR  (done 2026-11-20)
- [x] PR merged `feature/unified-ui-demo-label` → `dev` → `main`
- [x] Worker redeployed
- [ ] `[you]` Open https://imaginarium.accurova.com in a private window and look over the banner, dark and light themes

### 2. Deploy on push (Workers Builds)  `[you]`
Removes the manual `wrangler deploy` step.
- [ ] Open https://dash.cloudflare.com/c580c4403524273d1bece674117472dd/workers/services/view/accurova-imaginarium/production/settings and under **Build** choose *Connect to Git*
- [ ] Repo `TheBooleanJulian/accurova-imaginarium`, production branch `main`, root directory `/` (repo root, not a subfolder)
- [ ] Build command `npm ci && npm run build`, deploy command `npx wrangler deploy`
- [ ] Push a trivial change to `dev`, promote via PR, confirm the build runs

### 3. Decide whether server mode goes on Workers  `[you]` decide
Server mode (Hono API + job worker) is written for Node. On Workers it needs a port, and `sharp` (native image code) has no Workers equivalent.
Options, simplest first:
- [ ] **A. Stay demo-only.** Nothing to do. Good for showing the workflow, not for real client work.
- [ ] **B. Cloudflare Container or small Node host for the API**, static front end stays on Workers. Fewer code changes. Needs approval as new infrastructure.
- [ ] **C. Full Workers port**: replace `sharp` (Cloudflare Images or a WASM resizer), move the job queue to Queues or Cron + Postgres, swap `postgres` for Hyperdrive (the fleet's pattern, see `thebooleanjulian-db`). Largest change.
- [ ] Record the decision at the top of this file

### 4. Real-service credentials (only if 3 is B or C)  `[you]`
Keys never go in the repo; set them as Worker secrets (`npx wrangler secret put NAME`).
- [ ] Supabase: use the shared project (`thebooleanjulian-db`, own schema, least-privilege role), or create one at https://supabase.com/dashboard/new (Singapore `ap-southeast-1`)
- [ ] Apply migrations: `DATABASE_URL=... npm run db:migrate` (files in `supabase/migrations/`)
- [ ] OpenAI key: https://platform.openai.com/api-keys, then set `OPENAI_API_KEY`
- [ ] Set `AUTH_MODE=supabase`, `STORAGE=supabase`, `AI_PROVIDER=openai`, `VITE_BACKEND=server`, `SIGNING_SECRET`
- [ ] Run one real project end to end and check the output and the cost per job (README, "Known limitations")

### 5. Repo housekeeping  `[you]` decide, `[claude]` do
- [ ] Add a LICENSE. The repo is public with no license, which means all rights reserved. Pick one (the branding repo uses a dual open-source / commercial setup, see `../thebooleanjulian-branding/COMMERCIAL-LICENSE.md`)
- [ ] Remove `vercel.json` and the Vercel option from the README if Vercel is no longer a target
- [ ] Add `dev` as the default branch protection / required CI check if you want the workflow enforced

### 6. UI follow-ups from the Unified UI migration  `[claude]`
- [ ] Screenshot and review the editor canvas, client review page and PDF pack in dark and light (only the Projects page and user menu were checked visually)
- [ ] Contrast check (4.5:1 text, 3:1 borders) in both themes
- [ ] Magenta restraint pass: one magenta element per region (currently the brief node, "Real product" badge and "must" shots)
- [ ] The mock AI's sample palettes still include old teal and gold. They are sample content, not UI, but could be swapped
- [ ] The Tailwind names are kept for a small diff (`panel`, `raised`, `ink`...); rename to token names if you want them to match the spec exactly

### 7. Product follow-ups (from the README)  `[claude]`
- [ ] PDF fonts are Latin-only; embed a Noto Sans SC subset so Chinese briefs export correctly
- [ ] Email invites for client reviewers (currently copy-and-send links)
- [ ] Supabase Realtime instead of 2 s polling
- [ ] Pilot with a real Accurova campaign, then tune prompts in `src/core/prompts.ts` (bump `promptVersion`)

## How to deploy (manual, until task 2 is done)

Do the install and build outside Google Drive (npm breaks on Drive):

```powershell
robocopy "D:\My Drive\TheBooleanJulian_GD\accurova-imaginarium" "C:\Users\Temp\dev\accurova-imaginarium" /E /XD .git node_modules dist .data .demo
cd C:\Users\Temp\dev\accurova-imaginarium
npm ci
npm run build
npx wrangler deploy
```

Then check https://imaginarium.accurova.com. Rollback: `npx wrangler rollback`, or remove `routes` from `wrangler.jsonc` and redeploy.

## Decisions

- 2026-11-20: Hosted on Cloudflare Workers, tracked here instead of `zeabur-migration/progress.md` (Julian).
- 2026-11-20: Repo is public (Julian). It started private only because that was the default at creation.
- 2026-11-20: Browser-only demo is what is live; server mode is deferred (task 3).
