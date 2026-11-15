// The Impact section of the Architecture page (impact.js has the model): the changed functions and their callers as
// a picture drawn by stack.js archView, the lines over it, the marks' legend with counts, and every caller as a list.
// ImpactMode is mixed into the review (review.js): reading the cached result per PR head, asking the language servers
// in the background (for someone else's PR only on a click, as the servers are not started for it otherwise), and the
// section itself. Nothing here costs money: no model is asked.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { readTextFile, writeTextFile, appHome, settings, shared } from "herdr";
import { markRoom, ARCH } from "./arch.js";
import { archView, laidOut, sectionTitle, chip, SEVERITY_COLOR } from "./stack.js";
import { TYPE, solidOver, readableFade } from "./views.js";
import { hash } from "./pr.js";
import { call, supported } from "./defs.js";
import { installHint } from "./setup.js";
import { SETUP_KEY } from "./setup-view.js";
import { computeImpact, impactArch, impactLines, impactMarks, impactRows, fullName, MARKS, MARK_ORDER, SIG, MODEL_V } from "./impact.js";
import { isDense, impactDense, denseWords, denseFile, restText, IMPACT_DENSE } from "./impact.js"; // many callers: a row per changed symbol
import { isInfraFile } from "./infra.js"; // what "Infrastructure changes" reads is not Impact's

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ROW = 18; // a line under a card's text; the layout keeps the lines and the gap before them
const rowsOf = (n) => (n.rows?.length ? (n.rows.length * ROW + 3) / 18 : 0);
const tone = (t, r) => (r.tone === "warn" ? t.ansi3 : r.tone === "strong" ? t.foreground : t.muted);
const button = (id, t, label, tip, click) => div().id(id).flex_none().whitespace_nowrap().px(9).h(26).flex().items_center().rounded(6).border_1().border_color(t.border)
  .text_size(TYPE.small).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(tip).on_click(click).child(label);

/** The cards and calls laid out, with a line per row of a card and the room for a finding's mark. */
export function impactLayout(model, marks) {
  const a = impactArch(model);
  const args = [a, "diff", (n) => rowsOf(n) + (marks.nodes.has(n.id) ? markRoom(marks.nodes.get(n.id), ARCH.W - 20).rows : 0)];
  return laidOut(args, { a }); // what a render can afford now, the better layout after it (stack.js)
}

// A card's rows: its mark as a shape and its words (a caller), or what is known about a changed function. The first
// row carries the short link to the card's place in the person's editor (edit(id, at): review.js editAt, or null).
const decorate = (t, id, edit = null) => (n) => (n.rows?.length ? [v_flex().id(`${id}-rows-${n.id}`).flex_none().h(n.rows.length * ROW).children(n.rows.map((r, k) => h_flex().id(`${id}-row-${n.id}-${k}`).h(ROW).gap(5).items_center()
  .text_size(TYPE.micro).text_color(tone(t, r)).when(r.tone === "strong", (e) => e.font_semibold()).when(Boolean(r.tip), (e) => e.tooltip(r.tip))
  .when(Boolean(r.glyph), (e) => e.child(div().flex_none().w(12).child(r.glyph))).child(div().flex_1().min_w(0).truncate().child(r.text))
  .children(k === 0 && edit && n.at ? edit(`${id}-ed-${n.id}`, n.at) : [])))] : []);

const HINT = "Click a file to see every changed symbol it calls; click it again to let it go.";
const SEVS = ["critical", "high", "medium", "low"];

// Many callers (impact.js impactDense): a row per changed symbol, what stands out first, under it its callers by
// file, the ones not in this PR first. No lines: the chosen file (pointed at, or clicked to keep; o.focus / o.hover,
// a path) is outlined wherever it calls a changed symbol, those symbols' rows are outlined too and the rest is
// dimmed; the strip over the rows says the same in words and has a fixed height, so pointing moves nothing. A place
// is always the file's name with its line in one piece that does not wrap; the whole path is the tooltip.
function denseRows(t, o, D, model) {
  const chosen = o.focus ?? o.hover ?? null, hit = new Set((chosen ? D.files.get(chosen) ?? [] : []).map((x) => x.id)), said = hit.size ? denseFile(D, chosen) : HINT;
  const fade = Math.max(0.6, readableFade(t.muted, t.background, 0.6));
  const place = (id, at, text) => div().id(id).flex_none().whitespace_nowrap().text_color(t.muted).cursor_pointer().hover((x) => x.underline()).tooltip(`Show ${at}`).on_click((_e, cx) => { o.onPlace(at, cx); cx.stop_propagation(); }).child(text);
  // A file that calls the symbol: its name, with the line of its one caller or the number of its callers.
  const file = (id, f, warn) => { const on = f.path === chosen, c = warn ? t.ansi3 : t.foreground;
    return h_flex().id(id).flex_none().gap(5).items_center().px(7).h(22).rounded(6).border_1().border_color(on ? t.accent : warn ? t.ansi3 + "88" : t.border).when(on, (e) => e.bg(solidOver(t.background, t.accent + "1a")))
      .text_size(TYPE.micro).text_color(c).cursor_pointer().hover((x) => x.bg(t.hover))
      .tooltip(`${f.path}\n${f.callers.map((x) => `${x.name}, line ${x.line}`).join("\n")}\nA click ${o.focus === f.path ? "lets the file go" : "chooses the file"}.`)
      // ponytail: no on_hover here. Re-rendering the review on every pointer move over a chip took Herdr down; a click is enough.
      .on_click((_e, cx) => { o.onFocus(o.focus === f.path ? null : f.path, cx); cx.stop_propagation(); })
      .when(warn, (e) => e.child(div().flex_none().child(SIG.glyph)))
      .child(div().whitespace_nowrap().child(f.n === 1 ? `${f.base}:${f.line}` : f.base)).when(f.n > 1, (e) => e.child(div().flex_none().text_color(t.muted).child(`${f.n}`))); };
  const group = (r, k, mark) => { const g = r.groups[mark], warn = Boolean(r.sig), shown = g.files.slice(0, IMPACT_DENSE.files), far = chosen ? g.files.slice(IMPACT_DENSE.files).find((f) => f.path === chosen) : null;
    if (far) shown[shown.length - 1] = far; // the chosen file is in sight in every row it calls, also where it stands behind "and n more"
    return h_flex().gap(10).items_start().text_size(TYPE.small)
      .child(h_flex().flex_none().w(218).h(22).gap(6).items_center().text_color(mark === "outside" ? t.foreground : t.muted).when(mark === "outside", (e) => e.font_semibold())
        .child(div().flex_none().w(12).child(MARKS[mark].glyph)).child(div().whitespace_nowrap().child(`${MARKS[mark].word} · ${g.n}`)))
      .child(h_flex().flex_1().min_w(0).flex_wrap().gap(6).items_center().children(shown.map((f, i) => file(`rv-impact-d${k}-${mark[0]}${i}`, f, warn)))
        .when(g.files.length > IMPACT_DENSE.files, (e) => e.child(div().flex_none().text_size(TYPE.micro).text_color(t.muted).tooltip(g.files.slice(IMPACT_DENSE.files).map((f) => `${f.path}: ${f.n}`).join("\n")).child(`and ${g.files.length - IMPACT_DENSE.files} more ${g.files.length - IMPACT_DENSE.files === 1 ? "file" : "files"}`)))); };
  const row = (r, k) => { const id = `rv-impact-d${k}`, on = hit.has(r.id), top = r.mark ? [...r.mark.findings].sort((a, b) => SEVS.indexOf(a.severity) - SEVS.indexOf(b.severity))[0] : null;
    const el = v_flex().id(id).w_full().gap(6).px(12).py(9).rounded(8).border_1().border_color(on ? t.accent : r.risky ? t.ansi3 + "88" : t.border).when(on, (e) => e.border_2()).when(!on && r.risky > 0, (e) => e.border_l(4)).bg(solidOver(t.background, t.surface)).tooltip(denseWords(r))
      .child(h_flex().gap(10).items_center().text_size(TYPE.small)
        .child(div().id(`${id}-name`).flex_none().max_w(420).truncate().font_semibold().cursor_pointer().hover((x) => x.underline()).tooltip(`Show ${r.at}`).on_click((_e, cx) => { o.onPlace(r.at, cx); cx.stop_propagation(); }).child(r.name))
        .child(place(`${id}-at`, r.at, `${r.base}:${r.line}`))
        .when(Boolean(r.sig), (e) => e.child(chip(t, `${SIG.glyph} signature changed`, t.ansi3, true, `${id}-sig`, r.sig.old ? `Before: ${r.sig.old}\nNow: ${r.sig.now}` : `Now: ${r.sig.now}`)))
        .when(r.risky > 0, (e) => e.child(div().flex_none().whitespace_nowrap().text_color(t.ansi3).child(`${r.risky} ${r.risky === 1 ? "caller keeps" : "callers keep"} the old call`)))
        .when(r.isNew, (e) => e.child(chip(t, "ADDED", t.ansi2, false)))
        .when(Boolean(top), (e) => e.child(h_flex().id(`${id}-f`).flex_1().min_w(0).gap(5).items_center().cursor_pointer().tooltip(r.mark.findings.map((f) => `${f.severity}: ${f.title}`).join("\n")).on_click((_e, cx) => { o.onFinding(top, cx); cx.stop_propagation(); })
          .child(chip(t, `${top.severity[0].toUpperCase()}${top.severity.slice(1)} · ${r.mark.n}`, t[SEVERITY_COLOR[r.mark.severity] ?? "muted"], true)).child(div().flex_1().min_w(0).truncate().text_size(TYPE.micro).child(top.title))))
        .when(!top, (e) => e.child(div().flex_1()))
        .when(r.changed > 0, (e) => e.child(div().flex_none().whitespace_nowrap().text_color(t.muted).child(`${MARKS.changed.glyph} ${r.changed} changed in this PR`)))
        .child(div().flex_none().whitespace_nowrap().text_color(t.muted).child(r.tests ? `${r.tests} ${r.tests === 1 ? "test" : "tests"}` : "no test"))
        .children(o.edit ? o.edit(`${id}-ed`, r.at) : []))
      .children(["outside", "untouched"].filter((m) => r.groups[m].n > 0).map((m) => group(r, k, m)));
    return hit.size && !on ? el.opacity(fade) : el; };
  return v_flex().id("rv-impact-dense").w_full().gap(8)
    .child(div().id("rv-impact-said").w_full().h(38).overflow_hidden().whitespace_normal().text_size(TYPE.small).line_height(1.45).text_color(hit.size ? t.foreground : t.muted).tooltip(hit.size ? `${chosen}\n${said}` : said).child(said))
    .children(D.symbols.map(row))
    .when(D.rest.length > 0, (e) => e.child(v_flex().id("rv-impact-rest").w_full().gap(6).px(12).py(9).rounded(8).border_1().border_dashed().border_color(t.border)
      .child(div().w_full().whitespace_normal().text_size(TYPE.small).text_color(t.muted).child(restText(D, model)))
      .child(h_flex().flex_wrap().gap(6).children(D.rest.map((r, k) => h_flex().id(`rv-impact-r${k}`).flex_none().gap(5).items_center().px(7).h(22).rounded(6).border_1().border_color(t.border).text_size(TYPE.micro).cursor_pointer().hover((x) => x.bg(t.hover))
        .tooltip(`Show ${r.at}`).on_click((_e, cx) => o.onPlace(r.at, cx)).child(div().whitespace_nowrap().child(r.name)).when(r.tests > 0, (x) => x.child(div().flex_none().text_color(t.muted).child(`${r.tests} ${r.tests === 1 ? "test" : "tests"}`))))))));
}

/**
 * The section. st: {state: "ok" | "busy" | "idle" | "error", model, message, done, of} (ImpactMode's); o: {root: the
 * checkout or null, trusted, marks, L: impactLayout's (null with dense: impact.js impactDense, the rows instead of the
 * picture; then focus / hover are the chosen caller file's path, with onFocus(path | null, cx)), open: the list is unfolded, hover, onHover, onFinding,
 * onPlace(at, cx), onRun(cx), onFold(cx), hscroll(id, w, h, el): the review's sideways scroller, edit(id, at): the
 * short "open in the editor" link for a place (review.js editAt; [] without an editor or a checkout)}. Returns the page's
 * parts [[name, element]]: "impact", and "impact-list" (every caller and test, folded) when there are callers; none
 * when there is nothing to say yet.
 */
export function impactSection(t, st, o) {
  const title = (counts) => sectionTitle(t, "Impact", counts);
  const line = (text, c = t.muted) => div().w_full().whitespace_normal().text_size(TYPE.body).text_color(c).child(text);
  const box = (...kids) => [["impact", v_flex().id("rv-impact").w_full().gap(8).pt(6).children(kids.filter(Boolean))]];
  if (!st || st.state === "loading" || st.state === "none") return [];
  if (st.state === "busy") return box(title(), h_flex().gap(8).items_center().text_size(TYPE.body).text_color(t.muted).child(div().child(SPIN[0]).frames(SPIN, 90))
    .child(st.message ?? (st.of ? `Asking the language server for callers: ${st.done + 1} of ${st.of}.` : "Asking the language server for callers.")));
  if (st.state === "error") return box(title(), line(`The callers could not be read: ${st.message}`, t.ansi1),
    h_flex().child(button("rv-impact-run", t, "Try again", "Ask the language server for the callers again", (_e, cx) => o.onRun(cx))));
  if (st.state === "idle") {
    if (!o.root) return box(title(), line("Callers come from a language server that reads the PR's code on this machine. The PR head is not checked out yet."));
    if (o.trusted) return []; // starts by itself with the next frame
    return box(title(), line("Callers come from a language server that reads this PR's code. For someone else's PR it starts only when you ask, and in Restricted Mode."),
      h_flex().child(button("rv-impact-run", t, "Find callers", "Start the language server for this PR's code and ask it who calls the changed functions. No model is asked.", (_e, cx) => o.onRun(cx))));
  }
  const m = st.model, lines = impactLines(m), T = lines.totals, L = o.L?.L ?? null, rows = impactRows(m).filter((r) => r.caller);
  const pic = o.dense ? denseRows(t, o, o.dense, m) : L.nodes.length ? archView(L, t, "rv-impact-pic", (n, _e, cx) => o.onPlace(n.at, cx), decorate(t, "rv-impact", o.edit), { hover: o.hover, onHover: o.onHover, onFinding: o.onFinding, marks: o.marks, zoom: settings().zoom || 1, numbers: false }) : null;
  const key = (mark, n, risky = false) => h_flex().gap(5).items_center().child(div().flex_none().text_color(risky ? t.ansi3 : mark === "outside" ? t.foreground : t.muted).child(risky ? SIG.glyph : MARKS[mark].glyph))
    .child(div().text_color(n ? t.foreground : t.muted).child(`${risky ? SIG.word : MARKS[mark].word}: ${n}`));
  return [...box(title(lines.counts),
    v_flex().gap(2).children(lines.source.map((s) => line(s))),
    line(lines.lead, t.foreground),
    T.callers > 0 && h_flex().id("rv-impact-legend").gap(14).flex_wrap().text_size(TYPE.small).tooltip("What a caller's mark says, and how many callers carry it")
      .children([...MARK_ORDER.map((k) => key(k, T[k])), ...(T.risky ? [key(null, T.risky, true)] : [])]),
    lines.dense && line(lines.dense),
    pic && (o.dense ? pic : o.hscroll("rv-impact-canvas", L.width + 4 + 40, L.height + 4, pic))),
    ...(rows.length > 0 ? [["impact-list", v_flex().id("rv-impact-rows").w_full().gap(4)
      .child(h_flex().id("rv-impact-list").gap(8).items_center().cursor_pointer().text_size(TYPE.body).text_color(t.muted).hover((x) => x.text_color(t.foreground))
        .tooltip(o.open ? "Fold this list" : "Show every caller and test with its place").on_click((_e, cx) => o.onFold(cx)).child(o.open ? "▾" : "▸").child(`Callers and tests as a list · ${rows.length}`))
      .when(Boolean(o.open), (e) => e.child(v_flex().gap(1).children(rows.map((r, k) => h_flex().id(`rv-impact-li-${k}`).gap(8).items_center().px(6).py(3).rounded(6).text_size(TYPE.small).cursor_pointer().hover((x) => x.bg(t.hover))
        .tooltip(r.caller.sites.map((s) => `${s.line}: ${s.text}`).join("\n")).on_click((_e, cx) => o.onPlace(`${r.caller.path}:${r.caller.line}`, cx))
        .child(div().flex_none().w(14).text_color(r.mark === "outside" ? t.foreground : t.muted).child(MARKS[r.mark].glyph))
        .child(div().flex_none().max_w(320).truncate().font_semibold().child(r.name))
        .child(div().flex_none().text_color(t.muted).child("calls"))
        .child(div().flex_none().max_w(260).truncate().child(fullName(r.fn)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.at))
        .child(div().flex_none().text_color(r.words.includes(SIG.word) ? t.ansi3 : t.muted).child(r.words))
        .children(o.edit ? o.edit(`rv-impact-li-${k}`, `${r.caller.path}:${r.caller.line}`) : [])))))]] : [])];
}

export const ImpactMode = {
  // The result belongs to one PR head: pr-data/cache/impact-<url hash>-<head>.json.
  impactKey() { const url = this.prSel?.url, head = this.worktree?.head ?? this.head; return url && head && !this.exMode ? `${hash(url)}-${head}` : null; },
  impactFile(key) { return `${appHome()}/pr-data/cache/impact-${key}.json`; },
  // The infrastructure files of the patch (infra.js decides which), once per patch: {paths: Set, only: the patch has
  // nothing else}. A file outside the patch (a caller) is one by its name alone.
  impactInfra() {
    if (this.impactInfraMemo?.patch !== this.patch) { const paths = new Set((this.patch ?? []).filter(isInfraFile).map((f) => f.path));
      this.impactInfraMemo = { patch: this.patch, paths, only: paths.size > 0 && paths.size === this.patch.length, is: (p) => paths.has(p) || isInfraFile({ path: p }) }; }
    return this.impactInfraMemo;
  },
  /** The model for the head shown, or null (not asked yet, running, failed, or a diff of infrastructure code only). */
  impactNow() { const st = this.impactSt; return st && st.key === this.impactKey() && st.state === "ok" ? st.model : null; },

  // From render, on the Architecture page: read the cached result once per head; none: ask the language servers,
  // by itself for a PR whose code may run them unasked (trustedPr), else on the section's button.
  impactTick(cx) {
    const key = this.impactKey();
    if (!key || this.tab !== "steps" || this.page !== "arch" || !this.hunks) return;
    const st = this.impactSt;
    if (st?.key === key) { if (st.state === "idle" && !st.asked && this.lspRoot() && this.trustedPr()) { st.asked = true; cx.timer.after(0, (cx) => this.impactRun(cx)); } return; }
    // Only infrastructure code: no section and no language server ("Infrastructure changes" has it).
    if (this.impactInfra().only) { this.impactSt = { key, state: "none" }; return; }
    const mine = (this.impactSt = { key, state: "loading" });
    cx.spawn(async (cx) => {
      const saved = JSON.parse(await readTextFile(this.impactFile(key)).catch(() => null) ?? "null");
      if (this.impactSt !== mine) return;
      if (saved?.v === MODEL_V) { mine.state = "ok"; mine.model = saved; } else mine.state = "idle";
      cx.notify();
    });
  },

  // Asks the bridge (impact.js computeImpact: awaits between requests, so the window stays free) and keeps the result.
  // A language server that is still loading its index answers "starting": asked again every 2 s, for 2 minutes.
  impactRun(cx, tries = 0) {
    const key = this.impactKey(), root = this.lspRoot();
    if (!key || !root || !this.hunks || this.impactInfra().only || (this.impactSt?.key === key && this.impactSt.state === "busy" && !tries)) return;
    const st = (this.impactSt = { key, state: "busy", done: 0, of: 0, message: tries ? this.impactSt?.message : null });
    cx.spawn(async (cx) => {
      const r = await computeImpact({ call, root, hunks: this.hunks, supported, infra: this.impactInfra().is, onStep: (done, of) => { st.done = done; st.of = of; st.message = null; cx.notify(); } })
        .catch((e) => ({ status: "error", message: String(e?.message ?? e) }));
      if (this.impactSt !== st) return;
      if (r.status === "starting" && tries < 60) { st.message = r.message; cx.notify(); return cx.timer.after(2000, (cx) => { if (this.impactSt === st) this.impactRun(cx, tries + 1); }); }
      // A language server that is not installed: the message says how to get it (setup.js, the same list as Setup).
      const hint = (m) => installHint(m, shared(SETUP_KEY)?.os);
      if (r.status !== "ok") { st.state = "error"; st.message = hint(r.message || "the language server did not answer"); return cx.notify(); }
      st.state = "ok"; st.model = { ...r.model, failed: (r.model.failed ?? []).map(hint), head: this.worktree?.head ?? this.head ?? null, at: new Date().toISOString() };
      // Over what is there (a model of an older version, a run before this one): writeTextFile replaces a file only
      // when told its text; told nothing, it writes a new file and leaves an existing one as it is.
      { const file = this.impactFile(key); readTextFile(file).catch(() => null).then((before) => writeTextFile(file, JSON.stringify(st.model), before)).catch(() => null); }
      cx.notify();
    });
    cx.notify();
  },

  // The section's clicks as commands: "impact" its button (Find callers, Try again), "impact:list" the list's fold,
  // "impact:file:<path>" a caller file of the rows chosen,
  // "impact:<path>:<line>" a card or a row.
  impactCommand(arg, cx) {
    if (!arg) this.impactRun(cx);
    else if (arg === "list") this.fold.impactList = !this.fold.impactList;
    else if (arg.startsWith("file:")) this.impactFocus = arg.slice(5) || null; // the rows of many callers: a caller file chosen by its path ("impact:file:": none)
    else this.impactGo(arg, cx);
  },

  // A card's or a row's click: its place, in the diff when the line is there, else the file in the read-only view.
  impactGo(at, cx) { const m = /^(.*):(\d+)$/.exec(String(at ?? "")); if (m) this.goDef({ path: m[1], line: Number(m[2]), inRoot: true }, cx); },

  /** The Architecture page's parts: [["impact", element], ["impact-list", element]] or fewer (review.js archPage). */
  impactParts(t) {
    const st = this.impactSt?.key === this.impactKey() ? this.impactSt : null;
    if (!st || !this.prSel) return [];
    let marks = null, L = null;
    if (st.state === "ok") {
      marks = impactMarks(st.model, this.openFindings());
      const memo = `${[...marks.nodes].map(([id, m]) => `${id}:${m.n}:${m.findings[0]?.id}`)}`;
      // Many callers (impact.js isDense): rows, nothing laid out. Kept per findings like the picture.
      if (st.memo !== memo) { st.memo = memo; const dense = isDense(st.model); st.dense = dense ? impactDense(st.model, this.openFindings()) : null; st.L = dense ? null : impactLayout(st.model, marks); if (!st.dense?.files.has(this.impactFocus)) this.impactFocus = null; }
      L = st.L;
    }
    const o = this.archOpts("impact");
    return impactSection(t, st, { root: this.lspRoot(), trusted: this.trustedPr(), marks, L, dense: st.dense ?? null, focus: st.dense ? o.focus : null, onFocus: o.onFocus, open: Boolean(this.fold.impactList), hover: o.hover, onHover: o.onHover, onFinding: o.onFinding,
      onPlace: (at, cx) => this.impactGo(at, cx), onRun: (cx) => this.impactRun(cx), onFold: (cx) => { this.fold.impactList = !this.fold.impactList; cx.notify(); },
      hscroll: (id, w, h, pic) => this.hscroll(id, w, h, pic, t), edit: (id, at) => this.editAt(t, id, at) });
  },
};
