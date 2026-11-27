// Runs the guard's shell checks against fixed cases: node hooks/check-guard.mjs [path to guard.mjs]
// Each case feeds a PreToolUse payload to the guard in a scratch repository (one on main, one on a
// story branch, each with a locked test) and compares the exit code and message. Run it after every
// guard change. Cases tagged PowerShell use that tool's payload; they run on any system.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const G = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "guard.mjs"));
// realpath: on macOS the temp folder is reached through the /var -> /private/var link.
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
// A linked worktree of the main repository, on a branch of its own (Orca's default naming), and a main
// checkout that a session moved off main.
dirs.worktree = path.join(base, "linked");
execFileSync("git", ["worktree", "add", "-q", dirs.worktree, "-b", "sydneydesign/mail"], { cwd: dirs.main, stdio: "ignore" });
// The main checkout declares a worktree setup, so a worker in a worktree nobody set up is told to run it.
writeFileSync(path.join(dirs.main, ".orchestrator.json"), JSON.stringify({ git: { protectedBranches: ["main"] }, worktree: { setup: ["true"] } }));
writeFileSync(path.join(dirs.main, ".orchestrator", "worktree.mjs"), "// fixture\n");
// A second linked worktree only the claim cases use, so earlier cases' claims do not reach it.
dirs.claimed = path.join(base, "claimed");
execFileSync("git", ["worktree", "add", "-q", dirs.claimed, "-b", "sydneydesign/claims"], { cwd: dirs.main, stdio: "ignore" });
dirs.moved = repo("moved");
execFileSync("git", ["switch", "-q", "-c", "explora/x"], { cwd: dirs.moved, stdio: "ignore" });
// A branch that exists only on a remote: git checkout <name> would create it and switch.
execFileSync("git", ["update-ref", "refs/remotes/origin/pr-branch", "HEAD"], { cwd: dirs.main, stdio: "ignore" });
// A repository whose tests folder is a symlink, with the locked test listed by the link's path.
dirs.linkedTests = repo("linkedtests");
{ const d = dirs.linkedTests; mkdirSync(path.join(d, "real"), { recursive: true }); execFileSync("git", ["mv", "tests", "real/tests"], { cwd: d, stdio: "ignore" });
  try { symlinkSync(path.join("real", "tests"), path.join(d, "tests")); dirs.linkedTestsOk = true; } catch { dirs.linkedTestsOk = false; } }
// story/y has a commit of its own, so resetting main onto it moves main.
for (const a of [["switch", "-q", "-c", "story/y"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "y"], ["switch", "-q", "main"]])
  execFileSync("git", a, { cwd: dirs.main, stdio: "ignore" });
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
  ["story/x","builder: gh pr merge is blocked","gh pr merge 5 --merge","orchestrator:builder",2,"never merge"],
  ["story/x","builder: gh pr comment is blocked","gh pr comment 5 --body \"done\"","orchestrator:builder",2,"only read GitHub"],
  ["story/x","builder: gh pr review --approve is blocked","gh pr review 5 --approve","orchestrator:builder",2,"never approve"],
  ["story/x","builder: gh api with a field is blocked","gh api repos/o/r/issues/1/comments -f body=x","orchestrator:builder",2,"only read GitHub"],
  ["story/x","builder: gh api -X PATCH is blocked","gh api -X PATCH repos/o/r/pulls/5","orchestrator:builder",2,"only read GitHub"],
  ["story/x","builder: gh repo delete is blocked","gh repo delete o/r --yes","orchestrator:builder",2,"only read GitHub"],
  ["story/x","builder: gh pr view is allowed","gh pr view 5 --json title","orchestrator:builder",0,""],
  ["story/x","builder: gh pr checks is allowed","gh pr checks 5","orchestrator:builder",0,""],
  ["story/x","builder: gh api GET with a field is allowed","gh api -X GET search/issues -f q=x","orchestrator:builder",0,""],
  ["story/x","builder: gh api read is allowed","gh api repos/o/r/pulls/5/comments","orchestrator:builder",0,""],
  ["story/x","orchestrator: gh pr merge asks","gh pr merge 5 --merge","",0,"\"ask\""],
  ["story/x","orchestrator: gh pr merge --admin is blocked","gh pr merge 5 --merge --admin","",2,"--admin"],
  ["story/x","orchestrator: gh pr review --approve asks","gh pr review 5 --approve","",0,"\"ask\""],
  ["story/x","orchestrator: merge through gh api asks","gh api -X PUT repos/o/r/pulls/5/merge","",0,"\"ask\""],
  ["story/x","orchestrator: approve through gh api asks","gh api repos/o/r/pulls/5/reviews -f event=APPROVE","",0,"\"ask\""],
  ["story/x","orchestrator: gh pr create is allowed","gh pr create --title x --body \"y\"","",0,""],
  ["story/x","orchestrator: gh pr comment is allowed","gh pr comment 5 --body \"fixed\"","",0,""],
  ["story/x","a commit message mentioning export HUSKY=0 passes","git commit -m \"export HUSKY=0 is blocked\"","",0,""],
  ["story/x","a python heredoc mentioning export HUSKY=0 passes","python3 - <<'E'\nprint(\"export HUSKY=0\")\nE","",0,""],
  ["story/x","export HUSKY=\"0\" is blocked","export HUSKY=\"0\"","",2,"HUSKY"],
  ["story/x","declare -x HUSKY=0 is blocked","declare -x HUSKY=0; git commit -m x","",2,"HUSKY"],
  ["story/x","export HUSKY=1 passes","export HUSKY=1; git commit -m x","",0,""],
  ["story/x","builder: gh pr -R o/r merge is blocked","gh pr -R o/r merge 5","orchestrator:builder",2,"never merge"],
  ["story/x","builder: gh pr --repo o/r comment is blocked","gh pr --repo o/r comment 5 --body x","orchestrator:builder",2,"only read GitHub"],
  ["story/x","builder: gh verb in a variable is blocked","V=merge; gh pr $V 5","orchestrator:builder",2,"never merge"],
  ["story/x","builder: gh verb from the environment is blocked","gh pr $UNSET_VERB 5","orchestrator:builder",2,"only read GitHub"],
  ["story/x","builder: gh api -fbody=x is blocked","gh api repos/o/r/issues/1/comments -fbody=x","orchestrator:builder",2,"only read GitHub"],
  ["story/x","builder: a body faking -X GET is blocked","gh api repos/o/r/issues/1/comments -f body=\"use -X GET\"","orchestrator:builder",2,"only read GitHub"],
  ["story/x","builder: gh pr update-branch is blocked","gh pr update-branch 5","orchestrator:builder",2,"only read GitHub"],
  ["story/x","builder: gh issue develop is blocked","gh issue develop 3","orchestrator:builder",2,"only read GitHub"],
  ["story/x","builder: gh gist create is blocked","gh gist create f","orchestrator:builder",2,"only read GitHub"],
  ["story/x","builder: gh by its path is checked","/opt/homebrew/bin/gh pr merge 5","orchestrator:builder",2,"never merge"],
  ["story/x","builder: gh api graphql is blocked","gh api graphql -f query='{viewer{login}}'","orchestrator:builder",2,"only read GitHub"],
  ["story/x","builder: gh search is allowed","gh search issues \"flaky test\"","orchestrator:builder",0,""],
  ["story/x","builder: gh auth status is allowed","gh auth status","orchestrator:builder",0,""],
  ["story/x","builder: gh run view is allowed","gh run view 123 --log-failed","orchestrator:builder",0,""],
  ["story/x","{ export HUSKY=0; } is blocked","{ export HUSKY=0; git commit -m x; }","",2,"HUSKY"],
  ["story/x","then export HUSKY=0 is blocked","if true; then export HUSKY=0; fi; git commit -m x","",2,"HUSKY"],
  ["story/x","PS: $env:HUSKY = \"0\" is blocked","$env:HUSKY = \"0\"; git commit -m x","",2,"HUSKY","PowerShell"],
  ["story/x","orchestrator: gh pr review -ab asks","gh pr review 5 -ab ok","",0,"\"ask\""],
  ["story/x","orchestrator: --approve=true asks","gh pr review 5 --approve=true","",0,"\"ask\""],
  ["story/x","orchestrator: --admin=true is blocked","gh pr merge 5 --admin=true","",2,"--admin"],
  ["story/x","orchestrator: REST merges endpoint asks","gh api repos/o/r/merges -f base=main -f head=x","",0,"\"ask\""],
  ["story/x","orchestrator: moving a branch ref asks","gh api -X PATCH repos/o/r/git/refs/heads/main -F force=true","",0,"\"ask\""],
  ["story/x","orchestrator: reading pulls does not ask","gh api repos/o/r/pulls/5","",0,""],
  ["story/x","eval export HUSKY=0 is blocked","eval export HUSKY=0; git commit -m x","",2,"HUSKY"],
  ["story/x","export HUSKY=0 through source is blocked","source <(echo export HUSKY=0); git commit -m x","",2,"HUSKY"],
  ["story/x","reviewer: gh pr checkout is blocked","gh pr checkout 5","orchestrator:reviewer",2,"only read GitHub"],
  ["story/x","builder: gh run download is blocked","gh run download 1 -D tests","orchestrator:builder",2,"only read GitHub"],
  ["story/x","orchestrator: approval payload in a file asks","gh api repos/o/r/pulls/5/reviews --input r.json","",0,"\"ask\""],
  ["story/x","orchestrator: graphql query from a file asks","gh api graphql -F query=@m.graphql","",0,"\"ask\""],
  ["story/x","orchestrator: deleting a branch ref asks, not as a merge","gh api -X DELETE repos/o/r/git/refs/heads/story/x","",0,"moving or deleting a branch"],
  ["main","orchestrator: git merge on main asks","git merge --no-ff story/x","",0,"\"ask\""],
  ["main","builder: git merge on main is blocked","git merge story/x","orchestrator:builder",2,"is blocked"],
  ["main","orchestrator: git rebase on main is blocked","git rebase story/x","",2,"is blocked"],
  ["main","orchestrator: git cherry-pick on main is blocked","git cherry-pick abc123","",2,"is blocked"],
  ["main","orchestrator: git pull --ff-only on main passes","git pull --ff-only","",0,""],
  ["main","orchestrator: git pull on main asks","git pull","",0,"\"ask\""],
  ["main","orchestrator: git merge --abort on main passes","git merge --abort","",0,""],
  ["story/x","orchestrator: git merge on a story branch passes","git merge origin/main","",0,""],
  ["main","orchestrator: pull --ff-only from a story branch asks","git pull --ff-only . story/x","",0,"\"ask\""],
  ["main","orchestrator: pull --ff-only origin branch asks","git pull --ff-only origin story/x","",0,"\"ask\""],
  ["story/x","builder: xargs gh pr merge is blocked","echo 5 | xargs gh pr merge","orchestrator:builder",2,"never merge"],
  ["story/x","builder: find -exec gh pr merge is blocked","find . -maxdepth 0 -exec gh pr merge 5 +","orchestrator:builder",2,"never merge"],
  ["main","xargs git push --force is blocked","echo x | xargs git push --force","",2,"force push"],
  ["story/x","builder: node -e running gh is blocked","node -e 'require(\"child_process\").execSync(\"gh pr merge 5\")'","orchestrator:builder",2,"cannot run gh"],
  ["story/x","orchestrator: node -e running gh asks","node -e 'require(\"child_process\").execSync(\"gh pr merge 5\")'","",0,"\"ask\""],
  ["story/x","export \"HUSKY=0\" is blocked","export \"HUSKY=0\"; git commit -m x","",2,"HUSKY"],
  ["story/x","orchestrator: graphql mergeBranch asks","gh api graphql -f query='mutation{mergeBranch(input:{}){clientMutationId}}'","",0,"\"ask\""],
  ["story/x","orchestrator: graphql deleteRef asks","gh api graphql -f query='mutation{deleteRef(input:{}){clientMutationId}}'","",0,"\"ask\""],
  ["story/x","orchestrator: graphql query from $(cat) asks","gh api graphql -f query=\"$(cat m.graphql)\"","",0,"\"ask\""],
  ["story/x","orchestrator: gh alias set asks","gh alias set pm \"pr merge\"","",0,"\"ask\""],
  ["story/x","orchestrator: an unknown gh area asks","gh pm 5","",0,"\"ask\""],
  ["story/x","builder: gh browse is allowed","gh browse","orchestrator:builder",0,""],
  ["story/x","builder: gh status is allowed","gh status","orchestrator:builder",0,""],
  ["story/x","orchestrator: a comment body \"-a\" is not an approval","gh pr review 5 --comment -b \"-a\"","",0,""],
  ["main","session start in the main checkout: orchestrator","","",0,"You are an orchestrator","SessionStart"],
  ["worktree","session start in a linked worktree: an orchestrator too","","",0,"opened in the linked worktree","SessionStart"],
  ["moved","session start when the main checkout is off main says so","","",0,"The main checkout is on explora/x","SessionStart"],
  ["worktree","a session in a linked worktree loads the skill","orchestrator:orchestrate","",0,"","Skill"],
  ["main","the orchestrator loads its skill in the main checkout","orchestrator:orchestrate","",0,"","Skill"],
  ["main","orchestrator: switching the main checkout is blocked","git switch -c explora/botones","",2,"main checkout stays on main"],
  ["main","orchestrator: checkout of a branch in the main checkout is blocked","git checkout story/y","",2,"main checkout stays on main"],
  ["main","builder: switching the main checkout is blocked","git switch story/y","orchestrator:builder",2,"main checkout stays on main"],
  ["main","checkout of a file in the main checkout passes","git checkout -- README.md","",0,""],
  ["worktree","switching inside a linked worktree passes","git switch -c sydneydesign/other","",0,"","Bash","wt-owner"],
  ["main","orchestrator: fetch . x:main asks","git fetch . story/y:main","",0,"moves a protected branch"],
  ["main","orchestrator: push . x:main asks","git push . story/y:main","",0,"moves a protected branch"],
  ["main","orchestrator: branch -f main asks","git branch -f main story/y","",0,"moves a protected branch"],
  ["main","orchestrator: update-ref main asks","git update-ref refs/heads/main story/y","",0,"moves a protected branch"],
  ["story/x","builder: fetch . x:main is blocked","git fetch . story/x:main","orchestrator:builder",2,"never move a protected branch"],
  ["main","fetch origin is not a move","git fetch origin","",0,""],
  ["main","orchestrator: checkout - in the main checkout is blocked","git checkout -","",2,"main checkout stays on main"],
  ["main","orchestrator: checkout story/y -- is blocked","git checkout story/y --","",2,"main checkout stays on main"],
  ["main","orchestrator: checkout -qb is blocked","git checkout -qb explora/z","",2,"main checkout stays on main"],
  ["main","builder: branch -M onto main is blocked","git branch -M story/y main","orchestrator:builder",2,"never move a protected branch"],
  ["main","orchestrator: branch -C onto main asks","git branch -C story/y main","",0,"moves a protected branch"],
  ["main","orchestrator: renaming main away asks","git branch -m main old-main","",0,"moves a protected branch"],
  ["main","orchestrator: push origin x:main asks","git push origin story/y:main","",0,"moves a protected branch"],
  ["main","orchestrator: reset --keep onto a branch on main asks","git reset --keep story/y","",0,"moves a protected branch"],
  ["main","orchestrator: reset of a file on main passes","git reset -- README.md","",0,""],
  ["story/x","builder: branch -f story/y main is allowed","git branch -f story/y main","orchestrator:builder",0,""],
  ["story/x","builder: update-ref of its own branch to main is allowed","git update-ref refs/heads/story/y main","orchestrator:builder",0,""],
  ["main","orchestrator: push origin main passes","git push origin main","",0,""],
  ["main","the orchestrator starts in the main checkout","","",0,"You are an orchestrator","SessionStart","orch"],
  ["worktree","after EnterWorktree, a compaction keeps it the orchestrator","","",0,"You are an orchestrator","SessionStart","orch"],
  ["worktree","after EnterWorktree, it may reload its skill","orchestrator:orchestrate","",0,"","Skill","orch"],
  ["main","builder: update-ref -m onto main is blocked","git update-ref -m ff refs/heads/main story/y","orchestrator:builder",2,"never move a protected branch"],
  ["main","orchestrator: update-ref --stdin asks","git update-ref --stdin","",0,"moves a protected branch"],
  ["main","builder: reset --soft <commit> -- on main is blocked","git reset --soft story/y --","orchestrator:builder",2,"never move a protected branch"],
  ["main","orchestrator: gh pr checkout in the main checkout is blocked","gh pr checkout 12","",2,"main checkout stays on main"],
  ["main","orchestrator: git reset HEAD on main passes","git reset HEAD","",0,""],
  ["main","orchestrator: git switch main on main passes","git switch main","",0,""],
  ["main","orchestrator: push HEAD:main from main passes","git push origin HEAD:main","",0,""],
  ["main","a second session in the main checkout starts","","",0,"You are an orchestrator","SessionStart","second"],
  ["worktree","the first orchestrator still compacts as orchestrator","","",0,"You are an orchestrator","SessionStart","orch"],
  ["main","the orchestrator starts again in the main checkout","","",0,"You are an orchestrator","SessionStart","orch2"],
  ["main","it enters the block's worktree","worktree","",0,"","EnterWorktree","orch2"],
  ["worktree","a /clear there keeps it the orchestrator","","",0,"You are an orchestrator","SessionStart:clear","fresh-after-clear"],
  ["worktree","a session opened fresh there is an orchestrator","","",0,"You are an orchestrator","SessionStart:startup","opened-by-hand"],
  ["main","orchestrator: push origin :main asks","git push origin :main","",0,"moves a protected branch"],
  ["main","orchestrator: push --delete main asks","git push origin --delete main","",0,"moves a protected branch"],
  ["main","builder: update-ref HEAD on main is blocked","git update-ref HEAD story/y","orchestrator:builder",2,"never move a protected branch"],
  ["worktree","a session in a worktree merging into main asks","MAINDIR","",0,"\"ask\"","Bash","worker-1"],
  ["main","orchestrator: checkout -p is not a switch","git checkout -p story/y","",0,""],
  ["main","orchestrator: push HEAD:refs/heads/main from main passes","git push origin HEAD:refs/heads/main","",0,""],
  ["main","builder: checkout of a remote-only branch is blocked","git checkout pr-branch","orchestrator:builder",2,"main checkout stays on main"],
  ["main","builder: switch -d main is blocked","git switch -d main","orchestrator:builder",2,"main checkout stays on main"],
  ["main","builder: symbolic-ref HEAD is blocked","git symbolic-ref HEAD refs/heads/story/y","orchestrator:builder",2,"main checkout stays on main"],
  ["main","builder: bisect start with revisions is blocked","git bisect start HEAD HEAD~1","orchestrator:builder",2,"main checkout stays on main"],
  ["main","reading symbolic-ref HEAD passes","git symbolic-ref HEAD","orchestrator:builder",0,""],
  ["main","builder: branch -D main is blocked","git branch -D main","orchestrator:builder",2,"never move a protected branch"],
  ["worktree","a session opened by hand in a worktree","","",0,"You are an orchestrator","SessionStart:startup","w-compact"],
  ["worktree","stays an orchestrator after its compaction","","",0,"You are an orchestrator","SessionStart:compact","w-compact"],
  ["worktree","gh pr merge from a worktree asks","gh pr merge 5","",0,"\"ask\"","Bash","w-compact"],
  ["worktree","after its /clear it is still an orchestrator","","",0,"You are an orchestrator","SessionStart:clear","w-clear"],
  ["main","builder: checkout -bname attached is blocked","git checkout -bexplora/x","orchestrator:builder",2,"main checkout stays on main"],
  ["main","builder: checkout --orphan=name is blocked","git checkout --orphan=explora/y","orchestrator:builder",2,"main checkout stays on main"],
  ["main","builder: fetch with a glob onto refs/heads is blocked","git fetch origin '+refs/heads/*:refs/heads/*'","orchestrator:builder",2,"never move a protected branch"],
  ["worktree","switch -C main in a worktree asks: it moves main","git switch -C main story/y --ignore-other-worktrees","",0,"moves a protected branch","Bash","wt-owner"],
  ["worktree","committing in a main checkout already off main passes","MOVEDCOMMIT","",0,"","Bash","w-c3"],
  ["main","designer: a python heredoc with a quoted > passes","python3 - <<'EOF'\nprint(\"<p>{a}: b</p>\")\nEOF","orchestrator:designer",0,""],
  ["story/x","a python heredoc that runs git push --force asks","python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['git','push','--force'])\nEOF","",0,"\"ask\""],
  ["main","researcher: a loop variable in a target is blocked (write the full path)","LOOPTMP","orchestrator:researcher",2,"write the full path"],
  ["main","researcher: a loop over a path list is still blocked","LOOPCLIMB","orchestrator:researcher",2,"write the full path"],
  ["main","known false block: a quoted folder glued to a glob is read as two words","GLUEDGLOB","orchestrator:designer",2,""],
  ["main","a session in a symlinked folder still protects locked tests","rm tests/a.test.js","",2,"locked","Bash","symlinked"],
  ["worktree","a session in a worktree nobody set up is told to run setup","","",0,"has not been set up","SessionStart:startup","w-setup"],
  ["claimed","the first session that edits a worktree claims it","x.txt","",0,"","Write","s-a"],
  ["claimed","another session editing there is blocked","x.txt","",2,"belongs to another session","Write","s-b"],
  ["claimed","a role agent of the first session edits there","x.txt","orchestrator:builder",0,"","Write","s-a"],
  ["claimed","a builder in its own Orca session edits there","x.txt","orchestrator:builder",0,"","Write","s-orca"],
  ["claimed","another session committing there is blocked","git commit -m x","",2,"belongs to another session","Bash","s-b"],
  ["claimed","another session reading git there passes","git status","",0,"","Bash","s-b"],
  ["claimed","another session writing a report in the work folder passes",".orchestrator/work/x/r.md","",0,"","Write","s-b"],
  ["main","session start names the worktree another session holds","","",0,"Other sessions work now in","SessionStart","s-c"],
  ["main","session start names the shared ledger","","",0,"shared ledger is","SessionStart","s-c"],
  ["claimed","releasing a worktree asks the human","node sessions.mjs release .","",0,"\"ask\"","Bash","s-b"],
  ["claimed","a role agent cannot release a worktree","node sessions.mjs release .","orchestrator:builder",2,"never release","Bash","s-b"],
  ["claimed","the first session ends","","",0,"","SessionEnd","s-a"],
  ["claimed","then another session edits there","x.txt","",0,"","Write","s-b"],
  ["main","editing in the main checkout claims nothing","y.txt","",0,"","Write","s-a"],
  ["main","another session edits the main checkout too","y.txt","",0,"","Write","s-d"],
  ["main","researcher: ${z:-..} in a target is blocked","TPL1","orchestrator:researcher",2,"read-only"],
  ["main","researcher: $1 in a target is blocked","TPL2","orchestrator:researcher",2,"read-only"],
  ["main","researcher: a loop name reassigned in the body is blocked","TPL3","orchestrator:researcher",2,"read-only"],
  ["story/x","env -S glued with HUSKY=0 is blocked","env -S\"HUSKY=0 git commit -m x\"","",2,"HUSKY"],
  ["main","env -S glued with a locked test is blocked","env -S\"rm tests/a.test.js\"","",2,"locked"],
  ["main","PS: cmd /c glued is checked","cmd /c\"git push --force\"","",2,"force push","PowerShell"],
  ["main","Write through a symlinked folder to a locked test is blocked","LINKWRITE","",2,"locked","Write","symlinked"],
  ["linkedTests","rm through a symlinked tests folder is blocked","rm tests/a.test.js","",2,"locked"],
  ["story/x","a python heredoc inside $( ) is still checked","x=$(python3 - <<EOF\nimport os\nos.system(\"git push --force\")\nEOF\n)","",2,"force push"],
  ["main","researcher: mapfile can set a loop name: blocked","TPL4","orchestrator:researcher",2,"read-only"],
  ["main","researcher: a loop word naming a link into the repo is blocked","TPL5","orchestrator:researcher",2,"read-only"],
  ["main","node heredoc running $( ) on a locked test is blocked","node - <<EOF\n$(rm tests/a.test.js)\nEOF","",2,"locked"],
  ["main","a node heredoc body is read as shell","node - <<'EOF'\nconsole.log(`$(rm tests/a.test.js)`)\nEOF","",2,"locked"],
  ["main","rm \"tests/\"* is blocked","rm \"tests/\"*","",2,"locked"],
  ["main","rm tests/* is blocked","rm tests/*","",2,"locked"],
  ["main","rm tests/{a,b}.test.js is blocked","rm tests/{a,b}.test.js","",2,"locked"],
  ["main","known gap: bash -c with a script in glued pieces is checked by its first piece","bash -c \"git push \"'--force'","",0,""],
  ["main","researcher: select can set a loop name: blocked","TPL6","orchestrator:researcher",2,"read-only"],
  ["main","a session in a symlinked folder: cd .. then rm through the link is blocked","cd .. && rm link-main/tests/a.test.js","",2,"locked","Bash","symlinked"],
  ["main","an unmatched [ does not crash the guard","rm x[ tests/a.test.js","",2,"locked"],
  ["main","rm tests/[!b].test.js is blocked","rm tests/[!b].test.js","",2,"locked"],
  ["main","rm tests/{a..b}.test.js is blocked","rm tests/{a..b}.test.js","",2,"locked"],
  ["linkedTests","rm through the real path of a symlinked tests folder is blocked","rm real/tests/a.test.js","",2,"locked"],
  ["linkedTests","Write through the real path of a symlinked tests folder is blocked","real/tests/a.test.js","",2,"locked","Write"],
  ["main","known gap: env -S with glued pieces is checked by its first piece","env -S\"git push \"'--force'","",0,""],
  ["main","designer: a cat heredoc with $(date) into the temp folder passes","CATDATE","orchestrator:designer",0,""],
  ["main","sed with [ in its script does not crash","sed -i 's/\\[/(/' README.md && git push --force","",2,"force push"],
  ["story/x","builder: git commit -m\"new feature\" passes","git commit -m\"new feature\"","orchestrator:builder",0,""],
  ["main","rm -f *.log at the root passes","rm -f *.log","",0,""],
  ["main","cp *.md docs/ passes","cp *.md docs/","",0,""],
  ["main","a dynamic route folder is not a glob","cp tmp.tsx \"tests/[id]/page.tsx\"","",0,""],
  ["main","rm -rf t* takes the tests folder: blocked","rm -rf t*","",2,"locked"],
  ["linkedTests","a variable path through the real folder asks","rm real/tests/$UNSET_NAME_Z","",0,"\"ask\""],
  ["main","env --split-string= 'rm locked' is blocked","env --split-string='rm tests/a.test.js'","",2,"locked"],
  ["main","rm tests/[[:alpha:]].test.js is blocked","rm tests/[[:alpha:]].test.js","",2,"locked"],
  ["main","rm tests/[]a].test.js is blocked","rm tests/[]a].test.js","",2,"locked"],
  ["main","rm tests/{a,x/y}.test.js is blocked","rm tests/{a,x/y}.test.js","",2,"locked"],
  ["main","rm tests/{a,{b,c}}.test.js is blocked","rm tests/{a,{b,c}}.test.js","",2,"locked"],
  ["main","rm tests/\\a.test.js is blocked","rm tests/\\a.test.js","",2,"locked"],
];
let fail = 0;
let caseNo = 0;
// session: a session id; one starting with orch (or fresh-after-clear) was launched in the main checkout.
for (let [branch, title, command, agent, exit, msg, tool = "Bash", session = `t${++caseNo}`] of cases) {
  if (command === "MAINDIR") command = `git -C "${dirs.main}" merge story/y`;
  const T = realpathSync(os.tmpdir());
  if (command === "LOOPTMP") command = `S=${T}/sp; for f in k8op q49e c47x; do cat x > $S/$f.txt; done`;
  if (command === "LOOPCLIMB") command = `S=${T}/sp; for f in a ../b; do cat x > $S/$f.txt; done`;
  if (command === "GLUEDGLOB") command = `rm -f "${T}/shots/"*.png`;
  if (command === "TPL1") command = `cat x > ${T}/sp/${"${z:-..}"}/${"${z:-..}"}/src.js`;
  if (command === "TPL2") command = `set -- ../..; cat x > ${T}/sp/$1/src.js`;
  if (command === "TPL3") command = `for f in a b; do f=zz; cat x > ${T}/sp/$f; done`;
  if (command === "TPL4") command = `for f in a; do :; done; mapfile -t f < ${T}/l; cat x > ${T}/sp/$f/src.js`;
  if (command === "TPL5") { const sp5 = path.join(base, "sp5"); mkdirSync(sp5, { recursive: true }); try { symlinkSync(dirs.main, path.join(sp5, "r")); } catch { if (!existsSync(path.join(sp5, "r"))) { console.log(`skip ${title} (no symlinks here)`); continue; } } command = `for f in r; do cat x > ${sp5}/$f/src/a.js; done`; }
  if (command === "TPL6") command = `S=${T}/sp; x=.; for f in a; do :; done; select f in $x$x; do cat x > $S/$f/src/a.js; break; done <<< 1`;
  if (command === "CATDATE") command = `cat > ${T}/m.html <<EOF\n<div class=a>built $(date)</div>\nEOF`;
  if (command === "MOVEDCOMMIT") command = `git -C "${dirs.moved}" commit -m x`;
  // tool "SessionStart" sends that event; tool "Skill" loads the skill named in command.
  const event = tool === "SessionStart" ? { hook_event_name: "SessionStart" }
    : tool === "SessionEnd" ? { hook_event_name: "SessionEnd", reason: "exit" }
    : tool === "EnterWorktree" ? { hook_event_name: "PreToolUse", tool_name: "EnterWorktree", tool_input: { path: dirs[command] } }
    : tool.startsWith("SessionStart:") ? { hook_event_name: "SessionStart", source: tool.slice(13) }
    : tool === "Write" ? { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.resolve(dirs[branch], command), content: "x" } }
    : tool === "Skill" ? { hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: command } }
    : { hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command } };
  const input = { ...event, cwd: dirs[branch], session_id: session, ...(agent ? { agent_type: agent, agent_id: "a1" } : {}) };
  // Where Claude Code launched the session (CLAUDE_PROJECT_DIR): the case's folder, except for the orchestrator's
  // sessions (orch…), launched in the main checkout and now working in a worktree it entered.
  const launched = /^(orch|fresh-after-clear)/.test(session) ? dirs.main : dirs[branch];
  if ((session === "symlinked" || branch === "linkedTests") && dirs.linkedTestsOk === false) { console.log(`skip ${title} (no symlinks here)`); continue; }
  if (session === "symlinked") { const link = path.join(base, "link-main"); try { symlinkSync(dirs.main, link); } catch {} input.cwd = link; if (input.tool_name === "Write") input.tool_input.file_path = path.join(link, "tests", "a.test.js"); }
  const r = spawnSync("node", [G], { input: JSON.stringify(input), cwd: dirs[branch], encoding: "utf8", timeout: 20000, env: { ...process.env, CLAUDE_PROJECT_DIR: launched } });
  const out = r.stderr + r.stdout;
  const ok = r.status === exit && (msg ? out.includes(msg) : !out.includes('"ask"'));
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${title}  (exit ${r.status}, want ${exit})${ok && !process.env.VERBOSE ? "" : "  " + (r.stderr + r.stdout).slice(0, 160).replace(/\n/g, " ")}`);
}
rmSync(base, { recursive: true, force: true });
console.log(fail ? `${fail} of ${cases.length} failed` : `all ${cases.length} passed`);
process.exit(fail ? 1 : 0);
