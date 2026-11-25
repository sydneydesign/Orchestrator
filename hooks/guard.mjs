#!/usr/bin/env node
// orchestrator guard. Claude Code hook for SessionStart, PreToolUse, PostToolUse, PostToolUseFailure,
// SubagentStop and Stop.
// Inert unless the repository has .orchestrator.json at its root.
// Exit 0 = allow. Exit 2 = block; stderr goes back to Claude. Exit 0 with permissionDecision "ask" on
// stdout = Claude Code asks the human to confirm.

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WIN = process.platform === "win32";
// Windows and a default macOS volume (APFS) ignore case: Tests/a.test.js and tests/a.test.js are one file.
const FOLD = WIN || process.platform === "darwin";
const stripBom = (s) => s.replace(/^﻿/, "");
const input = JSON.parse(stripBom(readFileSync(0, "utf8")) || "{}");
const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

function block(reason) {
  process.stderr.write(`orchestrator: ${reason}\n`);
  process.exit(2);
}

// A command the human must confirm. It is reported only after every other check on the line passed,
// so a blocked command never reaches the prompt.
let confirmReason = null;
const confirm = (reason) => { confirmReason ??= `orchestrator: ${reason}`; };

function toplevel(dir) {
  let d = path.resolve(dir);
  while (!existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  try { return path.resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: d, stdio: ["ignore", "pipe", "ignore"] }).toString().trim()); }
  catch { return null; }
}

// The checkout the session works in. A worktree has its own toplevel and its own branch.
const root = toplevel(cwd) ?? path.resolve(process.env.CLAUDE_PROJECT_DIR || cwd);
// The folder a shell command runs in so far: the session's, then wherever a cd on the line moved it.
let here = cwd;
// Projects installed before the rename keep .orquestador.json and .orquestador/ until they migrate.
const STATE = existsSync(path.join(root, ".orchestrator.json")) || !existsSync(path.join(root, ".orquestador.json")) ? ".orchestrator" : ".orquestador";
const configPath = path.join(root, `${STATE}.json`);
if (!existsSync(configPath)) process.exit(0);

let config;
try { config = JSON.parse(stripBom(readFileSync(configPath, "utf8"))); }
catch (e) { block(`${STATE}.json is not valid JSON (${e.message}). Fix it before continuing.`); }

const git = config.git ?? {};
const protectedBranches = git.protectedBranches ?? ["main", "master"];
const broadAddBlocked = git.blockBroadAdd !== false;
// The role of this session: a Claude Code subagent carries it in agent_type. The main session has none.
const agentType = String(input.agent_type ?? "");
const inSubagent = Boolean(agentType);
const isRole = (r) => new RegExp(`(^|:)${r}$`).test(agentType);
// .orchestrator.json → roles.<name>.readOnly decides, then the plugin's own roles. A subagent is also
// held by its own tools list.
const configReadOnly = config.roles?.[agentType.replace(/^.*:/, "")]?.readOnly;
const readOnlyRole = typeof configReadOnly === "boolean" ? configReadOnly
  : ["reviewer", "researcher", "designer"].some(isRole);

// Paths are compared repo-relative, so a worktree copy of a locked file matches too.
const key = (p) => { const k = p.split(path.sep).join("/").replace(/^\.\//, ""); return FOLD ? k.toLowerCase() : k; };
const relTo = (base, p) => key(path.relative(base, path.resolve(base, p)));
const LOCK_REL = key(`${STATE}/locked-tests.txt`);
const lockFile = path.join(root, STATE, "locked-tests.txt");
const lockedPaths = existsSync(lockFile)
  ? stripBom(readFileSync(lockFile, "utf8")).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  : [];
const locked = new Set(lockedPaths.map(key));
// A directory that holds a locked file: deleting or moving it takes the file with it.
const holdsLocked = (rel) => rel === "" || [...locked].some((l) => l.startsWith(rel + "/"));
// The guard's failure count: no agent edits it, moves it or deletes the folder that holds it.
const BREAKER_REL = key(`${STATE}/work/breaker.json`);
const touchesBreaker = (rel, removes) => inSubagent && (rel === BREAKER_REL || (removes && (rel === "" || BREAKER_REL.startsWith(rel + "/"))));
const storiesRel = config.storiesDir ? key(path.join(config.storiesDir, "stories")) + "/" : null;
const mapRel = config.storiesDir ? key(path.join(config.storiesDir, "map.md")) : null;

// True only when git answers that HEAD is detached: no repository or a git error is not a detached HEAD.
function detached(dir) {
  try { return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() === "HEAD"; }
  catch { return false; }
}

// A rebase or an am stopped on a conflict keeps HEAD detached until --continue or --abort.
function midRebase(dir) {
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return ["rebase-merge", "rebase-apply"].some((d) => existsSync(path.join(gitDir, d)));
  } catch { return false; }
}

function currentBranch(dir) {
  try { return execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return null; }
}

// ---------- SessionStart: load the procedure

if (input.hook_event_name === "SessionStart") {
  // A session started as a role (claude --agent orchestrator:builder) already has its contract.
  if (inSubagent) process.exit(0);
  let debt = "";
  try {
    debt = execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "orchestrate", "scripts", "tidy.mjs"), "--summary"],
      { cwd: root, stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }).toString().trim();
  } catch {}
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart",
    additionalContext: "This project uses orchestrator. You are the orchestrator: load the orchestrator:orchestrate skill before any work and follow it. Delegate through the Agent tool (references/harness.md)." + (debt ? ` ${debt}` : "") } }));
  process.exit(0);
}

// ---------- PreToolUse: a role never takes the orchestrator's procedure

if (input.hook_event_name === "PreToolUse" && input.tool_name === "Skill" && inSubagent
  && /(^|:)orchestrate$/.test(String(input.tool_input?.skill ?? ""))) {
  block(`you are ${agentType}, not the orchestrator. Follow your brief; report NEEDS_CONTEXT when it does not cover something.`);
}

// ---------- PreToolUse: file edits

// A read-only role writes only its report under .orchestrator/work/, and scratch files in the temp folder
// (its scratchpad, a log). Anything else, another worktree or the user's settings included, is not its to change.
// Symlinks are resolved first: on macOS /tmp is /private/tmp.
const realish = (abs) => { let d = abs, rest = ""; while (!existsSync(d) && path.dirname(d) !== d) { rest = path.join(path.basename(d), rest); d = path.dirname(d); } try { return path.join(realpathSync(d), rest); } catch { return abs; } };
const under = (abs, dir) => { const r = path.relative(dir, abs); return !(r === ".." || r.startsWith(`..${path.sep}`) || path.isAbsolute(r)); };
const TEMP_DIRS = [...new Set([os.tmpdir(), process.env.TMPDIR, process.env.TEMP, process.env.TMP, WIN ? null : "/tmp"].filter(Boolean).map((d) => realish(path.resolve(d))))];
const readOnlyBlocks = (abs) => {
  if (key(abs).includes(`/${STATE}/work/`)) return false;
  const real = realish(abs);
  return under(real, realish(root)) || !TEMP_DIRS.some((d) => under(real, d));
};

function checkFileWrite(rel, absolute) {
  if (locked.has(rel)) block(`${rel} is a locked acceptance test. Report the problem instead of changing the test; only the orchestrator unlocks it, on the product owner's request.`);
  if (rel === mapRel) block(`${rel} is generated. Change the stories and run stories.mjs instead.`);
  if (inSubagent && rel === LOCK_REL) block("subagents cannot change the locked-tests list.");
  if (touchesBreaker(rel, false)) block(`${rel} is the guard's own record. No agent changes it.`);
  if (isRole("builder") && storiesRel && rel.startsWith(storiesRel)) block("the builder does not edit story files. Report the criterion status; the orchestrator updates the markers.");
  if (readOnlyRole && readOnlyBlocks(absolute)) block(`${agentType} is read-only. It writes only its report under .orchestrator/work/, and scratch files in the temp folder.`);
}

if (input.hook_event_name === "PreToolUse" && ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(input.tool_name)) {
  const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!target) process.exit(0);
  const abs = path.resolve(cwd, target);
  const base = toplevel(path.dirname(abs)) ?? root;
  checkFileWrite(relTo(base, abs), abs);
  process.exit(0);
}

// ---------- PreToolUse: shell commands

// Split a command line into simple commands. Quoted text is kept apart: it is checked as a command
// of its own when it is itself a git or shell call, or the script a shell runs (bash -c "...").
let groupSeq = 0;
function commands(line, group = 0) {
  const quoted = [];
  // The shell leaves $ inside single quotes alone: \x01 marks it so the variable expansion leaves it too.
  const bare = line.replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g, (_, d, s) => { quoted.push(d ?? s.replace(/\$/g, "\x01")); return ` __Q${quoted.length - 1}__ `; });
  const scripts = new Set([...bare.matchAll(/(?:^|[\s\\/;&|(])(?:bash|sh|zsh|pwsh|powershell|cmd)(?:\.exe)?\s+(?:-\w*c|-command|\/c)\s+__Q(\d+)__/gi)].map((m) => +m[1]));
  const runs = (i) => scripts.has(i) || /^\s*(\S*[\\/])?git(\.exe)?\s/i.test(quoted[i]) || /^\s*(bash|sh|pwsh|powershell)\b/i.test(quoted[i]);
  const out = [];
  // .sub: the segment runs in a subshell, $(...), a backtick, a pipeline or the background, so a cd there
  // does not move the commands after it.
  const parts = bare.split(/(&&|\|\||;|\||&|\n|\$\(|`|\(|\))/);
  let depth = 0, tick = false;
  for (let k = 0; k < parts.length; k += 2) {
    const before = parts[k - 1] ?? "", after = parts[k + 1] ?? "";
    if (before === "(" || before === "$(") depth++;
    if (before === "`") tick = !tick;
    const tokens = parts[k].trim().split(/\s+/).filter(Boolean);
    // .bare keeps the quotes out: a > inside a quoted argument is text, not a redirection.
    const restore = (t) => t.replace(/__Q(\d+)__/g, (_, i) => quoted[i]);
    const sub = depth > 0 || tick || [before, after].some((d) => d === "|" || d === "&");
    if (tokens.length) out.push(Object.assign(tokens.map(restore), { bare: tokens, restore, sub, group }));
    // A script handed to a shell or to git is checked where it runs, as its own group.
    for (const m of parts[k].matchAll(/__Q(\d+)__/g)) if (runs(+m[1])) out.push(...commands(quoted[+m[1]].replace(/\x01/g, "$"), ++groupSeq).map((c) => Object.assign(c, { parent: c.parent ?? group })));
    if (after === ")" && depth > 0) depth--;
  }
  return out;
}

const INTERPRETERS = /^(\S*[\\/])?(python[0-9.]*|py|node|perl|ruby|deno|bun|php|osascript)(\.exe)?$/i;
// What starts another program from inside a script, in the languages above.
const SPAWNS = /\b(subprocess|os\.(system|popen|exec\w*|spawn\w*)|popen|child_process|shell_exec|passthru|proc_open|qx)\b|\b(exec(File)?(Sync)?|spawn(Sync)?|system)\s*\(|\bBun\.(spawn|\$)|\bDeno\.(Command|run)|do shell script|`\s*git\b|\$\(\s*git\b/i;
const MENTIONS_GIT = /(^|[^\w-])git(?![\w-])/i;
// The bodies of the heredocs fed to an interpreter in a command line: the text that program runs.
function interpreterHeredocs(line) {
  const bodies = [];
  for (const m of line.matchAll(/^([^\n]*?)(?<!<)<<(?!<)-?[ \t]*(['"]?)(\w+)\2[^\n]*\n([\s\S]*?)\n[ \t]*\3[ \t]*$/gm)) {
    if (m[1].split(/&&|\|\||;|\|/).some((seg) => INTERPRETERS.test(seg.trim().split(/\s+/)[0] ?? ""))) bodies.push(m[4]);
  }
  return bodies.join("\n");
}
// Heredocs that only write text: `cat > f <<E` or `tee f <<E`, with no pipe after it. Their body is data
// (HTML with >, a script saved to run later), never commands.
// (Easy One, 2026-11-25: a measuring page written with cat was blocked over the > in its HTML.)
function splitDataHeredocs(line) {
  const rest = line.replace(/^([^\n]*?)(?<!<)<<(?!<)-?[ \t]*(['"]?)(\w+)\2([^\n]*)\n([\s\S]*?)\n[ \t]*\3[ \t]*$/gm, (all, head, q, tag, after, body) => {
    // A << inside quotes or a comment is no heredoc: then the lines after it are commands.
    if (/['"#`]/.test(head)) return all;
    const seg = head.split(/&&|\|\||;|\||\(/).at(-1).trim();
    if (!/^(cat|tee)$/.test(seg.split(/\s+/)[0] ?? "") || /\|/.test(after)) return all;
    return `${head}<<${q}${tag}${q}${after}`;
  });
  return { rest };
}
const isGit = (t) => /(^|[\\/])git(\.exe)?$/i.test(t);
// The index of the subcommand in git's arguments, after its global options (-C dir, -c key=value).
function gitSubIndex(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += /^(-C|-c|--git-dir|--work-tree|--namespace)$/.test(args[i]) ? 2 : 1;
  return i;
}
function gitSubcommand(c) {
  const args = c.slice(isGit(c[0]) ? 1 : 2);
  return String(args[gitSubIndex(args)] ?? "").toLowerCase();
}

function checkGit(args) {
  const i = gitSubIndex(args);
  args.slice(0, i).forEach((a, k) => { if (a === "-c" && /^core\.hookspath=/i.test(args[k + 1] ?? "")) block("overriding core.hooksPath skips the project's hooks."); });
  const sub = (args[i] ?? "").toLowerCase();
  const rest = args.slice(i + 1);
  const has = (re) => rest.some((a) => re.test(a));
  // Only a global -C names the folder: `git commit -C <commit>` reuses a message.
  const globalC = args.slice(0, i).indexOf("-C");
  const dirArg = globalC >= 0 ? path.resolve(here, args[globalC + 1] ?? ".") : here;

  // Once core.hooksPath is set, it stays: unsetting it or pointing it elsewhere skips the project's hooks.
  // Reading it is fine, and so is setting it the first time (installing husky, for example).
  const hooksKey = rest.findIndex((a) => /^core\.hookspath$/i.test(a));
  // A whole-section change (remove, rename) or an editor session can drop it too.
  const touchesCore = has(/^(--)?(remove-section|rename-section)$/) && has(/^core$/i);
  const edits = has(/^(-e|--edit|edit)$/);
  if (sub === "config" && (hooksKey >= 0 || touchesCore || edits) && !has(/^(--get|--get-all|--list|-l|get|list)$/)) {
    // The project's own value: a global hooksPath must not stop a project setting its first one.
    let current = "";
    try { current = execFileSync("git", ["config", "--local", "--get", "core.hooksPath"], { cwd: dirArg, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
    catch { /* not set */ }
    const unsets = touchesCore || edits || has(/^--(unset|unset-all)$/) || rest.slice(0, Math.max(hooksKey, 0)).includes("unset");
    const value = hooksKey >= 0 ? rest[hooksKey + 1] : undefined;
    if (current && (unsets || (value !== undefined && value !== current))) block(`core.hooksPath stays at ${current}: the project's commit checks run from there.`);
  }


  // A detached HEAD takes a role's commits off the branch the orchestrator merges: the merge comes out empty.
  if (inSubagent && ["commit", "merge", "rebase", "cherry-pick", "pull", "am", "revert"].includes(sub) && detached(dirArg) && !midRebase(dirArg)) {
    block(`HEAD is detached in ${dirArg}: git ${sub} would put commits on no branch. Report BLOCKED; the orchestrator puts you back on your branch.`);
  }
  if (sub === "push") {
    if (has(/^(--force|--force-with-lease|--force-if-includes)/) || has(/^-[a-z]*f/i) || has(/^\+/)) block("force push is blocked.");
    if (has(/^--no-verify$/)) block("--no-verify is blocked. Fix the failing hook instead.");
    if (inSubagent) block("role agents never push. Report DONE; the orchestrator pushes when the product owner asks.");
    if (git.allowPush === false) confirm("git.allowPush is false in this project, so every push needs the product owner's confirmation.");
  }
  if (sub === "commit") {
    if (has(/^--no-verify$/) || has(/^-[a-z]*n/i)) block("skipping commit hooks is blocked. Fix the failing hook instead.");
    if (broadAddBlocked && (has(/^--all$/) || has(/^-[a-z]*a/i))) block("`git commit -a` stages everything. Stage the story's files by name.");
    const b = currentBranch(dirArg);
    if (b && protectedBranches.includes(b)) block(`commits on ${b} are blocked. Create the story branch first.`);
    // A role must not commit a change to a locked file: the Stop check compares against HEAD.
    if (inSubagent) {
      let staged = [];
      try { staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dirArg, stdio: ["ignore", "pipe", "ignore"] }).toString().split(/\r?\n/).filter(Boolean).map(key); }
      catch { /* not a repository: nothing staged */ }
      const hit = staged.find((f) => locked.has(f) || f === LOCK_REL);
      if (hit) block(`${hit} is locked. Unstage it; only the orchestrator commits changes to locked files.`);
    }
  }
  if (["merge", "rebase", "cherry-pick", "pull", "am", "revert"].includes(sub)) {
    const b = currentBranch(dirArg);
    if (b && protectedBranches.includes(b)) block(`git ${sub} on ${b} is blocked. Merging into ${b} happens only on the product owner's request.`);
  }
  if (sub === "add" && broadAddBlocked && rest.some((a) => /^(-A|--all|-u|--update|\.|\.\/|:\/|\*)$/.test(a))) {
    block("broad `git add` is blocked. Stage the story's files by name.");
  }
  if (sub === "reset" && has(/^--hard$/)) block("git reset --hard is blocked. It discards work.");
  if (sub === "clean" && has(/^-[a-z]*f/i)) block("git clean -f is blocked. It deletes untracked files.");
  if ((sub === "checkout" || sub === "restore") && rest.some((a) => a === "." || a === ":/")) block(`git ${sub} . discards every uncommitted change. Name the files instead.`);
  // Restoring a locked file to HEAD is how a role undoes a change to it, so that stays allowed.
  const toHead = (sub === "restore" && !has(/^(-s|--source)/))
    || (sub === "checkout" && rest.includes("--") && rest.slice(0, rest.indexOf("--")).every((a) => /^HEAD$/i.test(a)));
  if (["rm", "mv"].includes(sub)) checkPaths(sub === "mv" ? rest.slice(0, -1) : rest, dirArg, true);
  if (["rm", "mv", "checkout", "restore"].includes(sub) && !toHead) checkPaths(rest, dirArg);
}

const NULL_DEVICE = /^(\/dev\/null|\$null|nul)$/i;
const WRITERS = /^(rm|del|erase|rmdir|mv|move|cp|copy|tee|sed|truncate|remove-item|move-item|copy-item|set-content|add-content|out-file|clear-content|new-item)$/i;
const REMOVERS = /^(rm|del|erase|rmdir|rd|mv|move|remove-item|move-item|ri|mi)$/i;

// True after a cd the guard could not follow: relative paths are then in no known folder.
let lostDir = false;
function checkPaths(tokens, dir, removes = false) {
  const base = toplevel(dir) ?? root;
  for (const t of tokens) {
    let p = t.replace(/^[<>]+/, "").replace(/^(-\w+:)/, "");
    if (lostDir && p && !p.startsWith("-") && !p.includes("$") && !path.isAbsolute(p) && !NULL_DEVICE.test(p)) p = `$CWD/${p}`;
    if (!p || p.startsWith("-") || NULL_DEVICE.test(p)) continue;
    if (p.includes("$")) { unresolvedPath(p, dir, base, removes); continue; }
    const rel = relTo(base, path.resolve(dir, p));
    if (locked.has(rel)) block(`${rel} is a locked acceptance test. It cannot be changed, moved or deleted.`);
    if (removes && !rel.startsWith("..") && holdsLocked(rel)) block(`${rel || "."} holds locked acceptance tests. It cannot be moved or deleted.`);
    if (inSubagent && rel === LOCK_REL) block("subagents cannot change the locked-tests list.");
    if (touchesBreaker(rel, removes)) block(`${rel || "."} holds the guard's own record. No agent changes, moves or deletes it.`);
    if (isRole("builder") && storiesRel && rel.startsWith(storiesRel)) block("the builder does not edit story files. Report the criterion status; the orchestrator updates the markers.");
    if (rel === mapRel) block(`${rel} is generated. Change the stories and run stories.mjs instead.`);
  }
}

// Any .. on the command line, in a loop list too (for f in ../x), can carry a variable's path anywhere.
const LINE_CLIMBS = () => /(^|[\s\\/'"=])\.\.([\\/\s'";]|$)/.test(String(input.tool_input?.command ?? ""));
// A path with a variable the guard cannot resolve ($f in a loop, $(...)): any value could stand there.
// When the pattern can name a guarded file, the human confirms.
function unresolvedPath(p, dir, base, removes) {
  const at = p.indexOf("$");
  const prefix = p.slice(0, at);
  const tail = p.slice(at);
  const climbs = /(^|[\\/])\.\.([\\/]|$)/.test(tail) || LINE_CLIMBS();
  // The fixed folder before the variable: `tests/a$X.js` sits in tests/, `$D/a` in no known folder.
  const fixedDir = /[\\/]/.test(prefix) ? prefix.replace(/[^\\/]*$/, "") : "";
  const relDir = fixedDir ? relTo(base, path.resolve(dir, fixedDir)) : null;
  if (!climbs && (relDir === ".." || relDir?.startsWith("../"))) return;
  const relPrefix = prefix ? relTo(base, path.resolve(dir, prefix)) + (/[\\/]$/.test(prefix) ? "/" : "") : null;
  if (isRole("builder") && storiesRel && relPrefix?.startsWith(storiesRel) && !climbs) block("the builder does not edit story files. Report the criterion status; the orchestrator updates the markers.");
  const guarded = [...locked, mapRel, ...(inSubagent ? [LOCK_REL, BREAKER_REL] : [])].filter(Boolean);
  let hit;
  if (climbs) hit = guarded.length || (isRole("builder") && storiesRel) ? "any file" : null;
  else {
    const esc = (t) => t.replace(/[.*+?^{}()|[\]\\]/g, "\\$&");
    const rest = esc(key(tail).replace(/\$(\{[^}]*\}|\(.*?\)|[a-z_]\w*|\d|\S)?/gi, "\x02"))
      .replace(/^\x02\//, "(?:.*/)?").replace(/\x02/g, ".*");
    const lead = relPrefix === null ? "(?:.*/)?" : relPrefix.startsWith("..") ? "" : esc(relPrefix);
    const re = new RegExp(`^${lead}${rest}${removes ? "(/.*)?" : ""}$`, FOLD ? "i" : "");
    hit = guarded.find((g) => re.test(g)) ?? (isRole("builder") && storiesRel && (relPrefix === null || storiesRel.startsWith(relPrefix)) ? storiesRel : null);
  }
  if (hit) confirm(`\`${p}\` holds a shell variable the guard cannot resolve, and it could name ${hit}, which no agent changes. Confirm it does not, or write the full path.`);
}

// ---------- The same failure in a row, inside one builder run
// .orchestrator/work/breaker.json is the guard's own file: for each run, how many times in a row each
// command failed with the same output. No agent edits it.
const breakerPath = path.join(root, STATE, "work", "breaker.json");
const maxSameFailure = config.verify?.maxSameFailure ?? 3;
const commandKey = (c) => String(c ?? "").replace(/\s+/g, " ").trim();
// A subagent run is its agent_id, never the session it runs in. A session started as a role
// (claude --agent) has no agent_id: the session is the run.
const runId = String(input.agent_id ?? (inSubagent ? input.session_id ?? "" : ""));
// Searches and comparisons exit 1 when they find nothing: that is an answer, not a failure. A command
// line exits with its last command, so that one decides. `rtk test <cmd>` wraps a real command.
const isProbe = (c) => {
  let t = commands(c).at(-1) ?? [];
  if (/^rtk$/i.test(t[0] ?? "") && /^(test|err|summary|proxy)$/i.test(t[1] ?? "")) t = t.slice(2);
  t = t.filter((x) => !/^(rtk|sudo|command|env|time)$/i.test(x) && !/^\$?(env:)?[A-Za-z_]\w*=/.test(x));
  return /^(grep|egrep|fgrep|rg|findstr|select-string|sls|test|\[|\[\[|diff|cmp|fc)$/i.test(t[0] ?? "")
    || (isGit(t[0] ?? "") && /^(diff|grep|rev-parse|ls-files|show-ref|merge-base|cat-file|check-ignore|config)$/i.test(gitSubcommand(t)));
};
function readBreaker() { try { return JSON.parse(stripBom(readFileSync(breakerPath, "utf8"))); } catch { return {}; } }
// Only this run is kept: parallel builders work in their own worktrees, each with its own file.
function writeBreaker(mine) {
  mkdirSync(path.dirname(breakerPath), { recursive: true });
  const tmp = `${breakerPath}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ failures: { [runId]: mine } }, null, 2));
  renameSync(tmp, breakerPath);
}
const breakerOn = () => isRole("builder") && ["Bash", "PowerShell"].includes(input.tool_name) && maxSameFailure > 0 && runId;

// Durations, counts and line numbers change from one attempt to the next; the failure itself does not.
if (input.hook_event_name === "PostToolUseFailure") {
  if (!breakerOn() || input.is_interrupt) process.exit(0);
  const cmd = commandKey(input.tool_input?.command);
  if (isProbe(cmd)) process.exit(0);
  const signature = createHash("sha1").update(String(input.error ?? "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);
  const mine = readBreaker().failures?.[runId] ?? {};
  mine[cmd] = { signature, times: mine[cmd]?.signature === signature ? mine[cmd].times + 1 : 1 };
  writeBreaker(mine);
  process.exit(0);
}

// A success breaks the row.
if (input.hook_event_name === "PostToolUse") {
  if (!breakerOn()) process.exit(0);
  const cmd = commandKey(input.tool_input?.command);
  const mine = readBreaker().failures?.[runId];
  if (mine?.[cmd]) { delete mine[cmd]; writeBreaker(mine); }
  process.exit(0);
}

if (input.hook_event_name === "PreToolUse" && ["Bash", "PowerShell"].includes(input.tool_name)) {
  if (isRole("builder") && maxSameFailure > 0 && runId) {
    const cmd = commandKey(input.tool_input?.command);
    const failed = readBreaker().failures?.[runId]?.[cmd];
    if (failed?.times >= maxSameFailure) block(`\`${cmd.slice(0, 200)}\` failed ${failed.times} times in a row with the same output. Do not run it again: stop and report BLOCKED with that output and what you tried.`);
  }
  const data = splitDataHeredocs(String(input.tool_input?.command ?? ""));
  // The body of a text heredoc is not checked at all: the Write tool writes the same file unread.
  const cmds = commands(data.rest.replace(/\d*>&\d/g, " "));
  // Shell variables: `S=/tmp/x; ... > $S/log` writes to /tmp/x/log, not to a repo file named $S/log.
  // A command sees the assignments made before it on this line (`S=...` alone, or `export S=...`), then
  // the environment; ~ is the home folder and $PWD the folder the command runs in. What stays unresolved
  // goes to unresolvedPath. A name whose value is null is unresolved: it came from $(...), a backtick, or
  // an assignment the guard cannot place (a subshell, a pipeline), so neither the line nor the environment decides.
  const vars = {};
  const shellState = (name) => name === "PWD" ? (lostDir ? undefined : here) : name === "OLDPWD" ? undefined : process.env[name];
  const lookup = (name) => name in vars ? vars[name] ?? undefined : shellState(name);
  // ~ is HOME: the line's own when it sets one (unresolved if the guard cannot tell its value).
  const expand = (t) => t.replace(/^~(?=[\\/]|$)/, () => "HOME" in vars ? vars.HOME ?? "$HOME" : os.homedir())
    .replace(/\$(?:env:)?(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, (m, a, b) => lookup(a ?? b) ?? m)
    .replace(/\x01/g, "$");
  const ASSIGN = /^(?:\$env:)?([A-Za-z_]\w*)=(.*)$/s;
  const line = String(input.tool_input?.command ?? "");
  // A name assigned inside $(...), a backtick, a subshell or a pipeline segment: the shell drops that value
  // when the segment ends, so the guard cannot tell which value a later command sees.
  const scoped = new Set();
  for (const m of line.matchAll(/(?:\$\(|`|\(|(?<!\|)\|(?!\|))\s*(?:export\s+|local\s+)?([A-Za-z_]\w*)=/g)) scoped.add(m[1]);
  for (const m of line.matchAll(/(?:^|[;&\n]|&&)\s*(?:export\s+)?([A-Za-z_]\w*)=[^;&|\n]*(?<!\|)\|(?!\|)/g)) scoped.add(m[1]);
  // Names the shell sets in ways the guard does not follow: loop variables, read, +=, printf -v.
  for (const m of line.matchAll(/\b(?:for|select)\s+([A-Za-z_]\w*)\s+in\b|([A-Za-z_]\w*)\+=|\bprintf\s+-v\s+([A-Za-z_]\w*)/g)) scoped.add(m[1] ?? m[2] ?? m[3]);
  for (const m of line.matchAll(/\bread\b((?:\s+-\w+(?:\s+\S+)?)*)((?:\s+[A-Za-z_]\w*)+)/g)) for (const n of m[2].trim().split(/\s+/)) scoped.add(n);
  for (const n of scoped) vars[n] = null;
  // Assignments are read from the bare tokens: `D="x"` arrives as `D=` and a quote placeholder, and
  // `F=$(cmd)` as a lone `F=`, because commands() splits at $( and backticks.
  const learn = (raw) => {
    let bare = [...(raw.bare ?? raw)];
    while (/^(do|then|else|elif|if|while|until|\{|!)$/.test(bare[0] ?? "")) bare = bare.slice(1);
    const joined = [];
    for (let i = 0; i < bare.length; i++) {
      if (/=$/.test(bare[i]) && /^__Q\d+__$/.test(bare[i + 1] ?? "")) { joined.push(bare[i] + bare[i + 1]); i++; } else joined.push(bare[i]);
    }
    const list = /^(export|declare|typeset|local|readonly)$/.test(joined[0] ?? "") ? joined.slice(1) : joined.length && joined.every((t) => ASSIGN.test(t)) ? joined : [];
    list.forEach((t, i) => {
      const m = ASSIGN.exec(t);
      if (!m) return;
      const value = raw.restore ? raw.restore(m[2]) : m[2];
      // Never trust an empty value (what is left of F=$(...)), a $(...) or backtick, a value with a quote
      // inside it (D=a/"b"), or one split from its next piece (export D="a"/b arrives as two tokens).
      const split = (/__Q\d+__/.test(m[2]) && !/^__Q\d+__$/.test(m[2])) || (i + 1 < list.length && !ASSIGN.test(list[i + 1]));
      vars[m[1]] = scoped.has(m[1]) || value === "" || /\$\(|`/.test(value) || split ? null : expand(value);
    });
  };
  // The branch check reads HEAD before the command runs, so a switch and a commit must not share a command.
  // Compare subcommands only: a commit message that mentions «switch» is not a branch change.
  const gitSubs = cmds.filter((c) => isGit(c[0]) || isGit(c[1] ?? "")).map(gitSubcommand);
  if (gitSubs.some((c) => c === "switch" || c === "checkout") && gitSubs.includes("commit")) {
    block("run the branch switch and the commit as separate commands.");
  }
  // The folder of each group: the line itself (0), and each script handed to a shell, which starts where its
  // parent group was and keeps its own cd to itself.
  const dirs = new Map([[0, { here: cwd, lost: false }]]);
  for (const raw of cmds) {
    const g = raw.group ?? 0;
    if (!dirs.has(g)) dirs.set(g, { ...(dirs.get(raw.parent ?? 0) ?? dirs.get(0)) });
    const dirState = dirs.get(g);
    ({ here, lost: lostDir } = dirState);
    learn(raw);
    // Strip wrappers, shell keywords and VAR=value prefixes: `HUSKY=0 git commit` is still a git commit,
    // and so is the body of a loop (`do rm $f`).
    let s = 0;
    while (s < raw.length && (/^(do|then|else|elif|if|while|until|\{|!)$/.test(raw[s]) || /^(rtk|sudo|command|exec|env|nohup|time|&)$/i.test(raw[s]) || /^\$?(env:)?[A-Za-z_]\w*=/.test(raw[s]))) {
      if (/^\$?(env:)?HUSKY=0/i.test(raw[s])) block("HUSKY=0 skips the commit hooks. Fix the failing hook instead.");
      s++;
    }
    const tokens = raw.slice(s);
    if (!tokens.length) continue;
    // The arguments with their variables filled in; the program name stays as written.
    const args = tokens.slice(1).map(expand);
    // A script run inline (node -e, python -c, a heredoc) can call git in shapes the checks here cannot read:
    // execFileSync('git', [...]), a cd before it, a quote the parser pairs wrongly. When it both mentions git
    // and starts a program, ask. A script that only edits text mentioning git (the common case) passes.
    if (INTERPRETERS.test(tokens[0])) {
      const script = tokens.some((t) => t.includes("<<")) ? interpreterHeredocs(line) : tokens.slice(1).join(" ").replace(/\x01/g, "$");
      if (MENTIONS_GIT.test(script) && SPAWNS.test(script)) confirm(`this ${tokens[0]} script mentions git, and git calls inside a script are not checked. Confirm it does not commit, push or rewrite history.`);
    }
    // Windows PowerShell 5 expands $1 and eats quotes inside an inline script (it deleted a story's
    // criteria), and its -Encoding utf8 writes a BOM (it broke lint and can break a story's frontmatter).
    if (input.tool_name === "PowerShell") {
      if (INTERPRETERS.test(tokens[0]) && /^(-e|--eval|-p|--print|-c)$/i.test(tokens[1] ?? "")) block(`PowerShell rewrites $ and quotes inside an inline ${tokens[0]} script. Write the script to a file in your scratchpad and run that file, or edit with Edit/Write.`);
      const enc = tokens.findIndex((t) => /^-encoding(:|$)/i.test(t));
      const encValue = enc < 0 ? "" : tokens[enc].includes(":") ? tokens[enc].split(":")[1] : tokens[enc + 1] ?? "";
      if (/^(set-content|add-content|out-file|sc|ac)$/i.test(tokens[0]) && /^utf-?8(bom)?$/i.test(encValue)) block(`${tokens[0]} -Encoding utf8 writes a byte-order mark in Windows PowerShell. Write the file with Edit/Write instead.`);
    }
    // Later relative paths on the line resolve from the folder a cd moved to.
    // A cd in a subshell, a pipeline or the background, cd -, popd and a folder the guard cannot resolve:
    // the folder after it is unknown.
    if (/^(cd|chdir|pushd|popd|set-location|sl|push-location|pop-location)$/i.test(tokens[0])) {
      const to = args.find((t) => !t.startsWith("-") || t === "-");
      const native = WIN && to ? to.replace(/^\/([a-z])(\/|$)/i, "$1:/") : to;
      if (raw.sub || /^(popd|pop-location)$/i.test(tokens[0]) || native === "-" || (native && /[$~%]/.test(native))) dirState.lost = true;
      else dirState.here = native ? path.resolve(here, native) : os.homedir();
      continue;
    }
    if (isGit(tokens[0])) {
      if (readOnlyRole && !/^(status|diff|log|show|blame|grep|ls-files|rev-parse|branch|remote)$/i.test(gitSubcommand(tokens))) block(`${agentType} is read-only. It may only run git commands that read.`);
      checkGit(args);
      continue;
    }
    if (/^gh$/i.test(tokens[0]) && /^pr$/i.test(tokens[1] ?? "") && /^merge$/i.test(tokens[2] ?? "")) {
      if (inSubagent) block("role agents never merge. The product owner merges, or asks the orchestrator to.");
      if (git.allowPush === false) confirm("git.allowPush is false in this project, so every merge needs the product owner's confirmation.");
    }
    // Redirections write too: split "x>file" and "> file" into their own tokens.
    const split = (raw.bare?.slice(s) ?? tokens).flatMap((t) => t.split(/(>>?)/)).filter(Boolean);
    const redirTargets = split.filter((t, i) => i > 0 && /^>>?$/.test(split[i - 1])).map((t) => expand(raw.restore?.(t) ?? t));
    if (WRITERS.test(tokens[0])) checkPaths(args, here);
    if (REMOVERS.test(tokens[0])) checkPaths(/^(mv|move|move-item|mi)$/i.test(tokens[0]) ? args.slice(0, -1) : args, here, true);
    if (redirTargets.length) checkPaths(redirTargets, here);
    if (readOnlyRole) {
      const targets = [...(WRITERS.test(tokens[0]) ? args.filter((t) => !t.startsWith("-")) : []), ...redirTargets]
        .filter((t) => !/^&?\d*$/.test(t) && !NULL_DEVICE.test(t));
      // A variable left unresolved could hold ../ and climb out of the temp folder; after a lost cd, so could a relative path.
      const outside = targets.find((t) => t.includes("$") || (lostDir && !path.isAbsolute(t)) || readOnlyBlocks(path.resolve(here, t)));
      if (outside) block(`${agentType} is read-only. It writes only its report under .orchestrator/work/, and scratch files in the temp folder (not ${outside}${outside.includes("$") ? ": write the full path, not a variable the guard cannot resolve" : ""}).`);
    }
  }
  if (confirmReason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse",
    permissionDecision: "ask", permissionDecisionReason: confirmReason } }));
  process.exit(0);
}

// ---------- Stop and SubagentStop: the builder does not stop on red
// SubagentStop fires for a Claude Code subagent. In the orchestrator's own session there is no role,
// so Stop exits at once.

if (input.hook_event_name === "SubagentStop" || input.hook_event_name === "Stop") {
  // A detached HEAD holds commits no branch carries: the merge of the branch would bring none of them.
  if (inSubagent && !readOnlyRole && !input.stop_hook_active && detached(root)) block("HEAD is detached: your commits are on no branch. Do not move HEAD yourself. Report BLOCKED with the output of `git log --oneline -3`.");
  if (!isRole("builder")) process.exit(0);
  // Content, not command shape: whatever tool changed a locked file, the story files or the lock
  // list, the difference from HEAD shows it. This check ignores stop_hook_active: the builder
  // restores the files (git restore <file>) or stops for good only by reporting BLOCKED.
  const spec = (list) => list.map((p) => (FOLD ? `:(icase)${p}` : p));
  const lockSet = spec([...lockedPaths, `${STATE}/locked-tests.txt`]);
  const run = (a) => { try { return execFileSync("git", a, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };
  const names = (a) => run(a).split(/\r?\n/).filter(Boolean);
  const changed = names(["diff", "--name-only", "HEAD", "--", ...lockSet, ...spec(storiesRel ? [storiesRel, mapRel] : [])]);
  if (changed.length) block(`these locked or orchestrator-owned files differ from HEAD: ${changed.join(", ")}. Restore them with \`git restore <file>\`, then report what you needed to change them for.`);
  // A commit made through an interpreter leaves the tree equal to HEAD. The orchestrator commits each
  // lock, so the last commit that touched the lock list is the base the locked files must still match.
  const base = run(["log", "-1", "--format=%H", "--", `${STATE}/locked-tests.txt`]);
  const committed = base ? names(["diff", "--name-only", base, "HEAD", "--", ...lockSet]) : [];
  if (committed.length && !input.stop_hook_active) block(`locked files were committed after the lock (${base.slice(0, 7)}): ${committed.join(", ")}. Do not undo it yourself. Report BLOCKED and name these files and the commit.`);
  if (input.stop_hook_active) process.exit(0); // One retry for the verification commands; then the builder reports honestly.
  const deadline = Date.now() + 1000 * 1000; // Stay inside the hook timeout in hooks.json.
  for (const c of config.verify?.onBuilderStop ?? []) {
    const left = deadline - Date.now();
    if (left <= 0) block("the verification checks ran out of time. Report the unchecked commands as ⚠️.");
    try { execSync(c, { cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout: left, maxBuffer: 64 * 1024 * 1024 }); }
    catch (e) {
      const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.split(/\r?\n/).slice(-40).join("\n");
      block(`\`${c}\` failed. Fix it, or report it as ❌ with this output:\n${out}`);
    }
  }
  process.exit(0);
}

process.exit(0);
