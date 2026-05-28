#!/usr/bin/env node
// Userspace PostgreSQL lifecycle via embedded-postgres binaries (no sudo, no Docker).
// Cluster data lives repo-local in .pgdata/ (gitignored). PG16 binaries.
// CLI: node scripts/db.mjs <init|start|stop>
//
// start/stop shell out to pg_ctl so the postmaster daemonizes and SURVIVES this
// process exiting. embedded-postgres' own .start() spawns postgres as a child
// and registers an exit hook that kills it when node exits — correct for a
// long-lived process, fatal for one-shot CLI use (PG would die the moment the
// command returns). init() stays on embedded-postgres because it is transient
// (initdb + createDatabase + clean shutdown, all in one process).
//
// Override: set USE_EMBEDDED_PG=false, or point DATABASE_URL at a non-local
// (or non-5432) host, to skip embedded-pg entirely (use an external server).
import EmbeddedPostgres from "embedded-postgres";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const dataDir = join(repoRoot, ".pgdata");
const logFile = join(dataDir, "server.log");

const USER = "metamcp_user";
const PASSWORD = "m3t4mcp";
const DATABASE = "metamcp_db";
const PORT = 5432;

// embedded-postgres runs initdb the first time; a cluster is initialised iff
// PG_VERSION exists in the data dir. initialise() must not run twice.
const isInitialised = () => existsSync(join(dataDir, "PG_VERSION"));

function skipReason() {
  if (process.env.USE_EMBEDDED_PG === "false") return "USE_EMBEDDED_PG=false";
  const url = process.env.DATABASE_URL;
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
