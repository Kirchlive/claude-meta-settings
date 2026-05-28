# Running claude-meta-settings natively (no Docker, no sudo)

claude-meta-settings is just **two Node processes plus PostgreSQL**, and it runs
directly on a host with **no Docker and no sudo**. The backend (Express/tRPC) listens
on **12009**; the Next.js frontend listens on **12008** and proxies the backend paths
(`/metamcp`, `/mcp-proxy`, `/trpc`, `/api/auth`, `/oauth`, `/.well-known`, `/health`)
to `http://localhost:12009`.

PostgreSQL is provisioned automatically as a **userspace** database via
[`embedded-postgres`](https://www.npmjs.com/package/embedded-postgres) (PostgreSQL 16
binaries downloaded at install time, data stored repo-locally in `.pgdata/`). No system
PostgreSQL install and no manual `CREATE ROLE/DATABASE` step are required.

## Prerequisites

- **Node.js 20+** and **pnpm 9** (matches the root `packageManager`).
- For STDIO MCP servers to launch, the runtime `PATH` must include whatever those
  servers need (`node`, `npx`, `uvx`, etc.).

That's it — no PostgreSQL, no Docker, no sudo.

## Quick setup (one command)

```bash
git clone https://github.com/Kirchlive/claude-meta-settings.git
cd claude-meta-settings
cp example.env .env          # adjust BETTER_AUTH_SECRET (openssl rand -hex 32) etc.
pnpm install && pnpm run setup
```

`pnpm run setup` runs, sudo-free, in this order:

1. **install + patch** — dependencies install, and the `postinstall` hook patches the
   Next.js proxy timeout (30s → 600s) for long-running MCP calls.
2. **db init** — `embedded-postgres` initializes a userspace PostgreSQL in `.pgdata/`
   and creates the `metamcp_user` role and `metamcp_db` database (idempotent).
3. **build** — backend (tsup → `apps/backend/dist`) and frontend (`next build`).
4. **migrate** — `drizzle-kit migrate` applies the schema.
5. **hooks** — `scripts/install-claude-hooks.sh` registers the Claude Code session hooks.

> **First install tip:** set `LOG_LEVEL=info` in `.env` to see bootstrap/startup logs
> (namespaces, endpoints, and API keys being created). Default is `errors-only`.

## Configuration (`.env`)

`cp example.env .env`, then set at least:

- `BETTER_AUTH_SECRET=` — a strong random value, e.g. `openssl rand -hex 32`
- `APP_URL` and `NEXT_PUBLIC_APP_URL` — the public URL of the frontend (default
  `http://localhost:12008`)
- `TRANSFORM_LOCALHOST_TO_DOCKER_INTERNAL=false` — keep off natively (it rewrites MCP
  server URLs to `host.docker.internal`, which only exists inside Docker)

The `POSTGRES_*` / `DATABASE_URL` defaults in `example.env` match the embedded database,
so you normally don't need to touch them.

> `NEXT_PUBLIC_APP_URL` is inlined into the frontend bundle at **build** time, so it
> must be set before the build (the `setup` script handles this). The other variables
> are read at runtime.

### Using an existing PostgreSQL instead

If you already run PostgreSQL and would rather use it, point `DATABASE_URL` at it (a
non-`localhost` host) or set `USE_EXTERNAL_PG=1`. The embedded database is then skipped
entirely and your server is used as-is. You are responsible for the role/database in
that case.

## The session-bound lifecycle

Setup registers `SessionStart`/`SessionEnd` hooks in `~/.claude/settings.json` that tie
the stack to your Claude Code sessions via a reference-counted supervisor
(`scripts/claude-meta-supervisor.mjs`, state under `~/.claude/claude-meta/`):

- **First session (0 → 1):** starts the stack in order embedded PostgreSQL → backend
  `:12009` → frontend `:12008`, then blocks until `http://localhost:12008/health`
  returns `200`. This health gate means the meta MCP server is reachable on the first
  try — no `/mcp` reconnect.
- **Additional sessions:** increment the refcount; the stack keeps running.
- **Last session (1 → 0):** stops the stack and frees ports `12008`, `12009`, `5432`.
- **Self-healing:** if a session ends uncleanly (crash / `kill -9`) and leaves a stale
  refcount, the next `SessionStart` detects that `:12008` is not healthy and cleanly
  restarts.

Manage the hooks manually:

```bash
sh scripts/install-claude-hooks.sh      # also run by `pnpm run setup`
sh scripts/uninstall-claude-hooks.sh    # remove the session hooks
```

## Manual start / stop

To run the stack without the session hooks:

```bash
pnpm start    # embedded PostgreSQL → backend → frontend, with health gate on :12008
pnpm stop     # stops the stack, frees the ports
```

You can also control just the database with `pnpm db:start` / `pnpm db:stop`.

## Reverse proxy (optional)

`deploy/nginx-metamcp.conf` is a ready-to-use nginx server block that proxies
`:80 → 127.0.0.1:12008` with SSE-friendly long timeouts and buffering off. Add TLS only
if the host is publicly reachable.

> Note: with the session-bound lifecycle the frontend is only up while a Claude Code
> session is open, so a `:80` reverse proxy is reachable only during that time. For
> always-on access, use the external-PostgreSQL mode with a process manager
> (systemd/launchd/pm2) instead of the session hooks.

## Migrating an existing Docker deployment

Dump the dockerized database and restore it into the native database. With the embedded
database, start it first so it's listening on `:5432`:

```bash
pnpm db:start
docker exec <pg-container> pg_dump -U USER -d DB --no-privileges > metamcp.sql
psql "$DATABASE_URL" -f metamcp.sql
```

STDIO MCP servers registered while running under Docker may have stored
**container-only paths** in `mcp_servers` (e.g. `/opt/...`, `/app/...`, or
`host.docker.internal`). Repoint them to host paths. Inspect first:

```sql
SELECT uuid, name, command, args, env FROM mcp_servers
WHERE array_to_string(args, ' ') LIKE '%/opt/%'
   OR array_to_string(args, ' ') LIKE '%/app/%'
   OR env::text LIKE '%host.docker.internal%';
```

Then update each affected row (`args` is `text[]`, `env` is `jsonb`):

```sql
UPDATE mcp_servers
SET args = ARRAY['/absolute/host/path/to/server.js']::text[],
    env  = jsonb_set(env, '{SOME_HOST}', '"127.0.0.1"', true)
WHERE uuid = '<server-uuid>';
```
