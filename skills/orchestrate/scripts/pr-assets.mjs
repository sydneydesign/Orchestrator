#!/usr/bin/env node
// orchestrator pr-assets. Puts a pull request's screenshots on the `pr-assets` branch and prints the
// Markdown that shows them. The branch has no history in common with the main branch and is never merged,
// so screenshots never enter the main branch. Your checkout, its index and its branch stay as they are.
//
//   node pr-assets.mjs <scope> <image>...   commit the images as pr-assets:<scope>/<file name>
//     --remote <name>                       the remote that hosts the pull request (default origin)
//
// It commits locally and never pushes. Push the branch after it: git push <remote> pr-assets.
// The links name the commit, not the branch, so a picture replaced later never changes an older PR.
// They render for every viewer who can read the repository, private ones included.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BRANCH = "pr-assets";
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const args = process.argv.slice(2);
const remoteAt = args.indexOf("--remote");
const REMOTE = remoteAt >= 0 ? args[remoteAt + 1] : "origin";
const positional = args.filter((a, i) => !a.startsWith("--") && (remoteAt < 0 || i !== remoteAt + 1));

const usage = (code) => {
  const lines = readFileSync(new URL(import.meta.url), "utf8").split(/\r?\n/).slice(1);
  process.stdout.write(lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
  process.exit(code);
};
if (args.includes("--help") || args.includes("-h")) usage(0);
if (positional.length < 2) usage(2);
const [SCOPE, ...files] = positional;
const fail = (m) => { console.error(`pr-assets: ${m}`); process.exit(1); };
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(SCOPE)) fail(`"${SCOPE}" is not a scope: use the story ID or the block's slug.`);
for (const f of files) {
  if (!existsSync(f)) fail(`${f} does not exist.`);
  if (!IMAGE.test(f)) fail(`${f} is not a PNG, JPEG, GIF or WebP image.`);
}
const twice = files.map((f) => path.basename(f)).find((b, i, all) => all.indexOf(b) !== i);
if (twice) fail(`two files are named ${twice}: the second would replace the first. Rename one.`);

const git = (argv, env) => execFileSync("git", argv, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...env } }).toString().trim();
const tryGit = (argv) => { try { return git(argv); } catch { return null; } };
if (tryGit(["rev-parse", "--show-toplevel"]) === null) fail("not inside a git repository.");

// ---------- where the links point
// The URL as configured: an insteadOf rewrite changes how git connects, not where the repository lives.
const remoteUrl = tryGit(["config", "--get", `remote.${REMOTE}.url`]) ?? fail(`no remote named ${REMOTE}.`);
const m = remoteUrl.match(/^(?:[\w+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[/:](.+?)(?:\.git)?\/?$/);
if (!m) fail(`cannot read the host and repository from ${remoteUrl}.`);
const [, host, slug] = m;
// An SSH alias (git@work:owner/repo) names an entry in ~/.ssh/config, not the web host the links need.
if (!host.includes(".")) fail(`the host "${host}" in ${remoteUrl} looks like an SSH alias, not the web address of the repository. Pass --remote with a remote whose URL names the real host (github.com or your server).`);

// ---------- the parent commit: the remote's branch, unless the local one is ahead of it
if (tryGit(["ls-remote", "--exit-code", "--heads", REMOTE, BRANCH]) !== null) {
  git(["fetch", "--quiet", REMOTE, `+refs/heads/${BRANCH}:refs/remotes/${REMOTE}/${BRANCH}`]);
}
const local = tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`]);
const remote = tryGit(["rev-parse", "--verify", "--quiet", `refs/remotes/${REMOTE}/${BRANCH}`]);
const isAncestor = (a, b) => tryGit(["merge-base", "--is-ancestor", a, b]) !== null;
let parent = local ?? remote;
if (local && remote && local !== remote) {
  if (isAncestor(local, remote)) parent = remote;
  else if (!isAncestor(remote, local)) fail(`the local ${BRANCH} and ${REMOTE}/${BRANCH} have diverged. Merge ${REMOTE}/${BRANCH} into it first.`);
}
if (parent && tryGit(["merge-base", parent, "HEAD"])) fail(`${BRANCH} shares history with your branch. It must be an orphan branch that is never merged.`);

// ---------- the new tree, built in a throw-away index
const tmp = mkdtempSync(path.join(os.tmpdir(), "pr-assets-"));
const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
let commit;
try {
  git(parent ? ["read-tree", parent] : ["read-tree", "--empty"], env);
  for (const f of files) {
    const blob = git(["hash-object", "-w", "--no-filters", "--", f]);
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},${SCOPE}/${path.basename(f)}`], env);
  }
  const tree = git(["write-tree"], env);
  if (parent && tree === git(["rev-parse", `${parent}^{tree}`])) commit = parent;
  else commit = git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `${SCOPE}: screenshots for the pull request`]);
} finally { rmSync(tmp, { recursive: true, force: true }); }

// Moves the branch only from the value read above: a concurrent run fails instead of losing a commit.
if (commit !== local) git(["update-ref", `refs/heads/${BRANCH}`, commit, local ?? "0".repeat(commit.length)]);

const url = (f) => `https://${host}/${slug}/blob/${commit}/${encodeURIComponent(SCOPE)}/${encodeURIComponent(path.basename(f))}?raw=true`;
const lines = files.map((f) => `![${path.basename(f).replace(/\.[^.]+$/, "")}](${url(f)})`);
const pushed = remote === commit;
lines.push("", pushed ? `${BRANCH} is already on ${REMOTE}.` : `Push before you open the PR, or the pictures do not show: git push ${REMOTE} ${BRANCH}`);
process.stdout.write(lines.join("\n") + "\n");
