// Runs the guard's shell checks against fixed cases: node hooks/check-guard.mjs [path to guard.mjs]
// Each case feeds a PreToolUse payload to the guard in a scratch repository (one on main, one on a
// story branch, each with a locked test) and compares the exit code and message. Run it after every
// guard change. Cases tagged PowerShell use that tool's payload; they run on any system.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const G = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "guard.mjs"));
// realpath: on macOS the temp folder is reached through the /var -> /private/var link, and the guard
// does not yet match a locked file when the session folder is a symlink to the repository (0.11.3).
const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "check-guard-")));
const repo = (branch) => {
  const d = path.join(base, branch.replace(/\W/g, "_"));
  mkdirSync(path.join(d, ".orchestrator"), { recursive: true }); mkdirSync(path.join(d, "scripts/x"), { recursive: true }); mkdirSync(path.join(d, "tests"), { recursive: true });
  writeFileSync(path.join(d, ".orchestrator.json"), JSON.stringify({ git: { protectedBranches: ["main"] } }));
  writeFileSync(path.join(d, ".orchestrator/locked-tests.txt"), "scripts/x/guard.mjs\ntests/a.test.js\n");
  writeFileSync(path.join(d, "scripts/x/guard.mjs"), "x"); writeFileSync(path.join(d, "tests/a.test.js"), "x");
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  g("init", "-q", "-b", "main"); g("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"); g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i");
  if (branch !== "main") g("checkout", "-qb", branch);
  return d;
};
const dirs = { main: repo("main"), "story/x": repo("story/x") };
const cases = [
  ["main", "quoted git run through xargs is checked", "echo x | xargs -I{} sh -c 'true' ; printf '%s' 'git commit -m x' | xargs -0 -I{} env {}", "", 2, "commits on main"],
  ["main", "quoted git handed to any program is checked", 'npx some-runner "git commit -m x"', "", 2, "commits on main"],
  ["main", "quoted git passed to echo is checked", 'echo "git commit -m x" | xargs -I{} env {}', "", 2, "commits on main"],
  ["main", "echo of quoted force push stays blocked", 'echo "git push --force"', "", 2, "force push"],
  ["main", "a search for quoted git text is allowed", 'grep -rn "git commit" scripts', "", 0],
  ["main", "rg for quoted force push is allowed", 'rg "git push --force" docs', "", 0],
  ["main", "gh body mentioning a force push is allowed", 'gh pr create --title x --body "git push --force"', "", 0],
  ["main", "a search piped into sh is checked", 'rg "git push --force" | sh', "", 2, "force push"],
  ["main", "a search next to bash -c is checked", 'rg "git push --force" docs; bash -c "true"', "", 2, "force push"],
  ["main", "a search behind a prefix is checked", 'env LC_ALL=C grep "git commit" scripts', "", 2, "commits on main"],
  ["main", "bash -c git is checked", 'bash -c "git push --force"', "", 2, "force push"],
  ["main", "quoted git as its own command is checked", '"git" push --force', "", 2, "force push"],
  ["story/x", "reviewer searches for quoted git text", 'rg "git commit" .claude', "orchestrator:reviewer", 0],
  ["story/x", "bash -c checked where it runs, before a later cd", 'bash -c "rm scripts/x/guard.mjs" && cd scripts', "", 2, "locked"],
  ["story/x", "bash -c with a harmless rm before a cd passes", 'bash -c "rm guard.mjs" && cd scripts/x', "", 0],
  ["story/x", "plain git commit on a story branch passes", 'git commit -m x', "", 0],
  ["main", "search piped into sh; is checked", 'rg -o "git push --force" f | sh;', "", 2, "force push"],
  ["main", "search piped into sh in a subshell is checked", '(rg -o "git push --force" f | sh)', "", 2, "force push"],
  ["main", "search piped into sh& is checked", 'rg -o "git push --force" f | sh&', "", 2, "force push"],
  ["main", "search piped into quoted sh is checked", 'rg -o "git push --force" f | "sh"', "", 2, "force push"],
  ["main", "search through head into xargs env is checked", 'rg -o "git push --force" f | head -1 | xargs env', "", 2, "force push"],
  ["main", "search piped into fish is checked", 'rg -o "git push --force" f | fish', "", 2, "force push"],
  ["main", "search into ssh via xargs is checked", 'rg -o "git push --force" f | xargs -I{} ssh localhost {}', "", 2, "force push"],
  ["main", "search redirected to a script is checked", 'rg "git push --force" > run.sh; chmod +x run.sh; ./run.sh', "", 2, "force push"],
  ["main", "search inside $() is checked", '$(rg -oN -r "git push --force" "^.*" f)', "", 2, "force push"],
  ["main", "gh alias --shell is checked", 'gh alias set --shell fp "git push --force"', "", 2, "force push"],
  ["main", "a local script named rg is checked", './rg "git push --force"', "", 2, "force push"],
  ["main", "quoted bash.exe script is checked", "watch \"bash.exe -c 'git push --force'\"", "", 2, "force push"],
  ["main", "quoted /bin/bash script is checked", "watch \"/bin/bash -c 'git push --force'\"", "", 2, "force push"],
  ["main", "search inside a for loop is checked (one command per line only)", 'for f in a; do rg "git push --force" $f; done', "", 2, "force push"],
  ["main", "search inside an if is checked", 'if rg -q "git push --force" f; then echo y; fi', "", 2, "force push"],
  ["main", "search followed by another command is checked", 'rg -n "git push --force" f && echo done', "", 2, "force push"],
  ["main", "$() in single quotes is text", "grep '$(git push --force)' f", "", 0],
  ["main", "gh issue comment mentioning a force push is allowed", 'gh issue comment 3 --body "never git push --force here"', "", 0],
  ["main", "search piped to head is allowed? (no: pipe out)", 'rg "git push --force" f | head', "", 2, "force push"],
  ["story/x", "commit message heredoc mentioning reset --hard passes", "git commit -m \"$(cat <<'EOF'\nFix guard\n\ngit reset --hard is blocked\nEOF\n)\"", "", 0],
  ["story/x", "pr body heredoc mentioning force push passes", "gh pr create --title x --body \"$(cat <<'EOF'\n- git push --force is blocked\n- git checkout x\n- git commit\nEOF\n)\"", "", 0],
  ["story/x", "markdown backticks in a pr body pass", 'gh pr create --title x --body "Run `git push --force` never"', "", 0],
  ["main", "escaped $( in echo is text", 'echo "\\$(git push --force)"', "", 0],
  ["main", "search then $_ is checked", 'rg "git push --force"; $_', "", 2, "force push"],
  ["main", "function named grep is checked", 'grep() { $1; }; grep "git push --force"', "", 2, "force push"],
  ["main", "PATH pointing rg at a script is checked", 'PATH=./bin:$PATH rg "git push --force"', "", 2, "force push"],
  ["story/x", "variable set inside $() does not leak (asks or blocks)", 'echo "$(true; D=/tmp/)"; rm ${D}tests/a.test.js', "", 0, "\"ask\""],
  ["main", "dash -c after a cd is checked", 'dash -c "cd x && git push --force"', "", 2, "force push"],
  ["main", "bash --norc -c is checked", 'bash --norc -c "cd x && git push --force"', "", 2, "force push"],
  ["main", "timeout wrapper is checked", 'timeout 9 git push --force', "", 2, "force push"],
  ["main", "timeout -k wrapper is checked", 'timeout -k 5 9 git push --force', "", 2, "force push"],
  ["main", "nice -n wrapper is checked", 'nice -n 5 git push --force', "", 2, "force push"],
  ["main", "sudo -u wrapper is checked", 'sudo -u root git push --force', "", 2, "force push"],
  ["story/x", "caffeinate -i rm of a locked test is checked", 'caffeinate -i rm tests/a.test.js', "", 2, "locked"],
  ["story/x", "builder repeat-failure probe unaffected", 'npm test "$(grep -l foo src)"', "", 0],
  ["main", "search &> to a file then sourced is checked", 'rg -o -r "git push --force" -m1 "^" f &> x.sh; . ./x.sh', "", 2, "force push"],
  ["main", "search in a redirected group is checked", '{ rg -o -r "git push --force" -m1 "^" f; } > x.sh; . ./x.sh', "", 2, "force push"],
  ["main", "search inside bash -c piped to sh is checked", "bash -c \"rg -o -r 'git push --force' -m1 ^ f\" | sh", "", 2, "force push"],
  ["main", "sudo --user is checked", 'sudo --user root git push --force', "", 2, "force push"],
  ["main", "timeout --signal is checked", 'timeout --signal KILL 5 git push --force', "", 2, "force push"],
  ["main", "sudo -iu is checked", 'sudo -iu root git push --force', "", 2, "force push"],
  ["main", "timeout then nohup is checked", 'timeout 5 nohup git push --force', "", 2, "force push"],
  ["main", "timeout then env is checked", 'timeout 5 env A=1 git push --force', "", 2, "force push"],
  ["main", "nice then command is checked", 'nice -n 5 command git push --force', "", 2, "force push"],
  ["main", "bash -o pipefail -c is checked", 'bash -o pipefail -c "cd x && git push --force"', "", 2, "force push"],
  ["main", "bash --rcfile -c is checked", 'bash --rcfile /dev/null -c "cd x && git push --force"', "", 2, "force push"],
  ["main", "env -i is checked", 'env -i git push --force', "", 2, "force push"],
  ["main", "exec -a is checked", 'exec -a x git push --force', "", 2, "force push"],
  ["main", "time -p is checked", 'time -p git push --force', "", 2, "force push"],
  ["main", "command -p is checked", 'command -p git push --force', "", 2, "force push"],
  ["main", "HUSKY=0 behind timeout is blocked", 'timeout 5 HUSKY=0 git commit -m x', "", 2, "HUSKY"],
  ["main", "search with 2>/dev/null is allowed", 'rg "git push --force" docs 2>/dev/null', "", 0],
  ["main", "search with 2>&1 is allowed", 'rg "git push --force" docs 2>&1', "", 0],
  ["main", "$() inside a search's git text is checked", 'rg "git $(git push --force)" docs', "", 2, "force push"],
  ["main", "$() inside a gh body's git text is checked", 'gh pr create --body "git $(git push --force)"', "", 2, "force push"],
  ["main", "constructor first word does not crash", 'constructor; git push --force', "", 2, "force push"],
  ["main", "__proto__ first word does not crash", '__proto__ x; git push --force', "", 2, "force push"],
  ["story/x", "reviewer may run command -v git", 'command -v git', "orchestrator:reviewer", 0],
  ["main", "env -P is checked", 'env -P /usr/bin git push --force', "", 2, "force push"],
  ["main", "sudo -R is checked", 'sudo -R / git push --force', "", 2, "force push"],
  ["main", "doas -a is checked", 'doas -a style git push --force', "", 2, "force push"],
  ["main", "bash -euo pipefail -c is checked", 'bash -euo pipefail -c "cd x && git push --force"', "", 2, "force push"],
  ["main", "bash +o posix -c is checked", 'bash +o posix -c "cd x && git push --force"', "", 2, "force push"],
  ["story/x", "env -S with HUSKY=0 is blocked", "env -S 'HUSKY=0 git commit -m x'", "", 2, "HUSKY"],
  ["main", "env -S with -i is checked", "env -S '-i git push --force'", "", 2, "force push"],
  ["main", "xcrun is checked", 'xcrun git push --force', "", 2, "force push"],
  ["main", "arch -arm64 is checked", 'arch -arm64 git push --force', "", 2, "force push"],
  ["main", "PS: Select-String search is allowed", "Select-String \"git push --force\" docs\\x.md", "", 0, "", "PowerShell"],
  ["main", "PS: sls with 2>$null is allowed", "sls \"git push --force\" x.md 2>$null", "", 0, "", "PowerShell"],
  ["main", "PS: findstr search is allowed", "findstr \"git push --force\" x.md", "", 0, "", "PowerShell"],
  ["main", "PS: rg.exe search is allowed", "rg.exe \"git push --force\" docs", "", 0, "", "PowerShell"],
  ["main", "PS: a path to rg.exe is checked", "C:\\tools\\rg.exe \"git push --force\" docs", "", 2, "force push", "PowerShell"],
  ["main", "PS: .\\rg is checked", ".\\rg \"git push --force\"", "", 2, "force push", "PowerShell"],
  ["main", "PS: Select-String piped on is checked", "Select-String \"git push --force\" x | ForEach-Object { iex $_.Line }", "", 2, "force push", "PowerShell"],
  ["main", "PS: subexpression in a search is checked", "Select-String \"git push $(git push --force)\" x", "", 2, "force push", "PowerShell"],
  ["main", "PS: pwsh -NoProfile -Command is checked", "pwsh -NoProfile -Command \"cd x; git push --force\"", "", 2, "force push", "PowerShell"],
  ["main", "PS: cmd /c is checked", "cmd /c \"cd x && git push --force\"", "", 2, "force push", "PowerShell"],
  ["main", "PS: cmd /d /s /c is checked", "cmd /d /s /c \"cd x && git push --force\"", "", 2, "force push", "PowerShell"],
  ["main", "PS: call operator is checked", "& git push --force", "", 2, "force push", "PowerShell"],
  ["main", "PS: git.exe is checked", "git.exe push --force", "", 2, "force push", "PowerShell"],
  ["main", "PS: gh pr body is allowed", "gh pr create --title x --body \"never git push --force\"", "", 0, "", "PowerShell"],
  ["main", "escaped quote across lines is checked", 'rg \\"\ngit push --force\nrg "x"', "", 2, "force push"],
  ["main", "a search over two lines is checked", 'rg "git push --force"\ngit push --force', "", 2, "force push"],
  ["main", "sudo -uroot is checked", 'sudo -uroot git push -f', "", 2, "force push"],
  ["main", "sudo -iuroot is checked", 'sudo -iuroot git push -f', "", 2, "force push"],
  ["main", "sudo -uroot HUSKY=0 is blocked", 'sudo -uroot HUSKY=0 git commit -m x', "", 2, "HUSKY"],
  ["main", "nice -n5 is checked", 'nice -n5 git push --force', "", 2, "force push"],
  ["main", "xcrun --sdk is checked", 'xcrun --sdk macosx git push --force', "", 2, "force push"],
  ["main", "xcrun -sdk is checked", 'xcrun -sdk macosx git push -f', "", 2, "force push"],
  ["main", "arch -arch is checked", 'arch -arch arm64 git push --force', "", 2, "force push"],
  ["story/x", "env -iS with HUSKY=0 is blocked", 'env -iS "HUSKY=0 git commit -m x"', "", 2, "HUSKY"],
  ["story/x", "env --split-string= with HUSKY=0 is blocked", 'env --split-string="HUSKY=0 git commit -m x"', "", 2, "HUSKY"],
  ["main", "quoted assignment prefix is checked", 'X="a b" git push --force', "", 2, "force push"],
  ["story/x", "HUSKY quoted is blocked", 'HUSKY="0" git commit -m x', "", 2, "HUSKY"],
  ["main", "/usr/bin/env is checked", '/usr/bin/env git push --force', "", 2, "force push"],
  ["story/x", "export HUSKY=0 is blocked", 'export HUSKY=0; git commit -m x', "", 2, "HUSKY"],
  ["story/x", "an empty assignment then git is checked", 'X= git push --force', "", 2, "force push"],
  ["story/x", "PS: $env:HUSKY=0 is blocked", '$env:HUSKY="0"; git commit -m x', "", 2, "HUSKY", "PowerShell"],
];
let fail = 0;
for (const [branch, title, command, agent, exit, msg, tool = "Bash"] of cases) {
  const input = { hook_event_name: "PreToolUse", tool_name: tool, cwd: dirs[branch], session_id: "t", tool_input: { command }, ...(agent ? { agent_type: agent, agent_id: "a1" } : {}) };
  const r = spawnSync("node", [G], { input: JSON.stringify(input), cwd: dirs[branch], encoding: "utf8" });
  const ok = r.status === exit && (!msg || (r.stderr + r.stdout).includes(msg));
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${title}  (exit ${r.status}, want ${exit})${ok ? "" : "  " + (r.stderr + r.stdout).slice(0, 160).replace(/\n/g, " ")}`);
}
rmSync(base, { recursive: true, force: true });
console.log(fail ? `${fail} of ${cases.length} failed` : `all ${cases.length} passed`);
process.exit(fail ? 1 : 0);
