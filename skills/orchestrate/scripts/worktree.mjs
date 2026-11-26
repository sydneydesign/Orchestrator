#!/usr/bin/env node
/**
 * Prepares and removes the project's worktrees, so an isolated agent starts with what it needs and a removed
 * worktree leaves nothing behind. The commands are the project's: .orchestrator.json → worktree.
 *
 *   "worktree": { "setup": ["npm ci"], "teardown": ["..."], "copy": [".env", "node_modules/.cache/x/"] }
 *
 * setup and teardown run in the worktree's folder, in order, through the system shell; their output goes to
 * stderr. copy and .worktreeinclude use .gitignore syntax and copy only ignored files from the main checkout,
 * never over a file that exists.
 *
 *   node worktree.mjs create           WorktreeCreate hook. Reads { cwd, name } on stdin, prints the path.
 *   node worktree.mjs remove           WorktreeRemove hook. Reads { cwd, worktree_path } on stdin.
 *   node worktree.mjs setup <path>     copy and setup in a worktree another tool made (Orca)
 *   node worktree.mjs teardown <path>  teardown only, before another tool removes the worktree
 *
 * create follows Claude Code's naming: <main checkout>/.claude/worktrees/<name>, branch worktree-<name>. Its base
 * is worktree.baseRef: "head", the default here, is the caller's HEAD; "fresh" is origin's default branch. A
 * failing setup removes what create made. remove deletes a branch only when every commit on it lives on another
 * branch or a remote-tracking ref.
 *
 * The install copies this file to .orchestrator/worktree.mjs and registers create and remove in the project's
 * .claude/settings.json, only when .orchestrator.json has a worktree key.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { constants, cpSync, existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const stripBom = (s) => s.replace(/^﻿/, "");
const log = (s) => process.stderr.write(`orchestrator worktree: ${s}\n`);

export class WorktreeError extends Error {}

export function git(dir, args, options = {}) {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  } catch (e) {
    throw new WorktreeError(`git ${args.join(" ")} failed: ${(e.stderr || e.message || "").toString().trim()}`);
  }
}
const tryGit = (dir, args, options) => { try { return git(dir, args, options); } catch { return null; } };
const same = (a, b) => {
  const norm = (p) => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };
  const x = norm(a), y = norm(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/** The worktrees of the repository that holds dir; the first is the main checkout. */
export function listWorktrees(dir) {
  const list = [];
  let wt = null;
  for (const line of git(dir, ["worktree", "list", "--porcelain"]).split(/\r?\n/)) {
    if (line.startsWith("worktree ")) { wt = { path: path.resolve(line.slice(9)), branch: null, locked: false }; list.push(wt); }
    else if (line.startsWith("branch refs/heads/") && wt) wt.branch = line.slice(18);
    else if (line.startsWith("locked") && wt) wt.locked = true;
  }
  return list;
}

/** .orchestrator.json of a checkout, or null. */
export function readConfig(dir) {
  for (const name of [".orchestrator.json", ".orquestador.json"]) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    try { return JSON.parse(stripBom(readFileSync(file, "utf8"))); }
    catch (e) { throw new WorktreeError(`${file} is not valid JSON (${e.message})`); }
  }
  return null;
}

/** The worktree key that applies to a worktree: its own .orchestrator.json, else the main checkout's. */
// Always the main checkout's: a branch's own .orchestrator.json is content a builder can commit, and these
// commands run through the shell, outside the guard.
export function worktreeConfig(worktree, main) {
  return readConfig(main)?.worktree ?? {};
}

const strings = (v) => [].concat(v ?? []).filter((s) => typeof s === "string" && s.trim());

/** Runs commands in order in dir through the system shell, output to stderr. Throws on the first failure. */
export function runCommands(commands, dir, env = {}) {
  for (const command of strings(commands)) {
    log(`${path.basename(dir)}: ${command}`);
    const r = spawnSync(command, { cwd: dir, shell: true, stdio: ["ignore", 2, 2], env: { ...process.env, ...env } });
    if (r.error) throw new WorktreeError(`"${command}" did not start: ${r.error.message}`);
    if (r.status !== 0) throw new WorktreeError(`"${command}" failed in ${dir} (${r.signal ? `signal ${r.signal}` : `exit ${r.status}`})`);
  }
}

/** Ignored files and folders of main that match copy or .worktreeinclude. Folders end in "/". */
export function filesToCopy(main, copy) {
  const include = path.join(main, ".worktreeinclude");
  const patterns = [...strings(copy), ...(existsSync(include) ? stripBom(readFileSync(include, "utf8")).split(/\r?\n/) : [])]
    .map((p) => p.trim()).filter((p) => p && !p.startsWith("#"));
  if (!patterns.length) return [];
  const listed = git(main, ["ls-files", "-z", "--others", "--ignored", "--directory", ...patterns.map((p) => `--exclude=${p}`)], { maxBuffer: 256 << 20 })
    .split("\0").filter(Boolean)
    .filter((p) => !/^\.claude\/worktrees(\/|$)/.test(p));
  if (!listed.length) return [];
  // --directory also lists untracked folders that only contain a match: keep what the project ignores.
  const r = spawnSync("git", ["-C", main, "check-ignore", "-z", "--stdin"], { input: listed.join("\0") + "\0", encoding: "utf8", maxBuffer: 256 << 20 });
  if (r.status !== 0 && r.status !== 1) throw new WorktreeError(`git check-ignore failed: ${r.stderr}`);
  const ignored = new Set(r.stdout.split("\0").filter(Boolean));
  const kept = listed.filter((p) => ignored.has(p));
  return kept.filter((p) => !kept.some((q) => q !== p && q.endsWith("/") && p.startsWith(q)));
}

/** Copies the ignored files the project asked for, then runs setup. */
export function setup(worktree, main, config = worktreeConfig(worktree, main)) {
  const copied = filesToCopy(main, config.copy);
  for (const rel of copied) {
    cpSync(path.join(main, rel), path.join(worktree, rel), { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  }
  if (copied.length) log(`copied ${copied.length} ignored path(s) from the main checkout: ${copied.slice(0, 5).join(", ")}${copied.length > 5 ? ", ..." : ""}`);
  runCommands(config.setup, worktree, envFor(worktree, main));
}

export function teardown(worktree, main, config = worktreeConfig(worktree, main)) {
  runCommands(config.teardown, worktree, envFor(worktree, main));
}

const envFor = (worktree, main) => ({
  ORCHESTRATOR_WORKTREE: worktree, ORCHESTRATOR_WORKTREE_NAME: path.basename(worktree), ORCHESTRATOR_MAIN_CHECKOUT: main,
});

// Whether every commit on a branch also lives on another branch or a remote-tracking ref: then -D loses
// nothing. A reflog can mislead (expired, or a branch made with git branch <sha>); reachability cannot.
// exclude: other branches about to be deleted too, which cannot count as a copy.
export function reachableElsewhere(dir, branch, exclude = []) {
  const tip = tryGit(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`])?.trim();
  if (!tip) return false;
  const refs = (tryGit(dir, ["for-each-ref", "--contains", tip, "--format=%(refname)", "refs/heads", "refs/remotes"]) ?? "").split(/\r?\n/).map((s) => s.trim());
  const gone = new Set([branch, ...exclude].map((b) => `refs/heads/${b}`));
  // Its own remote copy does not count: a pushed, unmerged branch stays local too.
  const own = new RegExp(`^refs/remotes/[^/]+/${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  return refs.some((r) => r && !gone.has(r) && !own.test(r) && !/\/HEAD$/.test(r));
}

export function mainBranch(dir, config) {
  const candidates = config?.git?.protectedBranches ?? ["main", "master"];
  return candidates.find((b) => tryGit(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]) !== null) ?? null;
}

/** Claude Code's worktree.baseRef: local settings over project settings over user settings. */
export function baseRefSetting(root) {
  const userDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
  // Claude Code's default is "fresh" (origin's default branch). Here the default is "head": a builder needs the
  // orchestrator's unpushed stories and locks, as launch.mjs requires. An explicit setting still wins.
  let value = "head";
  for (const file of [path.join(userDir, "settings.json"), path.join(root, ".claude", "settings.json"), path.join(root, ".claude", "settings.local.json")]) {
    try { const v = JSON.parse(stripBom(readFileSync(file, "utf8")))?.worktree?.baseRef; if (v === "fresh" || v === "head") value = v; } catch {}
  }
  return value;
}

/** The commit a new worktree starts from. "fresh": origin's default branch, fetched at most daily, else HEAD. */
export function baseCommit(cwd, baseRef) {
  if (baseRef === "fresh") {
    const ref = tryGit(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])?.trim();
    if (ref) {
      const fetchHead = path.join(path.resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]).trim()), "FETCH_HEAD");
      const stale = !existsSync(fetchHead) || Date.now() - statSync(fetchHead).mtimeMs > 24 * 3600e3;
      if (stale) tryGit(cwd, ["fetch", "--quiet", "origin", ref.replace("refs/remotes/origin/", "")], { timeout: 5000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      const sha = tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])?.trim();
      if (sha) return sha;
    }
  }
  return git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
}

/** WorktreeCreate: makes the worktree, copies, runs setup, returns its path. */
export function create({ cwd, name }) {
  // + is how a / in the name is written in the folder name, so it cannot be part of a name.
  if (typeof name !== "string" || !name || name.includes("..") || name.includes("+") || /^[\\/]|^[A-Za-z]:|\\/.test(name)) throw new WorktreeError(`"${name}" is not a worktree name`);
  const caller = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const main = listWorktrees(cwd)[0].path;
  const branch = `worktree-${name}`;
  if (tryGit(cwd, ["check-ref-format", "--branch", branch]) === null) throw new WorktreeError(`"${branch}" is not a valid branch name`);
  const dir = path.join(main, ".claude", "worktrees", name.replace(/\//g, "+"));

  // The same name opens the same worktree, as Claude Code does.
  if (existsSync(dir)) {
    if (listWorktrees(main).some((w) => same(w.path, dir))) { log(`reusing ${dir}`); return dir; }
    throw new WorktreeError(`${dir} exists and is not a worktree of this repository: pick another name or remove it`);
  }
  const branchExists = tryGit(main, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) !== null;
  if (branchExists) git(main, ["worktree", "add", dir, branch]);
  // --no-track: a branch tracking origin's default branch would look unmerged to tidy.
  else git(main, ["worktree", "add", "--no-track", "-b", branch, dir, baseCommit(caller, baseRefSetting(caller))]);
  try {
    setup(dir, main);
  } catch (e) {
    tryGit(main, ["worktree", "remove", "--force", dir]);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    tryGit(main, ["worktree", "prune"]);
    if (!branchExists) tryGit(main, ["branch", "-D", branch]);
    throw new WorktreeError(`setup failed, so the worktree was removed: ${e.message}`);
  }
  return dir;
}

/**
 * Removes a worktree after its teardown. Deletes its branch, and the worktree-<name> branch it started on,
 * only when the branch has no commits of its own or is merged into the main branch. Returns the kept branches.
 */
export function removeWorktree(worktreePath, { teardownFirst = true, discard = false } = {}) {
  const dir = path.resolve(worktreePath);
  const where = existsSync(dir) ? dir : process.cwd();
  const list = listWorktrees(where);
  const main = list[0].path;
  const entry = list.find((w) => same(w.path, dir));
  if (!entry) {
    if (existsSync(dir)) throw new WorktreeError(`${dir} is not a worktree of this repository: nothing removed`);
    git(main, ["worktree", "prune"]);
    return [];
  }
  if (entry === list[0]) throw new WorktreeError(`${dir} is the main checkout: never removed`);
  const config = readConfig(main);
  // Uncommitted work is never removed silently: the removal fails and says so.
  if (!discard && existsSync(dir) && (tryGit(dir, ["status", "--porcelain"]) ?? "x").trim()) throw new WorktreeError(`${dir} has uncommitted changes: commit them or keep the worktree. Nothing removed`);
  if (teardownFirst && existsSync(dir)) teardown(dir, main);
  git(main, ["worktree", "remove", "--force", dir]);
  // Windows can leave a folder behind that git no longer lists.
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  git(main, ["worktree", "prune"]);

  const protectedBranches = config?.git?.protectedBranches ?? ["main", "master"];
  const target = mainBranch(main, config);
  const startBranch = `worktree-${path.basename(dir).replace(/\+/g, "/")}`;
  const busy = new Set(listWorktrees(main).map((w) => w.branch).filter(Boolean));
  const kept = [];
  const candidates = [...new Set([entry.branch, startBranch].filter(Boolean))];
  for (const b of candidates) {
    if (protectedBranches.includes(b) || busy.has(b)) continue;
    if (tryGit(main, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]) === null) continue;
    if (reachableElsewhere(main, b, candidates.filter((c) => c !== b))) git(main, ["branch", "-D", b]);
    else kept.push(b);
  }
  for (const b of kept) log(`kept branch ${b}: it has commits that are not in ${target ?? "the main branch"}`);
  return kept;
}

async function readStdin() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  try { return JSON.parse(stripBom(s)); } catch { throw new WorktreeError("expected the hook's JSON on stdin"); }
}

async function main() {
  const [command, target] = process.argv.slice(2);
  try {
    if (command === "create") {
      const input = await readStdin();
      // stdout carries only the path: Claude Code reads its last line.
      process.stdout.write(`${create({ cwd: input.cwd || process.cwd(), name: input.name })}\n`);
    } else if (command === "remove") {
      const input = await readStdin();
      if (!input.worktree_path) throw new WorktreeError("no worktree_path on stdin");
      removeWorktree(input.worktree_path);
    } else if (command === "setup" || command === "teardown") {
      if (!target || !existsSync(target)) throw new WorktreeError(`${command} needs the path of an existing worktree`);
      const dir = path.resolve(target);
      const list = listWorktrees(dir);
      if (!list.some((w) => same(w.path, dir)) || same(list[0].path, dir)) throw new WorktreeError(`${dir} is not a linked worktree of this repository`);
      (command === "setup" ? setup : teardown)(dir, list[0].path);
    } else {
      throw new WorktreeError("usage: worktree.mjs create | remove | setup <path> | teardown <path>");
    }
  } catch (e) {
    log(e instanceof WorktreeError ? e.message : e.stack);
    process.exit(1);
  }
}

// Through a symlinked project folder, argv keeps the link while import.meta.url has the real path.
const realArg = (() => { try { return realpathSync(path.resolve(process.argv[1] ?? "")); } catch { return null; } })();
if (realArg && realpathSync(fileURLToPath(import.meta.url)) === realArg) main();
