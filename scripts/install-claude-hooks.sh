#!/bin/sh
# Register claude-meta-settings with the Claude Code session lifecycle.
#
# Non-destructive and idempotent: merges SessionStart/SessionEnd hooks into
# ~/.claude/settings.json (preserving any existing hooks/settings) and ensures
# the meta mcpServers http entry exists in ~/.claude.json without overwriting a
# present one. Run once per machine.
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUP="$REPO_ROOT/scripts/claude-meta-supervisor.mjs"
SETTINGS="$HOME/.claude/settings.json"
CLAUDE_JSON="$HOME/.claude.json"
STATE_DIR="$HOME/.claude/claude-meta"

mkdir -p "$HOME/.claude"
mkdir -p "$STATE_DIR"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"

UP_CMD="node $SUP up"
DOWN_CMD="node $SUP down"

# --- merge hooks into settings.json (idempotent) ---------------------------
node - "$SETTINGS" "$UP_CMD" "$DOWN_CMD" <<'NODE'
const fs = require("fs");
const [, , file, upCmd, downCmd] = process.argv;
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, "utf8") || "{}"); } catch { cfg = {}; }
cfg.hooks = cfg.hooks || {};

function ensure(event, matcher, command) {
  const arr = (cfg.hooks[event] = cfg.hooks[event] || []);
  for (const grp of arr) {
    for (const h of grp.hooks || []) {
      if (h.command === command) return false; // already registered
    }
  }
  const entry = { hooks: [{ type: "command", command }] };
  if (matcher) entry.matcher = matcher;
  arr.push(entry);
  return true;
}

let changed = false;
changed = ensure("SessionStart", "startup|resume", upCmd) || changed;
changed = ensure("SessionEnd", null, downCmd) || changed;
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
console.log(changed
  ? "Merged claude-meta hooks into " + file
  : "claude-meta hooks already present in " + file);
NODE

# --- ensure meta mcpServers entry in ~/.claude.json ------------------------
if [ -f "$CLAUDE_JSON" ]; then
  node - "$CLAUDE_JSON" <<'NODE'
const fs = require("fs");
const [, , file] = process.argv;
let cfg;
try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); }
catch (e) { console.error("Skipping " + file + " (parse failed: " + e.message + ")"); process.exit(0); }
cfg.mcpServers = cfg.mcpServers || {};
if (cfg.mcpServers.meta) {
  console.log("mcpServers.meta already present in " + file + " — left unchanged.");
} else {
  cfg.mcpServers.meta = {
    type: "http",
    url: "http://localhost:12008/metamcp/<endpoint>/mcp",
    headers: { Authorization: "Bearer <token>" },
  };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  console.log("ACTION REQUIRED: added placeholder mcpServers.meta to " + file +
    " — replace <endpoint> and <token> with your endpoint name and API key.");
}
NODE
else
  echo "NOTE: $CLAUDE_JSON not found — add the meta mcpServers http entry manually:"
  echo '  "meta": { "type": "http", "url": "http://localhost:12008/metamcp/<endpoint>/mcp", "headers": { "Authorization": "Bearer <token>" } }'
fi

echo "Done. Start/stop is now tied to Claude Code sessions; refcount dir: $STATE_DIR"
