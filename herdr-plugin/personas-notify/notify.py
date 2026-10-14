#!/usr/bin/env python3
"""Event hook for the local.personas-notify herdr plugin.

Fires on every `pane.agent_status_changed`. Only registered persona
children (registry files in /tmp/herdr/children/<name>.json, written by the
coordinator at dispatch time) produce notifications; the coordinator's own
state changes and untracked agents are ignored.

Behavior:
  - `working`  -> mark seen_working in the registry entry (guards against a
                  pre-turn `idle` being misread as "done"). No message.
  - `idle`/`done` -> push a collect hint into the coordinator agent's pane,
                  show a toast, then consume the registry entry.
  - `blocked`  -> push an attention hint + toast. Entry is kept, so a later
                  settle after the user resolves the dialog still notifies.

Graceful degradation: any failure (missing herdr binary, coordinator not
promptable, etc.) is swallowed; the coordinator can always fall back to
non-blocking `herdr agent get <name>` polls.
"""

import json
import os
import pathlib
import subprocess
import sys

REG = pathlib.Path("/tmp/herdr/children")
DEVNULL = subprocess.DEVNULL


def read_json_env(name):
    raw = os.environ.get(name)
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}


def main():
    data = (read_json_env("HERDR_PLUGIN_EVENT_JSON") or {}).get("data") or {}
    status = str(data.get("agent_status") or "").lower()
    if status not in ("working", "idle", "done", "blocked"):
        return

    pane_id = data.get("pane_id")
    name = data.get("display_agent") or data.get("agent")

    entry_path = None
    entry = None
    if REG.is_dir():
        for p in sorted(REG.glob("*.json")):
            try:
                e = json.loads(p.read_text())
            except Exception:
                continue
            if (pane_id and e.get("pane") == pane_id) or (
                name and e.get("name") == name
            ):
                entry_path, entry = p, e
                break
    if entry is None:
        return

    if status == "working":
        entry["seen_working"] = 1
        entry_path.write_text(json.dumps(entry))
        return

    # A child can only be done/blocked after its turn was observed working.
    if not entry.get("seen_working"):
        return

    herdr = os.environ.get("HERDR_BIN_PATH") or "herdr"
    label = entry.get("name") or name or "child"
    tab = entry.get("tab", "")
    out = entry.get("out", "")

    if status == "blocked":
        toast_title = f"child {label} BLOCKED"
        sound = "request"
        msg = (
            f"[herdr] child {label} is BLOCKED and needs attention. "
            f"Inspect before answering on its behalf: "
            f"`herdr agent read {label} --source recent-unwrapped --lines 50`, "
            f"then ask the user."
        )
    else:
        toast_title = f"child {label} {status}"
        sound = "done"
        close = f"; herdr tab close {tab}" if tab else ""
        msg = (
            f"[herdr] child {label} settled ({status})."
            + (f" Artifact: {out}." if out else "")
            + f" Collect when its result is needed: `herdr agent wait {label}`{close}."
        )

    try:
        subprocess.run(
            [herdr, "notification", "show", toast_title,
             "--body", (out or label), "--sound", sound],
            stdout=DEVNULL, stderr=DEVNULL, timeout=10,
        )
    except Exception:
        pass

    coord = entry.get("coord_pane") or entry.get("coordinator")
    if coord:
        try:
            subprocess.run(
                [herdr, "agent", "prompt", str(coord), msg],
                stdout=DEVNULL, stderr=DEVNULL, timeout=15,
            )
        except Exception:
            pass  # e.g. coordinator itself blocked; the toast already fired

    if status in ("idle", "done"):
        try:
            entry_path.unlink()
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # A broken hook must never break a child's lifecycle.
        sys.exit(0)
