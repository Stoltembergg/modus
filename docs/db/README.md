# Database and backend sources

This directory contains the Supabase-backed account, billing, and model-router
sources. It includes executable backend code and regression tests alongside the
database migrations.

| Path | Contents |
| --- | --- |
| `migrations/` | Ordered SQL migrations; existing migration contents are preserved |
| `functions/` | Deno Edge Functions, shared modules, and unit tests |
| `tests/` | Disposable PostgreSQL test runner, pgTAP suites, and concurrency checks |

## Local validation

Run from the repository root:

```bash
npm run test:supabase
npm run test:functions
```

The existing command names are retained. The SQL suite creates a temporary local
PostgreSQL cluster and never connects to the hosted project. It requires
PostgreSQL 15+, pgTAP, `pg_prove`, and Deno. The Functions suite uses Deno; CI pins
the runtime version in [ci.yml](../../.github/workflows/ci.yml).

See the [SQL test guide](./tests/README.md) and
[Edge Functions guide](./functions/README.md) for details.

## Supabase CLI layout

`docs/db/` is the source location in this repository. It does not include a
Supabase CLI `config.toml`; CLI projects use the conventional
`supabase/config.toml` layout. Use a separately configured CLI workspace and copy
the required migrations and Functions into that workspace before CLI deployment.
Supply local environment files explicitly; moving these sources does not
configure a CLI project or deploy anything to a hosted database.

Historical comments in existing SQL migrations and rollback scripts retain their
original source paths. Current sources live under `docs/db/`.
