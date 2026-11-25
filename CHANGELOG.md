# Changelog

## 0.10.0 — 2026-11-25

The close cleans up after itself. In Easy One the clean-up rules existed as text and were skipped whenever the close was: 85 MB of work files, 29 merged branches, 122 committed screenshots and nine links into deleted folders piled up.

- `scripts/tidy.mjs` deletes the work folders of closed blocks, the local branches merged into the main branch with their clean worktrees, and the caches listed in `.orchestrator.json` → `tidy.caches`. It previews by default, keeps a work folder a tracked file still cites and a worktree with changes, and never forces anything. The close runs it without asking.
- The orchestrator's session start names what earlier blocks left behind.
- The close stops each agent once its report is read, and rewrites `state.md` to about 50 lines of current state. Every brief says "leave nothing running".
- Screenshots stay in `.orchestrator/work/` and never enter git. The options the human did not keep leave the code when an exploration is formalized.
- A UI brief points at the approved design by commit or tag, never at copied values, and an agent stops instead of inventing a missing component, token or style.
- A session started as a role (`claude --agent orchestrator:builder`) gets no orchestrator prompt at its start, and the same-failure breaker counts its session as the run.

## 0.9.0 — 2026-11-23

Orca is retired. Orca's own orchestration guide (CLI 1.4.271) conflicted with the plugin: it launches workers with `worker-start --agent`, which the guard blocked; it can open a worker as a chat with no terminal, so the guard could not find the worker's role; and it creates worker worktrees itself.

- Roles run only as Claude Code subagents. Parallel writers get `isolation: worktree`.
- The live and isolated profiles stay, without workers.
- `scripts/dispatch.mjs` is gone, and so are the role files, `orca.workerPermissionMode`, and every "If Orca dispatched you" section.
- The guard no longer detects a harness, reads role files or checks `orca` commands. It reads the role only from `agent_type`.
- The UI check needs a browser tool. A builder runs it only through a command-line browser such as Playwright; otherwise the orchestrator runs it after the builder reports DONE.
- The install proves delegation with one subagent probe.
Pruned what Claude already knows. A line stays only when it is specific to this plugin, goes against Claude's default, or records a real failure:

- Gone: "do not launch subagents" in every role (subagents cannot launch subagents); git rules the guard already enforces; generic git and `gh` advice; the role examples table; INVEST and the usual split patterns; the story anti-patterns Claude checks anyway; generic browser tips; generic research and copy rules; WCAG ratios; the Orca role-file lines in `.gitignore`.

Lessons from Alhaitham, the orchestrator of Easy One, written for any project:

- How to write to the human so code reads as code. A story goes by its title with the ID in parentheses, and markers become plain words. Commands go in their own blocks, and commit hashes and paths stay in the ledger. A project's `CLAUDE.md` can loosen this for a technical human.
- The human talks only to the orchestrator, which routes each message.
- Exploration: for fast iteration the human watches, the orchestrator edits directly on `explore/<topic>` and formalizes only when the human keeps the result.
- One story at a time when the human refines work.
- Scale the process to the project: a prototype gets one review per story and tests only for criteria with logic.
- Product documentation states what is. Decisions, dates and open points stay out of it.
- Stories cite a source, or are marked as proposals.
- A UI state gets its own criterion only when a person cannot reach it by using the screen.

## 0.8.1 — 2026-11-18

The second batch of lessons from the gg-ez reference redesign block.

- The builder knows from the start that the orchestrator unlocks and relocks tests, and that it never edits a story by any means. It drafts criterion text in its report.
- A new criterion joins a story only when it serves that story's benefit. Otherwise it starts a new story.
- Before the orchestrator calls a UI story done, it looks at the builder's screenshots itself.
- A UI brief names the project's primitives to use.
- A human's local-only change is marked in the ledger. Every brief says never to stage it, and a writer that must change it hands over a diff.
- The orchestrator checks an agent's factual claims before it passes them on.
- Before proposing repository settings, check the human's permissions with `gh api`.

## 0.8.0 — 2026-11-18

Lessons from the gg-ez reference redesign block, sent by its orchestrator session.

- **Profiles.** The orchestrator picks a profile for each block of work and writes it in the ledger. Live: writers run one at a time in the main checkout, on the block's branch `block/<slug>`, as subagents or as workers. Isolated: each writer gets its own worktree, as before. When in doubt, choose live. A live block of coupled UI stories ran faster than workers in worktrees.
- `dispatch.mjs --live` puts a writer on `current`. It refuses the launch when another writer is open on `current`, or when the main checkout is on a protected branch or a detached HEAD.
- The guard blocks two commands in the PowerShell tool. The first is an inline script (`node -e`, `python -c`): PowerShell rewrites `$1` and quotes inside it, and one script deleted a story's criteria. The second is `Set-Content`, `Add-Content` or `Out-File` with `-Encoding utf8`: it writes a BOM, which broke lint.
- Briefs carry a call budget. A builder with several stories commits after each criterion turns green. A subagent that runs out of turns without a report is resumed with "verify, commit, report".
- A finding or a human correction on files a builder still holds goes to that builder as an extra item, never to a second writer. A correction also becomes a general rule in the next brief.
- While a writer shares the checkout, the orchestrator commits with `git commit -- <paths>`.
- A polish test gets its own criterion before it is locked. A human change to a decision that locked tests observe unlocks those files in their own commit, with the reason.
- Builder and designer read the console before they capture in Orca's browser tab: the capture adds `data-__ab-ci`, which Next reports as a hydration error.
- A test over a set reads the set from the code, never from an example.
- PR titles are plain words without story IDs. The body leads with what matters. A visible change adds before and after screenshots.

## 0.7.1 — 2026-11-17

Two checks ported from Alhaitham, Easy One’s fork of this plugin.

- The guard blocks a role from committing, merging, rebasing, pulling, cherry-picking, applying patches or reverting on a detached HEAD. It also refuses the stop of a writing role there. A rebase or `am` stopped on a conflict still finishes.
- Only a global `-C` names git’s folder for the guard. Before this, `git commit -C <commit>` skipped the protected-branch check.
- `dispatch.mjs` refuses a writer while the stories have uncommitted changes in the main checkout or the worker’s worktree. It fails on a git error instead of passing.

## 0.7.0 — 2026-11-12

A leaner instruction set: each rule lives in one place, and text that code already enforces is gone. Ported from the measured trim of Alhaitham, Easy One's fork of this plugin.

- `references/harness.md` covers only what the plugin adds on top of Orca's own guide (3,367 → about 2,000 words). It now ends with **Enforced by code**: everything the guard, `dispatch.mjs` and `stories.mjs --check` enforce, so prose about those rules can be deleted safely.
- The orchestrate skill drops the duplicated harness and delivery rules, fixes the stale `--worktree new-child` step, and adds lesson retirement: a lesson leaves `CLAUDE.md` once code prevents its failure.
- The **If Orca dispatched you** section in every role file is one paragraph.
- The stories skill names the splitting patterns in one line instead of a numbered lecture.
- The one-time proof that Orca workers load the plugin and their role moved from `harness.md` into the install skill, its only user.
- Folder trust is no longer described as always prompting: on macOS, new worktrees started without it. Added a note on the brief «paste again to expand» pause.
- README rewritten; this changelog added.

## 0.6.3 — 2026-11-12

- The guard asks before an inline script only when it both mentions git and starts a program. Replayed over past sessions, prompts fell from about 1 in 25 Bash commands to almost none.

## 0.6.2 — 2026-11-12

- The guard asks the human before running an inline script (`node -e`, `python -c`, a heredoc) that mentions git, because git calls inside a script escape the command checks.

## 0.6.1 — 2026-11-12

- The switch-plus-commit check compares git subcommands only: a commit message containing "switch" no longer blocks.
- A single `&` separates commands, so a git call after it is checked.
- Once `core.hooksPath` is set, unsetting it, pointing it elsewhere, removing or renaming the `core` section and `git config -e` are blocked.
- Read-only roles can run read-only git commands with global options, such as `git -C dir status`.

## 0.6.0 — 2026-11-11

- `scripts/dispatch.mjs` launches a supervised Orca worker in one command: terminal in the worker permission mode, role file, empty shells closed, stop on any prompt, brief dispatched.

## 0.5.x — 2026-11-02 to 2026-11-06

- A same-failure breaker stops a builder that repeats a failing command.
- Builder reports carry a `Risk:` line; stale context references fail `stories.mjs --check`.
- Builders test only the feature: one acceptance test per criterion plus its error case.
- Fixes from a code review and from running on macOS.

## 0.4.0 — 2026-10-30

- Per-terminal role files for Orca workers; one review and one fix round per story; partial test runs keep earlier results.

## Earlier

- 0.3.x: renamed from orquestador; push needs confirmation instead of being blocked; writer worktrees are removed once their story is done; the install asks for the plugin's scope.
