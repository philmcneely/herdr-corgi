// "Infrastructure changes" as a part of the Architecture page: infra.js has the data, the words and the layout, this
// file draws them. o: {model: infra.js infraModel, pic: infra.js infraPicture (null without cards), canvas(L,
// decorate, marks): the picture in the page's sideways scroller (review.js archCanvas), onJump(at, cx), hl: the
// highlighted line's number, onHl(num | null, cx), edit(id, at): the short "open in the editor" link for a place
// (review.js editAt; [] without an editor or a checkout)}.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { TYPE } from "./views.js";
import { sectionTitle } from "./stack.js";
import { infraSource, infraSummary, noticeText, rowText, foldText, unreadText } from "./infra.js";

export function infraSection(t, o) {
  const m = o.model, P = o.pic;
  // A card's lines (infra.js cardLines), 18 px each as the layout counts them: what stands out with a sign (⚠ a
  // reference to something removed, ≈ an estimate), a changed argument leads to its own line in the diff. The first
  // line carries the link to the resource's place in the person's editor (the line's own, else the card's); a card
  // without lines has it in its free lower left corner, which takes no row of the layout.
  const ed = (n, at = null) => (o.edit && (at ?? n.at) ? o.edit(`rv-infra-ed${n.col}-${n.row}`, at ?? n.at) : []);
  const decorate = (n) => (n.lines?.length ? [v_flex().flex_none().h(n.lines.reduce((k, l) => k + l.rows, 0) * 18).children(n.lines.map((l, k) => h_flex().id(`rv-infra-l${n.col}-${n.row}-${k}`).flex_none().h(l.rows * 18).gap(4).items_start().pt(2).text_size(TYPE.micro).line_height(1.35)
    .text_color(l.bad ? t.ansi1 : l.estimate ? t.ansi3 : t.foreground).tooltip(l.text)
    .when(Boolean(l.at), (e) => e.cursor_pointer().hover((s) => s.underline()).on_click((_e, cx) => { o.onJump(l.at, cx); cx.stop_propagation(); }))
    .when(Boolean(l.bad || l.estimate), (e) => e.child(div().flex_none().child(l.bad ? "⚠" : "≈")))
    .child(l.rows > 1 ? div().flex_1().min_w(0).h(l.rows * 18 - 4).overflow_hidden().whitespace_normal().child(l.text) : div().flex_1().min_w(0).truncate().child(l.text))
    .children(k === 0 ? ed(n, l.at) : [])))] : ed(n).map((e) => div().absolute().left(0).bottom(6).child(e)));
  // The references whose text is not on their line in the picture (a line that fans out, one that runs under the cards).
  const addr = new Map(m.cards.map((c) => [c.id, c.addr])), nameOf = (id) => addr.get(id) ?? P.L.nodes.find((n) => n.id === id)?.label ?? id, loose = P ? P.L.paths.filter((p) => !p.text || p.text.cut) : [];
  // A line under the picture: its text leads to its place in the diff; the short editor link stands at its end, in the same row.
  const line = (id, text, at, color = t.muted) => h_flex().flex_1().min_w(0).gap(8).items_start()
    .child(div().id(id).min_w(0).text_size(TYPE.small).line_height(1.5).whitespace_normal().text_color(color)
      .when(Boolean(at), (e) => e.cursor_pointer().hover((s) => s.text_color(t.foreground)).tooltip("Show this place in the diff").on_click((_e, cx) => o.onJump(at, cx))).child(text))
    .children(at && o.edit ? o.edit(`${id}-ed`, at) : []);
  // The title counts what the section lists, each under its own name: the sentence over the picture counts the
  // resources alone, so one number for all three would not match it.
  const count = (k, one) => (k ? `${k} ${one}${k === 1 ? "" : "s"}` : null);
  const counts = [count(m.cards.filter((c) => c.status !== "unchanged").length, "resource"), count(m.rows.length, "value"), count(m.notices.length, "notice")].filter(Boolean).join(" · ");
  return v_flex().w_full().gap(8).pt(6)
    .child(sectionTitle(t, "Infrastructure changes", counts))
    .child(div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(infraSource(m)))
    // A changed backend, provider or Transform stands above the picture: it changes where or how everything below runs.
    .children(m.notices.map((n, k) => h_flex().gap(8).items_start().child(div().flex_none().text_size(TYPE.small).line_height(1.5).text_color(t.ansi3).child("⚠")).child(line(`rv-infra-note${k}`, noticeText(n), `${n.file}:${n.line}`, t.foreground))))
    .when(Boolean(P), (e) => e.child(div().text_size(TYPE.body).text_color(t.muted).whitespace_normal().child(`${infraSummary(m)}${P.arch.folded ? ` ${foldText(P.arch.folded)}` : ""}`)).child(o.canvas(P.L, decorate, P.marks)))
    .when(loose.length > 0, (e) => e.child(v_flex().gap(2).child(div().text_size(TYPE.small).font_semibold().text_color(t.muted).child("References without their text in the picture"))
      .children(loose.map((p) => h_flex().id(`rv-infra-ref${p.num}`).gap(8).items_center().px(4).rounded(6).text_size(TYPE.small).text_color(t.muted).when(o.hl === p.num, (x) => x.bg(t.selected)).hover((x) => x.bg(t.hover)).on_hover((on, cx) => o.onHl(on ? p.num : null, cx))
        .child(div().flex_none().w(18).h(18).flex().items_center().justify_center().rounded_full().border_1().border_color(o.hl === p.num ? t.accent : t.muted).text_size(TYPE.micro).text_color(t.foreground).child(String(p.num)))
        .child(div().flex_1().min_w(0).whitespace_normal().line_height(1.4).child(`${p.from.map(nameOf).join(", ")} → ${nameOf(p.to)}${p.label ? `: ${p.label}` : ""}`))))))
    .when(m.rows.length > 0, (e) => e.child(v_flex().gap(2).child(div().text_size(TYPE.small).font_semibold().text_color(t.muted).child("Variables, outputs and other values"))
      .children(m.rows.map((r, k) => line(`rv-infra-row${k}`, rowText(r), `${r.file}:${r.line}`)))))
    .children(m.unread.map((u, k) => line(`rv-infra-unread${k}`, unreadText(u), null)));
}
