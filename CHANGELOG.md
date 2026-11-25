# Changelog

## 0.11.1 — 2026-11-25

Guard fixes from Easy One's port of 0.11.0 and two code reviews, each case reproduced first.

- The guard follows `cd` along a command line: `cd tests && rm a.test.js` was checked in the wrong folder and deleted a locked test. A `cd` it cannot follow (a variable, `cd -`, `popd`, inside a subshell, a pipeline or the background) makes later relative paths unknown, so a write that could reach a guarded file asks. A script handed to `bash -c` keeps its own folder.
- Variables: a value from `$(...)`, a backtick, a subshell or a pipeline, or a quote inside it, stays unresolved, and so do loop variables, `read`, `+=` and `printf -v`. `export D="x"` is read whole. `$PWD` is the shell's folder, not the hook's.
- A `..` after a variable, or anywhere on a line with an unresolved variable, asks instead of passing.
- Commands inside `do`, `then`, `else`, `{` and `!` are checked; they were skipped.
- The body of a `cat` or `tee` heredoc is text, not commands: HTML with `>` in it no longer blocks. A `<<<` here-string or a `<<` inside quotes is not taken for one.
- A read-only role cannot write through an unresolved variable even under the temp folder: the variable could hold `../`. `$null` is the null device.

Roles:

- Every brief tells the agent to search with grep, rg or find through Bash when its session has no Grep or Glob tool. Some Claude Code versions have neither: an Easy One designer called Grep twice and got «No such tool available». The roles keep listing them for the versions that have them.
- The copywriter gets Bash and PowerShell, so it can search on those versions too. The guard holds its writes as before.
- The brief tells every role three more things it never read in `harness.md`: the server URL the orchestrator started (never start one), scratch files in the scratchpad (never new files in the repository), and Edit or Write instead of `sed -i`. From Easy One's sessions of 25 November.

## 0.11.0 — 2026-11-25

Builders can run in their own Orca terminal, so the human watches them work. Orca is only the place a builder runs: the plugin launches it with its role, and the guard holds it as it holds a subagent.

- `scripts/launch.mjs` creates the Orca worktree on the story's branch, opens `claude --agent orchestrator:builder` there, stops on any prompt for the human, and hands it the brief with `orca orchestration worker-start --terminal`. Orca wakes the orchestrator when the builder reports. It checks first that Orca still has every command it uses.
- One fixed rule: an isolated-profile builder runs this way when `.orchestrator.json` → `orca.builders` is `"terminal"` and the orchestrator runs inside Orca. Every other role, and every other case, is a subagent.
- `references/orca.md` lists the facts the launch relies on, each with its source and whether it was tested. Tested on macOS with Orca 1.4.274; not yet on Windows.
- Orca's `orchestration` skill stays out of Claude's skills (`harness.md` → Avoid): it launches workers without a role. `orca-cli` is fine.

Guard fixes from Easy One's session of 25 November, where the guard blocked a designer and a design-system agent writing logs and scripts to their scratchpad:

- Shell paths are read with their variables filled in: assignments made earlier on the same command line (`S=...` alone or `export S=...`), then the environment, and `~`. `S=<scratchpad>; npx vite > $S/vite.log` is a write to the scratchpad, not to a repo file named `$S/vite.log`. Single-quoted `$` stays literal, and `git rm`/`git mv` paths are expanded too.
- A path whose variable stays unresolved (a loop variable, `$(...)`) asks the human when it could name a locked test, the lock list, the generated map or the guard's record, and a builder's write into the stories through one is blocked. A read-only role writes the full path instead.
- A read-only role may also write in the temp folder (its scratchpad, a log). Everywhere else, other worktrees and the user's settings included, it still writes only its report under `.orchestrator/work/`.

## 0.10.1 — 2026-11-25

Fixes to `tidy.mjs` from Easy One's review of its port.

- A branch counts as merged only if it ever had commits of its own, so a branch created for a builder that has not committed yet stays, and a fast-forward merge is no longer missed.
- A work folder stays when a project skill under `.claude/` or a new, uncommitted file cites it. Names in `state.md` match whole names only.
- A worktree with reports in its own `.orchestrator/work/`, or a branch its upstream lacks, stays.
- Preview and the session-start note change nothing (`git worktree prune` runs only with `--run`). `--keep` also takes a branch.

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
