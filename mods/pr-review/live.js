// Herdr's live data (spaces, panes, agents, terminals) for the copies of this mod that are expensive to draw.
//
// Herdr draws a copy of a mod again whenever live data that copy has ever read changes: one read anywhere (in a frame,
// in init, in a timer) and the copy is drawn on every change from then on. Measured in a test window beside one
// terminal that reports another status every 2 s: a mod that never reads them is drawn 28 times a minute (other mods'
// shared writes), one that read spaces() once 58 times. spaces(), panes(), agents() and terminals() all change with
// every status of every agent in every space; focused() and layout() do not.
//
// So the PR panel and the review never ask Herdr for those four. The mod's small copies do (the chip in the main
// layouts, the bar in the review layout: feed() in their frame, which costs them nothing to draw), and keep what they
// read here, in the module the copies share. spaces() and the others below give that; without such a copy in the
// layout they ask Herdr as before.
import { spaces as spaces0, panes as panes0, agents as agents0, terminals as terminals0, layout } from "herdr";

const FED = { at: 0, direct: false, waiting: [], spaces: [], panes: [], agents: [], terminals: [], watch: [], sig: "" };
const MOD = (() => { try { return new URL(import.meta.url).pathname.split("/").slice(-2)[0] || "pr-review"; } catch { return "pr-review"; } })();
export const FEEDERS = ["mini", "bar"]; // the parts whose frame calls feed()

// Whether the layout has a copy that feeds: a block or float of this mod with one of those parts, anywhere in the tree
// but not inside a hidden node: a copy that is not shown draws no frame, so it feeds nothing (or nothing new), and
// the readers would keep an empty or an old answer. Then Herdr is asked, as without a feeding copy.
export function feederIn(tree, mod = MOD) {
  if (Array.isArray(tree)) return tree.some((x) => feederIn(x, mod));
  if (!tree || typeof tree !== "object" || tree.hidden === true) return false;
  if (tree.mod === mod && FEEDERS.includes(tree.props?.part)) return true;
  return Object.values(tree).some((v) => v && typeof v === "object" && feederIn(v, mod));
}
// With a feeding copy in the layout the kept data, also before that copy's first frame (nothing yet: the reader must
// not ask Herdr in the meantime, or it is drawn on every change for good; a task waits with whenFed). Without one, or
// after a wait that was given up, Herdr is asked.
// (In a copy's init Herdr has no layout yet, layout() is null: also then nothing is asked. The panel's init wants the
// active space; it gets it a moment later, from focused() in its first frames.)
const kept = () => { if (FED.direct) return false; const tree = layout(); return tree === null || tree === undefined || feederIn(tree); };
export const spaces = () => (kept() ? FED.spaces : spaces0());
export const panes = () => (kept() ? FED.panes : panes0());
export const agents = () => (kept() ? FED.agents : agents0());
export const terminals = () => (kept() ? FED.terminals : terminals0());
// For a task that needs the data right after the mod started: until the feeding copy drew its first frame, at most
// 2 s (then Herdr is asked from here on: a layout whose feeding copy never draws).
export function whenFed(cx) {
  if (FED.at || !kept()) return Promise.resolve();
  return new Promise((done) => { FED.waiting.push(done); cx.timer.after(2000, () => { if (!FED.at) FED.direct = true; done(); }); });
}

// The terminals a big copy shows the state of (a fix's agent, a check, a probe): feed() says when one of them changed.
export function watch(addresses) { FED.watch = [...new Set(addresses)].sort(); }
export const watchSig = (addresses, agentList, terminalList) => addresses.map((a) => `${a}:${agentList.find((x) => x.address === a)?.status ?? ""}:${terminalList.find((x) => x.address === a)?.state ?? ""}`).join("|");
// In the frame of a small copy: reads the four and keeps them. True when a watched terminal's status or state is
// another one than at the last call (the caller then makes the big copy draw, with one shared write).
export function feed() {
  FED.spaces = spaces0(); FED.panes = panes0(); FED.agents = agents0(); FED.terminals = terminals0(); FED.at = Date.now(); FED.direct = false;
  for (const done of FED.waiting.splice(0)) done();
  const sig = watchSig(FED.watch, FED.agents, FED.terminals), changed = sig !== FED.sig;
  FED.sig = sig;
  return changed;
}
