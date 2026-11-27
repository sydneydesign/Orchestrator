#!/usr/bin/env node
// orchestrator tidy. Lists, and with --run removes, what a closed block leaves behind:
//   - work folders under .orchestrator/work/ (ignored by git: a deleted folder is gone);
//   - local branches already merged into the main branch, and their clean worktrees;
//   - worktrees an agent left unused (.claude/worktrees/<name> on worktree-<name>, clean, never committed to);
//   - the regenerable caches named in .orchestrator.json → tidy.caches.
// Each worktree's .orchestrator.json → worktree.teardown runs before it is removed.
// A work folder that a tracked file links to is kept and named: move what must last first.
//
//   node tidy.mjs                 preview, changes nothing
//   node tidy.mjs --run           remove
//   node tidy.mjs --keep <scope>  keep a work folder that is still in use (repeatable)
//   node tidy.mjs --summary       one line for the session start; empty when nothing is left

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { reachableElsewhere, teardown, worktreeConfig } from "./worktree.mjs";
import { liveClaims, sharedDir } from "./sessions.mjs";
import { realpathSync } from "node:fs";
const FOLDC = (p) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);

const args = process.argv.slice(2);
const RUN = args.includes("--run");
const SUMMARY = args.includes("--summary");
const keep = new Set(args.flatMap((a, i) => (a === "--keep" && args[i + 1] && !args[i + 1].startsWith("--") ? [args[i + 1]] : [])));

// { code, out }: code 0 ok, 1 "no match" for grep, anything else an error.
const run = (argv, cwd = root) => {
  try { return { code: 0, out: execFileSync("git", argv, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString() }; }
  catch (e) { return { code: typeof e.status === "number" ? e.status : -1, out: "" }; }
};
const git = (argv, cwd = root) => { const r = run(argv, cwd); return r.code === 0 ? r.out : null; };

let root;
try { root = execFileSync("git", ["rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
catch { if (!SUMMARY) console.error("tidy: not inside a git repository."); process.exit(SUMMARY ? 0 : 1); }
// Any session may run tidy, from any worktree: it always tidies from the main checkout, where the work
// folders and the agent worktrees live.
{ const first = /^worktree (.+)$/m.exec(git(["worktree", "list", "--porcelain"]) ?? "")?.[1];
  if (first && existsSync(path.join(first, ".git")) && statSync(path.join(first, ".git")).isDirectory()) root = first; }
// Worktrees another live session holds stay, whatever their state (sessions.mjs).
const claimed = Object.values(liveClaims(root)).map((c) => path.resolve(c.folder));
const isClaimed = (p) => { const r = (() => { try { return realpathSync(p); } catch { return path.resolve(p); } })(); return claimed.some((c) => FOLDC(c) === FOLDC(r)); };

const STATE = existsSync(path.join(root, ".orchestrator.json")) || !existsSync(path.join(root, ".orquestador.json")) ? ".orchestrator" : ".orquestador";
const configPath = path.join(root, `${STATE}.json`);
if (!existsSync(configPath)) { if (!SUMMARY) console.error(`tidy: no ${STATE}.json here.`); process.exit(SUMMARY ? 0 : 1); }
let config = {};
try { config = JSON.parse(readFileSync(configPath, "utf8").replace(/^﻿/, "")); } catch {}

const protectedBranches = config.git?.protectedBranches ?? ["main", "master"];
const mainBranch = protectedBranches.find((b) => git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]) !== null);
const current = (git(["branch", "--show-current"]) ?? "").trim();
// The shared ledger lists every session's work in progress: a folder or branch it names is kept. A tracked
// .orchestrator/state.md from before 0.16.0 counts too.
const statePaths = [sharedDir(root) && path.join(sharedDir(root), "state.md"), path.join(root, STATE, "state.md")].filter((p) => p && existsSync(p));
const stateText = statePaths.map((p) => readFileSync(p, "utf8")).join("\n");
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A whole name, not part of a longer one: explore/a is not named by explore/a-2.
const names = (text, name) => new RegExp(`(^|[^A-Za-z0-9_./-])${esc(name)}($|[^A-Za-z0-9_./-])`, "m").test(text);
if (RUN) git(["worktree", "prune"]);

// ---------- work folders
const workDir = path.join(root, STATE, "work");
const workFolders = existsSync(workDir)
  ? readdirSync(workDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !keep.has(d.name)).map((d) => d.name)
  : [];
// A file in the repository (tracked or new, not ignored) outside the orchestrator's folder that names the
// work folder, with either slash, cites it. A search that fails keeps the folder.
const cited = new Map();
for (const name of workFolders) {
  if (names(stateText, name)) { cited.set(name, ["the shared ledger"]); continue; }
  const r = run(["grep", "--untracked", "-l", "-E", `${esc(STATE)}[/\\\\]work[/\\\\]${esc(name)}([^A-Za-z0-9_.-]|$)`, "--", ".", `:!${STATE}`]);
  if (r.code === 0 && r.out.trim()) cited.set(name, r.out.trim().split(/\r?\n/));
  else if (r.code !== 1) cited.set(name, ["(the search failed)"]);
}
const removableWork = workFolders.filter((n) => !cited.has(n));

// ---------- merged branches and their worktrees
const worktrees = [];
{
  let wt = null;
  for (const line of (git(["worktree", "list", "--porcelain"]) ?? "").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) { wt = { path: line.slice(9), branch: null, locked: false }; worktrees.push(wt); }
    else if (line.startsWith("branch refs/heads/") && wt) wt.branch = line.slice(18);
    else if (line.startsWith("locked") && wt) wt.locked = true;
  }
}
const mainPath = worktrees[0]?.path;
// Branch deletion runs where the main branch is checked out, so `git branch -d` judges against it.
const mainCheckout = worktrees.find((w) => w.branch === mainBranch)?.path;
// A branch counts as merged only if it ever had commits of its own. One that was created and never
// committed to has a single entry in its reflog, wherever main has moved since. Without a reflog it is kept.
const reflogLength = (b) => (git(["reflog", "show", "--format=%H", `refs/heads/${b}`]) ?? "").trim().split(/\r?\n/).filter(Boolean).length;
const hadOwnCommits = (b) => reflogLength(b) > 1;
// -D only for a branch whose commits all live elsewhere: one reflog entry alone can mislead.
const neverCommitted = (b) => reflogLength(b) === 1;
const merged = mainBranch
  ? (git(["branch", "--merged", mainBranch, "--format=%(refname:short)"]) ?? "").split(/\r?\n/).map((s) => s.trim())
      .filter((b) => b && !protectedBranches.includes(b) && b !== current && !keep.has(b) && !names(stateText, b)
        && !worktrees.some((w) => w.path === mainPath && w.branch === b)
        && hadOwnCommits(b))
  : [];
const unknownKeep = [...keep].filter((k) => !existsSync(path.join(workDir, k)) && git(["rev-parse", "--verify", "--quiet", `refs/heads/${k}`]) === null);
const worktreeOf = (b) => worktrees.find((w) => w.branch === b && w.path !== mainPath);
// Why a merged branch must stay, or null. `git worktree remove` also deletes ignored files, so a worktree
// with agents' reports in its own work folder stays. `git branch -d` refuses a branch its upstream lacks.
const hasReports = (w) => { const d = path.join(w.path, STATE, "work"); return existsSync(d) && readdirSync(d).length > 0; };
const reasonToKeep = (b) => {
  const w = worktreeOf(b);
  if (w && isClaimed(w.path)) return `a session works in its worktree ${w.path}`;
  if (w && existsSync(w.path)) {
    if ((git(["status", "--porcelain"], w.path) ?? "x").trim() !== "") return `its worktree ${w.path} has uncommitted changes`;
    if (hasReports(w)) return `its worktree ${w.path} holds reports in ${STATE}/work/`;
  }
  const up = git(["rev-parse", "--verify", "--quiet", `${b}@{upstream}`]);
  if (up && run(["merge-base", "--is-ancestor", b, up.trim()]).code !== 0) return "its upstream does not have all its commits";
  return null;
};
const branches = merged.filter((b) => !reasonToKeep(b));
const busy = merged.filter((b) => reasonToKeep(b));

// ---------- worktrees an agent left unused. Claude Code removes its own; with the project's WorktreeCreate
// hook (.orchestrator.json → worktree) it keeps them, so they end here. Locked ones are Claude Code's.
const agentDir = mainPath ? path.join(mainPath, ".claude", "worktrees") : null;
// An agent that has just started has not edited anything yet: a worktree touched in the last hour may be in use.
const idle = (w) => { try { const g = git(["rev-parse", "--git-dir"], w.path)?.trim(); const times = [statSync(w.path).mtimeMs, ...(g ? [statSync(path.resolve(w.path, g)).mtimeMs] : [])]; return Date.now() - Math.max(...times) > 3600e3; } catch { return false; } };
const unusedCandidates = agentDir ? worktrees.filter((w) => path.dirname(path.resolve(w.path)) === path.resolve(agentDir)
  && w.branch === `worktree-${path.basename(w.path).replace(/\+/g, "/")}` && !w.locked && existsSync(w.path) && path.resolve(w.path) !== path.resolve(root)
  && !keep.has(w.branch) && !keep.has(path.basename(w.path)) && !names(stateText, w.branch) && !names(stateText, path.basename(w.path))
  && neverCommitted(w.branch) && (git(["status", "--porcelain"], w.path) ?? "x").trim() === "" && !hasReports(w) && idle(w) && !isClaimed(w.path)) : [];
// A worktree-<name> branch whose worktree is gone and that never had commits holds nothing.
const strayCandidates = (git(["branch", "--list", "worktree-*", "--format=%(refname:short)"]) ?? "").split(/\r?\n/).map((s) => s.trim())
  .filter((b) => b && !worktrees.some((w) => w.branch === b) && neverCommitted(b) && !keep.has(b) && !names(stateText, b));
// -D only when every commit also lives on a branch or remote that stays: never on one another.
const doomed = [...unusedCandidates.map((w) => w.branch), ...strayCandidates];
const safe = (b) => reachableElsewhere(root, b, doomed.filter((d) => d !== b));
const unusedWorktrees = unusedCandidates.filter((w) => safe(w.branch));
const strayBranches = strayCandidates.filter(safe);

// ---------- caches the project declared regenerable; only ignored paths that hold no tracked file
const caches = [].concat(config.tidy?.caches ?? []).filter((c) => typeof c === "string" && c.trim())
  .filter((c) => existsSync(path.join(root, c)) && git(["check-ignore", "-q", c]) !== null && (git(["ls-files", "--", c]) ?? "x").trim() === "");

if (SUMMARY) {
  const parts = [];
  if (removableWork.length) parts.push(`${removableWork.length} work folder(s)`);
  if (mainCheckout && branches.length) parts.push(`${branches.length} merged branch(es)`);
  if (unusedWorktrees.length) parts.push(`${unusedWorktrees.length} unused agent worktree(s)`);
  if (strayBranches.length) parts.push(`${strayBranches.length} leftover agent branch(es)`);
  if (caches.length) parts.push(`${caches.length} cache folder(s)`);
  if (parts.length) process.stdout.write(`Left from earlier blocks: ${parts.join(", ")}. If no block is in progress, run the tidy step of the close (§9).`);
  process.exit(0);
}

const say = (s) => console.log(s);
say(RUN ? "tidy: removing" : "tidy: preview (nothing changed; add --run to remove)");
say(`\nWork folders (${STATE}/work/):`);
if (!workFolders.length) say("  none");
for (const n of removableWork) say(`  ${n}`);
for (const [n, files] of cited) say(`  KEEP ${n}: cited by ${files.join(", ")}. Move what must last out of work/ and fix the link, then run again.`);
if (keep.size) say(`  kept on request: ${[...keep].join(", ")}`);
for (const k of unknownKeep) say(`  WARNING: --keep ${k} matches no work folder or branch.`);
say(`\nBranches merged into ${mainBranch ?? "(no main branch found)"}:`);
if (!merged.length) say("  none");
for (const b of branches) say(`  ${b}${worktreeOf(b) ? `  (and its worktree ${worktreeOf(b).path})` : ""}`);
for (const b of busy) say(`  KEEP ${b}: ${reasonToKeep(b)}.`);
if (merged.length && !mainCheckout) say(`  Not removed: ${mainBranch} is not checked out in any worktree here, so git cannot judge them safely.`);
say("\nUnused agent worktrees (.claude/worktrees/, never committed to):");
if (!unusedWorktrees.length && !strayBranches.length) say("  none");
for (const w of unusedWorktrees) say(`  ${w.path}  (and ${w.branch})`);
for (const b of strayBranches) say(`  ${b}  (branch only)`);
say("\nCaches (.orchestrator.json → tidy.caches):");
if (!caches.length) say("  none");
for (const c of caches) say(`  ${c}`);

if (!RUN) process.exit(0);

const failed = [];
// The project's teardown first (a cache the dev server holds, a design tool's list); a failure keeps the worktree.
// Checked before teardown: a worktree git would then refuse to remove must keep its setup.
const removeTree = (w) => {
  if (w.locked) { failed.push(`worktree ${w.path} (locked)`); return false; }
  // Only a checked-out submodule stops git; one not initialised (a line starting with -) does not.
  if ((git(["-C", w.path, "submodule", "status"]) ?? "").split(/\r?\n/).some((l) => l.trim() && !l.startsWith("-"))) { failed.push(`worktree ${w.path} (has submodules; git will not remove it)`); return false; }
  const dirty = git(["-C", w.path, "status", "--porcelain"]);
  if (dirty === null || dirty.trim()) { failed.push(`worktree ${w.path} (has changes)`); return false; }
  try { teardown(w.path, mainPath, worktreeConfig(w.path, mainPath)); }
  catch (e) { failed.push(`worktree ${w.path} (teardown: ${e.message})`); return false; }
  if (git(["worktree", "remove", w.path]) === null) { failed.push(`worktree ${w.path}`); return false; }
  return true;
};
for (const n of removableWork) rmSync(path.join(workDir, n), { recursive: true, force: true });
for (const b of mainCheckout ? branches : []) {
  const w = worktreeOf(b);
  if (w && existsSync(w.path) && !removeTree(w)) continue;
  if (git(["branch", "-d", b], mainCheckout) === null) failed.push(`branch ${b}`);
}
// Never committed to: -D loses nothing, and -d would judge against whatever is checked out.
for (const w of unusedWorktrees) if (removeTree(w) && git(["branch", "-D", w.branch]) === null) failed.push(`branch ${w.branch}`);
for (const b of strayBranches) if (git(["branch", "-D", b]) === null) failed.push(`branch ${b}`);
for (const c of caches) rmSync(path.join(root, c), { recursive: true, force: true });
say(failed.length ? `\nNot removed: ${failed.join(", ")}. Look at each one; never force it.` : "\nDone.");
process.exit(failed.length ? 1 : 0);
