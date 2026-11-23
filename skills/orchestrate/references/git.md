# Git and GitHub

## Local rules

- One branch per story: `story/<ID>-<slug>`. In the live profile (`references/harness.md`), the block's stories share one branch, `block/<slug>`, with one commit per story. Non-story work: `chore/<slug>` or `fix/<slug>`.
- Batch commits: one commit per story, or one per coherent block. Not one per edit.
- Commit message: `<ID>: <story title>` on the first line, then the criteria that changed status.
- While a writer works in your checkout, commit with `git commit -- <paths>`. The index holds what the writer staged, and a commit after `git add <names>` takes it too: one took a builder's `git rm`, and that commit did not build on its own (gg-ez, 2026-11-18).

## Push and remote

- Push only when the human asks. When the human says "commit and push", do both: a commit alone is half the request.
- Role agents never push; the guard blocks it. When the human asks, run the push yourself. With `git.allowPush: false` the guard makes Claude Code ask the human to confirm each push and each `gh pr merge`; that prompt is their consent, so run the command and let them approve it. Do not hand the command back to the human.

## Pull requests

- One PR per story, or one per block in the live profile.
- Title: plain words a person understands without the story, for example "Members can reset their password". No story IDs in the title.
- Body: what changed and what the reviewer must know, first and short. Then the output of `node <storiesDir>/stories.mjs --pr <ID>` for each story, the review summary and any ⚠️ manual steps.
- When something visible changes, add before and after screenshots.
- Create with `gh pr create` only after the human approves the push.
- Merge only on the human's OK. If the project names a code owner (`git.codeOwner`), the PR goes to them for review.

## Optional: shared repositories

Use these only when several people work in the repository. The human applies them, because they change a shared repository.

Before you propose any change to the repository's settings (these, the description, the topics), run `gh api repos/<owner>/<repo> -q .permissions`. Most settings need `admin`. A human with only `push` cannot apply them, so ask the owner instead.

- Branch protection on the default branch: PR required, status checks required.
- Required checks: the project's verification commands plus `node <storiesDir>/stories.mjs --tests --check`.
- `CODEOWNERS`: the acceptance-test paths and the stories folder go to the product owner or the named code owner.

### Reserving story IDs across machines

When several people or machines create stories, reserve the ID by pushing an empty branch `story/<ID>-<slug>` as soon as the story file exists. Check free IDs against the default branch, remote branches and open PRs. Only a pushed branch reserves an ID.
