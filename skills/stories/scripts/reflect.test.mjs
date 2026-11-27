// Tests for reflect.mjs: the translation from `stories.mjs --json` to a gg-ez reflection, with no network and no
// database. Run with `node --test "skills/**/*.test.mjs"`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  badReflect,
  childEnv,
  criterionState,
  descriptionOf,
  designState,
  linksOf,
  prototypeOf,
  storySection,
  validLink,
  optionProblems,
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

  it("with --design the state is the design phase, read from git: ready/, lock/, explora/ or a commit, the rest", () => {
    const git = {
      tags: ["ready/ALT-001", "ready/ALT-002-2", "lock/ALT-003-alta", "lock/ALT-010-x", "ready/ALT-0011", "archivo/ready-ALT-004"],
      branches: ["explora/ALT-005", "explora/ALT-006-humo", "explora/ALT-0077"],
      subjects: ["ALT-007: the screen", "feat(ALT-008, ALT-009): two at once", "chore: base, with ALT-012 named inside"],
      aliases: new Map([["ACC-001", ["ALT-010"]]]),
    };
    const phase = (id, status = "pending") => designState(story(id, status), git);
    assert.deepEqual(phase("ALT-001"), { tipo: "completed", estado: "Hecho" });
    assert.deepEqual(phase("ALT-002"), { tipo: "completed", estado: "Hecho" });
    assert.deepEqual(phase("ALT-003", "works"), { tipo: "started", estado: "Pantallas aprobadas" });
    assert.deepEqual(phase("ACC-001"), { tipo: "started", estado: "Pantallas aprobadas" }, "an old ID counts as its own");
    assert.deepEqual(phase("ALT-005"), { tipo: "started", estado: "Diseñando" });
    assert.deepEqual(phase("ALT-006"), { tipo: "started", estado: "Diseñando" });
    assert.deepEqual(phase("ALT-007"), { tipo: "started", estado: "Diseñando" });
    assert.deepEqual(phase("ALT-009"), { tipo: "started", estado: "Diseñando" }, "inside a list of scopes");
    assert.deepEqual(phase("ALT-012", "partial"), { tipo: "unstarted", estado: "Por diseñar" }, "named, not opening the subject");
    assert.deepEqual(phase("ALT-004"), { tipo: "unstarted", estado: "Por diseñar" }, "an archived ready does not count");
    assert.deepEqual(phase("ALT-001", "discarded"), { tipo: "canceled", estado: "Cancelado" });
    // The ID as a whole word: ALT-0011 and ALT-0077 belong to other stories.
    assert.deepEqual(designState(story("ALT-001", "pending"), { ...git, tags: ["ready/ALT-0011"] }), {
      tipo: "unstarted",
      estado: "Por diseñar",
    });
  });

  it("--skip leaves out an activity's stories, and a story's own reflect still wins over --design", () => {
    const design = { tags: ["ready/ALT-001", "ready/DEM-001"], branches: [], subjects: [], aliases: new Map() };
    const reflection = reflectionOf({
      source: "product",
      stories: [
        story("ALT-001", "partial"),
        story("ALT-002", "pending", { reflect: { tipo: "started", estado: "Otra" } }),
        story("DEM-001", "works"),
      ],
      activities: [],
      branches: [],
      prBranches: [],
      repo: null,
      storiesDir: "producto",
      design,
      skip: ["DEM"],
    });
    assert.deepEqual(reflection.piezas, [
      { clave: "ALT-001", titulo: "Title of ALT-001", tipo: "completed", estado: "Hecho" },
      { clave: "ALT-002", titulo: "Title of ALT-002", tipo: "started", estado: "Otra" },
    ]);
  });

  it("knows --design, --alias NEW=OLD,OLD and --skip CODE, repeated, and refuses a broken alias", () => {
    const options = parseArgs(["--design", "--alias", "ACC-001=ALT-004", "--alias=ACC-002=ALT-004,NAV-002", "--skip", "DEM"]);
    assert.equal(options.ok, true);
    assert.equal(options.design, true);
    assert.deepEqual([...options.aliases], [["ACC-001", ["ALT-004"]], ["ACC-002", ["ALT-004", "NAV-002"]]]);
    assert.deepEqual(options.skip, ["DEM"]);
    assert.equal(parseArgs(["--alias", "ACC-001"]).ok, false);
    assert.equal(parseArgs(["--skip"]).ok, false);
    assert.equal(parseArgs(["--alias", "ACC-001=ALT-004", "--alias", "ACC-001=ALT-005"]).ok, false, "the same story twice");
  });

  it("a --skip code or an --alias story that matches nothing is named: a typo must not send for real", () => {
    const stories = [story("ALT-001", "pending"), story("DEM-001", "works")];
    const aliases = new Map([["ALT-001", ["NAV-002"]], ["ACC-009", ["ALT-004"]]]);
    assert.deepEqual(optionProblems(stories, { skip: ["DEM", "DME"], aliases, design: true }), [
      "--skip DME matches no activity",
      "--alias ACC-009 matches no story",
    ]);
    assert.deepEqual(optionProblems(stories, { skip: ["DEM"], aliases: new Map([["ALT-001", ["X-1"]]]), design: true }), []);
    assert.deepEqual(optionProblems(stories, { skip: [], aliases: new Map([["ALT-001", ["X-1"]]]), design: false }), [
      "--alias only counts with --design",
    ]);
  });

  it("a scope list counts the ID anywhere in it, and the ID ends at a letter too", () => {
    const git = (subjects) => ({ tags: [], branches: [], subjects, aliases: new Map() });
    assert.equal(designState(story("ALT-001", "pending"), git(["feat(ui, ALT-001): x"])).estado, "Diseñando");
    assert.equal(designState(story("A11Y-001", "pending"), git(["fix(ALT-002, A11Y-001): x"])).estado, "Diseñando");
    assert.equal(designState(story("ALT-001", "pending"), git(["ALT-001b: other"])).estado, "Por diseñar");
    assert.equal(designState(story("ALT-001", "pending"), git(["chore(ui): ALT-001 named later"])).estado, "Por diseñar");
    assert.equal(designState(story("ALT-007", "pending"), { ...git([]), branches: ["explora/ALT-0077"] }).estado, "Por diseñar");
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

const LABELS = {
  story: "Historia",
  criteria: "Criterios de aceptación",
  markers: ["test", "manual", "sin verificar", "sin construir", "falla"],
};

const FILE = [
  "---",
  "id: ALT-001",
  "title: Darme de alta",
  'prototype: "https://easy-one.example/alta"',
  "screens: []",
  "---",
  "",
  "## Historia",
  "Como propietario de pyme,",
  "quiero darme de alta,",
  "para empezar la prueba.",
  "",
  "## Criterios de aceptación",
  "- **ALT-001.1** Pide el correo. [test: src/a.test.ts › \"ALT-001.1 Pide el correo.\"]",
  "",
  "## Fuera de alcance",
  "- El NIF.",
  "",
].join("\n");

const CRITERIA = [
  { id: "ALT-001.1", head: '**ALT-001.1** Pide el correo. [test: src/a.test.ts › "ALT-001.1 Pide el correo."]', kind: "test", result: "pass" },
  { id: "ALT-001.2", head: "**ALT-001.2** Falla el test. [test: src/a.test.ts › \"x\"]", kind: "test", result: "fail" },
  { id: "ALT-001.3", head: "**ALT-001.3** Sin resultado. [test: src/a.test.ts › \"y\"]", kind: "test" },
  { id: "ALT-001.4", head: "**ALT-001.4** A mano. [manual 2026-11-09, Sydney]", kind: "manual" },
  { id: "ALT-001.5", head: "**ALT-001.5** Por hacer. [sin construir]", kind: "unbuilt" },
  { id: "ALT-001.6", head: "**ALT-001.6** Roto. [falla: el botón no responde]", kind: "failing" },
  { id: "ALT-001.7", head: "**ALT-001.7** Sin mirar. [sin verificar]", kind: "unverified" },
];

describe("reflect: what the task says (descripcion)", () => {
  it("[REF-007.5] is the story's Historia, then each criterion with its state in words, without bold or marker", () => {
    assert.equal(
      descriptionOf({ text: FILE, criteria: CRITERIA, labels: LABELS }),
      [
        "Como propietario de pyme,",
        "quiero darme de alta,",
        "para empezar la prueba.",
        "",
        "Criterios de aceptación",
        "- ALT-001.1 (funciona) Pide el correo.",
        "- ALT-001.2 (falla) Falla el test.",
        "- ALT-001.3 (sin verificar) Sin resultado.",
        "- ALT-001.4 (funciona) A mano.",
        "- ALT-001.5 (sin construir) Por hacer.",
        "- ALT-001.6 (falla) Roto.",
        "- ALT-001.7 (sin verificar) Sin mirar.",
      ].join("\n"),
    );
  });

  it("[REF-007.5] a criterion's state is read as stories.mjs reads it: a test by its result, manual works", () => {
    assert.deepEqual(
      CRITERIA.map(criterionState),
      ["funciona", "falla", "sin verificar", "funciona", "sin construir", "falla", "sin verificar"],
    );
    assert.equal(criterionState({ kind: "test", result: "skipped" }), "sin verificar");
  });

  it("[REF-007.5] without a Historia section it sends the criteria; with neither, null", () => {
    const noStory = FILE.replace(/## Historia\n[\s\S]*?\n\n/, "");
    assert.equal(storySection(noStory, "Historia"), "");
    assert.equal(
      descriptionOf({ text: noStory, criteria: CRITERIA.slice(0, 1), labels: LABELS }),
      "Criterios de aceptación\n- ALT-001.1 (funciona) Pide el correo.",
    );
    assert.equal(
      descriptionOf({ text: FILE, criteria: [], labels: LABELS }),
      "Como propietario de pyme,\nquiero darme de alta,\npara empezar la prueba.",
    );
    assert.equal(descriptionOf({ text: noStory, criteria: [], labels: LABELS }), null);
    assert.equal(descriptionOf({ text: "", criteria: [], labels: LABELS }), null);
  });

  it("[REF-007.5] the Historia heading is the project's label, matched as stories.mjs matches it", () => {
    const english = "---\nid: X\n---\n## Story\r\nAs a user,\r\n<!-- a note -->\r\nI want it.\r\n## Acceptance criteria\r\n";
    assert.equal(storySection(english, "Story"), "As a user,\nI want it.");
    assert.equal(storySection(english, "Historia"), "");
    assert.equal(storySection(FILE, "historia"), "Como propietario de pyme,\nquiero darme de alta,\npara empezar la prueba.");
  });

  it("[REF-007.5] a description longer than gg-ez takes is cut with an ellipsis, by characters", () => {
    const long = [{ id: "ALT-001.1", head: `**ALT-001.1** ${"é".repeat(25_000)} [sin construir]`, kind: "unbuilt" }];
    const text = descriptionOf({ text: "", criteria: long, labels: LABELS });
    assert.equal(text.length, 20_000);
    assert.ok(text.endsWith("…"));
  });
});

describe("reflect: the task's links (enlaces)", () => {
  const FIGMA = (n) => `https://www.figma.com/design/6NuL9XQpuNnRXfChGBMp1s?node-id=${n}`;
  const PNG = "https://github.com/o/r/blob/abc/producto/pantallas/ALT-001/alta-1440.png";

  it("[REF-007.5] the prototype goes first, then each screen named by its kind and numbered when several", () => {
    assert.deepEqual(
      linksOf({
        prototype: "https://easy-one.example/alta",
        screens: [PNG, FIGMA("1-2"), "https://figma.com/proto/x", "https://easy-one.example/pantalla/alta", "https://x.example/a.WEBP"],
      }),
      [
        { nombre: "Prototipo", enlace: "https://easy-one.example/alta" },
        { nombre: "Captura 1", enlace: PNG },
        { nombre: "Figma 1", enlace: FIGMA("1-2") },
        { nombre: "Figma 2", enlace: "https://figma.com/proto/x" },
        { nombre: "Pantalla", enlace: "https://easy-one.example/pantalla/alta" },
        { nombre: "Captura 2", enlace: "https://x.example/a.WEBP" },
      ],
    );
    assert.deepEqual(linksOf({ prototype: null, screens: [] }), []);
  });

  it("[REF-007.5] skips what is not http or https, or longer than gg-ez takes, and a lookalike is not Figma", () => {
    assert.deepEqual(
      linksOf({
        prototype: "javascript:alert(1)",
        screens: [
          "producto/pantallas/ALT-001/alta.png",
          "ftp://x.example/a.png",
          "mailto:a@b.example",
          `https://x.example/${"a".repeat(2000)}`,
          "https://notfigma.com/design/x",
        ],
      }),
      [{ nombre: "Pantalla", enlace: "https://notfigma.com/design/x" }],
    );
  });

  it("[REF-007.5] never more than 10: the prototype, then the screens in order", () => {
    const screens = Array.from({ length: 11 }, (_, i) => FIGMA(`${i}-1`));
    const links = linksOf({ prototype: "https://easy-one.example/alta", screens });
    assert.equal(links.length, 10);
    assert.equal(links[0].nombre, "Prototipo");
    assert.deepEqual(links.slice(1).map((link) => link.enlace), screens.slice(0, 9));
    assert.equal(linksOf({ prototype: null, screens }).length, 10);
  });

  it("[REF-007.5] a link gg-ez would refuse is never sent: control or invisible characters, empty or long names", () => {
    const link = (nombre) => ({ nombre, enlace: "https://x.example" });
    assert.equal(validLink(link("Figma")), true);
    for (const bad of ["", "   ", "Fig\u0007ma", "Fig​ma", "Figma\n2", "a".repeat(61), "‮Figma"]) {
      assert.equal(validLink(link(bad)), false, JSON.stringify(bad));
    }
    assert.equal(validLink({ nombre: "Figma", enlace: "ftp://x.example" }), false);
    // Control characters inside a screen's address do not reach a name, and the address goes encoded.
    const links = linksOf({ prototype: null, screens: ["https://x.example/a\u0007b​"] });
    assert.equal(links.length, 1);
    assert.ok(links.every(validLink));
    assert.doesNotMatch(links[0].enlace, /[\u0000-\u001f​]/);
  });

  it("[REF-007.5] the prototype is the story's `prototype:` key, a single address", () => {
    assert.equal(prototypeOf(FILE), "https://easy-one.example/alta");
    assert.equal(prototypeOf("---\nid: X\nprototype: https://p.example/x # the screen\n---\n"), "https://p.example/x");
    assert.equal(prototypeOf("---\nid: X\nprototype: [https://a.example, https://b.example]\n---\n"), null);
    assert.equal(prototypeOf("---\nid: X\n---\n"), null);
    assert.equal(prototypeOf("---\nid: X\nprototype:\n---\n"), null);
    assert.equal(prototypeOf("no frontmatter\nprototype: https://p.example\n"), null);
  });

  it("[REF-007.5] with the story files, each piece brings its descripcion and its enlaces", () => {
    const [piece] = reflectionOf({
      source: "product",
      stories: [story("ALT-001", "partial", { screens: [FIGMA("1-2")], criteria: CRITERIA.slice(0, 1) })],
      activities: [],
      branches: [],
      prBranches: [],
      repo: null,
      storiesDir: "producto",
      files: new Map([["ALT-001", FILE]]),
      labels: LABELS,
    }).piezas;
    assert.equal(
      piece.descripcion,
      "Como propietario de pyme,\nquiero darme de alta,\npara empezar la prueba.\n\nCriterios de aceptación\n- ALT-001.1 (funciona) Pide el correo.",
    );
    assert.deepEqual(piece.enlaces, [
      { nombre: "Prototipo", enlace: "https://easy-one.example/alta" },
      { nombre: "Figma", enlace: FIGMA("1-2") },
    ]);
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
    const none = {
      ok: true,
      source: null,
      tests: false,
      dryRun: false,
      anyBranch: false,
      design: false,
      aliases: new Map(),
      skip: [],
    };
    assert.deepEqual(parseArgs([]), none);
    assert.deepEqual(parseArgs(["--source", "easy-one", "--tests", "--dry-run", "--any-branch"]), {
      ...none,
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
