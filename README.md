# Orchestrator

A Claude Code plugin for structured product work. One main session plans and decides. Role agents build and review. User stories with verifiable acceptance criteria define "done". A guard hook holds every agent to its contract.

![license](https://img.shields.io/badge/license-MIT-green) ![claude code](https://img.shields.io/badge/Claude%20Code-plugin-orange)

- [Why](#why)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Set up a project](#set-up-a-project)
- [Day-to-day use](#day-to-day-use)
- [Stories](#stories)
- [Configuration](#configuration)
- [The guard](#the-guard)
- [Roles](#roles)
- [Design principles](#design-principles)
- [Upgrading](#upgrading)
- [License](#license)

## Why

An agent that writes code, judges its own work and reports its own progress tends to report success. Orchestrator separates those jobs:

- **The author is never the judge.** A builder writes the code. A fresh reviewer, which never sees the builder's reasoning, judges the diff against the story.
- **"Done" is evidence.** Every acceptance criterion carries a marker: a passing test, a dated manual check, or an honest "unverified". A validator computes each story's status from the markers. Nobody writes a status by hand.
- **Tests cannot be weakened to get green.** Acceptance tests are written first and locked once they pass. The guard stops any agent from changing them.
- **The human is asked only what a human must decide.** Product calls, irreversible actions and final acceptance reach the human. Everything else proceeds and is logged.

## How it works

```
 human ──► orchestrator (main session) ──► builder ──► reviewer ──► orchestrator ──► human
              │  plans, briefs, decides       │ tests first   │ judges the       │ accepts
              │  merges, keeps the ledger     │ then code     │ diff vs story    │
              ▼                               ▼               ▼
        .orchestrator/state.md         locked tests     review report
```

1. **The main session is the orchestrator.** It owns the plan, the decisions and the merge. It decides by itself when to delegate, and it is the only voice the human hears.
2. **Role agents do the work.** They run as Claude Code subagents. Each one gets a written brief and returns a report file.
3. **Every story follows one flow.** Ready check, then a branch. The builder writes the acceptance tests first, watches them fail, and makes them pass. The orchestrator locks the tests. One independent review follows, then at most one fix round, then the human's acceptance.
4. **The guard enforces the rules that matter most.** It is a hook, so it applies whatever an agent's prompt says.

There is one orchestrator per repository: the session in the main checkout. A session you open in a linked worktree (by hand, or a tab Orca opens) starts as a worker on that worktree's branch. The main checkout stays on the main branch, because you merge from it: the orchestrator runs its blocks in a worktree it enters.

The plugin does nothing in a project without `.orchestrator.json`. In a project that has one, a session-start hook tells the main session to load the `orchestrate` skill.

## Requirements

- Claude Code with plugin support.
- Node.js 20 or later on `PATH`. The guard and the story validator use it.
- Git. The GitHub steps use the `gh` CLI.

## Installation

In Claude Code, from the project's folder:

```
/plugin marketplace add sydneydesign/Orchestrator
/plugin install orchestrator@orchestrator-local
```

Claude Code asks for a scope:

| Scope | Who gets the plugin | Where it is recorded |
|---|---|---|
| user | you, in every project on this machine | your user settings |
| project | everyone who works in the repository, in every checkout and worktree | `.claude/settings.json`, committed |
| local | you, in this folder only | `.claude/settings.local.json`, not committed |

Choose **project** or **user** scope when stories run in parallel. A parallel writer works in its own worktree, which is another folder, and local scope does not reach it.

From a shell, name the scope. Without `--scope` the plugin installs at user scope:

```
claude plugin marketplace add sydneydesign/Orchestrator
claude plugin install orchestrator@orchestrator-local --scope project
```

From a local clone:

```
claude plugin validate ./
claude plugin marketplace add ./
claude plugin install orchestrator@orchestrator-local --scope project
```

To try the plugin without installing it, run `claude --plugin-dir <path to this folder>`.

Claude Code loads plugins when the process starts. Restart the CLI after you install. `/clear` is not enough.

## Set up a project

Run `/orchestrator:install` in the project. The install measures the project instead of asking about it. It runs the verification commands, times them, and checks which tests can and cannot prove. It asks the human only what it cannot measure: personas, releases, risk tags, and whether agents may check the UI in a browser.

It writes:

| File | Contents |
|---|---|
| `.orchestrator.json` | The project's settings: verification commands, what tests cannot prove, seams, language, git rules |
| `<storiesDir>/` | The story folder in the project's language, the `stories.mjs` validator, templates and the generated map |
| `.claude/agents/` | Project roles, when the project needs them |
| `CLAUDE.md` | A short orchestrator block, and an empty **Lessons** section |
| `.orchestrator/` | The ledger (`state.md`) and the list of locked tests |

The install ends by proving each piece on this machine: every command runs, the validator passes, the guard blocks a force push, and a real subagent is held to its read-only role. Each check is reported as ✅ working, ⚠️ not verified (with the manual step), or ❌ failed.

To bring an existing story folder under the plugin, run the install in that project. It maps the old fields and markers, converts the files with a script, and checks that the number of stories and criteria does not change.

## Day-to-day use

Talk to the main session in plain language: "build the password reset story", "review what's left for the first release", "explore a denser table layout". The orchestrator:

- picks the next story from the map, checks it is ready, and asks you to approve criteria it wrote;
- briefs a builder, then a reviewer, and reads both reports;
- comes back to you only for a product call, an irreversible action (push, merge, deploy, delete), what the tests cannot prove, and acceptance;
- writes to you in product terms: the story's title first, its ID in parentheses, and code tokens kept out of the way.

For visual work you want to iterate on quickly, ask for **exploration**. The orchestrator edits directly on an `explore/<topic>` branch, in a worktree of its own, while you watch. Your checkout stays on `main`. When you keep the result, it turns it into stories, tests and one review in a single pass, and the options you did not keep leave the code. Screenshots stay in `.orchestrator/work/` and never enter git.

When you ask for a push, the orchestrator opens one pull request per story and looks after it until it is merged or closed. The title is the story ID and what a person notices. The body says what changed, shows before and after screenshots for visible changes, and gives honest evidence: who checked what and how, what nobody could check, each criterion's state, the commands that passed and the reviewers' verdicts. The screenshots go to a `pr-assets` branch that is never merged, so they stay out of the main branch. `watch-pr.mjs` watches the PR in the background and wakes the orchestrator for a failing check, a conflict, a new comment, or when the PR is ready to merge. Fixes go through a builder on the same branch. After three failed pushes for one issue, a redesign asked in review, or an open security point, the orchestrator stops and asks you. The guard asks you before every merge and every approval, and role agents only read GitHub.

At the end of a block of work the orchestrator runs the full verification, writes lessons from real failures into `CLAUDE.md`, and cleans up without being asked: it stops its agents, keeps `state.md` to the current state, and runs `tidy.mjs`. Then it gives you one batched list: bad news first, decisions it made, and branches waiting to be pushed or merged.

`tidy.mjs` shows a preview, then deletes the work folders of closed blocks, local branches already merged into the main branch (with their clean worktrees), and the caches you list in `tidy.caches`. It keeps a work folder that any file in the repository (a doc, a project skill, a new story not yet committed) or `state.md` still names, a branch that never had commits of its own, a branch its upstream lacks, a worktree with uncommitted changes or with reports in its own work folder, and any tracked file. Pass `--keep <folder or branch>` for work still in progress. If a close was skipped, the next session starts with one line saying what was left behind.

## Stories

A story records one capability a person notices. Its criteria record exactly what is true.

```markdown
- **ACC-004.1** When the user saves a text, the system shows the new text in the preview. [test: preview.test.ts › "shows the saved text"]
  - Given the user clears the text, when they save, then the system keeps the previous text and shows an error.
```

| Marker | Meaning |
|---|---|
| `[test: <file> › "<title>"]` | An automated test covers it. Counts only while the test passes. |
| `[manual YYYY-MM-DD, who]` | A person checked it by hand on that date. |
| `[unverified]` | The behaviour exists. Nobody has checked it. |
| `[unbuilt]` | The behaviour does not exist yet. |
| `[failing: reason]` | The behaviour exists and does not hold. |

The validator computes each story's status from its markers and its decisions (✅ works, ⚠️ unverified, 🟡 partial, ⬜ pending, ❌ failing, 🔒 blocked, ⛔ discarded) and generates `map.md`:

```
node <storiesDir>/stories.mjs              generate the map from the last test results
node <storiesDir>/stories.mjs --tests      run the tests, then generate the map
node <storiesDir>/stories.mjs --check      fail on errors or a stale map (use in CI)
node <storiesDir>/stories.mjs --ready ID   check that a story is ready to build
node <storiesDir>/stories.mjs --pr ID      print the pull-request checklist for a story
  --link <base>                            link the story file as <base>/<path>, for a PR body
```

A bug is never a new story: it is a failing marker on the criterion it breaks. A decision that blocks stories (a provider, pricing, hosting) lives in `decisions/` and is closed only by the human.

## Configuration

`.orchestrator.json`, written by the install:

| Key | Purpose |
|---|---|
| `language` | The language of the project's stories and documents |
| `storiesDir` | The story folder |
| `verify.all` | The full verification commands, run once per block of work |
| `verify.onBuilderStop` | The fast commands the guard runs when a builder stops |
| `verify.maxSameFailure` | How many times a builder may run the same failing command (default 3) |
| `verify.mutation` | Optional mutation-testing command for the changed files |
| `runnerLimit` | One sentence on what the tests cannot prove. The human reviews it. |
| `ui` | Permission for browser checks: the dev URL and the test data agents may touch. Remove it to forbid them. |
| `seams` | Pairs of places that must change together, each with its watcher |
| `riskTags` | Areas that add a reviewer even to small changes (for example security, legal, costs) |
| `copy` | The copy master document and voice rules. Enables the `copywriter` role. |
| `design` | The design source. Enables the `designer` role. |
| `roles` | Project roles and whether each one may write |
| `orca.builders` | Optional. `"terminal"` runs each builder of an isolated block in its own Orca terminal, so you can watch it, when the orchestrator runs inside Orca. Everything else stays a subagent. See `skills/orchestrate/references/orca.md`. |
| `worktree` | Optional. What a new worktree needs before an agent starts in it: `setup` commands (an install, a code generator), ignored files to `copy` (`.env`), and `teardown` commands for its removal. The install registers `.orchestrator/worktree.mjs` as Claude Code's worktree hooks only when this key exists. |
| `tidy.caches` | Optional. Ignored folders that rebuild themselves and grow (a screenshot cache, for example). The close clears them. |
| `git` | Protected branches, whether pushes need confirmation, broad `git add`, the code owner |
| `git.mergeMethod` | Optional. How the orchestrator merges a PR when you ask: `"merge"` (default) or `"squash"`. |
| `git.trustedBots` | Optional. Bot accounts whose PR comments count as requests, like a person's with write access, for example `["claude[bot]"]` (default none). List a bot only when the people who can trigger it have write access. Every other bot's comment is a claim to check. |
| `git.ignoredChecks` | Optional. Names of PR checks the watch leaves out, for example a deploy preview that always fails for this account. |

A project's `CLAUDE.md` can adjust the process. For example, a prototype with demo data can ask for one review per story and tests only for criteria with logic.

## The guard

`hooks/guard.mjs` runs on session start, before shell commands and file edits, and when an agent stops. It blocks:

- commits, rebases and cherry-picks on protected branches, and merges there by role agents;
- a role agent switching the main checkout off the main branch, or moving a protected branch without a checkout (`git fetch . x:main`); the orchestrator is asked instead;
- a session in a linked worktree loading the orchestrator's procedure;
- force pushes, `--no-verify`, `HUSKY=0`, and changes to `core.hooksPath`;
- broad `git add` and `commit -a`, and a branch switch and a commit in one command;
- `reset --hard`, `clean -f`, and `checkout .` / `restore .`;
- any write, move or delete on locked tests, the locked-tests list or the generated map;
- pushes, merges and the orchestrator's procedure from role agents;
- writes outside `.orchestrator/work/` from read-only roles, and story edits from builders;
- a commit on a detached HEAD from a role agent;
- a command that has already failed the same way `verify.maxSameFailure` times.

It asks the human before each merge into a protected branch, each pull request merge or approval, each push when `git.allowPush` is `false`, and an inline script that both mentions git and starts a program. You click; you never type the command. The orchestrator merges accepted work once per block, at the close. When a builder stops, the guard runs `verify.onBuilderStop` and refuses the stop while locked files differ from their commit.

The full list lives in `skills/orchestrate/references/harness.md` under **Enforced by code**. A rule on that list is never repeated in the instructions.

The guard catches honest mistakes. It is not a sandbox against an agent that tries to get around it. A gap gets a fix only after an agent hits it in real work (`harness.md` → **What the guard is for**).

## Roles

| Role | Writes | Job |
|---|---|---|
| `builder` | code and tests | Implements one story, test-first, until the verification commands pass |
| `reviewer` | its report | Judges the tests, the story compliance and the code quality of one diff |
| `researcher` | its report | Answers one question with sources and ends with one recommendation |
| `copywriter` | the copy master | Writes and reviews user-facing text. Only when `copy` is set. |
| `designer` | its report | Compares the built UI against the design source. Only when `design` is set. |

These are a starting set. The orchestrator creates a project role when a job needs independent judgement, different permissions, or a deliverable with its own quality bar, for example a security reviewer or a translator. Project roles live in the project's `.claude/agents/` and follow `skills/orchestrate/references/role-template.md`.

## Design principles

- **Code over prose.** A rule that the guard or a script enforces is not repeated in the instructions. The instructions keep only what a model would not do by default.
- **One rule, one home.** Each rule lives in the file of whoever acts on it. Lessons enter only from real failures, and leave once code prevents them.
- **Evidence over claims.** "Done" means command output or a passing test. A review without evidence is rejected.
- **The human decides what only a human can.** Everything else proceeds and is logged.
- **Neutral by default.** The plugin assumes no stack, language or domain. Each project's measured settings and lessons live in that project.

## Repository layout

| Path | Contents |
|---|---|
| `skills/orchestrate/` | The orchestrator's operating procedure, with references for the harness, git and roles, `scripts/tidy.mjs` for the close, `scripts/launch.mjs` to run a builder in an Orca terminal, `scripts/worktree.mjs` to set up and remove worktrees, and `scripts/pr-assets.mjs` and `scripts/watch-pr.mjs` for pull requests |
| `skills/stories/` | How to write, split and maintain stories, with templates |
| `skills/install/` | The project setup, and the assets it copies |
| `agents/` | The shipped role contracts |
| `hooks/` | The guard, and `check-guard.mjs`, its cases: run `node hooks/check-guard.mjs` after changing it |
| `CHANGELOG.md` | Changes in each version |

## Upgrading

See [`CHANGELOG.md`](CHANGELOG.md) for the changes in each version. After an update, restart the CLI.

**From 0.13.1 to 0.13.2.** Nothing to change. No code changed: the guard's scope is now written down (`harness.md` → **What the guard is for**).

**From 0.13.0 to 0.13.1.** Nothing to change. A project with its own copy of `worktree.mjs` copies it again, so the guard can tell a worktree that ran its setup.

**From 0.12.0 to 0.13.0.** Nothing to change for the hierarchy: the guard and the procedure carry it. A project whose own rules have the orchestrator switch the main checkout (a live block, an exploration) drops that rule. To give isolated agents a ready worktree, add `"worktree": { "setup": [...], "copy": [...], "teardown": [...] }` to `.orchestrator.json` and rerun `/orchestrator:install`, or do its step 5.3 by hand: copy `scripts/worktree.mjs` to `.orchestrator/worktree.mjs` and register the two hooks. With the hooks, Claude Code keeps every subagent's worktree when it finishes; the close's `tidy.mjs` removes the ones nobody committed to. A project with its own copy of `tidy.mjs` or `launch.mjs` copies `worktree.mjs` next to it, since both import it.

**From 0.11.2 to 0.12.0.** Copy `stories.mjs` into the project again for `--pr --link`. Optional keys: `git.mergeMethod`, `git.trustedBots`, `git.ignoredChecks`. The guard now asks before the orchestrator's merges into the main branch instead of blocking them: a project rule that the human types the merge can go. A project with its own copy of the guard ports 0.12.0's diff of `hooks/guard.mjs` whole and runs `hooks/check-guard.mjs` against it.

**From 0.11.1 to 0.11.2.** Nothing to change. A project with its own copy of the guard ports 0.11.2's diff of `hooks/guard.mjs` whole: `commands()`, `programIndex()` and the constants above them depend on each other, and a guard that throws lets every command through.

**From 0.10.x to 0.11.0.** Nothing to change. To watch builders work in Orca, add `"orca": { "builders": "terminal" }` to `.orchestrator.json` and run the orchestrator inside Orca. Keep Orca's `orchestration` skill out of `~/.claude/skills`; `orca-cli` is fine.

**From 0.10.0 to 0.10.1.** Nothing to change. A project with its own copy of `tidy.mjs` copies it again: 0.10.0 could delete a fresh branch and miss some citations.

**From 0.9.x to 0.10.0.** Nothing to change. Optionally add `"tidy": { "caches": [...] }` to `.orchestrator.json` for caches the close should clear. A project that keeps its own copy of the plugin's procedure and guard ports `scripts/tidy.mjs` and the guard's session-start note by hand.

**From 0.8.x to 0.9.0.** Orca support is removed: roles run only as Claude Code subagents. Delete the `orca` key from `.orchestrator.json`, and `.orchestrator/roles/` if it exists.

## License

MIT. See [`LICENSE`](LICENSE). Written by Sydney and Claude (Claude Code).
