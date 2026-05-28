# claude-meta-settings — WSL Fresh-Install (Run 3, 2026-05-28)

Third clean-install test on WSL (`/mnt/c/Development`), against the repo state
that fixes the three issues found in run 2 (setup ordering, configurable
PG port, WSL `/mnt/c` datadir). Goal: confirm `pnpm install && pnpm run setup`
runs end-to-end with **no manual intervention**.

> Secrets in this transcript are throwaway test-instance credentials and have
> been redacted (`<redacted>`).

---

## 0. Clean state

```
$ ls -la /mnt/c/Development/claude-meta-settings  → No such file or directory
$ ls -la ~/.cms-pgdata                            → No such file or directory   (run-2 workaround dir, gone)
$ ss -ltn | grep ':5432'                          → 5432 frei
$ node --version → v22.22.2 ; pnpm --version → 11.2.2 ; git present
```

System PostgreSQL stopped from the previous test → :5432 free. Prerequisites OK.

## 1. Clone

```
$ git clone https://github.com/Kirchlive/claude-meta-settings.git
Cloning into 'claude-meta-settings'... Updating files: 100% (361/361), done.
```

## 2. Confirm the run-2 fixes are present

- `scripts/db.mjs` → `ensureUsableDataDir()` (auto-relocate on FS that won't hold 0700) + `POSTGRES_PORT`/`CLAUDE_META_PGDATA` read from `.env`.
- `package.json` setup chain → `node scripts/db.mjs init && pnpm build && node scripts/db.mjs start && pnpm --filter backend db:migrate && sh scripts/install-claude-hooks.sh` (`db:start` back before migrate).
- `example.env` → documents `POSTGRES_PORT` coexistence + `CLAUDE_META_PGDATA`.
- `README.md` → WSL section ("auto-relocates the cluster to an ext4 path").

## 3. Configure `.env`

```
$ cp example.env .env
$ SECRET=$(openssl rand -hex 32); sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$SECRET|" .env
$ sed -i "s|^LOG_LEVEL=.*|LOG_LEVEL='info'|" .env

LOG_LEVEL='info'
POSTGRES_PORT=5432
APP_URL=http://localhost:12008
BETTER_AUTH_SECRET=<redacted>
BOOTSTRAP_ENABLE=true
```

## 4. `pnpm install`

```
dependencies:  + embedded-postgres 16.13.0-beta.17
devDependencies: + dotenv-cli 8.0.0  + prettier 3.5.3  + turbo 2.5.5  + typescript 5.8.2

. postinstall$ sh scripts/patch-next-proxy-timeout.sh || true
. postinstall: patched 30000->600000:  …/next/dist/esm/server/lib/router-utils/proxy-request.js
. postinstall: patched 30000->600000:  …/next/dist/server/lib/router-utils/proxy-request.js
. postinstall: Done. patched=2 skipped=0 found=2
Done in 1m 37.6s
```

Proxy-timeout patch applied automatically via `postinstall`.

## 5. `pnpm run setup` — one pass, no manual steps

```
 Tasks:    4 successful, 4 total     (turbo build)
 Time:     3m50s

pg_ctl: no server running
waiting for server to start.... done
server started
[db] started on port 5432

> backend@1.0.0 db:migrate
> dotenv -e ../../.env -- drizzle-kit migrate
[✓] migrations applied successfully!

Merged claude-meta hooks into /home/rob/.claude/settings.json
ACTION REQUIRED: added placeholder mcpServers.meta to /home/rob/.claude.json — replace <endpoint> and <token> with your endpoint name and API key.
Done. Start/stop is now tied to Claude Code sessions; refcount dir: /home/rob/.claude/claude-meta
```

✅ **No `ECONNREFUSED`** — `db.mjs start` ran before `db:migrate` (the run-2 bug is fixed). Build green, migrations applied, hooks registered.

## 6. Start stack + health gate

```
$ pnpm start  →  node scripts/claude-meta-supervisor.mjs up
pg_ctl: server is running (PID: …) … "-p" "5432"
[db] already running on port 5432

$ curl -sf http://localhost:12008/health   →  {"status":"ok"}
$ ss -ltn | grep -E ':1200[89]|:5432'
  :5432  (postgres)   :12009 (node backend)   :12008 (next-server frontend)
```

## 7. Wire `~/.claude.json` `meta` entry

Bootstrap created: user `test@user.example`, namespace `Default`, endpoint
`Public` (auth disabled), public + private API keys. Keys are masked in logs →
read from the `api_keys` table (no `psql` shipped; query via the `pg` package
from `apps/backend`). Note: `api_keys` has no `is_public` column — ownership is
via `user_id` (`null` = public). `DATABASE_URL`'s `${VAR}` form isn't expanded
by plain `dotenv`, so build the connection string from `POSTGRES_*` when querying.

```
api_keys:
  Public  key=sk_mt_<redacted>  user_id=null
  Private key=sk_mt_<redacted>  user_id=…
```

```
$ # set ~/.claude.json mcpServers.meta:
  { "type":"http", "url":"http://localhost:12008/metamcp/Public/mcp",
    "headers": { "Authorization": "Bearer sk_mt_<redacted>" } }
```

## 8. Verify MCP endpoint (initialize handshake)

```
$ curl -s -X POST http://localhost:12008/metamcp/Public/mcp \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer sk_mt_<redacted>" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize", … }'

event: message
data: {"result":{"protocolVersion":"2024-11-05","capabilities":{"prompts":{},"resources":{},"tools":{}},
       "serverInfo":{"name":"metamcp-unified-…","version":"1.0.0"}},"jsonrpc":"2.0","id":1}
```

✅ Handshake succeeds — the `meta` MCP server is registered and functional.

---

## Result

All three run-2 bugs are fixed in the repo; `pnpm install && pnpm run setup`
completed in a single pass with **zero manual intervention**:

| Run-2 bug | Fix confirmed in run 3 |
|---|---|
| `/mnt/c` `chmod 0700` doesn't stick | `db.mjs` auto-relocates cluster to `~/.local/share/claude-meta/pgdata` (symlink) |
| `:5432` conflict forced `sudo` | `POSTGRES_PORT` configurable (was free here → default) |
| setup ran migrate before DB up | `db:start` now precedes `db:migrate` → no `ECONNREFUSED` |

Stack live: embedded PostgreSQL 16 :5432, backend :12009, frontend :12008
(health `{"status":"ok"}`), session hooks registered, MCP handshake verified.
