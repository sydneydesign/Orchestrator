#!/usr/bin/env node
// Reflect a repository's stories in gg-ez.
//
//   node <plugin>/skills/stories/scripts/reflect.mjs [--source <name>] [--tests] [--dry-run]
//
// Run it inside the repository. It reads `node <storiesDir>/stories.mjs --json`, turns each story into a piece of
// gg-ez's reflection format, asks git and gh which stories have a branch or an open pull request, and posts the
// reflection to gg-ez with the project's reflection key. gg-ez creates, changes and cancels the project's tasks to
// match, and answers how many.
//
//   --source <name>  the source name, when it is not the repository's folder name. It must be the key's source.
//   --tests          run the project's tests first (`stories.mjs --tests`), so each state matches the map. Without
//                    it, the last saved test results count, and with none, criteria with tests are unverified.
//   --dry-run        print what would be sent, by state, and send nothing. Needs no key.
//
// Settings come only from the environment, never from a file or an argument, and neither is printed:
//   GGEZ_URL  gg-ez's address, https (http only for this machine).
//   GGEZ_KEY  the project's reflection key, generated once in gg-ez under Settings › Projects › <project>.
//
// A story's state, in this order: discarded → Cancelado; works → Hecho; an open pull request from a branch with its
// ID → En revisión; a branch with its ID on origin, or partial → En curso; anything else → Por hacer. Each travels
// as its gg-ez state type and name.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** gg-ez's title limit, in UTF-16 units: it measures with JavaScript's `length`. */
const TITLE_LIMIT = 200;

const STATES = {
  canceled: { tipo: "canceled", estado: "Cancelado" },
  completed: { tipo: "completed", estado: "Hecho" },
  review: { tipo: "started", estado: "En revisión" },
  started: { tipo: "started", estado: "En curso" },
  unstarted: { tipo: "unstarted", estado: "Por hacer" },
};

/** A source name as gg-ez takes it: lowercase letters, digits and single hyphens, up to 40 characters. */
const SOURCE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Does a branch name carry this story ID as a whole word? `x/ALT-001-smoke` does; `x/ALT-0011` does not. */
export function hasId(branch, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![0-9])`).test(branch);
}

/** The gg-ez state of a story: its type and its name. See the order in the header. */
export function pieceState(story, branches, prBranches) {
  if (story.discarded || story.status === "discarded") return { ...STATES.canceled };
  if (story.status === "works") return { ...STATES.completed };
  if (prBranches.some((branch) => hasId(branch, story.id))) return { ...STATES.review };
  if (story.status === "partial" || branches.some((branch) => hasId(branch, story.id))) {
    return { ...STATES.started };
  }
  return { ...STATES.unstarted };
}

/** The title as gg-ez stores it: one line, trimmed, and cut with an ellipsis if it is too long. */
export function titleFor(title) {
  const line = String(title).replace(/\r\n|\r|\n/g, " ").trim();
  if (line.length <= TITLE_LIMIT) return line;
  let cut = "";
  for (const char of line) {
    if (cut.length + char.length > TITLE_LIMIT - 1) break;
    cut += char;
  }
  return `${cut.trimEnd()}…`;
}

/** The reflection to send: the source and one piece per story. Pure: everything it needs comes in. */
export function reflectionOf({ source, stories, activities, branches, prBranches, repo, storiesDir }) {
  const groups = new Map(activities.map((activity) => [activity.code, activity.name]));
  return {
    origen: source,
    piezas: stories.map((story) => {
      const piece = {
        clave: story.id,
        titulo: titleFor(story.title),
        ...pieceState(story, branches, prBranches),
      };
      if (repo) {
        const file = [storiesDir, story.file].join("/").split("/").map(encodeURIComponent).join("/");
        piece.enlace = `${repo.url}/blob/${encodeURI(repo.defaultBranch)}/${file}`;
      }
      const group = groups.get(story.code);
      if (typeof group === "string" && group.trim()) piece.grupo = group;
      return piece;
    }),
  };
}

/** Where to send and with what key, from the environment. Errors never repeat either value. */
export function readSettings(env) {
  const missing = ["GGEZ_URL", "GGEZ_KEY"].filter((name) => !String(env[name] ?? "").trim());
  if (missing.length) {
    return { ok: false, error: `Missing ${missing.join(" and ")} in the environment. Nothing was sent.` };
  }
  let url;
  try {
    url = new URL(String(env.GGEZ_URL).trim());
  } catch {
    return { ok: false, error: "GGEZ_URL is not an address. Nothing was sent." };
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return {
      ok: false,
      error: "GGEZ_URL must use https (http only for this machine): the key would travel in the clear. Nothing was sent.",
    };
  }
  return { ok: true, endpoint: new URL("/api/reflejo", url).href, key: String(env.GGEZ_KEY).trim() };
}

/** What to say about gg-ez's answer, and whether it worked. */
export function reportOf(pieces, status, body) {
  if (status === 200 && body?.ok === true) {
    return {
      ok: true,
      text: `Reflected ${pieces} pieces in gg-ez: created ${body.creadas}, changed ${body.cambiadas}, canceled ${body.canceladas}.`,
    };
  }
  const reason = typeof body?.error === "string" && body.error ? body.error : "no reason given";
  const hints = {
    401: " Check GGEZ_KEY: the key may be retired or mistyped.",
    403: " The key belongs to another source: run with --source <the key's source>.",
    503: " gg-ez cannot check keys right now.",
  };
  return { ok: false, text: `gg-ez rejected the reflection (HTTP ${status}): ${reason}.${hints[status] ?? ""}` };
}

// ---------- The command

function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options }).trim();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function gitHubRepo(remote) {
  const match = remote.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

async function main(argv) {
  const args = argv.slice(2);
  const option = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const dryRun = args.includes("--dry-run");

  let root;
  try {
    root = run("git", ["rev-parse", "--show-toplevel"]);
  } catch {
    fail("Run it inside a git repository. Nothing was sent.");
  }

  let storiesDir = "product";
  const configFile = path.join(root, ".orchestrator.json");
  if (existsSync(configFile)) {
    try {
      storiesDir = JSON.parse(readFileSync(configFile, "utf8")).storiesDir ?? storiesDir;
    } catch {
      fail(".orchestrator.json is not valid JSON. Nothing was sent.");
    }
  }
  const script = path.join(root, storiesDir, "stories.mjs");
  if (!existsSync(script)) fail(`There is no ${storiesDir}/stories.mjs in this repository. Nothing was sent.`);

  if (args.includes("--tests")) {
    try {
      execFileSync(process.execPath, [script, "--tests", "--summary"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
    } catch (error) {
      // Failing tests exit 1 and still leave their results; 2 means there are no results to read.
      if (error.status !== 1) fail("stories.mjs --tests could not run the tests. Nothing was sent.");
    }
  }

  let data;
  try {
    data = JSON.parse(run(process.execPath, [script, "--json"], { cwd: root }));
  } catch (error) {
    // stories.mjs prints its JSON and exits 1 when it found problems: read them from its output.
    try {
      data = JSON.parse(String(error.stdout ?? ""));
    } catch {
      fail("stories.mjs --json did not answer with JSON. Nothing was sent.");
    }
  }
  if (data.errors?.length) {
    const first = data.errors.slice(0, 5).map((problem) => `  - ${problem}`).join("\n");
    fail(`stories.mjs found ${data.errors.length} problem(s); fix them first. Nothing was sent.\n${first}`);
  }
  const stories = Array.isArray(data.stories) ? data.stories : [];
  if (!stories.length) fail("There are no stories to reflect. Nothing was sent.");

  let activities = [];
  const activitiesFile = path.join(root, storiesDir, "activities.json");
  if (existsSync(activitiesFile)) {
    try {
      activities = JSON.parse(readFileSync(activitiesFile, "utf8"));
    } catch {
      fail(`${storiesDir}/activities.json is not valid JSON. Nothing was sent.`);
    }
  }

  const source = option("--source") ?? path.basename(root);
  if (!SOURCE.test(source) || source.length > 40) {
    fail(`"${source}" is not a source name gg-ez takes (lowercase letters, digits and hyphens): use --source <name>. Nothing was sent.`);
  }

  let remote = "";
  try {
    remote = run("git", ["remote", "get-url", "origin"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    // No origin: no branches, no pull requests, no links.
  }
  let branches = [];
  if (remote) {
    try {
      branches = run("git", ["ls-remote", "--heads", "origin"], { cwd: root })
        .split("\n")
        .map((line) => line.split("\trefs/heads/")[1])
        .filter(Boolean);
    } catch {
      fail("git could not list the branches on origin, so the states would be wrong. Nothing was sent.");
    }
  }
  let repo = null;
  let prBranches = [];
  const name = gitHubRepo(remote);
  if (name) {
    try {
      const view = JSON.parse(run("gh", ["repo", "view", name, "--json", "url,defaultBranchRef"], { cwd: root }));
      repo = { url: view.url, defaultBranch: view.defaultBranchRef?.name ?? "main" };
      prBranches = JSON.parse(
        run("gh", ["pr", "list", "--repo", name, "--state", "open", "--limit", "1000", "--json", "headRefName"], { cwd: root }),
      ).map((pr) => pr.headRefName);
    } catch {
      fail("gh could not read the repository or its pull requests (is it installed and signed in?), so the states would be wrong. Nothing was sent.");
    }
  }

  const reflection = reflectionOf({ source, stories, activities, branches, prBranches, repo, storiesDir });
  const cut = stories.filter((story) => titleFor(story.title) !== String(story.title).replace(/\r\n|\r|\n/g, " ").trim());
  for (const story of cut) console.warn(`${story.id}: its title is longer than gg-ez takes, and goes cut.`);
  const byState = new Map();
  for (const piece of reflection.piezas) byState.set(piece.estado, (byState.get(piece.estado) ?? 0) + 1);
  const summary = [...byState].map(([state, count]) => `${state} ${count}`).join(", ");
  console.log(`${reflection.piezas.length} pieces from "${source}": ${summary}.`);
  if (dryRun) {
    console.log("Nothing was sent (--dry-run).");
    return;
  }

  const settings = readSettings(process.env);
  if (!settings.ok) fail(settings.error);
  let response;
  try {
    response = await fetch(settings.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${settings.key}`, "content-type": "application/json" },
      body: JSON.stringify(reflection),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    fail(`Could not reach gg-ez (${error?.cause?.code ?? error?.name ?? "network error"}). Nothing changed there.`);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    // The report says "no reason given".
  }
  const report = reportOf(reflection.piezas.length, response.status, body);
  if (!report.ok) fail(report.text);
  console.log(report.text);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
const self = fileURLToPath(import.meta.url);
if (process.platform === "win32" ? invoked.toLowerCase() === self.toLowerCase() : invoked === self) {
  await main(process.argv);
}
