// Run: node test_impact.mjs  (the Impact picture: which symbols a diff changes, their callers and marks from a
// language server's answers, the cards and their summing up, the lines over the picture and the Markdown section)
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileChanges, symbolAt, changedSymbols, callersOf, computeImpact, impactTotals, impactLines, impactArch, impactMarks, impactRows, impactDoc, isTestPath, isImport, testsLine, MARKS, SIG, LIMITS, IMPACT_DENSE, isDense, impactDense, denseWords, denseFile, denseText, restText } from "./impact.js";
import { archLayout } from "./arch.js";
import { diffRows, hunksOf, splitPatch } from "./pr.js";

// ---- a small repository: what the bridge would answer
const sym = (name, kind, line, end, more = {}) => ({ name, kind, container: "", line, end, nameLine: line, character: 4, sigEnd: line, ...more });
const SYMBOLS = {
  "shop/price.py": [sym("RATE", "constant", 1, 1, { character: 0 }), sym("total", "function", 4, 9), sym("discount", "function", 12, 15), sym("Cart", "class", 18, 30, { character: 6 }),
    sym("add", "method", 20, 24, { container: "Cart", character: 8 }), sym("net", "function", 33, 35)],
  "shop/checkout.py": [sym("pay", "function", 3, 12), sym("refund", "function", 15, 20)],
  "shop/report.py": [sym("monthly", "function", 5, 9)],
  "shop/tests/test_price.py": [sym("PriceTest", "class", 4, 20, { character: 6 }), sym("test_total", "method", 5, 8, { container: "PriceTest", character: 8 }), sym("test_discount", "method", 10, 12, { container: "PriceTest", character: 8 })],
};
const hunk = (path, start, lines) => ({ path, rows: diffRows([`@@ -${start},9 +${start},9 @@`, ...lines]) });
const HUNKS = [
  // total(): its declaration changes (a parameter more) and a body line; discount(): a body line only.
  hunk("shop/price.py", 3, [" ", "-def total(items):", "+def total(items, rate):", "     n = 0", "-    return n", "+    return n * rate", " ", " ", " ", " ", " ", " def discount(x):", "+    x = round(x)", "     return x"]),
  // net(): all of it is new.
  hunk("shop/price.py", 33, ["+def net(x):", "+    y = x", "+    return y"]),
  // pay() calls total() on a changed line; refund() calls it on a line the PR leaves alone.
  hunk("shop/checkout.py", 5, [" x = 1", "-    t = total(items)", "+    t = total(items, rate)", " y = 2"]),
  hunk("shop/tests/test_price.py", 6, ["-        self.assertEqual(total([1]), 1)", "+        self.assertEqual(total([1], 1), 1)"]),
  hunk("deploy/app.yaml", 1, ["+replicas: 2"]),
];
const REFS = {
  "shop/price.py#4": [{ path: "shop/price.py", line: 6, end: 6, text: "return total(rest)" }, // itself
    { path: "shop/checkout.py", line: 1, end: 1, text: "from shop.price import total, net" },
    { path: "shop/checkout.py", line: 6, end: 6, text: "t = total(items, rate)" }, { path: "shop/checkout.py", line: 17, end: 17, text: "back = total(items)" },
    { path: "shop/report.py", line: 7, end: 8, text: "sum = total(" }, { path: "shop/report.py", line: 2, end: 2, text: "print(total([]))" },
    { path: "shop/tests/test_price.py", line: 6, end: 6, text: "self.assertEqual(total([1], 1), 1)" }],
  "shop/price.py#12": [{ path: "shop/tests/test_price.py", line: 11, end: 11, text: "discount(3)" }, { path: "shop/price.py", line: 22, end: 22, text: "self.sum -= discount(x)" }],
  "shop/price.py#33": [{ path: "shop/report.py", line: 8, end: 8, text: "net(x)" }],
};
const bridge = (over = {}) => { const asked = []; return { asked, call: async (endpoint, body) => { asked.push(`${endpoint} ${body.path}${body.line ? `:${body.line}` : ""}`);
  if (over[endpoint]) { const r = over[endpoint](body); if (r) return r; }
  if (endpoint === "/symbols") return SYMBOLS[body.path] ? { status: "ok", server: "Python", symbols: SYMBOLS[body.path] } : { status: "error", message: "boom" };
  return { status: "ok", references: REFS[`${body.path}#${body.line}`] ?? [], outside: body.line === 4 ? 2 : 0, more: 0 }; } }; };
const supported = (p) => p.endsWith(".py");

// ---- the diff's changes per file
const ch = fileChanges(HUNKS), price = ch.get("shop/price.py");
assert.deepEqual([...price.added].sort((a, b) => a - b), [4, 6, 13, 33, 34, 35], "added lines by their new numbers, over both hunks");
assert.deepEqual(price.removed.map((r) => [r.at, r.text]), [[4, "def total(items):"], [6, "    return n"]], "a removed line stands before the new line that took its place");
assert.equal(price.text.get(4), "def total(items, rate):");

// ---- which symbols changed
assert.equal(symbolAt(SYMBOLS["shop/price.py"], 21).name, "add", "the innermost symbol: a method, not its class");
assert.equal(symbolAt(SYMBOLS["shop/price.py"], 19).name, "Cart", "a class line outside its methods is the class");
assert.equal(symbolAt(SYMBOLS["shop/price.py"], 1), null, "a one-line constant is not a symbol to follow");
assert.equal(symbolAt([sym("handler", "constant", 3, 9)], 5).name, "handler", "a value over several lines is (const f = () => …)");
const changed = changedSymbols("shop/price.py", SYMBOLS["shop/price.py"], price);
assert.deepEqual(changed.map((s) => [s.name, s.isNew, Boolean(s.sig)]), [["total", false, true], ["discount", false, false], ["net", true, false]]);
assert.deepEqual(changed[0].sig, { old: "def total(items):", now: "def total(items, rate):" }, "the declaration before and now, from the diff");
assert.equal(changed[0].id, "shop/price.py#4");
// A line removed from a function's body with nothing added: the function changed.
const gone = fileChanges([hunk("shop/price.py", 12, [" def discount(x):", "-    x = round(x)", "     return x"])]).get("shop/price.py");
assert.deepEqual(changedSymbols("shop/price.py", SYMBOLS["shop/price.py"], gone).map((s) => [s.name, s.sig]), [["discount", null]]);
// The declaration line re-indented or moved unchanged is no signature change; a multi-line one counts each of its lines.
const moved = fileChanges([hunk("a.py", 4, ["-def total(items):", "+def total(items):", "+    pass"])]).get("a.py");
assert.equal(changedSymbols("a.py", [sym("total", "function", 4, 9)], moved)[0].sig, null);
const multi = fileChanges([hunk("a.py", 5, ["     items,", "+    rate,", " ):"])]).get("a.py");
assert.ok(changedSymbols("a.py", [sym("total", "function", 4, 12, { sigEnd: 7 })], multi)[0].sig, "a parameter added on a line of its own");
// A symbol's name is the PR's text and is looked for as written, never read as a pattern: Go's method names and C++
// operators have ( ) * +, a name that is no pattern at all does not throw, and one built to make a pattern search
// for seconds ((a+)+b against a long line of a's) is found, or not, at once.
{
  const decl = (name, old, now) => changedSymbols("a.go", [sym(name, "function", 4, 9)], fileChanges([hunk("a.go", 4, [`-${old}`, `+${now}`, "+  x"])]).get("a.go"))[0].sig;
  assert.deepEqual(decl("(*Server).Handle", "func (*Server).Handle(w) {", "func (*Server).Handle(w, r) {"), { old: "func (*Server).Handle(w) {", now: "func (*Server).Handle(w, r) {" });
  assert.deepEqual(decl("operator++", "T& operator++() {", "T& operator++(int) {"), { old: "T& operator++() {", now: "T& operator++(int) {" });
  assert.equal(decl("(*Server).Handle", "func xServeryHandle(w) {", "func (*Server).Handle(w, r) {").old, null, "the dot and the star are themselves, not any character");
  assert.equal(decl("foo(", "func other() {", "func foo(() {").old, null, "a name that is no pattern does not throw");
  const t = performance.now(), slow = decl("(a+)+b", `func ${"a".repeat(40)}c() {`, "func (a+)+b() {");
  assert.ok(slow.old === null && performance.now() - t < 200, `a name built as a slow pattern: ${Math.round(performance.now() - t)} ms`);
}

// ---- callers and their marks
assert.ok(isTestPath("shop/tests/test_price.py") && isTestPath("src/test/java/A.java") && isTestPath("web/cart.spec.ts") && isTestPath("pkg/cart_test.go") && !isTestPath("shop/price.py") && !isTestPath("src/contest/a.py"));
assert.ok(isImport("from shop.price import total") && isImport("import { total } from './price'") && isImport("    total,") && isImport("const { total } = require('./price')") && !isImport("t = total(items)") && !isImport("return total"));
const symbols = new Map(Object.entries(SYMBOLS));
const callers = callersOf(changed[0], REFS["shop/price.py#4"], symbols, ch);
assert.deepEqual(callers.map((c) => [c.name, c.mark, c.test, c.sites.map((s) => s.line)]), [
  [null, "outside", false, [2]], ["monthly", "outside", false, [7]], ["refund", "untouched", false, [17]], ["pay", "changed", false, [6]], ["PriceTest.test_total", "changed", true, [6]]],
  "outside the PR first, tests last; the import and the function's own line are no callers; a call at module level is the file's");
// One function with a changed call and an untouched one is "untouched": the call left as it was is the one to look at.
const both = callersOf(changed[0], [{ path: "shop/checkout.py", line: 6, end: 6, text: "total(a, b)" }, { path: "shop/checkout.py", line: 9, end: 9, text: "total(a)" }], symbols, ch);
assert.deepEqual(both.map((c) => [c.name, c.mark, c.sites.length]), [["pay", "untouched", 2]]);
// A call whose arguments go over several lines is changed when one of those lines is.
const wide = callersOf(changed[0], [{ path: "shop/checkout.py", line: 4, end: 6, text: "total(" }], symbols, ch);
assert.equal(wide[0].mark, "changed");

// ---- the whole computation against a bridge
{
  const b = bridge(), steps = [], r = await computeImpact({ call: b.call, root: "/r", hunks: HUNKS, supported, onStep: (d, of) => steps.push(`${d}/${of}`) });
  assert.equal(r.status, "ok");
  const m = r.model;
  assert.deepEqual(m.functions.map((f) => [f.name, f.callers.length]), [["total", 5], ["discount", 2], ["net", 1]], "net is new but report.py uses it on a line outside the diff");
  assert.deepEqual([m.servers, m.uncovered, m.failed, m.skipped], [["Python"], [{ ext: "yaml", files: 1 }], [], 0]);
  assert.deepEqual(steps, ["0/4", "1/4", "2/4", "3/4"]);
  assert.ok(b.asked.indexOf("/references shop/price.py:4") < b.asked.indexOf("/references shop/price.py:12") && b.asked.indexOf("/references shop/price.py:12") < b.asked.indexOf("/references shop/price.py:33"), "a changed declaration is asked first, what is new last");
  assert.ok(!b.asked.some((x) => x.startsWith("/references shop/tests")), "a changed test is not followed");
  assert.equal(b.asked.filter((x) => x === "/symbols shop/report.py").length, 1, "a caller's file is asked for its symbols once");
  assert.deepEqual(impactTotals(m), { functions: 3, callers: 5, outside: 2, untouched: 2, changed: 1, risky: 3, tests: 2 }, "Cart.add calls discount on an untouched line of a file in the PR");
  assert.ok(b.asked.includes("/references shop/checkout.py:3") && !m.functions.some((f) => f.name === "pay"), "pay() only follows total()'s new parameter: a caller with the mark changed, not a changed function");

  const L = impactLines(m);
  assert.equal(L.counts, "3 changed functions, 5 callers, 2 tests");
  assert.equal(L.lead, "2 callers of the changed code are not in this PR. 3 callers keep an unchanged call to a function whose signature changed.");
  assert.deepEqual(L.source, ["Callers the language server found (Python), direct ones only.", "Dynamic calls, reflection, removed functions, other repositories and languages without a server are not in it.",
    "Not covered: 1 file without a language server (.yaml).", "2 uses outside the checkout or in vendored code are not shown."]);

  // The cards: the changed functions in one frame, the callers in a frame per mark; tests are a line, not a card.
  const a = impactArch(m), by = new Map(a.nodes.map((n) => [n.id, n]));
  assert.ok(!isDense(m), "three changed functions and five callers are a picture");
  assert.deepEqual(a.groups.map((g) => [g.label, g.kind]), [["◆ Callers not in this PR", "2"], ["◐ Callers in the diff, call untouched", "2"], ["○ Callers changed in this PR", "1"], ["Changed functions", "3"]]);
  assert.deepEqual(by.get("shop/price.py#4").rows.map((x) => x.text), ["price.py:4", "signature changed", "1 test calls it"]);
  assert.deepEqual([by.get("shop/price.py#4").description, by.get("shop/price.py#4").rows[0].tip], ["", "shop/price.py:4"], "a card's place is its first row: the file's name with the line, the path as the tooltip");
  assert.match(by.get("shop/price.py#4").rows[1].tip, /Before: def total\(items\):\nNow: def total\(items, rate\):/);
  assert.equal(by.get("shop/price.py#4").status, "changed"); assert.equal(by.get("shop/price.py#33").status, "new");
  assert.deepEqual(by.get("shop/price.py#33").rows.map((x) => x.text).slice(1), ["no test calls it"]);
  const refund = by.get("c:shop/checkout.py#15");
  assert.deepEqual([refund.label, refund.description, refund.at, refund.group, refund.rows.map((x) => `${x.glyph} ${x.text}`)],
    ["refund", "", "shop/checkout.py:17", "m:untouched", [" checkout.py:17", "◐ in the diff, call untouched", "⚠ signature changed, caller not"]]);
  assert.equal(by.get("c:shop/report.py#0").label, "report.py, top level");
  // monthly() calls total() and net(): one card, two calls.
  assert.deepEqual(a.edges.filter((e) => e.from === "c:shop/report.py#5").map((e) => e.to).sort(), ["shop/price.py#33", "shop/price.py#4"]);
  assert.ok(!a.nodes.some((n) => /test/.test(n.id)), "no card for a test");
  // The layout takes them: every card placed, a line of room per row, calls left to right.
  const lay = archLayout(a, "diff", (n) => (n.rows?.length ?? 0));
  assert.equal(lay.nodes.length, a.nodes.length);
  assert.ok(lay.nodes.every((n) => Array.isArray(n.rows) && Number.isFinite(n.x) && n.h > 40), "the rows reach the drawn card");
  assert.ok(lay.nodes.find((n) => n.id === "shop/price.py#4").x > lay.nodes.find((n) => n.id === "c:shop/checkout.py#15").x, "a caller stands left of what it calls");

  // Findings inside a changed function sit on its card.
  const marks = impactMarks(m, [{ id: "f1", file: "shop/price.py", line: 6, severity: "medium", title: "Rate is not checked" }, { id: "f2", file: "price.py", line: 5, severity: "high", title: "x" }, { id: "f3", file: "shop/price.py", line: 40, severity: "high", title: "y" }]);
  assert.deepEqual([...marks.nodes].map(([id, x]) => [id, x.n, x.severity]), [["shop/price.py#4", 2, "high"]]);

  // The Markdown section says what the page shows.
  const d = impactDoc(m, [{ id: "f1", file: "shop/price.py", line: 6, severity: "medium", title: "Rate is not checked" }]);
  assert.equal(d.title, "Impact (3 changed functions, 5 callers, 2 tests)");
  assert.ok(d.lines.includes("Callers by mark: not in this PR: 2 · in the diff, call untouched: 2 · changed in this PR: 1 · signature changed, caller not: 3."));
  assert.deepEqual(d.rows.find((r) => r[1] === "`refund`"), ["`total` (`shop/price.py:4`), signature changed, 1 test calls it, medium: Rate is not checked", "`refund`", "`shop/checkout.py:17`", "in the diff, call untouched; signature changed, caller not"]);
  assert.ok(d.rows.some((r) => r[1] === "`PriceTest.test_total (test)`" && r[3] === "changed in this PR"));
  assert.equal(d.rows.length, impactRows(m).length);
  assert.ok(d.flow.nodes.some((n) => n.label === "refund · shop/checkout.py:17 · in the diff, call untouched · signature changed, caller not") && d.flow.edges.length === a.edges.length && d.flow.groups[0].label === "Callers not in this PR");
}

// A function this PR adds that only the diff uses is not in the picture; a changed function nobody calls is.
{
  const b = bridge({ "/references": (q) => (q.line === 33 ? { status: "ok", references: [{ path: "shop/checkout.py", line: 6, end: 6, text: "net(1)" }] } : q.line === 4 ? { status: "ok", references: [] } : null) });
  const m = (await computeImpact({ call: b.call, root: "/r", hunks: HUNKS, supported })).model;
  assert.deepEqual(m.functions.map((f) => f.name), ["pay", "total", "discount"], "net() is used only by a line of the diff; pay() changed a call to nothing that changed, so it is a change of its own");
  assert.deepEqual(impactArch(m).nodes.find((n) => n.id === "shop/price.py#4").rows.map((x) => x.text), ["price.py:4", "signature changed", "no test calls it", "no caller found"]);
  assert.equal(impactRows(m)[0].name, "no caller found");
}
// A function with a change of its own that also calls a changed function stays one: its card, a call between the two.
{
  const hunks = [...HUNKS, hunk("shop/checkout.py", 8, ["+    log(t)"])], m = (await computeImpact({ call: bridge().call, root: "/r", hunks, supported })).model;
  assert.deepEqual(m.functions.map((f) => f.name), ["pay", "total", "discount", "net"]);
  const a = impactArch(m);
  assert.ok(a.edges.some((e) => e.from === "shop/checkout.py#3" && e.to === "shop/price.py#4") && !a.nodes.some((n) => n.id === "c:shop/checkout.py#3"), "one card for pay, in the frame of the changed functions");
  assert.deepEqual([impactTotals(m).callers, impactTotals(m).changed, a.groups.map((g) => g.kind)], [4, 0, ["2", "2", "0", "4"]], "the legend counts what the frames show");
}
// A server still loading answers "starting": nothing is kept, the caller asks again. One that fails says what failed.
{
  const r = await computeImpact({ call: bridge({ "/symbols": () => ({ status: "starting", message: "Java index is building…" }) }).call, root: "/r", hunks: HUNKS, supported });
  assert.deepEqual(r, { status: "starting", message: "Java index is building…" });
  const e = await computeImpact({ call: bridge({ "/symbols": () => ({ status: "error", message: "pyright-langserver is not installed" }) }).call, root: "/r", hunks: HUNKS, supported });
  assert.deepEqual(e, { status: "error", message: "pyright-langserver is not installed" });
  // One search that times out leaves the others standing, and the lines say so.
  const t = await computeImpact({ call: bridge({ "/references": (q) => (q.line === 12 ? { status: "timeout", message: "Python server did not answer within 20 s" } : null) }).call, root: "/r", hunks: HUNKS, supported });
  assert.equal(t.model.functions.find((f) => f.name === "discount").error, "Python server did not answer within 20 s");
  assert.ok(impactLines(t.model).source.includes("A search did not finish: Python server did not answer within 20 s"));
  // No language server for any file of the PR.
  const n = await computeImpact({ call: bridge().call, root: "/r", hunks: [hunk("deploy/app.yaml", 1, ["+replicas: 2"]), hunk("README.md", 1, ["+x"])], supported });
  assert.deepEqual([n.status, n.model.functions, n.model.uncovered.map((u) => u.ext)], ["ok", [], ["md", "yaml"]]);
  assert.equal(impactLines(n.model).lead, "No language server covers the files of this PR.");
  assert.deepEqual(impactLines(n.model).source, ["Not covered: 2 files without a language server (.md, .yaml)."]);
}
// Infrastructure code is "Infrastructure changes"' part (infra.js isInfraFile, one source for both): its files are
// not asked about though a server exists for them, are no callers, and the line under the title points there.
{
  const { isInfraFile } = await import("./infra.js");
  const hunks = [...HUNKS, hunk("stacks/orders/queue.tf", 1, ["+resource \"aws_sqs_queue\" \"orders\" {}"]), hunk("template.yaml", 1, ["+Resources:", "+  Fn:", "+    Type: AWS::Serverless::Function"])];
  const patch = [{ path: "stacks/orders/queue.tf", lines: [] }, { path: "template.yaml", lines: ["+Resources:"] }, { path: "deploy/app.yaml", lines: ["+replicas: 2"] }, { path: "shop/price.py", lines: [] }];
  const paths = new Set(patch.filter(isInfraFile).map((f) => f.path)), infra = (p) => paths.has(p) || isInfraFile({ path: p });
  assert.deepEqual([...paths], ["stacks/orders/queue.tf", "template.yaml"], "a YAML file that is no template is not infrastructure");
  const b = bridge({ "/references": (q) => (q.line === 12 ? { status: "ok", references: [{ path: "stacks/orders/main.tf", line: 3, end: 3, text: "discount = 1" }, { path: "shop/price.py", line: 22, end: 22, text: "self.sum -= discount(x)" }] } : null) });
  const m = (await computeImpact({ call: b.call, root: "/r", hunks, supported: (p) => /\.(py|tf)$/.test(p), infra })).model;
  assert.ok(!b.asked.some((x) => /\.tf|template\.yaml/.test(x)), "no server is asked about an infrastructure file");
  assert.deepEqual([m.infra, m.uncovered, m.functions.find((f) => f.name === "discount").callers.map((c) => c.path)], [2, [{ ext: "yaml", files: 1 }], ["shop/price.py"]], "a use in a .tf file is no caller");
  assert.ok(impactLines(m).source.includes("Not covered: 1 file without a language server (.yaml); 2 infrastructure files: see Infrastructure changes."));
  assert.ok(impactDoc(m).lines.includes("Not covered: 1 file without a language server (.yaml); 2 infrastructure files: see Infrastructure changes."));
  assert.equal(impactLines({ ...m, uncovered: [], infra: 1 }).source[2], "Not covered: 1 infrastructure file: see Infrastructure changes.");
}
// Limits: only so many changed symbols are asked, and a slow run stops asking; both are counted.
{
  const many = Array.from({ length: 8 }, (_x, i) => sym(`f${i}`, "function", 1 + i * 3, 2 + i * 3)), rows = many.map((s) => hunk("a.py", s.line + 1, ["+    x = 1"]));
  const call = async (endpoint) => (endpoint === "/symbols" ? { status: "ok", server: "Python", symbols: many } : { status: "ok", references: [] });
  const r = await computeImpact({ call, root: "/r", hunks: rows, supported, limits: { ...LIMITS, ASK: 5 } });
  assert.deepEqual([r.model.functions.length, r.model.skipped], [5, 3]);
  assert.ok(impactLines(r.model).source.includes("3 changed functions were not asked for callers (limit reached)."));
  let clock = 0;
  const slow = await computeImpact({ call, root: "/r", hunks: rows, supported, limits: { ...LIMITS, MS: 100 }, now: () => (clock += 60) });
  assert.ok(slow.model.functions.length < 8 && slow.model.functions.length + slow.model.skipped === 8, "past the time limit the rest is skipped");
}

// ---- many callers: a row per changed symbol instead of a picture
{
  const fn = (name, line, callers, more = {}) => ({ id: `lib.py#${line}`, path: "pkg/lib.py", name, kind: "function", container: "", line, end: line + 2, nameLine: line, character: 4, isNew: false, sig: null, callers, outside: 0, more: 0, ...more });
  const caller = (file, k, mark = "outside", test = false) => ({ id: `${file}#${k}`, name: `use${k}`, kind: "function", path: file, line: k, sites: [{ line: k, text: "", mark }], mark, test });
  const model = (functions) => ({ v: 2, servers: ["Python"], uncovered: [], failed: [], skipped: 0, functions });
  // The thresholds: more than 12 changed symbols, 12 callers or 15 calls.
  assert.ok(!isDense(model([fn("parse", 1, Array.from({ length: IMPACT_DENSE.callers }, (_x, k) => caller("a.py", k + 1)))])) && isDense(model([fn("parse", 1, Array.from({ length: IMPACT_DENSE.callers + 1 }, (_x, k) => caller("a.py", k + 1)))])), "13 callers");
  assert.ok(isDense(model(Array.from({ length: IMPACT_DENSE.symbols + 1 }, (_x, k) => fn(`f${k}`, 1 + k * 4, [])))), "13 changed symbols");
  assert.ok(isDense(model(Array.from({ length: 4 }, (_x, k) => fn(`f${k}`, 1 + k * 4, Array.from({ length: 4 }, (_y, i) => caller("a.py", i + 1)))))), "4 callers that each call 4 symbols are 16 calls");
  assert.ok(!isDense(model([fn("parse", 1, Array.from({ length: 30 }, (_x, k) => caller("tests/test_a.py", k + 1, "changed", true)))])), "tests are no callers here");
  // What stands out first: a changed signature whose caller did not change, then a finding, then the most callers
  // outside the PR; what has no caller outside is one line.
  const sig = { old: "def dump(x):", now: "def dump(x, y):" };
  const m = model([fn("plain", 1, [caller("a.py", 1), caller("a.py", 2), caller("b.py", 3), caller("tests/test_a.py", 9, "changed", true)]), fn("found", 9, [caller("a.py", 1)]),
    fn("dump", 17, [caller("pkg/deep/long-name-of-a-module.py", 4), caller("lib2.py", 5, "untouched"), caller("lib3.py", 6, "changed")], { sig }),
    fn("inner", 25, [caller("lib2.py", 7, "untouched"), caller("lib3.py", 8, "changed")]), fn("alone", 33, []), ...Array.from({ length: 9 }, (_x, k) => fn(`more${k}`, 41 + k * 8, [caller(`c${k}.py`, 1)]))]);
  const D = impactDense(m, [{ id: "x", file: "pkg/lib.py", line: 10, severity: "high", title: "found is wrong" }]);
  assert.deepEqual(D.symbols.slice(0, 4).map((r) => [r.name, r.risky, r.mark?.severity ?? null, r.groups.outside.n, r.groups.untouched.n, r.changed, r.tests]),
    [["dump", 2, null, 1, 1, 1, 0], ["found", 0, "high", 1, 0, 0, 0], ["plain", 0, null, 3, 0, 0, 1], ["more0", 0, null, 1, 0, 0, 0]]);
  assert.deepEqual(D.symbols[2].groups.outside.files.map((f) => [f.path, f.base, f.n, f.line, f.callers.map((c) => c.name)]), [["a.py", "a.py", 2, 1, ["use1", "use2"]], ["b.py", "b.py", 1, 3, ["use3"]]], "its callers by file, the most first");
  assert.deepEqual(D.rest, [{ id: "lib.py#25", name: "inner", at: "pkg/lib.py:25", inPr: 2, tests: 0 }, { id: "lib.py#33", name: "alone", at: "pkg/lib.py:33", inPr: 0, tests: 0 }]);
  assert.equal(restText(D, m), "2 changed functions have no caller outside this PR: inner (2 in the PR), alone.");
  assert.equal(denseWords(D.symbols[0]), "signature changed, 2 callers keep the old call; 1 caller not in this PR in 1 file; 1 caller in the diff, call untouched in 1 file; 1 caller changed in this PR; no test");
  assert.equal(denseWords(D.symbols[1]), "1 caller not in this PR in 1 file; no test; high: found is wrong");
  // A caller file and the symbols it calls (the file chosen on the page).
  assert.deepEqual(D.files.get("a.py"), [{ id: "lib.py#9", n: 1 }, { id: "lib.py#1", n: 2 }]);
  assert.equal(denseFile(D, "a.py"), "a.py calls 2 of the changed symbols: found, plain (2 callers).");
  assert.equal(denseFile(D, "pkg/deep/long-name-of-a-module.py"), "long-name-of-a-module.py calls 1 of the changed symbols: dump.");
  assert.equal(denseFile(D, "nowhere.py"), "");
  // The lines and the Markdown say so, with the rows in the page's order and no flowchart.
  const doc = impactDoc(m, [{ id: "x", file: "pkg/lib.py", line: 10, severity: "high", title: "found is wrong" }]);
  assert.equal(impactLines(m).dense, denseText());
  assert.ok(doc.lines.includes(denseText()) && doc.lines.includes("- `dump` (`pkg/lib.py:17`): signature changed, 2 callers keep the old call; 1 caller not in this PR in 1 file; 1 caller in the diff, call untouched in 1 file; 1 caller changed in this PR; no test")
    && doc.lines.includes("2 changed functions have no caller outside this PR: inner (2 in the PR), alone.") && doc.flow.nodes.length === 0 && doc.rows.length === 20);
  assert.ok(doc.lines.indexOf("- `found` (`pkg/lib.py:9`): 1 caller not in this PR in 1 file; no test; high: found is wrong") > doc.lines.findIndex((l) => l.startsWith("- `dump`")));
}
// The invented result of a large PR (demo/fixtures/gen-impact-dense.mjs): the numbers the rows are made for.
if (existsSync(new URL("../../demo/fixtures/review/impact-dense.json", import.meta.url))) {
  const m = JSON.parse(readFileSync(new URL("../../demo/fixtures/review/impact-dense.json", import.meta.url), "utf8")), T = impactTotals(m), D = impactDense(m);
  assert.deepEqual([T.functions, T.outside, T.untouched, T.changed, T.risky, isDense(m)], [16, 99, 31, 11, 5, true]);
  assert.deepEqual([D.symbols.length, D.rest.length, D.symbols[0].name, D.symbols[0].risky, D.symbols[1].name, D.symbols[1].groups.outside.n], [11, 5, "useCheckoutSession", 5, "priceBreakdown", 21]);
  assert.equal(D.symbols.reduce((n, r) => n + r.groups.outside.n, 0), 99, "every caller outside the PR is in a row");
}

// ---- words
assert.equal(testsLine({ callers: [] }), "no test calls it");
assert.equal(testsLine({ callers: [{ test: true }, { test: true }, { test: false }] }), "2 tests call it");
assert.deepEqual(Object.values(MARKS).map((x) => x.word), ["not in this PR", "in the diff, call untouched", "changed in this PR"]);
assert.equal(SIG.word, "signature changed, caller not");
// A class among the changed symbols: "symbols", not "functions".
{
  const m = { v: 1, servers: ["TypeScript"], uncovered: [], failed: [], skipped: 0, functions: [{ id: "a.ts#3", path: "a.ts", name: "Cart", kind: "class", container: "", line: 3, end: 30, nameLine: 3, character: 6, isNew: false, sig: null, callers: [], outside: 0, more: 0 }] };
  assert.equal(impactLines(m).counts, "1 changed symbol, 0 callers, 0 tests");
  assert.equal(impactLines(m).lead, "The language server found no caller of the changed symbol.");
  assert.equal(impactArch(m).groups.at(-1).label, "Changed symbols");
}

// ---- the fixture: PR #2's real result (demo/fixtures/refresh-impact.mjs) fits the diff it was made from
const FIXTURES = new URL("../../demo/fixtures/review/", import.meta.url);
if (existsSync(FIXTURES)) {
  const model = JSON.parse(readFileSync(new URL("impact.json", FIXTURES), "utf8")), hunks = hunksOf(splitPatch(readFileSync(new URL("pr2.diff", FIXTURES), "utf8"))).map((h) => ({ ...h, rows: diffRows(h.lines) }));
  const changes = fileChanges(hunks);
  assert.deepEqual(model.functions.map((f) => [f.name, f.path, Boolean(f.sig), f.callers.map((c) => [c.name, c.mark, c.test])]),
    [["handler", "library/handler.py", false, []], ["send_reminders", "library/reminders.py", true, [["ReminderTest.test_reminds_two_days_before_due_once", "changed", true]]]]);
  for (const f of model.functions) assert.ok([...changes.get(f.path).added].some((l) => l >= f.line && l <= f.end), `${f.name} has a changed line in pr2.diff`);
  assert.equal(impactLines(model).lead, "The language server found no caller of the changed functions outside the tests.");
  assert.equal(impactDoc(model).title, "Impact (2 changed functions, 0 callers, 1 test)");
  assert.ok(impactLines(model).source.includes("Not covered: 1 infrastructure file: see Infrastructure changes."), "PR #2's template.yaml is the other section's");
}
console.log("impact ok");
