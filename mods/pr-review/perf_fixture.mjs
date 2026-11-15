// A synthetic big review for the performance checks (perf_bench.mjs, test_perf.mjs): the fixture of PR #2 with more
// of everything. Its nine files come first, so the fixture's hunk aliases (h1..h13), cards and findings stay valid;
// the rest is generated, the same every time (no randomness). Not a test itself.
import { splitPatch, hunksOf } from "./pr.js";

const EXT = ["py", "js", "ts", "go", "tf", "md", "json", "rs"];
const CODE = {
  py: (i) => `    result_${i} = compute(order.items[${i}], rate=0.${i % 9 + 1})  # step ${i}`,
  js: (i) => `  const value${i} = await client.fetch(\`/orders/\${id}/items/${i}\`, { retries: ${i % 4} });`,
  ts: (i) => `  export const handler${i} = async (event: OrderEvent<${i}>): Promise<Result> => apply(event, "${i}");`,
  go: (i) => `\tif err := store.Put(ctx, key${i}, value); err != nil { return fmt.Errorf("put %d: %w", ${i}, err) }`,
  tf: (i) => `  rule_${i} = { name = "orders-${i}", priority = ${i}, action = "allow" }`,
  md: (i) => `- Step ${i}: the **order** service calls \`billing.charge(${i})\` and waits for the answer.`,
  json: (i) => `    "route_${i}": { "path": "/orders/${i}", "timeout": ${i * 10}, "public": false },`,
  rs: (i) => `    let total_${i}: u64 = items.iter().map(|x| x.price * ${i}).sum::<u64>() + offset;`,
};

// One generated file's diff: `hunks` hunks of `per` lines each (context, removed and added lines mixed).
function fileDiff(k, hunks, per) {
  const ext = EXT[k % EXT.length], path = `services/svc${Math.floor(k / 10)}/module_${k}.${ext}`, line = CODE[ext], out = [`diff --git a/${path} b/${path}`, `index 1111111..2222222 100644`, `--- a/${path}`, `+++ b/${path}`];
  for (let h = 0; h < hunks; h++) {
    const start = 10 + h * (per + 40), body = [];
    for (let i = 0; i < per; i++) body.push(`${i % 7 === 2 ? "-" : i % 7 === 3 || i % 5 === 0 ? "+" : " "}${line(k * 1000 + h * 100 + i)}`);
    const del = body.filter((l) => l[0] !== "+").length, add = body.filter((l) => l[0] !== "-").length;
    out.push(`@@ -${start},${del} +${start},${add} @@ def part_${h}():`, ...body);
  }
  return { path, text: out.join("\n") };
}

// base: the fixture texts { diff, analysis, findings } (demo/fixtures/review: pr2.diff, analysis-s.json,
// findings-s.json). Returns the same three as texts, with `files` files, about `lines` diff lines, `findings`
// findings and `cards` cards on the map.
export function bigReview(base, { files = 100, lines = 10000, findings = 60, cards = 80 } = {}) {
  const had = splitPatch(base.diff), more = Math.max(0, files - had.length), baseLines = base.diff.split("\n").length;
  const per = Math.max(4, Math.round((lines - baseLines) / Math.max(1, more) / 3) - 2), gen = Array.from({ length: more }, (_x, k) => fileDiff(k, 3, per));
  const diff = [base.diff.replace(/\n$/, ""), ...gen.map((g) => g.text)].join("\n") + "\n";
  const hunks = hunksOf(splitPatch(diff)), mine = hunks.slice(hunksOf(had).length);

  const doc = JSON.parse(base.findings), list = doc.findings, SEV = ["high", "medium", "low", "medium", "critical", "low"];
  for (let k = 0; list.length < findings; k++) {
    const g = gen[(k * 3) % gen.length];
    list.push({ ...list[0], id: `perf${k}`, reviewer: k % 2 ? "claude" : "security", file: g.path, line: 12 + (k % 5), end: 13 + (k % 5), severity: SEV[k % SEV.length], category: k % 2 ? "bug" : "security",
      title: `Generated finding ${k}: the call at step ${k} is not checked`, detail: `The value of step ${k} is used **without** a check.\n\n- first reason ${k}\n- second reason ${k}\n\n\`\`\`py\nvalue = compute(${k})\n\`\`\``,
      suggestion: `Check the result of step ${k} before it is stored.`, code: CODE[EXT[((k * 3) % gen.length) % EXT.length]](k) });
  }

  const saved = JSON.parse(base.analysis), a = saved.answer, arch = a.architecture, ids = arch.nodes.map((n) => n.id), STATUS = ["unchanged", "changed", "new", "unchanged"];
  for (let g = 0; arch.nodes.length < cards; g++) {
    arch.groups.push({ id: `g_p${g}`, label: `Generated service ${g}`, kind: g % 2 ? "Lambda" : "Service" });
    for (let i = 0; i < 9 && arch.nodes.length < cards; i++) {
      const id = `p${g}_${i}`, prev = ids.at(-1);
      arch.nodes.push({ id, group: `g_p${g}`, label: `Module ${g}.${i}`, description: `Generated card ${g}.${i} of the big review.`, type: i % 4 === 0 ? "store" : "module", status: STATUS[(g + i) % 4] });
      arch.edges.push({ from: prev, to: id, label: `call ${g}.${i}`, source: "implemented", status: STATUS[(g + i + 1) % 4], evidence: `${gen[(g * 9 + i) % gen.length].path}:12` });
      if (i % 3 === 0 && ids.length > 12) arch.edges.push({ from: ids[ids.length - 11], to: id, label: `reads ${g}.${i}`, source: "implemented", status: "new", evidence: `${gen[(g * 7 + i) % gen.length].path}:14` });
      ids.push(id);
    }
  }
  for (let s = 0; s * 30 < mine.length; s++) {
    const part = mine.slice(s * 30, s * 30 + 30), f0 = gen[(s * 10) % gen.length].path;
    a.steps.push({ ...a.steps[0], title: `Generated layer ${s}`, risk: SEV[s % 3], reading_order: a.steps.length + 1, hunks: part.map((h) => h.alias), depends_on: [], visuals: [],
      findings: [0, 1].map((j) => ({ ...a.steps[0].findings[0], id: undefined, breaks: undefined, file: f0, line: 12 + j, title: `Generated layer finding ${s}.${j}`, severity: SEV[(s + j) % SEV.length], criteria: [] })) });
  }
  saved.hunks = hunks.map((h) => ({ alias: h.alias, id: h.id }));
  return { diff, analysis: JSON.stringify(saved), findings: JSON.stringify(doc) };
}
