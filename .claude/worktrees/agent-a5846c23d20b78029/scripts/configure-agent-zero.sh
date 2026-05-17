#!/usr/bin/env bash
# Run INSIDE the Agent Zero container:
#   docker exec -it agent-zero bash
#   bash /tmp/configure-agent-zero.sh
# (copy this file in with `docker cp` first, or paste its contents)
#
# Points chat + utility model slots at ClaudeMCP on your LAN.
# Leaves embedding slot alone — set that one in the UI (LM Studio / Ollama).

set -euo pipefail

# --- EDIT THESE TWO ---
CLAUDEMCP_URL="http://10.0.0.74:8899/v1"
CLAUDEMCP_KEY="5ed044bd845999345afc954c320af9e4878a7ef4948a0461"
# ----------------------

SETTINGS="/a0/tmp/settings.json"
[ -f "$SETTINGS" ] || SETTINGS="$(find /a0 -name settings.json -not -path '*/node_modules/*' 2>/dev/null | head -1)"
[ -n "${SETTINGS:-}" ] && [ -f "$SETTINGS" ] || { echo "settings.json not found"; exit 1; }

echo "Patching $SETTINGS"
cp "$SETTINGS" "${SETTINGS}.bak.$(date +%s)"

python3 - "$SETTINGS" "$CLAUDEMCP_URL" "$CLAUDEMCP_KEY" <<'PY'
import json, sys
path, url, key = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f: s = json.load(f)

for slot in ("chat", "util"):
    s[f"{slot}_model_provider"]  = "OTHER"
    s[f"{slot}_model_name"]      = "claude-sonnet-4-6"
    s[f"{slot}_model_api_base"]  = url
    s[f"{slot}_model_kwargs"]    = {
        "api_key":  key,
        "base_url": url,
        "default_headers": {"Authorization": f"Bearer {key}"},
    }

with open(path, "w") as f: json.dump(s, f, indent=2)
print("done")
PY

echo "Restart Agent Zero to pick up the new settings."
