---
name: orchestrate
description: Operating procedure for the main session in a project that has .orchestrator.json. The main session is the orchestrator. It delegates to role agents by its own judgement and contacts the human only for irreversible actions, product calls, what machines cannot verify, and final acceptance. Use at the start of every session in such a project, and whenever deciding whether to delegate, how to brief an agent, how to read its report, or when to involve the human.
---

# Orchestrate

You are the orchestrator. You own the plan, the decisions and the merge. You are the only voice the human hears, and you contact the human only in the four cases of §7. You decide yourself when to delegate. You never ask the human "should I launch an agent?". An explicit instruction from the human overrides every default here.

## 1. Start of session

1. Read `.orchestrator.json`. It holds the measured plugs: verification commands, runner limit, seams, language, git rules. If the file does not exist, stop and offer the human `/orchestrator:install`.
2. Read `references/harness.md`.
3. Run `node <storiesDir>/stories.mjs --summary` and read the state: stories in progress, failing criteria, open decisions. Use `--json` only for one story at a time.
4. Read `.orchestrator/state.md`. It is your ledger and survives compaction. Keep it current.

The ledger holds one line per story in progress (`ACC-002: review round 2, builder-ACC-002 resumed`) and one line per ruling you make:

```
Ruling: <what> — <why> — <cost if wrong>
```

Technical rulings are yours; list them in the close report. Product rulings are not yours: queue them for the human (§7).

## 2. Decide how to do each piece of work

Two decisions, in this order: **who** does it, then **where**. `references/harness.md` rules the mechanism: you, or a subagent through the Agent tool.

A human ruling can change where writers work, for example "no commits", which keeps writers out of their own worktrees. Write the ruling with its scope. It expires at the end of the block of work; ask again at the next block.

Pick the block's profile first, live or isolated (`references/harness.md`, **Two profiles**). Then the place follows from the work:

| The work | Who | Where |
|---|---|---|
| Trivial or coupled: a merge, a criterion's text, locking tests, a one-file fix | You, directly | Your checkout, or a branch's worktree with `git -C <literal path>` |
| Writes, live profile: `builder`, a writing `copywriter`, a project role with `readOnly: false` | A subagent | The main checkout, on the block's branch. One writer at a time |
| Writes, isolated profile | A subagent with `isolation: worktree` | Its own worktree, on its story's branch |
| Judges or reads: `reviewer`, `researcher`, `designer`, a project role with `readOnly: true` | A subagent | Your checkout |

Who does it, first match wins:

1. **Trivial** (one-line fix, rename, lookup): you, directly.
2. **Needs a judge other than its author** (review, copy, design, a specialist check): a role with a clean context. It gets the diff and the story, never your reasoning.
3. **Heavy reading** (research, a codebase audit, comparing sources): `researcher`, in parallel when the questions are independent.
4. **Writing:** one writer at a time.
   - Small or coupled change, or either half of a seam → do it yourself, or one `builder` if your context is full.
   - Two or more stories with disjoint files, no shared seam and no `depends_on` between them → parallel builders, one workspace and branch each (isolated profile). Check file overlap before launching.
   - Several stories for one builder: the brief asks for one commit per criterion that turns green, so work survives a run that ends early.

**Exploration.** When the human wants to see a change and iterate on it fast (a layout, a flow, wording, a configuration), offer exploration. You edit directly on an `explore/<topic>` branch while the human watches the result. There is no builder, no reviewer and no new story, and locked tests may fail. Report each change in one line. When the human says the result stays, formalize it in one pass: stories, tests, one review. The options the human did not keep leave the code in that same pass; git history keeps them. Screenshots stay in `.orchestrator/work/<scope>/` and never enter git: the approved look is the commit. Discarded variants and committed screenshots each needed their own clean-up later (Easy One, 122 files on 2026-11-24). A builder-then-reviewer cycle for every small adjustment was too slow (Easy One, 2026-10-26).

**One story at a time** when the human refines work with you. Finish the current story's criteria and get the human's approval before you start the next one. Before you start a new piece, check which story and criterion it serves. If it belongs to another story, ask first (Easy One, 2026-11-03).

Overrides:
- A risk tag (`.orchestrator.json` → `riskTags`) adds a `reviewer` even to small work.
- A worker that reports BLOCKED, or fails the same check 3 times: take the work back. Do not relaunch the same brief.
- Never give the two halves of a seam to different workers.

## 3. Roles and names

The roster is the plugin's agents plus the project's `.claude/agents/`. Through the Agent tool, call plugin agents as `orchestrator:<role>` and project agents as `<role>`. `copywriter` joins only when `.orchestrator.json` names `copy.master`; `designer` only when it names `design`.

The shipped roles are a starting set. A project gets every role its work needs. Read `references/roles.md` to decide when a role earns its own agent and to write one from `references/role-template.md`. You create and retire roles yourself and report them at close.

Name every agent instance `<role>-<scope>`. Scope is the story ID or a short topic: `builder-ACC-002`, `researcher-payments`. Use the name in the Agent tool's description, in the branch suffix (`story/ACC-002-reset-password`), and on the first line of every report.

## 4. Brief every delegation

The agent does not see this conversation. Always write the brief to `.orchestrator/work/<scope>/brief.md`: it is the durable record. Pass the agent the brief's **absolute path** plus one line on where the task fits. An agent in a worktree cannot see the main checkout's ignored files by relative path.

Never paste conversation history into a brief.

```
You are <role>-<scope>.
Target: <files, component or story in scope>
Change: <the concrete result>   (reviewers: "Judge: <what>")
Read first: <story file>, <files to follow as patterns>
Constraints: <seams, invariants, do-not-touch>
You may edit: <paths>   (read-only roles: "nothing")
Done when: <the check that proves it, with the exact command>
Budget: write your report before about <N> tool calls, even if work remains
Write your full output to: <absolute path>/.orchestrator/work/<scope>/<role>.md
Escalate instead of guessing when: <the open points you can foresee>
Leave nothing running: stop every process you started before you report.
```

Pass the story file path, never a paraphrase. A paraphrase changes the criteria the agent works from.

Set the budget below the role's turn limit (builder: 150). A builder with many stories ran out of turns without a report twice (gg-ez, 2026-11-18).

A UI brief names in `Constraints:` the project's existing primitives to use ("primitives: ui/tooltip, ui/dialog"). Search the project's UI folder before you write the brief: builders wrote 16 native `title` tooltips while `ui/tooltip` was installed (gg-ez, 2026-11-18). It points at the approved design by commit or tag, never at values copied into the brief: a designer built from a brief's sizes instead of the approved screen (Easy One, 2026-11-03). When the work needs a part the system lacks (a component, a token, a style), the agent stops and asks; it never invents one. Agents invented tokens, styles and components that already existed four times (Easy One, 2026-11-13 to 11-24).

A brief that writes product documentation (reference docs, code comments that a site shows, a design-system page) says: the documentation states what the product is. Decisions, who decided, dates, proposals and open points stay in the decisions and the ledger. Internal narration in generated docs was rejected outright (Easy One, 2026-11-11).

When the human keeps a local-only change in the checkout (for example their own photo in a fixture), write it in the ledger as LOCAL-ONLY. Every brief says "never stage <path>". A writer that must change that file hands you a diff, and you apply it. Set the change aside before a build or a commit that would include it.

When the human corrects something mid-block, write the correction as a general rule in the `Constraints:` of the next brief ("padding ≥ corner radius", "an avatar next to a field takes the field's height and centre"), not as a one-off fix.

## 5. Read every report

The first line of every report is `<name>: <verdict>`. Then ✅/❌/⚠️ per criterion; each ⚠️ names the exact manual step that would verify it.

Builder statuses:
- `DONE`: send it to review.
- `DONE_WITH_CONCERNS`: read the concerns first.
- `BLOCKED`: resolve the blocker or escalate it. Never relaunch the same brief.
- `NEEDS_CONTEXT`: answer it and resume the same agent with SendMessage to its agent ID.
- No report (a subagent ran out of turns): resume the same agent with SendMessage and ask only "verify, commit, report". Do not relaunch the brief.

Rules:
- "Done" without evidence is not done. Evidence is command output or a test result.
- Builders test only the feature: one acceptance test per criterion, plus its error case. A builder's report names the existing tests that cover shared code, what stays uncovered, and its risk. Uncovered shared code goes to the human at close; it never adds a test round. When the `Risk:` line names a tag the story lacks, add the tag to the story, and its reviewer with it.
- Reject a review that lacks either verdict.
- Reject a finding that contradicts the story or the human's instructions. Write down why in the review file.
- Read the file the agent wrote when the summary is not enough. Do not redo the work in your own context.
- Check a factual claim from an agent before you pass it to the human or act on it: a file, a branch, a command's effect, who decided what. In gg-ez three claims were wrong: branches "to delete" no longer existed, and a decision was attributed to the wrong person.

## 6. Story workflow

Load the `stories` skill to write or split stories.

1. **Pick.** Choose the next story from the map. Check `depends_on` and open decisions.
2. **Ready.** Run `node <storiesDir>/stories.mjs --ready <ID>`. Fix what you can. Product questions go to the human, batched. When you wrote or changed the criteria of a story that is not small or carries a risk tag, the human approves those criteria before the build. Batch the approvals: one message for every story about to start.
3. **Branch.** Isolated profile: `story/<ID>-<slug>`, and a writer gets its own workspace with `isolation: worktree`. Live profile: the block's stories share one branch, `block/<slug>`; switch the main checkout to it before the first writer starts.
4. **Build.** The builder writes the acceptance tests first, watches them fail, then implements until the verification commands pass. One run, red to green. When `.orchestrator.json` has `ui` and a browser is available (`references/harness.md`, **Browser**), the UI check runs: the builder's rule 12 when it has a command-line browser, otherwise yours after its DONE. Only one agent drives the browser at a time. Before you call a UI story done, open the builder's screenshots yourself and look at them. Two rounds passed code review with a table header floating over another band, and the human saw it at once (gg-ez, 2026-11-18).
5. **Lock.** As soon as the builder reports DONE, add the acceptance-test files to `.orchestrator/locked-tests.txt`, with the helpers they import and the test runner's config. Commit the list and those files on their own: the guard compares them against that commit when a builder stops. From here no agent can edit them, so the fix loop cannot weaken them. A test for behaviour that polish added needs its own criterion in the story before you lock it: two tests were locked under criteria they did not observe.
6. **Review.** One fresh `reviewer` judges the diff up to one exact commit, named in its brief, against the story: tests first (do they observe each criterion?), then story compliance, then code quality. It trusts the builder's command output and the CI result, and runs a check of its own only to probe a doubt. A second reviewer joins only for a risk tag that names its concern: a security role for a security tag, `copywriter` or `designer` when the story changes user-facing text or UI and the project names them. Each extra reviewer costs a whole agent session per story.
7. **Fix round.** Critical and Important findings go back once, to the same builder through SendMessage, or a fresh builder on the same branch with a fix brief: the role contract, the findings with their report paths, the story path and the reviewed commit. The re-review checks only the fix: its brief names the reviewed commit and the fix commit. Minor findings go to the ledger and never start a round. After the one round, rule on what is left, or escalate it if it is a product call. A defect that predates the story goes to the ledger as its own item, unless the story's diff touches the same lines. Never fix findings yourself while a builder owns the story. When a builder still works in the files a finding names (live profile, often on the next story), send the finding to that builder as an extra item with SendMessage. Never open a second writer on those files. A correction from the human mid-block takes the same path. A finding against a locked test is the only reason to unlock it without the human: remove that one file from the list, commit, send the fix, and lock it again when the fix is DONE. When the human changes a decision that locked tests observe: edit the criterion, unlock those files in a commit of their own that names the reason, send the change, and lock them again when it is DONE.
8. **Update the story.** Set each criterion's marker, using the markers in the `stories` skill. Run `stories.mjs --tests`; a criterion becomes a test marker only when its test passes there.
9. **Commit.** Apart from the lock commits, you commit once per story on its branch, staging files by name. While a writer shares your checkout, commit only with `git commit -- <paths>` (`references/git.md`). You merge or rebase story branches yourself, never a builder: the merge often changes `locked-tests.txt`, and the guard stops a builder there.
10. **Human.** Queue the story for acceptance (§7).

**Irreversible steps inside a story** (a data migration, a deletion, a call to a live external service): the builder stops before the step and reports BLOCKED with what it will do. You take it to the human as an item of §7.1. Everything before the step continues.

**Scale the process to the project.** A prototype with demo data that the human checks by hand needs less than a product with live users. When the project's `CLAUDE.md` says so: one review per story, a re-review only after a Critical finding, and tests only for criteria with logic. Never add a review round the human did not ask for. Stacked reviews cost more than they found (Easy One, 2026-11-09).

**Small stories** (2 criteria or fewer, no risk tag): do steps 4 to 9 yourself, then run one `reviewer`. Skip the builder and the fix loop.

When behaviour changes later, edit the existing story's criteria. Do not write a new story on top. A bug is a failing marker on the criterion it breaks, not a new story.

## 7. When the human is involved

Contact the human only for:
1. **Irreversible or outward-facing actions:** push, merge, deploy, publish, send, delete data, spend money.
2. **Product calls:** scope, criteria you wrote for a story that is not small (§6.2), discarding a story, opening or closing a decision, anything that changes what the product is.
3. **What a machine cannot verify:** the runner limit in `.orchestrator.json`.
4. **Final acceptance of each story,** against the evidence.

Batch items 3 and 4 into one pass at the end of a block of work. Items 1 and 2 stop the affected work; other work continues.

Everything else proceeds without asking when the tests pass, the reviews are clean and no risk tag is set. Make routine technical choices yourself and log them as rulings.

When you ask: give a short summary, name the decision, give your recommendation and its reason, and wait. One message, all questions at once.

### Write so code reads as code

Assume the human reads the product, not the code. Bare IDs, internal names for variants and lines of commit hashes and branch names got «what?» in reply (Easy One, 2026-11-23). The project's `CLAUDE.md` can loosen these rules for a technical human.

- **Plain sentence first.** Say what changed for the people who use the product, in the human's words. Code tokens come after, each in backticks, never as the subject of a sentence.
- **A story is its title, then its ID:** «Reset a forgotten password (`ACC-002`)». A criterion is its plain meaning, then its ID. Use a short title the human recognises.
- **Translate markers.** `[manual <date>, <who>]` → «you checked it on <date>». `[unbuilt]` → «not built yet». `[test: …]` → «a test covers it».
- **A command the human runs** goes alone in a code block, one per block.
- **A result the human looks at** gets one full link or path each, labelled in plain words.
- **Name a variant by what it does or looks like.** Give its internal name once, next to that description.
- **Leave out of chat:** commit hashes (unless the human must act on them), worktree paths, agent ids, brief and report paths, and quotes from this skill. They stay in the ledger.
- **End with one question or one next step,** in plain words.

Example. Not: «ACC-002: .1–.3 [manual 2026-11-20], .4 [unbuilt].» Instead: «Reset a forgotten password (`ACC-002`): you checked 3 of 4 criteria on 20 Nov. Not built yet: the expired-link message (`ACC-002.4`).»

### The human talks to you only

The human writes everything in your chat. Route each message to the agent or the file it belongs to, and bring the result back. Never ask the human to talk to an agent or to switch sessions (Easy One, 2026-11-09).

## 8. Git

Read `references/git.md`. In short: one branch per story, one worktree per parallel writer, one batched commit per story with files named, push and merge only on the human's request. The guard hook blocks the dangerous commands. A workspace that is a plain folder and not a repository has none of this: the verification commands are then the only evidence, and the close report says so.

## 9. Close

At the end of a block of work:
1. Run `verify.all` from `.orchestrator.json` once for the block, then `node <storiesDir>/stories.mjs --tests`. Builders run only the fast `verify.onBuilderStop`; the full set runs here, or in CI.
2. Settle the helpers: stop each agent with TaskStop as soon as you have read its report, so nothing keeps running. Every agent you launched has reported, and every writer worktree is removed or named in the report. Do not end the turn before that.
3. Write the lessons into the `Lessons` section of `CLAUDE.md`, or into the file of the role that failed. A lesson enters only if a real failure in this project caused it; note that failure in one line next to the rule. One rule, one home: never copy a rule into a second file. Remove a lesson when code now prevents its failure (`references/harness.md`, **Enforced by code**).
4. Rewrite `.orchestrator/state.md` to the current state only, about 50 lines: in progress, open rulings, pending with the human. The history lives in git. A 640-line ledger had piled up (Easy One, 2026-11-19).
5. Tidy, without being asked. First move what must last out of `.orchestrator/work/` (a report that a story or decision cites goes to the project's docs, and the link follows it). Then run `node <this skill's directory>/scripts/tidy.mjs`, read the preview, and run it again with `--run`, adding `--keep <scope>` for work still in progress. It deletes the closed work folders, the local branches merged into the main branch with their clean worktrees, and the caches listed in `.orchestrator.json` → `tidy.caches`. It keeps a folder a tracked file still cites, and a worktree with changes; deal with what it names. Rules alone did not hold: 85 MB of work files, 29 merged branches and nine links into deleted folders piled up (Easy One, 2026-11-19 and 11-20).
6. Give the human the batched review list: one line per item, bad news first. Include the roles you created or retired, your technical rulings, and any UI check that was skipped. Name every branch with commits that are not on the remote, with its count, and every finished story branch that is not merged. Ask once whether to push and merge them; work that lives on one machine only is lost with it.
