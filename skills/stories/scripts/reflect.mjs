#!/usr/bin/env node
// Reflect a repository's stories in gg-ez.
//
//   node <plugin>/skills/stories/scripts/reflect.mjs [--source <name>] [--tests] [--dry-run] [--any-branch]
//
// Run it inside the repository, on the tip of its default branch. It reads `node <storiesDir>/stories.mjs --json`,
// turns each story into a piece of gg-ez's reflection format, asks git and gh which stories have a branch or an
// open pull request, and posts the reflection to gg-ez with the project's reflection key. gg-ez creates, changes and
// cancels the project's tasks to match, and answers how many.
//
//   --source <name>  the source name, when it is not the repository's folder name. It must be the key's source.
//   --tests          run the project's tests first (`stories.mjs --tests`), so each state matches the map. Without
//                    it, the last saved test results count, and with none, criteria with tests are unverified.
//   --dry-run        print how many pieces would go, by state, and send nothing. Needs no key.
//   --any-branch     send even when HEAD is not the tip of the default branch on origin, or the stories folder has
//                    uncommitted changes. The next run from the default branch puts gg-ez back to it.
//   --design         the state is the story's design phase, read from git (`designState`): ready/ → Hecho,
//                    lock/ → Pantallas aprobadas, explora/ or a commit in src/ that opens with the ID → Diseñando,
//                    the rest → Por diseñar. Reads the tags on origin; needs the whole history.
//   --alias NEW=OLD  with --design, a story's old IDs, comma-separated, count as its own. Repeatable.
//   --skip CODE      leave out the stories of that activity (gg-ez cancels their tasks). Repeatable.
//
// Settings come only from the environment, never from a file or an argument, and neither is printed nor passed to
// any program it runs (git, gh, the project's tests):
//   GGEZ_URL  gg-ez's address, https (http only for this machine).
//   GGEZ_KEY  the project's reflection key, generated once in gg-ez under Settings › Projects › <project>.
//
// A story's state, in this order: discarded → Cancelado; works → Hecho; an open pull request from a branch with its
// ID → En revisión; a branch with its ID on origin, or partial → En curso; anything else → Por hacer. Each travels
// as its gg-ez state type and name.
//
// A piece: { clave, titulo, tipo, estado, enlace?, grupo?, descripcion, enlaces }. `descripcion` is the story's
// story section (its heading is stories.config.json → labels.sections.story, «Historia» in Spanish) and then its
// criteria, one line each with its state (funciona, sin verificar, falla, sin construir), in plain text cut to 20 000
// characters; null when the story has neither, which clears the task's. `enlaces` is [{ nombre, enlace }], at most 10:
// «Prototipo» from the story's optional `prototype:` frontmatter key, then each URL in `screens:`, named «Figma»
// (figma.com), «Captura» (a png, jpg or webp) or «Pantalla», numbered when several share a kind. Only http and https
// addresses go; anything else is skipped, so gg-ez never refuses the reflection over a link.
//
// A project can decide the state itself: if a story in `stories.mjs --json` brings `reflect`, it wins. An object
// `{ tipo, estado }` goes as it is (tipo: backlog, unstarted, started, completed or canceled); `null` leaves the
// story out, and gg-ez cancels its task. A `reflect` with another shape stops the run, naming the story.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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

/** Variables no program it runs may see. The tests also lose the GitHub tokens. */
const SECRETS = ["GGEZ_URL", "GGEZ_KEY"];
const TOKENS = ["GH_TOKEN", "GITHUB_TOKEN"];

/** The options, or what is wrong with them. Anything unknown is refused: a typo must not send for real. */
export function parseArgs(args) {
  const options = {
    ok: true,
    source: null,
    tests: false,
    dryRun: false,
    anyBranch: false,
    design: false,
    aliases: new Map(),
    skip: [],
  };
  const flags = { "--tests": "tests", "--dry-run": "dryRun", "--any-branch": "anyBranch", "--design": "design" };
  const valueOf = (arg, name, at) => (arg === name ? [args[at + 1], at + 1] : [arg.slice(name.length + 1), at]);
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at];
    if (arg in flags) {
      options[flags[arg]] = true;
    } else if (arg === "--source" || arg.startsWith("--source=")) {
      const [value, next] = valueOf(arg, "--source", at);
      at = next;
      if (!value || value.startsWith("--")) return { ok: false, error: "--source needs a name." };
      options.source = value;
    } else if (arg === "--alias" || arg.startsWith("--alias=")) {
      const [value, next] = valueOf(arg, "--alias", at);
      at = next;
      const match = String(value ?? "").match(/^([^=\s]+)=([^=\s]+)$/);
      const olds = match ? match[2].split(",").filter(Boolean) : [];
      if (!match || !olds.length) return { ok: false, error: "--alias needs NEW=OLD or NEW=OLD,OLD." };
      if (options.aliases.has(match[1])) {
        return { ok: false, error: `--alias ${match[1]} comes twice: put all its old IDs in one, comma-separated.` };
      }
      options.aliases.set(match[1], olds);
    } else if (arg === "--skip" || arg.startsWith("--skip=")) {
      const [value, next] = valueOf(arg, "--skip", at);
      at = next;
      if (!value || value.startsWith("--")) return { ok: false, error: "--skip needs an activity code." };
      options.skip.push(value);
    } else {
      return {
        ok: false,
        error: `Unknown argument: ${arg}. Use --source <name>, --tests, --dry-run, --any-branch, --design, --alias NEW=OLD or --skip CODE.`,
      };
    }
  }
  return options;
}

/** The environment for a program it runs: never the address or the key, and no GitHub token for the tests. */
export function childEnv(env, { forTests = false } = {}) {
  const drop = new Set(forTests ? [...SECRETS, ...TOKENS] : SECRETS);
  return Object.fromEntries(Object.entries(env).filter(([name]) => !drop.has(name)));
}

/** `owner/name` of a GitHub remote, or null. Only github.com itself, not a lookalike. */
export function gitHubName(remote) {
  const match = String(remote).match(/(?:^|[@/])github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** A JSON file's text without the byte order mark some editors put at its start. */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The IDs of the stories without a title: gg-ez would reject the whole reflection for one of them. */
export function untitled(stories) {
  return stories.filter((story) => typeof story.title !== "string" || !story.title.trim()).map((story) => story.id);
}

/**
 * Why this checkout is not what should be reflected, or null. Only the tip of the default branch on origin, with
 * the stories folder clean: from anywhere else the reflection would undo itself at the next merge.
 */
export function headProblem({ head, tip, dirty, branch }) {
  if (!tip) return `Could not find origin/${branch} to compare with.`;
  if (head !== tip) return `HEAD is not the tip of origin/${branch}: pull, or switch to it.`;
  if (dirty) return "The stories folder has uncommitted changes.";
  return null;
}

/** Does a branch name carry this story ID as a whole word? `x/ALT-001-smoke` does; `x/ALT-0011` does not. */
export function hasId(branch, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![0-9])`).test(branch);
}

/** gg-ez's state types: a `reflect` with any other is refused before sending. */
const STATE_TYPES = new Set(["backlog", "unstarted", "started", "completed", "canceled"]);

/** Does the story bring its own `reflect` (an object, or null to leave it out)? */
const ownsReflect = (story) => Object.hasOwn(story, "reflect");

/**
 * The IDs of the stories whose own `reflect` gg-ez would not take: not null and not { tipo, estado } with a known type
 * and a name. One of them would reject the whole reflection, or move a task to the wrong column.
 */
export function badReflect(stories) {
  return stories
    .filter((story) => {
      if (!ownsReflect(story) || story.reflect === null) return false;
      const own = story.reflect;
      return (
        typeof own !== "object" ||
        !STATE_TYPES.has(own.tipo) ||
        typeof own.estado !== "string" ||
        !own.estado.trim()
      );
    })
    .map((story) => story.id);
}

/**
 * What is wrong with --skip and --alias for these stories: a code or a story that matches nothing (a typo would
 * send DEM to the board, or drop a story to Por diseñar), and an alias without --design, where it does nothing.
 */
export function optionProblems(stories, { skip, aliases, design }) {
  const codes = new Set(stories.map((story) => story.code));
  const ids = new Set(stories.map((story) => story.id));
  const problems = [];
  for (const code of skip) if (!codes.has(code)) problems.push(`--skip ${code} matches no activity`);
  if (aliases.size && !design) problems.push("--alias only counts with --design");
  else for (const id of aliases.keys()) if (!ids.has(id)) problems.push(`--alias ${id} matches no story`);
  return problems;
}

const DESIGN = {
  completed: { tipo: "completed", estado: "Hecho" },
  approved: { tipo: "started", estado: "Pantallas aprobadas" },
  designing: { tipo: "started", estado: "Diseñando" },
  todo: { tipo: "unstarted", estado: "Por diseñar" },
};

/**
 * The design phase of a story (--design), read from git; the first that matches wins. Discarded → Cancelado; a tag
 * ready/<ID> or ready/<ID>-N → Hecho; a tag lock/<ID>-… → Pantallas aprobadas; a branch explora/<ID>[-…], or a commit
 * that touches the code and whose subject or scope opens with the ID ("ALT-007: …", "feat(ALT-008, ALT-009): …") →
 * Diseñando; the rest → Por diseñar. <ID> is the story's ID or one of its old ones (`aliases`). Pure.
 */
export function designState(story, { tags, branches, subjects, aliases }) {
  if (story.discarded || story.status === "discarded") return { ...STATES.canceled };
  const escape = (id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const id = `(?:${[story.id, ...(aliases.get(story.id) ?? [])].map(escape).join("|")})`;
  const some = (list, pattern) => list.some((item) => pattern.test(item));
  if (some(tags, new RegExp(`^ready/${id}(?:-\\d+)?$`))) return { ...DESIGN.completed };
  if (some(tags, new RegExp(`^lock/${id}-`))) return { ...DESIGN.approved };
  if (
    some(branches, new RegExp(`^explora/${id}(?:-.*)?$`)) ||
    // The ID opens the subject ("ALT-007: …") or is one item of its scope ("feat(ui, ALT-008): …"), and ends there.
    some(subjects, new RegExp(`^(?:[\\w-]+\\((?:[^()]*?,\\s*)?)?${id}(?![A-Za-z0-9])`))
  ) {
    return { ...DESIGN.designing };
  }
  return { ...DESIGN.todo };
}

/**
 * The gg-ez state of a story: its type and its name. A story that brings its own `reflect` goes as it says; with
 * `design` (--design), its design phase; otherwise, the order in the header.
 */
export function pieceState(story, branches, prBranches, design = null) {
  if (ownsReflect(story) && story.reflect !== null) {
    return { tipo: story.reflect.tipo, estado: story.reflect.estado.trim() };
  }
  if (design) return designState(story, design);
  if (story.discarded || story.status === "discarded") return { ...STATES.canceled };
  if (story.status === "works") return { ...STATES.completed };
  if (prBranches.some((branch) => hasId(branch, story.id))) return { ...STATES.review };
  if (story.status === "partial" || branches.some((branch) => hasId(branch, story.id))) {
    return { ...STATES.started };
  }
  return { ...STATES.unstarted };
}

/** A text cut to `limit` UTF-16 units with an ellipsis, by whole characters, or the text if it fits. */
function cutTo(text, limit) {
  if (text.length <= limit) return text;
  let cut = "";
  for (const char of text) {
    if (cut.length + char.length > limit - 1) break;
    cut += char;
  }
  return `${cut.trimEnd()}…`;
}

/** The title as gg-ez stores it: one line, trimmed, and cut with an ellipsis if it is too long. */
export function titleFor(title) {
  return cutTo(String(title).replace(/\r\n|\r|\n/g, " ").trim(), TITLE_LIMIT);
}

// ---------- What the task says and links to (descripcion, enlaces)

/** gg-ez's limits for a piece's description and links, in UTF-16 units. A link's address has the cap of `enlace`. */
const DESCRIPTION_LIMIT = 20_000;
const LINKS_LIMIT = 10;
const LINK_NAME_LIMIT = 60;
const LINK_URL_LIMIT = 2000;

/** Control, format (zero-width, bidi) and line or paragraph separator characters: gg-ez refuses them in a name. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** The labels stories.mjs uses when the project sets none (stories.config.json → labels). */
export const DEFAULT_LABELS = {
  story: "Story",
  criteria: "Acceptance criteria",
  markers: ["test", "manual", "unverified", "unbuilt", "failing"],
};

const lf = (text) => String(text ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A story file's frontmatter lines and body, split as stories.mjs splits them. No frontmatter: no lines. */
function splitStory(text) {
  const match = lf(text).match(/^---\n([\s\S]*?)\n?---\n?([\s\S]*)$/);
  return match ? { front: match[1].split("\n"), body: match[2] } : { front: [], body: lf(text) };
}

/**
 * The text of a story's section, between its `## <heading>` (any case) and the next `## `, without HTML comments,
 * trimmed; "" when the story has no such section. Pure.
 */
export function storySection(text, heading) {
  const wanted = String(heading).trim().toLowerCase();
  for (const part of splitStory(text).body.split(/^## /m).slice(1)) {
    const newline = part.indexOf("\n");
    if ((newline < 0 ? part : part.slice(0, newline)).trim().toLowerCase() !== wanted) continue;
    return (newline < 0 ? "" : part.slice(newline + 1))
      .replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*(?:\n|$)/gm, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return "";
}

/** The story's `prototype:` frontmatter key, read as stories.mjs reads a key, or null: a list or nothing is no address. */
export function prototypeOf(text) {
  for (const line of splitStory(text).front) {
    const pair = line.match(/^prototype:\s*(.*?)\s*(\s#.*)?$/);
    if (!pair) continue;
    const value = pair[1].trim().replace(/^(["'])(.*)\1$/, "$2").trim();
    return value && !value.startsWith("[") ? value : null;
  }
  return null;
}

/**
 * A criterion's state in gg-ez's words, the way stories.mjs counts it for the story's status: a test by its last
 * result (pass → funciona, fail → falla, none → sin verificar), manual → funciona, and the marker's own state.
 */
export function criterionState(criterion) {
  if (criterion.kind === "test") return { pass: "funciona", fail: "falla" }[criterion.result] ?? "sin verificar";
  return { manual: "funciona", failing: "falla", unbuilt: "sin construir" }[criterion.kind] ?? "sin verificar";
}

/** One criterion as a plain line: `- <ID> (<state>) <rule>`, without the `**ID**` bold or the `[marker]` at its end. */
function criterionLine(criterion, markers) {
  const known = new RegExp(
    `\\s*\\[(?:${markers.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}]).*\\]\\s*$`,
    "iu",
  );
  const rule = String(criterion.head ?? "")
    .replace(/^\*\*[^*]+\*\*\s*/, "")
    .replace(known.test(String(criterion.head ?? "")) ? known : /\s*\[[^\]]+\]\s*$/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .trim();
  return `- ${criterion.id} (${criterionState(criterion)}) ${rule}`.trimEnd();
}

/**
 * The description of a story's task: its «Historia» section (the heading is the project's label), then its criteria,
 * one per line with its state. Plain text with line breaks, cut to gg-ez's limit. null when the story has neither,
 * which clears the task's description. Pure.
 */
export function descriptionOf({ text, criteria, labels = DEFAULT_LABELS }) {
  const parts = [];
  const story = storySection(text, labels.story);
  if (story) parts.push(story);
  if (criteria?.length) {
    parts.push([labels.criteria, ...criteria.map((criterion) => criterionLine(criterion, labels.markers))].join("\n"));
  }
  // A NUL byte would make gg-ez refuse the whole reflection (jsonb cannot store it), so it never leaves here.
  return parts.length ? cutTo(parts.join("\n\n").replaceAll("\u0000", ""), DESCRIPTION_LIMIT) : null;
}

/** The address as gg-ez takes it, normalised, or null: http or https only, within the cap of an address. */
function linkUrl(value) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.href.length <= LINK_URL_LIMIT ? url.href : null;
}

/** Would gg-ez take this link? A name of 1 to 60 once trimmed, with no control or invisible characters, and an address. */
export function validLink(link) {
  const name = typeof link?.nombre === "string" ? link.nombre.trim() : "";
  return (
    name.length >= 1 &&
    name.length <= LINK_NAME_LIMIT &&
    !INVISIBLE.test(name) &&
    linkUrl(link.enlace) !== null
  );
}

/** What a screen is: Figma for figma.com, Captura for an image, Pantalla otherwise. */
function screenKind(href) {
  const url = new URL(href);
  if (url.hostname === "figma.com" || url.hostname.endsWith(".figma.com")) return "Figma";
  return /\.(?:png|jpe?g|webp)$/i.test(url.pathname) ? "Captura" : "Pantalla";
}

/**
 * The task's links: the prototype first («Prototipo»), then each screen named by its kind, numbered when there are
 * several of a kind («Figma 1», «Figma 2»). Anything not http or https, or too long, is skipped; never more than 10. Pure.
 */
export function linksOf({ prototype, screens }) {
  const kept = [];
  const prototypeUrl = linkUrl(prototype);
  if (prototypeUrl) kept.push({ kind: "Prototipo", enlace: prototypeUrl });
  for (const screen of screens ?? []) {
    const href = linkUrl(screen);
    if (href) kept.push({ kind: screenKind(href), enlace: href });
  }
  const links = kept.slice(0, LINKS_LIMIT);
  const total = new Map();
  for (const { kind } of links) total.set(kind, (total.get(kind) ?? 0) + 1);
  const seen = new Map();
  return links
    .map(({ kind, enlace }) => {
      seen.set(kind, (seen.get(kind) ?? 0) + 1);
      return { nombre: total.get(kind) > 1 ? `${kind} ${seen.get(kind)}` : kind, enlace };
    })
    .filter(validLink);
}

/** The reflection to send: the source and one piece per story. Pure: everything it needs comes in. */
export function reflectionOf({
  source,
  stories,
  activities,
  branches,
  prBranches,
  repo,
  storiesDir,
  design = null,
  skip = [],
  files = null,
  labels = DEFAULT_LABELS,
}) {
  const groups = new Map(activities.map((activity) => [activity.code, activity.name]));
  // Left out, so gg-ez cancels the task they had: a story with `reflect: null`, and an activity in --skip.
  const leftOut = (story) => (ownsReflect(story) && story.reflect === null) || skip.includes(story.code);
  return {
    origen: source,
    piezas: stories.filter((story) => !leftOut(story)).map((story) => {
      const piece = {
        clave: story.id,
        titulo: titleFor(story.title),
        ...pieceState(story, branches, prBranches, design),
      };
      if (repo) {
        const file = [storiesDir, story.file].join("/").split("/").map(encodeURIComponent).join("/");
        piece.enlace = `${repo.url}/blob/${encodeURI(repo.defaultBranch)}/${file}`;
      }
      const group = groups.get(story.code);
      if (typeof group === "string" && group.trim()) piece.grupo = group;
      // With the story files (`files`: ID → the file's text), the task's description and links come too.
      if (files) {
        const text = files.get(story.id) ?? "";
        piece.descripcion = descriptionOf({ text, criteria: story.criteria ?? [], labels });
        piece.enlaces = linksOf({ prototype: prototypeOf(text), screens: story.screens ?? [] });
      }
      return piece;
    }),
  };
}

/** Where to send and with what key, from the environment. Errors never repeat either value. */
export function readSettings(env) {
  const missing = SECRETS.filter((name) => !String(env[name] ?? "").trim());
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
  return execFileSync(file, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: childEnv(process.env),
    ...options,
  }).trim();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(file, label) {
  try {
    return JSON.parse(stripBom(readFileSync(file, "utf8")));
  } catch {
    return fail(`${label} is not valid JSON. Nothing was sent.`);
  }
}

async function main(argv) {
  const options = parseArgs(argv.slice(2));
  if (!options.ok) fail(options.error);

  // The settings first: without them there is no point running the tests, git or gh.
  const settings = options.dryRun ? null : readSettings(process.env);
  if (settings && !settings.ok) fail(settings.error);

  let root;
  try {
    root = run("git", ["rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    fail("Run it inside a git repository. Nothing was sent.");
  }

  let storiesDir = "product";
  for (const name of [".orchestrator.json", ".orquestador.json"]) {
    const file = path.join(root, name);
    if (existsSync(file)) {
      storiesDir = readJson(file, name).storiesDir ?? storiesDir;
      break;
    }
  }
  const script = path.join(root, storiesDir, "stories.mjs");
  if (!existsSync(script)) fail(`There is no ${storiesDir}/stories.mjs in this repository. Nothing was sent.`);

  const source = options.source ?? path.basename(root);
  if (!SOURCE.test(source) || source.length > 40) {
    fail(`"${source}" is not a source name gg-ez takes (lowercase letters, digits and hyphens): use --source <name>. Nothing was sent.`);
  }

  let remote = "";
  try {
    remote = run("git", ["remote", "get-url", "origin"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    // No origin: no branches, no pull requests, no links, and nothing to compare HEAD with.
  }
  let repo = null;
  let prBranches = [];
  const name = gitHubName(remote);
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

  let branches = [];
  const tips = new Map();
  if (remote) {
    try {
      for (const line of run("git", ["ls-remote", "--heads", "origin"], { cwd: root }).split("\n")) {
        const [sha, ref] = line.split("\trefs/heads/");
        if (ref) {
          branches.push(ref);
          tips.set(ref, sha);
        }
      }
    } catch {
      fail("git could not list the branches on origin, so the states would be wrong. Nothing was sent.");
    }
    let defaultBranch = repo?.defaultBranch ?? null;
    if (!defaultBranch) {
      try {
        defaultBranch = run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
          cwd: root,
          stdio: ["ignore", "pipe", "ignore"],
        }).replace(/^origin\//, "");
      } catch {
        defaultBranch = "main";
      }
    }
    const problem = headProblem({
      head: run("git", ["rev-parse", "HEAD"], { cwd: root }),
      tip: tips.get(defaultBranch) ?? null,
      dirty: run("git", ["status", "--porcelain", "--", storiesDir], { cwd: root }) !== "",
      branch: defaultBranch,
    });
    if (problem && !options.anyBranch) {
      fail(`${problem} Only the default branch is reflected, or the next run would undo this one. Use --any-branch to send anyway. Nothing was sent.`);
    }
    if (problem) console.warn(`${problem} Sending anyway (--any-branch).`);
  }

  // --design reads the design phase from git: the tags on origin, and the subjects of the commits that touch src/.
  let design = null;
  if (options.design) {
    if (!remote) fail("--design reads the tags on origin, and this repository has no origin. Nothing was sent.");
    try {
      if (run("git", ["rev-parse", "--is-shallow-repository"], { cwd: root }) === "true") {
        fail("--design needs the whole history, and this checkout is shallow (fetch-depth: 0). Nothing was sent.");
      }
      const tags = run("git", ["ls-remote", "--tags", "origin"], { cwd: root })
        .split("\n")
        .map((line) => line.split("\trefs/tags/")[1])
        .filter((tag) => tag && !tag.endsWith("^{}"));
      const subjects = run("git", ["log", "--format=%s", "HEAD", "--", "src/"], { cwd: root })
        .split("\n")
        .filter(Boolean);
      design = { tags, branches, subjects, aliases: options.aliases };
    } catch {
      fail("git could not read the tags or the history, so the design phases would be wrong. Nothing was sent.");
    }
  }

  if (options.tests) {
    try {
      execFileSync(process.execPath, [script, "--tests", "--summary"], {
        cwd: root,
        stdio: ["ignore", "ignore", "inherit"],
        env: childEnv(process.env, { forTests: true }),
      });
    } catch {
      // With --summary, failing tests still exit 0; anything else is a validation problem or no results, and the
      // `--json` read below reports it.
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
  const withoutTitle = untitled(stories);
  if (withoutTitle.length) fail(`These stories have no title: ${withoutTitle.join(", ")}. Nothing was sent.`);
  const wrongOptions = optionProblems(stories, options);
  if (wrongOptions.length) fail(`${wrongOptions.join("; ")}. Nothing was sent.`);
  const wrongReflect = badReflect(stories);
  if (wrongReflect.length) {
    fail(`These stories bring a reflect gg-ez would not take: ${wrongReflect.join(", ")}. Nothing was sent.`);
  }

  const activitiesFile = path.join(root, storiesDir, "activities.json");
  const activities = existsSync(activitiesFile) ? readJson(activitiesFile, `${storiesDir}/activities.json`) : [];

  // The section headings and markers in the project's language, as stories.mjs reads them.
  const configFile = path.join(root, storiesDir, "stories.config.json");
  const own = existsSync(configFile) ? readJson(configFile, `${storiesDir}/stories.config.json`)?.labels ?? {} : {};
  const markers = { test: "test", manual: "manual", unverified: "unverified", unbuilt: "unbuilt", failing: "failing", ...own.markers };
  const labels = {
    story: own.sections?.story ?? DEFAULT_LABELS.story,
    criteria: own.sections?.criteria ?? DEFAULT_LABELS.criteria,
    markers: Object.values(markers).filter((marker) => typeof marker === "string" && marker),
  };
  const files = new Map();
  for (const story of stories) {
    try {
      files.set(story.id, readFileSync(path.join(root, storiesDir, story.file), "utf8"));
    } catch {
      fail(`Could not read ${storiesDir}/${story.file}. Nothing was sent.`);
    }
  }

  const reflection = reflectionOf({
    source,
    stories,
    activities: Array.isArray(activities) ? activities : [],
    branches,
    prBranches,
    repo,
    storiesDir,
    design,
    skip: options.skip,
    files,
    labels,
  });
  for (const story of stories) {
    if (titleFor(story.title) !== story.title.replace(/\r\n|\r|\n/g, " ").trim()) {
      console.warn(`${story.id}: its title is longer than gg-ez takes, and goes cut.`);
    }
  }
  const byState = new Map();
  for (const piece of reflection.piezas) byState.set(piece.estado, (byState.get(piece.estado) ?? 0) + 1);
  const summary = [...byState].map(([state, count]) => `${state} ${count}`).join(", ");
  console.log(`${reflection.piezas.length} pieces from "${source}": ${summary}.`);
  const described = reflection.piezas.filter((piece) => piece.descripcion).length;
  const linked = reflection.piezas.filter((piece) => piece.enlaces?.length);
  const links = linked.reduce((sum, piece) => sum + piece.enlaces.length, 0);
  console.log(`${described} with a description, ${linked.length} with links (${links} links).`);
  if (options.dryRun) {
    console.log("Nothing was sent (--dry-run).");
    return;
  }

  let response;
  try {
    response = await fetch(settings.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${settings.key}`, "content-type": "application/json" },
      body: JSON.stringify(reflection),
      // A redirect would drop the key or turn the POST into a GET: say it instead of following it.
      redirect: "error",
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

// Run as a command, also through a symlink or a junction (argv keeps the link, import.meta.url the real path).
const real = (file) => {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};
const invoked = process.argv[1] ? real(process.argv[1]) : "";
const self = real(fileURLToPath(import.meta.url));
if (process.platform === "win32" ? invoked.toLowerCase() === self.toLowerCase() : invoked === self) {
  await main(process.argv);
}
