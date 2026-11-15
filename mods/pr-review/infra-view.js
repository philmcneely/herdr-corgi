// "Infrastructure changes" as a part of the Architecture page: infra.js has the data, the words and the layout, this
// file draws them. o: {model: infra.js infraModel, pic: infra.js infraPicture (null without cards), canvas(L,
// decorate, marks): the picture in the page's sideways scroller (review.js archCanvas), onJump(at, cx), hl: the
// highlighted line's number, onHl(num | null, cx), edit(id, at): the short "open in the editor" link for a place
// (review.js editAt; [] without an editor or a checkout)}. With many resources (infra.js isDense) there is no picture
// with lines: o.dense is infra.js infraDense, drawn here as cards by file; o.focus / o.hover: the chosen card's id,
// onFocus(id | null, cx), onHover(id | null, cx), onFinding(finding, cx).
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { TYPE, solidOver, readableFade } from "./views.js";
import { sectionTitle, chip, STATUS_COLOR, SEVERITY_COLOR } from "./stack.js";
import { infraSource, infraSummary, noticeText, rowText, unreadText, denseText, denseRefs } from "./infra.js";

const CARD_W = 224; // a card of the list by file: as wide as a card of the pictures, so three or more fit a row
const HINT = "Click a card to see what it refers to and what refers to it; click it again to let it go.";

// Many resources: the cards by file, each file a frame, as many cards in a row as the width holds (the list never
// gets wider than the page). No lines: the chosen card (pointed at, or clicked to keep) is outlined, what it refers
// to carries "→", what refers to it "←", the rest is dimmed, and the strip over the list says the same in words. The
// strip has a fixed height, so pointing at a card moves nothing.
function denseList(t, o, D) {
  const chosen = o.focus ?? o.hover ?? null, R = chosen ? D.refs.get(chosen) : null, to = new Set((R?.to ?? []).map((x) => x.id)), from = new Set((R?.from ?? []).map((x) => x.id));
  const fade = Math.max(0.6, readableFade(t.muted, t.background, 0.6)), said = R ? denseRefs(D, chosen) : HINT;
  const card = (c, g, k) => {
    const id = `rv-infra-d${g}-${k}`, color = t[STATUS_COLOR[c.status] ?? "muted"], live = c.status !== "unchanged", self = c.id === chosen, rel = [to.has(c.id) && "→", from.has(c.id) && "←"].filter(Boolean).join(" ");
    const top = c.mark ? [...c.mark.findings].sort((a, b) => ["critical", "high", "medium", "low"].indexOf(a.severity) - ["critical", "high", "medium", "low"].indexOf(b.severity))[0] : null;
    const el = v_flex().id(id).flex_none().w(CARD_W).px(10).py(7).gap(3).rounded(8).border_1().border_color(self || rel ? t.accent : live ? color : t.border).when(live && !self, (e) => e.border_l(4)).when(self, (e) => e.border_2())
      .bg(self ? solidOver(t.background, t.accent + "1a") : c.status === "added" ? solidOver(t.background, t.ansi2 + "14") : solidOver(t.background, t.surface))
      .cursor_pointer().hover((x) => x.bg(t.hover)).tooltip(`${D.names.get(c.id) ?? c.name}\nA click ${o.focus === c.id ? "lets it go" : "chooses it"}.`)
      // ponytail: no on_hover, as in impact-view: a re-render per pointer move over a card took Herdr down.
      .on_click((_e, cx) => o.onFocus(o.focus === c.id ? null : c.id, cx))
      // The type leads and the name stands under it in the same size: resources of one thing often share a name, and
      // with the name as the title they read as the same card several times.
      .child(h_flex().gap(6).items_center().text_size(TYPE.small)
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(c.type))
        .when(Boolean(rel) && !self, (e) => e.child(div().id(`${id}-rel`).flex_none().font_semibold().text_color(t.accent).tooltip([to.has(c.id) && "The chosen card refers to it.", from.has(c.id) && "It refers to the chosen card."].filter(Boolean).join(" ")).child(rel)))
        .when(c.status !== D.uniform, (e) => e.child(chip(t, c.status === "replaced" ? "MAY BE REPLACED" : c.status.toUpperCase(), color, false))))
      .child(h_flex().gap(6).items_baseline().text_size(TYPE.small)
        .child(div().flex_1().min_w(0).truncate().when(c.status === "removed", (e) => e.line_through()).child(c.name))
        .child(div().id(`${id}-at`).flex_none().whitespace_nowrap().text_size(TYPE.micro).text_color(t.muted).cursor_pointer().hover((x) => x.underline()).tooltip(`Show ${c.at} in the diff`).on_click((_e, cx) => { o.onJump(c.at, cx); cx.stop_propagation(); }).child(`line ${c.line}`)))
      .children(c.lines.map((l, i) => h_flex().id(`${id}-l${i}`).flex_none().gap(4).items_start().text_size(TYPE.micro).line_height(1.35).text_color(l.bad ? t.ansi1 : l.estimate ? t.ansi3 : t.foreground).tooltip(l.text)
        .when(Boolean(l.at), (e) => e.cursor_pointer().hover((x) => x.underline()).on_click((_e, cx) => { o.onJump(l.at, cx); cx.stop_propagation(); }))
        .when(Boolean(l.bad || l.estimate), (e) => e.child(div().flex_none().child(l.bad ? "⚠" : "≈")))
        .child(l.rows > 1 ? div().flex_1().min_w(0).whitespace_normal().child(l.text) : div().flex_1().min_w(0).truncate().child(l.text))))
      .when(Boolean(top), (e) => e.child(h_flex().id(`${id}-f`).gap(5).items_center().text_size(TYPE.micro).cursor_pointer().tooltip(c.mark.findings.map((f) => `${f.severity}: ${f.title}`).join("\n"))
        .on_click((_e, cx) => { o.onFinding(top, cx); cx.stop_propagation(); })
        .child(chip(t, `${top.severity[0].toUpperCase()}${top.severity.slice(1)} · ${c.mark.n}`, t[SEVERITY_COLOR[c.mark.severity] ?? "muted"], true)).child(div().flex_1().min_w(0).truncate().child(top.title))))
      .child(h_flex().h(18).gap(6).items_center().text_size(TYPE.micro).text_color(t.muted)
        .when(c.to + c.from > 0, (e) => e.child(div().id(`${id}-n`).flex_none().tooltip(`It refers to ${c.to} of this PR's resources, ${c.from} refer to it.`).child(`→ ${c.to}  ← ${c.from}`)))
        .child(div().flex_1()).children(o.edit ? o.edit(`${id}-ed`, c.at) : []));
    return chosen && !self && !rel ? el.opacity(fade) : el;
  };
  return v_flex().id("rv-infra-dense").w_full().gap(10)
    .child(div().id("rv-infra-said").w_full().h(38).overflow_hidden().whitespace_normal().text_size(TYPE.small).line_height(1.45).text_color(R ? t.foreground : t.muted).tooltip(said).child(said))
    .children(D.groups.map((G, g) => v_flex().id(`rv-infra-g${g}`).w_full().gap(8).p(12).rounded(10).border_1().border_dashed().border_color(t.border)
      .child(h_flex().gap(8).items_baseline().text_size(TYPE.small)
        .child(h_flex().min_w(0).child(div().min_w(0).truncate().text_color(t.muted).child(G.dir)).child(div().flex_none().font_semibold().child(G.base)))
        .child(div().flex_1()).child(div().flex_none().text_color(t.muted).child(G.kind)))
      .child(div().w_full().whitespace_normal().text_size(TYPE.small).text_color(t.muted).child(G.types.map(([type, n]) => `${n} ${type}`).join(" · ")))
      .child(h_flex().w_full().flex_wrap().items_start().gap(10).children(G.cards.map((c, k) => card(c, g, k))))
      .when(G.more > 0, (e) => e.child(div().text_size(TYPE.small).text_color(t.muted).child(`and ${G.more} more in this file`)))));
}

export function infraSection(t, o) {
  const m = o.model, P = o.pic;
  // A card's lines (infra.js infraArch), 18 px each as the layout counts them: first its place (the file's name and
  // line, never wrapped), then what stands out with a sign (⚠ a reference to something removed, ≈ an estimate) and
  // its changed arguments, each leading to its own line in the diff. The first line carries the link to the place in
  // the person's editor.
  const ed = (n, at = null) => (o.edit && (at ?? n.at) ? o.edit(`rv-infra-ed${n.col}-${n.row}`, at ?? n.at) : []);
  const decorate = (n) => (n.lines?.length ? [v_flex().flex_none().h(n.lines.reduce((k, l) => k + l.rows, 0) * 18).children(n.lines.map((l, k) => h_flex().id(`rv-infra-l${n.col}-${n.row}-${k}`).flex_none().h(l.rows * 18).gap(4).items_start().pt(2).text_size(TYPE.micro).line_height(1.35)
    .text_color(l.bad ? t.ansi1 : l.estimate ? t.ansi3 : l.place ? t.muted : t.foreground).tooltip(l.tip ?? l.text)
    .when(Boolean(l.at), (e) => e.cursor_pointer().hover((s) => s.underline()).on_click((_e, cx) => { o.onJump(l.at, cx); cx.stop_propagation(); }))
    .when(Boolean(l.bad || l.estimate), (e) => e.child(div().flex_none().child(l.bad ? "⚠" : "≈")))
    .child(l.rows > 1 ? div().flex_1().min_w(0).h(l.rows * 18 - 4).overflow_hidden().whitespace_normal().child(l.text) : div().flex_1().min_w(0).truncate().child(l.text))
    .children(k === 0 ? ed(n, l.at) : [])))] : []);
  // The references whose text is not on their line in the picture (a line that fans out, one that runs under the cards).
  const addr = new Map(m.cards.map((c) => [c.id, c.addr])), nameOf = (id) => addr.get(id) ?? P.L.nodes.find((n) => n.id === id)?.label ?? id, loose = P ? P.L.paths.filter((p) => !p.text || p.text.cut) : [];
  const D = o.dense ?? null;
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
    .when(Boolean(D), (e) => e.child(div().text_size(TYPE.body).text_color(t.muted).whitespace_normal().child(`${infraSummary(m)} ${denseText()}`)).child(denseList(t, o, D)))
    .when(Boolean(P), (e) => e.child(div().text_size(TYPE.body).text_color(t.muted).whitespace_normal().child(infraSummary(m))).child(o.canvas(P.L, decorate, P.marks)))
    .when(loose.length > 0, (e) => e.child(v_flex().gap(2).child(div().text_size(TYPE.small).font_semibold().text_color(t.muted).child("References without their text in the picture"))
      .children(loose.map((p) => h_flex().id(`rv-infra-ref${p.num}`).gap(8).items_center().px(4).rounded(6).text_size(TYPE.small).text_color(t.muted).when(o.hl === p.num, (x) => x.bg(t.selected)).hover((x) => x.bg(t.hover)).on_hover((on, cx) => o.onHl(on ? p.num : null, cx))
        .child(div().flex_none().w(18).h(18).flex().items_center().justify_center().rounded_full().border_1().border_color(o.hl === p.num ? t.accent : t.muted).text_size(TYPE.micro).text_color(t.foreground).child(String(p.num)))
        .child(div().flex_1().min_w(0).whitespace_normal().line_height(1.4).child(`${p.from.map(nameOf).join(", ")} → ${nameOf(p.to)}${p.label ? `: ${p.label}` : ""}`))))))
    .when(m.rows.length > 0, (e) => e.child(v_flex().gap(2).child(div().text_size(TYPE.small).font_semibold().text_color(t.muted).child("Variables, outputs and other values"))
      .children(m.rows.map((r, k) => line(`rv-infra-row${k}`, rowText(r), `${r.file}:${r.line}`)))))
    .children(m.unread.map((u, k) => line(`rv-infra-unread${k}`, unreadText(u), null)));
}
