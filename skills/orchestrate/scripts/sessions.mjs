#!/usr/bin/env node
// orchestrator sessions. Every session in a project with .orchestrator.json is an orchestrator, wherever it was
// opened: the main checkout or any linked worktree. They share two things, kept in the repository's common git
// folder (<git common dir>/orchestrator/), outside every branch, so every worktree sees the same copy:
//   - state.md: the shared ledger. Each session keeps its own section and reads the others.
//   - claims.json: which session works in which linked worktree. The guard claims a worktree for the session
//     that first edits or commits there, and blocks another live session there. A claim ends when its session
//     ends, or after CLAIM_HOURS without activity.
// The main checkout is never claimed: nobody switches it or commits on its protected branch.
//
//   node sessions.mjs ledger            print the shared ledger's path
//   node sessions.mjs claims            list the live claims
//   node sessions.mjs release <folder>  end the claim on a worktree, so another session can work there.
//                                       Only on the human's word: the guard asks them to confirm.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLAIM_HOURS = 2;
// A claim is written again only when it is older than this, so most tool calls read and do not write.
const REFRESH_MS = 60e3;

const realpathIf = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
const norm = (p) => { const r = realpathIf(p); return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r; };

/** The repository's common git folder (shared by every worktree), or null outside a repository. */
export function commonDir(dir) {
  try {
    const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return out ? path.resolve(out) : null;
  } catch {
    try { return path.resolve(dir, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim()); }
    catch { return null; }
  }
}

export function sharedDir(dir) { const c = commonDir(dir); return c ? path.join(c, "orchestrator") : null; }

/**
 * The shared ledger's path. The first time, it starts from the tracked .orchestrator/state.md of the main
 * checkout (projects before 0.16.0 kept it there), so no work in progress is lost.
 */
export function ledgerPath(dir, mainCheckout, stateDir = ".orchestrator") {
  const shared = sharedDir(dir);
  if (!shared) return null;
  const file = path.join(shared, "state.md");
  if (!existsSync(file)) {
    try {
      mkdirSync(shared, { recursive: true });
      const old = mainCheckout ? path.join(mainCheckout, stateDir, "state.md") : null;
      if (old && existsSync(old)) copyFileSync(old, file);
      else writeFileSync(file, "# Orchestrator ledger\n\nOne section per session: `## <topic> (<branch or folder>)`. Edit only your own section.\n");
    } catch { /* read-only: the caller reports the path anyway */ }
  }
  return file;
}

const claimsFile = (dir) => { const s = sharedDir(dir); return s ? path.join(s, "claims.json") : null; };

export function readClaims(dir) {
  const f = claimsFile(dir);
  if (!f || !existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, "")) ?? {}; } catch { return {}; }
}

function writeClaims(dir, claims) {
  const f = claimsFile(dir);
  if (!f) return;
  try {
    mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(claims, null, 2));
    renameSync(tmp, f);
  } catch { /* a claim that cannot be written protects nothing, and blocks nothing */ }
}

export const isLive = (c, now = Date.now()) => Boolean(c) && now - Date.parse(c.at) < CLAIM_HOURS * 3600e3;

/** Live claims, keyed by worktree folder. */
export function liveClaims(dir) {
  return Object.fromEntries(Object.entries(readClaims(dir)).filter(([, c]) => isLive(c)));
}

/**
 * Claims a linked worktree for a session. Returns null when the session may work there (the claim is now its
 * own), or the other session's live claim. A folder outside every linked worktree is never claimed.
 */
export function claim(worktree, session, branch) {
  if (!worktree || !session) return null;
  const k = norm(worktree);
  const claims = readClaims(worktree);
  const c = claims[k];
  const now = Date.now();
  if (c && c.session !== session && isLive(c, now)) return c;
  if (c && c.session === session && now - Date.parse(c.at) < REFRESH_MS && c.branch === branch) return null;
  claims[k] = { session, folder: worktree, branch: branch ?? null, at: new Date(now).toISOString(), since: c?.session === session ? c.since : new Date(now).toISOString() };
  writeClaims(worktree, claims);
  return null;
}

/** Ends every claim of a session (its SessionEnd), or the claim on one folder. */
export function release(dir, { session, folder } = {}) {
  const claims = readClaims(dir);
  let n = 0, stale = 0;
  for (const [k, c] of Object.entries(claims)) {
    if ((session && c.session === session) || (folder && k === norm(folder))) { delete claims[k]; n++; }
    else if (!isLive(c)) { delete claims[k]; stale++; }
  }
  if (n || stale) writeClaims(dir, claims);
  return n;
}

export const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60e3); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

// ---------- command line
if (process.argv[1] && realpathIf(process.argv[1]) === realpathIf(fileURLToPath(import.meta.url))) {
  const [cmd, arg] = process.argv.slice(2);
  const here = process.cwd();
  if (cmd === "ledger") {
    let main = null;
    try { main = /^worktree (.+)$/m.exec(execFileSync("git", ["worktree", "list", "--porcelain"], { stdio: ["ignore", "pipe", "ignore"] }).toString())?.[1] ?? null; } catch {}
    const p = ledgerPath(here, main);
    if (!p) { console.error("sessions: not inside a git repository."); process.exit(1); }
    console.log(p);
  } else if (cmd === "claims") {
    const live = Object.values(liveClaims(here));
    if (!live.length) console.log("No worktree is claimed.");
    for (const c of live) console.log(`${c.folder}  ${c.branch ?? "(detached)"}  session ${c.session}, active ${ago(c.at)}`);
  } else if (cmd === "release" && arg) {
    const n = release(here, { folder: path.resolve(here, arg) });
    console.log(n ? `Released ${path.resolve(here, arg)}.` : "No claim on that folder.");
  } else {
    console.error("usage: node sessions.mjs ledger | claims | release <folder>");
    process.exit(2);
  }
}
