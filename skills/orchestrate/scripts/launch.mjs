#!/usr/bin/env node
/**
 * Runs one builder in its own Orca terminal, in its own Orca worktree, so the human can watch it.
 * Orca is only the place the builder runs: the plugin picks the role, writes the brief and the guard
 * holds it (references/orca.md). Used only when .orchestrator.json → orca.builders is "terminal" and
 * this session runs inside Orca; otherwise the builder is a subagent.
 *
 *   1. check that Orca still has the commands this script uses (an update fails here, not halfway);
 *   2. refuse while the stories have uncommitted changes, and a second builder for the same story;
 *   3. find the Orca worktree on the story's branch, or create it from --base and run the project's
 *      .orchestrator.json → worktree copy and setup there (worktree.mjs);
 *   4. open a terminal there running `claude --agent orchestrator:builder --permission-mode <mode>`;
 *   5. wait for Claude, and stop on any prompt (folder trust, MCP, bypass warning): those are the human's;
 *   6. hand it the brief with `orca orchestration worker-start --terminal`, so Orca wakes you when it reports.
 *
 * Usage, from the project root:
 *   node <skill dir>/scripts/launch.mjs --story <ID> --branch <story branch> --brief <brief.md>
 *     --mode <your own permission mode> [--base <ref>] [--run <run id>] [--terminal <handle>] [--dry-run]
 *
 * --base is where a new worktree starts (default: the main checkout's branch).
 * --terminal resumes a launch that stopped at a prompt, after the human answered it.
 * Prints one JSON line: { title, handle, dispatchId, runId, worktree }.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setup } from "./worktree.mjs";

export const PERMISSION_MODES = ["default", "acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"];
// What this script calls, and the help text that shows each still exists. Checked on every launch.
export const NEEDS = [
  [["worktree", "list"], []],
  [["worktree", "create"], ["--repo", "--name", "--branch", "--base-branch", "--no-parent"]],
  [["terminal", "list"], ["--worktree"]],
  [["terminal", "create"], ["--worktree", "--title", "--command"]],
  [["terminal", "wait"], ["--terminal", "--for", "tui-idle", "--timeout-ms"]],
  [["terminal", "close"], ["--terminal"]],
  [["orchestration", "worker-start"], ["--terminal", "--spec-file", "--task-title", "--run"]],
];
const SHELL_TITLE = /^(Terminal \d+|.*\b(powershell|pwsh|cmd)(\.exe)?|bash|zsh|sh|fish)$/i;
const stripBom = (s) => s.replace(/^﻿/, "");

export function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
  }
  return args;
}

/** What is wrong with the arguments and the project, or null. Pure. */
export function argsProblem(a, config, protectedBranches = config?.git?.protectedBranches ?? ["main", "master"]) {
  if (config?.orca?.builders !== "terminal") return `.orchestrator.json → orca.builders is not "terminal": delegate the builder as a subagent`;
  if (!a.story || !a.branch || !a.brief || !a.mode) return "needs --story, --branch, --brief and --mode";
  if (!/^[\w.-]+$/.test(a.story)) return `story "${a.story}" must be a story ID (letters, digits, . _ -)`;
  if (protectedBranches.includes(a.branch)) return `${a.branch} is protected: a builder works on its story's branch`;
  if (!PERMISSION_MODES.includes(a.mode)) return `"${a.mode}" is not a permission mode (${PERMISSION_MODES.join(", ")})`;
  return null;
}

/** The paths in `git status --porcelain` output. Pure. */
export const porcelainPaths = (out) => out.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).split(" -> ").pop().replace(/^"|"$/g, ""));

const fail = (message) => { console.error(`orchestrator launch: ${message}`); process.exit(1); };

function orcaRaw(args) {
  try { return execFileSync("orca", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { return `${e.stdout ?? ""}${e.stderr ?? ""}`; }
}

// Orca prints JSON on success and on failure; a failure also exits non-zero.
function orca(args) {
  const out = orcaRaw([...args, "--environment", "local", "--json"]);
  let data;
  try { data = JSON.parse(out); } catch { fail(`orca ${args.slice(0, 2).join(" ")} printed no JSON: ${out.slice(0, 300)}`); }
  if (!data.ok) fail(`orca ${args.slice(0, 2).join(" ")}: ${JSON.stringify(data.error ?? data)}`);
  return data.result;
}

const git = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function main() {
  const a = parseArgs(process.argv.slice(2));
  const root = resolve(process.cwd());
  const configFile = join(root, ".orchestrator.json");
  if (!existsSync(configFile)) fail(`${root} has no .orchestrator.json: run it from the project root`);
  let config;
  try { config = JSON.parse(stripBom(readFileSync(configFile, "utf8"))); } catch (e) { fail(`.orchestrator.json is not valid JSON (${e.message})`); }
  const problem = argsProblem(a, config);
  if (problem) fail(problem);
  // Orca wakes the coordinator in its own terminal: outside Orca, the builder's report would reach no one.
  if (!process.env.ORCA_TERMINAL_HANDLE) fail("this session does not run inside Orca, so Orca could not wake you when the builder reports. Delegate the builder as a subagent.");
  const brief = resolve(a.brief);
  if (!existsSync(brief)) fail(`brief not found: ${brief}`);

  const version = orcaRaw(["--version"]).trim();
  if (!/^\d+\.\d+/.test(version)) fail(`orca does not run here (${version.slice(0, 200)}). Delegate the builder as a subagent and tell the human.`);
  for (const [cmd, flags] of NEEDS) {
    const help = orcaRaw([...cmd, "--help"]);
    const missing = !help.includes(`orca ${cmd.join(" ")}`) ? "" : flags.find((f) => !help.includes(f));
    if (missing !== undefined) fail(`Orca ${version} has no \`orca ${cmd.join(" ")}${missing ? ` ${missing}` : ""}\`: an update changed it. Delegate the builder as a subagent and tell the human; references/orca.md lists what this script relies on.`);
  }

  // A builder can undo a story fix it does not see committed. .orchestrator.json must be committed too:
  // the new worktree gets only what git has, and without it the guard does not hold the builder.
  const lockList = join(".orchestrator", "locked-tests.txt");
  const lockedPaths = existsSync(join(root, lockList))
    ? stripBom(readFileSync(join(root, lockList), "utf8")).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : [];
  const paths = [".orchestrator.json", lockList, ...lockedPaths, ...(config.storiesDir ? [join(config.storiesDir, "stories")] : [])];
  const dirty = porcelainPaths(git(root, ["-c", "core.quotepath=off", "status", "--porcelain", "--untracked-files=all", "--", ...paths]));
  if (dirty.length) fail(`uncommitted changes in ${dirty.join(", ")}. Commit them before you launch the builder.`);

  // The new worktree starts from base: it must carry the same stories, config and locks as this checkout.
  const head = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (!a.base && head === "HEAD") fail("the main checkout has a detached HEAD: switch it to the block's branch, or pass --base <ref>");
  const base = a.base ?? head;
  try { git(root, ["diff", "--quiet", base, "HEAD", "--", ...paths]); }
  catch { fail(`${base} differs from your checkout in ${paths.join(", ")}: the builder would start without those changes. Pass the branch that has them as --base.`); }

  // Orca lists the worktrees of every project: keep this repository's only.
  const commonDir = (dir) => { try { return resolve(dir, git(dir, ["rev-parse", "--git-common-dir"]).trim()); } catch { return null; } };
  const mine = commonDir(root);
  const onBranch = () => (orca(["worktree", "list"]).worktrees ?? [])
    .find((w) => (w.branch === a.branch || w.branch === `refs/heads/${a.branch}`) && existsSync(w.path) && commonDir(w.path) === mine);
  const title = `builder-${a.story}`;
  let wt = onBranch();
  if (a.dryRun) {
    console.log(JSON.stringify({ dryRun: true, title, orca: version, worktree: wt?.path ?? `new, on ${a.branch} from ${base}`, command: `claude --agent orchestrator:builder --permission-mode ${a.mode}`, brief }));
    return;
  }

  let created = false;
  if (!wt) {
    // Orca gives a taken branch name a numeric suffix: the builder would work on another branch.
    let exists = true;
    try { git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${a.branch}`]); } catch { exists = false; }
    if (exists) fail(`${a.branch} exists but no Orca worktree has it: Orca would create ${a.branch}-2. Remove or rename the branch, or open it in Orca, then rerun.`);
    // Without --repo, Orca takes the repository of the terminal this runs in, which may be another project.
    orca(["worktree", "create", "--repo", `path:${dirname(mine)}`, "--name", a.story, "--branch", a.branch, "--base-branch", base, "--no-parent"]);
    wt = onBranch();
    if (!wt) fail(`Orca created the worktree but lists none on ${a.branch}: check \`orca worktree list\` and Orca's branch prefix`);
    created = true;
  }
  if (!existsSync(join(wt.path, ".orchestrator.json"))) fail(`${wt.path} has no .orchestrator.json: the guard would not hold the builder there`);
  // Dependencies before the builder's first command; output goes to stderr, stdout keeps the one JSON line.
  if (created) {
    try { setup(wt.path, dirname(mine)); }
    catch (e) { fail(`the worktree setup failed in ${wt.path}: ${e.message}. Fix it, run \`node <skill dir>/scripts/worktree.mjs setup "${wt.path}"\`, then rerun this command.`); }
  }
  // A branch: selector could match another project's worktree; the id names this one.
  const selector = `id:${wt.id}`;

  const open = orca(["terminal", "list", "--worktree", selector]).terminals ?? [];
  const twin = open.find((t) => t.handle !== a.terminal && t.title === title);
  if (twin) fail(`${title} is already open (${twin.handle}): send it a message with orca orchestration send instead`);

  const handle = a.terminal ?? orca(["terminal", "create", "--worktree", selector, "--title", title,
    "--command", `claude --agent orchestrator:builder --permission-mode ${a.mode}`]).terminal.handle;
  // The plain shell Orca opens in a new worktree only adds a tab. Orca may open it late: list again.
  if (created && !a.terminal) {
    for (const t of orca(["terminal", "list", "--worktree", selector]).terminals ?? []) {
      if (t.handle !== handle && SHELL_TITLE.test(t.title ?? "")) orca(["terminal", "close", "--terminal", t.handle]);
    }
  }

  const { wait } = orca(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "60000"]);
  if (!wait?.satisfied || wait.blockedReason) {
    fail(`${title} (${handle}) is not ready: ${wait?.blockedReason ?? "timeout"}. Read it with \`orca terminal read --terminal ${handle}\`; a prompt there is the human's to answer, never yours. When they have, rerun this command with --terminal ${handle}.`);
  }

  const start = ["orchestration", "worker-start", "--terminal", handle, "--spec-file", brief, "--task-title", title];
  if (a.run) start.push("--run", a.run);
  const r = orca(start);
  console.log(JSON.stringify({ title, handle, dispatchId: r.dispatchId, runId: r.runId, worktree: wt.path }));
}

// Through a symlinked project folder, argv keeps the link while import.meta.url has the real path.
const realArg = (() => { try { return realpathSync(resolve(process.argv[1] ?? "")); } catch { return null; } })();
if (realArg && realpathSync(fileURLToPath(import.meta.url)) === realArg) main();
