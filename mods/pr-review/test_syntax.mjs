// Run: node test_syntax.mjs
import assert from "node:assert/strict";
import { tokenize, tokenizeStrict, forward, langOf, firstLineOf, highlightRows, highlightLines, colors, contrast, runs, renderLine, refAt, highlightJob, highlightStep } from "./syntax.js";

// [text, kind] pairs of a line, for readable asserts.
const kinds = (line, lang, state = null) => tokenize(line, lang, state).spans.map((s) => [line.slice(s.start, s.end), s.kind]);
const has = (line, lang, pair, state) => assert.ok(kinds(line, lang, state).some(([t, k]) => t === pair[0] && k === pair[1]), `${lang}: ${JSON.stringify(pair)} in ${JSON.stringify(kinds(line, lang, state))}`);

assert.equal(langOf("src/a.tsx"), "js");
assert.equal(langOf("x/Dockerfile"), "dockerfile");
assert.equal(langOf("main.tf"), "hcl");
assert.equal(langOf("sketch.ino"), "cpp");
assert.equal(langOf("README.md"), "markdown");
assert.equal(langOf("build.gradle.kts"), "kotlin");
assert.equal(langOf("LICENSE"), null);
// Shell by its name: endings, dotfiles, templates of a script, Git hooks, make and just.
for (const p of ["a.sh", "a.bash", "a.zsh", "a.ksh", "a.fish", "test/load.bats", "Start.command", ".envrc", "home/.bashrc", ".zshrc", ".profile", ".env", ".env.local", "prod.env",
  "infra/user_data.sh.tpl", "boot.sh.tftpl", "justfile", "tasks.just", "hooks/pre-commit", ".husky/commit-msg", ".githooks/pre-push"]) assert.equal(langOf(p), "shell", p);
assert.equal(langOf("config.yaml.tpl"), "yaml");
// Make, YAML with more to say (a workflow, a Spring configuration), key=value files and TOML, by their names.
for (const [p, lang] of [["Makefile", "make"], ["sub/makefile", "make"], ["GNUmakefile", "make"], ["rules.mk", "make"], ["win.make", "make"], ["Makefile.inc", "make"], ["Makefile.am", "make"],
  [".github/workflows/ci.yml", "workflow"], [".github/workflows/release.yaml", "workflow"], ["action.yml", "workflow"], [".github/actions/deploy/action.yaml", "workflow"], [".github/dependabot.yml", "yaml"], ["workflows/ci.yml", "yaml"],
  ["src/main/resources/application.yml", "spring"], ["application-prod.yaml", "spring"], ["bootstrap.yml", "spring"], ["compose.yaml", "yaml"], ["template.yaml", "yaml"], ["application.yml.example", "spring"],
  ["application.properties", "properties"], ["gradle.properties", "properties"], ["tox.ini", "properties"], ["setup.cfg", "properties"], ["app.conf", "properties"], [".editorconfig", "properties"], [".npmrc", "properties"],
  ["pyproject.toml", "toml"], ["Cargo.lock", "toml"], ["Pipfile", "toml"], ["package-lock.json", "json"], [".env", "shell"]]) assert.equal(langOf(p), lang, p);
assert.equal(langOf("docs/hooks/readme"), "shell"); // a guess by the folder, which the first line overrules:
assert.equal(langOf("hooks/pre-commit", "#!/usr/bin/env python3"), "python");
// A file without an ending, by its first line.
for (const [first, lang] of [["#!/bin/sh", "shell"], ["#!/bin/bash -eu", "shell"], ["#! /usr/bin/env bash", "shell"], ["#!/usr/bin/env zsh", "shell"], ["#!/usr/bin/env dash", "shell"], ["#!/bin/ksh", "shell"],
  ["#!/usr/bin/env -S bash -x", "shell"], ["#!/usr/bin/python3.12", "python"], ["#!/usr/bin/env python", "python"], ["#!/usr/bin/env node", "js"], ["#!/usr/bin/env -S deno run", "js"],
  ["#!/usr/bin/perl", null], ["# just a comment", null], ["", null]]) assert.equal(langOf("bin/release", first), lang, first);
assert.equal(langOf("tool.py", "#!/bin/sh"), "python"); // the ending wins
// firstLineOf: line 1 from a file's diff, or that the file is executable when the diff starts further down.
assert.equal(firstLineOf(["diff --git a/bin/x b/bin/x", "new file mode 100755", "index 0000000..1111111", "--- /dev/null", "+++ b/bin/x", "@@ -0,0 +1,2 @@", "+#!/usr/bin/env bash", "+echo hi"]), "#!/usr/bin/env bash");
assert.equal(firstLineOf(["diff --git a/bin/x b/bin/x", "deleted file mode 100755", "--- a/bin/x", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-#!/bin/sh", "-echo hi"]), "#!/bin/sh");
assert.equal(langOf("bin/x", firstLineOf(["diff --git a/bin/x b/bin/x", "index 2222222..3333333 100755", "--- a/bin/x", "+++ b/bin/x", "@@ -12,3 +12,3 @@", " a", "-b", "+c"])), "shell");
assert.equal(langOf("bin/x", firstLineOf(["diff --git a/bin/x b/bin/x", "index 2222222..3333333 100644", "--- a/bin/x", "+++ b/bin/x", "@@ -12,3 +12,3 @@", " a"])), null);
assert.equal(langOf("NOTES", firstLineOf(["new file mode 100755", "@@ -0,0 +1 @@", "+Just text."])), null); // line 1 is known and no "#!"
assert.equal(firstLineOf([]), "");

// JS/TS: keywords, definitions, calls, members, PascalCase types, strings, comments.
const ts = kinds('export class Foo extends Bar { run() { return this.x.go(1, "a") } } // done', "js");
for (const p of [["export", "keyword"], ["Foo", "type"], ["Bar", "type"], ["run", "function"], ["go", "function"], ["x", "variable"], ["1", "number"], ['"a"', "string"], ["// done", "comment"]])
  assert.ok(ts.some(([t, k]) => t === p[0] && k === p[1]), JSON.stringify(p));
assert.ok(tokenize("const s = new Map()", "js").spans.find((s) => s.kind === "type").ref);
// Block comment and template literal carried across lines.
let r = tokenize("const a = 1; /* start", "js");
assert.deepEqual(r.state, { c: 1, end: "*/" });
r = tokenize("still comment */ const b = `x", "js", r.state);
assert.deepEqual(r.spans[0], { start: 0, end: 16, kind: "comment" });
assert.deepEqual(r.state, { end: "`" });
assert.deepEqual(kinds("y` + z", "js", r.state)[0], ["y`", "string"]);

// Python: def/class, decorators, f-strings, triple quotes across lines.
has("def load(path: str) -> Config:", "python", ["load", "function"]);
has("def load(path: str) -> Config:", "python", ["Config", "type"]);
has("@dataclass", "python", ["@dataclass", "function"]);
has('x = f"{a}" if True else None', "python", ['f"{a}"', "string"]);
has("x = True", "python", ["True", "boolean"]);
r = tokenize('doc = """first', "python");
assert.deepEqual(r.state, { end: '"""' });
r = tokenize('end""" + str(x)', "python", r.state);
assert.equal(r.state, null);
assert.deepEqual(kinds('end""" + str(x)', "python", { end: '"""' })[0], ['end"""', "string"]);

// Java: annotations, text blocks, generics.
has("@Override public List<String> names() {", "java", ["@Override", "type"]);
has("@Override public List<String> names() {", "java", ["List", "type"]);
has("record Point(int x, int y) {}", "java", ["Point", "type"]);
assert.deepEqual(tokenize('String q = """', "java").state, { end: '"""' });

// Go, Rust, HCL, YAML, JSON, Shell, SQL, Dockerfile, C++.
has("func (s *Server) Handle(w http.ResponseWriter) error {", "go", ["Handle", "function"]);
has("func (s *Server) Handle(w http.ResponseWriter) error {", "go", ["error", "type"]);
assert.deepEqual(tokenize("var s = `raw", "go").state, { end: "`" });
has("fn parse<'a>(s: &'a str) -> Result<Self, Error> { println!(\"x\"); }", "rust", ["parse", "function"]);
has("fn parse<'a>(s: &'a str) -> Result<Self, Error> { println!(\"x\"); }", "rust", ["'a", "type"]);
has("fn parse<'a>(s: &'a str) -> Result<Self, Error> { println!(\"x\"); }", "rust", ["println", "function"]);
has('resource "aws_s3_bucket" "logs" {', "hcl", ["resource", "keyword"]);
has("  bucket = var.name # c", "hcl", ["bucket", "variable"]);
r = tokenize("  policy = <<EOF", "hcl");
assert.deepEqual(r.state, { h: "EOF" });
assert.equal(tokenize("EOF", "hcl", r.state).state, null);
has("on: [push] # trigger", "yaml", ["on", "function"]);
has("enabled: true", "yaml", ["true", "boolean"]);
has('{"name": "x", "n": 1, "ok": null}', "json", ['"name"', "function"]);
has('{"name": "x", "n": 1, "ok": null}', "json", ['"x"', "string"]);
has('git log --format="%h" $REV | head', "shell", ["git", "function"]);
has('git log --format="%h" $REV | head', "shell", ["$REV", "constant"]);
has('git log --format="%h" $REV | head', "shell", ["head", "function"]);
// Shell: a script as it is written (invented), line by line with the state carried on.
{
  const script = String.raw`#!/usr/bin/env bash
# Rotates the signing key of the reminder queue.
set -euo pipefail
readonly QUEUE="library-reminders"
KEEP=3
STATE_DIR="${"$"}{STATE_DIR:-$HOME/.cache/rotate-$QUEUE}"
declare -a KEYS=("primary" "standby")
url="https://example.test/keys#latest"   # the fragment is no comment
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
function usage {
  cat <<-EOF
	usage: $0 status | rotate [--keep N]
	EOF
}
newest() {
  local count=${"$"}{#KEYS[@]} id
  for id in "${"$"}{KEYS[@]}"; do
    if [[ -s "$STATE_DIR/$id.pem" && "$id" != tmp-* ]]; then
      echo "$id $(stat -f %m "$STATE_DIR/$id.pem" 2>/dev/null || echo 0)"
    fi
  done | sort -k2 -nr | head -n "$count"
}
rotate() {
  cat > "key.json" <<'json'
{ "note": "$not_expanded" }
json
  if (( $(ls -1 key-*.pem | wc -l) > KEEP )); then
    ls -1t key-*.pem | tail -n +$((KEEP + 1)) | xargs rm -f --
  fi
  log "now ${"`"}ls -1 | wc -l${"`"} keys; it's done" a#b $#
  aws s3 cp --quiet \
    src "$dst" &&
    echo copied
}
case "$1" in
  status) newest; exit 0 ;;
  -h | --help) usage ;;
  *) echo "unknown: $1" >&2; exit 2 ;;
esac`.split("\n");
  let st = null;
  const got = script.map((line) => { const t = tokenize(line, "shell", st); st = t.state; return t.spans.map((s) => [line.slice(s.start, s.end), s.kind]); });
  const at = (start) => got[script.findIndex((l) => l.trimStart().startsWith(start))];
  const want = (start, ...pairs) => { for (const p of pairs) assert.ok(at(start).some(([t, k]) => t === p[0] && k === p[1]), `${start}: ${JSON.stringify(p)} in ${JSON.stringify(at(start))}`); };
  const none = (start, text, kind) => assert.ok(!at(start).some(([t, k]) => t.includes(text) && k === kind), `${start}: no ${kind} ${text} in ${JSON.stringify(at(start))}`);
  assert.equal(st, null, "nothing is left open at the end");
  assert.deepEqual(got[0], [["#!/usr/bin/env bash", "comment"]]);
  want("set", ["set", "keyword"], ["-euo", "type"]);
  want("readonly", ["readonly", "keyword"], ["QUEUE", "constant"], ["=", "operator"]);
  want("KEEP=3", ["KEEP", "constant"], ["3", "number"]);
  want("STATE_DIR", ["STATE_DIR", "constant"], ["${STATE_DIR:-$HOME/.cache/rotate-$QUEUE}", "constant"]); // inside the quotes
  want("declare", ["-a", "type"], ["KEYS", "constant"]); none("declare", "primary", "function");
  want("url=", ["# the fragment is no comment", "comment"]); none("url=", "#latest", "comment");
  want("log()", ["log", "function"], ["printf", "function"], ["'%s %s\\n'", "string"], ["$(", "operator"], ["date", "function"], ["-u", "type"], ["$*", "constant"], [">&2", "operator"]);
  want("function usage", ["function", "keyword"], ["usage", "function"]);
  want("cat <<-EOF", ["cat", "function"], ["<<-EOF", "keyword"]);
  want("usage: $0", ["$0", "constant"], ["\tusage: ", "string"]); // the heredoc's body
  assert.deepEqual(at("EOF"), [["\tEOF", "keyword"]]);
  want("local count", ["local", "keyword"], ["count", "constant"], ["${#KEYS[@]}", "constant"], ["id", "constant"]); none("local count", "#KEYS", "comment");
  want("for id", ["for", "keyword"], ["id", "constant"], ["in", "keyword"], ["do", "keyword"]);
  want("if [[", ["if", "keyword"], ["[[", "keyword"], ["-s", "type"], ["$id", "constant"], ["&&", "operator"], ["!=", "operator"], ["]]", "keyword"], ["then", "keyword"]);
  want("echo \"$id", ["echo", "function"], ["stat", "function"], ["2>", "operator"], ["||", "operator"], ["0", "number"]);
  assert.equal(at("echo \"$id").filter(([t, k]) => t === "echo" && k === "function").length, 2, "a command again after ||");
  want("done |", ["done", "keyword"], ["|", "operator"], ["sort", "function"], ["head", "function"], ["-n", "type"]);
  want("cat > \"key.json\"", [">", "operator"], ["<<'json'", "keyword"]);
  assert.deepEqual(at("{ \"note\""), [['{ "note": "$not_expanded" }', "string"]]); // a quoted marker: "$" stays text
  assert.deepEqual(at("json"), [["json", "keyword"]]); // a marker in small letters
  want("if ((", ["((", "keyword"], ["ls", "function"], ["wc", "function"], ["))", "keyword"]); none("if ((", "KEEP", "function");
  want("ls -1t", ["tail", "function"], ["xargs", "function"], ["1", "number"], ["--", "type"]); none("ls -1t", "rm", "function");
  want("log \"now", ["log", "function"], ["`", "operator"], ["ls", "function"], ["wc", "function"], [" keys; it's done\"", "string"], ["$#", "constant"]); none("log \"now", "a#b", "comment");
  none("src", "src", "function"); want("src", ["$dst", "constant"], ["&&", "operator"]); // "\" before it: arguments go on
  want("echo copied", ["echo", "function"]); // "&&" before it: a command
  want("case", ["case", "keyword"], ["in", "keyword"]);
  want("status)", ["status", "string"], ["newest", "function"], ["exit", "keyword"], [";;", "operator"]);
  want("-h |", ["-h | --help", "string"], ["usage", "function"]);
  want("*)", ["*", "string"], ["echo", "function"], [">&2", "operator"], ["2", "number"]);
  // Lines of their own: what stays open, and what must not hang or mislead.
  assert.deepEqual(tokenize("echo 'two", "shell").state, { s: "'", k: false });
  assert.equal(tokenize("lines' | wc", "shell", { s: "'", k: false }).state, null);
  assert.deepEqual(tokenize('x="$(aws sts get-caller-identity \\', "shell").state, { s: '"(', k: true });
  has('  --query Account)" && echo ok', "shell", ["echo", "function"], { s: '"(', k: true });
  assert.deepEqual(tokenize("cat <<EOF | grep x", "shell").state, { h: "EOF", raw: false, tabs: false, s: "" });
  assert.equal(tokenize("id=$(org list-parents --child-id \"$id\")", "shell").state, null); // "$(" outside quotes hung the old tokenizer
  has("id=$(org list-parents)", "shell", ["org", "function"]);
  has('AWS_PROFILE="$p" aws s3 ls', "shell", ["aws", "function"]);
  has("for ((i = 0; i < 10; i++)); do echo $i; done", "shell", ["echo", "function"]);
  has("POLICIES=(one two)", "shell", ["POLICIES", "constant"]);
  assert.ok(!kinds("POLICIES=(one two)", "shell").some(([, k]) => k === "function"));
  has("RUN apt-get update && apt-get install -y curl", "dockerfile", ["-y", "type"]);
  has("```sh", "markdown", ["```sh", "punctuation"], "md");
  has("echo $HOME", "markdown", ["echo", "function"], tokenize("```bash", "markdown", "md").state);
  assert.deepEqual(kinds("#!/usr/bin/env node", "js"), [["#!/usr/bin/env node", "comment"]]);
  assert.ok(kinds("#![allow(dead_code)]", "rust").length > 1); // an attribute, no "#!" line
}
has("SELECT id, name FROM users WHERE id = 1 -- x", "sql", ["SELECT", "keyword"]);
has("select id from t", "sql", ["from", "keyword"]);
has("FROM node:20 AS build", "dockerfile", ["AS", "keyword"]);
has('RUN npm ci && echo "ok"', "dockerfile", ["RUN", "keyword"]);
assert.deepEqual(tokenize("RUN a \\", "dockerfile").state, { cont: 1 });
has("#include <vector>", "cpp", ["#include", "keyword"]);
has("#include <vector>", "cpp", ["<vector>", "string"]);
has("template <typename T> class Foo : public Bar {", "cpp", ["Foo", "type"]);
has("std::vector<int> v = make(1);", "cpp", ["vector", "variable"]);
has("std::vector<int> v = make(1);", "cpp", ["make", "function"]);
r = tokenize('auto s = R"x(raw', "cpp");
assert.deepEqual(r.state, { end: ')x"' });
assert.equal(tokenize('more)x"; int y;', "cpp", r.state).state, null);
assert.deepEqual(tokenize("x", "nope"), { spans: [], state: null });

// Markdown: headings, fences in their language, links with href, inline code, emphasis, lists, front matter.
has("## Setup", "markdown", ["## Setup", "keyword"]);
const link = tokenize("See [the docs](../docs/a.md#install) and https://x.io.", "markdown", "md").spans.filter((s) => s.href);
assert.deepEqual(link.map((s) => s.href), ["../docs/a.md#install", "../docs/a.md#install", "https://x.io."]);
has("Use `npm ci` and **care**, not snake_case_name", "markdown", ["`npm ci`", "string"], "md");
has("Use `npm ci` and **care**, not snake_case_name", "markdown", ["**care**", "type"], "md");
assert.ok(!kinds("not snake_case_name here", "markdown", "md").length);
has("- [x] done", "markdown", ["-", "operator"], "md");
r = tokenize("```ts", "markdown", "md");
assert.equal(r.state.lang, "js");
has("const x = 1", "markdown", ["const", "keyword"], r.state);
assert.equal(tokenize("```", "markdown", r.state).state, null);
const fm = highlightLines(["---", "title: Hi", "---", "# Head"], "markdown");
assert.equal(fm[1][0].kind, "function");
assert.equal(fm[3][0].kind, "keyword");

// Diff rows: each side keeps its own state; hunk headers reset.
const rows = [{ kind: "@", text: "@@" }, { kind: "-", text: "/* old" }, { kind: "+", text: "let a = 1" }, { kind: " ", text: "b */ c" }, { kind: "@", text: "@@" }, { kind: "+", text: "x */" }];
const hl = highlightRows(rows, "js", "a.js");
assert.equal(hl[1][0].kind, "comment");
assert.equal(hl[2][0].kind, "keyword"); // new side never saw "/* old"
assert.notEqual(hl[3][0].kind, "comment"); // context row follows the new side's state
assert.notEqual(hl[5][0]?.kind, "comment"); // reset at "@"
assert.equal(highlightRows(rows, "js", "a.js"), hl); // memoized
assert.deepEqual(highlightRows(rows, null), rows.map(() => []));

// Colors: theme ANSI kept when readable, replaced when not.
const dark = { background: "#21252b", foreground: "#abb2bf", dim: "#5c6370", muted: "#7f848e", ansi1: "#e06c75", ansi2: "#98c379", ansi3: "#e5c07b", ansi4: "#61afef", ansi5: "#c678dd", ansi6: "#56b6c2", ansi14: "#56b6c2" };
const c = colors(dark);
assert.equal(c.keyword, "#c678dd");
const light = { ...dark, background: "#ffffff", foreground: "#1f2328", ansi3: "#f0f000" }; // unreadable yellow on white
const cl = colors(light);
assert.notEqual(cl.type, "#f0f000");
for (const [k, v] of Object.entries(cl)) if (k !== "comment") assert.ok(contrast(v, "#ffffff") >= 3, `${k} ${v}`);

// Runs: same-color neighbours merge, ref spans stay alone, text is covered exactly.
const line = "foo.bar(x) + 1";
const rs = runs(line, tokenize(line, "js").spans, c);
assert.equal(rs.map((x) => x.text).join(""), line);
assert.ok(rs.find((x) => x.text === "bar" && x.span?.ref));
const els = renderLine(() => { const e = { calls: [], child(t) { e.text = t; return e; } }; for (const m of ["flex_none", "whitespace_nowrap", "text_color"]) e[m] = () => e; return e; }, line, tokenize(line, "js").spans, c, (el, run) => ({ ...el, ref: run.text }));
assert.ok(els.some((e) => e.ref === "bar"));
assert.equal(line.slice(refAt(tokenize(line, "js").spans, 5).start, refAt(tokenize(line, "js").spans, 5).end), "bar");
assert.equal(refAt(tokenize(line, "js").spans, 11), null);

// Performance: 10k lines of mixed code.
const sample = ['import { a, b } from "./x.js";', "export function foo(bar, baz) {", "  const q = bar.map((x) => x * 2).filter(Boolean); // note",
  "  /* block */ return new Thing(q, `tpl ${baz}`);", "}", "class Thing extends Base { constructor(a, b) { super(a); this.b = b ?? 0x1f; } }"];
const big = Array.from({ length: 10000 }, (_, i) => ({ kind: i % 7 === 0 ? "-" : i % 5 === 0 ? "+" : " ", text: sample[i % sample.length] }));
const py = Array.from({ length: 10000 }, (_, i) => ({ kind: " ", text: ['def f(x: int) -> "Foo":', '    return {"a": [1, 2.5, None]}  # c', "    s = f'{x!r}' + other.call(y)"][i % 3] }));
highlightRows(big.slice(0, 500), "js"); // warm up the JIT
// ---- Make, YAML, key=value files, TOML: an invented file each, line by line with the state carried on
// file(lines, lang): what each line got, [[text, kind], …]; every line's spans are in order, do not overlap and stay
// inside the line (a recipe and a workflow's script mix two scanners' spans).
const file = (lines, lang) => {
  let st = null;
  const got = lines.map((l) => {
    const t = tokenize(l, lang, st); st = t.state;
    t.spans.forEach((x, k) => assert.ok(x.start < x.end && x.end <= l.length && (k === 0 || t.spans[k - 1].end <= x.start), `${lang}: spans of ${JSON.stringify(l)}: ${JSON.stringify(t.spans)}`));
    return t.spans.map((x) => [l.slice(x.start, x.end), x.kind]);
  });
  const at = (start) => { const k = lines.findIndex((l) => l.trimStart().startsWith(start)); assert.ok(k >= 0, `no line starts with ${start}`); return got[k]; };
  return { got, state: st, at,
    want: (start, ...pairs) => { for (const p of pairs) assert.ok(at(start).some(([t, k]) => t === p[0] && k === p[1]), `${lang} ${JSON.stringify(start)}: ${JSON.stringify(p)} in ${JSON.stringify(at(start))}`); },
    none: (start, text, kind) => assert.ok(!at(start).some(([t, k]) => t.includes(text) && (!kind || k === kind)), `${lang} ${JSON.stringify(start)}: no ${kind ?? "span"} with ${text} in ${JSON.stringify(at(start))}`) };
};
{
  const mk = ["# Builds and ships the reminder service.", "SHELL := /bin/bash", "APP ?= reminders", "VERSION = $(shell git describe --tags --always)", "SRCS := $(wildcard src/*.c) \\", "        extra/util.c",
    "OBJS = $(patsubst %.c,build/%.o,$(SRCS))", "CFLAGS += -Wall -O2 # warnings on", "export AWS_REGION ?= eu-west-1", "include config.mk", "-include local.mk", "ifeq ($(OS),Windows_NT)", "  EXE := .exe", "else ifdef CI", "endif",
    ".PHONY: all clean test", "all: build/$(APP)$(EXE) | build", "build/%.o: %.c include/app.h", "\t@mkdir -p $(dir $@)", "\t$(CC) $(CFLAGS) -c $< -o $@", "build/$(APP)$(EXE): $(OBJS)",
    "\t$(CC) -o $@ $^ && echo \"built $@ at $$(date +%H:%M)\"", "test: all", "\t-rm -f report.xml", "\tfor f in tests/*.sh; do \\", "\t  bash \"$$f\" || exit 1; \\", "\tdone", "deploy: VERSION := release",
    "deploy: all ; @echo \"deploying $(VERSION)\"", "define banner", "echo \"== $(1) ==\"", "endef", "lint tidy:", "        ruff check src   # drawn with spaces, as the diff view does", "        X=1 ./run.sh"];
  const f = file(mk, "make");
  assert.equal(f.state, null);
  assert.deepEqual(f.got[0], [["# Builds and ships the reminder service.", "comment"]]);
  f.want("SHELL :=", ["SHELL", "variable"], [":=", "operator"]); f.want("APP ?=", ["APP", "variable"], ["?=", "operator"]);
  f.want("VERSION =", ["VERSION", "variable"], ["=", "operator"], ["$(", "variable"], ["shell", "function"], ["git", "function"], ["--tags", "type"], [")", "variable"]);
  f.want("SRCS :=", ["wildcard", "function"]); assert.deepEqual(f.at("extra/util.c"), []); // the value goes on after "\": no command
  f.want("OBJS =", ["patsubst", "function"], ["$(SRCS)", "variable"]);
  f.want("CFLAGS +=", ["CFLAGS", "variable"], ["+=", "operator"], ["# warnings on", "comment"]);
  f.want("export AWS_REGION", ["export", "keyword"], ["AWS_REGION", "variable"], ["?=", "operator"]);
  f.want("include config.mk", ["include", "keyword"]); f.want("-include", ["-include", "keyword"]);
  f.want("ifeq", ["ifeq", "keyword"], ["$(OS)", "variable"]); f.want("EXE := .exe", ["EXE", "variable"]); f.want("else ifdef", ["else", "keyword"], ["ifdef", "keyword"]); f.want("endif", ["endif", "keyword"]);
  f.want(".PHONY", [".PHONY", "keyword"], [":", "operator"]); f.none(".PHONY", "clean", "function");
  f.want("all:", ["all", "function"], ["$(APP)", "variable"]);
  f.want("build/%.o:", ["build/%.o", "function"], [":", "operator"]); f.none("build/%.o:", "%.c", "function");
  f.want("@mkdir", ["@", "operator"], ["mkdir", "function"], ["-p", "type"], ["dir", "function"], ["$@", "variable"]);
  f.want("$(CC) $(CFLAGS)", ["$(CC)", "variable"], ["$(CFLAGS)", "variable"], ["-c", "type"], ["$<", "variable"], ["$@", "variable"]); f.none("$(CC) $(CFLAGS)", "CC", "function");
  f.want("build/$(APP)$(EXE):", ["build/", "function"], ["$(APP)", "variable"], ["$(OBJS)", "variable"]);
  f.want("$(CC) -o", ["$^", "variable"], ["&&", "operator"], ["echo", "function"], ["built ", "string"], ["$@", "variable"], ["$", "operator"], ["date", "function"]); // "$$(date)": the shell's
  f.want("-rm", ["-", "operator"], ["rm", "function"], ["-f", "type"]);
  f.want("for f in", ["for", "keyword"], ["do", "keyword"]); f.want("bash \"$$f\"", ["bash", "function"], ["$f", "constant"], ["exit", "keyword"]); f.want("done", ["done", "keyword"]); // one command over three lines
  f.want("deploy: VERSION", ["deploy", "function"], ["VERSION", "variable"], [":=", "operator"]);
  f.want("deploy: all", ["deploy", "function"], [";", "punctuation"], ["@", "operator"], ["echo", "function"], ["$(VERSION)", "variable"]);
  f.want("define banner", ["define", "keyword"], ["banner", "variable"]); f.want("echo \"== ", ["$(1)", "variable"]); assert.deepEqual(f.at("endef"), [["endef", "keyword"]]);
  f.want("lint tidy:", ["lint", "function"], ["tidy", "function"]);
  f.want("ruff check", ["ruff", "function"], ["# drawn with spaces, as the diff view does", "comment"]); f.want("X=1", ["X", "constant"], ["./run.sh", "function"]);
  assert.deepEqual(tokenize("\tfor f in a b; do \\", "make").state, { m: "r", sh: null });
  assert.deepEqual(tokenize("\taws s3 cp a \\", "make").state, { m: "r", sh: { s: "", k: true } });
  assert.deepEqual(tokenize("SRCS := a.c \\", "make").state, { m: "v" });
  has("```makefile", "markdown", ["```makefile", "punctuation"], "md");
  has("all: build", "markdown", ["all", "function"], tokenize("```make", "markdown", "md").state);
}
{
  const wf = ["name: CI", "on:", "  push:", "    branches: [main, \"release/**\"]", "  workflow_dispatch:", "    inputs:", "      stage: { description: \"Where to deploy\", required: true, default: dev }", "permissions:", "  contents: read",
    "concurrency:", "  group: ci-${{ github.ref }}", "env:", "  NODE_VERSION: 20", "  REGISTRY: ghcr.io/example/reminders # the image", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    strategy:", "      matrix:",
    "        python: [\"3.11\", \"3.12\"]", "    steps:", "      - uses: actions/checkout@v4", "      - uses: actions/setup-python@0b93645e9fea7318ecaed2b359559ac225c90a2b # v5.3.0", "        with:", "          python-version: ${{ matrix.python }}",
    "      - name: Test", "        if: github.event_name == 'push' && !contains(github.event.head_commit.message, '[skip ci]')", "        run: |", "          set -euo pipefail",
    "          pytest -q --junitxml=\"report-${{ matrix.python }}.xml\" | tee out.log", "          cat <<EOF > notes.txt", "          built by ${{ github.actor }} in $HOME", "          EOF", "          if [ \"${{ github.ref }}\" = \"refs/heads/main\" ]; then",
    "            echo \"sha=$(git rev-parse --short HEAD)\" >> \"$GITHUB_OUTPUT\"", "          fi", "        env:", "          TOKEN: ${{ secrets.DEPLOY_TOKEN }}", "      - run: echo \"done on ${{ runner.os }}\" && ls -la",
    "  deploy:", "    needs: [build]", "    if: ${{ success() && startsWith(github.ref, 'refs/tags/') }}", "    steps:", "      - uses: ./.github/actions/deploy"];
  const f = file(wf, "workflow");
  assert.equal(f.state, null);
  f.want("name: CI", ["name", "keyword"], [":", "punctuation"]); f.want("on:", ["on", "keyword"]); f.none("on:", "on", "boolean");
  f.want("branches:", ["branches", "keyword"], ["[", "punctuation"], ["\"release/**\"", "string"]);
  f.want("stage: {", ["stage", "function"], ["description", "function"], ["\"Where to deploy\"", "string"], ["true", "boolean"]);
  f.want("group:", ["${{", "operator"], ["github", "variable"], ["}}", "operator"]);
  f.want("NODE_VERSION", ["NODE_VERSION", "function"], ["20", "number"]); f.want("REGISTRY", ["# the image", "comment"]);
  f.want("build:", ["build", "function"]); f.want("runs-on", ["runs-on", "keyword"]);
  f.want("- uses: actions/checkout", ["-", "operator"], ["uses", "keyword"], ["@", "operator"], ["v4", "constant"]);
  f.want("- uses: actions/setup-python", ["0b93645e9fea7318ecaed2b359559ac225c90a2b", "constant"], ["# v5.3.0", "comment"]);
  f.want("python-version", ["python-version", "function"], ["matrix", "variable"]);
  f.want("if: github", ["if", "keyword"], ["github", "variable"], ["==", "operator"], ["'push'", "string"], ["&&", "operator"], ["!", "operator"], ["contains", "function"], ["'[skip ci]'", "string"]);
  f.want("run: |", ["run", "keyword"], ["|", "operator"]);
  f.want("set -euo", ["set", "keyword"], ["-euo", "type"]); // the script is shell
  f.want("pytest", ["pytest", "function"], ["--junitxml", "type"], ["report-", "string"], ["${{", "operator"], ["matrix", "variable"], [".xml\"", "string"], ["|", "operator"], ["tee", "function"]);
  f.want("cat <<EOF", ["cat", "function"], ["<<EOF", "keyword"]); f.want("built by", ["built by ", "string"], ["github", "variable"], ["$HOME", "constant"]); assert.deepEqual(f.at("EOF"), [["EOF", "keyword"]]);
  f.want("if [ \"${{", ["if", "keyword"], ["[", "keyword"], ["github", "variable"], ["then", "keyword"]);
  f.want("echo \"sha=", ["echo", "function"], ["git", "function"], [">>", "operator"], ["$GITHUB_OUTPUT", "constant"]); f.want("fi", ["fi", "keyword"]);
  f.want("env:", ["env", "keyword"]); f.want("TOKEN:", ["TOKEN", "function"], ["secrets", "variable"]); // after the script: YAML again
  f.want("- run: echo", ["run", "keyword"], ["echo", "function"], ["runner", "variable"], ["&&", "operator"], ["ls", "function"], ["-la", "type"]);
  f.want("if: ${{", ["success", "function"], ["startsWith", "function"], ["'refs/tags/'", "string"]);
  f.none("- uses: ./.github", "@");
  assert.deepEqual(tokenize("        run: |", "workflow").state, { b: 8, run: 1, sh: null });
  assert.deepEqual(tokenize("        run: |", "yaml").state, { b: 8 }); // plain YAML: a block of text
}
{
  const yml = ["---", "# Settings of the reminder service in production.", "spring:", "  datasource:", "    url: jdbc:postgresql://${DB_HOST:localhost}:5432/library", "    hikari: &pool", "      maximum-pool-size: 10", "  profiles.active: prod",
    "replica:", "  <<: *pool", "  read-only: yes", "server:", "  port: 8080", "  version: 1.2.3", "  on: true", "reminders:", "  ratio: 0.75", "  sender: \"noreply@example.test\"", "  subject: 'It''s due: ${title}'",
    "  greeting: \"#{T(java.time.LocalDate).now().getYear()}\"", "  empty: ~", "  nothing: null", "  tags: !!set {a, b}", "  cron: \"0 0 7 * * *\" # every morning", "  template: |", "    Dear ${name},", "", "    your loan: is due # no comment", "  folded: >-",
    "    one long", "  after: yes", "list:", "  - plain text: with a colon", "  - http://example.test:8080/path#frag", "  - - nested", "    - 12:30", "  - key: value", "    other: [1, 2.5, true, text]", "  QueueName: !Sub \"${AWS::StackName}-events\"",
    "  long: \"a quoted text", "    that goes on\" # done", "  last: 1"];
  const f = file(yml, "spring");
  assert.equal(f.state, null);
  assert.deepEqual(f.got[0], [["---", "punctuation"]]);
  f.want("url:", ["url", "function"], ["${DB_HOST:localhost}", "variable"]); f.none("url:", "5432", "number");
  f.want("hikari:", ["&pool", "constant"]); f.want("maximum-pool-size", ["maximum-pool-size", "function"], ["10", "number"]); f.want("profiles.active", ["profiles.active", "function"]);
  f.want("<<:", ["<<", "operator"], ["*pool", "constant"]); f.want("read-only", ["yes", "boolean"]);
  f.want("port:", ["8080", "number"]); f.none("version:", "1.2", "number"); f.want("on: true", ["on", "function"], ["true", "boolean"]);
  f.want("ratio:", ["0.75", "number"]); f.want("sender:", ["\"noreply@example.test\"", "string"]);
  f.want("subject:", ["'It''s due: ", "string"], ["${title}", "variable"]); f.want("greeting:", ["#{T(java.time.LocalDate).now().getYear()}", "variable"]);
  f.want("empty:", ["~", "constant"]); f.want("nothing:", ["null", "constant"]); f.want("tags:", ["!!set", "type"], ["{", "punctuation"]);
  f.want("cron:", ["\"0 0 7 * * *\"", "string"], ["# every morning", "comment"]);
  f.want("template:", ["|", "operator"]); f.want("Dear", ["Dear ", "string"], ["${name}", "variable"]); assert.deepEqual(f.at("your loan"), [["your loan: is due # no comment", "string"]]);
  f.want("folded:", [">-", "operator"]); assert.deepEqual(f.at("one long"), [["one long", "string"]]); f.want("after:", ["after", "function"], ["yes", "boolean"]);
  f.want("- plain text", ["-", "operator"], ["plain text", "function"]); assert.deepEqual(f.at("- http://"), [["-", "operator"]]); // no key, no comment
  assert.deepEqual(f.at("- - nested"), [["-", "operator"], ["-", "operator"]]); assert.deepEqual(f.at("- 12:30"), [["-", "operator"]]);
  f.want("other:", ["1", "number"], ["2.5", "number"], ["true", "boolean"], [",", "punctuation"]); f.none("other:", "text");
  f.want("QueueName", ["!Sub", "type"], ["${AWS::StackName}", "variable"], ["-events\"", "string"]);
  assert.deepEqual(f.at("long:").at(-1), ["\"a quoted text", "string"]); assert.deepEqual(f.at("that goes on"), [["    that goes on\"", "string"], ["# done", "comment"]]); f.want("last:", ["last", "function"]);
  assert.deepEqual(kinds("greeting: \"#{x}\"", "yaml").filter(([, k]) => k === "variable"), []); // "#{…}" is Spring's
  has("title: Notes # c", "markdown", ["title", "function"], tokenize("---", "markdown").state); // front matter
}
{
  const f = file(["# Settings of the reminder service.", "! an old-style comment", "server.port=8080", "spring.application.name = reminders", "spring.datasource.url=jdbc:postgresql://${DB_HOST:localhost}:5432/library", "reminders.enabled=true",
    "reminders.greeting=Gr\\u00fc\\u00dfe\\n", "reminders.year=#{T(java.time.Year).now()}", "reminders.recipients=front-desk, \\", "    back-office", "logging.level.root: INFO", "empty.value=", "[*.{py,toml}]", "indent_size = 4", "; a note"], "properties");
  assert.equal(f.state, null);
  assert.deepEqual(f.got[0], [["# Settings of the reminder service.", "comment"]]); assert.deepEqual(f.got[1], [["! an old-style comment", "comment"]]);
  assert.deepEqual(f.at("server.port"), [["server", "function"], [".", "punctuation"], ["port", "function"], ["=", "operator"], ["8080", "number"]]);
  f.want("spring.application.name", ["name", "function"], ["=", "operator"], ["reminders", "string"]);
  f.want("spring.datasource.url", ["jdbc:postgresql://", "string"], ["${DB_HOST:localhost}", "variable"], [":5432/library", "string"]);
  f.want("reminders.enabled", ["true", "boolean"]); f.want("reminders.greeting", ["\\u00fc", "string.escape"], ["\\n", "string.escape"]); f.want("reminders.year", ["#{T(java.time.Year).now()}", "variable"]);
  assert.deepEqual(f.at("back-office"), [["back-office", "string"]]); // the value goes on after "\"
  f.want("logging.level.root", [":", "operator"], ["INFO", "string"]); f.want("empty.value", ["=", "operator"]);
  assert.deepEqual(f.at("[*.{py,toml}]"), [["[*.{py,toml}]", "keyword"]]); f.want("indent_size", ["indent_size", "function"], ["4", "number"]); assert.deepEqual(f.at("; a note"), [["; a note", "comment"]]);
}
{
  const f = file(["# Packaging of the reminder service.", "[project]", "name = \"reminders\"", "dependencies = [\"boto3>=1.34\", 'jinja2']", "released = 2026-11-01T07:30:00Z", "debug = false", "ratio = 0.75", "[[tool.poetry.source]]",
    "\"a key\" = { url = \"https://example.test/simple\", priority = 1 }   # the mirror", "description = \"\"\"", "Several lines # no comment", "of text.\"\"\"", "line-length = 120"], "toml");
  assert.equal(f.state, null);
  assert.deepEqual(f.at("[project]"), [["[project]", "type"]]); assert.deepEqual(f.at("[[tool"), [["[[tool.poetry.source]]", "type"]]);
  f.want("name =", ["name", "function"], ["=", "operator"], ["\"reminders\"", "string"]); f.want("dependencies", ["[", "punctuation"], ["\"boto3>=1.34\"", "string"], ["'jinja2'", "string"]);
  f.want("released", ["2026-11-01T07:30:00Z", "number"]); f.want("debug", ["false", "boolean"]); f.want("ratio", ["0.75", "number"]);
  f.want("\"a key\"", ["\"a key\"", "function"], ["url", "function"], ["priority", "function"], ["1", "number"], ["# the mirror", "comment"]);
  assert.deepEqual(f.at("Several lines"), [["Several lines # no comment", "string"]]); f.want("line-length", ["line-length", "function"], ["120", "number"]);
}
// A Dockerfile: only RUN, CMD and ENTRYPOINT hold a command; the other instructions' words are arguments.
{
  const f = file(["ARG PYTHON=3.12", "FROM python:${PYTHON} AS build", "WORKDIR /app", "COPY --from=build /app /app", "RUN --mount=type=cache,target=/root/.cache pip install -r requirements.txt \\", "    && python -m compileall -q .", "EXPOSE 8080",
    "HEALTHCHECK --interval=30s CMD [\"python\", \"-m\", \"health\"]"], "dockerfile");
  f.want("ARG", ["ARG", "keyword"], ["PYTHON", "constant"]); f.want("FROM", ["FROM", "keyword"], ["${PYTHON}", "constant"], ["AS", "keyword"]);
  assert.deepEqual(f.at("WORKDIR"), [["WORKDIR", "keyword"]]); f.want("COPY", ["--from=build", "type"]); f.none("COPY", "/app", "function");
  f.want("RUN", ["--mount=type=cache,target=/root/.cache", "type"], ["pip", "function"], ["-r", "type"]); f.want("&& python", ["python", "function"]);
  f.want("EXPOSE", ["8080", "number"]); f.want("HEALTHCHECK", ["--interval=30s", "type"], ["CMD", "keyword"], ["\"", "string"]);
}
// ---- no line can hold its slice for ever, no scanner throws, and no span leaves its line
{
  assert.deepEqual([forward(3, 1), forward(1, 1), forward(0, 5)], [3, 2, 6]); // moved on; stood still; went back
  // The shape of every scanner's loop, with a branch that never moves on and one that jumps back to the start (the
  // fault that once left a whole review without colors): one pass per character, no more.
  for (const broken of [(i) => i, () => 0]) {
    let i = 0, passes = 0;
    for (let at = i - 1; i < 50;) { i = forward(i, at); at = i; if (i >= 50) break; passes++; i = broken(i); }
    assert.equal(passes, 50);
  }
  for (const lang of ["js", "shell", "make", "yaml", "properties", "toml", "markdown"]) { // a scanner that throws (no line at all): plain, and a fresh start
    assert.deepEqual(tokenize(null, lang, null), { spans: [], state: null }, lang);
    assert.throws(() => tokenizeStrict(null, lang, null), lang);
  }
  // Random lines for every language (a fixed seed): special characters, openers of strings, comments, heredocs and
  // placeholders, and the starts of real lines, with the state carried on and now and then started afresh.
  let seed = 0x5eed1234;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const BITS = ["$", "(", ")", "{", "}", "[", "]", '"', "'", "\\", "<", ">", "#", "`", "|", "&", ";", ":", "=", "-", "!", "@", "%", "*", "?", ",", ".", "/", " ", "  ", "\t", "$(", "${", "$((", "))", "${{", "}}", "#{", "$$", "$@", "<<EOF", "<<-'x'", "EOF",
    '"""', "'''", "/*", "*/", "//", "--", "```", "~~~", "---", "\\u00fc", "é", "🙂", "x", "name", "0x1f", "12", "1.5", "true", "null", ": ", " #", "- ", "@v4", "](", "**", "_"];
  const STARTS = ["if [ ", "for f in ", "case $x in", "echo ", "export A=", "cat <<EOF", "target: dep", "\t@$(CC) ", "VAR := ", "ifeq (", "define x", "- name: ", "  run: |", "    ", "key: ", "- uses: a/b@", "if: ", "a.b=", "[section]", "[[t]]", "k = ",
    "FROM x AS ", "RUN ", "ENV A=1 \\", "# ", "## ", "- [ ] ", "> ", "| a | b |", "def f(", "class A ", "import ", "const s = `", "fn f<'a>(", "resource \"a\" \"b\" {", "SELECT ", "#include <", "#!/bin/sh", "@decorator", "R\"x("];
  const line = () => { let s = rnd() < 0.5 ? pick(STARTS) : ""; for (let k = Math.floor(rnd() * 12); k > 0; k--) s += pick(BITS); return s; };
  const LANGS = ["js", "python", "java", "kotlin", "cpp", "go", "rust", "hcl", "sql", "json", "shell", "make", "yaml", "workflow", "spring", "properties", "toml", "markdown", "dockerfile"];
  const t0 = performance.now();
  for (const lang of LANGS) {
    let st = null;
    for (let k = 0; k < 4000; k++) {
      const l = line();
      if (rnd() < 0.05) st = null; // as after a hunk header
      const t = tokenizeStrict(l, lang, st);
      st = t.state;
      let end = 0;
      for (const x of t.spans) {
        assert.ok(Number.isInteger(x.start) && Number.isInteger(x.end) && x.start >= end && x.end >= x.start && x.end <= l.length && typeof x.kind === "string", `${lang}: ${JSON.stringify(l)} -> ${JSON.stringify(t.spans)}`); // an empty span (a whole-line span of an empty line) draws nothing
        end = x.end;
      }
    }
  }
  const ms = performance.now() - t0;
  console.log(`fuzz: ${LANGS.length} languages, 4000 random lines each: ${ms.toFixed(0)} ms`);
  assert.ok(ms < 5000, `the random lines took ${ms} ms`);
}
const sh = Array.from({ length: 10000 }, (_, i) => ({ kind: " ", text: ['if [[ -s "$STATE_DIR/$id.pem" && "$id" != tmp-* ]]; then', '  echo "$id $(stat -f %m "$STATE_DIR/$id.pem" 2>/dev/null || echo 0)" | sort -k2 -nr # c', "  KEEP=$((KEEP + 1)); log 'done' >&2", "fi"][i % 4] }));
const lines10k = (lines) => Array.from({ length: 10000 }, (_, i) => ({ kind: " ", text: lines[i % lines.length] }));
const ymlBig = lines10k(["jobs:", "  build:", "    runs-on: ubuntu-latest # the runner", "    steps:", "      - uses: actions/checkout@v4", "        with: { fetch-depth: 0, token: \"${{ secrets.TOKEN }}\" }", "      - run: |",
  "          pytest -q --junitxml=\"report-${{ matrix.python }}.xml\" | tee out.log", "        env:", "          URL: jdbc:postgresql://${DB_HOST:localhost}:5432/library"]);
const mkBig = lines10k(["OBJS = $(patsubst %.c,build/%.o,$(SRCS))", "build/%.o: %.c include/app.h", "\t$(CC) $(CFLAGS) -c $< -o $@ && echo \"built $@ at $$(date +%H:%M)\"", "ifeq ($(OS),Windows_NT)", "endif"]);
const propsBig = lines10k(["spring.datasource.url=jdbc:postgresql://${DB_HOST:localhost}:5432/library", "# a comment", "server.port=8080", "name = \"reminders\"   # toml too"]);
for (const [name, set, lang] of [["js", big, "js"], ["python", py, "python"], ["shell", sh, "shell"], ["workflow", ymlBig, "workflow"], ["make", mkBig, "make"], ["properties", propsBig, "properties"], ["toml", propsBig, "toml"]]) {
  // Best of three, so a busy machine (parallel test runs, model calls) does not fail a fast tokenizer.
  let ms = Infinity;
  for (let i = 0; i < 3 && ms >= 150; i++) {
    const t0 = performance.now();
    highlightRows(set, lang);
    ms = Math.min(ms, performance.now() - t0);
  }
  console.log(`tokenize 10k ${name} lines: ${ms.toFixed(1)} ms`);
  assert.ok(ms < 150, `${name} too slow: ${ms} ms`);
}
const t1 = performance.now();
highlightRows(big, "js", "big.js"); highlightRows(big, "js", "big.js");
console.log(`10k lines, memoized second call included: ${(performance.now() - t1).toFixed(1)} ms`);
// Sliced highlighting gives the same spans as one pass, whatever the slice size (a negative budget stops every 32 rows).
{
  const rows = Array.from({ length: 200 }, (_, i) => ({ kind: i % 7 === 0 ? "-" : i % 5 === 0 ? " " : "+", text: i % 9 === 0 ? "/* open" : i % 9 === 3 ? "close */ const x = 1;" : `let v${i} = "s";` }));
  const job = highlightJob(rows, "js");
  let out = null, steps = 0;
  while (!(out = highlightStep(job, -1))) steps++;
  assert.deepEqual(out, highlightRows(rows, "js"));
  assert.ok(steps >= 5, `${steps} slices`);
}
console.log("syntax ok");
