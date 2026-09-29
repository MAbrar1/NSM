# ═══════════════════════════════════════════════════════════════
# ELITE POS — DATABASE MIGRATIONS RUNBOOK
# From SQLite dev (`prisma db push`) to versioned migrations and a
# production PostgreSQL database — without losing data.
# ═══════════════════════════════════════════════════════════════

This project has two database regimes:

| Regime | Provider | Workflow | Used by |
|---|---|---|---|
| Local development | SQLite (`file:./dev.db`) | `npm run db:push` — schema sync, no migration files | `npm run dev`, tests |
| Staging / production | PostgreSQL | Versioned migrations via `prisma migrate` | `npm run db:migrate:deploy` |

The schema in `prisma/schema.prisma` is the single source of truth for
both. Only the *workflow* differs.

---

## 1. Daily development (SQLite)

```bash
# After editing prisma/schema.prisma:
npm run db:push        # sync schema to dev.db (no migration files)
npm run db:seed        # load realistic demo data (destroys existing rows!)
```

`db push` is intentionally used in dev: it keeps iteration fast and the
`dev.db` file is disposable. **Never** point a production deploy at a
database managed by `db push` — there is no migration history to apply.

## 2. Production switch (PostgreSQL)

### Step 1 — Provision the database

Create the database and a least-privilege user. Example for a
self-managed Postgres:

```sql
CREATE DATABASE elite_pos;
CREATE USER elite_pos_app WITH PASSWORD '<strong-password>';
GRANT ALL PRIVILEGES ON DATABASE elite_pos TO elite_pos_app;
```

(Managed providers — Neon, Supabase, RDS — give you a connection string
instead; skip to step 2.)

### Step 2 — Point the app at Postgres

```bash
# .env (or the platform's env settings)
DATABASE_URL="postgresql://elite_pos_app:<password>@host:5432/elite_pos?schema=public"
```

The datasource in `prisma/schema.prisma` already documents this switch:

```prisma
datasource db {
  provider = "sqlite" // Switch to "postgresql" or "mysql" for production
  url      = env("DATABASE_URL")
}
```

Change `provider` to `"postgresql"` **when you create the first real
migration** (step 3), not before — the SQLite dev database keeps working
through `db push` as long as the provider matches the URL's engine.

### Step 3 — Create the baseline migration

The one-shot helper does all of this for you (SQL generation, folder
layout, `migrate resolve`):

```bash
# Against a database whose schema ALREADY matches schema.prisma
# (e.g. the dev database after db push, or the empty prod database
# right after `db push` was pointed at it once):
DATABASE_URL="postgresql://…" npx tsx scripts/db-migrate-baseline.ts "init"
```

It creates `prisma/migrations/0_init/migration.sql`, the
`migration_lock.toml`, and marks `0_init` as **applied** on the target
database — no data is touched. From then on, `migrate deploy` applies
only *new* migrations on top.

Manual equivalent, if you prefer:

```bash
npm run db:migrate:create   # → prisma migrate dev --create-only
npx prisma migrate dev      # applies locally; marks the migration as applied
```

Commit `prisma/migrations/` to version control. This folder is now the
deployment history — it must never be hand-edited after being applied
anywhere shared.

### Step 4 — Deploy schema changes from now on

```bash
# Local: create + apply a new migration in one step
npm run db:migrate

# CI/CD or the production host: apply pending migrations only
# (never resets data, never shadows the dev database)
npm run db:migrate:deploy

# Pipeline pre-check: fail the deploy when migrations are pending
npm run db:migrate:status
```

### Switching an existing SQLite dataset to Postgres

If you already have sales history in `dev.db` and must keep it:

1. Create the Postgres database (step 1).
2. Set `provider = "postgresql"` in `schema.prisma` and run
   `npm run db:migrate:create` against the empty Postgres database.
3. Copy the data with a one-off ETL (PgLoader, a Prisma script, or
   `pg_dump`/CSV round-trip). Do **not** use `prisma db push` for this.
4. Run `npm run db:migrate:deploy` — it will report the baseline as
   applied; from here the normal migration workflow takes over.

## 3. Operational rules

- **Never run `prisma migrate reset` against production.** It drops all
  data. There is no confirmation prompt when run from CI.
- **Every schema change ships as a migration.** Edit `schema.prisma`,
  run `db:migrate:create`, review the SQL, then commit both together.
- **Order matters on concurrent deploys:** `migrate deploy` applies
  pending migrations in timestamp order and records them in
  `_prisma_migrations`; two simultaneous deploys serialize safely.
- **Backup before destructive migrations** (dropping columns, changing
  types). On managed providers take a snapshot; otherwise
  `pg_dump elite_pos > backup.sql`.
- **`prisma db push` is dev-only.** CI should fail if it detects schema
  drift on a migrate-managed database (`prisma migrate diff --exit-code`
  or simply `db:migrate:status`).

## 4. CI/CD pipeline

A ready-to-use GitHub Actions workflow lives at
`.github/workflows/ci.yml`. It runs on every push/PR:

1. `npm ci` + Prisma generate
2. `tsc --noEmit` (type gate)
3. **unit + integration tests** (integration tests push the schema into a
   throwaway SQLite temp database — no secrets needed)
4. `next build` (production compile gate)
5. On `main` only, with `PROD_DATABASE_URL` configured as a secret:
   `db:migrate:status` (gate) then `db:migrate:deploy` (apply pending
   migrations), before the app deploy step of your choice.

The deploy job is intentionally commented-out at the app-host step —
wiring it to your host (VPS, Docker, serverless) is the last step and
is documented inline in the workflow.

`db:migrate:deploy` exits non-zero on failure, so a failed migration
stops the pipeline before the app restarts against a half-migrated
schema.
