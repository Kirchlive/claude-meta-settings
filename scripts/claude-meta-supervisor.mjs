#!/usr/bin/env node
// Session-lifecycle supervisor for the claude-meta-settings stack.
//
//   node scripts/claude-meta-supervisor.mjs up     # ref 0->1 starts the stack
//   node scripts/claude-meta-supervisor.mjs down   # ref 1->0 stops the stack
//
// Refcount + lock under ~/.claude/claude-meta/ coordinate parallel Claude Code
// sessions: the first session starts the stack, the last one stops it. `up`
// blocks on a health-gate against :12008 so the mcpServers http entry connects
// on the first try. `down` is fast (SIGKILL) to stay inside the SessionEnd
// timeout. Orphaned state (crash / kill -9, where SessionEnd never fired) is
// self-healed on the next `up`.

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const STATE_DIR = join(homedir(), ".claude", "claude-meta");
const COUNTER_FILE = join(STATE_DIR, "refcount");
const LOCK_FILE = join(STATE_DIR, "lock");
const PIDS_FILE = join(STATE_DIR, "pids.json");
const BACKEND_LOG = join(STATE_DIR, "backend.log");
const FRONTEND_LOG = join(STATE_DIR, "frontend.log");

const FRONTEND_PORT = 12008;
const HEALTH_URL = `http://localhost:${FRONTEND_PORT}/health`;

const DB_SCRIPT = join(REPO_ROOT, "scripts", "db.mjs");
const BACKEND_ENTRY = join("apps", "backend", "dist", "index.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- lock -----------------------------------------------------------------

const LOCK_STALE_MS = 30_000;

async function acquireLock(timeoutMs = 10_000) {
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(LOCK_FILE, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Break a stale lock left by a crashed holder.
      try {
        if (Date.now() - statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) {
          rmSync(LOCK_FILE, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        rmSync(LOCK_FILE, { force: true });
        continue;
      }
      await sleep(100);
    }
  }
}

function releaseLock() {
  try {
    rmSync(LOCK_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

// ---- refcount / pids ------------------------------------------------------

function readCounter() {
  try {
    const n = parseInt(readFileSync(COUNTER_FILE, "utf8").trim() || "0", 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeCounter(n) {
  writeFileSync(COUNTER_FILE, String(Math.max(0, n)));
}

function readPids() {
  try {
    return JSON.parse(readFileSync(PIDS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writePids(p) {
  writeFileSync(PIDS_FILE, JSON.stringify(p, null, 2));
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---- health ---------------------------------------------------------------

async function healthOk(timeoutMs = 2_000) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(HEALTH_URL, { signal: ac.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(timeoutMs = 60_000, intervalMs = 1_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await healthOk()) return true;
    await sleep(intervalMs);
  }
  return false;
}

// ---- stack control --------------------------------------------------------

function startDetached(command, args, logFile) {
  const out = openSync(logFile, "a");
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  return child.pid;
}

async function startStack() {
  mkdirSync(STATE_DIR, { recursive: true });

  // 1. embedded postgres (owned by scripts/db.mjs, created by Fork-C)
  const db = spawnSync(process.execPath, [DB_SCRIPT, "start"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (db.status !== 0) {
    throw new Error(`db start failed (exit ${db.status})`);
  }

  // 2. backend (loads .env via dotenv from repo-root cwd, listens on :12009)
  const backendPid = startDetached(
    process.execPath,
    [BACKEND_ENTRY],
    BACKEND_LOG,
  );

  // 3. frontend (Next.js, :12008, proxies /metamcp/ -> :12009)
  const frontendPid = startDetached(
    "pnpm",
    ["--filter", "frontend", "start"],
    FRONTEND_LOG,
  );

  writePids({ backend: backendPid, frontend: frontendPid });

  if (!(await waitForHealth())) {
    throw new Error(`health gate timed out waiting for ${HEALTH_URL}`);
  }
}

function killGroup(pid) {
  if (!pid) return;
  // Detached children lead their own process group; kill the whole group so
  // pnpm's `next start` child dies too.
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* group already gone */
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

function stopStack() {
  const pids = readPids();
  killGroup(pids.frontend);
  killGroup(pids.backend);
  // Fast DB shutdown; bounded so `down` stays inside the SessionEnd budget.
  spawnSync(process.execPath, [DB_SCRIPT, "stop"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    timeout: 4_000,
  });
  writePids({});
}

// ---- commands -------------------------------------------------------------

async function up() {
  mkdirSync(STATE_DIR, { recursive: true });
  await acquireLock();
  try {
    let counter = readCounter();
    const running = await healthOk();

    // Self-heal: counter claims sessions are active but the stack is down
    // (crash / kill -9 / SessionEnd never fired). Reset and rebuild.
    if (counter > 0 && !running) {
      stopStack();
      counter = 0;
    }

    writeCounter(counter + 1);

    if (!running) {
      await startStack();
    }
  } finally {
    releaseLock();
  }
}

async function down() {
  mkdirSync(STATE_DIR, { recursive: true });
  // Short lock timeout: SessionEnd has a tight budget, never block on it.
  await acquireLock(1_500);
  try {
    const next = Math.max(0, readCounter() - 1);
    writeCounter(next);
    if (next === 0) {
      stopStack();
    }
  } finally {
    releaseLock();
  }
}

const cmd = process.argv[2];

(async () => {
  try {
    if (cmd === "up") await up();
    else if (cmd === "down") await down();
    else {
      console.error("usage: claude-meta-supervisor.mjs <up|down>");
      process.exit(2);
    }
  } catch (e) {
    console.error(`[claude-meta-supervisor] ${e.message}`);
    process.exit(1);
  }
})();
