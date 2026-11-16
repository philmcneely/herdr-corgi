// Run: node test_live.mjs  (live.js: the copies that feed Herdr's live data to the panel and the review)
import assert from "node:assert/strict";
import { S } from "./render_stub.mjs";
const L = await import("./live.js");

// A feeding copy in the layout: a block or a float of this mod with the part "mini" or "bar"; another mod's "bar" is none.
const tree = (parts) => ({ id: "root", type: "row", children: [{ id: "side", type: "column", children: [{ id: "tt", type: "block", content: { mod: "timetrack", props: { part: "bar" } } }] },
  { id: "main", type: "block", content: { tab: "active" }, floating: parts.map((part) => ({ id: `f-${part}`, content: { mod: "pr-review", props: part ? { part } : undefined } })) }] });
assert.equal(L.feederIn(tree(["mini"])), true, "the chip feeds");
assert.equal(L.feederIn(tree(["bar"])), true, "the review's bar feeds");
assert.equal(L.feederIn(tree([null, "review"])), false, "the panel and the review do not; another mod's bar is not ours");
assert.equal(L.feederIn(null), false);
// A feeding copy in a hidden node (itself, or a column around it) draws no frame: it does not count.
{ const t = tree(["mini"]), own = structuredClone(t), around = structuredClone(t);
  own.children[1].floating[0].hidden = true; around.children[1].hidden = true;
  assert.deepEqual([L.feederIn(own), L.feederIn(around), L.feederIn({ ...t, hidden: false })], [false, false, true]); }

// In a copy's init there is no layout yet: nothing is asked then either.
S.layout = null; S.spaces = [{ id: "s0", active: true }];
{ S.live = {}; const got = L.spaces(); assert.deepEqual([got, S.live.spaces ?? 0], [[], 0], "no layout yet (init): nothing, and Herdr is not asked"); }
// Not fed yet, or no feeding copy in the layout: Herdr is asked.
const reads = (f) => { S.live = {}; const v = f(); return [v, { ...S.live }]; };
S.spaces = [{ id: "s1", active: true }]; S.layout = tree(["mini"]);
assert.deepEqual(reads(() => L.spaces()), [[], { layout: 1 }], "before the feeding copy's first frame: nothing yet, and Herdr is not asked (one read would draw the reader on every change for good)");
{ // a task waits for the first feed
  let woke = 0; const timers = [], cx = { timer: { after: (_ms, f) => timers.push(f) } };
  const w = L.whenFed(cx).then(() => { woke++; });
  await Promise.resolve(); assert.equal(woke, 0, "whenFed waits");
  S.terminals = [{ address: "t1", state: "live" }]; L.feed(); await w; assert.equal(woke, 1, "until the feeding copy drew");
  timers.forEach((f) => f()); assert.equal(L.spaces()[0].id, "s1", "the wait's timer after a feed changes nothing");
}
// Fed: what the feeding copy read, and Herdr is not asked by the reader (layout() is: it does not change with a status).
assert.equal(L.feed(), false, "nothing is watched: nothing changed");
S.spaces = [{ id: "s2", active: true }]; // Herdr's data moved on, the feeding copy has not drawn yet
const [got, asked] = reads(() => [L.spaces(), L.panes(), L.agents(), L.terminals()]);
assert.deepEqual([got[0][0].id, got[3][0].address, asked.spaces ?? 0, asked.panes ?? 0, asked.agents ?? 0, asked.terminals ?? 0], ["s1", "t1", 0, 0, 0, 0], "a fed reader gets the kept data and asks Herdr for none of the four");
L.feed(); assert.equal(L.spaces()[0].id, "s2", "the next frame of the feeding copy brings the new data");
S.layout = tree([null]);
assert.deepEqual(reads(() => L.spaces())[1].spaces, 1, "without a feeding copy in the layout Herdr is asked");
S.layout = tree(["bar"]);
{ // fresh: data kept from an earlier frame (a space made since, back from the review) is not taken as it is
  const timers = [], cx = { timer: { after: (_ms, f) => timers.push(f) } };
  S.spaces = [{ id: "s2" }, { id: "s3" }];
  assert.equal(L.feedIfAsked(), false, "nobody asked: the feeding copy's timer reads nothing");
  let woke = 0; const w = L.whenFed(cx, true).then(() => { woke++; });
  await Promise.resolve(); assert.equal(woke, 0, "it waits for a read from now on");
  L.feedIfAsked(); await w; assert.deepEqual(L.spaces().map((s) => s.id), ["s2", "s3"], "the feeding copy's timer read for it");
  assert.equal(L.feedIfAsked(), false, "once");
  // no feed within the wait: what is kept, and Herdr is still not asked (asked once, the reader is drawn on every change)
  S.spaces = [{ id: "s4" }]; timers.length = 0; const w2 = L.whenFed(cx, true); timers.forEach((f) => f()); await w2;
  const [got, asked] = reads(() => L.spaces());
  assert.deepEqual([got.map((s) => s.id), asked.spaces ?? 0], [["s2", "s3"], 0], "kept after the wait, not asked");
  L.feed();
}
// A watched terminal: feed() says when its state is another one.
L.watch(["t1", "t9"]);
assert.equal(L.feed(), true, "a new watch list is a change");
assert.equal(L.feed(), false, "the same states again are none");
S.terminals = [{ address: "t1", state: "finished" }, { address: "t2", state: "live" }];
assert.equal(L.feed(), true, "a watched terminal ended");
S.terminals = [{ address: "t1", state: "finished" }, { address: "t2", state: "finished" }];
assert.equal(L.feed(), false, "another terminal's state is not a change");
assert.equal(L.watchSig(["t1"], [{ address: "t1", status: "blocked" }], []), "t1:blocked:");
S.layout = undefined; S.spaces = null; S.terminals = null;
console.log("live ok");
