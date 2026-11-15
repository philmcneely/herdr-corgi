// Run: node test_setup.mjs  (Setup's detection → report mapping, with stubbed PATH lookups; Codex detection)
import assert from "node:assert/strict";
import { parseCheck, report, blockers, found, programs, checkScript, pretypeArgv, installHint } from "./setup.js";

const out = (have, auth = "") => programs().map((p) => `${p}=${have.includes(p) ? `/bin/${p}` : ""}`).join("\n") + "\n" + auth;
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

// Everything there and logged in: all ok, no blockers, no install commands.
const all = parseCheck(out(programs(), "auth:gh=1\nauth:claude=1"));
assert.ok(report(all).every((r) => r.status === "ok" && r.install === null));
assert.deepEqual(blockers(report(all)), []);
assert.equal(found(all, "codex"), true);

// Only the required ones: optional and language servers are "optional-missing" with what they enable.
const min = parseCheck(out(["git", "gh", "claude", "python3"], "auth:gh=1\nauth:claude=1"));
const r = byId(report(min, "darwin"));
assert.equal(r.codex.status, "optional-missing");
assert.equal(found(min, "codex"), false); // Codex detection: no codex on PATH, no Codex reviewer
assert.equal(r.jdtls.status, "optional-missing");
assert.equal(r.jdtls.what, "Go to definition and Impact in Java need jdtls");
assert.equal(r.jdtls.install, "brew install jdtls");
assert.equal(report(min, "linux").find((x) => x.id === "jdtls").install, null); // no simple Linux command
assert.equal(r["typescript-language-server"].what, "Go to definition and Impact in TypeScript and JavaScript need typescript-language-server + tsc");
assert.equal(r["terraform-ls"].what, "Go to definition in Terraform needs terraform-ls"); // Impact leaves Terraform to Infrastructure changes
// A language server the bridge could not start: the message names the language, this system's command and Setup.
assert.equal(installHint("pyright-langserver is not installed"), "pyright-langserver is not installed (the language server for Python). Install it with `npm install -g pyright`; the panel's Setup (PRs ▾ → Setup) offers the same command.");
assert.equal(installHint("tsc is not installed", "linux"), "tsc is not installed (the language server for TypeScript and JavaScript). Install it with `npm install -g typescript-language-server typescript`; the panel's Setup (PRs ▾ → Setup) offers the same command.");
assert.equal(installHint("jdtls is not installed", "linux"), "jdtls is not installed (the language server for Java). The panel's Setup (PRs ▾ → Setup) lists it; there is no one-line install for this system.");
assert.equal(installHint("Python server did not answer within 20 s"), "Python server did not answer within 20 s");
assert.deepEqual(blockers(report(min)), []);

// A program for one system only shows there: bwrap is the probes' sandbox on Linux (macOS has sandbox-exec built in).
assert.equal(byId(report(min, "darwin")).bwrap, undefined);
assert.deepEqual([byId(report(min, "linux")).bwrap.status, byId(report(min, "linux")).bwrap.install], ["optional-missing", "sudo apt install bubblewrap"]);
assert.match(byId(report(min, "linux")).bwrap.what, /Without it every probe asks first and its script runs with no sandbox/);
// What a feature needs beyond the program being there, and what happens without it, stands in the row.
assert.match(r.git.what, /From 2\.46 on.*with an older git they do not start in such a clone/);
assert.match(r.codex.what, /permission profile that reads only the PR checkout.*fails the run instead of reading more/);

// A server without its companion (tsc) counts as missing.
const half = parseCheck(out(["git", "gh", "claude", "python3", "typescript-language-server"], "auth:gh=1\nauth:claude=1"));
assert.equal(byId(report(half))["typescript-language-server"].status, "optional-missing");

// Required missing, and gh logged out: both block, with the install or login command.
const bad = parseCheck(out(["git", "gh", "python3"], "auth:gh=0"));
const b = byId(report(bad, "linux"));
assert.equal(b.claude.status, "missing");
assert.equal(b.claude.install, "npm install -g @anthropic-ai/claude-code");
assert.equal(b.gh.status, "logged-out");
assert.equal(b.gh.install, "gh auth login");
assert.deepEqual(blockers(report(bad)).map((x) => x.id), ["gh", "claude"]);

// Nothing checked yet: Codex is not offered.
assert.equal(found(undefined, "codex"), false);
// The script asks for every program, and the pre-typed terminal never runs the command by itself.
assert.ok(programs().every((p) => checkScript().includes(p)));
const argv = pretypeArgv("brew install gh");
assert.equal(argv[0], "sh");
assert.equal(argv.at(-1), "brew install gh");
assert.ok(/vared/.test(argv[2]) && /read -e -i/.test(argv[2]));
// The editors of "Open in <Editor>": optional, and on macOS the app alone counts (the links open through the app).
{
  const script = checkScript();
  assert.ok(script.includes('"Visual Studio Code"') && script.includes('"IntelliJ IDEA Ultimate"') && script.includes("printf '%s=%s\\n' code"), "the check also looks for the apps");
  const got = parseCheck("git=/usr/bin/git\ncode=\nidea=\ncode=/Applications/Visual Studio Code.app\n"), rows = report(got, "darwin");
  assert.deepEqual([rows.find((r) => r.id === "code").status, rows.find((r) => r.id === "idea").status, rows.find((r) => r.id === "idea").need], ["ok", "optional-missing", "optional"]);
}
console.log("ok");
