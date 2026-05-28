#!/usr/bin/env node
// Userspace PostgreSQL lifecycle via embedded-postgres binaries (no sudo, no Docker).
// Cluster data lives repo-local in .pgdata/ (gitignored) by default. PG16 binaries.
// CLI: node scripts/db.mjs <init|start|stop>
//
// start/stop shell out to pg_ctl so the postmaster daemonizes and SURVIVES this
// process exiting. embedded-postgres' own .start() spawns postgres as a child
// and registers an exit hook that kills it when node exits — correct for a
// long-lived process, fatal for one-shot CLI use (PG would die the moment the
// command returns). init() stays on embedded-postgres because it is transient
// (initdb + createDatabase + clean shutdown, all in one process).
//
// Configuration (read from repo-root .env, with defaults):
//   POSTGRES_PORT (5432), POSTGRES_USER (metamcp_user), POSTGRES_PASSWORD (m3t4mcp),
//   POSTGRES_DB (metamcp_db) — set POSTGRES_PORT=5433 to coexist with a system
//   PostgreSQL on 5432 without sudo.
//   CLAUDE_META_PGDATA — relocate the cluster data dir (default: repo .pgdata/).
//
// Override: set USE_EMBEDDED_PG=false / USE_EXTERNAL_PG=1, or point DATABASE_URL
// at a non-local (or non-PORT) host, to skip embedded-pg entirely.
import EmbeddedPostgres from "embedded-postgres";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");

// ---- .env -------------------------------------------------------------------
// db.mjs is invoked as a one-shot CLI (by package.json scripts and by the
// supervisor) that does NOT inherit a dotenv-loaded environment, so it reads
// repo-root .env itself. Same parser/expansion as scripts/claude-meta-supervisor.mjs.
function parseEnv(text) {
  const out = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (val[0] === '"' || val[0] === "'") {
      const q = val[0];
      const end = val.indexOf(q, 1);
      val = end > 0 ? val.slice(1, end) : val.slice(1);
    } else {
      const c = val.indexOf(" #"); // strip trailing inline comment on bare values
      if (c >= 0) val = val.slice(0, c).trim();
    }
    out[key] = val;
  }
  return out;
}

function loadEnv() {
  const merged = { ...process.env };
  const envFile = join(repoRoot, ".env");
  if (!existsSync(envFile)) return merged;
  const parsed = parseEnv(readFileSync(envFile, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    merged[k] = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => merged[n] ?? "");
  }
  return merged;
}

const env = loadEnv();

const PORT = Number(env.POSTGRES_PORT) || 5432;
const USER = env.POSTGRES_USER || "metamcp_user";
const PASSWORD = env.POSTGRES_PASSWORD || "m3t4mcp";
const DATABASE = env.POSTGRES_DB || "metamcp_db";

// Data dir: explicit CLAUDE_META_PGDATA is the user's choice (used as-is); the
// default repo-local .pgdata/ may be auto-relocated on filesystems that cannot
// hold a 0700 dir (see ensureUsableDataDir).
const explicitDataDir = !!env.CLAUDE_META_PGDATA;
const dataDir = env.CLAUDE_META_PGDATA || join(repoRoot, ".pgdata");
const logFile = join(dataDir, "server.log");

// embedded-postgres runs initdb the first time; a cluster is initialised iff
// PG_VERSION exists in the data dir. initialise() must not run twice.
const isInitialised = () => existsSync(join(dataDir, "PG_VERSION"));

const isFalsey = (v) =>
  v != null && ["0", "false", "no", "off"].includes(String(v).trim().toLowerCase());
const isTruthy = (v) => v != null && String(v).trim() !== "" && !isFalsey(v);

function skipReason() {
  if (env.USE_EMBEDDED_PG === "false") return "USE_EMBEDDED_PG=false";
  if (isTruthy(env.USE_EXTERNAL_PG)) return "USE_EXTERNAL_PG set";
  const url = env.DATABASE_URL;
  if (url) {
    try {
      const u = new URL(url);
      const host = u.hostname;
      const port = u.port || "5432";
      const isLocal =
        (host === "localhost" || host === "127.0.0.1") && port === String(PORT);
      if (!isLocal) return `DATABASE_URL points elsewhere (${host}:${port})`;
    } catch {
      // unparseable DATABASE_URL: fall through and manage embedded-pg
    }
  }
  return null;
}

// PostgreSQL refuses a data dir that isn't 0700/0750. On filesystems that don't
// honor chmod (e.g. WSL's /mnt/c 9p/DrvFs mount, where 0700 silently stays
// 0777), initdb fails with "invalid permissions". For the DEFAULT location we
// detect this and relocate the cluster onto an ext4 path under $HOME, leaving a
// symlink so init/start/stop keep using the same .pgdata path. An explicit
// CLAUDE_META_PGDATA is trusted as-is (no probe, no relocation).
function ensureUsableDataDir() {
  if (explicitDataDir || isInitialised()) return;
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    if ((statSync(dataDir).mode & 0o777) === 0o700) return; // FS honors perms
  } catch {
    // fall through to relocation
  }
  const fallback = join(homedir(), ".local", "share", "claude-meta", "pgdata");
  mkdirSync(fallback, { recursive: true, mode: 0o700 });
  chmodSync(fallback, 0o700);
  rmSync(dataDir, { recursive: true, force: true });
  symlinkSync(fallback, dataDir);
  console.log(
    `[db] ${dataDir} can't hold a 0700 dir (e.g. WSL /mnt/c); cluster relocated to ${fallback} (symlinked)`,
  );
}

function makePg() {
  return new EmbeddedPostgres({
    databaseDir: dataDir,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
    onError: (err) => console.error("[embedded-pg]", err?.message ?? err),
  });
}

async function ensureDatabase(pg) {
  try {
    await pg.createDatabase(DATABASE);
    console.log(`[db] created database ${DATABASE}`);
  } catch (err) {
    if (/already exists/i.test(String(err?.message ?? err))) {
      console.log(`[db] database ${DATABASE} already exists`);
    } else {
      throw err;
    }
  }
}

// Resolve the platform pg_ctl binary the same way embedded-postgres resolves
// its own binaries (via its binary.js), so this stays correct across OS/arch
// and the pnpm node_modules layout where the platform package is not hoisted.
async function resolvePgCtl() {
  const req = createRequire(import.meta.url);
  const epIndex = req.resolve("embedded-postgres");
  const binaryJs = join(dirname(epIndex), "binary.js");
  const { default: getBinaries } = await import(pathToFileURL(binaryJs).href);
  const { pg_ctl } = await getBinaries();
  return pg_ctl;
}

function runPgCtl(pgCtl, args) {
  const r = spawnSync(pgCtl, ["-D", dataDir, ...args], { stdio: "inherit" });
  if (r.error) throw r.error;
  return r.status;
}

// pg_ctl status: 0 = running, 3 = stopped, 4 = no/invalid data dir.
async function isRunning(pgCtl) {
  return runPgCtl(pgCtl, ["status"]) === 0;
}

async function init() {
  ensureUsableDataDir();
  const pg = makePg();
  if (!isInitialised()) {
    console.log(`[db] initialising cluster in ${dataDir}`);
    await pg.initialise();
  } else {
    console.log("[db] cluster already initialised, skipping initdb");
  }
  await pg.start();
  await ensureDatabase(pg);
  await pg.stop();
  console.log("[db] init complete");
}

async function start() {
  if (!isInitialised()) {
    console.log("[db] cluster not initialised; running init first");
    await init();
  }
  const pgCtl = await resolvePgCtl();
  if (await isRunning(pgCtl)) {
    console.log(`[db] already running on port ${PORT}`);
    return;
  }
  // -w waits until ready; -l captures the postmaster log; -o passes the port.
  // pg_ctl forks the postmaster into its own session, so it outlives this CLI.
  const status = runPgCtl(pgCtl, ["-l", logFile, "-o", `-p ${PORT}`, "-w", "start"]);
  if (status !== 0) throw new Error(`pg_ctl start failed (exit ${status})`);
  console.log(`[db] started on port ${PORT}`);
}

async function stop() {
  if (!isInitialised()) {
    console.log("[db] no cluster to stop");
    return;
  }
  const pgCtl = await resolvePgCtl();
  if (!(await isRunning(pgCtl))) {
    console.log("[db] not running");
    return;
  }
  const status = runPgCtl(pgCtl, ["-m", "fast", "-w", "stop"]);
  if (status !== 0) throw new Error(`pg_ctl stop failed (exit ${status})`);
  console.log("[db] stopped");
}

async function main() {
  const skip = skipReason();
  if (skip) {
    console.log(`[db] skipping embedded-postgres: ${skip}`);
    return;
  }
  const cmd = process.argv[2];
  switch (cmd) {
    case "init":
      return init();
    case "start":
      return start();
    case "stop":
      return stop();
    default:
      console.error("usage: node scripts/db.mjs <init|start|stop>");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("[db] fatal:", err);
  process.exit(1);
});
