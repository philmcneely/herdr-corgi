// Run: node test_fetch.mjs
import assert from "node:assert/strict";
import { pollDue, pollAfter } from "./pr.js";

const M = 60000;
assert.equal(pollDue(null, 0, 5 * M), true, "never asked: due");
assert.equal(pollDue({ at: 0, fails: 0 }, 4 * M, 5 * M), false);
assert.equal(pollDue({ at: 0, fails: 0 }, 5 * M, 5 * M), true);
let s = pollAfter(null, false, 0);
assert.deepEqual(s, { at: 0, fails: 1 });
assert.equal(pollDue(s, 9 * M, 5 * M), false, "one failure: 10 min");
assert.equal(pollDue(s, 10 * M, 5 * M), true);
s = pollAfter(pollAfter(s, false, 10 * M), false, 30 * M);
assert.equal(s.fails, 3);
assert.equal(pollDue(s, 30 * M + 29 * M, 5 * M), false, "40 min would be next, capped at 30");
assert.equal(pollDue(s, 30 * M + 30 * M, 5 * M), true);
assert.deepEqual(pollAfter(s, true, 61 * M), { at: 61 * M, fails: 0 }, "a success resets the wait");
console.log("ok fetch");
