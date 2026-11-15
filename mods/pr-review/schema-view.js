// "Schema changes" as a part of the Architecture page: schema.js has the readers, the data, the words and the layout,
// this file draws them and reads the files. SchemaMode is mixed into the review (review.js): it reads the schema
// files of the patch and, from the checkout, the older migrations of their folders, in the background and only while
// the Architecture page shows. Nothing here costs money or runs anything of the PR: no model, no database.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, appHome, settings } from "herdr";
import { TYPE } from "./views.js";
import { laidOut, sectionTitle } from "./stack.js";
import { SCHEMA_SOURCE, SCHEMA_MARKS, SCHEMA_STATES, schemaFiles, schemaWants, schemaSteps, schemaPicture, schemaMarks, schemaSummary, foldText, unreadText, edgeText } from "./schema.js";

const ROW = 18; // a row of a card, as the layout counts it
const MAX_FILES = 200; // older migrations read from the checkout

/**
 * The section as the page's parts: [["schema", the picture with what it says about itself], ["schema-risks", the risk
 * hints, when a rule holds]]. o: {model: schema.js schemaModel, pic: schema.js schemaPicture (null without cards), canvas(L,
 * decorate, marks): the picture in the page's sideways scroller (review.js archCanvas), onJump(at, cx), hl: the
 * highlighted line's number, onHl(num | null, cx), edit(id, at): the short "open in the editor" link for a place
 * (review.js editAt; [] without an editor or a checkout)}.
 */
export function schemaSection(t, o) {
  const m = o.model, P = o.pic;
  const tone = (state) => (state === "added" ? t.ansi2 : state === "removed" ? t.ansi1 : state ? t.accent : t.muted);
  const warn = (r) => (r.risk?.length ? [div().flex_none().text_color(t.ansi3).child("⚠")] : []);
  // A card's rows (schema.js cardRows): a state's word over its rows, a column with its sign, type and marks, an
  // index, a note. A row with a place leads to its line in the diff; ⚠ marks what a risk rule names (the list below).
  const row = (n, r, k) => {
    const tip = [r.tip ?? r.text, ...(r.risk ?? [])].filter(Boolean).join("\n");
    // A card's first row carries the link to its place in the person's editor (the row's own line, else the card's).
    const ed = k === 0 && o.edit && (r.at ?? n.at) ? o.edit(`rv-schema-ed${n.col}-${n.row}`, r.at ?? n.at) : [];
    const el = h_flex().id(`rv-schema-r${n.col}-${n.row}-${k}`).flex_none().h(ROW).gap(5).items_center().text_size(TYPE.micro).when(Boolean(tip), (e) => e.tooltip(tip))
      .when(Boolean(r.at), (e) => e.cursor_pointer().hover((s) => s.underline()).on_click((_e, cx) => { o.onJump(r.at, cx); cx.stop_propagation(); }));
    if (r.kind === "head") return el.font_semibold().text_color(tone(r.state)).child(div().flex_1().min_w(0).child(`${r.text[0].toUpperCase()}${r.text.slice(1)}`)).children(ed);
    if (r.kind === "note") return el.text_color(t.muted).child(div().flex_1().min_w(0).truncate().child(r.text)).children(warn(r)).children(ed);
    const sign = div().flex_none().w(9).text_color(tone(r.state)).child(r.sign ?? "");
    if (r.kind === "idx") return el.text_color(t.foreground).child(sign).child(div().flex_1().min_w(0).truncate().child(r.text)).children(warn(r)).children(ed);
    return el.text_color(t.foreground).child(sign)
      .child(div().flex_none().max_w(r.text ? 80 : 110).truncate().font_semibold().when(r.state === "removed", (e) => e.line_through()).child(r.name))
      .child(div().flex_1().min_w(0).truncate().text_color(r.text ? t.foreground : t.muted).child(r.text || r.type))
      .when(r.marks.length > 0, (e) => e.child(div().flex_none().text_color(t.muted).child(r.marks.join(" "))))
      .children(warn(r)).children(ed);
  };
  const decorate = (n) => (n.rows?.length ? [v_flex().flex_none().h(n.rows.length * ROW).children(n.rows.map((r, k) => row(n, r, k)))] : []);
  const name = new Map(m.cards.map((c) => [c.id, c.name])), nameOf = (id) => name.get(id) ?? P?.L.nodes.find((n) => n.id === id)?.label ?? id, loose = P ? P.L.paths.filter((p) => !p.text || p.text.cut) : [];
  const edgeOf = (p) => P.arch.edges[p.edges?.[0]] ?? null;
  // A line under the picture: its text leads to its place in the diff; the short editor link stands at its end, in the same row.
  const line = (id, text, at, color = t.muted) => h_flex().flex_1().min_w(0).gap(8).items_start()
    .child(div().id(id).min_w(0).text_size(TYPE.small).line_height(1.5).whitespace_normal().text_color(color)
      .when(Boolean(at), (e) => e.cursor_pointer().hover((s) => s.text_color(t.foreground)).tooltip("Show this place in the diff").on_click((_e, cx) => o.onJump(at, cx))).child(text))
    .children(at && o.edit ? o.edit(`${id}-ed`, at) : []);
  const key = (sign, word, color = t.muted) => h_flex().flex_none().gap(4).child(div().text_color(color).child(sign)).child(div().child(word));
  const risks = m.risks.length ? [["schema-risks", v_flex().id("rv-schema-risks").w_full().gap(2).child(div().text_size(TYPE.small).font_semibold().text_color(t.muted).child(`May be risky for live data · ${m.risks.length}`))
    .child(div().text_size(TYPE.small).text_color(t.muted).child("From fixed rules over the changes above, not from a review."))
    .children(m.risks.map((r, k) => h_flex().gap(8).items_start().child(div().flex_none().text_size(TYPE.small).line_height(1.5).text_color(t.ansi3).child("⚠")).child(line(`rv-schema-risk${k}`, r.text, r.at, t.foreground))))]] : [];
  return [["schema", v_flex().id("rv-schema").w_full().gap(8).pt(6)
    .child(sectionTitle(t, "Schema changes", [m.total && `${m.total} ${m.total === 1 ? "table" : "tables"}`, m.risks.length && `${m.risks.length} ${m.risks.length === 1 ? "risk hint" : "risk hints"}`].filter(Boolean).join(" · ")))
    .child(div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(SCHEMA_SOURCE))
    .when(Boolean(P), (e) => e.child(div().text_size(TYPE.body).text_color(t.muted).whitespace_normal().child(`${schemaSummary(m)}${P.arch.folded ? ` ${foldText(P.arch.folded)}` : ""}`))
      .child(h_flex().id("rv-schema-legend").gap(12).flex_wrap().text_size(TYPE.small).text_color(t.muted).tooltip("A column's state is its sign and the word over its rows; the letters are its marks")
        .children(SCHEMA_STATES.map(([word, sign]) => key(sign, word, tone(word)))).children(SCHEMA_MARKS.map(([k, word]) => key(k, word, t.foreground)))
        .when(m.risks.length > 0, (x) => x.child(key("⚠", "may be risky", t.ansi3))))
      .child(o.canvas(P.L, decorate, P.marks)))
    .when(loose.length > 0, (e) => e.child(v_flex().gap(2).child(div().text_size(TYPE.small).font_semibold().text_color(t.muted).child("Relations without their text in the picture"))
      .children(loose.map((p) => h_flex().id(`rv-schema-ref${p.num}`).gap(8).items_center().px(4).rounded(6).text_size(TYPE.small).text_color(t.muted).when(o.hl === p.num, (x) => x.bg(t.selected)).hover((x) => x.bg(t.hover)).on_hover((on, cx) => o.onHl(on ? p.num : null, cx))
        .child(div().flex_none().w(18).h(18).flex().items_center().justify_center().rounded_full().border_1().border_color(o.hl === p.num ? t.accent : t.muted).text_size(TYPE.micro).text_color(t.foreground).child(String(p.num)))
        .child(div().flex_1().min_w(0).whitespace_normal().line_height(1.4).child(edgeOf(p) && p.from.length === 1 ? edgeText(edgeOf(p), nameOf) : `${p.from.map(nameOf).join(", ")} → ${nameOf(p.to)}${p.label ? `, ${p.label}` : ""}`))))))
    .children(m.notes.map((n, k) => line(`rv-schema-note${k}`, n, null)))
    .children(m.unread.map((u, k) => line(`rv-schema-unread${k}`, unreadText(u), null)))], ...risks];
}

export const SchemaMode = {
  /** The model of the patch shown, or null (nothing found, not read yet, or no diff: Explore). */
  schemaNow() { const st = this.schemaSt; return st && st.patch === this.patch && !this.exMode ? st.model : null; },

  // From render, on the Architecture page: once per patch and checkout, read in slices of its own (Herdr stops a
  // script slice after about 50 ms). While it reads, the page keeps what it had for this patch.
  schemaTick(cx) {
    const patch = this.patch, root = this.worktree?.path ?? null, st = this.schemaSt;
    if (this.exMode || this.tab !== "steps" || this.page !== "arch" || !patch || (st?.patch === patch && st.root === root)) return;
    const same = st?.patch === patch, mine = (this.schemaSt = { patch, root, model: same ? st.model : null, pic: same ? st.pic : null, sig: same ? st.sig : null, open: same ? st.open : null });
    if (schemaFiles(patch).length) cx.timer.after(0, (cx) => cx.spawn((cx) => this.schemaLoad(mine, cx)));
  },
  // Without a checkout: what the patch itself holds (added and deleted files). With one: the changed files at the PR
  // head and the other migrations of their folders, the newest MAX_FILES. Which of them exist is asked through
  // safegit.py (ls-files -s: tracked regular files only, so a link out of the checkout is not followed).
  async schemaLoad(mine, cx) {
    const { patch, root } = mine, files = schemaFiles(patch), want = root ? schemaWants(files) : null;
    let texts = null;
    const r = want?.specs.length ? await exec("python3", [`${appHome()}/mods/pr-review/safegit.py`, root, "ls-files", "-s", "--", ...want.specs], { timeout: 30000 }).catch(() => null) : null;
    if (this.schemaSt !== mine) return;
    if (r?.code === 0) {
      texts = new Map();
      const listed = r.stdout.split("\n").map((l) => /^100\d+ \S+ \d\t(.+)$/.exec(l)?.[1]).filter((p) => p && !p.startsWith('"') && want.keep(p));
      const changed = new Set(files.map((f) => f.path)), newest = listed.sort((a, b) => changed.has(b) - changed.has(a) || b.localeCompare(a, "en", { numeric: true })).slice(0, MAX_FILES);
      for (const p of newest) { const text = await readTextFile(`${root}/${p}`).catch(() => null); if (typeof text === "string") texts.set(p, text); }
      if (this.schemaSt !== mine) return;
    }
    // File by file, with a pause (a timer, so a fresh slice) every 12 ms, as review.js onSource makes the hunks.
    const own = new Set(files.map((f) => f.path)), steps = schemaSteps(files.map((f) => ({ ...f, head: texts?.get(f.path) })), texts ? [...texts].filter(([p]) => !own.has(p)).map(([path, text]) => ({ path, text })) : null);
    let step = steps.next();
    for (let t = Date.now(); !step.done; step = steps.next()) if (Date.now() - t > 12) { await new Promise((ok) => cx.timer.after(0, ok)); t = Date.now(); if (this.schemaSt !== mine) return; }
    mine.model = step.value; mine.pic = mine.open = null; cx.notify();
  },

  /** The Architecture page's parts "schema" and "schema-risks", or none when the diff has no schema change (review.js archPage). */
  schemaParts(t) {
    const m = this.schemaNow(), st = this.schemaSt;
    if (!m) return [];
    // The layout is kept per model and per marks: a frame that changes nothing lays nothing out (openFindings gives
    // the same list while nothing changed). As archL (stack.js laidOut): what a frame can afford now, the better
    // layout after it; a picture too big for the frame comes with the first slice after it (until then the section
    // without its picture, or with the one from before when only the findings changed).
    const fs = this.openFindings();
    if (m.cards.length && (!st.pic || st.open !== fs)) {
      const sig = [...schemaMarks(m, fs).nodes].map(([id, k]) => `${id}:${k.severity}:${k.findings.map((f) => f.id)}`).join("|");
      if (!st.pic || st.sig !== sig) { const pic = schemaPicture(m, fs, false, false); st.pic = laidOut(pic.args, pic, () => this.schemaSt?.pic, { wait: true, before: st.pic?.L ?? null }); st.sig = sig; }
      st.open = fs;
    }
    const o = this.archOpts("schema");
    return schemaSection(t, { model: m, pic: m.cards.length && st.pic?.L ? st.pic : null, onJump: (at, cx) => this.jumpTo(at, cx), edit: (id, at) => this.editAt(t, id, at), hl: o.hl, onHl: o.onHl,
      canvas: (L, decorate, marks) => this.archCanvas(t, L, { ...o, onFocus: null, marks, zoom: settings().zoom || 1 }, { id: "rv-schema-canvas", pic: "rv-schema", wrap: false, decorate, notes: false }) });
  },
};
