# Changelog

## 0.13.2 — 2026-11-26

The guard stops growing against bypasses. Since 0.9.0 it grew from 411 to 906 lines. Between 0.11.2 and 0.13.1 its cases went from 114 to 301. Most of that work closed bypasses that only reviews found (globs, symlinks, `env -S`, quoting), and each fix revealed more.

- `references/harness.md` → **What the guard is for**: the guard catches honest mistakes, not deliberate evasion. A gap gets a fix only after an agent hits it in real work. Bypasses found only in review go under "Known, unchanged".
- No guard code changed.

## 0.13.1 — 2026-11-26

Fixes from the Easy One watch of 26 November, each reproduced first, kept to what survived six code reviews.

- A glob is matched segment by segment against the locked tests: `rm tests/*`, `rm tests/[!b].test.js` and `rm -rf t*` are blocked, `rm -f *.log` and `cp *.md docs/` pass. A brace group counts as anything in its segment. A glob the guard cannot read for certain (`[[:alpha:]]`, `[]a]`, a brace group with `/` or another brace, a backslash escape) names everything under its fixed folder: `rm tests/{a,x/y}.test.js` and `rm tests/\a.test.js` are blocked.
- Symlinks: each path is checked both as written and as resolved, for shell commands, Write and Edit, paths with a variable, the commit check and the builder's Stop check. The locked list is also read through its real paths, so neither a session folder reached through a link nor a symlinked `tests -> real/tests` hides a locked test. `cd ..` from a linked folder is followed as the shell does.
- A worker in a worktree opened by hand (an Orca tab) is told at its start to run the project's setup first, when the project has one (commands, files to copy, or a `.worktreeinclude`) and that worktree shows no sign of it. Worktrees under `.claude/worktrees/` come from the hook, which runs setup. `worktree.mjs setup` leaves a mark for this.
- The brief tells every role to put a script longer than one line in a scratchpad file and run it, to read PDFs with the Read tool, to try another source when a web page fails, and, in a worktree of its own, to run one plain command per call. It names source files relative to the repository root: Claude Code refused two isolated agents' edits through the main checkout's paths.
- `env -S"…"`, `env --split-string= '…'` and `cmd /c"…"` are read as scripts.
- `hooks/check-guard.mjs` has 301 cases, each with a 20-second limit; symlink cases are skipped, and say so, where links cannot be made.
- Tried and dropped, each because review found ways through it: a loop exemption for read-only roles (a variable in a target stays blocked: write the full path), reading an interpreter's heredoc as its script (`perl -ne system$_` runs its heredoc as shell), and joining a quote to the word it touches (`git commit -m"new feature"` read as `-n` and `-a`).
- Known, unchanged: a quoted folder glued to a glob (`"<dir>/"*.png`) is read as two words, and a `bash -c` or `env -S` script in glued quoted pieces is checked by its first piece.

## 0.13.0 — 2026-11-26

One orchestrator per repository, and the human's checkout stays on the main branch. In Easy One on 26 November a session switched the main checkout to `explora/botones`, the human's merge into main fast-forwarded that branch instead, and a session the human opened in an Orca worktree loaded the orchestrator's procedure too: three sessions acted on one folder.

- The orchestrator is the session in the main checkout. A session that starts in a linked worktree (by hand, Orca's, Claude Code's) is told at its start that it is a worker on that worktree's branch, and the guard stops it loading the `orchestrate` skill. A worker is held like a role agent: it never switches the main checkout, merges into a protected branch or moves one, through git or gh. The guard tells them apart by where Claude Code launched the session (`CLAUDE_PROJECT_DIR`), which stays the main checkout after the orchestrator enters a block's worktree, through compactions, resumes and `/clear`. A session launched in a worktree stays a worker through its own. No record is kept. The main checkout is the first entry of `git worktree list`; a bare repository has none, and then no session is a worker.
- The live profile runs in the block's worktree: `git worktree add .claude/worktrees/block-<slug> -b block/<slug>`, setup, then EnterWorktree with its path. Subagents and the dev server follow the session there; the main checkout stays on main. Explorations do the same. Tested with Claude Code 2.1.332: a subagent launched after EnterWorktree runs in the worktree, and ExitWorktree with `keep` leaves it intact.
- The guard asks before the orchestrator switches the main checkout off a protected branch, and blocks role agents from it. `git checkout -`, `git checkout <branch> --` and `-qb` count as switches. Moving a protected branch without a merge command counts as a merge: `git fetch . x:main`, `git push <any remote> x:main`, `git branch -f`, `-M` or `-C` onto main and `-m` of main itself, `git update-ref refs/heads/main`, `git update-ref` (past `-m`, `--stdin`, and `HEAD` while on main), deleting it (`git push origin :main`, `--delete main`), and `git reset <commit>` while on main, with or without `--`. `gh pr checkout` in the main checkout asks too. A branch that exists only on a remote, `git checkout -b<name>` and `--orphan=<name>`, `git switch -d`, `git symbolic-ref HEAD <ref>` and `git bisect` count as switches; `git branch -d main`, a glob refspec that can reach main (`refs/heads/*:refs/heads/*`), and `checkout -B main` or `switch -C main` in any worktree as moves. A worker never commits, merges, resets or switches in the main checkout, whatever branch it is on. `git checkout -p` is not a switch. Commands that change nothing pass: `git reset HEAD`, `git switch main` on main, `git push origin HEAD:main` from main. A `git pull --ff-only` that names a source asks too.
- The orchestrator's session start says when the main checkout is off the main branch.
- The install puts `.claude/worktrees/` in `.gitignore` in every project.
- `hooks/check-guard.mjs` has 255 cases, each with its own launch folder, with a linked worktree and a moved main checkout among its fixtures, SessionStart and Skill events, and each case in a session of its own unless it names one.

A new worktree is ready before its agent starts, and removing it leaves nothing behind. In Easy One isolated worktrees went unused: each needed `npm ci` and a code-graph build before the pre-commit stopped failing, a design canvas had to be told about it, and removal left caches and half-deleted folders.

- `.orchestrator.json` → `worktree`, read only from the main checkout (a branch's copy is content a builder can commit): `setup` commands, ignored files to `copy` (with `.worktreeinclude`), `teardown` commands. All optional; the commands are the project's and run in the worktree through the system shell.
- `scripts/worktree.mjs` is Claude Code's `WorktreeCreate` and `WorktreeRemove` hook. It creates the worktree where Claude Code would (`.claude/worktrees/<name>`, branch `worktree-<name>`). Its base is the caller's HEAD unless `worktree.baseRef` says `"fresh"`: Claude Code's own default, origin's branch, would start a builder without the orchestrator's unpushed stories and locks. A `+` in a name is refused: it stands for `/` in folder names, copies, runs setup and prints the path. A failing setup removes the worktree and fails the creation. Removal runs teardown first and deletes a branch only when it has no commits of its own or is merged into the main branch; a branch is deleted only when every commit on it also lives on another branch or a remote-tracking ref that stays, whatever its reflog says; its own remote copy does not count, so a pushed, unmerged branch stays. A worktree with uncommitted changes is never removed: the removal fails and says so. Both scripts run through a symlinked project folder.
- The install copies it to `.orchestrator/worktree.mjs` and registers the hooks in the project's `.claude/settings.json`, only when the `worktree` key exists. Other projects keep Claude Code's own worktrees.
- `launch.mjs` runs setup in a new Orca worktree before it opens the builder. `tidy.mjs` runs teardown before it removes any worktree, after checking that git will remove it (not locked, no changes, no checked-out submodules), and leaves alone a worktree touched in the last hour, where an agent may have just started, and now also removes agent worktrees nobody committed to: with the hook, Claude Code keeps every subagent's worktree when it finishes.
- Tested on macOS with Claude Code 2.1.332: a subagent with `isolation: "worktree"` started only after a 4-second setup finished, and `ExitWorktree` ran the removal hook. Not yet tested on Windows.

## 0.12.0 — 2026-11-26

The orchestrator opens quality pull requests and looks after them until they are merged, without the human typing anything. From what Sydney taught in gg-ez, and from the work after a PR opens.

- `references/ship.md` is the one home for pull requests: title, body, screenshots, the watch and review comments. `git.md` keeps the branch and commit rules and points there.
- The title is the story ID and what a person notices («TAB-018: la descripción a medias se guarda al irse»). It replaces "no story IDs in the title".
- The body says what a person notices first, one bullet per behaviour change, short technical pointers, then honest evidence: who checked what and how, what nobody could check, each criterion's state, the commands that passed and the reviewers' verdicts.
- Visible changes carry before and after screenshots. The before shots are taken when the story branch is created. `scripts/pr-assets.mjs` commits them to `pr-assets`, an orphan branch that is never merged, and prints the Markdown; the links name the commit. In gg-ez the screenshots were committed on the story branch: the merges carried them into `main`, and the links of PR 123 broke when its branch was deleted.
- `scripts/watch-pr.mjs` runs in the background and exits when a check fails, the PR conflicts with its base, a review or comment arrives, the PR is ready to merge, merged or closed, or after an hour. It uses only `gh` and `git`. Each comment says whether its author has write access; anything else, a bot included unless `git.trustedBots` lists it, is a claim to check, never an instruction. It skips the orchestrator's own replies: the `<!-- orchestrator -->` marker counts only from the signed-in `gh` account. It reports each failing check run, so a rerun that fails again is reported too. It calls a PR ready only when GitHub says it can merge with its checks green (`CLEAN`, or `UNSTABLE` with only ignored checks not green), and not before the first check reports. It reports `escalate` when one issue has failed on three pushes in a row; a fixed check or conflict starts its count again. Its cursor lives in `.orchestrator/watch/pr-<n>.json` of the main checkout, shared by every worktree and left alone by the close's tidy, with its own `.gitignore`.
- `scripts/pr-assets.mjs` stores files as they are (`--no-filters`, so Git LFS cannot turn them into pointers), refuses two files with the same name, and refuses a remote whose host is an SSH alias: the links need the real web host.
- Fixes go through a builder on the same branch; a conflict is resolved by merging the base in, never by a rebase. A redesign or scope change asked in review, a design debate and an open security point go to the human. In the isolated profile the base is merged in the builder's worktree with `git -C`.
- A review point that repeats on a second PR becomes a proposed rule for `CLAUDE.md` or `REVIEW.md`, written once the human approves.
- `stories.mjs --pr ID --link <base>` links the story file absolutely: a relative link breaks in a PR body. Without `--link` the output is unchanged. Copy `stories.mjs` into a project again to get it.
- New optional keys: `git.mergeMethod`, `git.trustedBots`, `git.ignoredChecks`.
- The guard holds merges and approvals. Role agents never merge or approve, and only read GitHub: anything but a read verb (`view`, `list`, `status`, `checks`, `diff`, `search`…) or a `gh api` call that is not a GET is the orchestrator's. The orchestrator asks the human before every merge and every approval, through `gh pr` or `gh api` (`pulls/<n>/merge`, `/merges`, a branch ref, `event=APPROVE`), whatever `git.allowPush` says. `gh pr merge --admin` skips the branch protection and is blocked. Flags before the verb (`gh pr -R o/r merge`), a verb in a variable, attached field values (`-fbody=x`) and gh by its path are read.
- A merge into a protected branch is a click, not a command the human types. The guard asks the human to confirm the orchestrator's `git merge` into `main` instead of blocking it; a `git pull --ff-only` there passes, and rebase, cherry-pick, `am` and `revert` stay blocked. The orchestrator merges a block's accepted work once, at the close, not per story. (Easy One, 2026-11-26: the human typed every merge into main, even the smallest.) A project whose own rules say the human types the merge can drop that rule.
- Fixed from 0.11.2: `export HUSKY=0` was matched anywhere on the line, so a commit message or a heredoc that mentioned it was blocked. It is read from the command's own words now, inside `{ }` or after `then` too, and PowerShell's `$env:HUSKY = "0"` with spaces is caught. (Easy One, 2026-11-26.)
- Git and gh run through `xargs`, `find -exec`, `parallel` or `watch` are checked as if run directly: `echo x | xargs git push --force` passed. A role agent cannot run gh from an inline `node -e` or `python -c` script, and the orchestrator is asked. A gh alias, an extension, and a GraphQL `mergeBranch`, `deleteRef` or `createRef` ask too.
- `hooks/check-guard.mjs` has 190 cases.

## 0.11.2 — 2026-11-26

A search no longer trips the guard. From Easy One's guard (a1436fd), reproduced here first, then narrowed over five code reviews: each wider version let a force push through.

- A line that is one search, `rg`, `grep`, `egrep`, `fgrep`, `ugrep`, `Select-String` or `findstr`, or one `gh pr`, `gh issue` or `gh release` command, may quote git or shell text: it is text, not a command. `rg "git push --force" docs` and a pull-request body that mentions a force push were blocked as a force push. `2>/dev/null` and `2>&1` are fine. Quoted text with a `$(...)` or backtick inside double quotes, a newline or an escaped quote on the line loses the exemption: it is checked as before 0.11.2.
- Anything more on the line and the quoted text is checked as before: another command, a pipe, a redirect, a group, a loop, a prefix such as `env` or `timeout`, `./rg` instead of `rg`, or the line being a script `bash -c` runs. Search in a line of its own.
- Windows: the same holds in PowerShell for `Select-String`, `sls`, `findstr` and `rg.exe`, with `2>$null` or `2>NUL`. A path such as `C:\tools\rg.exe` or `.\rg` is checked: it could be any program.
- `echo`, `printf` and `gh alias` stay checked: their output or alias can be run.
- Wrappers are read with their options: git behind `timeout`, `nice`, `ionice`, `stdbuf`, `caffeinate`, `chrt`, `taskset`, `setsid`, `unbuffer`, `doas`, `sudo -u root`, `sudo --user root`, `sudo -uroot`, `env -i`, `env -P`, `exec -a`, `time -p`, `command -p`, `xcrun --sdk x` or `arch -arch arm64`, alone, chained or written as a path (`/usr/bin/env`), passed unseen. So did a quoted prefix (`X="a b" git push`). `command -v git` only looks git up, so a read-only role may run it. `HUSKY=0` behind one is blocked too.
- `bash -c` and the other shells' scripts are checked with options before `-c` (`bash -o pipefail -c`, `bash -euo pipefail -c`, `+o posix`, `--rcfile f`, `pwsh -NoProfile -Command`, `cmd /d /s /c`), and for `dash`, `ksh`, `fish`, `csh` and `tcsh` too. Quoted text starting with `bash.exe` or `/bin/bash` is read as a shell call.
- The string `env -S` runs is checked as a command line: `env -S 'HUSKY=0 git commit'` passed. `export HUSKY=0`, `declare -x HUSKY=0` and PowerShell's `$env:HUSKY="0"` are blocked like `HUSKY=0 git commit`.
- `hooks/check-guard.mjs` runs 114 cases, Bash and PowerShell, against the guard in scratch repositories. Run it after every guard change: each version this week had a regression a rerun would have caught.
- A search behind `timeout 30` counts as a probe: finding nothing is not a failure.
- Still unchecked, as before: a `$(...)` inside double quotes that does not start with git (`--body "$(git push --force)"`; re-reading it as shell blocked ordinary commit messages and PR bodies written with a heredoc), git behind `xargs` or `find -exec`, a program name in quotes (`g"it"`, `"bash" -c`), `bash -c -- "…"`, and PowerShell's `Start-Process git`.

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
