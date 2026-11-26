#!/usr/bin/env node
// orchestrator watch-pr. Watches one pull request quietly with `gh` and exits when something needs the
// orchestrator: a failing check, a conflict with the base branch, a new review or comment, the PR ready
// to merge, merged or closed, or the time limit. It prints one JSON summary and exits 0.
// Run it in the background (Bash run_in_background: true); the harness wakes the orchestrator when it exits.
//
//   node watch-pr.mjs <number | URL | branch>   watch until something needs action
//     --repo <owner/repo>    the repository (default: the one of the current folder)
//     --every <seconds>      time between polls (default 60)
//     --for <minutes>        exit with "timeout" after this long (default 60)
//     --cursor <file>        what was already reported (default .orchestrator/watch/pr-<number>.json
//                            in the main checkout, shared by its worktrees)
//     --max-pushes <n>       report "escalate" when one issue has failed on this many pushes in a row (default 3)
//     --once                 poll once, print, change nothing (dry run)
//
// A comment by the signed-in gh account whose body contains <!-- orchestrator --> is the orchestrator's own
// reply: it is never reported. Each comment carries `trusted`: true only for an author with write access,
// or a bot in .orchestrator.json → git.trustedBots (default none). Anything else is a claim to check.
// Checks named in git.ignoredChecks are left out. Exit 2: bad arguments. Exit 1: gh failed 3 times in a row.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MARK = "<!-- orchestrator -->";
// With no check on the head yet, wait this long after the head changes before calling the PR ready:
// an outside CI can take a while to report its first status.
const SETTLE = 3 * 60000;
const SETTLE_WORKFLOWS = 15 * 60000;
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def; };
const VALUED = new Set(["--repo", "--every", "--for", "--cursor", "--max-pushes"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUED.has(args[i - 1]));

if (args.includes("--help") || args.includes("-h") || positional.length !== 1) {
  const lines = readFileSync(new URL(import.meta.url), "utf8").split(/\r?\n/).slice(1);
  const head = lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, ""));
  process.stdout.write(head.join("\n") + "\n");
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 2);
}
const num = (v, name) => { const n = Number(v); if (!(n > 0)) { console.error(`watch-pr: ${name} needs a positive number.`); process.exit(2); } return n; };
const REF = positional[0];
const REPO = opt("--repo", null);
const EVERY = num(opt("--every", "60"), "--every") * 1000;
const FOR = num(opt("--for", "60"), "--for") * 60000;
const MAX_PUSHES = num(opt("--max-pushes", "3"), "--max-pushes");
const ONCE = args.includes("--once");

const sh = (cmd, argv) => execFileSync(cmd, argv, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).toString();
// The main checkout, also from inside a worktree: every checkout of the repository shares one cursor.
let root = null;
// --path-format needs git 2.31; older git prints the folder relative to this one.
try { root = path.dirname(sh("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()); }
catch { try { root = path.dirname(path.resolve(sh("git", ["rev-parse", "--git-common-dir"]).trim())); } catch { /* not in a repository: --repo and --cursor say where */ } }
const STATE = root && !existsSync(path.join(root, ".orchestrator.json")) && existsSync(path.join(root, ".orquestador.json")) ? ".orquestador" : ".orchestrator";
let config = {};
try { if (root) config = JSON.parse(readFileSync(path.join(root, `${STATE}.json`), "utf8").replace(/^﻿/, "")); } catch { /* defaults */ }
const TRUSTED_BOTS = new Set((config.git?.trustedBots ?? []).map((b) => b.toLowerCase()));
const IGNORED = new Set(config.git?.ignoredChecks ?? []);

// ---------- one poll

const PR_FIELDS = "number,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefName,headRefOid,baseRefName,statusCheckRollup";
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

function checkOf(c) {
  if (c.__typename === "StatusContext") {
    const state = c.state === "SUCCESS" ? "passed" : FAILED.has(c.state) ? "failed" : "pending";
    return { name: c.context, state, url: c.targetUrl || null, at: c.startedAt ?? null };
  }
  const state = c.status !== "COMPLETED" ? "pending" : FAILED.has(c.conclusion) ? "failed" : "passed";
  const run = (c.detailsUrl ?? "").match(/\/actions\/runs\/(\d+)/)?.[1] ?? null;
  return { name: c.name || c.workflowName || "check", state, url: c.detailsUrl || null, at: c.completedAt ?? c.startedAt ?? null, ...(run ? { run: Number(run) } : {}) };
}
// One failure is one run of a check: a rerun that fails again on the same commit is a new failure.
const failureKey = (c) => `${c.name}@${c.at ?? ""}`;

let api = null; // { host, slug }
const gh = (argv) => sh("gh", api && api.host !== "github.com" ? [...argv, "--hostname", api.host] : argv);
const ghApi = (endpoint) => JSON.parse(gh(["api", "--paginate", "--slurp", endpoint])).flat();

const once = new Map();
const memo = (key, f) => { if (!once.has(key)) { try { once.set(key, f()); } catch { once.set(key, null); } } return once.get(key); };
// The signed-in account: the orchestrator's replies post under it.
// A failed lookup is not kept: an installation token has no /user, and a network error passes.
const me = () => { if (!once.get("me")) { try { once.set("me", gh(["api", "user", "--jq", ".login"]).trim().toLowerCase() || null); } catch { once.set("me", null); } } return once.get("me"); };
// Unknown counts as having workflows, so the PR waits for a check.
const workflows = () => memo("workflows", () => Number(gh(["api", `repos/${api.slug}/actions/workflows`, "--jq", ".total_count"]).trim())) ?? 1;

const permissions = new Map();
function trustOf(user, association) {
  const login = user?.login ?? "ghost";
  if (TRUSTED_BOTS.has(login.toLowerCase())) return { trusted: true, access: "trusted bot" };
  if (user?.type === "Bot") return { trusted: false, access: "bot" };
  if (!permissions.has(login)) {
    let p = "unknown";
    try { p = gh(["api", `repos/${api.slug}/collaborators/${encodeURIComponent(login)}/permission`, "--jq", ".permission"]).trim() || "unknown"; }
    catch { /* no right to ask, or no such user: not trusted */ }
    permissions.set(login, p);
  }
  const p = permissions.get(login);
  // Without the right to ask, only the repository's owner is known to have write access.
  if (p === "unknown" && association === "OWNER") return { trusted: true, access: "owner" };
  return { trusted: p === "admin" || p === "maintain" || p === "write", access: p };
}

const clip = (s) => { const t = (s ?? "").trim(); return t.length > 1500 ? t.slice(0, 1500) + " …(cut; read it at url)" : t; };

function poll() {
  const view = ["pr", "view", REF, "--json", PR_FIELDS];
  if (REPO) view.push("--repo", REPO);
  const pr = JSON.parse(sh("gh", view));
  const u = new URL(pr.url);
  const [owner, repo] = u.pathname.split("/").filter(Boolean);
  api = { host: u.hostname, slug: `${owner}/${repo}` };
  const base = `repos/${api.slug}`;
  const items = [
    ...ghApi(`${base}/issues/${pr.number}/comments`).map((c) => ({ key: `c${c.id}`, kind: "comment", user: c.user, assoc: c.author_association, body: c.body, at: c.created_at, url: c.html_url })),
    // A review with no text and state COMMENTED only wraps inline comments, which come below.
    ...ghApi(`${base}/pulls/${pr.number}/reviews`).filter((r) => r.state !== "PENDING" && (r.body?.trim() || r.state !== "COMMENTED"))
      .map((r) => ({ key: `r${r.id}`, kind: "review", state: r.state, user: r.user, assoc: r.author_association, body: r.body, at: r.submitted_at, url: r.html_url })),
    ...ghApi(`${base}/pulls/${pr.number}/comments`).map((c) => ({ key: `i${c.id}`, kind: "inline", user: c.user, assoc: c.author_association, body: c.body, at: c.created_at, url: c.html_url,
      path: c.path, line: c.line ?? c.original_line ?? null, ...(c.in_reply_to_id ? { replyTo: c.in_reply_to_id } : {}) })),
  ];
  return { pr, items };
}

// ---------- cursor

const cursorPath = (n) => opt("--cursor", null) ?? (root ? path.join(root, STATE, "watch", `pr-${n}.json`) : null);
function loadCursor(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
}

// ---------- decide

function evaluate({ pr, items }, cur) {
  const sha = pr.headRefOid;
  const now = Date.now();
  if (cur.head?.sha !== sha) cur.head = { sha, since: now };
  const events = [];
  const all = (pr.statusCheckRollup ?? []).map(checkOf);
  const checks = all.filter((c) => !IGNORED.has(c.name));
  const failed = checks.filter((c) => c.state === "failed");
  const pending = checks.filter((c) => c.state === "pending");
  // A name counts as passed only when none of its runs failed: a workflow on push and on pull_request, or a matrix.
  const passed = new Set(checks.filter((c) => c.state === "passed" && !failed.some((x) => x.name === c.name)).map((c) => c.name));
  const escalate = [];
  // An issue counts one attempt per head commit it fails on, and starts again once it is fixed:
  // only pushes that fail in a row count. A check still running on a new head keeps its count.
  for (const issue of Object.keys(cur.attempts)) {
    if (issue.startsWith("check: ") && passed.has(issue.slice(7))) delete cur.attempts[issue];
  }
  if (pr.mergeable === "MERGEABLE") delete cur.attempts.conflict;
  const attempt = (issue) => {
    const shas = new Set(cur.attempts[issue] ?? []);
    shas.add(sha);
    cur.attempts[issue] = [...shas];
    if (shas.size >= MAX_PUSHES) escalate.push({ issue, pushes: shas.size });
  };

  if (pr.state === "MERGED") events.push("merged");
  else if (pr.state === "CLOSED") events.push("closed");

  const rc = cur.reported.checks ?? {};
  const before = new Set(rc.sha === sha ? rc.keys ?? [] : []);
  if (pr.state === "OPEN" && failed.some((c) => !before.has(failureKey(c)))) {
    events.push("checks_failed");
    for (const c of failed) attempt(`check: ${c.name}`);
    cur.reported.checks = { sha, keys: [...before, ...failed.map(failureKey).filter((k) => !before.has(k))] };
  }
  if (pr.state === "OPEN" && pr.mergeable === "CONFLICTING" && cur.reported.conflict !== sha) {
    events.push("conflict");
    attempt("conflict");
    cur.reported.conflict = sha;
  }

  // The base moved and the branch must be up to date before it can merge.
  if (pr.state === "OPEN" && pr.mergeStateStatus === "BEHIND" && cur.reported.behind !== sha) {
    events.push("behind");
    cur.reported.behind = sha;
  }

  const seen = new Set(cur.seen);
  const fresh = items.filter((i) => !seen.has(i.key));
  for (const i of fresh) seen.add(i.key);
  cur.seen = [...seen];
  // The marker alone proves nothing: anyone can type it. Only the signed-in account's replies are skipped.
  const own = (i) => (i.body ?? "").includes(MARK) && me() !== null && (i.user?.login ?? "").toLowerCase() === me();
  const comments = fresh.filter((i) => !own(i)).sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .map(({ key, user, assoc, body, ...rest }) => ({ id: Number(key.slice(1)), author: user?.login ?? "ghost", ...trustOf(user, assoc), ...rest, body: clip(body) }));
  if (comments.length) events.push("comments");

  // Ready: GitHub says the PR can merge with every check green (CLEAN), or with only ignored checks not green
  // (UNSTABLE). Before the first check reports, the PR is not ready: a repository with workflows waits for
  // one, and one without waits SETTLE after the head changes for an outside CI.
  const notGreenIgnoredOnly = all.filter((c) => c.state !== "passed").every((c) => IGNORED.has(c.name));
  const mergeState = /^(CLEAN|HAS_HOOKS)$/.test(pr.mergeStateStatus) || (pr.mergeStateStatus === "UNSTABLE" && notGreenIgnoredOnly);
  const blockingReview = pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED";
  // Workflows that never run on pull requests (only on a push to main) report nothing: after a longer wait the
  // PR counts as started anyway.
  const started = all.length > 0 || (pr.state === "OPEN" && now - cur.head.since >= (workflows() === 0 ? SETTLE : SETTLE_WORKFLOWS));
  if (pr.state === "OPEN" && !pr.isDraft && mergeState && !failed.length && !pending.length && !blockingReview && started && cur.reported.ready !== sha) {
    events.push("ready");
    cur.reported.ready = sha;
  }

  return {
    pr: pr.number, url: pr.url, state: pr.state, events,
    branch: pr.headRefName, base: pr.baseRefName, head: sha.slice(0, 12),
    mergeable: pr.mergeable, mergeState: pr.mergeStateStatus, reviewDecision: pr.reviewDecision || null, draft: pr.isDraft,
    checks: { passed: passed.size, pending: pending.map((c) => c.name), failed: failed.map(({ state, ...c }) => c) },
    ...(escalate.length ? { escalate } : {}),
    comments,
    ...(me() === null ? { login: "unknown: replies marked by the orchestrator are reported as comments" } : {}),
  };
}

// ---------- loop

const print = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => (e.stderr?.toString() || e.message || String(e)).trim().split(/\r?\n/).slice(-3).join(" ");

const deadline = Date.now() + FOR;
let failures = 0;
let file = null;
let cur = null;
for (;;) {
  let snap;
  try { snap = poll(); failures = 0; }
  catch (e) {
    failures++;
    if (ONCE || failures >= 3) { print({ pr: REF, events: ["error"], error: errText(e) }); process.exit(1); }
    await sleep(Math.min(EVERY, 30000));
    continue;
  }
  if (!cur) {
    file = cursorPath(snap.pr.number);
    if (!file && !ONCE) { console.error("watch-pr: not inside a repository; pass --cursor <file>."); process.exit(2); }
    cur = file ? loadCursor(file) : {};
    cur.reported ??= {}; cur.attempts ??= {}; cur.seen ??= [];
  }
  const out = evaluate(snap, cur);
  const timeUp = Date.now() + EVERY > deadline;
  if (out.events.length || ONCE || timeUp) {
    if (!out.events.length && !ONCE) out.events.push("timeout");
    if (out.escalate && !out.events.includes("escalate")) out.events.push("escalate");
    if (!ONCE) {
      const dir = path.dirname(file);
      mkdirSync(dir, { recursive: true });
      // The cursors are this machine's state, never the repository's.
      if (!opt("--cursor", null) && !existsSync(path.join(dir, ".gitignore"))) writeFileSync(path.join(dir, ".gitignore"), "*\n");
      writeFileSync(file, JSON.stringify({ pr: snap.pr.number, ...cur }, null, 1) + "\n");
      out.cursor = file;
    }
    print(out);
    process.exit(0);
  }
  await sleep(EVERY);
}
