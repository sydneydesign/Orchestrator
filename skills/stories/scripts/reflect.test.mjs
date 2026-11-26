// Tests for reflect.mjs: the translation from `stories.mjs --json` to a gg-ez reflection, with no network and no
// database. Run with `node --test "skills/**/*.test.mjs"`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  badReflect,
  childEnv,
  gitHubName,
  hasId,
  headProblem,
  parseArgs,
  pieceState,
  readSettings,
  reflectionOf,
  reportOf,
  stripBom,
  titleFor,
  untitled,
} from "./reflect.mjs";

const story = (id, status, extra = {}) => ({
  id,
  title: `Title of ${id}`,
  code: id.slice(0, 3),
  status,
  discarded: status === "discarded",
  file: `stories/start/${id.toLowerCase()}-something.md`,
  ...extra,
});

const ACTIVITIES = [{ code: "ALT", name: "Empezar con el producto", folder: "start" }];

const REPO = { url: "https://github.com/owner/product", defaultBranch: "main" };

describe("reflect: a story becomes a piece", () => {
  it("each story is a piece: its ID is the key, its title the title, its activity the group", () => {
    const reflection = reflectionOf({
      source: "product",
      stories: [story("ALT-001", "pending")],
      activities: ACTIVITIES,
      branches: [],
      prBranches: [],
      repo: REPO,
      storiesDir: "producto",
    });
    assert.deepEqual(reflection, {
      origen: "product",
      piezas: [
        {
          clave: "ALT-001",
          titulo: "Title of ALT-001",
          tipo: "unstarted",
          estado: "Por hacer",
          enlace: "https://github.com/owner/product/blob/main/producto/stories/start/alt-001-something.md",
          grupo: "Empezar con el producto",
        },
      ],
    });
  });

  it("the state follows the story, in this order: discarded, works, open PR, branch or partial, the rest", () => {
    const state = (s, branches = [], prBranches = []) => pieceState(s, branches, prBranches);
    assert.deepEqual(state(story("ALT-001", "discarded"), ["x/ALT-001"], ["x/ALT-001"]), {
      tipo: "canceled",
      estado: "Cancelado",
    });
    assert.deepEqual(state(story("ALT-001", "works"), [], ["x/ALT-001"]), { tipo: "completed", estado: "Hecho" });
    // A partial story with an open PR from a branch with its ID is in review.
    assert.deepEqual(state(story("ALT-001", "partial"), ["sydney/ALT-001-smoke"], ["sydney/ALT-001-smoke"]), {
      tipo: "started",
      estado: "En revisión",
    });
    assert.deepEqual(state(story("ALT-001", "pending"), ["sydney/ALT-001-smoke"]), {
      tipo: "started",
      estado: "En curso",
    });
    assert.deepEqual(state(story("ALT-001", "partial")), { tipo: "started", estado: "En curso" });
    for (const status of ["pending", "unverified", "failing", "blocked"]) {
      assert.deepEqual(state(story("ALT-001", status)), { tipo: "unstarted", estado: "Por hacer" }, status);
    }
  });

  it("a story that brings its own `reflect` goes as it says: an object as its state, null not at all", () => {
    const reflection = reflectionOf({
      source: "product",
      stories: [
        story("ALT-001", "partial", { reflect: { tipo: "started", estado: "Pantallas aprobadas" } }),
        story("ALT-002", "works", { reflect: null }),
        story("ALT-003", "pending"),
      ],
      activities: [],
      branches: ["x/ALT-001"],
      prBranches: ["x/ALT-001"],
      repo: null,
      storiesDir: "producto",
    });
    assert.deepEqual(reflection.piezas, [
      { clave: "ALT-001", titulo: "Title of ALT-001", tipo: "started", estado: "Pantallas aprobadas" },
      { clave: "ALT-003", titulo: "Title of ALT-003", tipo: "unstarted", estado: "Por hacer" },
    ]);
  });

  it("a `reflect` that gg-ez would not take is named, instead of moving tasks by mistake", () => {
    const stories = [
      story("ALT-001", "partial", { reflect: { tipo: "started", estado: "Diseñando" } }),
      story("ALT-002", "partial", { reflect: { tipo: "doing", estado: "Diseñando" } }),
      story("ALT-003", "partial", { reflect: { tipo: "started", estado: " " } }),
      story("ALT-004", "partial", { reflect: "started" }),
      story("ALT-005", "partial", { reflect: null }),
      story("ALT-006", "partial"),
    ];
    assert.deepEqual(badReflect(stories), ["ALT-002", "ALT-003", "ALT-004"]);
  });

  it("a branch carries the ID as a whole word, not inside a longer one", () => {
    assert.equal(hasId("sydney/ALT-001-smoke", "ALT-001"), true);
    assert.equal(hasId("explore/ALT-001", "ALT-001"), true);
    assert.equal(hasId("ALT-001", "ALT-001"), true);
    assert.equal(hasId("sydney/ALT-0011-other", "ALT-001"), false);
    assert.equal(hasId("sydney/XALT-001", "ALT-001"), false);
    assert.equal(hasId("sydney/alt-001-smoke", "ALT-001"), false);
  });

  it("without a GitHub remote the piece has no link, and a story without activity no group", () => {
    const [pieza] = reflectionOf({
      source: "product",
      stories: [story("ZZZ-001", "works")],
      activities: ACTIVITIES,
      branches: [],
      prBranches: [],
      repo: null,
      storiesDir: "producto",
    }).piezas;
    assert.equal("enlace" in pieza, false);
    assert.equal("grupo" in pieza, false);
  });

  it("a title longer than gg-ez takes is cut with an ellipsis, by characters", () => {
    const long = "é".repeat(250);
    const cut = titleFor(long);
    assert.equal([...cut].length, 200);
    assert.ok(cut.endsWith("…"));
    assert.equal(titleFor("Short"), "Short");
    // New lines become spaces, as gg-ez stores them.
    assert.equal(titleFor("Two\nlines"), "Two lines");
  });
});

describe("reflect: settings come from the environment and are never printed", () => {
  const KEY = `ggez_${"a".repeat(64)}`;

  it("needs the address and the key", () => {
    for (const env of [{}, { GGEZ_URL: "https://gg.example" }, { GGEZ_KEY: KEY }]) {
      const settings = readSettings(env);
      assert.equal(settings.ok, false, JSON.stringify(Object.keys(env)));
      if (!settings.ok) {
        assert.match(settings.error, /GGEZ_/);
        assert.doesNotMatch(settings.error, /ggez_a|gg\.example/);
      }
    }
  });

  it("sends the key only over https, except to this machine", () => {
    assert.equal(readSettings({ GGEZ_URL: "http://gg.example", GGEZ_KEY: KEY }).ok, false);
    assert.equal(readSettings({ GGEZ_URL: "not a url", GGEZ_KEY: KEY }).ok, false);
    assert.deepEqual(readSettings({ GGEZ_URL: "https://gg.example/", GGEZ_KEY: KEY }), {
      ok: true,
      endpoint: "https://gg.example/api/reflejo",
      key: KEY,
    });
    assert.equal(readSettings({ GGEZ_URL: "http://localhost:3000", GGEZ_KEY: KEY }).ok, true);
  });
});

describe("reflect: what gg-ez answered", () => {
  it("says how many pieces went and what gg-ez created, changed and canceled", () => {
    const report = reportOf(3, 200, { ok: true, creadas: 1, cambiadas: 2, canceladas: 0 });
    assert.equal(report.ok, true);
    assert.match(report.text, /3 pieces/);
    assert.match(report.text, /created 1, changed 2, canceled 0/);
  });

  it("a rejection fails, with gg-ez's reason, and a wrong source says how to name it", () => {
    const rejected = reportOf(3, 422, { ok: false, error: "La pieza «ALT-001» no tiene clave" });
    assert.equal(rejected.ok, false);
    assert.match(rejected.text, /422/);
    assert.match(rejected.text, /ALT-001/);
    const otherSource = reportOf(3, 403, { ok: false, error: "Esta llave no es de ese origen" });
    assert.equal(otherSource.ok, false);
    assert.match(otherSource.text, /--source/);
  });
});

describe("reflect: arguments", () => {
  it("knows its options, in both forms, and refuses anything else", () => {
    const none = { ok: true, source: null, tests: false, dryRun: false, anyBranch: false };
    assert.deepEqual(parseArgs([]), none);
    assert.deepEqual(parseArgs(["--source", "easy-one", "--tests", "--dry-run", "--any-branch"]), {
      ok: true,
      source: "easy-one",
      tests: true,
      dryRun: true,
      anyBranch: true,
    });
    assert.deepEqual(parseArgs(["--source=easy-one"]), { ...none, source: "easy-one" });
    // A typo must not send for real, and a source without a value must not fall back to the folder.
    for (const bad of [["--dryrun"], ["--source"], ["--source", "--tests"], ["--source="], ["extra"]]) {
      assert.equal(parseArgs(bad).ok, false, bad.join(" "));
    }
  });
});

describe("reflect: what reaches other programs", () => {
  it("the address and the key never reach a child process, and the tests get no GitHub token", () => {
    const env = { PATH: "p", HOME: "h", GGEZ_URL: "u", GGEZ_KEY: "k", GH_TOKEN: "t", GITHUB_TOKEN: "g" };
    assert.deepEqual(childEnv(env), { PATH: "p", HOME: "h", GH_TOKEN: "t", GITHUB_TOKEN: "g" });
    assert.deepEqual(childEnv(env, { forTests: true }), { PATH: "p", HOME: "h" });
  });
});

describe("reflect: reading the repository", () => {
  it("recognises a GitHub remote, and only GitHub", () => {
    assert.equal(gitHubName("git@github.com:owner/repo.git"), "owner/repo");
    assert.equal(gitHubName("https://github.com/owner/repo"), "owner/repo");
    assert.equal(gitHubName("https://someone@github.com/owner/repo.git"), "owner/repo");
    assert.equal(gitHubName("ssh://git@github.com/owner/repo.git"), "owner/repo");
    assert.equal(gitHubName("https://evilgithub.com/owner/repo"), null);
    assert.equal(gitHubName("https://gitlab.com/owner/repo"), null);
    assert.equal(gitHubName(""), null);
  });

  it("a BOM at the start of a JSON file is not part of it", () => {
    assert.deepEqual(JSON.parse(stripBom("﻿[1]")), [1]);
    assert.equal(stripBom("[1]"), "[1]");
  });

  it("names the stories without a title, instead of sending them as «undefined»", () => {
    const stories = [
      { id: "ALT-001", title: "" },
      { id: "ALT-002" },
      { id: "ALT-003", title: "   " },
      { id: "ALT-004", title: "Ok" },
    ];
    assert.deepEqual(untitled(stories), ["ALT-001", "ALT-002", "ALT-003"]);
  });

  it("reflects only the tip of the default branch, with the stories folder clean", () => {
    assert.equal(headProblem({ head: "a1", tip: "a1", dirty: false, branch: "main" }), null);
    assert.match(headProblem({ head: "b2", tip: "a1", dirty: false, branch: "main" }), /tip of origin\/main/);
    assert.match(headProblem({ head: "a1", tip: "a1", dirty: true, branch: "main" }), /uncommitted/);
    // Without a tip to compare (no remote branch found), it does not guess.
    assert.match(headProblem({ head: "a1", tip: null, dirty: false, branch: "main" }), /origin\/main/);
  });
});
