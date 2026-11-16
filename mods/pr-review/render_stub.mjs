// Stand-ins for gpui-kit, gpui-base and herdr, for the render tests (test_render.mjs, test_smoke.mjs): elements are
// chainable proxies that record a null or non-finite argument (and, when asked, the ids given), virtual lists record their size and render nothing until
// asked, cx does nothing. Import it before main.js or review.js. Not a test itself.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// files: what readTextFile finds (and, with S.writes set, what writeTextFile wrote: as Herdr, only over the text it is told is there); clicks: an element's id → its on_click handler (from the last frame drawn);
// overlays: what openOverlay was asked to show.
// n: how much a frame builds (el: elements made, call: builder calls on them), for the performance checks.
export const S = (globalThis.__rv = { errs: [], lists: [], store: new Map(), files: new Map(), props: null, clicks: new Map(), overlays: [], n: { el: 0, call: 0 }, live: {} });
const where = () => new Error().stack.split("\n").slice(3, 6).map((s) => s.trim()).join(" | ");
const bad = (v) => v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v));
S.el = () => {
  let id = null, click = null; S.n.el++;
  const p = new Proxy(function () {}, {
    get(_, k) {
      if (k === "then") return undefined;
      return (...a) => {
        S.n.call++;
        if (k === "id") id = a[0];
        if (k === "on_click") click = a[0];
        if ((k === "id" || k === "on_click") && id !== null && click) S.clicks.set(id, click);
        if (k === "when") return a[0] ? a[1](p) : p;
        if (k === "map") return a[0](p);
        if (k === "id") S.ids?.add(String(a[0])); // a test that asks what was drawn sets S.ids = new Set()
        if (k === "drag_paths") S.drags?.push(...a[0]); // … and S.drags = [] for the paths that can be dragged
        if (k === "child" && typeof a[0] === "string") S.texts?.add(a[0]); // … and S.texts = new Set() for the texts drawn
        if (k === "children") { for (const c of a[0]) if (bad(c)) S.errs.push(`children: ${c} at ${where()}`); return p; }
        a.forEach((v, i) => { if (bad(v)) S.errs.push(`${String(k)}(arg ${i} = ${v}) at ${where()}`); });
        return p;
      };
    },
  });
  return p;
};
S.handle = () => { let val = ""; return new Proxy({}, { get: (_, k) => (k === "then" ? undefined : (...a) => { // an input keeps what set_value gave it
  if (k === "scroll_to_item" && !(Number.isInteger(a[0]) && a[0] >= 0)) S.errs.push(`scroll_to_item(${a[0]}) at ${where()}`);
  if (k === "set_value") val = String(a[0] ?? "");
  return k === "value" ? val : k === "is_focused" ? false : undefined;
}) }); };
S.vlist = (id, n, sizes, key, render) => {
  S.lists.push({ id, n, render });
  if (n > 10000) S.errs.push(`${id}: ${n} items`);
  if (Array.isArray(sizes)) { if (sizes.length !== n) S.errs.push(`${id}: ${sizes.length} sizes for ${n} items`); sizes.forEach((s, i) => { if (bad(s)) S.errs.push(`${id}: size ${i} = ${s}`); }); }
  for (let i = 0; i < n; i++) if (typeof key(i) !== "string") { S.errs.push(`${id}: key ${i}`); break; }
  return S.el();
};
const STUBS = {
  "gpui-kit": "const S = globalThis.__rv, B = new Proxy({}, { get: () => () => B }); globalThis.window ??= { paint_path: () => S.el() }; export class View {} export const div = S.el, svg = S.el, image = S.el, PathBuilder = { stroke: () => B, fill: () => B }, Background = { pattern_slash: () => B, solid: () => B, checkerboard: () => B };",
  "gpui-base": `const S = globalThis.__rv, f = () => S.el(), n = { new: () => S.handle() };
    export const v_flex = f, h_flex = f, v_virtual_list = S.vlist, Scrollbar = { vertical: f, horizontal: f }, TextView = { markdown: (_id, text) => { S.texts?.add(String(text ?? "")); return S.el(); } };
    export const Input = Object.assign(f, { new: f }), Textarea = Object.assign(() => S.el(), { new: f }), Editor = Object.assign(() => S.el(), { new: f });
    export const HoverCard = { new: f };
    export const VirtualListScrollHandle = n, ScrollHandle = n, TextareaState = n, InputState = n, EditorState = n;`,
  herdr: `const S = globalThis.__rv, no = async () => { throw new Error("stub"); }, never = () => new Promise(() => {});
    export const exec = (...a) => (S.exec ? S.exec(...a) : no()), hc = (...a) => (S.hc ? S.hc(...a) : no()), readTextFile = async (p) => { if (S.files.has(p)) return S.files.get(p); throw new Error("stub"); }, pickFolder = no, writeTextFile = async (p, text, expected) => { if (!S.writes) return; if ((S.files.get(p) ?? null) !== (expected ?? null)) throw new Error("stale"); S.files.set(p, text); }, run = (...a) => { S.runs?.push(a); return null; }; // a test that asks which commands ran sets S.runs = []
    const live = (k, v) => { S.live[k] = (S.live[k] ?? 0) + 1; return v; }; // how often a frame reads Herdr's live data (a mod is drawn again when what it read changes)
    export const spaces = () => live("spaces", S.spaces ?? []), panes = () => live("panes", S.panes ?? []), agents = () => live("agents", []), terminals = () => live("terminals", S.terminals ?? []), focused = () => live("focused", S.focused ?? null), layout = () => live("layout", S.layout === undefined ? { id: "root", type: "row", children: [] } : S.layout); // null: as in a copy's init, before Herdr has a layout
    export const theme = () => S.theme, settings = () => ({}), props = () => S.props ?? { part: "review" };
    export const shared = (k) => S.store.get(k), setShared = (k, v) => S.store.set(k, v), appHome = () => "/h", home = () => "/h", checking = () => Boolean(S.checking);
    export const nextCommand = () => (S.nextCommand ? S.nextCommand() : never()), watchFolder = (dir) => { let end; return Object.assign(new Promise((r) => { end = r; }), { cancel() { (S.cancelled ??= []).push(dir); end([]); } }); }, openOverlay = (o) => { S.overlays.push(o); }, closeOverlay = () => {}, notify = (n) => { (S.toasts ??= []).push(n); return "n"; };`,
};
registerHooks({
  resolve: (spec, ctx, next) => (STUBS[spec] ? { url: `stub:${spec}`, shortCircuit: true } : next(spec, ctx)),
  load: (url, ctx, next) => (url.startsWith("stub:") ? { format: "module", source: STUBS[url.slice(5)], shortCircuit: true } : next(url, ctx)),
});
// The theme as herdr's theme() gives it: exactly the documented role names (gpui-kit.d.ts), here with the colors of
// the atom-one-dark theme file. A name that is not a role reads undefined, and an element given undefined fails.
const ANSI = ["#454c59", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf", "#767676", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf"];
S.theme = Object.freeze({ background: "#21252b", surface: "#282c34", canvas: "#1e2227", chrome: "#21252b", popover: "#2c313a", raised: "#323844", hover: "#2c313c", selected: "#323844",
  border: "#3e4451", input: "#1d2025", foreground: "#abb2bf", muted: "#7f848e", dim: "#5c6370", accent: "#61afef", accent_foreground: "#21252b", solid: "#abb2bf", solid_foreground: "#21252b",
  selection: "#323844", working: "#e5c07b", blocked: "#e06c75", done: "#98c379", idle: "#5c6370", unknown: "#5c6370", ...Object.fromEntries(ANSI.map((c, i) => [`ansi${i}`, c])) });

export const cx = { notify() {}, timer: { after() {}, every() {} }, spawn() {}, focus_handle: () => ({ focus() {}, is_focused: () => false }), stop_propagation() {}, new() {} };
export const ok = (what, f) => { S.errs.length = 0; S.lists.length = 0; try { f(); } catch (e) { S.errs.push(`threw ${e?.stack ?? e}`); } assert.deepEqual(S.errs, [], what); };
