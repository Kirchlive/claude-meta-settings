#!/bin/sh
# Remove the claude-meta-settings session-lifecycle hooks from
# ~/.claude/settings.json. Non-destructive: only the claude-meta entries are
# stripped; all other hooks/settings are preserved. ~/.claude.json is left
# untouched.
set -eu

SETTINGS="$HOME/.claude/settings.json"

if [ ! -f "$SETTINGS" ]; then
  echo "No $SETTINGS — nothing to do."
  exit 0
fi

node - "$SETTINGS" <<'NODE'
const fs = require("fs");
const [, , file] = process.argv;
let cfg;
try { cfg = JSON.parse(fs.readFileSync(file, "utf8") || "{}"); }
catch (e) { console.error("Could not parse " + file + ": " + e.message); process.exit(1); }

if (!cfg.hooks) { console.log("No hooks in " + file + " — nothing to remove."); process.exit(0); }

const isOurs = (c) => typeof c === "string" && c.includes("claude-meta-supervisor.mjs");

for (const event of ["SessionStart", "SessionEnd"]) {
  if (!Array.isArray(cfg.hooks[event])) continue;
  cfg.hooks[event] = cfg.hooks[event]
    .map((grp) => ({ ...grp, hooks: (grp.hooks || []).filter((h) => !isOurs(h.command)) }))
    .filter((grp) => (grp.hooks || []).length > 0);
  if (cfg.hooks[event].length === 0) delete cfg.hooks[event];
}
if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;

fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
console.log("Removed claude-meta hooks from " + file);
NODE

echo "NOTE: ~/.claude.json left untouched. Remove the mcpServers.meta entry manually if you no longer want it."
