// Two sections of the Security page under its boundary map, both folded to one line until asked for:
// "Where sensitive data goes" (dataflow.js has the model): a chip per kind of data, the chosen one's steps as a list
// and its way lit on the map; "Who may do what" (rights.js): principals × resources as a table, each cell with its
// actions and what the PR does to them. SecPicsMode is mixed into the review (review.js), which gives the page's
// crossings and where a click leads. Nothing here costs money: both read what the security run already wrote.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { chip } from "./stack.js";
import { TYPE, signOf, signEl, signWords, secWho, runLabel } from "./views.js";
import { rightsOf, rightsShown, cellOf, entryText, GUARD, CHANGE, NOT_SAID } from "./rights.js";
import { dataflowOf, wayLine, FLAGS } from "./dataflow.js";

const FLAG_WORD = Object.fromEntries(FLAGS.map(([k, , , at]) => [k, at]));
const plain = (s) => String(s ?? "").replace(/[`*_]/g, "");

export const SecPicsMode = {
  // Both models are kept until their data change (review.js keep): the page asks for them on every frame.
  secDataNow(rows) { const data = this.ai?.secData ?? null, arch = this.ai?.arch ?? null; return this.keep("secData", [data, arch, rows], () => dataflowOf({ data, arch, crossings: rows })); },
  secRightsNow(rows) { const arch = this.ai?.arch ?? null, access = this.ai?.access, open = this.openFindings(); return this.keep("secRights", [arch, access, rows, open], () => rightsOf({ arch, access: access ?? [], crossings: rows, findings: open })); },
  // The kind of data whose steps are shown: the chosen one, else the first with a mark, else the first. Only while
  // the section is open.
  secDataItem(m) { return m && this.secDataOpen ? m.items.find((x) => x.id === this.secDataSel) ?? m.items.find((x) => x.flags.length) ?? m.items[0] ?? null : null; },
  // The cards its way lights on the boundary map (stack.js `keep`): its own, and both ends of every crossing it takes.
  secDataLit(rows) {
    const x = this.secDataItem(this.secDataNow(rows));
    return x ? new Set([...x.path, ...rows.filter((r) => x.crossed.includes(r.key)).flatMap((r) => [r.ends.from ?? secWho(r), r.ends.to])].filter(Boolean)) : null;
  },
  // sec-data (fold or open), sec-data:<item id> (choose one, open); sec-rights (fold or open), sec-rights:all (the
  // folded rows and columns).
  secPicCommand(name, arg) {
    if (name === "sec-data") { if (arg) { this.secDataSel = arg; this.secDataOpen = true; } else this.secDataOpen = !this.secDataOpen; }
    else if (arg === "all") { this.secRightsAll = !this.secRightsAll; this.secRightsOpen = true; } else this.secRightsOpen = !this.secRightsOpen;
  },
  // The page's parts [[name, element]]: "data" and "rights", each only with data. rows: the page's crossings;
  // show(key, cx): that crossing open in the list above; goTo(f): a finding's click.
  secPicParts(t, { rows, show, goTo }) {
    const head = (id, title, n, line, open, tip, cmd) => h_flex().id(id).gap(8).items_center().cursor_pointer().tooltip(open ? "Fold this section" : tip).on_click((_e, cx) => { this.secPicCommand(cmd, ""); cx.notify(); })
      .child(div().text_size(TYPE.title).font_semibold().child(`${title} · ${n}`)).child(div().text_color(t.muted).child(open ? "▾" : "▸")).child(div().flex_1())
      .child(div().min_w(0).text_size(TYPE.small).text_color(t.muted).truncate().child(line));
    const box = (id) => v_flex().id(id).gap(8).p(12).rounded(10).border_1().border_color(t.border).bg(t.surface);
    const note = (text) => div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().line_height(1.5).child(text);
    const link = (id, at) => div().id(id).flex_none().text_color(t.accent).cursor_pointer().hover((x) => x.underline()).on_click((_e, cx) => { this.jumpTo(at, cx); cx.stop_propagation(); }).child(`${at} ↗`);
    const parts = [];

    const d = this.secDataNow(rows);
    if (d) {
      const open = Boolean(this.secDataOpen), sel = this.secDataItem(d);
      const pick = (x) => { const on = x === sel, n = x.flags.length;
        return h_flex().id(`rv-sec-df-${x.id}`).flex_none().gap(6).items_center().px(9).h(26).rounded(6).border_1().border_color(on ? t.accent : t.border).when(x.byName, (e) => e.border_dashed())
          .bg(on ? t.selected : t.background).text_size(TYPE.small).text_color(on ? t.foreground : t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .tooltip(`${x.name}: ${x.kind}${x.byName ? ", read from its name" : ""}. ${n ? `To check: ${x.flags.map((f) => f.text).join("; ")}.` : "Nothing marked on its way."}\nA click shows its steps and lights its way on the map.`)
          .on_click((_e, cx) => { this.secPicCommand("sec-data", x.id); cx.notify(); })
          .child(div().max_w(280).truncate().child(x.name)).child(div().text_color(t.muted).child(x.byName ? `${x.kind}?` : x.kind))
          .when(n > 0, (e) => e.child(div().flex_none().text_color(t.ansi3).child(`⚠ ${n}`))); };
      const step = (x, s) => h_flex().id(`rv-sec-df-s-${x.id}-${s.n}`).gap(8).items_start().text_size(TYPE.small).line_height(1.5)
        .child(div().flex_none().w(18).text_color(t.muted).child(`${s.n}`))
        .child(v_flex().flex_1().min_w(0).gap(2).child(div().whitespace_normal().child(`${s.head}.${s.tail}`))
          .when(s.flags.length > 0 || Boolean(s.at) || Boolean(s.crossKey), (e) => e.child(h_flex().gap(8).items_center().flex_wrap()
            .children(s.flags.map((k) => chip(t, `⚠ ${FLAG_WORD[k]}`, k === "retention" || k === "public" ? t.ansi3 : t.ansi1, false)))
            .when(Boolean(s.crossKey), (y) => y.child(div().id(`rv-sec-df-c-${x.id}-${s.n}`).flex_none().text_color(t.accent).cursor_pointer().hover((z) => z.underline()).on_click((_e, cx) => { show(s.crossKey, cx); cx.stop_propagation(); }).child(`crossing ${s.cross} ↑`)))
            .when(Boolean(s.at), (y) => y.child(link(`rv-sec-df-at-${x.id}-${s.n}`, s.at))))));
      const tier = this.runTier("security").chosen ?? this.runTier("security").tier;
      parts.push(["data", box("rv-sec-data")
        .child(head("rv-sec-data-h", "Where sensitive data goes", d.total, d.line, open, "Each kind of sensitive data: the crossings it takes and where it ends", "sec-data"))
        .when(open, (e) => e.child(note(d.note))
          .when(d.items.length > 0, (y) => y.child(h_flex().gap(6).flex_wrap().children(d.items.map(pick))))
          .when(Boolean(sel), (y) => y.child(div().text_size(TYPE.small).whitespace_normal().line_height(1.5).child(wayLine(sel)))
            .child(v_flex().gap(6).children(sel.steps.map((s) => step(sel, s)))))
          .when(Boolean(d.rerun), (y) => y.child(h_flex().gap(8).items_center().text_size(TYPE.small).child(div().flex_1().min_w(0).text_color(t.muted).whitespace_normal().line_height(1.5).child(d.rerun ?? ""))
            .child(div().id("rv-sec-data-rerun").flex_none().whitespace_nowrap().px(9).h(26).flex().items_center().rounded(6).border_1().border_color(t.border).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
              .on_click((_e, cx) => this.runReviewer("security", cx, null, tier)).child(runLabel(this.find.runs?.security, this.runPrice("security", tier), "", true))))))]);
    }

    const m = this.secRightsNow(rows);
    if (m) {
      const open = Boolean(this.secRightsOpen), v = rightsShown(m, Boolean(this.secRightsAll)), folded = rightsShown(m, false).more;
      const entry = (e) => { const sign = e.findings.length ? signOf(e.findings) : null, moved = e.change !== "unchanged";
        return v_flex().id(`rv-sec-rt-${e.id}`).gap(2).px(4).py(2).rounded(4).cursor_pointer().hover((x) => x.bg(t.hover))
          .tooltip(`${plain(entryText(e))}\n${e.resource}${e.auth ? ` · ${e.auth}` : ""}\n${e.crossKey ? `A click opens crossing ${e.crossing} above, as numbered on the map.` : e.at ? "A click shows its line." : ""}`)
          .on_click((_e, cx) => { if (e.crossKey) show(e.crossKey, cx); else if (e.at) this.jumpTo(e.at, cx); })
          .child(h_flex().gap(6).items_center().flex_wrap()
            .when(e.guard, (x) => x.child(chip(t, GUARD.join(" "), e.loosened ? t.ansi1 : t.ansi2, false)))
            .child(div().flex_none().font_semibold().text_color(e.change === null ? t.ansi3 : moved ? t.accent : t.muted).child(e.mark.join(" ")))
            .when(Boolean(e.crossing), (x) => x.child(div().flex_none().text_color(t.muted).child(`‖${e.crossing}`)))
            .when(Boolean(sign), (x) => x.child(h_flex().id(`rv-sec-rt-f-${e.id}`).flex_none().gap(3).items_center().cursor_pointer().tooltip(`${signWords(e.findings)}\n${e.findings.map((f) => plain(f.title)).join("\n")}`).on_click(goTo(e.findings[0]))
              .child(signEl(div, t, sign, "!")).child(div().text_color(t.muted).child(`${e.findings.length}`)))))
          .children((e.actions.length ? e.actions : [{ text: e.guard ? "access" : "not named", wild: null }]).map((a) => div().whitespace_normal().when(Boolean(a.wild), (x) => x.font_semibold().text_color(a.wild === "all" ? t.ansi1 : t.ansi3)).when(!a.wild && !moved, (x) => x.text_color(t.muted))
            .child(`${e.guard ? "denies " : ""}${a.text}`)))
          .when(e.unused, (x) => x.child(h_flex().child(chip(t, "granted, not used", t.ansi3, false))))
          .when(Boolean(e.holds), (x) => x.child(div().text_color(t.muted).whitespace_normal().child(`Holds against: ${e.holds.replace(/\.$/, "")}.`)))
          .when(e.loosened, (x) => x.child(div().text_color(t.ansi1).child("⚠ This PR loosens it."))); };
      const colHead = (c) => v_flex().child(div().whitespace_normal().text_color(c.wild ? t.ansi1 : t.foreground).child(c.name)).when(c.kinds.length > 0, (e) => e.child(div().font_normal().text_color(t.muted).child(c.kinds.join(", "))));
      const rowHead = (r) => v_flex().child(div().font_semibold().whitespace_normal().child(r.name)).when(Boolean(r.kind), (e) => e.child(div().text_color(t.muted).child(r.kind)));
      // The signs of the cells shown, in a line over the table (as Schema changes has one): only those that occur.
      // Nothing of it while the section is folded.
      const cells = open ? v.rows.map((r) => v.cols.map((c) => cellOf(m, r, c))) : [], shown = cells.flat(2), key = (sign, word, color = t.muted) => h_flex().flex_none().gap(4).child(div().text_color(color).child(sign)).child(div().child(word));
      const legend = [...[...Object.entries(CHANGE), [null, NOT_SAID]].filter(([c]) => shown.some((e) => (c ? e.change === c : e.change === null))).map(([c, [sign, word]]) => key(sign, word, c === null ? t.ansi3 : c === "unchanged" ? t.muted : t.accent)),
        ...(shown.some((e) => e.guard) ? [key(GUARD[0], `${GUARD[1]}: a rule that denies`, t.ansi2)] : []), ...(shown.some((e) => e.crossing) ? [key("‖", "crossing on the map")] : []),
        ...(shown.some((e) => e.findings.length) ? [key("!", "unresolved findings", t.foreground)] : [])];
      parts.push(["rights", box("rv-sec-rights")
        .child(head("rv-sec-rights-h", "Who may do what", m.total, m.line, open, "Principals and resources as a table: the actions each may do and what this PR changes", "sec-rights"))
        .when(open, (e) => e.child(note(m.note))
          .child(h_flex().id("rv-sec-rt-legend").gap(12).flex_wrap().text_size(TYPE.small).text_color(t.muted).tooltip("What the signs in a cell say").children(legend))
          .child(this.table(t, "rv-sec-rt", [["Who", 200], ...v.cols.map((c) => [colHead(c), null])], v.rows.map((r, i) => [rowHead(r), ...cells[i].map((es) => (es.length ? v_flex().gap(4).children(es.map(entry)) : div().text_color(t.dim).child("–")))])))
          .when(folded > 0, (y) => y.child(div().id("rv-sec-rt-all").text_size(TYPE.small).text_color(t.muted).cursor_pointer().hover((x) => x.text_color(t.foreground)).on_click((_e, cx) => { this.secPicCommand("sec-rights", "all"); cx.notify(); })
            .child(this.secRightsAll ? "Show only what this PR changes ▴" : `${v.moreLine} ▸`))))]);
    }
    return parts;
  },
};
