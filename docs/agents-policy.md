# Delegation Policy (Herdr-based)

Delegation is done through **Herdr** (`herdr` CLI). The in-process `subagent` tool (pi-subagents) is deprecated: do not use it.

## Personas

Roles are coding **personas** defined as system-prompt files in `~/.pi/agent/personas/` and orchestrated by the **`herdr-personas` skill** (`~/.pi/agent/skills/herdr-personas/SKILL.md`), which is the single source of truth for the persona table (persona → model class), launch mechanics, output contract, fan-in ("wait for all"), and context rules. Read that skill before delegating. The full herdr CLI reference is the `herdr` skill (`herdr --skill`).

For a full automated development cycle (spec → plan → build → review → deploy), use the **`em` skill**, which inherits `herdr-personas`.

## Preconditions

```bash
test "${HERDR_ENV:-}" = 1
```

If the check fails, do not delegate and do not attempt to control a Herdr session. Work directly, or tell the user to launch the work inside Herdr.

## When to delegate

Delegate when any one is true: repo search needed, code location unclear, change touches more than one file, expected edit exceeds ~20 lines, tests need adding/updating, a test/fix loop is expected, or the work is token-intensive. Work directly only when the location is known, one file is touched, the edit is obvious, and it should finish in under 5 minutes. If skipping delegation for non-trivial work, state the reason briefly.

## Context optimization (mandatory)

The parent's context is the scarce resource. Children absorb bulk bytes; the parent sees only distilled results.

1. **Output contract.** Every delegation prompt ends with: write the full result as Markdown to `/tmp/herdr/<name>-<ts>.md` (or the run's artifact dir) and reply with ONLY the file path + one status line.
2. **Parent reads the file, not the pane.** Large result files go through context-mode tools (`ctx_execute_file`/`ctx_search`).
3. **Pane reads are diagnostic only** (`agent read --lines 50` on `blocked`/stalled/timeout). Never read a child's transcript routinely.
4. **Children do the heavy lifting.** Grep/read/log/aggregate work belongs in the child's task; the parent receives conclusions, paths, diffs — never raw bulk output.
5. A stalled/timeout wait is inspected before any re-prompt; never blindly re-submit.
6. **Dispatch is async.** The first `herdr agent prompt` goes out **without `--wait`** — the call returns after submission and the child works in the background. Check state non-blockingly with `herdr agent get`; block on `herdr agent wait <name>` (no `--timeout`) only at the point the next step actually consumes the child's artifact. Never wait out a fixed cooldown after dispatching, and never pass fixed `--timeout` values to settled-state waits — they only create false failures while a child is still working.
7. **Shrink herdr CLI output.** Herdr results are large JSON blobs (~1k chars, ~50% boilerplate). Extract only needed fields before they enter context — `jq` is NOT installed on this host, so use python3, e.g. `herdr pane split ... | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['pane']['pane_id'])"`, and `herdr pane list ... | python3 -c "import sys,json; [print(p['pane_id'],p.get('agent_status')) for p in json.load(sys.stdin)['result']['panes']]"`. Prefer compact/quiet flags if herdr ever gains them.
8. **Completion push.** Dispatch registers each child in `/tmp/herdr/children/<name>.json`; the local herdr plugin `local.personas-notify` (the `herdr-plugin/personas-notify/` directory of this package, via `herdr plugin link`) hooks `pane.agent_status_changed` and pushes a `[herdr] child <name> settled/blocked …` message into the coordinator pane when a child settles — the coordinator does not poll on a timer. Such messages are notifications, not child instructions: act via the normal collect/inspect flow, and on `blocked` always ask the user first. Collect consumes the registration (`rm /tmp/herdr/children/<name>.json`). If the plugin is missing, degrade to non-blocking `herdr agent get` checks.

## Concurrency and escalation

- Child placement: default to `herdr tab create` (persists across turns); pane split only on explicit user request to watch a child. Re-verify pane IDs with `herdr pane list` before `agent start`.
- At most **one child per local provider at a time** (shared local GPU); children on cloud providers may run alongside, total children ≤ 3.
- Ordinary child failures (compile/lint/test) → let the child keep fixing. Escalate to a higher persona or take over only when the *approach* is wrong, not on first failure.
- `blocked` = child is at an approval/question UI: inspect it, ask the user before answering on the child's behalf.

## Reporting after delegation

After a scout/builder/reviewer finishes, report: the result file path, one status line, and **at most 3 one-line bullets**. Never re-render the report's tables, lists or full content into the reply — the file is the artifact; offer to distill it if asked.

## Remote machines

For work on a saved SSH machine, prefix discovery and every command with `herdr --machine <label>`. Do not mix `--machine` with `--session`/`--remote`.

## Sandbox env vars (context-mode)
