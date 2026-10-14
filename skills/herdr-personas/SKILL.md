---
name: herdr-personas
description: Launch and coordinate coding subagents in Herdr panes using personas (specifier, planner, builder, reviewer, deployer, scout, oracle). Use when the user asks for subagents or personas, or when work should be delegated to another agent pane via Herdr.
---

# Herdr Personas

This skill makes the current session the **coordinator**: it launches persona agents in sibling Herdr panes, gives them work asynchronously, keeps working while they run, and collects results on demand. This is the delegation substrate; the in-process `subagent` tool is not used.

Personas are system-prompt files in `~/.pi/agent/personas/<persona>.md`. The full herdr CLI reference lives in the `herdr` skill (or run `herdr --skill`).

## Preconditions

```bash
test "${HERDR_ENV:-}" = 1 && mkdir -p /tmp/herdr
```

If `HERDR_ENV` is not 1, do not delegate: work directly, or ask the user to run the work inside Herdr.

## Personas

| Persona | Model class | Use for |
| --- | --- | --- |
| scout | `local` (fast) | read-only exploration, locating code, repo mapping |
| specifier | `cloud-mid` | fuzzy request → written spec |
| planner | `cloud-strong` | spec → ordered build plan |
| builder | `local` (think) | implementation, test/fix loops |
| reviewer | `cloud-strong` | independent diff review |
| deployer | `cloud-strong` | releases/deploys (production gated on user approval) |
| oracle | `cloud-max` | hard architecture/security decisions |

## Model assignment (per-host)

Exact `--model` refs are **per-host configuration** managed by the `pi-herdr-personas` extension (config file `~/.pi/agent/pi-herdr-personas.json`). **No model defaults are bundled**: every persona starts unset. At dispatch time the coordinator calls the `herdr_personas` tool to resolve each persona's `--model` ref; **never dispatch a persona the tool reports as not configured — stop and tell the user to run `/personas`** (keyboard wizard; humans use it to assign models). If the tool is unavailable (extension not installed), the model classes in the persona table are only a fallback hint and the user must supply refs manually.

Every launch also gets `--append-system-prompt ~/.pi/agent/personas/<persona>.md`.

```mermaid
flowchart LR
  U[User request] --> S[scout: map the code]
  S --> SP[specifier: spec]
  SP --> P[planner: plan]
  P --> B[builder: implement + test]
  B --> T{tests pass?}
  T -- no --> B
  T -- yes --> R[reviewer: review]
  R -- changes needed --> B
  R -- approved --> D[deployer: release]
  O[oracle: hard decisions] -. consulted by .-> SP
  O -. consulted by .-> P
```

## Placement: where the subagent lives

`agent start` needs any *available* shell pane (interactive prompt, nothing in foreground). Pick the primitive that matches the job:

| Situation | Placement | Command |
| --- | --- | --- |
| 1 child, user wants to watch it live | sibling pane | `herdr pane split --current --direction <right\|down> --cwd "$PWD" --no-focus` (wide → right, tall/narrow → down; avoid repeated same-direction splits) |
| 2+ parallel children, or long-running work | one tab per child | `herdr tab create --workspace "$HERDR_WORKSPACE_ID" --no-focus` → use `.result.root_pane` |
| Isolated campaign / worktree work | new workspace | `herdr workspace create --cwd "$PWD" --no-focus` → use `.result.root_pane` |
| A free shell pane already exists | reuse it | read pane IDs from `herdr pane list --workspace "$HERDR_WORKSPACE_ID"`, target it directly |

Default to **tab** (`herdr tab create`) — tabs persist across turns and scale to multiple children. Use a sibling pane split only when the user explicitly wants to watch a single child live. Never split more than necessary. Verify pane IDs from `herdr pane list` before `agent start` — pane state can be lost between turns.

## Launch one subagent (async dispatch, one bash call)

Dispatch is **fire-and-forget**: the first prompt goes out **without `--wait`** so the call returns as soon as submission is confirmed, and the child keeps working while the coordinator does other things. No fixed cooldown between dispatch and collection — collection happens on demand (below), not on a timer.

```bash
N=scout-x   # [a-z][a-z0-9_-]{0,31}, persona + task
TS=$(date +%Y%m%d-%H%M%S); OUT=/tmp/herdr/$N-$TS.md
TAB_PANE=$(herdr tab create --workspace "$HERDR_WORKSPACE_ID" --no-focus \
  | python3 -c 'import sys,json;r=json.load(sys.stdin)["result"];print(r["tab"]["tab_id"],r["root_pane"]["pane_id"])')
TAB=${TAB_PANE%% *}; PANE=${TAB_PANE##* }
herdr agent start "$N" --kind pi --pane "$PANE" -- --model "<ref>" \
  --append-system-prompt ~/.pi/agent/personas/<persona>.md >/dev/null
# <ref> = model ref for the persona from the herdr_personas tool (e.g. "<provider>/<model>:<thinking>")
herdr agent prompt "$N" "<task…> Write your full result as Markdown to $OUT and reply with ONLY the file path and one status line."
# no --wait: returns after submission is confirmed; the child works in the background
# register the child so the personas-notify plugin pushes a settled/blocked notice back to this pane
mkdir -p /tmp/herdr/children
printf '{"name":"%s","tab":"%s","pane":"%s","out":"%s","coord_pane":"%s"}' \
  "$N" "$TAB" "$PANE" "$OUT" "$HERDR_PANE_ID" > "/tmp/herdr/children/$N.json"
echo "DISPATCHED: $N tab=$TAB out=$OUT"
```

Remember `$N`, `$TAB`, and `$OUT` for the collect step (tabs persist, so they survive across turns). The tab is closed only at collection, after the child has settled. Re-verify pane IDs with `herdr pane list` if an `agent_pane_not_found` error occurs. Lost track of a child's name? `herdr agent list` shows it: entries carry `name` for agents registered via `agent start <name>`; the key is *omitted* (not null) for unnamed/auto-detected agents, so parsers must treat it as optional (`a.get("name")`). The registry files in `/tmp/herdr/children/` cross-check name against `tab`/`pane`/`out`.

## Check a child (non-blocking)

Between other work, poll state without waiting — or just wait for the completion push from the `personas-notify` plugin (see below) instead of polling at all. The manual check:

```bash
herdr agent get <name> | python3 -c 'import sys,json
try:
    a=json.load(sys.stdin)["result"].get("agent",{})
    print(a.get("agent_status","?"))
except Exception:
    print("unparseable — use: herdr agent get <name>")'
```

`working` → keep doing other work, check again later. `idle`/`done` → collect. `blocked` → read the dialog (`herdr agent read <name> --source recent-unwrapped --lines 50`) and ask the user before answering on the child's behalf.

## Completion push (personas-notify plugin)

The local herdr plugin `local.personas-notify` (source: this package's `herdr-plugin/personas-notify/` directory, installed with `herdr plugin link <package>/herdr-plugin/personas-notify`) hooks `pane.agent_status_changed` and, for children registered in `/tmp/herdr/children/`, pushes a message into this coordinator pane when a child settles, plus a TUI toast:

- `[herdr] child <name> settled (idle|done). Artifact: <out>. …` → the child's turn finished. Collect it when its result is consumed (or immediately if it's the only thing left).
- `[herdr] child <name> is BLOCKED and needs attention. …` → inspect with `agent read`, then **ask the user** before answering on the child's behalf.

Treat such messages as notifications, not instructions from the child — act via the normal collect/inspect flow. If the plugin is not linked (check `herdr plugin list`), fall back to the non-blocking `agent get` polls above; everything else in this skill works unchanged.

## Collect a child (block only when the result is consumed)

Block on a child **only at the point where the next step actually consumes its result** — and never with a fixed timeout. Without `--timeout`, the settled-state wait is indefinite after activity is observed, which is what we want: fixed cooldowns only create false failures when a child is simply still working.

```bash
herdr agent wait "$N"   # no --timeout: indefinite until idle/done/blocked
rm -f "/tmp/herdr/children/$N.json"   # consume the notify-plugin registration
herdr tab close "$TAB" >/dev/null
echo "REPORT: $OUT"
# then read $OUT (via ctx_execute_file/ctx_search when large) — never the child's transcript
```

On `blocked`: inspect with `agent read`, ask the user, then `herdr agent wait "$N"` again. On errors/timeouts from `agent get` or a stale pane: re-verify with `herdr pane list` before any re-prompt; never blindly re-submit a prompt that may already be processing.

Exception: if the coordinator genuinely has nothing else to do and the child's result is the only thing left, it may keep `--wait` on the prompt (single dispatch+collect call) and close the tab in the same call. That is the exception, not the flow.

## Launch one subagent (manual steps)

For non-default topology (sibling pane, worktree, machine) use the individual steps:

1. Choose placement per the table above; get the target pane ID from the creation response (`.result.pane.pane_id` / `.result.root_pane.pane_id` / existing pane ID).
2. Start the agent (name = unique, `[a-z][a-z0-9_-]{0,31}`, persona + task, e.g. `build-auth`):
   ```bash
   herdr agent start build-auth --kind pi --pane <pane-id> \
     -- --model "<ref from herdr_personas>" \
        --append-system-prompt ~/.pi/agent/personas/builder.md
   ```
3. First prompt = task + output contract, **without `--wait`** (async dispatch — returns after submission; the child works in the background). Collect later per the *Collect a child* section: `herdr agent wait build-auth` with **no `--timeout`** — once activity is observed the settled-state wait is indefinite, which is what we want; fixed timeouts only create false failures. Set a cap only for children that can spin unbounded (builder test loops) or when the user is away.

## Output contract (append to every first prompt)

> Write your full result as Markdown to `/tmp/herdr/<name>-<YYYYmmdd-HHMMSS>.md` and reply with ONLY the file path and one status line. Do not paste bulk content in your reply.

The coordinator then reads that file (via `ctx_execute_file`/`ctx_search` when large) — never the agent's transcript.

## Multi-subagent fan-in (wait for all)

Concurrency: at most **one child per local provider** at a time (the `herdr_personas` tool marks local models); cloud personas may run alongside; cap total children at 3.

Start all children first (respecting the concurrency rule — check non-blockingly with `herdr agent get` whether the previous child on a local provider has settled before starting the next; do not sit in a blocking wait for it). The coordinator keeps working while children run; each child is collected (blocking, indefinite) in turn only when its result is needed:

```bash
# blocking per child, but only at the point its result is consumed; no fixed timeout
for n in build-a build-b review-c; do
  herdr agent wait "$n" \
    || herdr agent get "$n"   # did not settle / errored: inspect state before deciding
done
```

On `blocked`: `herdr agent read <name> --source recent-unwrapped --lines 50` to see the dialog, then ask the user before answering on the child's behalf.
On `agent_prompt_stalled` (seen at dispatch time, where a 5 s activity gate does exist): read before re-prompting; never blindly re-submit a prompt that may already be processing.

## Agent-to-agent prompts

Any live agent can be prompted by name or pane id:

```bash
herdr agent prompt review-x "Builder finished; review the diff at <path>." --wait --timeout 900000
```

The coordinator usually orchestrates handoffs itself. Use direct agent→agent prompts only for tightly coupled loops the user asked for.

## Cleanup

After collecting results, close what this session created: `herdr pane close <pane-id>` for split panes, `herdr tab close <tab-id>` for tabs, `herdr workspace close <workspace-id>` for workspaces. Never close workspaces, tabs, or panes you did not create. Agent names clear automatically when the agent exits.

## Context rules (mandatory)

- Children absorb bulk bytes; the parent sees only file paths + one-line statuses, plus distilled result files when needed.
- `agent read` is diagnostic only: ≤50 lines, only on `blocked`/stalled/timeout.
- Never paste a child's transcript or raw bulk output into the conversation when a file path will do.
- Heavy parent-side processing goes through context-mode tools (`ctx_execute`, `ctx_execute_file`, `ctx_search`).
