// Run: node test_arch.mjs  (the architecture / blast radius layout: columns, lanes, ports, fans, stubs, hops, badges,
// card sizes, focus, orchestrator states)
import assert from "node:assert/strict";
import { archLayout, archBands, archFocus, archMarks, pathMark, labelLines, zoneArch, stateLayout, sourceStyle, hasSources, crossings, lineStats, layoutJob, layoutStep, archBest, archQuick, QUICK_LINES, widthAt, clampText, wrapLines, bundleChips, markRoom, MARK_CARD_H, ARCH, LABEL } from "./arch.js";
import { overlapsOf, transitionLabel, SM } from "./arch.js";
import { blastArch } from "./pr.js";

const inside = (s, r) => (s.y1 === s.y2
  ? s.y1 > r.y + 1 && s.y1 < r.y + r.h - 1 && Math.max(s.x1, s.x2) > r.x + 1 && Math.min(s.x1, s.x2) < r.x + r.w - 1
  : s.x1 > r.x + 1 && s.x1 < r.x + r.w - 1 && Math.max(s.y1, s.y2) > r.y + 1 && Math.min(s.y1, s.y2) < r.y + r.h - 1);
const over = (a, b) => Math.abs(a.x - b.x) < 18 && Math.abs(a.y - b.y) < 18;
const boxOver = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function sane(L, what) {
  const node = new Map(L.nodes.map((n) => [n.id, n])), bottom = Math.max(...L.nodes.map((n) => n.y + n.h));
  for (const p of L.paths) for (const s of p.segments) for (const n of L.nodes) assert.ok(!inside(s, n), `${what}: path ${p.mark} runs through ${n.id}`);
  // Every call points left to right; nothing runs under the cards.
  for (const p of L.paths) {
    assert.equal(p.arrow.left, false, `${what}: ${p.mark} points left`);
    if (p.kind === "long") continue; // runs under the picture to a card that is not in the next column (its own test)
    if (p.kind !== "stub") for (const f of p.from) assert.equal(node.get(p.to).col, node.get(f).col + 1, `${what}: ${p.mark} is a line but not to the next column`);
    for (const s of p.segments) assert.ok(Math.max(s.y1, s.y2) <= bottom + 4, `${what}: ${p.mark} runs below the cards`);
  }
  const badges = L.paths.filter((p) => p.badge);
  badges.forEach((p, i) => badges.slice(i + 1).forEach((q) => assert.ok(!over(p.badge, q.badge), `${what}: badges ${p.mark} ${q.mark} overlap`)));
  for (const p of badges) for (const n of L.nodes) assert.ok(!(Math.abs(p.badge.x - n.x - n.w / 2) < n.w / 2 + 9 && Math.abs(p.badge.y - n.y - n.h / 2) < n.h / 2 + 9), `${what}: badge ${p.mark} on ${n.id}`);
  for (const p of L.paths.filter((q) => q.chip)) for (const n of L.nodes) assert.ok(!boxOver(p.chip, n), `${what}: chip ${p.mark} on ${n.id}`);
  const vs = L.paths.flatMap((p) => p.segments.filter((s) => s.x1 === s.x2 && s.y1 !== s.y2).map((s) => ({ p: p.trunk ?? p.key, s })));
  vs.forEach((a, i) => vs.slice(i + 1).forEach((b) => {
    if (a.p === b.p || a.s.x1 !== b.s.x1) return;
    const lo = Math.max(Math.min(a.s.y1, a.s.y2), Math.min(b.s.y1, b.s.y2)), hi = Math.min(Math.max(a.s.y1, a.s.y2), Math.max(b.s.y1, b.s.y2));
    assert.ok(lo >= hi, `${what}: two paths share a lane`);
  }));
  assert.equal(L.hops.length, crossings([...L.paths.filter((p) => p.kind === "next"), ...L.trunks]).length, `${what}: every crossing that stays has its hop`);
}

// A chain inside one group: each call goes one column right (the group spans the columns); a call that would skip
// columns is a stub; groups whose columns overlap stack.
{
  const arch = { groups: [{ id: "app", label: "App" }, { id: "ops", label: "Ops" }],
    nodes: [...["runner", "props", "health", "intercept", "config", "main"].map((id) => ({ id, group: "app", label: id, description: "A component that does a thing in the service and has a long description that wraps over several lines and then goes on for a good while longer", status: "changed" })),
      { id: "probe", group: "ops", label: "Health probe" }, { id: "k8s", group: "ops", label: "Deployment" }],
    edges: [{ from: "runner", to: "health", label: "creates bean" }, { from: "runner", to: "intercept", label: "intercept()" }, { from: "props", to: "runner", label: "configures" },
      { from: "config", to: "props", label: "binds" }, { from: "main", to: "config", label: "scans" },
      { from: "health", to: "probe", label: "reports NOT_SERVING" }, { from: "k8s", to: "probe", label: "polls" }, { from: "config", to: "k8s", label: "env vars" }] };
  const L = archLayout(arch);
  assert.equal(L.paths.length, 8);
  sane(L, "chain");
  assert.ok(L.nodes.every((n) => n.descLines <= 3 && n.titleLines <= 2));
  assert.ok(L.nodes.filter((n) => n.group === "app").every((n) => n.cut)); // long descriptions are cut, with the tooltip
  const col = (id) => L.nodes.find((n) => n.id === id).col;
  assert.deepEqual(["main", "config", "props", "runner", "health", "intercept"].map(col), [0, 1, 2, 3, 4, 4]);
  assert.deepEqual(L.paths.filter((p) => p.kind === "stub").map((p) => `${p.from[0]}>${p.to}`), ["config>k8s"]);
  const [app, ops] = L.groups;
  assert.deepEqual(app.cols, [0, 4]);
  assert.ok(ops.y >= app.y + app.h, "ops shares column 4 with app: stacked under it");
  assert.equal(L.hops.length, 0);
}

// Ordering removes avoidable crossings: given crosswise, barycentre ordering makes them parallel. Zero hops.
{
  const arch = { groups: [{ id: "a" }, { id: "b" }], nodes: [{ id: "a1", group: "a" }, { id: "a2", group: "a" }, { id: "b1", group: "b" }, { id: "b2", group: "b" }],
    edges: [{ from: "a1", to: "b2", label: "x" }, { from: "a2", to: "b1", label: "y" }] };
  const L = archLayout(arch);
  const order = L.nodes.map((n) => `${n.id}:${n.y}`), y = (id) => L.nodes.find((n) => n.id === id).y;
  assert.equal(y("a1") < y("a2"), y("b2") < y("b1"), order.join(" ")); // one column reordered
  assert.equal(L.hops.length, 0);
  sane(L, "parallel");
}

// A crossing that can't be ordered away gets exactly one hop, on the horizontal line.
{
  const arch = { groups: [{ id: "a" }, { id: "b" }], nodes: ["n1", "n2", "n3"].map((id) => ({ id, group: "a" })).concat(["m1", "m2", "m3"].map((id) => ({ id, group: "b" }))),
    edges: [{ from: "n1", to: "m3", label: "p" }, { from: "n2", to: "m2", label: "q" }, { from: "n3", to: "m1", label: "r" }, { from: "n1", to: "m1", label: "s" }, { from: "n3", to: "m3", label: "t" }] };
  const L = archLayout(arch);
  assert.ok(L.hops.length >= 1);
  for (const h of L.hops) assert.equal(h.h.y1, h.h.y2); // the hop sits on the horizontal segment
  sane(L, "crossing");
}

// Same target and same meaning: one path, one lane, one entry port (a bus). Different meaning: separate.
{
  const arch = { groups: [{ id: "a" }, { id: "b" }], nodes: [{ id: "x", group: "a" }, { id: "y", group: "a" }, { id: "z", group: "a" }, { id: "t", group: "b" }],
    edges: [{ from: "x", to: "t", label: "Reads" }, { from: "y", to: "t", label: "reads " }, { from: "z", to: "t", label: "Writes" }] };
  const L = archLayout(arch);
  assert.equal(L.paths.length, 2);
  const bus = L.paths.find((p) => p.edges.length === 2), other = L.paths.find((p) => p.edges.length === 1);
  assert.deepEqual(bus.from, ["x", "y"]);
  const entry = (p) => p.segments.at(-1); // the last segment enters the target
  assert.equal(new Set(bus.segments.filter((s) => s.x1 === s.x2).map((s) => s.x1)).size, 1); // one shared lane
  assert.notEqual(entry(bus).y1, entry(other).y1); // separate entry ports
  assert.notEqual(bus.segments.find((s) => s.x1 === s.x2).x1, other.segments.find((s) => s.x1 === s.x2)?.x1 ?? -1);
  assert.equal(L.hops.length, 0);
  sane(L, "bus");
}

// A call that skips a column is a stub: a short line out of the source and a chip naming the target with the number.
{
  const arch = { groups: [{ id: "a" }, { id: "b" }, { id: "c" }], nodes: [{ id: "a1", group: "a" }, { id: "b1", group: "b" }, { id: "b2", group: "b" }, { id: "c1", group: "c", label: "Store" }],
    edges: [{ from: "a1", to: "c1", label: "skips" }, { from: "a1", to: "b1", label: "next" }, { from: "b2", to: "c1", label: "writes" }] };
  const L = archLayout(arch);
  sane(L, "skip");
  const skip = L.paths.find((p) => p.label === "skips"), a1 = L.nodes.find((n) => n.id === "a1");
  assert.equal(skip.kind, "stub");
  assert.equal(skip.segments.length, 1);
  assert.deepEqual([skip.segments[0].x1, skip.segments[0].x2 - skip.segments[0].x1], [a1.x + a1.w, ARCH.STUB]);
  assert.equal(skip.chip.text, "→ Store"); assert.ok(skip.num > 0); // the number is a badge in the chip
  assert.equal(skip.badge, null);
  assert.ok(skip.chip.x + skip.chip.w < L.nodes.find((n) => n.id === "b1").x, "the chip fits in the gutter");
}

// A cycle between groups: the call that closes it is a stub, nothing points right to left.
{
  const arch = { groups: [{ id: "a" }, { id: "b" }], nodes: [{ id: "p", group: "a" }, { id: "q", group: "b" }, { id: "r", group: "b" }],
    edges: [{ from: "p", to: "q", label: "asks" }, { from: "q", to: "r", label: "passes" }, { from: "r", to: "p", label: "calls back" }] };
  const L = archLayout(arch);
  sane(L, "cycle");
  assert.deepEqual(L.paths.map((p) => p.kind), ["next", "next", "stub"]);
}

// The shape of a real PR: Step Functions → Lambdas → AWS data and external services, one Lambda calling 6 things.
const sync = {
  groups: [{ id: "flow", label: "Orchestration", kind: "Step Functions" }, { id: "work", label: "Workers", kind: "Lambdas" },
    { id: "store", label: "Cloud data & security", kind: "AWS" }, { id: "ext", label: "External services", kind: "SaaS" }],
  nodes: [
    { id: "sm", group: "flow", label: "Nightly sync state machine", description: "Runs the stages once a night.", type: "service", status: "changed" },
    { id: "retry", group: "flow", label: "Retry state machine", description: "Re-runs failed stages.", type: "service", status: "unchanged" },
    { id: "fetch", group: "work", label: "Fetch worker", description: "Pulls repositories.", type: "component", status: "unchanged" },
    { id: "stages", group: "work", label: "Stages index, rank, lookup, tickets, mirror", description: "One handler per stage of the sync.", type: "component", status: "new" },
    { id: "notify", group: "work", label: "Notifier worker", description: "Posts results.", type: "component", status: "changed" },
    { id: "table", group: "store", label: "Jobs table", type: "data", status: "unchanged" },
    { id: "bucket", group: "store", label: "Raw bucket", type: "data", status: "unchanged" },
    { id: "vault", group: "store", label: "Secrets vault", type: "data", status: "unchanged" },
    { id: "host", group: "ext", label: "Code host API", type: "api", status: "unchanged" },
    { id: "search", group: "ext", label: "Search API", type: "api", status: "unchanged" },
    { id: "model", group: "ext", label: "Model API", type: "api", status: "unchanged" },
    { id: "mirror", group: "ext", label: "Mirror host", type: "api", status: "new" }],
  edges: [
    { from: "sm", to: "fetch", label: "invokes" }, { from: "sm", to: "stages", label: "invokes per stage", status: "new" }, { from: "retry", to: "notify", label: "invokes on failure" },
    { from: "stages", to: "host", label: "lists tickets", status: "new" }, { from: "stages", to: "search", label: "queries", status: "new" },
    { from: "stages", to: "model", label: "ranks candidates", status: "new" }, { from: "stages", to: "mirror", label: "pushes the mirror", status: "new" },
    { from: "fetch", to: "host", label: "fetches repositories" }, { from: "notify", to: "host", label: "posts a comment", status: "changed" },
    { from: "stages", to: "table", label: "writes candidates", status: "new" }, { from: "stages", to: "vault", label: "reads the token", status: "new" },
    { from: "fetch", to: "bucket", label: "stores raw data" }, { from: "notify", to: "table", label: "reads results" },
    { from: "sm", to: "vault", label: "reads the config" }] };
{
  const L = archLayout(sync), g = (id) => L.groups.find((x) => x.id === id);
  sane(L, "sync");
  assert.equal(L.paths.length, 14);
  // Groups by depth: three columns, the AWS group and the external services stacked in the third.
  assert.deepEqual(["flow", "work", "store", "ext"].map((id) => g(id).cols[0]), [0, 1, 2, 2]);
  assert.equal(new Set(L.groups.map((x) => x.x)).size, 3);
  const [top, low] = [g("store"), g("ext")].sort((a, b) => a.y - b.y);
  assert.ok(low.y >= top.y + top.h);
  // Nothing below the lowest card.
  const bottom = Math.max(...L.nodes.map((n) => n.y + n.h));
  assert.ok(L.paths.every((p) => p.segments.every((s) => Math.max(s.y1, s.y2) <= bottom + 8)));
  assert.ok(L.height <= bottom + ARCH.PAD + 1);
  // The call that skips the Lambdas: a stub with its chip.
  const skip = L.paths.find((p) => p.label === "reads the config");
  assert.equal(skip.kind, "stub");
  assert.equal(skip.chip.text, "→ Secrets vault");
  // Numbers in reading order: by the source's column, then top to bottom.
  const colOf = (p) => L.nodes.find((n) => n.id === p.from[0]).col;
  assert.deepEqual(L.paths.map((p) => p.num), L.paths.map((_, k) => k + 1));
  assert.ok(L.paths.every((p, k) => k === 0 || colOf(L.paths[k - 1]) <= colOf(p)), "numbers go column by column");
  // Fan-out: the four calls from the stages into the external services share one trunk into the group's frame.
  const fan = L.paths.filter((p) => p.from[0] === "stages" && L.nodes.find((n) => n.id === p.to).group === "ext");
  assert.equal(fan.length, 4);
  assert.equal(new Set(fan.map((p) => p.trunk)).size, 1);
  assert.equal(L.trunks.length, 1);
  const ext = g("ext"), entering = new Set(fan.flatMap((p) => p.segments).filter((s) => s.y1 === s.y2 && Math.min(s.x1, s.x2) < ext.x && Math.max(s.x1, s.x2) > ext.x).map((s) => JSON.stringify(s)));
  assert.equal(entering.size, 1, "one line enters the group's frame");
  const spineX = fan[0].segments.at(-1).x1;
  assert.ok(fan.every((p) => p.segments.at(-1).x1 === spineX && spineX > ext.x && spineX < p.arrow.x), "branches leave one spine inside the frame's left inset");
  assert.equal(new Set(fan.map((p) => p.num)).size, 4); // the legend lists each call
  // Focus on the stages: its six calls and the call into it stay, with the cards at their other ends.
  const F = archFocus(L, "stages"), num = (label) => L.paths.find((p) => p.label === label).num;
  assert.deepEqual([...F.nodes].sort(), ["host", "mirror", "model", "search", "sm", "stages", "table", "vault"]);
  assert.deepEqual([...F.paths].sort((a, b) => a - b), ["invokes per stage", "lists tickets", "queries", "ranks candidates", "pushes the mirror", "writes candidates", "reads the token"].map(num).sort((a, b) => a - b));
  assert.deepEqual(L.nodes.filter((n) => !F.nodes.has(n.id)).map((n) => n.id).sort(), ["bucket", "fetch", "notify", "retry"]);
  assert.equal(archFocus(L, null), null);
  assert.equal(archFocus(archLayout(sync, "before"), "mirror"), null); // not in this view: no focus
}

// An orchestrator's states: a lane in the card, top to bottom; each state's call leaves the card at its row (an
// edge the analysis gave, or one made from the state).
{
  const arch = { groups: [{ id: "flow", label: "Step Functions" }, { id: "work", label: "Lambdas" }],
    nodes: [{ id: "sm", group: "flow", label: "Sync state machine", type: "orchestration", states: [{ name: "Index", type: "task", calls: "w1" }, { name: "Has work?", type: "choice" }, { name: "Rank", type: "task", calls: "w2" }, { name: "Done", type: "succeed" }] },
      { id: "w1", group: "work", label: "Indexer" }, { id: "w2", group: "work", label: "Ranker" }],
    edges: [{ from: "sm", to: "w1", label: "invokes the indexer" }] };
  const L = archLayout(arch), sm = L.nodes.find((n) => n.id === "sm");
  sane(L, "states");
  assert.equal(L.paths.length, 2);
  const row = (k) => sm.y + sm.stateTop + k * ARCH.ROW + ARCH.ROW / 2;
  const [p1, p2] = L.paths;
  assert.deepEqual([p1.label, p2.label], ["invokes the indexer", "Rank"]);
  assert.equal(p1.segments[0].y1, row(0)); // leaves at "Index"
  assert.equal(p2.segments[0].y1, row(2)); // leaves at "Rank", below
  assert.ok(sm.y + sm.stateTop + 4 * ARCH.ROW <= sm.y + sm.h - 24, "the states fit above the card's footer");
  assert.ok(archLayout({ ...arch, nodes: arch.nodes.map((n) => ({ ...n, states: undefined })) }).nodes[0].stateTop === null); // old analyses: no lane
}

// Many state rows calling a few targets: one path per target (a line from each row into one trunk), each target its
// own channel, badges at the start of the lines next to the rows, numbered top to bottom.
{
  const st = (name, calls) => ({ name, type: "task", calls });
  const arch = { groups: [{ id: "flow", label: "Step Functions" }, { id: "work", label: "Lambdas" }],
    nodes: [{ id: "sm", group: "flow", label: "State machine intel", type: "orchestration",
      states: [st("Validate", "read"), st("Planned"), st("Partitions", "phase"), st("Research", "phase"), st("search", "phase"), st("lockfiles", "read"), st("prs", "phase"), st("Assemble", "asm")] },
    { id: "phase", group: "work", label: "Phase Lambdas" }, { id: "read", group: "work", label: "Read Lambdas" }, { id: "asm", group: "work", label: "Assemble" }],
    edges: [] };
  const L = archLayout(arch), sm = L.nodes.find((n) => n.id === "sm");
  sane(L, "rows");
  assert.equal(L.paths.length, 3, "one path per target");
  const phase = L.paths.find((p) => p.to === "phase");
  assert.equal(phase.label, "Partitions, Research, search, prs");
  assert.equal(phase.edges.length, 4);
  const lanes = L.paths.map((p) => p.segments.find((s) => s.x1 === s.x2)?.x1).filter((x) => x !== undefined);
  assert.equal(new Set(lanes).size, lanes.length, "each target its own channel");
  for (const p of L.paths) assert.ok(p.badge.x < sm.x + sm.w + 60, `badge ${p.mark} sits next to the rows, not in the channel`);
  assert.deepEqual(L.paths.map((p) => p.to), ["read", "phase", "asm"], "numbered by their first row, top to bottom");
}

// External services called from the middle of a group that spans further right: their own column beside it, not a
// frame stacked below with lines running down past the picture.
{
  const arch = { groups: [{ id: "aws", label: "AWS" }, { id: "ext", label: "External", kind: "SaaS" }],
    nodes: [{ id: "sm", group: "aws", label: "State machine" }, { id: "phase", group: "aws", label: "Phase Lambdas" }, { id: "read", group: "aws", label: "Read Lambdas" },
      { id: "hosted", group: "aws", label: "Lambda hosted" }, { id: "scan", group: "ext", label: "Scanner API" }, { id: "gh", group: "ext", label: "GitHub API" }, { id: "nvd", group: "ext", label: "NVD" }],
    edges: [{ from: "sm", to: "phase", label: "a" }, { from: "sm", to: "read", label: "b" }, { from: "phase", to: "hosted", label: "c" },
      { from: "phase", to: "scan", label: "d" }, { from: "phase", to: "gh", label: "e" }, { from: "read", to: "scan", label: "f" }, { from: "phase", to: "nvd", label: "g" }] };
  const L = archLayout(arch), g = (id) => L.groups.find((x) => x.id === id);
  sane(L, "external");
  assert.ok(g("ext").x >= g("aws").x + g("aws").w, "the external services sit right of the AWS frame");
  assert.ok(g("ext").y < g("aws").y + g("aws").h, "not stacked below it");
  const bottom = Math.max(...L.nodes.map((n) => n.y + n.h));
  assert.ok(L.paths.every((p) => p.segments.every((s) => Math.max(s.y1, s.y2) <= bottom + 8)), "no line runs below the picture");
}

// Fit: the same picture with narrow cards is narrower, its cards 160 px with at most two lines of description.
{
  const arch = { groups: [{ id: "a", label: "A" }], nodes: ["x", "y", "z"].map((id) => ({ id, group: "a", label: `Node ${id}`, description: "A long description that needs several lines in a card of any width at all, really" })),
    edges: [{ from: "x", to: "y", label: "1" }, { from: "y", to: "z", label: "2" }] };
  const wide = archLayout(arch), fit = archLayout(arch, "diff", () => 0, true);
  sane(fit, "fit");
  assert.ok(fit.width < wide.width * 0.8, "narrower");
  assert.ok(fit.nodes.every((n) => n.w === 160 && n.descLines <= 2));
}

// The blast radius: each context file's relation is its own path (no merged lanes), titles wrap to two lines.
{
  const b = blastArch({ units: [{ id: "u1", label: "GrpcServerRunner (Shutdown hook and health)", status: "changed", files: ["a.java"] }, { id: "u2", label: "GrpcProperties and application config", status: "changed", files: ["b.java"] }],
    context: [{ id: "c1", file: "src/App.java", direction: "upstream", relation: "@ConfigurationPropertiesScan registers the properties", links_to: "u2" },
      { id: "c2", file: "src/Env.java", direction: "upstream", relation: "reads the env variables GRPC_DEADLINE", links_to: "u2" },
      { id: "c3", file: "src/RunnerTest.java", direction: "upstream", relation: "test: the record gets a new field", links_to: "u1" },
      { id: "c4", file: "src/Other.java", direction: "upstream", relation: "next to which the new interceptor sits", links_to: "u1" }] });
  const L = archLayout(b, "diff", (n) => Math.min(2, n.findings?.length ?? 0));
  assert.equal(L.paths.length, 4);
  sane(L, "blast");
  const u1 = L.nodes.find((n) => n.id === "u:u1");
  assert.equal(u1.titleLines, 2);
  assert.equal(u1.title, "GrpcServerRunner (Shutdown hook and health)");
}

// State diagrams, top to bottom. A lifecycle that goes back (a return lane on the left) and stays (a self-loop):
// no crossings, nothing through a card, the start dot on top and the end ring at the bottom, changed ones marked.
{
  const v = { kind: "state_machine", title: "Loan", nodes: [{ id: "open", label: "Open" }, { id: "rem", label: "Reminded", changed: true }, { id: "over", label: "Overdue" }, { id: "ret", label: "Returned" }],
    transitions: [{ from: "open", to: "rem", event: "due soon", guard: "2 days left", action: "send reminder", changed: true }, { from: "rem", to: "ret", event: "return" },
      { from: "rem", to: "over", event: "due date passed" }, { from: "over", to: "ret", event: "return", guard: "fee paid" },
      { from: "over", to: "open", event: "extend", changed: true }, { from: "rem", to: "rem", event: "remind again", changed: true }, { from: "open", to: "ret", event: "return" }] };
  const L = stateLayout(v), at = (id) => L.nodes.find((n) => n.id === id);
  const lines = [...L.edges, ...L.backs];
  assert.equal(crossings(lines).length, 0);
  for (const e of lines) for (const sg of e.segments) for (const n of L.nodes.filter((x) => x.kind === "state")) assert.ok(!inside(sg, n), `${e.key} runs through ${n.id}`);
  assert.ok(at("\0start").y < at("open").y && at("open").y < at("rem").y && at("rem").y < at("over").y && at("over").y < at("ret").y && at("ret").y < at("\0end").y);
  for (const e of L.edges) for (const sg of e.segments) assert.ok(sg.y2 >= sg.y1, `${e.key} goes up`); // forward transitions only run down
  // A transition that skips a row (open to returned) is one unbroken line, also beside the rows it passes.
  for (const e of L.edges) e.segments.slice(1).forEach((sg, k) => assert.deepEqual([sg.x1, sg.y1], [e.segments[k].x2, e.segments[k].y2], `${e.key} has a gap after segment ${k}`));
  // The picture is as wide as its lines and their labels, not only as its cards.
  for (const e of L.edges) for (const sg of e.segments) assert.ok(Math.max(sg.x1, sg.x2) <= L.width, `${e.key} runs past the picture`);
  for (const e of L.edges.filter((x) => x.text && !x.labelAt.left)) assert.ok(e.labelAt.x + Math.min(e.labelAt.w, e.text.length * 6 + 4) <= L.width, `the label of ${e.key} runs past the picture`);
  assert.deepEqual(L.backs.map((b) => [b.from, b.to, b.text, b.changed]), [["over", "open", "extend", true]]);
  assert.ok(L.backs[0].laneX < Math.min(...L.nodes.map((n) => n.x)), "the return lane is left of every card");
  assert.deepEqual(L.loops.map((l) => [l.id, l.text, l.changed]), [["rem", "remind again", true]]);
  const due = L.edges.find((e) => e.from === "open" && e.to === "rem");
  assert.deepEqual([due.text, due.changed], ["due soon [2 days left] / send reminder", true]);
  assert.deepEqual(L.edges.filter((e) => e.changed).map((e) => `${e.from}>${e.to}`), ["open>rem"]);
  // The old shape (edges with labels) still lays out.
  const old = stateLayout({ kind: "state_machine", nodes: v.nodes, edges: [{ from: "open", to: "rem", label: "remind" }, { from: "rem", to: "ret", label: "return", changed: true }] });
  assert.deepEqual(old.edges.filter((e) => e.text).map((e) => [e.text, e.changed]), [["remind", false], ["return", true]]);
}

// Self-loops: several on one card each get their own row, and a loop's text never runs into the card beside it.
{
  const v = { kind: "state", nodes: [{ id: "none", label: "No item" }, { id: "list", label: "Items as list", note: "read as empty" }, { id: "map", label: "Items as map" }],
    transitions: [{ from: "none", to: "map", event: "add" }, { from: "list", to: "map", event: "add", action: "LOG.warn" }, { from: "none", to: "none", event: "remove" },
      { from: "map", to: "map", event: "add" }, { from: "map", to: "map", event: "remove" }, { from: "map", to: "map", event: "create", action: "overwrite" }] };
  const L = stateLayout(v);
  assert.equal(L.loops.length, 4);
  const label = (l) => ({ x: l.x, y: l.y - 1, w: SM.LOOP + l.w, h: 14 });
  for (const l of L.loops) for (const n of L.nodes.filter((x) => x.id !== l.id)) assert.ok(!boxOver(label(l), n), `loop ${l.text} on ${n.id}`);
  for (const a of L.loops) for (const b of L.loops) if (a !== b) assert.ok(!boxOver(label(a), label(b)), `loops ${a.text} and ${b.text} overlap`);
  for (const l of L.loops) assert.ok(l.x + SM.LOOP + l.w <= L.width, "the loop text fits in the picture");
}

// Step Functions: a choice forks into columns below it, a Parallel's branches sit side by side in its block, Catch and
// Retry are stubs to the right, the Fail state only reached by Catch is not a card.
{
  const v = { kind: "state_machine", nodes: [{ id: "load", label: "Load batch", type: "task" }, { id: "has", label: "Has items?", type: "choice" },
    { id: "par", label: "Enrich", type: "parallel" }, { id: "a1", label: "Index", parent: "par", branch: 0 }, { id: "a2", label: "Rank", parent: "par", branch: 0 },
    { id: "b1", label: "Lookup", parent: "par", branch: 1 }, { id: "skip", label: "Nothing to do", type: "pass" }, { id: "done", label: "Done", type: "succeed" }, { id: "fail", label: "Failed", type: "fail" }],
    edges: [{ from: "load", to: "has" }, { from: "has", to: "par", label: "items > 0" }, { from: "has", to: "skip", label: "empty" }, { from: "a1", to: "a2" },
      { from: "par", to: "done" }, { from: "skip", to: "done" }, { from: "par", to: "fail", error: "catch", label: "Catch" }, { from: "load", to: "load", error: "retry", label: "Retry ×3" }] };
  const L = stateLayout(v), at = (id) => L.nodes.find((n) => n.id === id);
  assert.equal(at("fail"), undefined);
  assert.equal(at("par").y, at("skip").y); // the choice's two ways side by side, below it
  assert.ok(at("par").y > at("has").y && at("par").x + at("par").w <= at("skip").x);
  const kids = at("par").children, k = (id) => kids.find((c) => c.id === id);
  assert.deepEqual([k("a1").branch, k("a2").branch, k("b1").branch], [0, 0, 1]);
  assert.ok(k("a1").y < k("a2").y && k("a1").x === k("a2").x && k("b1").x > k("a1").x && k("b1").y === k("a1").y);
  assert.deepEqual(L.stubs.map((x) => [x.from, x.text]), [["load", "Retry ×3"], ["par", "Catch → Failed"]]);
  for (const x of L.stubs) for (const n of L.nodes) assert.ok(!boxOver(x.chip, n), `stub chip on ${n.id}`);
  assert.equal(crossings([...L.edges, ...L.backs]).length, 0);
}

// Sources: implemented (solid, status colours), existing (muted), spec (dashed, a "spec" chip); none: as before.
{
  assert.deepEqual(["implemented", "existing", "spec", undefined].map((x) => { const st = sourceStyle(x); return [st.dashed, st.tone, st.chip]; }),
    [[false, "status", null], [false, "muted", null], [true, "status", "spec"], [false, "status", null]]);
  assert.match(sourceStyle("spec").tip, /not found in the diff/);
  const arch = { groups: [{ id: "a" }, { id: "b" }], nodes: [{ id: "x", group: "a", source: "implemented", evidence: "src/x.ts:3" }, { id: "y", group: "a" }, { id: "t", group: "b", source: "spec" }],
    edges: [{ from: "x", to: "t", label: "Reads", source: "implemented", evidence: "src/x.ts:9" }, { from: "y", to: "t", label: "reads", source: "spec" }] };
  const L = archLayout(arch);
  assert.equal(L.paths.length, 2, "a spec-only call never merges with an implemented one");
  assert.deepEqual(L.paths.map((p) => [p.source, p.dashed, p.evidence]), [["implemented", false, "src/x.ts:9"], ["spec", true, null]]);
  assert.equal(L.nodes.find((n) => n.id === "x").at, "src/x.ts:3"); // implemented evidence: the card opens it
  assert.ok(hasSources(arch));
  // Old analyses: no source, nothing dashed, no legend.
  const old = archLayout(sync);
  assert.ok(old.paths.every((p) => p.source === null && !p.dashed) && !hasSources(sync));
  // A spec-only transition in a state diagram is dashed.
  const sm = stateLayout({ nodes: [{ id: "a", label: "A" }, { id: "b", label: "B", source: "spec" }], transitions: [{ from: "a", to: "b", event: "archive", source: "spec" }] });
  const e = sm.edges.find((x) => x.from === "a");
  assert.deepEqual([e.source, e.dashed, sm.nodes.find((n) => n.id === "b").source], ["spec", true, "spec"]);
  assert.ok(sm.edges.filter((x) => x !== e).every((x) => !x.dashed));
}

// Text clamping.
assert.deepEqual(wrapLines("aa bb cc", 5), ["aa bb", "cc"]);
assert.deepEqual(clampText("one two three four five six", 9, 2), { text: "one two three…", lines: 2, cut: true });
assert.deepEqual(clampText("short", 10, 3), { text: "short", lines: 1, cut: false });

// Edge labels: one that doesn't fit right of its line (the next entry is close) goes left of it; no label lies on
// another line, a card or another label.
{
  const v = { kind: "state", nodes: [{ id: "none", label: "No item" }, { id: "list", label: "Items as list", note: "read as empty" }, { id: "map", label: "Items as map" }],
    transitions: [{ from: "none", to: "map", event: "add", action: "build the map from the first item" }, { from: "list", to: "map", event: "add", action: "LOG.warn, create overwrites" }] };
  const L = stateLayout(v), box = (e) => ({ x: e.labelAt.x, y: e.labelAt.y, w: e.labelAt.w, h: 13 }), lab = L.edges.filter((e) => e.text);
  assert.ok(lab.some((e) => e.labelAt.left), "one label on the left");
  for (const e of lab) {
    assert.ok(e.labelAt.w >= Math.min(120, e.text.length * 6), `${e.text}: only ${e.labelAt.w} px`);
    for (const o of L.edges) if (o !== e) for (const g of o.segments) assert.ok(!boxOver(box(e), { x: Math.min(g.x1, g.x2), y: Math.min(g.y1, g.y2), w: Math.abs(g.x2 - g.x1) || 1, h: Math.abs(g.y2 - g.y1) || 1 }), `${e.text} on ${o.key}`);
    for (const n of L.nodes) assert.ok(!boxOver(box(e), n), `${e.text} on ${n.id}`);
    for (const o of lab) if (o !== e) assert.ok(!boxOver(box(e), box(o)), `${e.text} on ${o.text}`);
  }
}

// A state diagram's lines, each on its own: the demo PR's Loan (four states in a column, three transitions that skip a
// state, a self-loop) and an order's lifecycle (8 states, 14 transitions, a fork, a way back, two self-loops).
{
  const T = (from, to, event, more = {}) => ({ from, to, event, ...more });
  const loan = { kind: "state_machine", nodes: ["borrowed", "reminded", "overdue", "returned"].map((id) => ({ id, label: id.toUpperCase() })),
    transitions: [T("borrowed", "reminded", "loan.reminded", { action: "sets reminded_on" }), T("borrowed", "overdue", "loan.overdue", { guard: "allowed by MOVES" }), T("reminded", "overdue", "loan.overdue"),
      T("borrowed", "returned", "loan.returned"), T("reminded", "returned", "loan.returned"), T("overdue", "returned", "loan.returned"), T("overdue", "overdue", "publish_overdue", { action: "raises ValueError" })] };
  const order = { kind: "state_machine", nodes: ["draft", "submitted", "in_review", "approved", "rejected", "shipped", "delivered", "closed"].map((id) => ({ id, label: id })),
    transitions: [T("draft", "submitted", "submit"), T("submitted", "in_review", "assign reviewer"), T("in_review", "approved", "approve"), T("in_review", "rejected", "reject"), T("approved", "shipped", "ship"),
      T("shipped", "delivered", "deliver"), T("delivered", "closed", "close after 14 days"), T("rejected", "closed", "archive"), T("rejected", "draft", "reopen for another round of edits"), T("draft", "closed", "cancel"),
      T("submitted", "closed", "cancel"), T("in_review", "in_review", "request changes"), T("shipped", "shipped", "retry delivery"), T("approved", "delivered", "pick up in store")] };
  // As stack.js draws it over a layer's code: the number and the trigger as the label, the bare number when there is no room.
  const numbered = (v, pad = () => 0) => ({ ...v, transitions: v.transitions.map((e, k) => ({ ...e, event: undefined, guard: undefined, action: undefined, label: transitionLabel(e, k), short: String(k + 1), pad: pad(k) })) });
  assert.deepEqual([loan.transitions[1], { label: "items > 0" }, { event: "reopen for another round of edits" }, {}].map((e, k) => transitionLabel(e, k)), ["1 · loan.overdue", "2 · items > 0", "3 · reopen for…", "4"]);
  const lines = (L) => [...L.edges, ...L.backs], state = (L) => L.nodes.filter((n) => n.kind === "state");
  const clean = (L, what) => {
    assert.equal(crossings(lines(L)).length, 0, `${what}: crossings`);
    assert.equal(overlapsOf(lines(L)).length, 0, `${what}: two lines on one stretch`);
    for (const e of lines(L)) for (const sg of e.segments) for (const n of state(L)) assert.ok(!inside(sg, n), `${what}: ${e.key} runs through ${n.id}`);
    // Every transition has its own port: no two leave or enter one side of a card at the same place.
    for (const n of L.nodes) for (const [side, own, at] of [["bottom", "from", (e) => e.segments[0].x1], ["top", "to", (e) => e.arrow.x]]) {
      const xs = L.edges.filter((e) => e[own] === n.id).map(at);
      assert.equal(new Set(xs).size, xs.length, `${what}: ${n.id} ${side} ports ${xs}`);
      for (const x of xs) assert.ok(x > n.x && x < n.x + n.w, `${what}: a port off ${n.id}`);
    }
    for (const n of state(L)) { const ys = [...L.backs.filter((b) => b.from === n.id).map((b) => b.sy), ...L.backs.filter((b) => b.to === n.id).map((b) => b.ty)]; assert.equal(new Set(ys).size, ys.length, `${what}: ${n.id} side ports`); }
    // A label lies on no card, no other label and no line but its own (a lane's label sits on its own line where it leaves).
    const box = (e) => ({ x: e.labelAt.x, y: e.labelAt.y, w: Math.min(e.labelAt.w, e.text.length * 6 + 4), h: 13 }), lab = lines(L).filter((e) => e.text && e.labelAt);
    for (const e of lab) {
      for (const n of L.nodes) assert.ok(!boxOver(box(e), n), `${what}: ${e.text} on ${n.id}`);
      for (const o of lab) if (o !== e) assert.ok(!boxOver(box(e), box(o)), `${what}: ${e.text} on ${o.text}`);
      for (const o of lines(L)) if (o !== e) for (const g of o.segments) assert.ok(!boxOver(box(e), { x: Math.min(g.x1, g.x2), y: Math.min(g.y1, g.y2), w: Math.abs(g.x2 - g.x1) || 1, h: Math.abs(g.y2 - g.y1) || 1 }), `${what}: ${e.text} on ${o.key}`);
      assert.ok(box(e).x >= 0 && box(e).x + box(e).w <= L.width, `${what}: ${e.text} off the picture`);
    }
    for (const e of lines(L)) for (const sg of e.segments) assert.ok(Math.min(sg.x1, sg.x2) >= 0 && Math.max(sg.x1, sg.x2) <= L.width && Math.max(sg.y1, sg.y2) <= L.height, `${what}: ${e.key} off the picture`);
  };
  const A = stateLayout(numbered(loan)), edge = (L, n) => L.edges.find((e) => e.key.startsWith(`f${n - 1}:`));
  clean(A, "loan");
  // The three that skip a state run in lanes beside the column: 2 and 4 (4 holds 2) on the right, the shorter inside;
  // 5, which would cross 2 there, on the left. The others go straight down the middle.
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => edge(A, n).lane), [0, 1, 0, 1, -1, 0]);
  const right = Math.max(...state(A).map((n) => n.x + n.w)), left = Math.min(...state(A).map((n) => n.x));
  assert.ok(right < edge(A, 2).segments[2].x1 && edge(A, 2).segments[2].x1 < edge(A, 4).segments[2].x1 && edge(A, 5).segments[2].x1 < left);
  for (const n of [1, 3, 6]) assert.equal(edge(A, n).segments.length, 1, `${n} is one straight line`);
  // The label is in the picture: number and trigger, a lane's on its own level line beside the card it leaves.
  assert.deepEqual(lines(A).map((e) => e.text).filter(Boolean), ["1 · loan.reminded", "2 · loan.overdue", "3 · loan.overdue", "4 · loan.returned", "5 · loan.returned", "6 · loan.returned"]);
  for (const n of [2, 4, 5]) { const e = edge(A, n); assert.ok(e.labelAt.on && e.labelAt.y + 7 === e.segments[1].y1, `${n}: the label on its line`); }
  // The self-loop: an arc right of its card with its text behind it, clear of the lanes.
  assert.deepEqual(A.loops.map((l) => [l.id, l.text]), [["overdue", "7 · publish_overdue"]]);
  assert.ok(A.loops[0].x + SM.LOOP + A.loops[0].w < edge(A, 2).segments[2].x1);
  // As high and wide as what it shows: nothing under the end ring, nothing right of the outer lane.
  const end = A.nodes.find((n) => n.kind === "end");
  assert.equal(A.height, end.y + end.h);
  assert.ok(A.width - edge(A, 4).segments[2].x1 <= 8);
  // A finding's chip gets room after its label (pad): the lanes start right of it.
  const P = stateLayout(numbered(loan, (k) => (k === 1 ? 90 : 0)));
  clean(P, "loan with a chip");
  assert.equal(edge(P, 2).labelAt.w, edge(A, 2).labelAt.w + 90);
  assert.ok(edge(A, 2).labelAt.x + edge(P, 2).labelAt.w > edge(A, 2).segments[2].x1 && edge(P, 2).labelAt.x + edge(P, 2).labelAt.w < edge(P, 2).segments[2].x1);
  // No room for the texts: the numbers alone, as before, on the same lines.
  const N = stateLayout(numbered(loan), 0, A.width - 1);
  clean(N, "loan, numbers");
  assert.deepEqual([lines(N).map((e) => e.text).filter(Boolean), N.loops[0].text, N.height], [["1", "2", "3", "4", "5", "6"], "7", A.height]);
  assert.ok(N.width < A.width - 150);
  assert.equal(stateLayout(numbered(loan), 0, A.width).width, A.width, "it fits: the texts stay");
  // With the whole texts (no numbers) it is as clean.
  clean(stateLayout(loan), "loan, whole texts");

  const B = stateLayout(numbered(order));
  clean(B, "order");
  assert.deepEqual([state(B).length, B.edges.filter((e) => e.text).length + B.backs.length + B.loops.length, B.loops.length, B.backs.length], [8, 14, 2, 1]);
  // The way back (9) on the left; the skipping ones on the right, but 8 on the left, where its source stands in the fork.
  assert.deepEqual([8, 10, 11, 14].map((n) => edge(B, n).lane), [-1, 1, 1, 1]);
  assert.ok(B.backs[0].laneX < Math.min(...state(B).map((n) => n.x)) && B.backs[0].laneX < edge(B, 8).segments[2].x1, "the longer one outside");
  assert.ok(B.width <= 700 && B.height <= 640, `${B.width} x ${B.height}`);
  clean(stateLayout(numbered(order), 0, 300), "order, numbers");
}

// Bands: a picture wider than the view is cut between cards into bands that each fit; one band when it fits.
{
  const arch = { groups: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
    nodes: ["a1", "a2", "b1", "b2", "c1", "c2"].map((id) => ({ id, label: id, group: id[0] })),
    edges: [["a1", "a2"], ["a2", "b1"], ["b1", "b2"], ["b2", "c1"], ["c1", "c2"]].map(([from, to]) => ({ from, to, label: "calls" })) };
  const L = archLayout(arch);
  assert.deepEqual(archBands(L, L.width + 10), [{ x0: 0, x1: L.width, h: L.height, y0: 0, in: [], out: [] }]);
  const view = Math.round(L.width / 2.5), B = archBands(L, view);
  assert.ok(B.length >= 3, `${B.length} bands`);
  assert.equal(B[0].x0, 0); assert.equal(B.at(-1).x1, L.width);
  for (let k = 1; k < B.length; k++) assert.equal(B[k].x0, B[k - 1].x1);
  for (const b of B) assert.ok(b.x1 - b.x0 <= view, "a band fits the view");
  for (const b of B) for (const n of L.nodes) assert.ok(n.x + n.w <= b.x0 || n.x >= b.x1 || (n.x >= b.x0 && n.x + n.w <= b.x1), `cut through ${n.id}`);
  // A cut sits right after the cards and numbers left of it, so the lanes of that gutter go on in the next band.
  for (const b of B.slice(0, -1)) for (const p of L.paths) for (const g of p.segments) if (g.x1 === g.x2) assert.ok(g.x1 < b.x1 - 40 || g.x1 > b.x1, `a lane of ${p.mark} at the right edge of a band`);
}
// ---- the Architecture page's picture (opts.labels): the calls' texts on their lines, one Mailer card both mails reach
// (a PR whose reminder is mailed twice: once directly, once by the consumer two columns further right).
const mail = { groups: [{"id": "fd", "label": "Front desk Lambda"}, {"id": "core", "label": "Shared library code"}, {"id": "cons", "label": "Reminder consumer Lambda"}, {"id": "infra", "label": "AWS infrastructure"}],
  nodes: [{"id": "handler", "group": "fd", "label": "handler (handler.py)", "description": "Front desk Lambda entry; now also serves POST /remind.", "status": "changed", "at": "library/handler.py:18"}, {"id": "reminders", "group": "core", "label": "reminders (reminders.py)", "description": "Selects loans for reminder/overdue and sends mail.", "status": "changed", "at": "library/reminders.py:16"}, {"id": "status", "group": "core", "label": "transition (status.py)", "description": "State machine with transition() that publishes events.", "status": "changed", "at": "library/status.py:43"}, {"id": "events", "group": "core", "label": "LoanEvent, Queue (events.py)", "description": "Immutable event and in-memory queue.", "status": "new", "at": "library/events.py:6"}, {"id": "consumer", "group": "cons", "label": "consumer (consumer.py)", "description": "SQS-triggered Lambda that mails members.", "status": "new", "at": "library/consumer.py:11"}, {"id": "queue", "group": "infra", "label": "LoanEvents (template.yaml)", "description": "SQS queue between the Lambdas.", "status": "new", "at": "template.yaml:11"}, {"id": "mailer", "group": "core", "label": "Mailer (mailer.py)", "description": "Sends mail.", "status": "unchanged"}],
  edges: [{"from": "handler", "to": "consumer", "label": "Imports and calls handle() inline", "source": "implemented"}, {"from": "reminders", "to": "mailer", "label": "Sends reminder directly", "source": "implemented"}, {"from": "reminders", "to": "status", "label": "transition() per loan", "source": "implemented"}, {"from": "status", "to": "events", "label": "Publishes LoanEvent", "source": "implemented"}, {"from": "events", "to": "queue", "label": "Should send to SQS (only a list)", "source": "spec"}, {"from": "queue", "to": "consumer", "label": "Triggers batch of 10", "source": "implemented"}, {"from": "consumer", "to": "mailer", "label": "Sends second reminder mail", "source": "implemented"}] };
{
  const plain = archLayout(mail), L = archLayout(mail, "diff", () => 0, false, { labels: true });
  sane(L, "mail");
  // Without labels (a layer's flow) nothing changes: the second mail is a stub, no path has a text.
  assert.equal(plain.paths.find((p) => p.from[0] === "consumer" && p.to === "mailer").kind, "stub");
  assert.ok(plain.paths.every((p) => !p.text));
  // With them it is a line into the one Mailer card: it enters from the left like the first mail's line, lower.
  const second = L.paths.find((p) => p.from[0] === "consumer" && p.to === "mailer"), first = L.paths.find((p) => p.from[0] === "reminders" && p.to === "mailer");
  const mailer = L.nodes.find((n) => n.id === "mailer"), bottom = Math.max(...L.nodes.map((n) => n.y + n.h));
  assert.equal(second.kind, "long"); assert.equal(second.chip, undefined);
  assert.deepEqual([second.arrow.x, first.arrow.x], [mailer.x, mailer.x]);
  assert.ok(second.arrow.y > first.arrow.y && second.arrow.y < mailer.y + mailer.h);
  for (const s of second.segments) for (const n of L.nodes) assert.ok(!inside(s, n), `the long line runs through ${n.id}`);
  assert.ok(second.segments.some((s) => s.y1 === s.y2 && s.y1 > bottom), "it runs under the cards");
  assert.ok(L.height > Math.max(...second.segments.map((s) => Math.max(s.y1, s.y2))), "and inside the picture");
  // A call can be asked for as a line (the Security page's way from an entry to a finding): no stub then, also
  // without texts on the lines.
  const forced = archLayout(mail, "diff", () => 0, true, { lines: (i) => i === 6 }), fl = forced.paths.find((p) => p.edges.includes(6));
  assert.deepEqual([fl.kind, fl.text, fl.chip], ["long", undefined, undefined]); sane(forced, "forced line");
  // Every call has its text next to its number, on no card and on no other text; the gutters grew to hold them.
  assert.ok(L.width > plain.width);
  const texts = L.paths.map((p) => p.text);
  assert.ok(texts.every(Boolean), "every call is labelled in the picture");
  assert.deepEqual(L.paths.find((p) => p.to === "status").text.lines, ["transition() per", "loan"]); // 21 characters: one over a line
  for (const p of L.paths) {
    assert.ok(p.text.x > p.badge.x && Math.abs(p.text.y + p.text.h / 2 - p.badge.y) <= 1, `${p.mark}: the text sits right of its number`);
    for (const n of L.nodes) assert.ok(!boxOver(p.text, n), `${p.mark}: text on ${n.id}`);
    for (const q of L.paths) if (q !== p) assert.ok(!boxOver(p.text, q.text), `texts ${p.mark} ${q.mark} overlap`);
    assert.ok(p.text.lines.length <= LABEL.LINES && p.text.lines.every((l) => l.length <= LABEL.CH));
  }
  // Code in a text breaks after its punctuation, not inside a name; plain words wrap as everywhere.
  assert.deepEqual(labelLines("queue.publish(LoanEvent)", 20), ["queue.publish(", "LoanEvent)"]);
  assert.deepEqual(labelLines("transition(loan, REMINDED/OVERDUE)", 20), ["transition(loan,", "REMINDED/OVERDUE)"]);
  assert.deepEqual(labelLines("Calls consumer.handle in-process", 20), ["Calls", "consumer.handle", "in-process"]);
  assert.deepEqual(labelLines("x".repeat(45), 20).map((l) => l.length), [20, 20, 5]);
  assert.deepEqual(labelLines("", 20), []);
  // A long text is cut after three lines (the legend then lists it whole); bands never cut through a text.
  const long = archLayout({ ...mail, edges: mail.edges.map((e, i) => (i ? e : { ...e, label: "Imports the consumer module and calls its handle() inline, in the request path of the front desk" })) }, "diff", () => 0, false, { labels: true });
  const cut = long.paths.find((p) => p.from[0] === "handler").text;
  assert.equal(cut.cut, true); assert.equal(cut.lines.length, 3); assert.ok(cut.lines[2].endsWith("…"));
  // A band is as tall as what is in it: the first columns have one row of cards, the long line runs under the last ones.
  const hs = archBands(L, 900).map((b) => b.h);
  assert.ok(hs.length > 1 && hs.every((h) => h > 0 && h <= L.height) && Math.max(...hs) === L.height, `band heights ${hs}`);
  assert.equal(archBands(L, 0)[0].h, L.height);
  // A line that goes on in the next band is named at both ends: what leaves a band on the right enters the next on the
  // left, with the same numbers at the same height. Nothing enters the first band or leaves the last.
  const BB = archBands(L, 900);
  assert.deepEqual([BB[0].in, BB.at(-1).out], [[], []]);
  BB.slice(0, -1).forEach((b, k) => { assert.ok(b.out.length > 0, `nothing leaves band ${k}`); assert.deepEqual(b.out, BB[k + 1].in); });
  for (const b of BB) for (const m of [...b.in, ...b.out]) assert.ok(m.nums.length > 0 && m.nums.every((n) => L.paths.some((p) => p.num === n)));
  assert.ok(BB.flatMap((b) => b.out).some((m) => m.back && m.nums.includes(L.paths.find((p) => p.kind === "long").num)), "the long line under the picture runs right to left");
  // A cut falls on the side of its gutter that keeps the bands short: the queue's line runs down to the consumer's
  // row, so its lane stays in the band of the tall column and the consumer's band is as tall as its frame.
  const once = archLayout({ ...mail, edges: mail.edges.slice(0, -1) }, "diff", () => 0, false, { labels: true }); // without the long line under the picture
  const queue = once.nodes.find((n) => n.id === "queue"), cons = once.groups.find((g) => g.id === "cons");
  const last = archBands(once, once.width - queue.x - 100).at(-1);
  assert.ok(last.x0 > queue.x + queue.w && last.x0 < cons.x, "the last band starts between the queue and the consumer");
  assert.ok(last.h < queue.y, `the consumer's band is ${last.h} tall, the queue starts at ${queue.y}`);
  for (const b of archBands(L, 900)) for (const p of L.paths) assert.ok(p.text.x + p.text.w <= b.x0 || p.text.x >= b.x1 || (p.text.x >= b.x0 && p.text.x + p.text.w <= b.x1), `a band cuts through text ${p.mark}`);
  // A marked call keeps a row above its text for the mark, also when it has no label.
  const marked = archLayout(mail, "diff", () => 0, false, { labels: true, marked: (es) => es.includes(0) }), mk = marked.paths.find((p) => p.edges.includes(0));
  assert.equal(mk.text.mark, true); assert.equal(mk.text.h, L.paths.find((p) => p.edges.includes(0)).text.h + LABEL.MARK);
  assert.ok(marked.paths.filter((p) => p !== mk).every((p) => !p.text.mark));
}

// ---- where findings sit on the picture: on the call or card they break, a reviewer's on the card of its file
{
  const f = (id, severity, file, line, breaks) => ({ id, severity, file, line, title: id, breaks });
  const m = archMarks(mail, [
    f("double", "high", "library/reminders.py", 21, { from: "consumer", to: "mailer", edge: "e6" }),
    f("inline", "medium", "library/handler.py", 21, { from: "handler", to: "consumer" }), // no index: found by its ends
    f("dead", "high", "library/reminders.py", 33, { node: "reminders" }),
    f("reviewer", "medium", "repo/library/reminders.py", 23, null), // no breaks: the card of its file
    f("low", "low", "library/reminders.py", 2, undefined), // above the card's line: still the file's card
    f("gone", "high", "library/handler.py", 6, { node: "no-such-card" }), // an unknown card: by its file
    f("nowhere", "high", "library/loans.py", 41, null)]); // no card for the file: not on the picture
  assert.deepEqual([...m.edges.keys()], [6, 0]);
  assert.deepEqual(m.edges.get(6), { findings: [m.edges.get(6).findings[0]], n: 1, breaks: 1, severity: "high" });
  const r = m.nodes.get("reminders");
  assert.deepEqual([r.n, r.breaks, r.severity, r.findings.map((x) => x.id)], [3, 1, "high", ["dead", "reviewer", "low"]]);
  assert.deepEqual([m.nodes.get("handler").n, m.nodes.get("handler").breaks], [1, 0]);
  assert.equal([...m.nodes.values()].concat([...m.edges.values()]).flatMap((x) => x.findings).some((x) => x.id === "nowhere"), false);
  // Two cards of one file: the last one that starts at or above the finding's line.
  const two = { nodes: [{ id: "a", at: "t.yaml:11" }, { id: "b", at: "t.yaml:28" }], edges: [] };
  assert.deepEqual([...archMarks(two, [f("x", "low", "t.yaml", 30), f("y", "low", "t.yaml", 12), f("z", "low", "t.yaml", 3)]).nodes].map(([k, v]) => [k, v.n]), [["b", 1], ["a", 2]]);
  // A finding that names its way in sits on that way's card, not on the card of its file (a template line).
  const acc = [{ id: "acc1", node: "handler" }, { id: "acc9", node: "no-such-card" }];
  const way = (ids) => [...archMarks(mail, [{ ...f("token", "high", "template.yaml", 18), reachable_from: ids }], acc).nodes.keys()];
  assert.deepEqual([way(["acc1"]), way(["acc9", "acc1"]), way(["acc9"]), way([])], [["handler"], ["handler"], ["queue"], ["queue"]]);
  // A bus merges calls: its mark is the sum, with the highest severity. Nothing marked: null.
  assert.deepEqual(pathMark(m, { edges: [0, 6] }).severity, "high"); assert.equal(pathMark(m, { edges: [0, 6] }).n, 2);
  assert.equal(pathMark(m, { edges: [3] }), null); assert.equal(pathMark(null, { edges: [0] }), null);
  assert.deepEqual([...archMarks(null, [f("x", "low", "a.py", 1)]).nodes], []);
}

// ---- trust zones passed through the layout
{
  // Trust zones as the frames (the Security page): the zones are the groups, a card without a zone stands in a
  // bare group (laid out, not drawn), a call over a boundary says so. Without zones the picture is untouched.
  const zoned = { ...mail, zones: [{ id: "z_fd", name: "Front desk function", trust: "authenticated" }, { id: "z_app", name: "Application", trust: "internal" }],
    nodes: mail.nodes.map((n) => ({ ...n, zone: n.id === "handler" ? "z_fd" : n.id === "mailer" || n.id === "queue" ? undefined : "z_app" })),
    edges: mail.edges.map((e) => (e.from === "handler" ? { ...e, crosses: true } : e)) };
  const za = zoneArch(zoned), Z = archLayout(za);
  assert.deepEqual(Z.groups.map((g) => [g.label, g.trust ?? null, Boolean(g.bare)]), [["Front desk function", "authenticated", false], ["Application", "internal", false], ["", null, true], ["", null, true]]);
  assert.deepEqual(Object.fromEntries(za.nodes.map((n) => [n.id, n.group])), { handler: "z_fd", reminders: "z_app", status: "z_app", events: "z_app", consumer: "z_app", queue: "\0free:infra", mailer: "\0free:core" });
  assert.deepEqual(Z.paths.filter((p) => p.crosses).map((p) => p.from[0]), ["handler"]);
  assert.deepEqual(za.edges, zoned.edges, "the calls keep their indexes: findings find their call");
  assert.equal(zoneArch(mail), mail); assert.equal(zoneArch(null), null);
  assert.ok(archLayout(mail).paths.every((p) => p.crosses === null));
  // Wrapped, no band cuts through a frame: a wide zone goes whole into the next band.
  const ZL = archLayout(za, "diff", () => 0, false, { labels: true }), app = ZL.groups.find((g) => g.label === "Application");
  for (const view of [300, 500, 700, 900]) for (const b of archBands(ZL, view)) for (const g of ZL.groups.filter((x) => !x.bare))
    assert.ok(!(g.x < b.x0 && b.x0 < g.x + g.w), `a band at ${view} px cuts ${g.label} at ${b.x0}`);
  assert.ok(archBands(ZL, Math.round(app.w * 0.6)).length > 1, "a frame wider than the view still wraps around it");
}
console.log("ok");

// ---- a mark names its finding
{
  const { markLine } = await import("./arch.js");
  const f = (title, severity) => ({ title, severity });
  assert.deepEqual(markLine({ n: 1, findings: [f("Front desk token defaults to empty, so an empty bearer token authenticates", "high")] }).text, "Front desk token defaults to…");
  const two = markLine({ n: 2, findings: [f("Minor thing", "low"), f("No SQS publisher", "high")] });
  assert.deepEqual([two.text, two.top.title], ["No SQS publisher and 1 more", "No SQS publisher"]);
  assert.equal(markLine({ n: 1, findings: [f("`Queue.publish` never sends", "high")] }).text, "Queue.publish never sends");
  assert.deepEqual(markLine(null), { text: "", top: null });
}

// ---- a finding a threat names sits at that threat's way in, not at its own (wrong) one or its file
{
  const { archMarks } = await import("./arch.js");
  const arch = { nodes: [{ id: "fd", at: "handler.py:1" }, { id: "q", at: "template.yaml:10" }], edges: [{ from: "fd", to: "q" }] };
  const tok = { id: "tok", severity: "high", file: "template.yaml", line: 14, reachable_from: ["acc2"] };
  const access = [{ id: "acc1", node: "fd" }, { id: "acc2", node: "q" }];
  assert.deepEqual([...archMarks(arch, [tok], access).nodes.keys()], ["q"], "without threats: its own way in");
  assert.deepEqual([...archMarks(arch, [tok], access, [{ where: { access: "acc1" }, findings: ["tok"] }]).nodes.keys()], ["fd"]);
  assert.deepEqual([...archMarks(arch, [tok], access, [{ where: { access: "acc1" }, findings: ["tok"], derived: true }]).nodes.keys()], ["q"], "a placeholder names nothing");
  assert.deepEqual([...archMarks(arch, [tok], access, [{ where: { edge: "e0" }, findings: ["tok"] }]).edges.keys()], [0]);
}

// ---- a way in stays next to its caller from outside instead of being pulled to the end of its group
{
  const { archLayout } = await import("./arch.js");
  const arch = { groups: [{ id: "x", label: "Callers" }, { id: "fd", label: "Front desk" }, { id: "c", label: "Consumer" }],
    nodes: [{ id: "cl", group: "x" }, { id: "h", group: "fd" }, { id: "r", group: "fd" }, { id: "s", group: "fd" }, { id: "e", group: "fd" }, { id: "co", group: "c" }],
    edges: [{ from: "cl", to: "h" }, { from: "r", to: "s" }, { from: "s", to: "e" }, { from: "h", to: "co" }, { from: "e", to: "co" }] };
  const L = archLayout(arch), col = (id) => L.nodes.find((n) => n.id === id).col;
  assert.equal(col("h"), col("cl") + 1, "the handler stands right after its caller");
  assert.ok(L.paths.find((p) => p.from.includes("cl")).kind !== "stub", "the call into it is a line, no stub");
}

// A long line from the card above a next-column line no longer crosses it (the owner's picture, rebuilt with other
// names): the card with the long line goes below, and its way down takes the lane that crosses nothing. A crossing
// that stays keeps its hop (hops are crossings()).
{
  const N = (id, group, label) => ({ id, group, label, description: "d", type: "service", status: "new" });
  const arch = { groups: [{ id: "ws", label: "Workstation", kind: "client" }, { id: "acc", label: "Account", kind: "cloud" }, { id: "store", label: "Storage", kind: "cloud" }],
    nodes: [N("show", "ws", "show script"), N("toggle", "ws", "toggle script"), N("org", "acc", "Organizations"), N("mid", "acc", "Delivery"), N("bucket", "store", "Bucket")],
    edges: [{ from: "show", to: "bucket", label: "reads events" }, { from: "toggle", to: "org", label: "detach / attach" }, { from: "mid", to: "bucket", label: "writes" }] };
  for (const fit of [false, true]) {
    const L = archLayout(arch, "diff", () => 0, fit, { labels: true }), y = (id) => L.nodes.find((n) => n.id === id).y;
    assert.deepEqual([L.paths.find((p) => p.kind === "long")?.to, L.hops.length], ["bucket", 0]);
    assert.ok(y("show") > y("toggle"), "the card with the long line sits below");
    assert.equal(L.hops.length, crossings([...L.paths.filter((p) => p.kind === "next" || p.kind === "long"), ...L.trunks]).length);
  }
  // Where the order cannot help (one card each in two columns of a group), the long line's lane still goes where it
  // crosses the fewest: here none.
  const one = { ...arch, groups: [...arch.groups, { id: "ws2", label: "Other", kind: "client" }], nodes: arch.nodes.map((n) => (n.id === "toggle" ? { ...n, group: "ws2" } : n)) };
  assert.equal(archLayout(one, "diff", () => 0, false, { labels: true }).hops.length, 0);
  console.log("ok long lines cross less");
}

// Two long lines from one column nest instead of crossing: the one that ends further right starts lower and runs on
// the lower channel (PR #2's reminders and handler, rebuilt with other names). Where no order helps, one crossing stays
// with its hop.
{
  const N = (id, group, label) => ({ id, group, label, description: "d", type: "service", status: "new" });
  const arch = { groups: [{ id: "g", label: "Lambda", kind: "lambda" }, { id: "h", label: "Middle", kind: "x" }, { id: "k", label: "Far", kind: "x" }],
    nodes: [N("a", "g", "far caller"), N("b", "g", "near caller"), N("c", "g", "other"), N("m1", "h", "first"), N("t2", "h", "near target"), N("t3", "k", "far target")],
    edges: [{ from: "a", to: "t3", label: "to the far one" }, { from: "b", to: "t2", label: "to the near one" }, { from: "c", to: "m1", label: "x" }, { from: "m1", to: "t2", label: "x" }, { from: "t2", to: "t3", label: "y" }] };
  // The middle frame as tall as the first one leaves no way between the frames: both lines go under the picture.
  const full = { ...arch, nodes: [...arch.nodes, N("m2", "h", "second"), N("m3", "h", "third")] };
  for (const fit of [false, true]) {
    const L = archLayout(full, "diff", () => 0, fit, { labels: true }), y = (id) => L.nodes.find((n) => n.id === id).y;
    assert.deepEqual([L.paths.filter((p) => p.kind === "long").length, L.hops.length, lineStats(L).around], [2, 0, 2]);
    assert.ok(y("a") > y("b"), "the line that ends further right starts lower");
    // With room over and under the middle frame neither goes round the picture after the search, and still nothing crosses.
    const free = archBest(arch, "diff", () => 0, fit, { labels: true });
    assert.deepEqual([free.paths.filter((p) => p.kind === "long").length, free.hops.length, lineStats(free).around], [2, 0, 0]);
  }
  console.log("ok long lines nest");
}

// Lines that run on top of each other are counted (overlapsOf) and the lanes avoid them: a chain of checks, each
// with a "no" to its own answer and a "yes" to the next check (a flow from PR #1, rebuilt with other names).
{
  const { overlapsOf } = await import("./arch.js");
  const { flowArch } = await import("./views.js");
  const note = (k) => "A short note about this step of the check.".repeat(3).slice(0, k);
  const n = ([id, label, k]) => ({ id, label, ...(k ? { note: note(k) } : {}), changed: true, source: "implemented" });
  const v = { kind: "flow", title: "checks", nodes: [["ev", "Incoming event", 87], ["c1", 'Starts with "Key "?', 0], ["c2", "compare(key, SECRET)?", 83], ["c3", 'path == "/list"?', 0],
    ["call", "api.list({})", 42], ["r1", "401 missing key", 0], ["r2", "403 wrong key", 0], ["r3", "404 not found", 0], ["r4", "200 + json(body)", 0]].map(n),
    edges: [["ev", "c1", "authorization header"], ["c1", "r1", "no"], ["c1", "c2", "yes"], ["c2", "r2", "no"], ["c2", "c3", "yes"], ["c3", "r3", "no"], ["c3", "call", "yes"],
      ["call", "r4", "status, body"]].map(([from, to, label]) => ({ from, to, label, changed: true, source: "implemented" })) };
  for (const fit of [false, true]) {
    const L = archLayout(flowArch(v), "diff", () => 0, fit, { labels: true }), drawn = [...L.paths.filter((p) => p.kind === "next" || p.kind === "long"), ...L.trunks];
    assert.deepEqual([overlapsOf(drawn).length, L.overlaps.length], [0, 0]);
  }
  // The count itself: one stretch shared, a touch at a corner is none, the same path never overlaps itself.
  const P = (key, ...segments) => ({ key, segments });
  assert.equal(overlapsOf([P("a", { x1: 0, y1: 10, x2: 50, y2: 10 }), P("b", { x1: 40, y1: 11, x2: 90, y2: 11 })]).length, 1);
  assert.equal(overlapsOf([P("a", { x1: 0, y1: 10, x2: 50, y2: 10 }), P("b", { x1: 50, y1: 10, x2: 90, y2: 10 })]).length, 0);
  assert.equal(overlapsOf([P("a", { x1: 5, y1: 0, x2: 5, y2: 40 }, { x1: 5, y1: 20, x2: 5, y2: 60 })]).length, 0);
  assert.equal(overlapsOf([P("a", { x1: 5, y1: 0, x2: 5, y2: 40 }), P("b", { x1: 6, y1: 20, x2: 6, y2: 60 })]).length, 1);
  console.log("ok overlaps");
}

// A long line from the top card of its column runs over the picture when that saves a crossing (PR #2's reminders →
// mailer, rebuilt with other names): no crossing and no shared stretch left, the picture moved down by the room for
// the channel (L.top), and a band without the line can leave that room out (y0).
{
  const N = (id, group, label) => ({ id, group, label, description: "d", type: "service", status: "new" });
  const arch = { groups: [{ id: "in", label: "Callers", kind: "x" }, { id: "fd", label: "Front", kind: "lambda" }, { id: "q", label: "Queue", kind: "x" }, { id: "rc", label: "Consumer", kind: "lambda" }],
    nodes: [N("client", "in", "client"), N("handler", "fd", "handler"), N("rem", "fd", "producer"), N("status", "fd", "state machine"), N("events", "fd", "events"), N("queue", "q", "queue"),
      N("consumer", "rc", "consumer"), N("store", "rc", "store"), N("mailer", "rc", "mailer")],
    edges: [["client", "handler", "POST /x"], ["rem", "status", "transition"], ["rem", "mailer", "mails directly"], ["handler", "consumer", "direct call"], ["status", "events", "publish"],
      ["events", "queue", "send"], ["queue", "consumer", "trigger"], ["consumer", "store", "read"], ["consumer", "mailer", "send mail"]].map(([from, to, label]) => ({ from, to, label })) };
  for (const fit of [false, true]) {
    const L = archLayout(arch, "diff", () => 0, fit, { labels: true }), up = L.paths.filter((p) => p.kind === "long" && p.segments.some((s) => s.y1 === s.y2 && s.y1 < L.top));
    assert.deepEqual([L.hops.length, L.overlaps.length, up.length, L.top > 0], [0, 0, 1, true]);
    assert.ok(Math.min(...L.nodes.map((n) => n.y), ...L.groups.map((g) => g.y)) >= L.top, "nothing but the channel above");
    const B = archBands(L, Math.round(L.width / 3));
    assert.ok(B.some((b) => b.y0 === 0) && B.some((b) => b.y0 >= L.top), "the band with the line shows its channel, one without starts at its frames");
  }
  console.log("ok a line over the picture");
}

// Finding chips that would touch are one bundle; one that joins two bundles makes them one; far ones stay alone.
{
  const c = (x, y, w = 46) => ({ x, y, w });
  assert.deepEqual(bundleChips([c(0, 0), c(50, 0), c(200, 0)]).map((g) => g.length), [1, 1, 1], "4 px apart and more: each its own chip");
  assert.deepEqual(bundleChips([c(0, 0), c(48, 0), c(200, 0)]).map((g) => g.length), [2, 1], "closer than the gap");
  assert.deepEqual(bundleChips([c(0, 0), c(96, 0), c(48, 9)]).map((g) => g.length), [3], "the third touches both");
  assert.deepEqual(bundleChips([c(0, 0), c(10, 30)]).map((g) => g.length), [1, 1], "a row below is not touching");
  console.log("ok chip bundles");
}

// A card's mark: a finding that fits one line takes two rows (chip and line), a longer one three, as before.
{
  const m = (title, n = 1) => ({ n, severity: "high", findings: [{ title, severity: "high" }] });
  assert.deepEqual(markRoom(m("No retry"), 210), { lines: 1, rows: 2, h: 33 });
  assert.deepEqual(markRoom(m("Nothing ever calls send_reminders or publish_overdue in production"), 210), { lines: 2, rows: 3, h: MARK_CARD_H });
  assert.equal(markRoom(m("No retry", 3), 140).lines, 1, "'No retry and 2 more' still fits 23 characters");
  console.log("ok mark room");
}

// A layout's lines in numbers: crossings, bends, length, and the long lines that run round the whole picture.
{
  const P = (key, kind, ...xy) => ({ key, kind, segments: xy.map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 })) });
  const L = { groups: [{ x: 0, y: 0, w: 300, h: 100 }], trunks: [], paths: [P("a", "next", [0, 10, 50, 10], [50, 10, 50, 40], [50, 40, 100, 40]), P("b", "next", [0, 30, 60, 30], [60, 30, 100, 30]),
    P("c", "long", [0, 60, 20, 60], [20, 60, 20, 120], [20, 120, 200, 120], [200, 120, 200, 80], [200, 80, 220, 80]), P("d", "stub", [0, 90, 16, 90])] };
  assert.deepEqual(lineStats(L), { crossings: 1, overlaps: 0, bends: 6, length: 130 + 100 + 320, around: 1, covered: 0 }, "a straight line has no bend, a stub does not count, c runs under the frame");
  assert.equal(lineStats({ ...L, paths: [...L.paths, { ...P("e", "next", [0, 5, 9, 5]), text: { x: 100, y: 110, w: 40, h: 20 } }] }).covered, 1, "c runs under e's text");
  console.log("ok line stats");
}

// The owner's boundary map, rebuilt with other names: a frame of four operator cards, two small frames in the middle
// column, one call from an operator card to the far column. The call takes the free way between the frames instead
// of the way round the picture, its card stands where that way is straight, the frame both operator lines go into
// stands level with them (lower than its place in the stack, the picture no taller), and nothing crosses.
{
  const N = (id, group, label) => ({ id, group, label, description: "", type: "component" }), E = (from, to, label, dashed = false) => ({ from, to, label, crosses: true, dashed });
  const arch = { groups: [["ops", "Operators", "operator"], ["out", "Outside", "public"], ["gw", "Gateway", "operator"], ["ctl", "Control plane", "operator"], ["app", "Workers", "internal"], ["data", "Storage", "data"]].map(([id, label, trust]) => ({ id, label, kind: trust, trust })),
    nodes: [N("caller", "out", "anyone on the internet"), N("api", "gw", "Public API"), N("report", "ops", "report script"), N("bucket", "data", "Event bucket"), N("toggle", "ops", "toggle script"), N("admin", "ctl", "Admin API"),
      N("deployA", "ops", "operator who deploys the gateway"), N("deployB", "ops", "operator who deploys the control plane"), N("stream", "app", "Delivery stream"), N("worker", "app", "Worker function"), N("secret", "data", "Signing secret"),
      N("bus", "app", "Event bus"), N("archive", "data", "Event archive")],
    edges: [E("caller", "api", "1. ‖ token · body, Authorization header"), E("caller", "api", "2. ‖ signature · body, signature header"), E("report", "bucket", "3. ‖ iam · scripts/report.sh", true), E("toggle", "admin", "4. ‖ iam · scripts/toggle.sh"),
      E("deployA", "api", "5. ‖ deploy access · API secret; hook secret", true), E("deployB", "admin", "6. ‖ deploy access · ADMIN_PROFILE", true), E("api", "worker", "7. ‖ iam · function:Invoke"), E("worker", "secret", "8. ‖ iam · secrets:GetValue"),
      E("bus", "archive", "9. ‖ iam · detail (body), detail-type", true), E("stream", "bucket", "10. ‖ iam · storage:PutObject")] };
  const args = (a) => [a, "diff", () => 0, true, { labels: true, lines: () => true }], lay = (a) => archBest(...args(a)); // as the Security page lays it out, after its search
  const L = lay(arch), s = lineStats(L), g = (id) => L.groups.find((x) => x.id === id), path = (n) => L.paths.find((p) => p.label.startsWith(`${n}. `)), bendsOf = (p) => lineStats({ ...L, paths: [p], trunks: [] }).bends;
  // Before: 2 crossings, 18 bends, 4698 px of lines, the long line round the picture.
  assert.deepEqual([s.crossings, s.overlaps, s.around, s.covered], [0, 0, 0, 0], "nothing crosses, no line round the picture");
  assert.ok(s.bends <= 6 && s.length < 3800, `bends ${s.bends}, length ${s.length}`);
  assert.deepEqual([bendsOf(path(4)), bendsOf(path(6))], [0, 0], "both lines into the control plane's card run straight");
  assert.ok(g("ctl").y > g("gw").y + g("gw").h + ARCH.GAP_G, "the control plane's frame stands lower than right under the gateway's");
  assert.equal(Math.max(...L.groups.map((x) => x.y + x.h)), g("ops").y + g("ops").h, "the picture is no taller than its tallest column");
  assert.ok(L.height <= g("ops").y + g("ops").h, "no channel under the picture any more");
  const long = path(3), frames = L.groups.filter((x) => x.id !== "ops" && x.id !== "data"); // its own frame and its target's aside
  assert.equal(long.kind, "long"); assert.ok(bendsOf(long) <= 2, "out of its card straight to the last gutter, then into its target");
  assert.ok(!long.segments.some((sg) => frames.some((r) => inside(sg, r))), "the long line runs through no frame on its way");
  for (const a of L.groups) for (const b of L.groups) assert.ok(a === b || a.x >= b.x + b.w || b.x >= a.x + a.w || a.y >= b.y + b.h + ARCH.GAP_G || b.y >= a.y + a.h + ARCH.GAP_G, `${a.id} and ${b.id} keep their gap`);
  assert.equal(L.paths.filter((p) => p.text).length, 10, "every line still carries its text");
  assert.deepEqual(L.paths.map((p) => p.label.split(".")[0]).sort((a, b) => a - b), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"], "the crossings keep their numbers");
  assert.equal(L.hops.length, crossings([...L.paths.filter((p) => p.kind === "next" || p.kind === "long"), ...L.trunks]).length);
  // The same data: the same picture. One call less far away: no card moves.
  assert.deepEqual(lay(arch), L);
  const less = lay({ ...arch, edges: arch.edges.filter((e) => !e.label.startsWith("9.")) });
  assert.deepEqual(less.nodes.map((n) => [n.id, n.col, n.y]), L.nodes.map((n) => [n.id, n.col, n.y]), "a call less: every card in its column at its height");
  // Wrapped into bands, the line through the picture goes on at its height in the next band.
  assert.ok(archBands(L, Math.round(L.width / 2)).length > 1);
  // What a render gets at once (archLayout) has the straight lines already and crosses no more than before; the long
  // line's way through the picture comes with the search (layoutJob), in slices: with a clock that ticks once per
  // step a slice of 10 ms is ten steps, and the result is the same wherever the slices fall.
  const quick = archLayout(...args(arch)), q = lineStats(quick);
  assert.ok(q.crossings <= 2 && q.bends < 18 && q.around === 1, JSON.stringify(q));
  assert.deepEqual(archQuick(...args(arch)), quick, "ten lines: a render can afford archLayout");
  const ticking = () => { let t = 0; return () => t++; }, job = layoutJob(...args(arch));
  let slices = 0, done = null;
  for (let before = 0; !(done = layoutStep(job, 10, ticking())); before = job.n) { slices++; assert.equal(job.n - before, 10, "ten steps a slice"); }
  assert.deepEqual(done, L); assert.ok(slices > 3, `${slices} slices`);
  // A picture without a long line and without a crossing has nothing to search: the render's layout stays.
  const plain = { ...arch, edges: arch.edges.filter((e) => !e.label.startsWith("3.")) };
  assert.deepEqual(archBest(...args(plain)), archLayout(...args(plain)));
  console.log("ok frames and long lines run straight");
}

// A line between two cards is straight where both sides have room (the taller card's port slides); a frame alone in
// its column comes down to the card that calls it, and the frame it calls follows, so both lines are straight.
{
  const N = (id, group, description = "d") => ({ id, group, label: id, description, type: "service" });
  const arch = { groups: ["a", "b", "c"].map((id) => ({ id, label: id, kind: "x" })), nodes: [N("a1", "a"), N("a2", "a"), N("b1", "b"), N("c1", "c", "A long description that makes this card taller than the others, over three lines of text in all.")],
    edges: [{ from: "a2", to: "b1", label: "x" }, { from: "b1", to: "c1", label: "y" }] };
  const L = archLayout(arch), y = (id) => L.nodes.find((n) => n.id === id).y, s = lineStats(L);
  assert.deepEqual([s.bends, s.crossings], [0, 0], "both lines straight");
  assert.ok(y("b1") === y("a2") && y("c1") < y("b1") && y("c1") > y("a1"), "b came down to a2 and c after it, less far: its taller card's port slid");
  assert.ok(Math.max(...L.groups.map((g) => g.y + g.h)) <= L.groups.find((g) => g.id === "a").h, "no taller than before");
  // Wrapped, a band shows from where its own frames start: the lowered frame's band has no empty strip over it.
  const B = archBands(L, L.groups.find((g) => g.id === "a").w + 60), gb = L.groups.find((g) => g.id === "b");
  assert.ok(B.length > 1 && B.find((b) => b.x0 <= gb.x && gb.x < b.x1).y0 >= gb.y - 12 && B[0].y0 === 0, JSON.stringify(B.map((b) => [b.x0, b.y0, b.h])));
  console.log("ok straight lines");
}

// The demo PR's maps (demo/fixtures/review, in a checkout of the repository) are no worse than before the frames and
// long lines moved: no more crossings, bends, length or ways round the picture, on the Security page and both sizes
// of the architecture map.
{
  const { existsSync, readFileSync } = await import("node:fs"), FX = new URL("../../demo/fixtures/review/", import.meta.url);
  if (!existsSync(FX)) console.log("skipped the demo PR's maps: no demo/fixtures/review next to this copy of the mod");
  else {
    const { mapReview, withSecurity } = await import("./pr.js"), { mapArch, crossingsOf, crossingChanged, secPicture } = await import("./views.js");
    const fx = (f) => JSON.parse(readFileSync(new URL(f, FX), "utf8")), saved = fx("analysis-s.json"), doc = fx("findings-s.json");
    const ai = withSecurity({ ...mapReview(saved.answer, saved.hunks), head: doc.security.head }, doc.security, null, doc.security.head), a = ai.arch;
    const rows = crossingsOf({ arch: a, access: ai.access, threats: ai.threats, gates: ai.gates, bypasses: ai.bypasses, findings: doc.findings });
    const secArgs = [secPicture(rows.filter(crossingChanged), a, (r) => rows.indexOf(r) + 1), "diff", () => 0, true, { labels: true, lines: () => true }], sec = archBest(...secArgs);
    const was = { sec: [0, 16, 3029, 2], wide: [0, 18, 5417, 2], fit: [0, 22, 4986, 2] }; // crossings + overlaps, bends, length, round the picture
    // Each map as a render gets it at once, and after its search.
    const m = mapArch(a, ai.access, ai.bypasses), maps = { sec: [archLayout(...secArgs), sec], wide: [false].flatMap((fit) => [archLayout(m, "diff", () => 0, fit, { labels: true }), archBest(m, "diff", () => 0, fit, { labels: true })]),
      fit: [true].flatMap((fit) => [archLayout(m, "diff", () => 0, fit, { labels: true }), archBest(m, "diff", () => 0, fit, { labels: true })]) };
    // The width with the other card size follows from either layout: the review lays out only the one it shows.
    assert.deepEqual([widthAt(maps.fit[0], true, false), widthAt(maps.wide[0], false, true), widthAt(maps.fit[0], true, true)], [maps.wide[0].width, maps.fit[0].width, maps.fit[0].width]);
    for (const [k, Ls] of Object.entries(maps)) for (const L of Ls) {
      const s = lineStats(L), now = [s.crossings + s.overlaps, s.bends, s.length, s.around];
      now.forEach((v, i) => assert.ok(v <= was[k][i], `${k}: ${now} was ${was[k]}`));
      assert.equal(s.covered, 0);
    }
    assert.ok(lineStats(sec).bends <= 8 && lineStats(sec).around <= 1, "the Security page's map: half the bends, one line less round the picture");
    console.log("ok the demo PR's maps are no worse");
  }
}

// Straight lines never cost crossings, and a big picture's search stays in its slices: a dense invented map (six
// frames of six cards, each card calling into the next frame, ten calls that skip columns: 36 cards, 50 lines) and
// one twice its size. After the search the picture crosses and covers no more lines than with every frame and port
// left where the stack put it (opts.still: the picture as it was before frames moved). In slices (a clock that ticks
// once per step: ten steps per 10 ms) the search gives the same layout as in one go, and no step is a whole layout:
// the job takes over a hundred times more steps than it lays the picture out (a step is one order priced).
{
  const dense = (frames) => {
    const groups = Array.from({ length: frames }, (_, g) => ({ id: `g${g}`, label: `Frame ${g}`, kind: "x" })), nodes = groups.flatMap((g, k) => Array.from({ length: 6 }, (_, i) => ({ id: `n${k}_${i}`, group: g.id, label: `card ${k} ${i}`, description: "d" })));
    const edges = [];
    for (let k = 0; k < frames - 1; k++) for (let i = 0; i < 6; i++) { edges.push({ from: `n${k}_${i}`, to: `n${k + 1}_${(i * 5 + k) % 6}`, label: `call ${k} ${i}` }); if (i % 2) edges.push({ from: `n${k}_${i}`, to: `n${k + 1}_${(i + 2) % 6}`, label: `also ${k} ${i}` }); }
    for (let j = 0; j < (frames * 5) / 3; j++) edges.push({ from: `n${j % (frames - 3)}_${j % 6}`, to: `n${(j % (frames - 3)) + 2 + (j % 2)}_${(j * 2) % 6}`, label: `far ${j}` });
    return { groups, nodes, edges };
  };
  const tangle = (L) => lineStats(L).crossings + 2 * lineStats(L).overlaps, ticking = () => { let t = 0; return () => t++; };
  for (const [frames, lines] of [[6, 55], [12, 119]]) {
    const arch = dense(frames);
    assert.deepEqual([arch.nodes.length, arch.edges.length], [frames * 6, lines]);
    for (const opts of frames === 6 ? [{ labels: true }, { labels: true, lines: () => true }] : [{ labels: true }]) {
      const args = [arch, "diff", () => 0, true, opts], still = archLayout(arch, "diff", () => 0, true, { ...opts, over: new Set(), still: true });
      const job = layoutJob(...args);
      let best = null, slices = 0;
      for (let before = 0; !(best = layoutStep(job, 10, ticking())); before = job.n) { slices++; assert.equal(job.n - before, 10, "ten steps a slice"); }
      assert.ok(tangle(best) <= tangle(still), `${tangle(best)} was ${tangle(still)}`);
      assert.equal(best.hops.length, lineStats(best).crossings, "every crossing that stays has its hop");
      assert.ok(job.n > 100 * (2 + Math.floor(400 / best.paths.length)), `${job.n} steps in ${slices} slices: no step is a whole layout`);
      assert.deepEqual(archBest(...args), best, "in one go: the same layout");
      assert.equal(widthAt(best, true, false), archQuick(arch, "diff", () => 0, false, opts).width, "the width with the usual cards, without laying them out");
      // What a render gets for it at once (archQuick, past QUICK_LINES calls): the rough pass, with every card and line
      // there, no card on another, each crossing with its hop; the search's layout replaces it.
      const rough = archQuick(...args), boxes = rough.nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
      assert.ok(arch.edges.length > QUICK_LINES); assert.deepEqual(rough, archLayout(arch, "diff", () => 0, true, { ...opts, rough: true })); assert.notDeepEqual(rough, best);
      assert.deepEqual([rough.nodes.length, rough.paths.every((p) => p.segments.length > 0), rough.hops.length], [arch.nodes.length, true, lineStats(rough).crossings]);
      assert.ok(boxes.every((a, i) => boxes.every((b, j) => i >= j || a.x >= b.x + b.w || b.x >= a.x + a.w || a.y >= b.y + b.h || b.y >= a.y + a.h)), "no card on another");
    }
  }
  console.log("ok a big picture's search stays in its slices");
}
