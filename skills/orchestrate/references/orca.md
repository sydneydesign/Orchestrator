# Builders in an Orca terminal

Opt-in. Orca is only the place a builder runs, so the human can watch it work. The plugin alone decides roles, briefs and safety: Orca never orchestrates. Orca's `orchestration` skill stays out of Claude's skills (`harness.md`, **Avoid**).

## The rule

A builder runs in its own Orca terminal when all three hold:

1. `.orchestrator.json` → `orca.builders` is `"terminal"`;
2. your session runs inside Orca (`ORCA_TERMINAL_HANDLE` is set);
3. the block runs in the isolated profile.

Otherwise it is a subagent. Every other role is always a subagent. No case-by-case choice: if the three hold, launch it this way; if the launch fails, delegate the builder as a subagent and tell the human why.

## Launch

From the project root, with the brief written as for a subagent:

```
node <skill dir>/scripts/launch.mjs --story <ID> --branch story/<ID>-<slug> --brief .orchestrator/work/<ID>/brief.md --mode <your own permission mode>
```

The script checks that Orca still has every command it uses, refuses uncommitted stories or `.orchestrator.json`, creates the Orca worktree on the story's branch from your current branch (`--base` to change it) and runs the project's `worktree` setup in it, opens `claude --agent orchestrator:builder` there, waits for Claude, and hands it the brief with `orca orchestration worker-start --terminal`. It prints the terminal handle, dispatch and run IDs.

- **It stops on a prompt** (folder trust, an MCP approval, the bypass warning). That prompt is the human's: tell them, never answer it. When they have, rerun the same command with `--terminal <handle>`.
- **Then end your turn.** Orca wakes you with a message naming a `check` command when the builder reports (`worker_done`) or asks (`ask`). Run it, read the report file as for a subagent, answer a question with `orca orchestration reply --id <message_id> --body "..."`. Do not poll.
- **Steer it** with `orca orchestration send --to dispatch:<id> --subject "..." --body "..."`, never by typing in its terminal.
- **After its report**, close its terminal: `orca terminal close --terminal <handle>`. Orca keeps it otherwise (it counts as a terminal it did not start).
- **At the close**, once the branch is merged, run `node <skill dir>/scripts/worktree.mjs teardown <worktree path>`, then remove the worktree through Orca before `tidy.mjs`: `orca worktree rm --worktree branch:<branch>`.

## What this relies on

Checked on macOS, Orca 1.4.274, Claude Code with the plugin installed, 2026-11-25. **Not yet tested on Windows.**

| Fact | Source |
|---|---|
| `claude --agent <plugin>:<role>` runs the main session as that agent, and hooks receive its name in `agent_type` | Claude Code docs (CLI `--agent`, hooks input); tested |
| A session started that way has no `agent_id`; the guard counts its session as the run | Tested; guard 0.10.0 |
| The guard holds it: a push is blocked as for a role agent | Tested 2026-11-25 (`launch.mjs` probe) |
| `orca terminal create --command`, `terminal wait --for tui-idle`, `orchestration worker-start --terminal --spec-file` | Orca CLI help, 1.4.274 |
| `worker-start --agent claude` cannot pass `--agent orchestrator:<role>`, and can open a chat with no terminal | Orca CLI help; why the plugin never uses it |
| `orca worktree create --branch` gives a taken name a numeric suffix; without `--repo` it takes the caller's repository | Orca CLI help, 1.4.274 |
| A builder's `worker_done` wakes the coordinator with a `check` message | Tested 2026-11-25 |
| `worker-release` keeps a terminal the coordinator opened (`external_terminal`) | Tested 2026-11-25 |
| Bypass mode stalls on a warning unless the Claude profile Orca launches with has `skipDangerousModePermissionPrompt: true`; folder trust asked on Windows, not on macOS | Tested 2026-11-12 (0.6.0) |

When an Orca update changes one of these commands, `launch.mjs` stops before it opens anything. Read the new `--help`, update the script and this table.
