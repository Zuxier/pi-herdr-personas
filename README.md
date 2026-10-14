# pi-herdr-personas

> **⚠️ Configure before use.** No model defaults are bundled. Before dispatching any subagent, run **`/personas`** inside pi and assign a model to each persona (and mark your local providers). Until then the `herdr_personas` tool reports every persona as *not set*, and the coordinator must not dispatch — it will stop and ask you to run `/personas`.

Persona-based subagent delegation for [pi](https://pi.dev) on [herdr](https://github.com/herdrdev/herdr): a coordinator agent dispatches specialist personas into herdr panes, keeps working, and gets a push when each child settles.

## What's inside

| Piece | Path | What it does |
|---|---|---|
| `herdr-personas` skill | `skills/herdr-personas/SKILL.md` | The delegation playbook: personas, async dispatch, output contract, collect/fan-in rules, context hygiene |
| Persona system prompts | `personas/*.md` | 7 roles: scout, specifier, planner, builder, reviewer, deployer, oracle |
| Model-config extension | `extensions/pi-herdr-personas.ts` | `/personas` — keyboard wizard to assign a model (+thinking level) per persona, per host; `herdr_personas` tool so the coordinator resolves the exact `--model` string at dispatch |
| Settle-notify plugin | `herdr-plugin/personas-notify/` | herdr plugin: when a registered child settles/blocks, pushes a `[herdr] child …` message into the coordinator's pane + TUI toast (no polling) |
| Policy doc | `docs/agents-policy.md` | The delegation policy to fold into your `AGENTS.md` |

## Requirements

- `pi` (pi-coding-agent)
- herdr, with the server running in your environment (`HERDR_ENV=1` — herdr sets this in its panes/sessions)
- Python 3 (plugin runtime)

## Install

```sh
git clone https://github.com/Zuxier/pi-herdr-personas && cd pi-herdr-personas
./install.sh
```

`install.sh` does everything: installs the pi package (skill + extension + `/personas`), copies the persona prompts to `~/.pi/agent/personas/`, and links the settle-notify herdr plugin.

Alternatively, install the pi package straight from git:

```sh
pi install git:https://github.com/Zuxier/pi-herdr-personas
# the plugin still needs local files, so link it from a (shallow) clone:
git clone --depth 1 https://github.com/Zuxier/pi-herdr-personas /tmp/pi-herdr-personas
herdr plugin link /tmp/pi-herdr-personas/herdr-plugin/personas-notify
cp /tmp/pi-herdr-personas/personas/*.md ~/.pi/agent/personas/
```

Then, inside pi:

```
/personas
```

…picks a persona (keyboard-navigable), picks a model from **your** pi model catalog (or types a custom `provider/model` reference), optionally picks a thinking level, and saves to `~/.pi/agent/pi-herdr-personas.json`. No defaults are bundled — the wizard is how you define your fleet (local inference, cloud tiers, whatever your host runs).

`/personas <persona>` configures one directly; `/personas show` prints the current assignments.

## How a delegation runs

1. Coordinator (you, in a herdr pane) delegates via the `herdr-personas` skill: creates a tab, `herdr agent start <name> --kind pi -- --model <ref> --append-system-prompt <persona>.md`, sends the task **without `--wait`**, registers the child in `/tmp/herdr/children/<name>.json`.
2. Coordinator keeps working. The `herdr_personas` tool supplies the per-host `--model` ref (persona → `provider/model:thinking`).
3. When the child settles, the herdr plugin pushes `[herdr] child <name> settled (done). Artifact: …` into the coordinator's pane — no timers, no polling.
4. Coordinator collects at the point the result is consumed: `herdr agent wait <name>` (no `--timeout`), reads the artifact file, closes the tab.

Concurrency: at most one child per local provider at a time (local models share the GPU); cloud personas run alongside; ≤3 children total.

## Model assignment

Per-host config, intentionally **not** checked in: `~/.pi/agent/pi-herdr-personas.json`

```json
{
  "personas": { "scout": { "model": "<provider>/<model>", "thinking": "high" } },
  "localProviders": ["<provider-id-of-your-local-inference>"]
}
```

Missing keys fall back to the bundled defaults. `localProviders` drives the concurrency rule (local = shared GPU) and the `local` flags the `herdr_personas` tool reports.

## Uninstall

```sh
pi remove <source>
herdr plugin unlink local.personas-notify   # if you want it gone
rm ~/.pi/agent/pi-herdr-personas.json        # optional: your config
```
