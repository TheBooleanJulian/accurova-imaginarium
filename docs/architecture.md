# Architecture notes

## State is split three ways

| Kind | Where | Changes when | Triggers AI? |
|---|---|---|---|
| Visual | `nodes.position`, `nodes.size` | dragging, resizing | never |
| Creative config | `nodes.data` (validated per type by `NODE_DEFS[type].configSchema`) | editing in the inspector | never, but can make outputs stale |
| Execution | `generation_jobs`, `node_runs`, `assets` | only when someone presses Run | — |

Nodes carry a `schemaVersion`. `normalizeNodeData` upgrades stored data through `MIGRATIONS` before validating, so node types can evolve without breaking saved graphs.

## Graph rules (`src/core/graph.ts`)

- Ports are typed (`brief`, `images`, `analysis`, `text`, `direction`, `shotplan`, `approved`). A connection is valid only when the types match, the input accepts another edge and no cycle would form. The same function validates in the browser (while dragging) and on the server (on save).
- `resolveInputs` computes what flows into each input from upstream outputs. Image outputs respect the node's selection and its **active run**: a pinned run, otherwise the newest run, unless that would hide an approved asset.
- `buildInputSnapshot` builds a job's exact inputs: the config keys that affect the operation, the resolved inputs and the prompt version. Its hash identifies the inputs. `opStatus` compares that hash with the active run's hash: `never_run`, `fresh` or `stale`.
- Approval nodes emit only the **newest version of each lineage** that the client approved. An older approved version stays on record but doesn't flow downstream.

## Jobs (`src/core/jobEngine.ts`, `server/jobs/pgJobStore.ts`)

```
submit ─▶ queued ─claim─▶ running ─▶ (store files ▶ insert run) ─▶ succeeded
              ▲             │  └─retryable error, attempts left─┐
              └── run_after ◀───────────── backoff ◀─────────────┘
                            ├─ non-retryable / out of attempts ─▶ failed
                            └─ cancel (local abort or cancel_requested) ─▶ cancelled
```

- **Submit** is rejected when required inputs are missing, the op isn't ready (e.g. no direction chosen) or the user hit their daily limit. It dedupes on the idempotency key, on a live job for the same node operation (`generation_jobs_one_active`), and on unchanged inputs (`up_to_date`). `force` asks for a new version on purpose.
- **Claiming** uses `FOR UPDATE SKIP LOCKED` and respects `MAX_CONCURRENT_JOBS_PER_PROJECT`. The worker holding a job renews `locked_at` every 10 s. A job whose lease expires is claimed again, or failed if it has no attempts left.
- **Durability**: generated files are written to storage and recorded as `assets` first, then the `node_run` is inserted, and only then is the job marked `succeeded`.
- **Where it runs**: on a long-running host, every API process also polls the queue (`WORKER=inline`). On Vercel, the request that submits a job keeps its function alive until the job finishes (`waitUntil`), and a cron tick picks up anything left over.

## Assets and provenance

`assets.source_type` (`upload`, `ai_generated`, `export`) and `assets.role` (`product`, `brand`, `reference`, `concept`, `pose`, `edit`, `export`) drive the labels everywhere: "Real product", "Reference", "AI concept", "AI pose ref", "AI edit vN". A database check ties uploads to the product, brand and reference roles. Lineage: `parent_asset_id` (derived from), `version_of` (root of an edit chain) and `version`. The `image_edit` op refuses to edit uploaded product photos.

## Permissions

`src/core/permissions.ts` is the role matrix. The UI uses it to show or hide controls, the API enforces it, and `supabase/migrations/*_rls.sql` implements it again in SQL. User requests run inside `Db.asUser()`: `set local role authenticated` plus `request.jwt.claims`, exactly as PostgREST does. Supabase's `auth.uid()` therefore works unchanged, and a local shim provides it on plain Postgres or PGlite.

## Adding a node type

1. Add the type to `NODE_TYPES` (`src/core/types.ts`) and the check constraint in a new migration.
2. Add a `NodeDef` in `src/core/nodeRegistry.ts`: ports, config schema, operations (`hashKeys`, `promptVersion`).
3. Add output resolution in `getOutputValue` (`src/core/graph.ts`), an executor case (`src/core/executors.ts`), a prompt (`src/core/prompts.ts`), and an inspector (`src/features/editor/inspectors`).
4. Add tests next to the existing ones.
