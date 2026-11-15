// The review layout's "change stack" pieces drawn natively (no libraries): the architecture picture, a layer's
// picture (flow, sequence, state machine, steps), stat cards, segmented bars, collapsible cards, the PR triage card.
// Pure layout lives in arch.js (archLayout) and pr.js (levels); these only draw. UI text is English.
import { div, PathBuilder, Background } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { levels } from "./pr.js";
import { markLine } from "./arch.js";
import { archLayout, archFocus, stateLayout, transitionText, sourceStyle, hasSources, pathMark, SPEC_TIP, ARCH, LABEL } from "./arch.js";
import { clampText, MARK_CARD_H } from "./arch.js"; // wave C2: a mark's finding in two lines
import { flowArch, seqLayout, wrapCount, SEQ, solidOver } from "./views.js";
import { readableFade } from "./views.js"; // wave R2: dimmed text stays readable

export const STATUS_COLOR = { new: "ansi2", added: "ansi2", changed: "accent", unchanged: "muted", removed: "ansi1" };
export const SEVERITY_COLOR = { critical: "ansi1", high: "ansi1", medium: "ansi3", low: "ansi4", minimal: "ansi2" };
const GLYPH = { external: "⇢", component: "◧", data: "⛁", service: "⚙", "api·service": "⇄", api: "⇄", context: "</>", queue: "☰", job: "⏱", ui: "▣" };

// A small "spec" tag: the element is only in the PR description/ticket, not found in the diff.
export const specTag = (t, id) => div().id(id).flex_none().px(4).rounded(4).border_1().border_dashed().border_color(t.ansi5).text_size(10).text_color(t.ansi5).tooltip(SPEC_TIP).child("spec");

// The sources legend: Implemented (solid) · Existing (grey) · Spec only (dashed).
export const sourceLegend = (t) => h_flex().gap(10).text_size(11.5).text_color(t.muted).children([["Implemented", t.accent, false], ["Existing", t.muted, false], ["Spec only", t.ansi5, true]]
  .map(([label, c, dashed]) => h_flex().gap(4).items_center().child(div().w(16).h(0).border_t(2).border_color(c).when(dashed, (e) => e.border_dashed())).child(label)));

// id + tip (optional): a hover explanation; the id must be unique on the page.
// A state, not a button: tinted (solid: stronger), without the frame that buttons have.
export const chip = (t, label, color, solid = false, id = null, tip = null) => div().flex_none().px(6).py(1).rounded(5).bg(color + (solid ? "33" : "1a"))
  .when(Boolean(id && tip), (e) => e.id(id).tooltip(tip)).text_size(11).font_semibold().text_color(color).child(label);

// What a triage chip (pr.js triageOf) means, for its tooltip.
const TRIAGE_TIP = { "High security risk": "Unresolved high-severity security findings, or a high merge risk", "Security risk": "Unresolved security findings on this PR",
  "Deep review": "Size or risk suggests reading this closely", "Quick look": "Small and low risk: a quick look should do",
  "Low effort": "Estimated review effort: low", "Medium effort": "Estimated review effort: medium", "High effort": "Estimated review effort: high" };
export const triageTip = (c) => TRIAGE_TIP[c] ?? "Kind of change, from the PR title prefix";
export const PRIORITY_TIP = "Review priority: P1 is the most urgent, P3 the least";

// A bar of segments [{weight, color}] in one row.
export const segBar = (t, parts, h = 6) => h_flex().w_full().h(h).gap(2).children(parts.filter((p) => p.weight > 0)
  .map((p) => div().flex_grow(p.weight).flex_basis(0).h_full().rounded(3).bg(p.color)))
  .when(!parts.some((p) => p.weight > 0), (e) => e.child(div().w_full().h_full().rounded(3).bg(t.raised)));

// A card with a header that folds it; open/toggle come from the view.
export function foldCard(t, id, title, right, open, toggle, body) {
  return v_flex().id(id).flex_none().rounded(10).border_1().border_color(t.border).bg(t.surface)
    .child(h_flex().id(`${id}-h`).px(12).py(10).gap(8).items_center().cursor_pointer().on_click(toggle)
      .tooltip(open ? "Collapse this section" : "Expand this section").accessibility_label(`${open ? "Collapse" : "Expand"} ${title}`)
      .child(div().w(12).text_color(t.muted).child(open ? "▾" : "▸"))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(14).child(title))
      .children(right ?? []))
    .when(open, (e) => e.child(v_flex().px(14).pb(12).gap(8).child(body())));
}

// The whole PR's architecture (or a layer's flow) at arch.js's positions: dashed group frames, node cards with glyph,
// title (2 lines), description (3 lines; the whole text as tooltip), states (an orchestrator's lane) and status;
// each path on its own lane with an arrow, a hop where it crosses another, and its numbered badge; a stub with its
// chip naming the target. A path with `text` (arch.js, the Architecture page) has its label next to its number; the
// others are listed in archLegend.
// onNode(node, event, cx) opens a card's place (its "Show in diff ↗" link, for cards with at or file); decorate(node) adds lines
// to a card (findings); opts {hl: path num to highlight, onHl(num | null, cx), focus: node id, hover: node id,
// onFocus(id | null, cx), onHover(id | null, cx), marks: arch.js archMarks, zoom, keep: a Set of node ids (with
// nothing focused or hovered, the other cards and the lines not between two of them are dimmed: the Security page's
// view), numbers: false (no number on a line unless it carries a mark)}. A focused node (clicked) keeps its paths
// and neighbours and dims the other lines to 25% (a hovered one to 55%); the other cards only to 60%, so their names
// stay readable. Clicking a chip focuses its target. marks: where unresolved findings sit. A card shows the highest
// severity with the count and the finding (its title cut short, "and n more"; whether it breaks the flow is in the tooltip; the layout keeps a row:
// extra); a call shows the same above its text, or as the colour of its number when it has no text on the line.
export function archView(L, t, id, onNode, decorate, opts = {}) {
  const kept = opts.keep ? { nodes: opts.keep, paths: new Set(L.paths.filter((p) => opts.keep.has(p.to) && p.from.some((f) => opts.keep.has(f))).map((p) => p.num)) } : null;
  const Fc = archFocus(L, opts.focus), Fh = Fc ? null : archFocus(L, opts.hover), F = Fc ?? Fh ?? kept, fade = Fh ? 0.55 : 0.25;
  const hlP = L.paths.find((p) => p.num === opts.hl), hlNodes = new Set(hlP ? [...hlP.from, hlP.to] : []);
  const dimP = (p) => Boolean(F) && !F.paths.has(p.num), dimN = (n) => Boolean(F) && !F.nodes.has(n.id);
  // A spec-only call in the legend's colour for it ("Spec only").
  const color = (p) => (opts.hl === p.num ? t.accent : p.source === "spec" ? t.ansi5 : sourceStyle(p.source).tone === "muted" ? t.muted : p.status === "new" || p.status === "changed" ? t.accent : t.muted);
  const marks = opts.marks, sevOf = (m) => t[SEVERITY_COLOR[m.severity]] ?? t.muted;
  const markChip = (m, cid) => chip(t, `${cap(m.severity)} · ${m.n}`, sevOf(m), true, cid, markTip(m));
  // A mark's row: the chip and the finding it is about (arch.js markLine); a click opens that finding (opts.onFinding).
  // stacked: the finding on a line of its own under the chip (above a call's text, where the row is narrow).
  // Wave C2 V1: the finding in up to two lines, cut at a word (arch.js clampText); w: the room for its text in px.
  const markRow = (m, cid, h, stacked = false, w = 160) => { const ml = markLine(m, 40), text = clampText(ml.text, Math.max(8, Math.floor(w / 6)), 2).text;
    return (stacked ? v_flex().items_start() : h_flex().items_start()).id(`${cid}-r`).flex_none().h(h).gap(stacked ? 1 : 4).tooltip(markTip(m))
    .when(Boolean(opts.onFinding && ml.top), (e) => e.cursor_pointer().on_click((_e, cx) => { opts.onFinding(ml.top, cx); cx.stop_propagation(); }))
    .child(markChip(m, cid)).child(div().when(!stacked, (e) => e.flex_1()).when(stacked, (e) => e.flex_none()).w_full().min_w(0).h(28).overflow_hidden().whitespace_normal().line_height(1.3).text_size(10.5).text_color(t.foreground).child(text)); };
  // opts.zoom (the person's zoom): a line is at least one device pixel wide, or it is not drawn when zoomed far out.
  const thin = Math.max(1.5, 1 / (opts.zoom || 1)), W = (p) => (opts.hl === p.num ? thin + 1 : thin);
  const dim = (el, on, by = fade) => (on ? el.opacity(by) : el);
  // Dimmed text (a call's text, its number, a chip, a card) stays at 4.5:1 against the background; lines go to `fade`.
  // L.label: the text's size from the layout (the Resilience map's is larger).
  const textFade = readableFade(t.foreground, t.background, fade), LB = L.label ?? { ...LABEL, px: 10.5 };
  // A dimmed card's second colour (its description, a call's text in grey) stays at 4.5:1 too (wave C2 V5).
  const cardFade = Math.max(0.6, readableFade(t.muted, t.background, 0.6));
  // A call's own tooltip (tip: the Security picture's, what the check is and holds on) says more than its label again.
  const tipOf = (p) => [p.tip ?? p.label, sourceStyle(p.source).tip, p.evidence].filter(Boolean).join("\n");
  const hop = ARCH.HOP, els = [];
  // Dimmed paths first, the highlighted one last (fans share their trunk: the brightest copy ends on top).
  const order = L.paths.map((p, i) => [p, i]).sort(([a], [b]) => (opts.hl === a.num) - (opts.hl === b.num) || dimP(b) - dimP(a));
  for (const [p, i] of order) {
    const c = color(p), w = W(p), faded = dimP(p), mine = (h) => h.h.p === p.key || h.h.p === p.trunk;
    p.segments.forEach((s, k) => {
      if (s.y1 === s.y2) {
        const x1 = Math.min(s.x1, s.x2), x2 = Math.max(s.x1, s.x2);
        const hx = [...new Set(L.hops.filter((h) => mine(h) && h.y === s.y1 && h.x > x1 && h.x < x2).map((h) => h.x))].sort((a, b) => a - b);
        let from = x1;
        [...hx, null].forEach((x, j) => {
          const to = x === null ? x2 : x - hop / 2;
          if (to > from) { const seg = div().id(`${id}-e${i}-${k}-${j}`).absolute().left(from).top(s.y1).w(to - from).h(0).border_t(w).border_color(c); els.push(dim(p.dashed ? seg.border_dashed() : seg, faded)); }
          if (x !== null) {
            els.push(dim(div().id(`${id}-h${i}-${k}-${j}`).absolute().left(x - hop / 2).top(s.y1 - hop / 2).w(hop).h(hop / 2).overflow_hidden()
              .child(div().w(hop).h(hop).rounded_full().border_t(w).border_l(w).border_r(w).border_color(c)), faded));
            from = x + hop / 2;
          }
        });
      } else {
        const seg = div().id(`${id}-e${i}-${k}`).absolute().left(s.x1).top(Math.min(s.y1, s.y2)).w(0).h(Math.abs(s.y2 - s.y1)).border_l(w).border_color(c);
        els.push(dim(p.dashed ? seg.border_dashed() : seg, faded));
      }
    });
    els.push(dim(div().id(`${id}-a${i}`).absolute().left(p.arrow.left ? p.arrow.x : p.arrow.x - 9).top(p.arrow.y - 8).text_size(11).text_color(c).child(p.arrow.left ? "◀" : "▶"), faded));
  }
  // A marked call without its text on the line: its number in the severity's colour (the legend row has the count).
  const bare = (p) => (p.text?.mark ? null : pathMark(marks, p));
  const badges = L.paths.flatMap((p, i) => (p.badge && (opts.numbers !== false || bare(p)) ? [dim(div().id(`${id}-b${i}`).absolute().left(p.badge.x - ARCH.BADGE / 2).top(p.badge.y - ARCH.BADGE / 2).w(ARCH.BADGE).h(ARCH.BADGE)
    .flex().items_center().justify_center().rounded_full().border_1().border_color(bare(p) ? sevOf(bare(p)) : color(p)).bg(opts.hl === p.num ? t.accent + "33" : bare(p) ? sevOf(bare(p)) + "26" : t.background)
    .text_size(11).text_color(t.foreground).tooltip([tipOf(p), bare(p) && markTip(bare(p))].filter(Boolean).join("\n")).child(String(p.num))
    .when(Boolean(opts.onHl), (e) => e.on_hover((on, cx) => opts.onHl(on ? p.num : null, cx)))
    .when(Boolean(p.evidence && opts.onJump), (e) => e.cursor_pointer().on_click((_e, cx) => { opts.onJump(p.evidence, cx); cx.stop_propagation(); })), dimP(p), textFade)] : []));
  // A call's text on its line, next to its number; a mark above it. Hover lights the call, a click opens its place.
  const texts = L.paths.flatMap((p, i) => (p.text ? [dim(v_flex().id(`${id}-t${i}`).absolute().left(p.text.x).top(p.text.y).w(p.text.w).h(p.text.h).px(3).py(2).rounded(4).bg(t.background).overflow_hidden()
    .text_size(LB.px).text_color(t.foreground).tooltip(tipOf(p))
    .when(Boolean(opts.onHl), (e) => e.on_hover((on, cx) => opts.onHl(on ? p.num : null, cx)))
    .when(Boolean(p.evidence && opts.onJump), (e) => e.cursor_pointer().on_click((_e, cx) => { opts.onJump(p.evidence, cx); cx.stop_propagation(); }))
    .when(Boolean(p.text.mark && pathMark(marks, p)), (e) => e.child(markRow(pathMark(marks, p), `${id}-tm${i}`, LABEL.MARK, true, p.text.w - 6)))
    .children(p.text.lines.map((l) => div().flex_none().h(LB.LH).line_height(LB.LH / LB.px).whitespace_nowrap().child(l))), dimP(p), textFade)] : []));
  const chips = L.paths.flatMap((p, i) => (p.chip ? [dim(div().id(`${id}-c${i}`).absolute().left(p.chip.x).top(p.chip.y).w(p.chip.w).h(p.chip.h).px(5)
    .flex().items_center().gap(6).rounded(6).border_1().border_color(bare(p) ? sevOf(bare(p)) : color(p)).when(p.dashed, (e) => e.border_dashed()).bg(opts.hl === p.num ? t.accent + "33" : t.background)
    .text_size(12).text_color(t.foreground).tooltip(`Call ${p.num}: ${tipOf(p)}\nNot drawn as a line, because it would skip a column or point back: the target is elsewhere in the picture. Hover to light it up, click to focus it.`)
    .child(div().w(ARCH.BADGE - 2).h(ARCH.BADGE - 2).flex_none().flex().items_center().justify_center().rounded_full().border_1().border_color(color(p)).text_size(10.5).child(String(p.num)))
    .child(div().min_w(0).truncate().child(p.chip.text))
    .when(Boolean(opts.onHl), (e) => e.on_hover((on, cx) => opts.onHl(on ? p.num : null, cx)))
    .when(Boolean(opts.onFocus), (e) => e.cursor_pointer().on_click((_e, cx) => { opts.onFocus(p.to, cx); cx.stop_propagation(); })), dimP(p), textFade)] : []));
  // A frame: a group, or a trust zone (arch.js zoneArch: the colour of its trust level, a light tint, the level's word
  // in the header). A bare group (cards outside every zone) has no frame.
  const groups = L.groups.flatMap((g, i) => (g.bare ? [] : [div().id(`${id}-g${i}`).absolute().left(g.x).top(g.y).w(g.w).h(g.h).rounded(12).border_1().border_dashed()
    // Opaque: the grid stays in the space between systems, never behind a frame's cards and call labels.
    .border_color(g.trust ? trustColor(t, g.trust) : t.border).bg(g.trust ? solidOver(t.background, trustColor(t, g.trust) + "0f") : t.background).child(h_flex().px(PAD_IN).h(26).items_center().gap(6).text_size(11.5)
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(g.label ?? ""))
      .child(div().flex_none().text_color(g.trust ? trustColor(t, g.trust) : t.muted).child(g.kind ?? "")))]));
  // A call over a trust boundary: two bars across its line, before the arrow; the tooltip names both zones (opts.zones).
  const zoneById = new Map((opts.zones ?? []).map((z) => [z.id, z])), zoneOfN = (nid) => zoneById.get(L.nodes.find((x) => x.id === nid)?.zone);
  const zoneName = (z) => (z ? `${z.name ?? z.id} (${z.trust})` : "an unnamed zone");
  // A call in one process that bypasses a boundary: no "‖", a "⤳" in the same place.
  const bypasses = L.paths.flatMap((p, i) => (p.bypass && !p.crosses ? [dim(div().id(`${id}-y${i}`).absolute().left(p.arrow.x - 26).top(p.arrow.y - 10).w(16).h(18).flex().items_center().justify_center()
    .text_size(13).text_color(t.ansi3).tooltip("Bypasses the boundary: a call in the same process into code written for another way in, so it gets this caller's input without that way's check").child("⤳"), dimP(p))] : []));
  const crossings = L.paths.flatMap((p, i) => (p.crosses ? [dim(div().id(`${id}-x${i}`).absolute().left(p.arrow.x - 24).top(p.arrow.y - 9).w(12).h(18).flex().items_center().justify_center()
    .text_size(13).font_semibold().text_color(t.ansi3).tooltip(zoneById.size ? `Crosses a trust boundary: from ${zoneName(zoneOfN(p.from[0]))} to ${zoneName(zoneOfN(p.to))}` : `Crosses a trust boundary${typeof p.crosses === "string" ? `: ${p.crosses}` : ""}`).child("‖"), dimP(p))] : []));
  const nodes = L.nodes.map((n, i) => {
    const st = sourceStyle(n.source), c = st.tone === "muted" ? t.muted : t[STATUS_COLOR[n.status] ?? "muted"];
    const live = st.tone !== "muted" && n.status && n.status !== "unchanged", lit = hlNodes.has(n.id) || opts.focus === n.id;
    const open = Boolean(onNode && (n.at || n.file || n.evidence)), tip = [n.cut ? `${n.label ?? n.id}\n\n${n.description ?? ""}` : "", st.tip, n.evidence].filter(Boolean).join("\n\n");
    // A caller from outside (type external) is a dashed capsule.
    const ext = n.type === "external";
    return dim(v_flex().id(`${id}-n${i}`).absolute().left(n.x).top(n.y).w(n.w).h(n.h).px(ext ? 16 : 10).py(8).gap(3).rounded(ext ? 28 : 8).border_1()
      .border_color(lit ? t.accent : live ? c : ext ? t.muted : t.border).when(live && !st.dashed && !ext, (e) => e.border_l(4)).when(lit, (e) => e.border_2()).when(st.dashed || ext, (e) => e.border_dashed())
      .bg(lit ? solidOver(t.background, t.accent + "1a") : ext ? t.background : n.status === "new" ? solidOver(t.background, t.ansi2 + "14") : solidOver(t.background, t.surface))
      .when(Boolean(tip), (e) => e.tooltip(tip))
      .when(Boolean(opts.onFocus), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => opts.onFocus(opts.focus === n.id ? null : n.id, cx)))
      .when(!opts.onFocus && open, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((ev, cx) => onNode(n, ev, cx)))
      .when(Boolean(opts.onHover), (e) => e.on_hover((on, cx) => opts.onHover(on ? n.id : null, cx)))
      .child(h_flex().gap(6).items_start().text_size(12.5)
        .child(div().id(`${id}-gl${i}`).flex_none().h(17).text_color(t.muted).when(Boolean(n.type), (e) => e.tooltip(`Type: ${n.type}`).accessibility_label(`Type: ${n.type}`)).child(GLYPH[n.type] ?? "◇"))
        // Its trust zone as a small dot (opts.zones); ringed when it is really reachable from further out (opts.effective).
        .when(Boolean(zoneById.get(n.zone)), (e) => { const z = zoneById.get(n.zone), eff = opts.effective?.get(n.id);
          return e.child(div().id(`${id}-z${i}`).flex_none().mt(4).w(9).h(9).rounded_full().bg(trustColor(t, z.trust)).when(Boolean(eff), (x) => x.border_2().border_color(t.ansi1))
            .tooltip(`Trust zone: ${zoneName(z)}${eff ? `\nReachable as ${eff.trust}: ${eff.why}.` : ""}`).accessibility_label(`Trust zone ${z.trust}`)); })
        .child(div().flex_1().min_w(0).h(n.titleLines * 17).overflow_hidden().whitespace_normal().line_height(1.35).font_semibold().child(n.title))
        .when(n.spots > 0, (e) => e.child(div().id(`${id}-sn${i}`).flex_none().tooltip(`${n.spots} changed ${n.spots === 1 ? "spot" : "spots"} in the code`).text_size(11).text_color(t.muted).child(`</> ${n.spots}`)))
        .when(Boolean(st.chip), (e) => e.child(specTag(t, `${id}-sp${i}`))))
      .when(n.descLines > 0, (e) => e.child(div().flex_none().h(n.descLines * 15).overflow_hidden().text_size(11).line_height(1.35).whitespace_normal().text_color(t.muted).child(n.desc)))
      .children(decorate ? decorate(n) : [])
      .when(Boolean(marks?.nodes?.get(n.id)), (e) => e.child(markRow(marks.nodes.get(n.id), `${id}-m${i}`, MARK_CARD_H, true, n.w - 20)))
      .child(div().flex_1())
      // No type word here: it was cut off in most cards (the glyph's tooltip and the card's panel name the type). A
      // narrow card (Fit, a layer's flow) has no room for the link either: its panel has it.
      .child(h_flex().gap(6).items_center().text_size(10.5)
        .child(div().flex_1())
        .when(open && Boolean(opts.onFocus) && n.w >= ARCH.W, (e) => e.child(div().id(`${id}-o${i}`).flex_none().px(4).rounded(4).text_color(t.accent).cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip("Show this place in the diff").child("Show in diff ↗").on_click((ev, cx) => { onNode(n, ev, cx); cx.stop_propagation(); })))
        .when(Boolean(n.status) && !(ext && n.status === "unchanged"), (e) => e.child(chip(t, n.status === "new" ? "ADDED" : n.status.toUpperCase(), c, false, `${id}-st${i}`, `Status in this PR: ${n.status === "new" ? "added" : n.status}`)))), dimN(n), cardFade);
  });
  // An orchestrator's states: a lane down the card, one row each; a state that calls a component ends in "→" where its
  // line leaves the card.
  const states = L.nodes.flatMap((n, i) => (n.stateTop === null || n.stateTop === undefined ? [] : [dim(v_flex().id(`${id}-s${i}`).absolute()
    .left(n.x + 10).top(n.y + n.stateTop).w(n.w - 14).children(n.states.map((s, k) => h_flex().id(`${id}-s${i}-${k}`).h(ARCH.ROW).gap(6).items_center().text_size(11).tooltip(`${s.type ?? "state"}: ${s.name}${s.calls ? " (calls a component)" : ""}`)
      .child(div().flex_none().w(14).text_color(s.source !== "existing" && (s.status === "new" || s.status === "changed") ? t.accent : t.muted).child(STATE_GLYPH[s.type] ?? "▭"))
      .child(div().flex_1().min_w(0).truncate().text_color(s.source === "spec" || s.source === "existing" ? t.muted : t.foreground).child(s.name))
      .when(s.source === "spec", (e) => e.child(specTag(t, `${id}-s${i}-${k}-sp`)))
      .when(Boolean(s.calls), (e) => e.child(div().flex_none().text_color(t.muted).child("→"))))), dimN(n), cardFade)]));
  // opts.edgeNotes: Map(edge index -> text), a path's marks on a call itself (the Resilience map: ⏱ 10 s, ↻ no limit),
  // just above the call's text, else above its number.
  const notes = !opts.edgeNotes ? [] : L.paths.flatMap((p, i) => {
    const text = [...new Set((p.edges ?? []).filter((k) => opts.edgeNotes.has(k)).map((k) => opts.edgeNotes.get(k)))].join(" · ");
    if (!text || !p.badge) return [];
    const x = p.text ? p.text.x : p.badge.x + ARCH.BADGE / 2 + 4, y = (p.text ? p.text.y : p.badge.y - ARCH.BADGE / 2) - LB.LH - 6;
    return [div().id(`${id}-en${i}`).absolute().left(x).top(y).h(LB.LH + 4).px(3).flex().items_center().rounded(4).bg(t.background).whitespace_nowrap()
      .text_size(LB.px).font_semibold().text_color(/no limit|✕|no /.test(text) ? t.ansi1 : t.foreground).child(text)];
  });
  return div().id(id).relative().flex_none().w(L.width + 4).h(L.height + 4).children([gridBg(t, L.width + 4, L.height + 4), ...groups, ...els, ...crossings, ...bypasses, ...nodes, ...states, ...texts, ...badges, ...chips, ...notes]);
}
const FLOW_FITS = 380;
// A layer's flow laid out by archLayout, memoized like archModel. fit: its narrow cards (the layer column is about
// 420 px); over the code there is room for the usual ones.
const flowMemo = new Map();
function flowModel(v, fit = true) {
  const key = `${fit}|${JSON.stringify(v)}`;
  if (!flowMemo.has(key)) {
    // labels: a call's text on its line, once archLayout takes that option (until then it is ignored, and every text is in the legend).
    flowMemo.set(key, archLayout(flowArch(v), "diff", () => 0, fit, { labels: true }));
    if (flowMemo.size > 12) flowMemo.delete(flowMemo.keys().next().value);
  }
  return flowMemo.get(key);
}
const cap = (s) => String(s ?? "").replace(/^./, (c) => c.toUpperCase());
// Trust zones (arch.js zoneArch): a colour per trust level, none of them the severity red.
const TRUST = { public: "ansi3", authenticated: "ansi4", internal: "ansi6", data: "ansi5" };
const trustColor = (t, trust) => t[TRUST[trust] ?? "ansi6"];
// Whether a picture has something about trust to explain: zones as frames or as dots on cards, or a call over a boundary.
export const hasTrust = (L) => Boolean(L) && (L.groups.some((g) => g.trust) || L.nodes.some((n) => n.zone) || L.paths.some((p) => p.crosses));
// That explanation, in one row: the trust levels shown (frames: squares; zones only as a dot on cards: dots), and the
// mark of a call over a boundary. zones: the analysis' zones, for the dots.
export function trustLegend(L, t, zones = []) {
  const framed = L.groups.some((g) => g.trust), byId = new Map((zones ?? []).map((z) => [z.id, z.trust]));
  const levels = [...new Set(framed ? L.groups.map((g) => g.trust).filter(Boolean) : L.nodes.map((n) => byId.get(n.zone)).filter(Boolean))];
  const swatch = (z) => (framed ? div().w(10).h(10).rounded(3).border_1().border_dashed().border_color(trustColor(t, z)).bg(trustColor(t, z) + "33") : div().w(9).h(9).rounded_full().bg(trustColor(t, z)));
  return h_flex().gap(10).text_size(11.5).text_color(t.muted)
    .when(levels.length > 0, (e) => e.child("Trust zones:").children(levels.map((z) => h_flex().gap(4).items_center().child(swatch(z)).child(z))))
    .when(L.paths.some((p) => p.crosses), (e) => e.child(h_flex().gap(4).items_center().child(div().font_semibold().text_color(t.ansi3).child("‖")).child("call over a trust boundary")));
}
// What a mark's chip says in full: the count by kind, then the titles (at most five).
const markTip = (m) => [`${m.n} unresolved ${m.n === 1 ? "finding" : "findings"} here, the highest is ${m.severity}${m.breaks ? `; ${m.breaks === m.n ? (m.n === 1 ? "it breaks" : "all break") : `${m.breaks} of them break`} the flow at this place` : ""}.`,
  ...m.findings.slice(0, 5).map((f) => `· ${f.title}`), ...(m.n > 5 ? [`· and ${m.n - 5} more`] : [])].join("\n");
const STATE_GLYPH = { task: "▭", choice: "◇", parallel: "⫴", map: "⧉", wait: "⏱", pass: "↓", fail: "✕", succeed: "✓" };
const PAD_IN = 10;

// The paths' labels: "① A, B → C: label", one row each; hovering a row highlights its path (opts as in archView).
// A path whose whole text is on its line in the picture (arch.js `text`) is left out: nothing to list, no legend.
// big: larger text, where the relation is the main information.
export function archLegend(L, t, id, title, opts = {}, big = false) {
  const name = new Map(L.nodes.map((n) => [n.id, n.label ?? n.id])), F = archFocus(L, opts.focus);
  const rows = L.paths.filter((p) => !p.text || p.text.cut), mark = (p) => (p.text?.mark ? null : pathMark(opts.marks, p));
  if (!rows.length) return div();
  return v_flex().id(id).flex_none().gap(2).p(big ? 12 : 10).rounded(10).border_1().border_color(t.border).bg(t.surface)
    .child(div().pb(4).text_size(big ? 13 : 12).font_semibold().text_color(t.muted).child(title))
    .children(rows.map((p) => h_flex().id(`${id}-r${p.num}`).gap(8).items_start().px(6).py(3).rounded(6).tooltip("Hover to highlight this connection in the picture")
      .when(opts.hl === p.num, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).when(Boolean(F) && !F.paths.has(p.num), (e) => e.opacity(0.4))
      .when(Boolean(opts.onHl), (e) => e.on_hover((on, cx) => opts.onHl(on ? p.num : null, cx)))
      .child(div().flex_none().mt(1).w(18).h(18).flex().items_center().justify_center().rounded_full().border_1()
        .border_color(opts.hl === p.num || p.status ? t.accent : t.muted).text_size(11).text_color(t.foreground).child(String(p.num)))
      .when(p.source === "spec", (e) => e.child(div().flex_none().mt(2).child(specTag(t, `${id}-sp${p.num}`))))
      .when(Boolean(mark(p)), (e) => e.child(div().flex_none().mt(1).child(chip(t, `${cap(mark(p).severity)} · ${mark(p).n}: ${markLine(mark(p)).text}`, t[SEVERITY_COLOR[mark(p).severity]] ?? t.muted, true, `${id}-m${p.num}`, markTip(mark(p))))))
      .child(div().flex_1().min_w(0).whitespace_normal().text_size(big ? 13 : 12).line_height(1.4)
        .child(`${p.from.map((f) => name.get(f)).join(", ")} → ${name.get(p.to)}${p.label ? `: ${p.label}` : ""}`))));
}

// The status colours, in the cards' own words ("Added", as on a card's chip). counts {unchanged, changed, added,
// removed}: how many cards of each the picture has, after the word (0 and missing: no number).
export const legend = (t, counts = {}) => h_flex().gap(10).text_size(11.5).text_color(t.muted).children([["Unchanged", "muted"], ["Changed", "accent"], ["Added", "ansi2"], ["Removed", "ansi1"]]
  .map(([label, c]) => h_flex().gap(4).items_center().child(div().w(10).h(10).rounded(3).border_1().border_color(t[c]).bg(t[c] + "33")).child(counts[label.toLowerCase()] ? `${label} ${counts[label.toLowerCase()]}` : label)));

// A layer's pictures in the narrow left column (several: stacked with their kind above each, as tabs when more than
// two). flow/architecture: Architecture impact's picture (archLayout via views.js flowArch: cards left to right, real
// connectors with numbered badges, the labels in a legend), scrolling sideways when wider than the column; sequence:
// participants, then numbered calls; state_machine: a state diagram top to bottom (stateView); steps: a numbered
// list. Changed nodes and edges in the accent colour; onJump(at, cx) for nodes with a place.
export const KIND_NAME = { architecture: "Architecture", flow: "Flow", sequence: "Sequence", state_machine: "State diagram", steps: "Steps" };
export const visualName = (v) => `${KIND_NAME[v.kind] ?? v.kind}${v.title ? `: ${v.title}` : ""}`;

// visuals: [visual]; tab / onTab(k, cx): the shown one when there are tabs. wrapX(id, width, height, el): the caller's
// sideways scroller for wide pictures (review.js hscroll), else a native overflow_x_scroll.
export function visualsCard(visuals, t, id, onJump, tab = 0, onTab = null, wrapX = null) {
  const sources = visuals.some(hasSources);
  if (visuals.length <= 2 || !onTab) return v_flex().gap(8).when(sources, (e) => e.child(sourceLegend(t))).children(visuals.map((v, k) => visualCard(v, t, `${id}-${k}`, onJump, wrapX)));
  const k = Math.min(tab, visuals.length - 1);
  return v_flex().gap(6).when(sources, (e) => e.child(sourceLegend(t)))
    .child(h_flex().flex_wrap().gap(4).children(visuals.map((v, j) => div().id(`${id}-t${j}`).px(8).h(22).flex().items_center().rounded(5).cursor_pointer().text_size(11.5)
      .bg(j === k ? t.selected : t.chrome).text_color(j === k ? t.foreground : t.muted).max_w(180).tooltip(`Show: ${visualName(v)}`).child(div().truncate().child(visualName(v)))
      .on_click((_e, cx) => { onTab(j, cx); cx.stop_propagation(); }))))
    .child(visualCard(visuals[k], t, `${id}-${k}`, onJump, wrapX));
}

// ponytail: which folded call lists are open, kept here (visualCard has no state of its own); lost on a reload.
const openLists = new Set();
const nativeX = (id, _w, _h, el, pb = 0) => div().id(id).w_full().overflow_x_scroll().pb(pb).child(el);
const edgesOf = (v) => [...(v.edges ?? []), ...(v.transitions ?? [])];
const edgeText = (v, e, prefix = "") => { const name = (id) => v.nodes.find((n) => n.id === id)?.label ?? id; return `${prefix}${name(e.from)} → ${name(e.to)}${transitionText(e) ? ` · ${transitionText(e)}` : ""}`; };

// A picture over its layer's code (review.js: a row of the diff list, which needs every row's height before it
// draws): what visualCard draws at the card width `wide`, with the height it takes. A state diagram gets its
// transitions as a list beside it (below it when there is no room), each with its whole text; a flow the usual cards
// when they fit, else the narrow ones; a sequence a sequence diagram (views.js seqLayout).
const planMemo = new Map();
export function visualPlan(v, wide, bare = false) {
  const key = `${wide}|${bare}|${JSON.stringify(v)}`;
  if (planMemo.has(key)) return planMemo.get(key);
  const inner = wide - 22, edges = edgesOf(v), rowsH = (texts, w, size, lh, gap) => texts.reduce((n, x) => n + gap + lh * wrapCount(x, w, size), 0);
  let P;
  if (v.kind === "state_machine") {
    // In the diagram a transition carries its number, which never gets cut; its text is in the list (a Catch or
    // Retry keeps its chip). w: stateLayout's width, which holds the lines and their labels.
    const isErr = (e) => e.error === "catch" || e.error === "retry" || (!e.event && /^(catch|retry)\b/i.test(String(e.label ?? "")));
    const S = stateLayout({ ...v, edges: [], transitions: edges.map((e, k) => (isErr(e) ? e : { ...e, event: undefined, guard: undefined, action: undefined, label: String(k + 1) })) });
    const w = S.width;
    const side = inner - w - 24 >= 320, texts = edges.map((e, k) => edgeText(v, e, `${k + 1}. `)), listH = rowsH(texts, (side ? inner - w - 24 : inner) - 4, 12, 18, 4);
    P = bare ? { S, w, side: false, bare, texts, h: S.height + 2 } : { S, w, side, texts, h: side ? Math.max(S.height + 2, listH) : S.height + 2 + 8 + listH };
  } else if (v.kind === "sequence") {
    const Q = seqLayout(v, inner);
    P = { Q, h: Q.height };
  } else if (v.kind === "steps") {
    P = { h: rowsH(v.nodes.map((n) => n.note ?? ""), 150, 10.5, 15, 34) + 20 };
  } else {
    const usual = flowModel(v, false), L = usual.width + 4 <= inner ? usual : flowModel(v), over = L.width + 4 > inner, name = new Map(L.nodes.map((n) => [n.id, n.label ?? n.id]));
    const listed = L.paths.filter((p) => !p.text || p.text.cut); // archLegend lists the calls whose text is not, or not whole, on the line
    const legend = listed.length ? 46 + rowsH(listed.map((p) => `${p.from.map((f) => name.get(f)).join(", ")} → ${name.get(p.to)}${p.label ? `: ${p.label}` : ""}`), inner - 62, 12, 17, 8) : 0;
    P = { L, over, h: L.height + 10 + (over ? 22 : 0) + 6 + legend };
  }
  P.h += 52; // the card's own frame: margin, padding, title row, gap
  if (planMemo.size > 24) planMemo.delete(planMemo.keys().next().value);
  planMemo.set(key, P);
  return P;
}

// wide: the card's width when it is a row over the layer's code (visualPlan), else it sizes to its content.
// opts {bare: a state diagram without its list of transitions (they are rows of their own), marks: views.js
// transitionMarks for a state diagram}.
export function visualCard(v, t, id, onJump, wrapX = null, wide = null, opts = {}) {
  const name = new Map(v.nodes.map((n) => [n.id, n.label ?? n.id])), c = (x) => (x?.changed && x?.source !== "existing" ? t.accent : t.border);
  const box = (n, k) => v_flex().id(`${id}-b${k}`).flex_none().max_w(180).px(8).py(4).gap(2).rounded(6).border_1().border_color(c(n)).when(n.source === "spec", (e) => e.border_dashed().tooltip(SPEC_TIP)).bg(t.background)
    .when(Boolean(n.at && onJump), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(n.source === "spec" ? `${SPEC_TIP}\nClick to jump to the related code` : "Jump to this place in the code").on_click((_e, cx) => { onJump(n.at, cx); cx.stop_propagation(); }))
    .child(h_flex().gap(4).items_center().child(div().text_size(12).font_semibold().text_color(n.source === "existing" ? t.muted : n.changed ? t.accent : t.foreground).child(n.label ?? n.id))
      .when(n.source === "spec", (e) => e.child(specTag(t, `${id}-b${k}-sp`))))
    .when(Boolean(n.note), (e) => e.child(div().px(5).rounded(5).bg(t.accent + "1f").text_size(10.5).text_color(t.foreground).whitespace_normal().child(n.note)));
  const edge = (e, k, prefix = "") => h_flex().id(`${id}-x${k}`).gap(4).items_start().text_size(11.5).text_color(e.changed && e.source !== "existing" ? t.accent : t.muted)
    .when(e.source === "spec", (x) => x.child(specTag(t, `${id}-x${k}-sp`)))
    .child(div().flex_1().min_w(0).whitespace_normal().child(`${prefix}${name.get(e.from) ?? e.from} → ${name.get(e.to) ?? e.to}${transitionText(e) ? ` · ${transitionText(e)}` : ""}`));
  const edges = edgesOf(v), P = wide ? visualPlan(v, wide, Boolean(opts.bare)) : null, place = (x) => x?.at ?? x?.evidence;
  let body;
  if (v.kind === "sequence" && P) {
    body = seqView(P.Q, t, `${id}-sq`, onJump);
  } else if (v.kind === "sequence") {
    // The same diagram as over a layer's code (seqLayout), spread over the room it has (wrapX.room: the scroller's
    // measured width, 0 before the first frame), scrolling sideways only when the columns do not fit at SEQ.MIN;
    // the numbered calls under it folded to one line.
    const room = wrapX?.room?.(`${id}-sq`) || 0, Q = seqLayout(v, room || 200 * v.nodes.length), open = openLists.has(id);
    body = v_flex().gap(6).child((wrapX ?? nativeX)(`${id}-sq`, Q.width, Q.height, seqView(Q, t, `${id}-sv`, onJump)))
      .child(h_flex().id(`${id}-calls`).gap(6).cursor_pointer().text_size(11.5).text_color(t.muted).hover((x) => x.text_color(t.foreground))
        .tooltip(open ? "Fold the list of calls" : "Show every call with its whole text").on_click((_e, cx) => { if (open) openLists.delete(id); else openLists.add(id); cx.stop_propagation(); cx.notify(); })
        .child(open ? "▾" : "▸").child(`${edges.length} numbered ${edges.length === 1 ? "call" : "calls"}`))
      .when(open, (e) => e.children(edges.map((x, k) => edge(x, k, `${k + 1}. `))));
  } else if (v.kind === "state_machine" && P) {
    // Every transition with its whole text: the diagram cuts a label where its line leaves no room.
    const list = v_flex().flex_1().min_w(0).children(edges.map((e, k) => div().id(`${id}-tr${k}`).flex_none().pt(4).text_size(12).line_height(1.5).whitespace_normal()
      .text_color(e.changed && e.source !== "existing" ? t.foreground : t.muted).when(Boolean(e.evidence), (x) => x.tooltip(e.evidence))
      .when(Boolean(place(e) && onJump), (x) => x.cursor_pointer().hover((s) => s.text_color(t.accent)).on_click((_e, cx) => { onJump(place(e), cx); cx.stop_propagation(); })).child(P.texts[k])));
    const pic = div().w(P.w).flex_none().child(stateView(P.S, t, `${id}-sv`, onJump, opts.marks));
    body = P.bare ? nativeX(`${id}-sm`, 0, 0, pic) : P.side ? h_flex().gap(24).items_start().child(pic).child(list) : v_flex().gap(8).child(nativeX(`${id}-sm`, 0, 0, pic)).child(list);
  } else if (v.kind === "state_machine") {
    const S = stateLayout(v);
    body = (wrapX ?? nativeX)(`${id}-sm`, S.width, S.height + 2, stateView(S, t, `${id}-sv`, onJump, opts.marks));
  } else if (v.kind === "steps") {
    const lv = levels(v.nodes, edges), order = [...v.nodes].sort((a, b) => lv.get(a.id) - lv.get(b.id));
    body = v_flex().gap(4).children(order.map((n, k) => h_flex().gap(6).items_start().child(div().w(16).flex_none().text_size(12).text_color(t.muted).child(`${k + 1}.`)).child(box(n, k))));
  } else {
    const L = P?.L ?? flowModel(v);
    body = v_flex().gap(6)
      .child((wrapX ?? nativeX)(`${id}-fs`, L.width + 4, L.height + 4, archView(L, t, `${id}-av`, onJump ? (n, _e, cx) => { onJump(place(n), cx); cx.stop_propagation(); } : null, null, {}), 6))
      // A picture wider than its room says so instead of being scaled down.
      .when(P ? P.over : L.width > FLOW_FITS, (e) => e.child(div().h(16).flex_none().text_size(10.5).text_color(t.dim).child("Scroll sideways for the whole picture →")))
      .child(archLegend(L, t, `${id}-lg`, "Edges"));
  }
  return v_flex().id(id).flex_none().mt(4).p(10).gap(8).rounded(8).border_1().border_color(t.border).bg(t.surface).when(Boolean(P), (e) => e.h(P.h - 4).overflow_hidden())
    .child(h_flex().h(16).flex_none().gap(8).items_center().text_size(11.5).child(div().flex_none().font_semibold().text_color(t.muted).child((KIND_NAME[v.kind] ?? v.kind).toUpperCase()))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(v.title ?? ""))
      .when(Boolean(P) && hasSources(v), (e) => e.child(sourceLegend(t))))
    .child(body);
}

// A sequence diagram at seqLayout's positions: the participants in a row (a long name on two lines), a lifeline under
// each, solid and darker than the grid behind it, and one row per call in order: its number and text above an arrow
// from the caller's lifeline to the callee's, the head at the callee (a loop beside the lifeline for a call to
// itself). A text longer than its arrow runs on over the other lifelines, ending inside the picture (seqLayout tx).
function seqView(Q, t, id, onJump = null) {
  const jump = (el, place) => el.when(Boolean(place && onJump), (x) => x.cursor_pointer().hover((s) => s.border_color(t.accent)).on_click((_e, cx) => { onJump(place, cx); cx.stop_propagation(); }));
  const col = (e) => (e.changed && e.source !== "existing" ? t.accent : t.muted);
  const heads = Q.cols.flatMap((n, k) => [
    div().id(`${id}-l${k}`).absolute().left(n.x).top(Q.head).w(0).h(Q.height - Q.head).border_l(1.5).border_color(t.muted),
    jump(div().id(`${id}-p${k}`).absolute().left(n.x - n.w / 2).top(0).w(n.w).h(Q.head - 4).px(6).flex().items_center().justify_center().rounded(6).border_1()
      .border_color(n.changed && n.source !== "existing" ? t.accent : t.border).when(n.source === "spec", (e) => e.border_dashed()).bg(t.background).text_size(12).font_semibold()
      .text_color(n.source === "existing" ? t.muted : t.foreground).tooltip([n.label ?? n.id, n.note, n.source === "spec" ? SPEC_TIP : ""].filter(Boolean).join("\n"))
      .child(Q.head > SEQ.HEAD ? div().max_h(Q.head - 8).overflow_hidden().whitespace_normal().text_center().line_height(1.25).child(n.label ?? n.id) : div().truncate().child(n.label ?? n.id)), n.at ?? n.evidence)]);
  const calls = Q.calls.flatMap((e, k) => {
    const c = col(e), lo = Math.min(e.x1, e.x2), y = e.y + SEQ.ROW - 12, self = e.x1 === e.x2, left = self || e.x2 < e.x1, text = e.caption;
    return [
      self ? div().id(`${id}-c${k}`).absolute().left(lo).top(y - 12).w(22).h(12).border_t(1.5).border_r(1.5).border_b(1.5).rounded_r(6).border_color(c)
        : div().id(`${id}-c${k}`).absolute().left(lo).top(y).w(Math.abs(e.x2 - e.x1)).h(0).border_t(1.5).border_color(c).when(Boolean(e.dashed) || e.source === "spec", (x) => x.border_dashed()),
      div().id(`${id}-a${k}`).absolute().left(left ? e.x2 : e.x2 - 9).top(y - 8).text_size(11).text_color(c).child(left ? "◀" : "▶"),
      jump(div().id(`${id}-t${k}`).absolute().left(e.tx).top(e.y + (self ? 12 : 4)).max_w(e.tw).h(17).px(3).bg(t.surface).text_size(11.5)
        .text_color(e.changed && e.source !== "existing" ? t.foreground : t.muted).tooltip([text, e.evidence].filter(Boolean).join("\n")).child(div().truncate().child(text)), e.at ?? e.evidence)];
  });
  return div().id(id).relative().flex_none().w(Q.width).h(Q.height).children([gridBg(t, Q.width, Q.height), ...heads, ...calls]);
}

// A state diagram at stateLayout's positions: start dot, end ring, state cards (Parallel/Map blocks with their
// branches), transitions down with their "event [guard] / action" beside the last stretch, return lanes on the left
// with rounded corners, self-loops on the card's edge, Catch/Retry stubs with chips. Changed in the accent colour.
const SM_GLYPH = { task: "▭", choice: "◇", parallel: "⫴", map: "⧉", wait: "⏱", pass: "↓", fail: "✕", succeed: "✓" };
// marks: views.js transitionMarks (Map(transition index -> {findings, severity})): such a transition is drawn in its
// severity's colour with a chip at its arrow, the titles in its tooltip. onJump(place, cx): a card, a label or a chip
// opens its place (at, else evidence).
export function stateView(L, t, id, onJump, marks = null) {
  // A transition's index, from its key: "f<i>:…" forward, "b<i>" a return lane, "l<i>" a self-loop.
  const idx = (e) => { const m = /^[fbl](\d+)/.exec(e.key ?? ""); return m ? Number(m[1]) : -1; };
  const sevC = (m) => t[SEVERITY_COLOR[m.severity]] ?? t.ansi1, mk = (e) => marks?.get(idx(e)) ?? null;
  const col = (x) => (mk(x) ? sevC(mk(x)) : x.changed && x.source !== "existing" ? t.accent : t.muted), els = [];
  const findTip = (m) => (m ? `\n\n${m.findings.length} unresolved ${m.findings.length === 1 ? "finding" : "findings"} at this transition:\n${m.findings.slice(0, 5).map((f) => `· ${f.title}`).join("\n")}` : "");
  const jump = (el, place) => el.when(Boolean(place && onJump), (x) => x.cursor_pointer().on_click((_e, cx) => { onJump(place, cx); cx.stop_propagation(); }));
  const hline = (k, x1, x2, y, c, d = false) => div().id(k).absolute().left(Math.min(x1, x2)).top(y).w(Math.abs(x2 - x1)).h(0).border_t(1.5).border_color(c).when(d, (e) => e.border_dashed());
  const vline = (k, x, y1, y2, c, d = false) => div().id(k).absolute().left(x).top(Math.min(y1, y2)).w(0).h(Math.abs(y2 - y1)).border_l(1.5).border_color(c).when(d, (e) => e.border_dashed());
  L.edges.forEach((e, i) => {
    const c = col(e);
    e.segments.forEach((s, k) => {
      els.push(s.y1 === s.y2 ? hline(`${id}-e${i}-${k}`, s.x1, s.x2, s.y1, c, e.dashed) : vline(`${id}-e${i}-${k}`, s.x1, s.y1, s.y2, c, e.dashed));
    });
    if (mk(e)) els.push(jump(div().id(`${id}-m${i}`).absolute().left(e.arrow.x + 7).top(e.arrow.y - 16).px(4).h(15).flex().items_center().rounded(4).border_1().border_color(c).bg(t.background)
      .text_size(9.5).text_color(t.foreground).tooltip(`${e.text || "Transition"}${findTip(mk(e))}`).child(`${cap(mk(e).severity)} · ${mk(e).findings.length}`), e.at ?? e.evidence));
    els.push(div().id(`${id}-a${i}`).absolute().left(e.arrow.x - 5).top(e.arrow.y - 11).text_size(9).text_color(c).child("▼"));
    if (e.text && e.labelAt) els.push(jump(div().id(`${id}-l${i}`).absolute().left(e.labelAt.x).top(e.labelAt.y).w(e.labelAt.w).h(13).text_size(10.5).text_color(mk(e) ? c : e.changed ? t.accent : t.muted)
      .tooltip([e.text, sourceStyle(e.source).tip, e.evidence].filter(Boolean).join("\n") + findTip(mk(e))).child(div().truncate().when(Boolean(e.labelAt.left), (x) => x.text_right()).child(e.text)), e.at ?? e.evidence));
  });
  L.backs.forEach((b, i) => {
    const c = col(b), near = Math.min(b.sx, b.tx);
    els.push(div().id(`${id}-r${i}`).absolute().left(b.laneX).top(b.ty).w(near - b.laneX).h(b.sy - b.ty).border_l(1.5).border_t(1.5).border_b(1.5).rounded_l(8).border_color(c).when(b.dashed, (e) => e.border_dashed()).tooltip(`${b.text || "back"}${findTip(mk(b))}`));
    if (b.tx > near) els.push(hline(`${id}-rt${i}`, near, b.tx, b.ty, c, b.dashed));
    if (b.sx > near) els.push(hline(`${id}-rs${i}`, near, b.sx, b.sy, c, b.dashed));
    els.push(div().id(`${id}-ra${i}`).absolute().left(b.tx - 8).top(b.ty - 8).text_size(9).text_color(c).child("▶"));
    if (b.text) els.push(div().id(`${id}-rl${i}`).absolute().left(b.laneX + 4).top(b.ty + 3).max_w(near - b.laneX - 6).text_size(10.5).text_color(b.changed ? t.accent : t.muted).tooltip(b.text).child(div().truncate().child(b.text)));
  });
  const nodes = L.nodes.map((n, i) => {
    if (n.kind === "start") return div().id(`${id}-n${i}`).absolute().left(n.x + 1).top(n.y + 1).w(12).h(12).rounded_full().bg(t.foreground).tooltip("Start state").accessibility_label("Start state");
    if (n.kind === "end") return div().id(`${id}-n${i}`).absolute().left(n.x).top(n.y).w(14).h(14).rounded_full().border_1().border_color(t.foreground).flex().items_center().justify_center().tooltip("End state").accessibility_label("End state")
      .child(div().w(8).h(8).rounded_full().bg(t.foreground));
    const st = sourceStyle(n.source), lit = n.changed && st.tone !== "muted";
    const card = v_flex().id(`${id}-n${i}`).absolute().left(n.x).top(n.y).w(n.w).h(n.h).px(8).py(5).gap(1).rounded(6).border_1().border_color(lit ? t.accent : t.border).when(st.dashed, (e) => e.border_dashed()).bg(t.background)
      .when(Boolean((n.at || n.evidence) && onJump), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Jump to this place in the code").on_click((_e, cx) => { onJump(n.at ?? n.evidence, cx); cx.stop_propagation(); }))
      .child(h_flex().gap(5).items_center().text_size(12).child(div().flex_none().text_color(t.muted).child(SM_GLYPH[n.type] ?? "▭"))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(lit ? t.accent : st.tone === "muted" ? t.muted : t.foreground).child(n.label ?? n.id))
        .when(Boolean(st.chip), (e) => e.child(specTag(t, `${id}-n${i}-sp`)))
        .when(n.kind === "block", (e) => e.child(div().flex_none().text_size(10.5).text_color(t.muted).child(n.type ?? ""))))
      .when(Boolean(n.note) && n.kind !== "block", (e) => e.child(div().truncate().text_size(10.5).text_color(t.muted).child(n.note)))
      .when(Boolean(n.note || st.tip || n.evidence), (e) => e.tooltip([`${n.label ?? n.id}`, n.note, st.tip, n.evidence].filter(Boolean).join("\n\n")));
    return card;
  });
  const kids = L.nodes.flatMap((n, i) => (n.children ?? []).flatMap((k, j, list) => {
    const out = [div().id(`${id}-k${i}-${j}`).absolute().left(k.x).top(k.y).w(k.w).h(k.h).px(6).flex().items_center().rounded(5).border_1().border_color(k.changed ? t.accent : t.border).when(k.source === "spec", (e) => e.border_dashed().tooltip(SPEC_TIP)).bg(t.surface).tooltip(k.label ?? k.id)
      .text_size(11).text_color(k.changed ? t.accent : t.foreground).child(div().truncate().child(k.label ?? k.id))];
    const nxt = list[j + 1];
    if (nxt && nxt.branch === k.branch) out.push(vline(`${id}-kl${i}-${j}`, k.x + k.w / 2, k.y + k.h, nxt.y, t.muted));
    return out;
  }));
  const loops = L.loops.flatMap((l, i) => [div().id(`${id}-o${i}`).absolute().left(l.x).top(l.y).w(14).h(12).rounded(6).border(1.5).border_color(col(l)).when(l.dashed, (e) => e.border_dashed()).tooltip(`${l.text || "self-transition"}${findTip(mk(l))}`),
    ...(mk(l) ? [div().id(`${id}-om${i}`).absolute().left(l.x - 2).top(l.y - 16).px(4).h(15).flex().items_center().rounded(4).border_1().border_color(col(l)).bg(t.background).text_size(9.5).text_color(t.foreground)
      .tooltip(`${l.text || "Self-transition"}${findTip(mk(l))}`).child(`${cap(mk(l).severity)} · ${mk(l).findings.length}`)] : []),
    ...(l.text ? [div().id(`${id}-ol${i}`).absolute().left(l.x + 17).top(l.y - 1).max_w(l.w).text_size(10.5).text_color(l.changed ? t.accent : t.muted).tooltip(l.text).child(div().truncate().child(`↺ ${l.text}`))] : [])]);
  const stubs = L.stubs.flatMap((s, i) => {
    const c = /retry/i.test(s.text) ? t.ansi3 : t.ansi1;
    return [hline(`${id}-sl${i}`, s.x1, s.x2, s.y, c, s.dashed), div().id(`${id}-sc${i}`).absolute().left(s.chip.x).top(s.chip.y).w(s.chip.w).h(s.chip.h).px(5).flex().items_center()
      .rounded(5).border_1().border_color(c).when(s.dashed, (e) => e.border_dashed()).bg(t.background).text_size(10.5).text_color(t.foreground).tooltip(s.text).child(div().truncate().child(s.text))];
  });
  return div().id(id).relative().flex_none().w(L.width).h(L.height + 2).children([gridBg(t, L.width, L.height + 2), ...els, ...nodes, ...kids, ...loops, ...stubs]);
}

// The PR triage card (pr.js triageOf): priority, title, the why in an accent quote bar, chips, repo and number.
// ponytail: no @author; prs.json has none and these PRs come from your own sessions.
export function triageCard(t, id, pr, tri, onClick) {
  return v_flex().id(id).flex_none().px(8).py(6).gap(5).rounded(8).border_1().border_color(t.border).bg(t.surface).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick)
    .child(h_flex().gap(6).items_center()
      .child(chip(t, `● P${tri.priority}`, tri.priority === 1 ? t.ansi1 : tri.priority === 2 ? t.ansi3 : t.muted, false, `${id}-p`, PRIORITY_TIP))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12).child(pr.title ?? `#${pr.number}`)))
    .when(Boolean(tri.why), (e) => e.child(div().pl(8).border_l(3).border_color(t.accent).text_size(11.5).line_height(1.4).text_color(t.foreground).whitespace_normal().child(tri.why)))
    .child(h_flex().flex_wrap().gap(4).children(tri.chips.map((c, k) => chip(t, c, /security/i.test(c) ? t.ansi1 : t.muted, false, `${id}-ch${k}`, triageTip(c)))))
    .child(div().id(`${id}-rp`).text_size(10.5).text_color(t.dim).tooltip("Repository and PR number").child(`${pr.repo} #${pr.number}`));
}

// A faint grid behind a picture (graph paper): one painted path (window.paint_path) with a line every GRID px, as many
// as the box holds, in the text colour at 7 % strength (low contrast in both themes). One element however big the picture is.
const GRID = 24;
export function gridBg(t, w, h) {
  // ponytail: coordinates in % of the box, as the other mods' paint_path rings do.
  const X = (x) => `${(100 * x) / w}%`, Y = (y) => `${(100 * y) / h}%`;
  let p = PathBuilder.stroke(1);
  for (let x = GRID; x < w; x += GRID) p = p.move_to(X(x), "0%").line_to(X(x), "100%");
  for (let y = GRID; y < h; y += GRID) p = p.move_to("0%", Y(y)).line_to("100%", Y(y));
  return globalThis.window.paint_path(p.build(), t.foreground + "12").absolute().top(0).left(0).w(w).h(h);
}


// A budget as a bullet chart (Resilience): the value's bar, the limit as a line, the part over it hatched in the
// severity red with its word; the numbers as text beside it. b: views.js budgetBar's px.
export function bulletChart(t, id, b, valueText, limitText, width = 320) {
  const rect = () => PathBuilder.fill().move_to("0%", "0%").line_to("100%", "0%").line_to("100%", "100%").line_to("0%", "100%").close().build();
  return h_flex().id(id).gap(12).items_center()
    .child(div().relative().flex_none().w(width).h(18).rounded(3).bg(t.surface).border_1().border_color(t.border)
      .child(div().absolute().left(0).top(4).h(8).w(Math.min(b.value, b.limit)).bg(t.muted))
      .when(b.over > 0, (e) => e.child(div().absolute().left(b.limit).top(2).h(12).w(b.over).border_1().border_color(t.ansi1)
        .child(globalThis.window.paint_path(rect(), Background.pattern_slash(t.ansi1, 1.5, 6)).absolute().top(0).left(0).size_full())))
      .child(div().absolute().left(b.limit).top(-3).w(2).h(22).bg(t.foreground)))
    .child(div().text_size(12.5).child(`${valueText} against ${limitText}`))
    .when(b.over > 0, (e) => e.child(div().text_size(12.5).font_semibold().text_color(t.ansi1).child(`✗ ${b.overS} s over`)));
}
