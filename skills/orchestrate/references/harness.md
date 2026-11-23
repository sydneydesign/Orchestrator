# Harness

The harness decides **how** you delegate, not whether. Every judgement in the `orchestrate` skill stays the same; only the mechanism changes. The plugin runs on plain Claude Code. The Agent tool is its delegation mechanism.

## The mechanism

| | Claude Code subagent (Agent tool) |
|---|---|
| Where it runs | inside your turn, in your checkout or in its own worktree (`isolation: worktree`) |
| The human | sees the agent's name and summary, not its steps |
| Survives your compaction | no; it dies with your turn. The brief and the report files are the durable record |
| Blocking question | `NEEDS_CONTEXT` in its report → `SendMessage` to the agent id |
| Role rules in the guard | from `agent_type` |

Separate sessions run only if the human starts them. They carry no role, so the guard treats them as an orchestrator. Coordinate with them through `.orchestrator/work/` and cross-session messages. A message lasts as long as its session; the branch and the files are the durable record.

## Two profiles

Pick a profile for each block of work. The work decides. Write the profile and its reason on the ledger's second line, and keep it for the whole block.

| Profile | When | Writers | Readers |
|---|---|---|---|
| **Live** | The human watches the result on localhost as it lands, or the block's stories share files | One subagent at a time, in the main checkout, on the block's branch | Subagents, in parallel |
| **Isolated** | Stories with disjoint files and parallel writers | A subagent each, with `isolation: worktree`, on its story's branch | Subagents, in your checkout |

When in doubt, choose live. A new worktree starts without dependencies, ignored files (`.env`, build output) or a dev server, and the human cannot see the work on localhost before the merge. In gg-ez (2026-11-18) a block of coupled UI stories ran faster live than isolated.

## Placement

- **Writers** (`builder`, a writing `copywriter`, a project role with `readOnly: false`) follow the block's profile. The branch rules of `references/git.md` apply in both.
- **Read-only roles** (`reviewer`, `researcher`, `designer`, a reviewing `copywriter`) run in your checkout. They judge what is there and write only their report.
- **A folder workspace** has no worktrees and no branches: `git.md` does not apply, and the verification commands are the only evidence. Say so in the close report.
- Pass a model only when the human named one.
- Role agents never launch other agents.
- Never place a writer in a workspace whose root has no `.orchestrator.json`: it is unguarded.

## Browser

The UI check needs a browser tool. Check that one is available before you promise a UI check. Without one, skip the UI check and say so in the close report.

- **You** use the browser tool of your session (for example Claude in Chrome, or a Playwright MCP server).
- **A builder subagent** has no MCP tools. It runs the UI check only through a command-line browser the project has, such as Playwright through Bash. Otherwise you run the UI check yourself after the builder reports DONE.

Only one agent drives the browser at a time. Screenshots are the evidence, not the page snapshot.

## The guard

The guard reads a subagent's role from `agent_type`. `.orchestrator.json` → `roles.<name>.readOnly` decides whether a role writes; the plugin's roles have defaults.

### Enforced by code

None of these needs a rule in any text. When a lesson's failure is on this list, delete the lesson.

- **`hooks/guard.mjs`** blocks:
  - commits, merges, rebases, pulls and cherry-picks on protected branches;
  - pushes from role agents;
  - force pushes, `--no-verify`, `HUSKY=0`, and overriding or changing `core.hooksPath`;
  - broad `git add` and `commit -a`;
  - a branch change and a commit in one command;
  - `reset --hard`, `clean -f`, and `checkout .` / `restore .`;
  - writes, moves or deletes on locked tests, the locked-tests list, the generated map and the guard's own record;
  - a builder editing stories;
  - read-only roles writing outside `.orchestrator/work/` or running git commands that write;
  - role agents loading the `orchestrate` skill or merging pull requests;
  - a role committing, merging, rebasing or cherry-picking on a detached HEAD (a stopped rebase may finish);
  - the same failing command after `verify.maxSameFailure` runs;
  - in the PowerShell tool, an inline script (`node -e`, `python -c`) and `Set-Content`, `Add-Content` or `Out-File` with `-Encoding utf8`.

  It asks the human before:
  - every push and pull-request merge when `git.allowPush` is `false`;
  - an inline script (`node -e`, `python -c`, a heredoc) that mentions git and starts a program.

  It runs `verify.onBuilderStop` when a builder stops, and refuses the stop while locked files differ from their commit. It refuses the stop of a writing role on a detached HEAD.
- **`stories.mjs --check`** fails on a stale map and on a context document that names a missing path or script.

## Avoid

- Experimental agent teams as the backbone: their plan approvals bypass the human, and teammates do not survive a resume.
- Two writers on the same files. A finding or a correction on files a writer still holds goes to that writer as an extra item (skill §6.7).
- Starting services (Docker, a database, a dev server) from a builder's shell. Start shared services yourself.
- Editing files inside a builder's worktree while it works: its `Stop` check restores them. Edit stories in your own checkout, after the builder reports. In the live profile the builder shares your checkout: leave its files alone and commit only with `git commit -- <paths>` (`references/git.md`).
- Opening a browser unless the brief or the human allows it. The `ui` key in `.orchestrator.json` is the human's permission for the UI check, and only for it.
