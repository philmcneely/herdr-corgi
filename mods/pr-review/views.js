// Pure helpers for the panel's state (main.js) and a layer's flow picture (stack.js visualCard). No gpui imports, so
// node tests them (test_views.mjs).
import { transitionText } from "./arch.js";
import { safeFile } from "./editor.js";
import { isSecurity, priceOf, isGuard, isDefect, secByEffect } from "./pr.js";
import { RES_WHEN } from "./pr.js"; // Resilience: the words for a dependency's cases
export { isDefect };

// The panel is either picking a PR (none chosen yet, or PRs ▾ open) or showing the chosen one (its diff or walkthrough).
// chosen: a PR, or the current branch picked from the list.
export const panelState = ({ chosen, picking }) => (!chosen || picking ? "picking" : "selected");

// The body tab of a chosen PR: "walk" or "diff" (Setup has its own page).
export const bodyTab = (view) => (view === "walk" ? "walk" : "diff");

// In progress: the newest `max` unless all are asked for; more: how many are left out.
export const IN_PROGRESS_MAX = 3;
export function capped(list, all = false, max = IN_PROGRESS_MAX) {
  return all ? { shown: list, more: 0 } : { shown: list.slice(0, max), more: Math.max(0, list.length - max) };
}

// ---- the PR list (main.js picker)

// Open and draft PRs first; merged and closed ones are their own group, folded, without a way into the review.
export const isOpenPr = (p) => p.state === "open" || p.state === "draft";
export const byState = (list) => ({ open: list.filter(isOpenPr), done: list.filter((p) => !isOpenPr(p)) });

// One row per PR: the ones shown under "In progress" leave the list (above: how many). started: the review in
// progress of a PR by url, so a row that stays (over the cap there) resumes instead of starting again.
export function listRows(list, inProgress, shown) {
  const top = new Set(shown.map((r) => r.url)), rest = list.filter((p) => !top.has(p.url));
  return { list: rest, above: list.length - rest.length, started: new Map(inProgress.map((r) => [r.url, r])) };
}

// A row's risk signal, from cached files only (null without any): the highest severity among the open findings, and
// whether one of them is about security. analysis: a mapReview result (its layers' findings); findings and status:
// the reviewers' findings file. A fixed or dismissed finding is settled; a fix that was only sent is not.
const SEVERITIES = ["critical", "high", "medium", "low"];
export function riskSignal({ analysis = null, findings = null, status = null } = {}) {
  if (!analysis && !findings) return null;
  const open = [...(findings ?? []), ...(analysis?.steps ?? []).flatMap((s) => s.findings ?? [])].filter((f) => !["fixed", "dismissed"].includes(status?.[f.id]?.s));
  return { top: SEVERITIES.find((s) => open.some((f) => f.severity === s)) ?? null, open: open.length,
    security: open.some(isSecurity), // as the review's ⛨ (pr.js isSecurity): what it does, not who found it
    // The mark's form: how sure the security findings are while there is one (the ⛨ speaks of them), else all of them.
    form: signOf(open.some(isSecurity) ? open.filter(isSecurity) : open).form, words: signWords(open) };
}

// "0/6 layers · 2/9 files · 1 comment · 11 unresolved findings" for a review in progress (open-reviews.json `progress`,
// whose fields keep their names: steps, stepsChecked).
export function progressText(p = {}) {
  const n = (count, one, many) => (count ? `${count} ${count === 1 ? one : many}` : null);
  return [p.steps ? `${p.stepsChecked ?? 0}/${p.steps} layers` : null, p.files ? `${p.filesViewed ?? 0}/${p.files} files` : null,
    n(p.comments, "comment", "comments"), n(p.replies, "reply", "replies"), p.fixedThreads ? `${p.fixedThreads} fixed` : null,
    n(p.findingsOpen, "unresolved finding", "unresolved findings")].filter(Boolean).join(" · "); // the review's word for them
}

// "3 pending comments in 2 files": what "Finish your review" would take along.
export function pendingText(comments) {
  const n = comments.length, files = new Set(comments.map((c) => c.file)).size;
  return `${n} pending ${n === 1 ? "comment" : "comments"} in ${files} ${files === 1 ? "file" : "files"}`;
}

// A flow (or a layer's architecture) visual as archLayout's input: its groups, else one implicit group for all nodes;
// a node's note is its card's description; `changed` becomes status "changed"; an edge's text is its label (or
// "event [guard] / action"). Sources (implemented, existing, spec) pass through, so the cards style the same way.
export function flowArch(v) {
  const groups = (v?.groups ?? []).filter((g) => g?.id);
  const implicit = groups.length ? null : { id: "flow", label: "", kind: "" };
  const status = (x) => x.status ?? (x.changed ? "changed" : undefined);
  return {
    groups: implicit ? [implicit] : groups,
    nodes: (v?.nodes ?? []).map((n) => ({ id: n.id, label: n.label ?? n.id, description: n.description ?? n.note ?? "", type: n.type,
      group: implicit ? implicit.id : n.group, status: status(n), source: n.source, at: n.at, evidence: n.evidence })),
    edges: [...(v?.edges ?? []), ...(v?.transitions ?? [])].map((e) => ({ from: e.from, to: e.to, label: transitionText(e),
      status: status(e), source: e.source, evidence: e.evidence, dashed: e.dashed })),
  };
}

// One wheel/trackpad event over a sideways scroller inside the scrolling page (review.js hscroll). g: the gesture so
// far ({axis, at} | null); a gesture keeps the axis it starts with (mostly sideways: only the picture moves; mostly
// down: the page scrolls) and ends after GESTURE_MS without an event or on a new touch; shift+wheel is sideways.
// Gives the gesture, the offset clamped to [0, max] and used (the picture took the event: the page must not).
export const GESTURE_MS = 150;
export function wheelStep(g, { dx = 0, dy = 0, t, phase, shift = false }, x, max) {
  let axis = phase === "started" || !g || t - g.at > GESTURE_MS ? null : g.axis;
  if (!axis && (dx || dy)) axis = Math.abs(dx) > Math.abs(dy) || shift ? "x" : "y";
  const used = axis === "x" && max > 0, clamp = (v) => Math.max(0, Math.min(max, v));
  return { g: { axis, at: t }, x: clamp(used ? x - (dx || (shift ? dy : 0)) : x), used };
}

// gh pr diff refuses PRs over 300 files (HTTP 406 / too_large): then the diff is made from a local clone.
export const diffTooLarge = (msg) => /HTTP 406|exceeded the maximum number of files|too_large/i.test(String(msg));

// The "List pull request files" API's files as gh-pr-diff-shaped text (pr.js splitPatch). A file without a patch
// (binary, or too large for GitHub) keeps its header and a note.
export function filesToDiff(files) {
  const out = [];
  for (const f of files) {
    const from = f.previous_filename ?? f.filename, added = f.status === "added", removed = f.status === "removed";
    out.push(`diff --git a/${from} b/${f.filename}`);
    if (added) out.push("new file mode 100644");
    else if (removed) out.push("deleted file mode 100644");
    else if (f.status === "renamed") out.push(`rename from ${from}`, `rename to ${f.filename}`);
    if (f.patch) out.push(`--- ${added ? "/dev/null" : `a/${from}`}`, `+++ ${removed ? "/dev/null" : `b/${f.filename}`}`, f.patch);
    else out.push(`Binary files a/${from} and b/${f.filename} differ`, `No diff from GitHub for this file (binary or too large): +${f.additions ?? 0} -${f.deletions ?? 0}`);
  }
  return out.join("\n") + "\n";
}

// ---- files folded when a review opens: lock files and generated output, and big changes (click the header to open)
const LOCK = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum|flake\.lock|gradle\.lockfile|[^/]*\.lock|[^/]*\.min\.(js|css)|[^/]*\.map)$/;
export const FOLD_LINES = 400;
export const foldOnOpen = (patch) => (patch ?? []).filter((f) => LOCK.test(f.path) || (f.add ?? 0) + (f.del ?? 0) > FOLD_LINES).map((f) => f.path);

// ---- the Files list's room (review.js filesItems): gpui-kit's virtual list holds at most 10000 items, so a big PR
// opens the files around where you read and folds the rest; each folded file keeps its height as one tall item, so
// the scrollbar spans the whole PR and nothing jumps when files open or fold while you scroll.
// files: the files that could open, in document order: {path, i (place in the PR), n (rows)}. Which fold
// (overBudget): the file at `center` first, then the ones you opened last (the newest RECENT), then the nearest
// to `center`, below before above on a tie; what doesn't fit in `cap` rows folds.
export const RECENT = 8;
export function allocate({ files, center = 0, recent = [], cap }) {
  const rank = new Map(recent.slice(0, RECENT).map((p, i) => [p, i]));
  const key = (f) => (f.i === center ? 0 : rank.has(f.path) ? 1 + rank.get(f.path) : 1e6 + 2 * Math.abs(f.i - center) + (f.i < center ? 1 : 0));
  const over = new Set();
  let used = 0;
  for (const f of [...files].sort((a, b) => key(a) - key(b))) { if (used + f.n > cap) over.add(f.path); else used += f.n; }
  return over;
}

// Index of the last sorted value <= x (0 when none): the file whose header is at or above an item.
export function lastAtOrBelow(sorted, x) {
  let lo = 0, hi = sorted.length - 1, k = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (sorted[m] <= x) { k = m; lo = m + 1; } else hi = m - 1; }
  return k;
}

// Whether to open the files around the view again, and around which file (null: leave it). heads: the item index
// of each file's header, in order; top: each item's y (top[i], one past the last too); folds: [top, bottom] of the
// folded files' items, in order; start..end: the items on screen; center: the file the room was given around.
// Only when a folded file is within `margin` px of the view and you have moved to another file: scrolling inside
// the open part changes nothing, so it doesn't reshuffle while you read.
export function recenter({ heads, top, folds, start, end, center, margin }) {
  if (!folds.length || !heads.length) return null;
  const at = lastAtOrBelow(heads, start);
  if (at === center) return null;
  const y0 = top[start] - margin, y1 = top[Math.min(end, top.length - 1)] + margin;
  let lo = 0, hi = folds.length; // the first fold that ends below y0
  while (lo < hi) { const m = (lo + hi) >> 1; if (folds[m][1] < y0) lo = m + 1; else hi = m; }
  return lo < folds.length && folds[lo][0] <= y1 ? at : null;
}

// A sideways scroller's visible width (review.js hscroll): its measured width less what the Ask drawer covers at the
// right, so the scroll reaches the picture's last columns; never under 100 px.
export const hsVisible = (measured, covered = 0) => Math.max(100, measured - covered);

// ---- bringing a list item to the top of its view (review.js settleTop)

// The kit's scroll_to_item(i, "top") reveals an item at the near edge: one below the view lands at the view's bottom.
// To land item i at the top from anywhere, the view first goes just past it: this is the item to centre for that, the
// first whose centre lies more than half a view below i's top, so i's top is cut off above by less than that item's
// height. "top" on i itself then pulls it exactly to the top edge. sizes: every item's height; viewH: the list's.
export function pastTop(sizes, i, viewH) {
  let y = 0;
  for (let k = 0; k < i; k++) y += sizes[k];
  const want = y + viewH / 2;
  for (let j = i; j < sizes.length; j++) { if (y + sizes[j] / 2 > want) return j; y += sizes[j]; }
  return sizes.length - 1; // less than a view below it: the list's end, which is as high as it gets
}

// ---- the review's left column

// The layers in the analysis' order (closest reading first) and in reading order: do the two lists differ? Only then
// is a switch between them worth showing.
export const orderDiffers = (steps) => [...steps].sort((a, b) => a.order - b.order).some((s, i) => s !== steps[i]);

// What a layer row or a file row says about its unresolved findings: the highest severity with its count ("2 high"),
// every severity in words for the tooltip, and how many are security findings. null without findings.
export function worst(findings) {
  if (!findings.length) return null;
  const n = {};
  for (const f of findings) n[f.severity] = (n[f.severity] ?? 0) + 1;
  const order = [...SEVERITIES, ...Object.keys(n).filter((k) => !SEVERITIES.includes(k))].filter((k) => n[k]);
  return { severity: order[0], count: n[order[0]], total: findings.length, label: `${n[order[0]]} ${order[0]}`,
    words: order.map((k) => `${n[k]} ${k}`).join(", "), security: findings.filter((f) => f.security).length,
    sign: signOf(findings.filter((f) => f.security)), signWords: signWords(findings.filter((f) => f.security)) }; // the ⛨ of a layer's or a file's row
}

// Merge blockers for "Needs your attention": by severity, security first within one severity, else in their order.
export function byUrgency(blockers, security = () => false) {
  const rank = (b) => { const i = SEVERITIES.indexOf(b.severity); return i < 0 ? SEVERITIES.length : i; };
  return blockers.map((b, i) => ({ b, i, sec: security(b) ? 0 : 1 })).sort((x, y) => rank(x.b) - rank(y.b) || x.sec - y.sec || x.i - y.i).map((x) => x.b);
}

// ---- what a finding claims (an open card in the diff; any other place that names the same facts)

// The scale behind a severity: the analysis names a finding's impact, and the impact fixes the severity.
export const IMPACT = {
  breaks_requirement: ["high", "it breaks a requirement of the task"], dead_path: ["high", "it leaves the new path without effect"],
  unauthorized_access: ["high", "it allows access without permission"], data_exposure: ["high", "it exposes data"], data_loss: ["high", "it loses data"],
  edge_case: ["medium", "it fails in an edge case"], degraded_operation: ["medium", "it makes the system harder to operate"],
  fragile_structure: ["medium", "it makes the structure fragile"], untested: ["medium", "it is not covered by a test"],
  maintainability: ["low", "it makes the code harder to maintain"], unrequested: ["low", "the task did not ask for it"],
};
export const CERTAINTY = { confirmed: "Confirmed: something that ran shows it.", derived: "Derived: it follows from the code that was read.",
  assumed: "Assumed: it depends on something that could not be checked." };

// The help text of a severity chip: the whole scale, one line per severity.
export const SEVERITY_SCALE = ["high", "medium", "low"].map((s) => `${s}: ${Object.values(IMPACT).filter(([sev]) => sev === s).map(([, why]) => why).join(", ")}.`).join("\n");

// A finding's facts as [label, text] rows: why it has its severity, its effect, how sure the claim is, and what has
// to hold for it to happen. A finding from an older analysis has none of these fields and gives no rows.
export function factRows(f) {
  const why = IMPACT[f?.impact]?.[1], known = Boolean(f?.effect || f?.certainty);
  // Reach: how sure the way from outside is (path_certainty, path_why), apart from the flaw itself (Certainty).
  const pc = CERTAINTY[f?.path_certainty] ? f.path_certainty : null, pw = String(f?.path_why ?? "").trim().replace(new RegExp(`^${pc}:\\s*`, "i"), "").replace(/\.$/, "");
  return [why && ["Severity", `${f.severity ?? IMPACT[f.impact][0]}, because ${why}.`], f?.effect && ["Effect", f.effect],
    CERTAINTY[f?.certainty] && ["Certainty", `${CERTAINTY[f.certainty]}${probedText(f)}`],
    pc && ["Reach", pw ? `${pc[0].toUpperCase()}${pc.slice(1)}: ${pw[0].toUpperCase()}${pw.slice(1)}.` : CERTAINTY[pc]],
    f?.preconditions?.length ? ["Preconditions", f.preconditions.join("; ")] : known && ["Preconditions", "None: it always happens."]].filter(Boolean);
}

// The line a finding's card sits under: the first line with code from its own line on (new side), so the card never
// hangs under an empty line. Its own line when the next code is more than three lines past its range (line..end), not
// shown, or in another block: a function or class starts there, or it is indented less than the code just above (a
// finding after a function's last line or a YAML block's last key belongs to that one). rows: a file's rows ({kind,
// number, text}).
const DEFINES = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:def|class|function)\b/;
export function findingAnchor(rows, line, end = line) {
  const code = (x) => x.kind !== "-" && Number.isInteger(x.number) && String(x.text ?? "").trim(), indent = (x) => /^\s*/.exec(x.text)[0].length;
  const r = rows.find((x) => code(x) && x.number >= line), above = rows.filter((x) => code(x) && x.number < line).at(-1);
  const other = r && r.number > line && (DEFINES.test(r.text) || (above && indent(r) < indent(above)));
  return r && r.number <= Math.max(line, end ?? line) + 3 && !other ? r.number : line;
}

// The gutter marks of ranges of lines: Map(new-side line number -> mark) for the rows that are really shown. A
// range's line and end come from a model's answer, so the work goes over the rows, never over the range (an end of
// 1e9 costs nothing); a range whose line or end is not a whole number, or that ends before it starts, marks nothing.
// ranges: [{line, end, mark}]; the first range that holds a row marks it.
export function rangeMarks(rows, ranges) {
  const ok = ranges.filter((x) => Number.isInteger(x.line) && Number.isInteger(x.end) && x.end >= x.line), out = new Map();
  if (ok.length) for (const r of rows) {
    if (r.kind === "-" || !Number.isInteger(r.number)) continue;
    const hit = ok.find((x) => r.number >= x.line && r.number <= x.end);
    if (hit) out.set(r.number, hit.mark);
  }
  return out;
}

// How many lines a text takes when it wraps at words in `width` px of the UI font (13.5 px unless `size` says
// otherwise): the virtual list needs every row's height before it draws. Character widths by class, measured on
// screenshots (within 2 %) and taken 4 % wider, so a card is never a line short.
const CH_W = (ch) => (ch === " " || "iljtfI.,:;'|!()[]{}-/`\"".includes(ch) ? 4 : ch > "\u2e7f" ? 13.5 : /[A-Zmw_@%&]/.test(ch) ? 8.5 : /\d/.test(ch) ? 8 : 7.3);
export function wrapCount(text, width, size = 13.5) {
  const k = (size / 13.5) * 1.04, room = Math.max(40, width);
  let n = 0;
  for (const para of String(text ?? "").split("\n")) {
    let x = 0;
    n++;
    for (const word of para.split(" ")) {
      const w = [...word].reduce((sum, ch) => sum + CH_W(ch), 0) * k;
      if (x > 0 && x + 4 * k + w > room) { n++; x = 0; }
      x += (x > 0 ? 4 * k : 0) + w;
      if (x > room) { n += Math.floor(x / room); x %= room; } // a word longer than a line breaks inside
    }
  }
  return n;
}

// A sequence visual as a sequence diagram: one column per participant with its lifeline at x, one row per call in
// the given order, from the caller's lifeline (x1) to the callee's (x2; the same for a call to itself). The columns
// share `width`, each between SEQ.MIN and SEQ.MAX px: a picture with room spreads over it, one without scrolls. A
// participant's name that does not fit its column's head goes on a second line (head: the heads' height). Each call
// carries its numbered caption and where it starts (tx) and how wide it may be (tw): from the arrow's left end, moved
// left so it ends inside the picture rather than being cut at its edge. Returns {cols, calls, head, width, height}.
export const SEQ = { MIN: 130, MAX: 420, HEAD: 30, HEAD2: 46, ROW: 38, PAD: 6 };
// A text's width in px at `size` (the same letter widths as wrapCount).
export const textWidth = (text, size = 13.5) => Math.ceil([...String(text ?? "")].reduce((w, ch) => w + CH_W(ch), 0) * (size / 13.5) * 1.04);
export function seqLayout(v, width) {
  const nodes = (v?.nodes ?? []).filter((n) => n?.id), col = Math.max(SEQ.MIN, Math.min(SEQ.MAX, Math.floor(width / Math.max(1, nodes.length))));
  const x = new Map(nodes.map((n, k) => [n.id, Math.round(col * (k + 0.5))])), W = col * nodes.length;
  const head = nodes.some((n) => textWidth(n.label ?? n.id, 12) * 1.05 > col - 28) ? SEQ.HEAD2 : SEQ.HEAD; // semibold: a little wider
  const calls = [...(v?.edges ?? []), ...(v?.transitions ?? [])].filter((e) => x.has(e.from) && x.has(e.to)).map((e, k) => {
    const text = transitionText(e), caption = /^\d+[.)]/.test(text) ? text : `${k + 1}. ${text}`; // some analyses number the calls themselves
    const x1 = x.get(e.from), x2 = x.get(e.to), self = x1 === x2, start = Math.min(x1, x2) + (self ? 28 : 8), want = textWidth(caption, 11.5) + 8;
    // A call to itself whose text does not fit right of its loop puts it left of the lifeline, so it never covers the loop.
    const tx = self && start + want > W - 4 ? Math.max(4, x1 - 6 - want) : Math.max(4, Math.min(start, W - 4 - want));
    return { ...e, n: k + 1, text, caption, x1, x2, y: head + SEQ.PAD + k * SEQ.ROW, tx, tw: self && tx < x1 ? x1 - 6 - tx : W - tx - 4 };
  });
  return { cols: nodes.map((n) => ({ ...n, x: x.get(n.id), w: col - 16 })), calls, head, width: W, height: head + 2 * SEQ.PAD + calls.length * SEQ.ROW };
}

// ---- the height of a Markdown text (review.js: comment and finding cards are rows of the virtual list)

// What TextView.markdown takes at `width` px, in px: the list needs it before it draws, and a row that is too low
// cuts its text. Counted by block: a paragraph or a heading by its wrapped lines (a paragraph's lines joined as
// TextView joins them, apart at hard breaks), a list by its items (indented, a little apart), a fenced code block by
// its lines (a long one wraps) plus its frame; MD.GAP between blocks. Inline code counts as ordinary letters without
// narrow ones. lh: the line height, size: the font size of the place. Measured on screenshots at 13.5 px.
export const MD = { GAP: 10, CODE_LH: 24, CODE_PAD: 48, CODE_CH: 8.8, CODE_IN: 32, ITEM_IN: 24, ITEM_GAP: 4, HEAD: 1.5, HEADS: [1.5, 1.35, 1.2, 1.1, 1.1, 1.1], ROW_PAD: 13, CELL_PAD: 24, QUOTE_IN: 20 };
const codeWide = (line) => line.replace(/`([^`]*)`/g, (_m, code) => `aa${code.replace(/\S/g, "a")}`);
const codeRows = (line, width) => { const n = (line.length * MD.CODE_CH) / Math.max(40, width - MD.CODE_IN); return n <= 1 ? 1 : Math.ceil(n * 1.15); }; // it wraps at words
// Remembered per text and place: a list asks for every visible card's height on each render (the count is in
// mdHeight.counted, for the test). ponytail: one map emptied at MD_KEPT entries, no LRU.
const MD_KEPT = 2000, mdSeen = new Map();
export function mdHeight(text, width, lh = 21, size = 13.5) {
  const key = `${width}|${lh}|${size}|${text ?? ""}`, hit = mdSeen.get(key);
  if (hit !== undefined) return hit;
  if (mdSeen.size >= MD_KEPT) mdSeen.clear();
  const h = mdCount(text, width, lh, size);
  mdSeen.set(key, h);
  return h;
}
mdHeight.counted = 0;
function mdCount(text, width, lh, size) {
  mdHeight.counted++;
  const lines = String(text ?? "").replace(/\r/g, "").split("\n"), blocks = [];
  // A paragraph's lines join (soft breaks), except after a hard break (two spaces or a backslash at the end); a link
  // counts its text, not its address; emphasis marks take no room.
  const vis = (l) => codeWide(l).replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__|~~/g, "");
  let open = false, run = null; // a paragraph or a list goes on; run: the paragraph's text since its last hard break
  const flushRun = () => { if (run) { blocks[blocks.length - 1] += lh * wrapCount(vis(run.text.trim()), width - run.indent, size); run = null; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], fence = /^\s*(```|~~~)/.exec(l);
    if (fence) {
      flushRun();
      let n = 0;
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) n += codeRows(lines[i], width);
      blocks.push(MD.CODE_PAD + Math.max(1, n) * MD.CODE_LH); open = false;
    } else if (!l.trim()) { flushRun(); open = false; }
    else if (/^\s*\|/.test(l)) { // a table: a row per line (not the --- line), as high as its tallest cell
      flushRun();
      let h = 0;
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
        if (/^\s*\|?[\s:|-]+$/.test(lines[i]) && lines[i].includes("-")) continue;
        const cells = lines[i].trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/), w = width / Math.max(1, cells.length) - MD.CELL_PAD;
        h += lh * Math.max(...cells.map((c) => wrapCount(vis(c.trim()), w, size))) + MD.ROW_PAD;
      }
      i--; blocks.push(h); open = false;
    } else if (/^\s*>/.test(l)) { // a quote: its own Markdown, narrower
      flushRun();
      const q = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ""));
      i--; blocks.push(mdHeight(q.join("\n"), width - MD.QUOTE_IN, lh, size)); open = false;
    } else {
      const head = /^\s*#{1,6}\s+/.test(l), level = /^\s*(#+)/.exec(l)?.[1].length ?? 0, item = /^\s*(?:[-*+]|\d+[.)])\s+/.test(l), indent = item || (open && /^\s{2,}/.test(l)) ? MD.ITEM_IN : 0;
      if (head) { flushRun(); const k = MD.HEADS[level - 1] ?? 1.1; blocks.push(k * lh * wrapCount(l.replace(/^\s*#+\s+/, ""), width, size * k)); open = false; continue; }
      if (item || !open) { flushRun(); if (!open) blocks.push(0); if (item) blocks[blocks.length - 1] += MD.ITEM_GAP; }
      run = run ? { ...run, text: `${run.text} ${l.trim()}` } : { text: l, indent };
      if (/( {2,}|\\)$/.test(l)) flushRun();
      open = true;
    }
  }
  flushRun();
  return Math.ceil(blocks.reduce((a, b) => a + b, lh * !blocks.length) + MD.GAP * Math.max(0, blocks.length - 1));
}

// ---- the Security page's "what each run checked"
export const AREA_NAME = { authentication: "Authentication", authorization: "Authorization", input_validation: "Input validation", secrets: "Secrets", permissions: "Permissions",
  personal_data: "Personal data", dependencies: "Dependencies", correctness: "Correctness", error_handling: "Error handling", concurrency: "Concurrency", state: "State", contracts: "Contracts", tests: "Tests" };
// One row per area, one column per run that reported a scope. analysis: the analysis file's `scope` ({checked: [{area,
// result, note}]} or null); runs: pr.js runsOf. → {cols: [run key], rows: [{area, cells: {<run key>: {result, note} |
// null}}]}: areas in the order they are first named, null where a run does not cover the area, an unknown result
// counted as not_checked.
export function scopeTable(analysis, runs = {}) {
  const sources = [["analysis", analysis?.checked], ...Object.entries(runs ?? {}).map(([k, r]) => [k, r?.scope?.checked])].filter(([, c]) => Array.isArray(c) && c.length > 0);
  const areas = [...new Set(sources.flatMap(([, c]) => c.map((x) => x.area)))];
  const cell = (x) => (x ? { result: ["finding", "clean", "not_checked"].includes(x.result) ? x.result : "not_checked", note: String(x.note ?? "") } : null);
  return { cols: sources.map(([k]) => k), rows: areas.map((area) => ({ area, cells: Object.fromEntries(sources.map(([k, c]) => [k, cell(c.find((x) => x.area === area))])) })) };
}
// A run in words, so "not run", "failed" and "no findings" never look alike. r: a run of runsOf (or {state}); count:
// its findings on the list now.
export const runSummary = (r, count = r?.count ?? 0) => (!r?.state ? "not run" : r.state === "running" ? "running" : r.state === "failed" ? `failed: ${r.error || "no error text"}`
  : count ? `${count} ${count === 1 ? "finding" : "findings"}` : "no findings");

// ---- the Security page's attack surface
// How exposed an access row is: "open" (reachable without the cloud account's credentials and nothing checks the
// caller), "public" (reachable so, something checks the caller), "internal". What checks: `auth_kind` (none | code |
// gateway | iam) when the analysis has it, else the first word of the free text `auth`.
export const exposureOf = (x) => (!x?.public ? "internal" : (x.auth_kind ? x.auth_kind === "none" : /^(|none|no|nothing|unauthenticated|-|–)$/i.test(String(x.auth ?? "").trim().replace(/[\s.(:;,].*$/, ""))) ? "open" : "public");
export const EXPOSURE = { open: "Public, no auth", failopen: "Auth, can fail open", public: "Public, auth", internal: "Internal" };
// A public way in whose check an unresolved finding says can be passed (impact unauthorized_access): "failopen" while
// that finding is open, else the row's own exposure. findings: the unresolved findings at this way in.
export const exposureNow = (x, findings = []) => (x?.exposure === "public" && findings.some((f) => f.impact === "unauthorized_access") ? "failopen" : x?.exposure ?? "internal");
// The analysis' access rows as the ways in (entry points: everything public, and routes, endpoints and APIs) and the
// rights granted (the rest: IAM and resource policies). Each row keeps its index `k` and gets its `exposure`; the
// entries come most exposed first, then in the given order.
export function surfaceOf(access) {
  const order = Object.keys(EXPOSURE), rows = (access ?? []).map((x, k) => ({ ...x, k, exposure: exposureOf(x) }));
  const entry = (x) => Boolean(x.public) || /route|endpoint|api|url|http|gateway|ingress/i.test(String(x.kind ?? ""));
  return { entries: rows.filter(entry).sort((a, b) => order.indexOf(a.exposure) - order.indexOf(b.exposure) || a.k - b.k), grants: rows.filter((x) => !entry(x)) };
}

// ---- the Security page's order of findings, the way in the PR opens unasked, and what a zone's component may do
// How far out a finding can be reached from: the analysis' word when it has one (stated), else from the most exposed
// way in at it (derived: open → public, public with a check → authenticated, internal → internal_only), else unknown.
export const REACH = ["public", "authenticated", "internal_only", "unknown"];
const FROM_EXPOSURE = { open: "public", failopen: "public", public: "authenticated", internal: "internal_only" };
export const reachLevel = (f, ways = []) => (REACH.includes(f?.reachability) ? f.reachability
  : ways.map((x) => FROM_EXPOSURE[x.exposure]).filter(Boolean).sort((a, b) => REACH.indexOf(a) - REACH.indexOf(b))[0] ?? "unknown");
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const REACH_WHY = { public: "Reachable from the internet", authenticated: "Reachable by an authenticated caller", internal_only: "Reachable only from inside", unknown: "Not known from where it can be reached" };
// rows [{f, level, crosses: true | false | null (the analysis names no zones)}], most exposed first, then the ones whose
// way crosses a trust boundary, then by severity; each with `why` it stands there, in a few words.
// A finding that is the broken check itself (impact unauthorized_access) is reached by whoever reaches the check: a
// level of "authenticated" (behind that check) is public, as reviewers.reach() rates it, so the head agrees with its
// effect ("an unauthenticated caller could …").
export function secOrder(rows) {
  rows = rows.map((r) => (r.f?.impact === "unauthorized_access" && r.level === "authenticated" ? { ...r, level: "public" } : r));
  return [...rows].sort((a, b) => REACH.indexOf(a.level) - REACH.indexOf(b.level) || Number(Boolean(b.crosses)) - Number(Boolean(a.crosses)) || (SEV_RANK[a.f.severity] ?? 9) - (SEV_RANK[b.f.severity] ?? 9))
    .map((r) => ({ ...r, why: [REACH_WHY[r.level], r.crosses === true ? "over a trust boundary" : r.crosses === false ? "no trust boundary on the way" : null, `${r.f.severity} severity`].filter(Boolean).join(", ") + "." }));
}

// The way in this PR opens although the task does not ask for it: an ask of state "extra" whose places (files: its
// hunks' and its findings' files) hold the way in's place or its card's (files). Only a one-to-one match counts:
// [{entry, ask}]. asks [{state, files}], entries [{opened_by_pr, files}].
export function extraWays(asks, entries) {
  const extra = (asks ?? []).filter((a) => a.state === "extra"), open = (entries ?? []).filter((x) => x.opened_by_pr !== false);
  const hits = (a, x) => x.files.some((f) => a.files.includes(f));
  return extra.flatMap((a) => {
    const mine = open.filter((x) => hits(a, x));
    return mine.length === 1 && extra.filter((b) => hits(b, mine[0])).length === 1 ? [{ entry: mine[0], ask: a }] : [];
  });
}

// What a component in a zone with a way in may do: the access rows whose principal is the zone or one of its cards
// (by name). [{zone, rights: [{resource, actions, used}]}] for each zone that holds a way in's card, in zone order.
export function zoneRights(zones, nodes, entries, access) {
  const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase(), cards = nodes ?? []; // "FrontDesk function" is the zone "Front desk function"
  const zoneOf = (id) => cards.find((n) => n.id === id)?.zone;
  const held = new Set((entries ?? []).map((x) => zoneOf(x.node)).filter(Boolean));
  return (zones ?? []).filter((z) => held.has(z.id)).map((z) => {
    const names = new Set([z.name, z.id, ...cards.filter((n) => n.zone === z.id).flatMap((n) => [n.label, n.id])].filter(Boolean).map(norm));
    return { zone: z, rights: (access ?? []).filter((x) => names.has(norm(x.principal))).map((x) => ({ resource: x.resource ?? "", actions: x.actions ?? [], used: x.used })) };
  });
}
// That as a sentence: "If FrontDesk function is compromised, it can sqs:SendMessage on LoanEvents (granted, never used)."
export function blastLine({ zone, rights }) {
  const name = zone.name ?? zone.id;
  if (!rights.length) return `If ${name} is compromised, it holds no right the analysis names.`;
  return `If ${name} is compromised, it can ${rights.map((r) => `${r.actions.join(", ") || "act"} on ${r.resource}${r.used === false ? " (granted, never used)" : ""}`).join("; ")}.`;
}

// ---- the diff with the old and the new side next to each other (review.js pushRows)

// A file's rows (pr.js fileRows or a hunk's diffRows: {kind: "@" | "gap" | " " | "-" | "+" | "", …}) as what the
// side-by-side view draws, top to bottom, by index into `rows`:
// {full: i} a row over the whole width (a hunk header, a gap that still hides lines, a note);
// {l, r} a pair: an unchanged line on both sides (l === r); a changed block's removed lines beside its added ones,
// first with first, and where the block has more lines on one side the other side is empty (null).
export function pairRows(rows) {
  const out = [];
  for (let i = 0; i < rows.length;) {
    const k = rows[i].kind;
    if (k === " ") out.push({ l: i, r: i++ });
    else if (k !== "-" && k !== "+") out.push({ full: i++ });
    else {
      // One changed block: its removed lines, then its added ones (a diff writes them in this order).
      let a = i;
      while (a < rows.length && rows[a].kind === "-") a++;
      let b = a;
      while (b < rows.length && rows[b].kind === "+") b++;
      for (let n = 0; n < Math.max(a - i, b - a); n++) out.push({ l: i + n < a ? i + n : null, r: a + n < b ? a + n : null });
      i = b;
    }
  }
  return out;
}

// ---- long code lines wrap (review.js pushRows: one list item per visual line, so a click knows its line by its key)

// Where a code line breaks to fit `cols` columns: the offset each visual line starts at ([0] when it fits). A break
// goes after the last space or , ; ( [ { in the line's last third, else at `cols` exactly. At most `max` lines; the
// last one is cut as before.
export const WRAP_MAX = 40;
const WRAP_AFTER = /[\s,;([{]/;
export function wrapCode(text, cols, max = WRAP_MAX) {
  const s = String(text ?? ""), c = Math.max(8, Math.floor(cols)), out = [0];
  for (let a = 0; s.length - a > c && out.length < max;) {
    let e = a + c;
    for (let j = e; j > a + Math.ceil((2 * c) / 3); j--) if (WRAP_AFTER.test(s[j - 1])) { e = j; break; }
    out.push(e);
    a = e;
  }
  return out;
}
// The height a code line takes: one row per visual line.
export const wrapHeight = (starts, row) => row * Math.max(1, starts.length);
// The code columns of a diff row `width` px wide whose code starts `gutter` px from its left (12 px right of it).
export const codeCols = (width, gutter, charW) => Math.max(8, Math.floor((width - gutter - 12) / (charW || 7.8)));
// The syntax spans of text[a, b), shifted to the slice: a wrapped line keeps its colors on every visual line.
export const sliceSpans = (spans, a, b) => spans.filter((s) => s.end > a && s.start < b).map((s) => ({ ...s, start: Math.max(s.start, a) - a, end: Math.min(s.end, b) - a }));

// ---- side by side (review.js pushRows, lineView): two halves of equal width, each its own line number and sign
export const HALF_GUTTER = 4 + 48 + 22;
// Which half a press at x on a side-by-side row `w` px wide hit: the row index there (null: the half is empty), x from
// the half's left edge, the half's width, and the side ("l" old, "r" new).
export function pairSide(x, w, l, r) {
  const half = w / 2, right = x >= half;
  return { side: right ? "r" : "l", ri: right ? r : l, x: right ? x - half : x, w: half };
}
// The diff's view: the person's choice ("split" | "unified", kept in shared), else side by side when both halves of a
// list `width` px wide hold about 80 columns of code.
export const SPLIT_COLS = 80;
export const diffModeOf = (chosen, width, charW) => (chosen === "split" || chosen === "unified" ? chosen : codeCols(width / 2, HALF_GUTTER, charW) >= SPLIT_COLS ? "split" : "unified");
// A file whose lines are all on one side (a new or a deleted file): side by side it keeps one column over the whole
// width instead of an empty half.
export const oneSided = (rows) => !rows.some((r) => r.kind === " ") && !(rows.some((r) => r.kind === "+") && rows.some((r) => r.kind === "-"));

// A colour with transparency laid over the base, as one opaque colour: cards drawn with it hide the grid behind them
// (a tint with alpha let the grid show through a card). Colours are #rgb, #rrggbb or #rrggbbaa; anything else is
// returned as it is.
export function solidOver(base, over) {
  const rgba = (c) => {
    const s = String(c ?? "").replace("#", "");
    const h = s.length === 3 || s.length === 4 ? [...s].map((x) => x + x).join("") : s;
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return null;
    return [0, 2, 4, 6].map((k) => (k < h.length ? parseInt(h.slice(k, k + 2), 16) : 255));
  };
  const b = rgba(base), o = rgba(over);
  if (!b || !o) return over;
  const a = o[3] / 255, hex = (v) => Math.round(v).toString(16).padStart(2, "0");
  return "#" + [0, 1, 2].map((k) => hex(o[k] * a + b[k] * (1 - a))).join("");
}

// A PR row's marks in the PR list (main.js), at most three by weight: the highest open severity, with ⛨ when an open
// finding is about security (one mark, the only red one), then the priority, then the type. Effort is left out: the
// review itself has no "Review effort" either.
export function rowMarks(risk, tri) {
  // The risk mark carries its sign: glyph and word apart, the severity's color and the certainty's form (signEl).
  return [risk?.top && { text: `${risk.security ? "⛨ " : ""}${risk.top}`, security: Boolean(risk.security), kind: "risk", glyph: risk.security ? "⛨" : "", word: risk.top,
    color: risk.security ? SIGN_COLOR[risk.top] ?? "ansi1" : "muted", form: risk.form ?? "plain", words: risk.words ?? "" },
    tri && { text: `P${tri.priority}`, kind: "priority" }, tri?.type && { text: tri.type, kind: "type" }].filter(Boolean).slice(0, 3);
}

// A stack of PRs around this one (related.py stacked_on, stacked_above), bottom first: [{number, title, url, self}];
// null when this PR is in no stack. The review's bar shows it as "Stack: #1 → #2".
export function stackOf(ctx, number) {
  const below = ctx?.stacked_on ?? null, above = ctx?.stacked_above ?? [];
  return below || above.length ? [...(below ? [below] : []), { number, self: true }, ...above] : null;
}

// ---- "Depends on" in a layer's head (review.js item "step"): small chips at the right end of the title row
// A text's width in px of the UI font at `size` (the estimate wrapCount uses), for chips whose clicks are placed by x.
export const textW = (text, size = 13.5) => Math.ceil([...String(text ?? "")].reduce((w, ch) => w + CH_W(ch), 0) * (size / 13.5) * 1.04);
// Which of the chips laid out right-aligned (the last one ending at `right`, `gap` px between) a press at x hit: its
// index, or -1.
export function chipAt(x, right, widths, gap = 6) {
  let r = right;
  for (let k = widths.length - 1; k >= 0; k--) {
    const l = r - widths[k];
    if (x >= l && x < r) return k;
    r = l - gap;
  }
  return -1;
}

// "By focus": the layers by what their rows show (worst): the highest unresolved severity first, a layer with a
// security finding first among equals, then more findings, then reading order; layers without one last.
// open(s): a layer's unresolved findings.
export function byFocus(steps, open) {
  const rank = (w) => (w ? (SEVERITIES.indexOf(w.severity) + 1 || SEVERITIES.length + 1) : SEVERITIES.length + 2);
  return steps.map((s) => ({ s, w: worst(open(s)) }))
    .sort((a, b) => rank(a.w) - rank(b.w) || Number(Boolean(b.w?.security)) - Number(Boolean(a.w?.security)) || (b.w?.count ?? 0) - (a.w?.count ?? 0) || a.s.order - b.s.order)
    .map((x) => x.s);
}

// A layer's ways in and rights: the access rows (the analysis' or the security run's) at one of its files that are
// public or opened by this PR, with the sentence for the mark at its row ("This layer opens a public route (Api)."),
// so a layer that adds a way in shows it without a finding. null: none.
export function layerAccess(access, files) {
  const at = (x) => String(x.at ?? "").replace(/:\d+(?:-\d+)?$/, ""), has = (p) => files.some((f) => f === p || f.endsWith(`/${p}`) || p.endsWith(`/${f}`));
  const rows = (access ?? []).filter((x) => (x.public || x.opened_by_pr) && at(x) && has(at(x)));
  if (!rows.length) return null;
  const { entries, grants } = surfaceOf(rows);
  const say = [...entries.map((x) => `opens ${x.public ? "a public" : "a"} ${x.kind || "way in"}${x.resource ? ` (${x.resource})` : ""}`),
    ...grants.map((x) => `grants ${x.principal || "someone"} ${(x.actions ?? []).join(", ") || "a right"}${x.resource ? ` on ${x.resource}` : ""}`)];
  return { entries: entries.length, grants: grants.length, text: `This layer ${say.join(", and ")}.` };
}

// The analysis' line at the top of the Analysis tab: the head it read and its age, "stale" (amber) once the PR moved
// on (another head, or not this diff). head: the analysis file's (null: from before it said so); now: the PR's head.
export function analysisAge({ head = null, exact = true, now = null, age = "" }) {
  const at = (x) => String(x).slice(0, 7), moved = !exact || Boolean(head && now && head !== now);
  return { stale: moved, text: `Analysis of ${head ? at(head) : exact ? "this diff" : "an older diff"}${age ? `, ${age}` : ""}${moved && now && head ? ` · the PR is at ${at(now)} now` : ""}` };
}

// ---- "What each run checked": the findings behind an area's "Finding"
// ponytail: an area is matched by its words in a finding's title, effect and detail (findings name no area); a run
// that reports areas per finding would make this exact.
const AREA_WORDS = { authentication: /authenticat|\btoken|bearer|login|credential|session/i, authorization: /authori[sz]|access control|\brole|allowed to|any (?:caller|member|loan)/i,
  input_validation: /input|validat|inject|saniti[sz]|unvalidated|request body/i, secrets: /secret|\btoken|api key|password|credential/i, permissions: /\biam\b|policy|permission|grant|least privilege/i,
  personal_data: /personal|\bpii\b|e-?mail address|\bmembers?\b|\bnames?\b|\bcustomers?\b|\busers?'? (?:data|names?|e-?mails?)/i, dependencies: /dependenc|package|library version|requirements|lockfile/i,
  error_handling: /error|exception|raises?\b|retr(?:y|ies)|fails?\b|failure/i, concurrency: /concurren|race|idempoten|redeliver|at[- ]least[- ]once|twice|duplicate|dedup/i,
  state: /\bstate\b|status|transition/i, contracts: /contract|interface|schema|signature|requirement|acceptance/i };
const AREA_CATEGORY = { correctness: ["bug"], tests: ["test"], contracts: ["requirement"] };
// The findings of run `k` ("analysis" or a reviewer) that fall under `area`: by category where one fits, else by words.
export function areaFindings(area, k, findings) {
  const mine = (findings ?? []).filter((f) => (f.sources ?? [{ reviewer: f.reviewer }]).some((s) => s.reviewer === k));
  const words = AREA_WORDS[area], cats = AREA_CATEGORY[area] ?? [];
  return mine.filter((f) => cats.includes(f.category) || (words && words.test([f.title, f.effect, f.detail].filter(Boolean).join(" "))));
}

// ---- a state diagram's transitions and the findings at them
// The unresolved findings at each transition of a state visual: one whose file and line fall on the transition's place
// (`evidence` or `at`: "file:line" or "file:line-end"; a finding's own range counts). Returns Map(index in edges then
// transitions -> {findings, severity: the highest}); a transition without a place has none.
const RANK = { critical: 0, high: 1, medium: 2, low: 3 };
// Wave C2 V4: a finding marks only the transition it names, not every transition in its lines: by breaks.transition
// {from, to} with the states' ids (one of them alone: every move out of or into that state), else the transition(s) whose line is nearest its own, within NEAR_T lines (ties: all).
const NEAR_T = 3;
export function transitionMarks(v, findings) {
  const out = new Map(), place = (s) => /^(.+?):(\d+)(?:-(\d+))?/.exec(String(s ?? "")), eq = (x, y) => String(x ?? "").toLowerCase() === String(y ?? "").toLowerCase();
  const ts = [...(v?.edges ?? []), ...(v?.transitions ?? [])].map((e, i) => { const m = place(e.evidence) ?? place(e.at); return { e, i, m: m && [m[1], Number(m[2]), Number(m[3] ?? m[2])] }; });
  const add = (i, f) => { const x = out.get(i) ?? { findings: [] }; x.findings.push(f); out.set(i, x); };
  for (const f of findings ?? []) {
    // breaks.transition is the analysis' word for it (review.py place); a plain from and to are an older analysis' or a call on the map.
    const b = f.breaks?.transition ?? f.breaks, named = b && ts.filter(({ e }) => (b.from || b.to) && (!b.from || eq(b.from, e.from)) && (!b.to || eq(b.to, e.to)));
    if (named?.length) { named.forEach(({ i }) => add(i, f)); continue; }
    const lo = f.line ?? 0, hi = f.end ?? f.line ?? 0, file = (path) => f.file && (f.file === path || f.file.endsWith(`/${path}`) || path.endsWith(`/${f.file}`));
    const near = ts.filter(({ m }) => m && file(m[0]) && Math.max(0, m[1] - hi, lo - m[2]) <= NEAR_T), gap = ({ m }) => (lo >= m[1] && lo <= m[2] ? 0 : Math.abs(lo - m[1]));
    const best = Math.min(...near.map(gap));
    near.filter((t) => gap(t) === best).forEach(({ i }) => add(i, f));
  }
  for (const x of out.values()) x.severity = x.findings.map((f) => f.severity).sort((a, b) => (RANK[a] ?? 9) - (RANK[b] ?? 9))[0];
  return new Map([...out].sort(([a], [b]) => a - b));
}

// Where the runs' self-reports in "What each run checked" contradict each other or the findings: an area one run calls
// clean and another finds something in ("cross"), or one a run calls clean while an unresolved security finding names
// it in its effect, by the area's words ("effect": "personal data clean" and "they can read members' names"). tab: scopeTable;
// open: the unresolved findings. Returns Map(area -> {kind, text, findings}).
export function scopeConflicts(tab, open = []) {
  const out = new Map();
  for (const r of tab?.rows ?? []) {
    const cells = Object.entries(r.cells).filter(([, c]) => c), clean = cells.filter(([, c]) => c.result === "clean").map(([k]) => k), found = cells.filter(([, c]) => c.result === "finding").map(([k]) => k);
    if (!clean.length) continue;
    if (found.length) { out.set(r.area, { kind: "cross", text: `${clean.join(", ")} ${clean.length === 1 ? "calls" : "call"} it clean, ${found.join(", ")} ${found.length === 1 ? "finds" : "find"} something here.`, findings: [] }); continue; }
    // Only a finding about security says something an area of the security run should have seen.
    const words = AREA_WORDS[r.area], hit = words ? open.filter((f) => (f.security || ["unauthorized_access", "data_exposure"].includes(f.impact)) && words.test(String(f.effect ?? ""))) : [];
    if (hit.length) out.set(r.area, { kind: "effect", text: `Called clean, but ${hit.length === 1 ? "an unresolved finding names" : `${hit.length} unresolved findings name`} it in ${hit.length === 1 ? "its" : "their"} effect: ${hit.slice(0, 2).map((f) => f.title).join("; ")}.`, findings: hit });
  }
  return out;
}

// The state hints at the top of the Analysis tab, where they are seen instead of a grey line under the page: the PR
// head's checkout, an analysis waiting for it, reviewer runs. checkout: {busy} | {error} | null; runs: the findings
// file's runs (busy while one runs); names: kind -> label. -> [{key, text, spin, error}]
export function stateHints({ checkout = null, pendingRun = false, runs = {}, names = {} }) {
  return [
    checkout?.busy && { key: "checkout", spin: true, text: `Checking out the PR head${pendingRun ? ": the analysis starts once it is there" : ""}…` },
    checkout?.error && { key: "checkout", error: true, text: `Could not check out the PR head: ${checkout.error}` },
    pendingRun && !checkout && { key: "wait", text: "The analysis starts once the PR head is checked out." },
    ...Object.entries(runs ?? {}).filter(([, r]) => r?.busy).map(([k]) => ({ key: `run-${k}`, spin: true, text: `${names[k] ?? k} is running…` })),
  ].filter(Boolean);
}

// How the line under the right pane shows a note about an action just taken: an error (it did not happen) in red with
// a mark, kept until it is closed or the next action; anything else in the text color, gone by itself after ttl ms.
export const NOTE_TTL = 8000;
const NOTE_ERROR = /^(Could not|Not |Nothing to |Select a line|Line \d+ of .* is not in)|^No \S+ on |Could not/;
export const noteRule = (text) => (NOTE_ERROR.test(String(text ?? "")) ? { error: true, ttl: null } : { error: false, ttl: NOTE_TTL });
// ---- the zone a card is really reachable from (derived, not the model's word)
// A card behind a public way in whose check sits in the card's own code (auth_kind "code") or that nothing checks is
// reachable from the public side, whatever zone the analysis draws it in. Returns Map(node id -> {trust: "public",
// drawn: the drawn zone's trust, zone, why}) for the cards where the two differ.
export function effectiveZones(arch, access) {
  const zones = new Map((arch?.zones ?? []).map((z) => [z.id, z])), out = new Map();
  for (const x of access ?? []) {
    const n = (arch?.nodes ?? []).find((m) => m.id === x?.node), z = zones.get(n?.zone), open = exposureOf(x) === "open";
    if (!x?.public || !n || !z || z.trust === "public" || !(x.auth_kind === "code" || open) || out.has(n.id)) continue;
    out.set(n.id, { trust: "public", drawn: z.trust, zone: z, why: open ? "nothing checks the caller before it" : `its only check (${x.auth || "in the code"}) is in its own code, so every request from the internet reaches it` });
  }
  return out;
}

// ---- the Security page as a boundary map (panel-secview, panel-check): the crossings of trust boundaries
// Every crossing the data names: a way in from the public side (an access row that is public), a right that reaches
// into another zone (an access row whose principal is a frame or a card of one), a call over a boundary (an edge with
// `crosses`, or between cards of different zones), a call in the same process that bypasses a boundary (kind
// "bypass": no crossing, but code written for another way in gets this caller's input), and an operator's way (kind
// "operator": access rows of principal_kind operator or ci; without them, one derived from a gate whose condition
// names configuration or a secret). Each row: {key, kind, from, to: {name, trust}, identity (who arrives: the access
// row's principal), expects (the gate's principal), check, at, holds_if, carries, change, result: finding | mitigated
// | not_assessed (from threats[] only: a named threat's result, or a finding a threat names or that names exactly this
// crossing), reason (why not assessed), findings, threats (named ones), stride, goal, path (node ids, from a threat),
// conflicts (findings whose own place and their threat's disagree), unmapped (a right whose principal is no card or
// frame), unused (a right granted but not used), ends: {from, to} (card ids, null outside), access?, edge?}.
export const TRUST_ORDER = ["public", "operator", "authenticated", "internal", "data"]; // operator: a workstation or CI runner outside the system
// What a card runs in: runs_in as a list (a library in several Lambdas) or one id (older analyses); [] when none.
export const runsIn = (n) => (Array.isArray(n?.runs_in) ? n.runs_in.filter(Boolean) : n?.runs_in ? [n.runs_in] : []);
// Of several zones the most exposed one (public before authenticated before internal before data).
const outermost = (zs) => zs.filter(Boolean).sort((a, b) => TRUST_ORDER.indexOf(a.trust) - TRUST_ORDER.indexOf(b.trust))[0] ?? null;
// A gate's check in words: its kind and where it sits ("token, in the code"); null without a check.
const checkText = (g) => (g?.check ? `${g.check}${g.source ? `, in the ${g.source === "code" ? "code" : "config"}` : ""}` : null);
const CHANGED = ["added", "widened", "narrowed", "changed", "removed"];
// A name without spaces, case or a generic last word, so "FrontDesk function" is the frame "Front desk Lambda".
const nameKey = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/(function|lambda|role|service|deployment|container|task|job)$/, "");
// A call in one process (no boundary): the data says so, or its words do. ponytail: the words only until every
// analysis sets in_process.
export const inProcess = (e) => (typeof e?.in_process === "boolean" ? e.in_process : /\bin[- ]process\b|\bimports?\b|\bin the same process\b/i.test(String(e?.label ?? "")));
// A gate's condition that names configuration or a secret: someone sets it at deploy time (an operator's way).
const CONFIG = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\bsecret|\benv(?:ironment)?\b|\bconfig|\bparameter|\bvariable/;
// gates: the security run's checks per crossing ({where: {access} | {from, to, edge}, principal, check, at, source,
// holds_if, carries}); a gate on the row itself (x.gate, e.gate) is the older place. A threat with `derived` is a
// placeholder ("no threat was named") and names no result.
// bypasses: the security run's calls in one process that bypass a boundary ({from, to, edge}); without them (an
// older run), a call in one process bypasses one when the code it reaches also gets calls from another frame.
export function crossingsOf({ arch = null, access = [], threats = [], findings = [], gates = [], bypasses = [] } = {}) {
  const zones = arch?.zones ?? [], nodes = arch?.nodes ?? [], groups = arch?.groups ?? [], edges = arch?.edges ?? [];
  const zone = (id) => zones.find((z) => z.id === id) ?? null, node = (id) => nodes.find((n) => n.id === id);
  // A card's zone: the zone of what it runs in (runs_in), else its own. A frame's zone: the one its cards share.
  const zoneOfFrame = (gid) => zone(nodes.find((n) => n.group === gid && n.zone && !runsIn(n).length)?.zone ?? nodes.find((n) => n.group === gid && n.zone)?.zone);
  const zoneOfNode = (nid, seen = 0) => { const n = node(nid); if (!n) return zoneOfFrame(nid); const r = runsIn(n).filter((x) => x !== nid); return r.length && seen < 4 ? outermost(r.map((x) => zoneOfNode(x, seen + 1))) ?? zone(n.zone) : zone(n.zone); };
  const label = (nid) => node(nid)?.label ?? groups.find((g) => g.id === nid)?.label ?? nid;
  // The card or frame a principal is: principal_node, else the frame or card of that name; null: not mapped.
  const principalNode = (x) => (x.principal_node !== undefined ? x.principal_node
    : groups.find((g) => nameKey(g.label) && nameKey(g.label) === nameKey(x.principal))?.id ?? nodes.find((n) => n.id === x.principal || (nameKey(n.label) && nameKey(n.label) === nameKey(x.principal)))?.id ?? null);
  const cardOf = (pid) => (node(pid) ? pid : nodes.find((n) => n.group === pid)?.id ?? null); // a frame: its first card
  const z = (x) => (x ? { name: x.name ?? x.id, trust: x.trust ?? null } : { name: "no zone named", trust: null });
  const named = (threats ?? []).filter((t) => !t.derived), byId = new Map((access ?? []).map((x) => [x.id, x]));
  // Where a finding belongs: the access rows its threats place it at, and its own reachable_from. When they disagree,
  // the outer one counts (public before the rest) and the finding is marked (or the data's own reach_conflict).
  const conflicts = new Map(), homeOf = new Map();
  for (const f of findings ?? []) {
    const ids = f.ids ?? [f.id], byThreat = [...new Set(named.filter((t) => (t.findings ?? []).some((i) => ids.includes(i)) && t.where?.access).map((t) => t.where.access))];
    const own = f.reachable_from ?? [], clash = byThreat.length && own.length && !own.some((a) => byThreat.includes(a));
    const all = [...new Set([...byThreat, ...own])], outer = all.filter((a) => byId.get(a)?.public);
    homeOf.set(f, clash ? (outer.length ? outer : byThreat) : all);
    // The run's own reach_conflict ({finding: {reachable_from}, threat: {where}}) says the same in its words.
    const rc = f.reach_conflict, where = rc?.threat?.where;
    if (rc) conflicts.set(f.id, { finding: rc.finding?.reachable_from ?? own, threat: [where?.access ?? where?.edge ?? (where?.from ? `${where.from} → ${where.to}` : null)].filter(Boolean), conflict: rc });
    else if (clash) conflicts.set(f.id, { finding: own, threat: byThreat, conflict: null });
  }
  const RESULT = { finding: "finding", mitigated: "mitigated", checked_clean: "mitigated", not_assessed: "not_assessed", not_checked: "not_assessed" };
  // The verdict of a crossing from its threats (placeholders and defects aside: a defect, "not an attacker goal", says
  // nothing about the boundary) and the findings they cite or that name exactly this crossing (own).
  const judge = (ts, own) => {
    const ns = ts.filter((t) => !t.derived), real = ns.filter((t) => !isDefect(t)), cited = new Set(real.flatMap((t) => t.findings ?? []));
    const fs = [...new Set([...own, ...(findings ?? []).filter((f) => (f.ids ?? [f.id]).some((i) => cited.has(i)))])];
    const results = real.map((t) => RESULT[t.result]).filter(Boolean);
    const result = fs.length || results.includes("finding") ? "finding" : results.includes("mitigated") ? "mitigated" : "not_assessed";
    // Why not assessed: the run's own reason at a threat it named (its note), before the placeholder's.
    const said = real.find((t) => String(t.note ?? "").trim());
    const reason = result !== "not_assessed" ? null : ns.some(isDefect) ? "Only a defect is named here, not what an attacker could do across this boundary."
      : said ? `The run named a threat here and left it open: ${String(said.note).trim().replace(/\.$/, "")}.` : (ts.find((t) => t.derived)?.threat || "No threat names this crossing.");
    return { result, reason, findings: fs, threats: ns, stride: [...new Set(real.map((t) => t.stride).filter(Boolean))].join(""), goal: real.map((t) => t.goal).find(Boolean) ?? null,
      path: ns.map((t) => t.path).find((p) => Array.isArray(p) && p.length > 1) ?? null, evidence: ns.map((t) => t.evidence).find(Boolean) ?? null,
      conflicts: fs.filter((f) => conflicts.has(f.id)).map((f) => ({ f, ...conflicts.get(f.id) })), _ts: ts, _own: own };
  };
  // A finding about security that names exactly this crossing: ⛨ (isSecurity), or of the category security (a right
  // granted and never used, low).
  const row = (base, match) => ({ ...base, ...judge((threats ?? []).filter(match.threat), (findings ?? []).filter((f) => (secByEffect(f) || f.category === "security") && match.finding(f))) });
  // The frame a card runs in (runs_in naming a frame, else its group): who calls is that deployment's identity.
  const frameOf = (nid) => { const n = node(nid); return n ? (runsIn(n).find((x) => groups.some((g) => g.id === x)) ?? n.group) : groups.some((g) => g.id === nid) ? nid : null; };
  const changeOf = (x) => x.change ?? (x.opened_by_pr === true ? "added" : x.opened_by_pr === false ? "unchanged" : null);
  const rows = [];
  for (const x of access ?? []) {
    if (notCrossing(x, threats, findings)) continue; // a guard, or a right on something the map does not show: asideOf
    const to = zoneOfNode(x.node), gate = (gates ?? []).find((g) => g.where?.access === x.id) ?? x.gate ?? {}, op = ["operator", "ci"].includes(x.principal_kind);
    // A way in starts outside, with whoever arrives (the principal); a right starts at its principal's frame or card.
    const pn = x.public ? null : principalNode(x), from = x.public ? null : pn ? zoneOfNode(pn) : null;
    // A right inside one zone crosses nothing by itself; it still folds into the call that uses it (below).
    const inner = !x.public && !op && from && to && from.trust === to.trust && from.name === to.name;
    rows.push(row({ inner, key: `a:${x.id ?? x.resource}`, kind: op ? "operator" : x.public ? "entry" : "right", from: x.public ? { name: x.principal || "Internet", trust: "public" } : pn ? z(from) : { name: x.principal ?? "unnamed", trust: null },
      to: z(to), identity: x.principal ?? null, expects: gate.principal ?? null, check: checkText(gate) ?? x.auth ?? null, at: gate.at ?? x.at ?? null, holds_if: gate.holds_if ?? null,
      carries: gate.carries ?? null, change: changeOf(x), ends: { from: pn && !op ? cardOf(pn) : null, to: x.node ?? null }, _pn: pn, access: x, what: x.resource ?? "", actions: x.actions ?? [],
      unmapped: !x.public && !op && !pn, unused: x.used === false, ...(op ? { valueFrom: x.value_from ?? null, derived: Boolean(x.derived) } : {}) },
    { threat: (t) => t.where?.access === x.id, finding: (f) => (homeOf.get(f) ?? []).includes(x.id) }));
  }
  edges.forEach((e, i) => {
    const a = zoneOfNode(e.from), b = zoneOfNode(e.to), gate = (gates ?? []).find((g) => g.where?.edge === `e${i}` || (g.where?.from === e.from && g.where?.to === e.to)) ?? e.gate ?? {};
    const st = e.status === "new" ? "added" : e.status === "changed" || e.changed ? "changed" : e.status === "unchanged" ? "unchanged" : null;
    const match = { threat: (t) => t.where?.edge === `e${i}` || (t.where?.from === e.from && t.where?.to === e.to), finding: (f) => f.breaks?.edge === `e${i}` || (f.breaks?.from === e.from && f.breaks?.to === e.to) };
    const base = { key: `e:${i}`, from: z(a), to: z(b), identity: frameOf(e.from) && !node(frameOf(e.from)) && frameOf(e.from) !== frameOf(e.to) ? label(frameOf(e.from)) : label(e.from), expects: gate.principal ?? null, check: checkText(gate), at: gate.at ?? null, holds_if: gate.holds_if ?? null,
      carries: gate.carries ?? null, change: st, ends: { from: e.from, to: e.to }, edge: i, what: e.label ?? "" };
    // In one process: no crossing. It bypasses a boundary when the code it reaches also gets calls from another frame
    // (a consumer written for a queue, here called directly), or the data marks it as a crossing.
    if (inProcess(e) || (node(e.from)?.group && node(e.from)?.group === node(e.to)?.group && !e.crosses)) {
      const other = edges.some((x, j) => j !== i && x.to === e.to && node(x.from)?.group !== node(e.to)?.group && !inProcess(x));
      const named = (bypasses ?? []).length ? bypasses.some((x) => x.edge === `e${i}` || (x.from === e.from && x.to === e.to)) : inProcess(e) && (e.crosses || other);
      if (named) rows.push(row({ ...base, kind: "bypass", check: null, what: `${e.label ?? "a direct call"}: bypasses the boundary of ${label(e.to)}` }, match));
      return;
    }
    if (!e.crosses && !(a && b && a.id !== b.id)) return;
    if (node(e.from)?.type === "external" && (access ?? []).some((x) => x.public && x.node === e.to)) return; // the way in's row says it
    rows.push(row({ ...base, kind: "call" }, match));
  });
  // A right and a call on the same boundary (the principal's frame, the same target) are one crossing: the call's
  // check and what crosses, the right's identity, actions and use, the threats of both (nothing drops out unseen).
  for (const r of rows.filter((x) => x.kind === "right")) {
    const c = rows.find((x) => x.kind === "call" && x.ends.to === r.ends.to && (r.inner || (r.ends.from && frameOf(x.ends.from) === frameOf(r.ends.from))));
    if (!c) continue;
    const merged = { ...c, ...judge([...new Set([...c._ts, ...r._ts])], [...new Set([...c._own, ...r._own])]), kind: "right", aliases: [r.key], identity: r.identity, access: r.access, actions: r.actions,
      unused: r.unused, unmapped: r.unmapped, what: `${r.what}${r.actions?.length ? ` (${r.actions.join(", ")})` : ""}; call: ${c.what}`, check: c.check ?? r.check, at: c.at ?? r.at, change: r.change ?? c.change,
      from: r.inner ? c.from : r.from, ends: { from: c.ends.from, to: c.ends.to } };
    rows.splice(rows.indexOf(c), 1, merged); rows.splice(rows.indexOf(r), 1);
  }
  for (const r of rows.filter((x) => x.inner)) rows.splice(rows.indexOf(r), 1);
  // An operator's script or workflow is a card of its own: the operator's way is that row and the card's one call over
  // a boundary together (who runs it, with which credentials, what it reaches), not a way to the script and a call.
  for (const o of rows.filter((x) => x.kind === "operator" && !x.derived && (x.ends.to || node(x._pn)))) {
    // The row sits at the script itself (its one call out; the script is the row's card or, without one, its principal),
    // or at what the script reaches (the call there from the operator's frame).
    const script = o.ends.to ?? o._pn, out = rows.filter((x) => x.kind === "call" && x.ends.from === script), into = rows.filter((x) => x.kind === "call" && o.ends.to && x.ends.to === o.ends.to && o._pn && [x.ends.from, frameOf(x.ends.from)].includes(o._pn));
    const calls = out.length ? out : into;
    if (calls.length !== 1) continue;
    const c = calls[0], merged = { ...o, ...judge([...new Set([...o._ts, ...c._ts])], [...new Set([...o._own, ...c._own])]), aliases: [c.key], to: c.to, edge: c.edge,
      what: `${o.what}${o.actions?.length ? ` (${o.actions.join(", ")})` : ""}; call: ${c.what}`, check: o.check ?? c.check, at: o.at ?? c.at, ends: { from: c.ends.from, to: c.ends.to } };
    rows.splice(rows.indexOf(o), 1, merged); rows.splice(rows.indexOf(c), 1);
  }
  // Two derived operator ways that say the same (an older run: one per check, both "configuration") are one.
  const sameOp = (r) => `${r.identity}\u0000${r.what}\u0000${r.ends.to}`;
  for (const r of rows.filter((x) => x.kind === "operator" && x.derived)) if (rows.find((x) => x.kind === "operator" && x.derived && sameOp(x) === sameOp(r)) !== r) rows.splice(rows.indexOf(r), 1);
  // An operator's way that sets what a check holds on: new with that check, and the findings that say the check fails.
  for (const o of rows.filter((x) => x.kind === "operator")) {
    const vars = String(`${o.what} ${(o.actions ?? []).join(" ")} ${o.access?.resource ?? ""}`).match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g) ?? [];
    const door = rows.find((x) => x !== o && x.holds_if && vars.some((v) => x.holds_if.includes(v)));
    if (!door) continue;
    const broken = door.findings.filter((f) => secByEffect(f) || f.impact === "unauthorized_access");
    Object.assign(o, { change: o.change && o.change !== "unchanged" ? o.change : door.change, breaks: door.key, findings: [...new Set([...(o.findings ?? []), ...broken])], result: broken.length ? "finding" : o.result, reason: broken.length ? null : o.reason });
  }
  // No operator way in the data, but a gate's condition names configuration or a secret: whoever deploys sets it.
  if (!rows.some((r) => r.kind === "operator")) for (const r of [...rows]) {
    const v = CONFIG.exec(String(r.holds_if ?? ""));
    if (v) rows.push({ key: `o:${r.key}`, kind: "operator", from: { name: "Operator (deploy)", trust: null }, to: r.to, identity: "whoever deploys", expects: null, check: null, at: r.at, holds_if: null,
      carries: null, change: null, ends: { from: null, to: r.ends.to }, what: `sets ${/^[A-Z]/.test(v[0]) ? v[0] : "the configuration"} that check ${rows.indexOf(r) + 1} holds on`, result: "not_assessed",
      reason: "Derived from the condition of a check: the data names no operator way.", findings: [], threats: [], stride: "", goal: null, path: null, evidence: null, conflicts: [], derived: true });
  }
  return rows;
}
// An access row that is no crossing: a guard (pr.js isGuard: a rule that takes a right away protects its resource), or
// a right of a mapped principal on something the map does not show (a role's own log group) that no threat and no
// finding names. Both stay on the page under the crossings (asideOf), so nothing is lost.
const namedAt = (x, threats, findings) => (threats ?? []).some((t) => !t.derived && t.where?.access === x.id) || (findings ?? []).some((f) => (f.reachable_from ?? []).includes(x.id));
const offMap = (x, threats, findings) => !x.public && !["operator", "ci"].includes(x.principal_kind) && Boolean(x.principal_node) && !x.node && !namedAt(x, threats, findings);
const notCrossing = (x, threats, findings) => isGuard(x) || offMap(x, threats, findings);
// → {guards: [{row, text, threats: the named ones at it}], rights: [{row, text}]}: a guard as "Guard at <its card or
// resource>: denies <what> to <who> (<rule>, <at>)", a right as "<who> may <what> on <resource> (<kind>, <at>)".
export function asideOf({ arch = null, access = [], threats = [], findings = [] } = {}) {
  const label = (id) => (arch?.nodes ?? []).find((n) => n.id === id)?.label ?? null, plainAct = (a) => String(a).replace(/^\s*(deny|denies|block|blocks)\s+/i, "");
  const tail = (x) => [x.auth, x.at].filter(Boolean).join(", ");
  // holds: what the rule stops in the run's words; loosened: the PR narrows or removes it (a finding candidate).
  return { guards: (access ?? []).filter(isGuard).map((x) => ({ row: x, threats: (threats ?? []).filter((t) => !t.derived && t.where?.access === x.id),
      holds: String(x.holds_against ?? "").trim() || null, loosened: ["narrowed", "removed"].includes(x.change) ? x.change : null,
      text: `Guard at ${label(x.node) ?? x.resource}: denies ${(x.actions ?? []).map(plainAct).join(", ") || "access"} to ${x.principal || "everyone else"}${tail(x) ? ` (${tail(x)})` : ""}.` })),
    rights: (access ?? []).filter((x) => !isGuard(x) && offMap(x, threats, findings)).map((x) => ({ row: x,
      text: `${x.principal || "A principal"} may ${(x.actions ?? []).join(", ") || "act"} on ${x.resource}${[x.kind, x.at].filter(Boolean).length ? ` (${[x.kind, x.at].filter(Boolean).join(", ")})` : ""}${x.used === false ? ", granted and not used" : ""}.` })) };
}
// A guard as one line for the page and the export: what it denies, what it holds against (the threats at it, else the
// run's holds_against) and, when the PR narrows or removes it, that this is to check. code: how a file:line is written.
export const guardLine = (g, code = (s) => s) => `${g.text}${g.threats.length ? g.threats.map((x) => ` Holds against: ${String(x.threat ?? "").replace(/\.$/, "")} (${String(x.result ?? "").replace(/_/g, " ")}${x.evidence ? `, ${code(x.evidence)}` : ""}).`).join("")
  : g.holds ? ` Holds against: ${g.holds.replace(/\.$/, "")}.` : " The run does not say what it holds against."}${g.loosened ? ` This PR ${g.loosened === "removed" ? "removes" : "narrows"} it: check what it no longer stops.` : ""}`;
// The unresolved findings a named threat cites (a defect named as a threat aside): what the threat model stands on,
// whatever their effect is called. findings: the unresolved ones; ids as in mergeFindings.
export const threatCited = (threats, findings) => { const cited = new Set((threats ?? []).filter((t) => !t.derived && !isDefect(t)).flatMap((t) => t.findings ?? []));
  return (findings ?? []).filter((f) => (f.ids ?? [f.id]).some((i) => cited.has(i))); };
// What a taken-over principal behind a way in may do: the rights (guards aside) of every principal whose card or frame
// stands in the zone of a way in's card, by principal, each right on its card's label or, off the map, its resource.
// [{principal, node, frame, rights: [{actions, on, used}], text}]; [] without a way in or without zones.
export function blastOf(arch, access) {
  const nodes = arch?.nodes ?? [], node = (id) => nodes.find((n) => n.id === id), zoneOf = (id) => node(id)?.zone ?? nodes.find((n) => n.group === id && n.zone)?.zone ?? null;
  const doors = new Set((access ?? []).filter((x) => x.public).map((x) => zoneOf(x.node)).filter(Boolean)), by = new Map();
  for (const x of access ?? []) {
    if (x.public || isGuard(x) || ["operator", "ci"].includes(x.principal_kind) || !x.principal_node || !doors.has(zoneOf(x.principal_node))) continue;
    if (!by.has(x.principal)) by.set(x.principal, { node: x.principal_node, rights: [] });
    by.get(x.principal).rights.push({ actions: x.actions ?? [], on: node(x.node)?.label ?? ([x.kind, x.resource].filter(Boolean).join(" ") || "a resource"), used: x.used });
  }
  // node: the principal's card or frame; frame: the frame that is or holds it (review.js adds what it reaches in one process).
  return [...by].map(([principal, { node: pn, rights }]) => ({ principal, node: pn, frame: node(pn)?.group ?? pn, rights,
    text: `If ${principal} is taken over, it can ${rights.map((r) => `${r.actions.join(", ") || "act"} on ${r.on}${r.used === false ? " (granted, not used)" : ""}`).join("; ")}.` }));
}
// A run's "left out" line without the words about its tools ("git diff not run: Bash denied, read the files" → "git
// diff not run: read the files"): what it did not look at stays.
export const skipText = (s) => String(s ?? "").replace(/(?:\bthe\s+)?\b(bash|tool|permission|sandbox|shell)\b:?[^,.;:()]*\b(denied|refused|not allowed|blocked|not available|unavailable)\b\s*[,;:]?\s*(?:(?:so|and)\s+)?/gi, "").trim();

// Whether a crossing is new or changed in this PR (not said counts as such: better shown than hidden).
// An operator's way derived from a gate's condition belongs to that gate, so it shows with it whatever its own change.
export const crossingChanged = (r) => r.change === null || CHANGED.includes(r.change) || (r.kind === "operator" && Boolean(r.derived));

// The sentence over the Security page, from the data: the door and its check, the condition it holds on and whether a
// finding says it breaks, what lies behind it, the other changes, and how many crossings are assessed. "Security · 0"
// is never alone.
// openSecurity: the unresolved security findings counted once per cause (pr.js findingCounts), as the verdict counts.
export function secSentence(rows, openSecurity = 0, cited = 0, loosened = 0) {
  const now = (rows ?? []).filter(crossingChanged), n = (k) => now.filter((r) => r.kind === k).length;
  const many = (c, one, more) => `${c} ${c === 1 ? one : more}`;
  const door = (r) => {
    // The finding that says the check does not hold: about access or data by its own effect (a finding that is ⛨ only
    // because a threat stands on it, a flood, says nothing about the check).
    const top = r.findings.filter((f) => f.impact === "unauthorized_access" || secByEffect(f)).sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9))[0];
    const broken = top && ["critical", "high"].includes(top.severity);
    return `The way in is ${r.what || r.to.name}, open to ${r.identity ?? "the outside"}; ${r.check ? `its check (${r.check})` : "no check is named"}${r.holds_if ? ` holds only if ${r.holds_if.replace(/\.$/, "")}` : r.check ? " is named without its condition" : ""}${broken ? `, and an unresolved ${top.severity} finding says it does not: ${top.title.replace(/\.$/, "")}` : ""}.${r.goal ? ` Behind it: ${r.goal.replace(/\.$/, "")}.` : ""}`;
  };
  const doors = now.filter((r) => r.kind === "entry").map(door);
  const more = [n("right") && many(n("right"), "right into another zone", "rights into another zone"), n("call") && many(n("call"), "call over a trust boundary", "calls over a trust boundary"),
    n("bypass") && many(n("bypass"), "call that bypasses a boundary", "calls that bypass a boundary"), n("operator") && many(n("operator"), "operator way", "operator ways")].filter(Boolean);
  const first = doors.length ? doors.join(" ") : "This PR opens no way in from the public side that the data names.";
  const rest = more.length ? ` It also adds or changes ${more.length > 1 ? `${more.slice(0, -1).join(", ")} and ${more.at(-1)}` : more[0]}.` : "";
  const na = now.filter((r) => r.result === "not_assessed").length;
  const tally = !now.length ? "" : !na ? ` ${now.length === 1 ? "The crossing is" : `All ${now.length} crossings are`} assessed.` : ` ${now.length - na} of ${many(now.length, "crossing", "crossings")} ${now.length - na === 1 ? "is" : "are"} assessed, ${na} not assessed.`;
  // cited: unresolved findings a threat stands on that are no ⛨ finding (their effect is not access or data).
  const also = cited ? ` ${many(cited, "other unresolved finding backs", "other unresolved findings back")} a threat named here.` : "";
  // loosened: guards (rules that take a right away) this PR narrows or removes.
  const guards = loosened ? ` It narrows or removes ${many(loosened, "guard", "guards")}.` : "";
  return `${first}${rest}${guards}${tally} ${openSecurity ? `${many(openSecurity, "security cause is", "security causes are")} unresolved.` : cited ? "No finding about access or data is unresolved." : "No security finding is unresolved."}${also}`;
}

// The security run's effective zones ([{node, drawn, effective, where}], derived from its gates) in the shape of
// effectiveZones: Map(node id -> {trust, drawn, zone, why}); empty list: none.
export function effectiveFrom(list, arch) {
  const zones = arch?.zones ?? [], zoneOf = (nid) => zones.find((z) => z.id === (arch?.nodes ?? []).find((n) => n.id === nid)?.zone) ?? null, out = new Map();
  // where: the place whose check must fail ({access} or {edge}, or a "file:line"); via: the calls in one process it came along.
  for (const x of list ?? []) if (x?.node && x.effective && x.effective !== x.drawn) out.set(x.node, { trust: x.effective, drawn: x.drawn, zone: zoneOf(x.node) ?? { name: x.drawn, trust: x.drawn }, where: x.where ?? null, via: x.via ?? [],
    why: x.via?.length ? `it is called in one process without a check (${x.via.join(", ")})` : typeof x.where === "string" ? `its first check is at ${x.where}` : "its first check is in its own code" });
  return out;
}

// ---- the architecture map with the boundary as it really runs (panel check, wave 5)
// The analysis' picture for Architecture impact: a card runs in what it is deployed in, so code without a deployment
// of its own takes the zone of what it runs in (runs_in) or, in a frame of shared code, none (no zone dot); a call in
// one process crosses nothing ("‖" off) and, when it reaches code that also gets calls from another frame or the run
// marked it as a crossing, `bypass`; a caller from outside is a card "Internet" (the outermost principal) with a call
// to each public way in, the "‖" on it. The calls keep their indexes (the new ones come last).
const SHARED = /librar|shared|common|module|package|util/i;
export function mapArch(arch, access = [], bypasses = []) {
  if (!arch) return arch;
  const nodes = arch.nodes ?? [], node = (id) => nodes.find((n) => n.id === id), frame = (id) => (arch.groups ?? []).find((g) => g.id === node(id)?.group);
  // runs_in names a card or a frame (a deployment): a frame's zone is the one its own cards carry.
  // Several (a library in two Lambdas): the most exposed of them.
  const frameZone = (gid) => nodes.find((n) => n.group === gid && n.zone && !runsIn(n).length)?.zone;
  const zid = (id) => (arch.zones ?? []).find((z) => z.id === id), pick = (ids) => outermost(ids.map(zid))?.id ?? ids.find(Boolean);
  const zoneOf = (n, k = 0) => (runsIn(n).length && k < 4 ? pick(runsIn(n).map((x) => (node(x) ? zoneOf(node(x), k + 1) : frameZone(x)))) ?? n.zone : SHARED.test(frame(n?.id)?.label ?? "") && k === 0 ? undefined : n?.zone);
  const feeds = (e, i) => (arch.edges ?? []).some((x, j) => j !== i && x.to === e.to && node(x.from)?.group !== node(e.to)?.group && !inProcess(x));
  const named = (e, i) => ((bypasses ?? []).length ? bypasses.some((x) => x.edge === `e${i}` || (x.from === e.from && x.to === e.to)) : Boolean(e.crosses || feeds(e, i)));
  const edges = (arch.edges ?? []).map((e, i) => (inProcess(e) ? { ...e, crosses: false, bypass: named(e, i) } : e));
  // A way in the analysis already draws a caller from outside for (an external card that calls it) needs no other.
  const doors = (access ?? []).filter((x) => x.public && node(x.node) && !(arch.edges ?? []).some((e) => e.to === x.node && node(e.from)?.type === "external"));
  const out = { ...arch, nodes: nodes.map((n) => ({ ...n, zone: zoneOf(n) })), edges };
  if (!doors.length) return out;
  const who = doors.map((x) => x.principal).filter(Boolean);
  return { ...out, groups: [{ id: "\0outside", label: "Outside", kind: "" }, ...(arch.groups ?? [])],
    nodes: [{ id: "\0in", label: "Internet", type: "external", group: "\0outside", status: "unchanged", description: [...new Set(who)].join(", ") || "callers from outside" }, ...out.nodes],
    edges: [...edges, ...doors.map((x) => ({ from: "\0in", to: x.node, label: x.resource ?? "", crosses: true, status: x.change === "added" || x.opened_by_pr ? "new" : undefined, evidence: x.at }))] };
}

// ---- a GitHub comment as the review shows it (review.js item "gh")

// GitHub renders the HTML in a comment; TextView.markdown shows most of it as raw text and the list's height counts
// it too (a bot's badge line alone is hundreds of letters). ghMd turns the HTML GitHub renders into Markdown: HTML
// comments go, <details> folds to its summary unless `open` (as on GitHub), a picture or badge becomes its alt text as a
// chip, an image a link, <br> a line break, tables a Markdown table, <pre> a fence; a tag GitHub drops (an unknown
// element) goes and keeps its text; code (fences, `inline`) stays as it is. A type like `Vec<T>` is no tag and stays.
const ENTITY = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", mdash: "—", ndash: "–", hellip: "…" };
const entities = (s) => s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e) => ENTITY[e.toLowerCase()] ?? (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : m));
const GH_TAG = /<\/?(?:a|abbr|b|blockquote|br|caption|center|code|dd|del|details|div|dl|dt|em|font|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|picture|pre|q|s|samp|small|source|span|strike|strong|sub|summary|sup|table|tbody|td|tfoot|th|thead|tr|tt|u|ul|var|[a-z]+-[a-z-]+)\b[^>]*>/gi;
const attr = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((x) => x !== undefined) ?? "";
const inner = (html) => entities(html.replace(GH_TAG, "")).replace(/\s+/g, " ").trim();
function htmlTable(t) {
  const rows = [...t.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => inner(c[2]).replace(/\|/g, "\\|")));
  if (!rows.length) return inner(t);
  const n = Math.max(...rows.map((r) => r.length)), line = (r) => `| ${[...r, ...Array(n - r.length).fill("")].join(" | ")} |`;
  return `\n\n${line(rows[0])}\n|${" --- |".repeat(n)}\n${rows.slice(1).map(line).join("\n")}\n\n`;
}
export function ghMd(body, open = false) {
  const keep = [], hold = (x) => `\u0000${keep.push(x) - 1}\u0000`;
  let s = String(body ?? "").replace(/\r/g, "").replace(/<!--[\s\S]*?(-->|$)/g, "");
  // Code first, held out of everything below: fences, <pre>, inline code.
  s = s.replace(/^([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*|$)/gm, (m) => hold(m));
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, x) => `\n\n${hold(`\`\`\`\n${entities(x.replace(/<\/?code\b[^>]*>/gi, "")).replace(/\n$/, "")}\n\`\`\``)}\n\n`);
  s = s.replace(/(`+)[^`\n]+?\1/g, (m) => hold(m));
  // <details>, innermost first: its summary as a line; its content only when open.
  for (let k = 0; k < 20 && /<details\b/i.test(s); k++) {
    s = s.replace(/<details\b[^>]*>((?:(?!<details\b)[\s\S])*?)(<\/details>|$)/i, (_m, x) => {
      const sum = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(x), rest = sum ? x.replace(sum[0], "") : x, title = (sum && inner(sum[1])) || "Details";
      return `\n\n**${open ? "▾" : "▸"} ${title}**\n\n${open ? `${rest}\n\n` : ""}`;
    });
  }
  s = s.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, htmlTable);
  s = s.replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, (m) => { const a = attr(/<img\b[^>]*>/i.exec(m)?.[0] ?? "", "alt"); return a ? hold(`\`${a}\``) : ""; });
  s = s.replace(/<img\b[^>]*>/gi, (m) => { const a = attr(m, "alt"), src = attr(m, "src"); return src ? `[🖼 ${a || "image"}](${src})` : a; });
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, a, x) => { const href = attr(`<a ${a}>`, "href"), t = x.trim(); return href && t ? `[${t}](${href})` : t; });
  s = s.replace(/^[ \t]*<br\s*\/?>[ \t]*$/gim, "\n").replace(/<br\s*\/?>/gi, "  \n");
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, x) => `\n\n${"#".repeat(Number(n))} ${x.trim()}\n\n`);
  s = s.replace(/<\/?(?:strong|b)\b[^>]*>/gi, "**").replace(/<\/?(?:em|i)\b[^>]*>/gi, "*").replace(/<\/?(?:del|s|strike)\b[^>]*>/gi, "~~").replace(/<\/?(?:code|kbd|tt|samp)\b[^>]*>/gi, "`");
  s = s.replace(/<hr\b[^>]*>/gi, "\n\n---\n\n").replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/?(?:p|div|ul|ol|blockquote|dl|center)\b[^>]*>/gi, "\n\n");
  s = entities(s.replace(GH_TAG, ""));
  s = s.replace(/\]\(([^)\s]+)\s+"[^"]*"\)/g, "]($1)"); // a link's title shows on hover on GitHub; here it would show as text
  s = s.replace(/[ \t]+\n(?!\n)/g, (m) => (m.startsWith("  ") ? "  \n" : "\n")).replace(/\n{3,}/g, "\n\n").trim();
  return s.replace(/\u0000(\d+)\u0000/g, (_m, k) => keep[Number(k)]).replace(/\u0000(\d+)\u0000/g, (_m, k) => keep[Number(k)]);
}
// A Markdown text cut at its fenced code blocks, which the review draws itself (their font follows the card, and
// their height is exact): [{text}] and [{code: lines, lang}] in order; a block without its closing fence runs to the end.
export function mdBlocks(md) {
  const out = [], lines = String(md ?? "").split("\n");
  let text = [];
  const flush = () => { const t = text.join("\n").trim(); if (t) out.push({ text: t }); text = []; };
  for (let i = 0; i < lines.length; i++) {
    const f = /^[ \t]*(```+|~~~+)\s*([\w+-]*)/.exec(lines[i]);
    if (!f) { text.push(lines[i]); continue; }
    flush();
    const code = [];
    for (i++; i < lines.length && !lines[i].trimStart().startsWith(f[1]); i++) code.push(lines[i]);
    out.push({ code, lang: f[2] || "" });
  }
  flush();
  return out;
}

// ---- the Resilience page (CONCEPT-RESILIENCE.md): pure helpers for the view
// Before the run: where it would start, counted from the picture and the ways in without a model ("This PR adds 1
// queue, 2 Lambdas and 1 public route."). nodes: the cards to mark with ○. ponytail: a rough count by type and frame
// words until the data's own count (ai.resilienceStart) is there.
export function resStartOf(arch, access = []) {
  const nodes = arch?.nodes ?? [], groups = arch?.groups ?? [], isNew = (x) => x.status === "new" || x.status === "added";
  const queues = nodes.filter((n) => /queue|sqs|topic|stream|bus/i.test(`${n.type ?? ""} ${n.label ?? ""}`));
  const fns = groups.filter((g) => /lambda|function|service|container|worker|job/i.test(`${g.kind ?? ""} ${g.label ?? ""}`));
  const routes = (access ?? []).filter((x) => x.public), many = (k, one, more) => `${k} ${k === 1 ? one : more}`;
  const parts = [queues.length && many(queues.length, "queue", "queues"), fns.length && many(fns.length, "function", "functions"), routes.length && many(routes.length, "public way in", "public ways in")].filter(Boolean);
  const verb = [...queues, ...nodes.filter((n) => fns.some((g) => g.id === n.group))].some(isNew) ? "adds or changes" : "touches";
  const text = parts.length ? `This PR ${verb} ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}: the run starts there.` : "The picture names no queue, function or public way in: the run reads the diff itself.";
  return { text, nodes: [...new Set([...queues.map((n) => n.id), ...routes.map((x) => x.node).filter(Boolean), ...nodes.filter((n) => fns.some((g) => g.id === n.group) && (n.type === "function" || /handler|consumer/i.test(n.label ?? ""))).map((n) => n.id)])] };
}
// The paths in the order of the page: blockers first, then findings, not assessed, limited ones; the order otherwise kept.
// Blockers, then the paths that block once wired (wave C2 D3: wired {why, at, today}), then findings, the rest.
const RES_RANK = (p) => (p.blocker ? 0 : p.wired ? 1 : p.result === "finding" ? 2 : p.result === "not_assessed" ? 3 : 4);
export const resOrder = (paths) => [...(paths ?? [])].sort((a, b) => RES_RANK(a) - RES_RANK(b));
// The one picture of an opened path, by what it has: a ladder (retries), a budget (a timeout), a race's timeline, or
// the writers of a shared state (two writers or more); null: none.
export function resPicture(p) {
  const has = { ladder: p?.ladder?.length > 0, budget: Boolean(p?.budget), race: (p?.race?.steps ?? []).length > 0, writers: (p?.writers ?? []).filter((w) => w.kind === "W").length >= 2 };
  const pick = { retry: "ladder", timeout: "budget", race: "race", state: "writers" }[p?.kind];
  // A kind with a picture of its own shows only that one (a timeout without its budget: no ladder of another path).
  return pick ? (has[pick] ? pick : null) : ["ladder", "budget", "race", "writers"].find((k) => has[k]) ?? null;
}
// A budget as a bullet bar in px: the value's bar, the limit's line, the part over it. width: the bar's room.
export function budgetBar({ value_s, limit_s }, width = 320) {
  const max = Math.max(value_s, limit_s) * 1.1 || 1, px = (s) => Math.round((s / max) * width);
  return { value: px(value_s), limit: px(limit_s), over: Math.max(0, px(value_s) - px(limit_s)), overS: Math.max(0, value_s - limit_s) };
}
// A path in the shape the page draws, from either shape: this view's own fixture or R-D's withResilience (blocker.why,
// ladder {factors [{label, n, at}], text}, budget {…, text}, races[] and state[] at the top). Pure.
export function resPathView(p, res = {}) {
  const lad = Array.isArray(p.ladder) ? p.ladder : (p.ladder?.factors ?? []).map((f) => ({ name: f.label, factor: f.n === null || f.n === undefined ? "no limit" : `×${f.n}`, at: f.at }));
  const race = p.race ?? (res.races ?? []).find((r) => (r.findings ?? []).some((id) => (p.findings ?? []).includes(id))) ?? (p.kind === "race" ? (res.races ?? [])[0] : null) ?? null;
  const st = p.writers ? null : (res.state ?? []).find((x) => (x.writers ?? []).length >= 2 && x.writers.some((w) => [...(p.reach ?? []), ...(p.steps ?? [])].includes(w.node)));
  const writers = p.writers ?? (st ? [...st.writers.map((w) => ({ ...w, kind: "W", guard: w.guard ?? "none" })), ...(st.readers ?? []).map((r) => ({ ...r, kind: "R", guard: "" }))] : undefined);
  const budget = p.budget ? { ...p.budget, note: p.budget.note ?? p.budget.text } : null;
  return { ...p, ladder: lad, product: p.product ?? (Array.isArray(p.ladder) ? null : p.ladder?.text) ?? null, budget, race, writers, state: p.state ?? st?.what ?? st?.id,
    invariant: p.invariant ?? st?.invariant ?? null, wired: p.wired ? { ...p.wired, reason: p.wired.reason ?? p.wired.why ?? "" } : null, blocker: p.blocker ? { reason: p.blocker.reason ?? p.blocker.why ?? "", unclear: Boolean(p.blocker.unclear) } : null };
}
// A path's step as a card of the map: a card id, or a place ("file:line") on the card of that file (the last card
// that starts at or above the line, else the file's first); an edge id or an unknown place: null.
export function resCardOf(step, arch) {
  const nodes = arch?.nodes ?? [], s = String(step ?? "");
  if (nodes.some((n) => n.id === s)) return s;
  const m = /^(.+?):(\d+)(?:-\d+)?$/.exec(s); // a range (mailer.py:14-20) by its first line
  if (!m) return null;
  const same = (a, b) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
  const mine = nodes.map((n) => ({ id: n.id, at: /^(.+?):(\d+)/.exec(String(n.at ?? n.evidence ?? "")) })).filter((x) => x.at && same(x.at[1], m[1]));
  const hit = (mine.filter((x) => Number(x.at[2]) <= Number(m[2])).sort((a, b) => Number(b.at[2]) - Number(a.at[2]))[0] ?? mine[0])?.id;
  if (hit) return hit;
  // A card without a place that names its file in its label: "Mailer (mailer.py)".
  const base = m[1].split("/").pop();
  return nodes.find((n) => !(n.at ?? n.evidence) && new RegExp(`\\(${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`).test(String(n.label ?? "")))?.id ?? null;
}
// "Trigger: end" as one sentence: the end's first letter small unless it starts a name or a code word.
// ponytail: only the usual first words of a sentence; a name (Lambda, Mailer) keeps its capital.
export const resSentence = (p) => `${p.trigger}: ${/^(The|A|An|One|Every|Each|Both|No|Nothing|It|Its|Batch|Mail|Mails)\b/.test(p.end ?? "") ? p.end[0].toLowerCase() + p.end.slice(1) : p.end ?? ""}`;
// A path's marks per card of the map: R-D's {at (node, "e<k>" or file:line), mark} or this view's {node, text}; a call's
// mark on the card it calls, a place's on the card of its file; several on one card joined. Map(node id -> text).
// A queue's mark (DLQ, no DLQ) on a call goes to the card the call starts at, the queue (wave R2); with onEdges the
// other marks of a call stay on the call itself (views.js resEdgeMarks) and are left out here.
export function resMarksOn(marks, arch, onEdges = false) {
  const out = new Map();
  for (const m of marks ?? []) {
    const e = /^e(\d+)$/.exec(String(m.at ?? "")), text = m.text ?? m.mark, dlq = /DLQ/.test(text ?? "");
    if (e && onEdges && !dlq) continue;
    const id = m.node ?? (e ? arch?.edges?.[Number(e[1])]?.[dlq ? "from" : "to"] : resCardOf(m.at, arch));
    if (id && text) out.set(id, out.has(id) ? `${out.get(id)} · ${text}` : text);
  }
  return out;
}

// ---- the way of a crossing as a chain, beginning with whoever arrives and passing each gate on it (panel round 3)
// [{kind: "node", text, strong} | {kind: "gate", text, own, row}]: a first step from outside (the internet or an external
// card) becomes the principal of the way in it reaches, with that way in's gate before its door; the row's own gate
// stands before its target; the steps before a way in's door drop out (that is who arrives). Pure.
export function wayOf(r, rows, arch) {
  const nodes = arch?.nodes ?? [], node = (id) => nodes.find((n) => n.id === id);
  const name = (id) => node(id)?.label ?? (arch?.groups ?? []).find((g) => g.id === id)?.label ?? (id === "internet" ? "Internet" : id);
  const gate = (x, own) => ({ kind: "gate", own, row: x, text: x.kind === "bypass" ? "no check: one process" : `‖ ${x.check ?? "no check named"}${x.expects ? ` · expects ${x.expects}` : ""}` });
  const ext = (id) => id === "internet" || node(id)?.type === "external", entryAt = (id) => (rows ?? []).find((x) => x.kind === "entry" && x.ends.to === id);
  let steps = [...new Set((r.path ?? [r.ends.from, r.ends.to]).filter(Boolean))];
  if (r.ends.to && !steps.includes(r.ends.to)) steps.push(r.ends.to);
  const out = [];
  if (r.kind === "entry" || r.kind === "operator" || !r.ends.from) {
    out.push({ kind: "node", text: r.identity ?? r.from?.name ?? "outside", strong: true });
    const door = steps.indexOf(r.ends.to); steps = door >= 0 ? steps.slice(door) : steps;
  } else if (steps.length > 1 && ext(steps[0]) && entryAt(steps[1])) {
    const e = entryAt(steps[1]); out.push({ kind: "node", text: e.identity ?? "outside", strong: false }, gate(e, false)); steps = steps.slice(1);
  }
  steps.forEach((id, k) => {
    if (id === r.ends.to && (k > 0 || out.length)) out.push(gate(r, true));
    out.push({ kind: "node", text: name(id), strong: id === r.ends.from || id === r.ends.to });
  });
  return out;
}
export const wayText = (items) => items.map((x) => x.text).join(" → ");

// ---- the zone a card is really reachable from, passed on over calls in one process without a check (C2)
// eff: Map(node -> {trust, drawn, zone, why}); a card a reachable card calls in one process takes its trust, with the
// condition of the way in it hangs on (cond(node): e.g. "if crossing 1 fails open"). Pure; eff stays as it is.
export function passZones(eff, arch, cond = () => null) {
  const out = new Map(eff), nodes = arch?.nodes ?? [], label = (id) => nodes.find((n) => n.id === id)?.label ?? id;
  const zoneOf = (id) => (arch?.zones ?? []).find((z) => z.id === nodes.find((n) => n.id === id)?.zone) ?? null;
  const todo = [...eff.keys()];
  while (todo.length) {
    const from = todo.shift(), src = out.get(from);
    for (const e of arch?.edges ?? []) {
      if (e.from !== from || !inProcess(e) || e.gate) continue;
      const z = zoneOf(e.to), had = out.get(e.to), rank = (x) => TRUST_ORDER.indexOf(x);
      if (had ? rank(had.trust) <= rank(src.trust) : z && rank(z.trust) <= rank(src.trust)) continue; // as exposed already
      out.set(e.to, { trust: src.trust, drawn: z?.trust ?? null, zone: z ?? { name: "no zone", trust: null }, why: `${label(from)} calls it in one process, without a check`, cond: src.cond ?? cond(from) });
      todo.push(e.to);
    }
  }
  return out;
}

// ---- Resilience, wave R2 (op-arch): words for the run's identifiers, the verdict with every reason, what to add
// before the merge and what to watch after it, the doubled ways, and dimmed text that stays readable.

// The run's identifiers (failing, likelihood, signal, cost keys) as words; an unknown one with its underscores as spaces.
const RES_WORDS = { poison_message: "a message that always fails", no_dlq: "no dead-letter queue", duplicate_effect: "an effect happens twice", lost_effect: "an effect is lost",
  unbounded_retry: "retries without a limit", over_timeout: "runs over its timeout", swallowed_retry: "an exhausted retry is swallowed", silent: "nothing signals it", no_alarm: "no alarm",
  reads_foreign_state: "reads state another process holds", n_plus_one: "one call per item", no_timeout_public: "no timeout inside a public request", shared_resource: "a shared resource",
  removed_signal: "the PR removes a signal", no_jitter: "no jitter", no_breaker: "no circuit breaker", no_trace: "no trace context", high_cardinality: "high metric cardinality",
  cannot_happen: "cannot happen here", possible: "possible", likely: "likely", unlikely: "unlikely",
  alarm: "an alarm", log: "a log line", metric: "a metric", dlq: "the dead-letter queue", platform_only: "the platform's own metrics only", none: "nothing",
  mental: "to understand", ops: "to run", money: "in money", dishonest_response: "the route answers success while the work is lost", no_throttle: "no throttle",
  stale_cache: "a stale cache", clock: "a clock assumption", request: "request",
  no_backoff: "retries at once, without backoff", thundering_herd: "every caller refills at once", unchecked_answer: "the answer is not checked", backpressure: "the wait backs up to the way in",
  secret_store: "secret store", config_store: "config store", identity_provider: "identity provider", in_process: "in one process" };
export const resWord = (k) => RES_WORDS[k] ?? String(k ?? "").replace(/_/g, " ");
// A model's text about its own tools ("nothing was executed, because Bash was denied") is no finding about the code.
export const resToolText = (s) => /\b(bash|tool|permission|sandbox)\b[^.]*\b(denied|refused|not allowed|blocked)\b/i.test(String(s ?? ""));
const andJoin = (l) => (l.length > 1 ? `${l.slice(0, -1).join(", ")} and ${l.at(-1)}` : l[0] ?? "");
// The page's sentence on top: how many paths block and every reason once, with its count ("… (2 paths)"); null
// without a blocker (the run's own summary stays).
export function resVerdict(paths) {
  const b = (paths ?? []).filter((p) => p.blocker), by = new Map();
  if (!b.length) return null;
  for (const p of b) { const w = p.blocker.reason ?? p.blocker.why ?? ""; by.set(w, (by.get(w) ?? 0) + 1); }
  return `${b.length} of ${paths.length} ${paths.length === 1 ? "path" : "paths"} ${b.length === 1 ? "blocks" : "block"} the merge: ${andJoin([...by].map(([w, n]) => (n > 1 ? `${w} (${n} paths)` : w)))}.`;
}
// What nothing will show after the merge (a blind spot with signal "none": add the signal before), and what to watch
// (a signal without an alarm, the age of the oldest message of each queue), one entry per resource (card). Pure.
// {before: [{text, at}], watch: [{text, at}]}.
export function resWatch(res, arch) {
  const before = [], watch = [], seen = new Set(), card = (at) => resCardOf(at, arch) ?? at, name = (id) => arch?.nodes?.find((n) => n.id === id)?.label ?? id;
  // R2 data (pr.js withResilience: unseen[], watch[] as "<failure> (<at>): <what>"): taken as they are, the place as a
  // link, an edge id by the card it starts at (the queue), a signal in words.
  if (Array.isArray(res?.unseen)) {
    const words = (x) => x.replace(/\bat e(\d+)\b/g, (all, k) => (arch?.edges?.[Number(k)] ? `in ${name(arch.edges[Number(k)].from)}` : all)).replace(/seen as (\w+)/, (_all, w) => `seen as ${resWord(w)}`);
    const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
    const parse = (x) => { const m = /^(.*) \(([^()]*)\): (.*)$/.exec(String(x ?? "")); return m ? { text: cap(words(`${m[1]}: ${m[3]}`)), at: m[2] } : { text: cap(words(String(x ?? ""))) }; };
    return { before: res.unseen.map(parse), watch: (res.watch ?? []).map(parse) };
  }
  for (const b of res?.blind_spots ?? []) {
    if (b.signal === "none") before.push({ text: `${b.failure}: nothing shows it after the merge, so add a log line or an alarm first`, at: b.at });
    else if (!b.alarm || b.alarm === "none" || b.alarm === "unknown") { watch.push({ text: `${b.failure}; it shows in ${resWord(b.signal ?? "platform_only")}${/alarm/i.test(b.failure ?? "") ? "" : ", no alarm"}`, at: b.at }); seen.add(card(b.at)); }
  }
  for (const d of res?.deps ?? []) {
    const e = /^e(\d+)$/.exec(String(d.edge ?? "")), at = e && arch?.edges?.[Number(e[1])] ? arch.edges[Number(e[1])].from : d.at, c = card(at); // e<k>: 0-based, its queue is the source
    if (d.mode !== "async" || seen.has(c)) continue;
    seen.add(c);
    watch.push({ text: `The age of the oldest message in ${name(c)}`, at: d.at });
  }
  return { before, watch };
}
// Every way to the same effect on a path that doubles one: the cards of the run's effects of that kind, and the cards
// two of them call (the mailer both send through), so "twice" shows on the map. A Set of card ids, empty otherwise.
export function resTwice(p, res, arch) {
  const out = new Set();
  if (!(p?.failing ?? []).includes("duplicate_effect")) return out;
  const effects = res?.effects ?? [], on = (e) => (p.steps ?? []).some((s) => s === e.node || resCardOf(s, arch) === (e.node ?? resCardOf(e.at, arch)));
  const kinds = new Set(effects.filter(on).map((e) => e.kind)), mine = effects.filter((e) => kinds.has(e.kind)).map((e) => e.node ?? resCardOf(e.at, arch)).filter(Boolean);
  if (mine.length < 2) return out;
  for (const id of mine) out.add(id);
  const callees = (id) => (arch?.edges ?? []).filter((e) => e.from === id).map((e) => e.to);
  for (const to of new Set(mine.flatMap(callees))) if (mine.filter((id) => callees(id).includes(to)).length >= 2) out.add(to);
  return out;
}
// The opacity that dims a text but keeps it at a contrast of at least `min`:1 against the background (WCAG), at
// least `from`; 0.6 when the theme's colours are not #rrggbb.
export function readableFade(fg, bg, from = 0.25, min = 4.5) {
  const lum = (c) => { const m = /^#?([0-9a-f]{6})/i.exec(String(c ?? "")); if (!m) return null; return [0, 2, 4].map((k) => parseInt(m[1].slice(k, k + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, k) => s + v * [0.2126, 0.7152, 0.0722][k], 0); };
  if (lum(fg) === null || lum(bg) === null) return Math.max(from, 0.6);
  for (let a = from; a < 1; a += 0.05) {
    const l1 = lum(solidOver(bg, `${String(fg).slice(0, 7)}${Math.round(a * 255).toString(16).padStart(2, "0")}`)), l2 = lum(bg);
    if ((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) >= min) return Math.round(a * 100) / 100;
  }
  return 1;
}
// What a probe typically costs and takes, on the Run probe button: one Sonnet probe of the review round on PR #2 cost
// $0.11; the agent writes the script in under a minute and the page reads the result after a minute at the earliest.
export const PROBE_TYPICAL = { usd: 0.11, min: "1–2" };
// A path's marks on its calls: Map(edge index -> text). A call's own marks (⏱ 10 s, ×3 on an edge e<k>, not DLQ, which
// stands at the queue), and "↻ no limit" on the call that redelivers without a limit (the ladder's open factor, by
// the line of its call in deps). p: views.js resPathView's shape.
export function resEdgeMarks(p, deps) {
  const out = new Map(), add = (k, text) => { if (k !== null && !(out.get(k) ?? "").split(" · ").includes(text)) out.set(k, out.has(k) ? `${out.get(k)} · ${text}` : text); };
  const idx = (at) => { const e = /^e(\d+)$/.exec(String(at ?? "")); return e ? Number(e[1]) : null; };
  for (const m of p?.marks ?? []) if (!/DLQ/.test(m.mark ?? m.text ?? "")) add(idx(m.at), m.mark ?? m.text);
  for (const f of p?.ladder ?? []) if (f.factor === "no limit") add(idx((deps ?? []).find((d) => d.edge && d.at === f.at)?.edge), "↻ no limit");
  return out;
}
// A blocker the run could not date (pre_existing "unknown", blocker.unclear) takes the word of its probe, which ran on
// the base: already there → no blocker of this PR; new in it (or not on the base) → a blocker. byProbe: the verdict.
// probes: review.js probesNow (status done, base.verdict). Pure; other paths as they are.
export function resByProbe(paths, probes) {
  return (paths ?? []).map((p) => {
    if (!(p.blocker?.unclear || p.pre_existing === "unknown")) return p;
    const v = (probes ?? []).find((x) => (x.id === p.probe || x.of === p.id) && x.status === "done" && x.base?.verdict)?.base.verdict;
    if (v === "already_on_base") return { ...p, blocker: null, pre_existing: true, byProbe: v };
    if (v === "new_in_pr" || v === "not_on_base") return { ...p, pre_existing: false, blocker: p.blocker ? { ...p.blocker, unclear: false } : p.blocker, byProbe: v };
    return p;
  });
}
// A path's mark line in a card of the Resilience map: 18 px high and 3 px under it, so a finding's chip (about 18 px
// in its 15 px row) below does not touch it. In arch.js extra rows of 18 px each, with the card's 3 px gap.
export const RES_MARK_ROW = { h: 18, below: 3 };
export const resMarkRows = (lines = 1) => (lines * RES_MARK_ROW.h + RES_MARK_ROW.below + 3) / 18;
// A card's marks of the Resilience map ("×3 · ✕ when slow, down · ~ when overloaded") as lines that fit the card:
// wrapped at words into `width` px (13 px, semibold). [[{text, bad}, …], …]: a line's pieces, one per mark on it (a
// mark may go on in the next line); bad: the mark says what breaks (✕, no DLQ, no limit) and is the red one. [] without
// a mark. Pure: the card's height is known before it draws.
export function resMarkLines(text, width) {
  const lines = [], w = (s) => textW(s, 13) * 1.06;
  let x = 0;
  String(text ?? "").split(" · ").filter(Boolean).forEach((mark, k) => {
    const bad = /✕|∞|no /.test(mark);
    mark.split(" ").forEach((word, j) => {
      const lead = j ? " " : " · ", last = lines.at(-1)?.at(-1);
      if (!last || x + w(lead + word) > width) { lines.push([{ mark: k, text: word, bad }]); x = w(word); return; }
      if (last.mark === k) last.text += ` ${word}`; else lines.at(-1).push({ mark: k, text: word, bad });
      x += w(lead + word);
    });
  });
  return lines.map((l) => l.map(({ text: t, bad }) => ({ text: t, bad })));
}
// ---- Resilience: a path's second line, short enough to read: the way, at most three of the things it breaks (the
// rest counted, all of them in `tip`), and its findings. today: why it cannot happen today, a line of its own. Pure.
export function resMeta(p, way, findings = 0, max = 3) {
  const failing = (p.failing ?? []).filter((x) => x !== "silent").map(resWord), today = p.wired?.today && !p.blocker ? String(p.wired.today).replace(/^./, (c) => c.toUpperCase()) : null;
  const breaks = failing.length > max ? `${failing.slice(0, max).join(", ")} and ${failing.length - max} more` : failing.join(", ");
  return { today, text: [way, breaks, findings > 0 && `${findings} ${findings === 1 ? "finding" : "findings"}`].filter(Boolean).join(" · "), tip: failing.length > max ? `It breaks: ${failing.join(", ")}.` : null };
}
// The opacity of a dimmed part of the Resilience page (an analysis of another head, a probe of an older one): as dim
// as 0.55 where the second colour of the text still reads at 4.5:1 on each background given, else less dim.
export const resFade = (t, bgs = [t.background, t.surface]) => Math.max(...bgs.map((bg) => readableFade(t.muted, bg, 0.55)));

// ---- A cache has a limit: after a set, the oldest entries of a Map go until at most `max` are left. Returns the map.
export function keepLast(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
  return map;
}
// The page's verdict in two parts (wave C2 V2): a short sentence ("5 of 11 paths block the merge.") and the count by
// reason, most first ("a visible effect is lost: 2 · load grows without a limit: 1"); null without a blocker.
export function resVerdictParts(paths) {
  const b = (paths ?? []).filter((p) => p.blocker), w = (paths ?? []).filter((p) => p.wired).length, by = new Map();
  if (!b.length && !w) return null;
  for (const p of b) { const r = p.blocker.reason ?? p.blocker.why ?? ""; by.set(r, (by.get(r) ?? 0) + 1); }
  // The paths that cannot happen today wait (wave C2 D3): said after the blockers, not counted with them.
  const wait = w ? `${b.length ? " " : ""}${w} ${w === 1 ? "path blocks" : "paths block"} once ${w === 1 ? "it is" : "they are"} wired.` : "";
  return { head: `${b.length ? `${b.length} of ${paths.length} ${paths.length === 1 ? "path" : "paths"} ${b.length === 1 ? "blocks" : "block"} the merge.` : ""}${wait}`,
    counts: [...by].sort((x, y) => y[1] - x[1]).map(([r, n]) => `${r}: ${n}`) };
}
// Where a chosen path starts on the map: the card of its first step (a call e<k> by the card it leaves), else null.
export function resStartCard(p, arch) {
  for (const s of p?.steps ?? []) {
    const e = /^e(\d+)$/.exec(String(s)), id = e ? arch?.edges?.[Number(e[1])]?.from : resCardOf(s, arch);
    if (id) return id;
  }
  return p?.reach?.[0] ?? null;
}
// Wave C2 V3: a resilience path whose probe reproduced it (status done, result reproduced) confirms its findings:
// certainty "confirmed", with probed {id, strength} so the word can say how ("confirmed, platform modeled" when the
// script modeled the platform). paths: the run's paths (p.findings ids, p.probe); probes: review.js probesNow. Pure.
export function withProbes(findings, paths, probes) {
  const by = new Map();
  for (const p of paths ?? []) {
    const x = (probes ?? []).find((q) => (q.id === p.probe || q.of === p.id) && q.status === "done" && q.result === "reproduced");
    if (x) for (const id of p.findings ?? []) by.set(id, { id: x.id, strength: x.strength ?? null });
  }
  if (!by.size) return findings;
  return (findings ?? []).map((f) => { const hit = (f.ids ?? [f.id]).map((id) => by.get(id)).find(Boolean); return hit ? { ...f, certainty: "confirmed", probed: hit } : f; });
}
// The certainty as a word, with how a probe confirmed it ("confirmed, platform modeled").
export const certaintyText = (f) => `${f?.certainty ?? ""}${f?.certainty === "confirmed" && f?.probed?.strength === "models_env" ? ", platform modeled" : ""}`;
// Which probe confirmed a finding, as a sentence after its certainty (" Probe r1 reproduced it, with the platform modeled.").
export const probedText = (f) => (f?.certainty === "confirmed" && f?.probed ? ` Probe ${f.probed.id} reproduced it${f.probed.strength === "models_env" ? ", with the platform modeled" : ""}.` : "");

// "Before merge" counted by what decides it, one number per group, in the rows' order: "⛨ 2 security", "9 findings on
// 3 criteria" (the rows that break a criterion and how many criteria they break; a criterion nothing stands for is
// "1 criterion without a finding"), "5 resilience blockers", "14 high" (the other findings by severity), "2 checks",
// "1 fix to verify", "1 overlapping PR". Every number counts rows, so the numbers of a line add up to the rows it
// speaks of ("16 more: …"). rows: review.js mergeRows (pr.js beforeMerge and the Resilience run's rows). -> [{key, n, text}]
const mergeKey = (r) => (r.kind === "security" ? "security" : r.kind === "criterion" || r.kind === "ask" ? "criteria" : r.kind === "resilience" ? (r.path ? "resilience" : "blind")
  : r.kind === "finding" ? `sev-${r.finding?.severity ?? "high"}` : r.kind === "verify" || r.kind === "overlap" ? r.kind : "checks");
export function mergeGroups(rows) {
  const say = { security: (n) => `⛨ ${n} security`, resilience: (n) => `${n} resilience ${n === 1 ? "blocker" : "blockers"}`, // the verdict line's word for the same paths
    blind: (n) => `${n} not observable`, verify: (n) => `${n} ${n === 1 ? "fix" : "fixes"} to verify`, overlap: (n) => `${n} overlapping ${n === 1 ? "PR" : "PRs"}`, checks: (n) => `${n} ${n === 1 ? "check" : "checks"}` };
  const crit = (n) => `${n} ${n === 1 ? "criterion" : "criteria"}`;
  const criteria = (l) => {
    const fs = l.filter((r) => r.kind === "criterion"), a = l.length - fs.length, c = new Set(fs.flatMap((r) => (r.asks?.length ? r.asks : [r.ask]).filter(Boolean).map((x) => x.id))).size;
    return [fs.length > 0 && `${fs.length} ${fs.length === 1 ? "finding" : "findings"}${c ? ` on ${crit(c)}` : ""}`, a > 0 && `${crit(a)} without a finding`].filter(Boolean).join(" and ");
  };
  const groups = new Map();
  for (const r of rows) { const k = mergeKey(r); groups.set(k, [...(groups.get(k) ?? []), r]); }
  return [...groups].map(([key, l]) => ({ key, n: l.length, text: key === "criteria" ? criteria(l) : say[key] ? say[key](l.length) : `${l.length} ${key.slice(4)}` }));
}
// The findings "Before merge" stands for (acceptance, engineer 2): each row's own, and the later open findings of its
// cause (pr.js same_cause), which byCause puts on that row. They count there, not again under "Other findings".
// open: the unresolved findings. -> Set of finding ids.
export function mergeHeld(rows, open = []) {
  const own = new Set(rows.flatMap((r) => (r.finding ? [r.finding.id] : []))), held = new Set(own);
  for (const f of open) if (f.same_cause && open.some((g) => g !== f && own.has(g.id) && (g.id === f.same_cause || (g.ids ?? []).includes(f.same_cause)))) held.add(f.id);
  return held;
}
// The rows shown of "Before merge" (and the box over the layers): at most n, every security row first, then the first
// of each other group before a second of any, in the rows' order, so a criterion is not pushed out by resilience
// rows. of(x): the row.
export function mergeFirst(items, n = 5, of = (x) => x) {
  const pick = new Set(items.filter((x) => mergeKey(of(x)) === "security").slice(0, n)), round = (k) => { const seen = new Set(); for (const x of items) { if (pick.size >= n) return; const g = mergeKey(of(x)); if (!pick.has(x) && !seen.has(g) && [...pick].filter((y) => mergeKey(of(y)) === g).length < k) { seen.add(g); pick.add(x); } } };
  for (let k = 1; pick.size < Math.min(n, items.length); k++) round(k);
  return items.filter((x) => pick.has(x));
}

// The button that starts a run (run: the findings file's runs[kind]): "Run (about $0.27, 1 min)" before a first run,
// "Run again (…)" after a failed one, and after a finished one "Re-run (about $0.27, 1 min) · last run 1 h ago on
// ccddf95", so a done run does not read like one still to buy. price: null when not known (Codex); age: "1 h ago";
// short: without the last run (a place that says it next to the button).
export function runLabel(run, price = null, age = "", short = false) {
  const p = price ? ` (${price})` : "";
  if (run?.state === "done") return short ? `Re-run${p}` : `Re-run${p} · last run${age ? ` ${age}` : ""}${run.head ? ` on ${String(run.head).slice(0, 7)}` : ""}`;
  return `${run?.state === "failed" ? "Run again" : "Run"}${p}`;
}

// ---- what the panel lists as relevant (PRs that stuck around: every session PR of every repo, every review opened once)
export const STALE_DAYS = 30, DONE_DAYS = 14;
const daysSince = (iso, now) => (now - Date.parse(iso ?? "")) / 86400000; // NaN (no date) counts as recent
// "Mine" in a space: the open PRs of its repo (slug, owner/name; outside a GitHub repo every repo) that changed within
// STALE_DAYS; the other open ones behind a fold; merged and closed ones of that repo and the last DONE_DAYS only.
export function mineGroups(list, slug, now = Date.now()) {
  const repo = (p) => !slug || p.repo === slug, within = (p, days) => !(daysSince(p.updatedAt ?? p.at, now) > days);
  const here = (p) => repo(p) && within(p, STALE_DAYS), open = list.filter(isOpenPr);
  return { here: open.filter(here), other: open.filter((p) => !here(p)), done: list.filter((p) => !isOpenPr(p) && repo(p) && within(p, DONE_DAYS)) };
}
// "In progress": reviews with something done in them (a file viewed, a layer checked, a comment, a reply, a fixed
// thread, or sent), not merged or closed as far as known (states: url → state), touched within DONE_DAYS; the space's
// repo (slug; outside a GitHub repo every repo). A review only opened and left is not in progress. all ("Show all"):
// the ones not touched for longer and the ones of other repos too, the space's repo first, then by last touch.
const WORK = ["stepsChecked", "filesViewed", "comments", "replies", "fixedThreads"];
const worked = (r) => r.status !== "done" && (r.status === "sent" || WORK.some((k) => (r.progress?.[k] ?? 0) > 0));
const closedNow = (r, states) => ["merged", "closed"].includes(states.get(r.url));
export function inProgressNow(list, { states = new Map(), slug = null, now = Date.now(), all = false } = {}) {
  const here = (r) => (!slug || r.repo === slug) && !(now - (r.lastTouched ?? 0) > DONE_DAYS * 86400000);
  return (list ?? []).filter((r) => worked(r) && !closedNow(r, states) && (all || here(r)))
    .sort((a, b) => Number(b.repo === slug) - Number(a.repo === slug) || (b.lastTouched ?? 0) - (a.lastTouched ?? 0));
}
// Reviews with work in them whose PR was merged or closed since, each with that `state`: the panel lists them dimmed
// with the word and a way to remove them, so that none leaves "In progress" without saying why.
export const inProgressLeft = (list, states = new Map()) => (list ?? []).filter((r) => worked(r) && closedNow(r, states)).map((r) => ({ ...r, state: states.get(r.url) }));
// What "In progress" shows: the recent ones up to the cap, or all of them (the older ones too); `more`: how many
// "Show all" adds (and "Show fewer" takes away again); `left`: the merged and closed ones.
export function progressRows(list, { states = new Map(), slug = null, now = Date.now(), all = false } = {}) {
  const every = inProgressNow(list, { states, slug, now, all: true }), recent = capped(inProgressNow(list, { states, slug, now })).shown;
  return { shown: all ? every : recent, more: every.length - recent.length, total: every.length, left: inProgressLeft(list, states) };
}
// "#2 removed from In progress. Its 2 pending comments and your progress are kept." (the line with Undo after ✕).
export function removedText(r) {
  const n = r?.progress?.comments ?? 0;
  return `#${r.number} removed from In progress. ${n ? `Its ${n} pending ${n === 1 ? "comment" : "comments"} and your progress` : "Your progress"} ${n ? "are" : "is"} kept.`;
}
// The panel's pick per view and space (shared "pr.selected"): this one set, the newest `max` kept.
export const withPick = (sel, key, url, max = 30) => Object.fromEntries([...Object.entries(sel ?? {}).filter(([k]) => k !== key), [key, url]].slice(-max));

// "Before merge" by cause: a row whose finding is a later finding of one cause (pr.js same_cause) while that cause's
// first finding is still open goes; the first row gets its place in `also` ("same cause at template.yaml:14").
// open: the unresolved findings.
export function byCause(rows, open = []) {
  const firstOf = (f) => (f?.same_cause ? open.find((g) => g !== f && (g.id === f.same_cause || (g.ids ?? []).includes(f.same_cause))) ?? null : null);
  const later = rows.filter((r) => firstOf(r.finding));
  return rows.filter((r) => !later.includes(r)).map((r) => {
    const also = later.filter((x) => firstOf(x.finding) === r.finding).map((x) => x.where).filter(Boolean);
    return also.length ? { ...r, also } : r;
  });
}

// ---- what an agent in a tab has cost so far (the fix agent: the CLI caps only non-interactive runs)

// A Claude Code session log (its .jsonl) priced: every model reply once (a reply spans several lines, one per content
// block, with the same message id), its tokens at pr.js priceOf; cache reads at a tenth of the input price, cache
// writes at 1.25 times it. -> {usd, ms (first to last reply), replies, model}
// ponytail: the 5-minute cache write price for every write; the 1 h writes cost 2x, which this undercounts a little.
export function sessionCost(text) {
  const seen = new Set();
  let usd = 0, first = null, last = null, model = null;
  for (const line of String(text ?? "").split("\n")) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const m = d?.type === "assistant" ? d.message : null, u = m?.usage;
    if (!u || !m.id || seen.has(m.id) || m.model === "<synthetic>") continue;
    seen.add(m.id);
    const [pin, pout] = priceOf(m.model), t = Date.parse(d.timestamp);
    usd += ((u.input_tokens ?? 0) * pin + (u.cache_read_input_tokens ?? 0) * pin * 0.1 + (u.cache_creation_input_tokens ?? 0) * pin * 1.25 + (u.output_tokens ?? 0) * pout) / 1e6;
    if (Number.isFinite(t)) { first ??= t; last = t; }
    model = m.model;
  }
  return { usd, ms: first === null ? 0 : last - first, replies: seen.size, model };
}
// Where Claude Code keeps the session logs of an agent started in `cwd`: <config>/projects/<cwd with every / and .
// as ->/.
export const sessionDir = (config, cwd) => `${config}/projects/${String(cwd).replace(/[/.]/g, "-")}`;

// What one fix agent (a sub-agent on one finding) costs, measured from its session logs (sessionCost) on PR #2 of
// the demo repo; another class is scaled by its output price and says so. usd per finding, s from first to last reply.
// ponytail: one Sonnet run ($0.14, 72 s, PR #2) on one small PR; measure again on a bigger one when the estimate is often far off.
export const FIX_TYPICAL = { sonnet: { usd: 0.15, s: 72, measured: true } };
export function fixTypical(tier) {
  if (FIX_TYPICAL[tier]) return FIX_TYPICAL[tier];
  const base = FIX_TYPICAL.sonnet, k = priceOf(tier)[1] / priceOf("sonnet")[1];
  return { usd: base.usd * k, s: base.s, measured: false };
}
// "about $0.40 and 3 min" (one finding), with "estimated from Sonnet runs" when not measured on this class.
export function fixEstimate(tier) {
  const t = fixTypical(tier);
  return `about $${t.usd.toFixed(2)} and ${Math.max(1, Math.round(t.s / 60))} min${t.measured ? "" : ", estimated from Sonnet runs"}`;
}
// A running fix agent's cost so far, for its facts: "$0.31 so far", and past twice the usual for its findings
// "$1.10 so far · above the usual cost; stop it in its tab". n: the findings it works on.
export function fixCostLine(usd, tier, n = 1) {
  const over = usd > 2 * fixTypical(tier).usd * Math.max(1, n);
  return { over, text: `$${usd.toFixed(2)} so far${over ? " · above the usual cost; stop it in its tab" : ""}` };
}

// What Go to's "Resume review" items are made of, as one string: the open reviews, each with when it was last touched
// (its progress moves with that) and its status. shared() hands out a new object per call, so the panel compares this.
export const openSig = (list) => (list ?? []).map((r) => `${r.url}|${r.lastTouched ?? ""}|${r.status ?? ""}`).join("\n");

// Whether the layout shows the PR panel (the block of this mod without a part): false when it or a column around it is
// hidden, or a stack around it has another tab up; null when the layout has no such block (the panel is placed some
// other way, as a pane or a window), which counts as shown.
export function panelShown(node, mod = "pr-review") {
  const walk = (n, shown) => {
    if (!n || typeof n !== "object") return null;
    const here = shown && !n.hidden;
    if (n.content?.mod === mod && !n.content.props?.part) return here;
    for (const c of n.children ?? []) { const r = walk(c, here && (n.type !== "stack" || !n.active || n.active === c.id)); if (r !== null) return r; }
    return null;
  };
  return walk(node, true);
}

// ---- Resilience: dependencies that fail or are overloaded (pr.js downstreamOf), a compact row each. The decided cases
// as words with their mark ("slow: waits up to 7 s of the 10 s request ✗"; ✓ handled, ~ partly, ✗ not handled; text, and
// words and mark apart so only the mark takes a colour), each
// with the path that shows how it spreads (only one of the run's paths) and that path's number on the page; the cases
// the code cannot decide by name only (open: they are asked under "After merge, watch"). paths: in the page's order. Pure.
const DEP_MARK = { yes: "✓", partly: "~", no: "✗" }, DEP_BARE = { yes: "handled", partly: "partly handled", no: "not handled" };
export function resDepRows(res, paths = res?.paths ?? []) {
  const num = new Map(paths.map((p, k) => [p.id, k + 1])), blocks = new Set(paths.filter((p) => p.blocker).map((p) => p.id));
  return (res?.downstream ?? []).map((d) => ({ dep: d.dep, what: [resWord(d.kind), d.mode && resWord(d.mode)].filter(Boolean).join(", "), entry: d.entry || null, at: d.at || null, card: d.card ?? d.node ?? null,
    cases: (d.cases ?? []).filter((c) => DEP_MARK[c.handled]).map((c) => ({ when: c.when, handled: c.handled, at: c.at ?? null, effect: c.effect ?? "", path: num.has(c.path) ? c.path : null,
      number: num.get(c.path) ?? null, blocks: blocks.has(c.path), words: `${RES_WHEN[c.when] ?? resWord(c.when)}: ${String(c.how || DEP_BARE[c.handled]).replace(/\.$/, "")}`, mark: DEP_MARK[c.handled] })).map((c) => ({ ...c, text: `${c.words} ${c.mark}` })),
    open: (d.cases ?? []).filter((c) => !DEP_MARK[c.handled]).map((c) => RES_WHEN[c.when] ?? resWord(c.when)) }));
}

// "Copy as Markdown": what it copies where the person is. kind picks the text (markdown.js), name completes the
// footer's "Copied <name> as Markdown", tip is the button's help. layer: the open layer's title when it is one of the
// analysis (not "All changes"); finding: one is open in the Findings tab. Files and Comments have no page of their
// own to copy: the ⋯ menu's entry copies the Overview there.
export function mdTarget({ tab, page = null, layer = null, finding = false } = {}) {
  const tip = (what) => `Copies ${what} as Markdown to the clipboard, to hand to an agent or a person. A preview first: you see every section with its size and can leave some out. Nothing is posted.`;
  if (tab === "findings") return finding ? { kind: "finding", name: "the open finding", tip: tip("the open finding: where it is, who found it, how sure it is, its code, effect, detail, suggestion and what is known about its fix") }
    : { kind: "findings", name: "the unresolved findings", tip: tip("every unresolved finding in full, most severe first. With a finding open: only that one") };
  if (tab === "steps" && !page && layer) return { kind: "layer", name: `the layer "${layer}"`, tip: tip("this layer: what it is for, its files, the questions to check, its findings with their code, its pictures as Mermaid, the functions with example values and the first lines of each hunk") };
  if (tab === "steps" && page === "arch") return { kind: "arch", name: "the architecture", tip: tip("this page: the map as a Mermaid diagram with its systems, zones and finding marks, every card and call, where a finding breaks the flow, the components and the other pictures") };
  if (tab === "steps" && page === "blast") return { kind: "blast", name: "the Security page", tip: tip("this page, nothing folded: every trust boundary crossing with its check, way and threats, the boundary picture as Mermaid, the security findings in full with their code, the rights granted and what each run checked") };
  if (tab === "steps" && page === "res") return { kind: "res", name: "the Resilience page", tip: tip("this page, nothing folded: the parts this PR adds, every path with its way as Mermaid, retries, time budget, race, state, action and probe, the calls with their limits, what happens when a dependency is slow, overloaded or down, all checks and what to watch after the merge") };
  return { kind: "overview", name: "the Overview", tip: tip("the Overview: the verdict, everything before the merge with its code, the criteria with their findings, what was not checked, what the PR does, the new parts, the repo's rules and checks and the related PRs") };
}

// A PR or review named in a command (pick:<ref>, drop:<ref>): its URL, owner/repo#number, or the bare number, which is
// the first one in the list's order when two repos have a PR of that number. Rows and state are keyed by URL.
export const byRef = (list, ref) => (list ?? []).find((x) => x.url === ref || `${x.repo}#${x.number}` === ref) ?? (list ?? []).find((x) => String(x.number) === ref) ?? null;

// The risk signal per file of a chosen PR (as riskSignal, by the findings' file): path → {top, open, security}. The
// panel marks its file rows with it, so the diff there shows what the review already knows.
export function fileRisk({ analysis = null, findings = null, status = null } = {}) {
  const by = new Map();
  for (const f of [...(findings ?? []), ...(analysis?.steps ?? []).flatMap((x) => x.findings ?? [])]) if (f?.file) by.set(f.file, [...(by.get(f.file) ?? []), f]);
  return new Map([...by].map(([path, list]) => [path, riskSignal({ findings: list, status })]).filter(([, r]) => r.open > 0));
}

// ---- the Security page's picture and its "if … is compromised" lines, for the page and for its Markdown alike
// The crossings as a picture: {groups, nodes, edges} for archLayout or a Mermaid flowchart. The trust zones are the
// frames (operators, then whoever arrives from outside, then the zones public → authenticated → internal → data, one
// frame each), only the cards at a crossing; whoever arrives from outside is a card of its own. Each line is numbered as its row in the table (num(r)) and says its check and
// what goes over it; `dashed`: not assessed; `tip`: the same in sentences. Pure.
// The card of whoever arrives at a crossing without a card of its own (a caller from outside, an operator).
export const secWho = (r) => `\0who:${r.kind}:${r.identity}`;
export function secPicture(rows, arch, num = (r) => rows.indexOf(r) + 1) {
  const nodes = new Map(), edges = [], card = (id) => (arch?.nodes ?? []).find((n) => n.id === id);
  // A frame per zone (two zones of one trust level, e.g. in two cloud accounts, stay apart); whoever arrives from
  // outside stands outside every zone, an operator's script with the operators.
  const lane = (r, side) => { const z = side === "from" ? r.from : r.to; return side === "from" && r.kind === "operator" && !z.trust ? "operator" : side === "from" && r.kind === "entry" ? "outside" : z.trust ? `z:${z.name}` : "unknown"; };
  const put = (id, label, type, trust) => { if (!nodes.has(id)) nodes.set(id, { id, label, type, group: `t:${trust}`, status: undefined, description: "" }); return id; };
  for (const r of rows) {
    const from = r.ends.from ? put(r.ends.from, card(r.ends.from)?.label ?? r.ends.from, card(r.ends.from)?.type, lane(r, "from")) : put(secWho(r), r.kind === "operator" ? r.from.name : r.identity ?? "unnamed", r.kind === "entry" ? "external" : "component", lane(r, "from"));
    const to = r.ends.to ? put(r.ends.to, card(r.ends.to)?.label ?? r.ends.to, card(r.ends.to)?.type, lane(r, "to")) : null;
    // The line says what goes over it (what an attacker controls, else the call or right); a check by its kind; a
    // crossing assessed and still unchecked "no check"; one not assessed only its dashes. The rest is the tooltip.
    const over = r.carries?.length ? [].concat(r.carries).slice(0, 2).join(", ") : r.kind === "right" ? (r.actions ?? []).slice(0, 1).join("") || r.what : r.what;
    const check = r.kind === "bypass" ? "bypasses the boundary" : r.check ? `‖ ${r.check.replace(/, in the (code|config)$/, "")}` : r.result !== "not_assessed" ? "no check" : null;
    const tip = [`${num(r)}. ${r.what || over}`, r.kind === "bypass" ? "A call in one process: it bypasses the boundary of the code it reaches." : r.check ? `Checked by ${r.check}${r.expects ? `, expects ${r.expects}` : ""}${r.holds_if ? `; holds only if ${r.holds_if}` : ""}.` : r.result === "not_assessed" ? "Not assessed: no threat names this crossing." : "No check on this crossing.", r.result !== "not_assessed" ? `Result: ${r.result}.` : null].filter(Boolean).join("\n");
    if (to) edges.push({ from, to, label: `${num(r)}. ${[check, over].filter(Boolean).join(" · ")}`, tip, crosses: r.kind !== "bypass", dashed: r.result === "not_assessed", evidence: r.at ?? undefined });
  }
  // The frames from the left: operators (their zones, then whoever deploys), callers from outside, then inwards.
  const zs = ["operator", ...TRUST_ORDER.filter((x) => x !== "operator")].flatMap((tr) => (arch?.zones ?? []).filter((z) => z.trust === tr)), zoneNamed = (g) => zs.find((z) => `z:${z.name ?? z.id}` === g);
  const used = new Set([...nodes.values()].map((n) => n.group)), groups = [...zs.filter((z) => z.trust === "operator").map((z) => `z:${z.name ?? z.id}`), "operator", "outside", ...zs.filter((z) => z.trust !== "operator").map((z) => `z:${z.name ?? z.id}`), "unknown"].filter((g) => used.has(`t:${g}`))
    // A zone's frame: its name (cut when long, whole on hover) and its level, which always stays (stack.js).
    .map((g) => (zoneNamed(g) ? { id: `t:${g}`, label: zoneNamed(g).name ?? zoneNamed(g).id, kind: zoneNamed(g).trust, trust: zoneNamed(g).trust }
      : { id: `t:${g}`, label: g === "operator" ? "Operators and CI" : g === "outside" ? "Outside" : "Zone not named", kind: g === "operator" ? "operator" : g === "outside" ? "public" : "", trust: g === "operator" ? "operator" : g === "outside" ? "public" : undefined }));
  return { groups, nodes: [...nodes.values()], edges };
}
// "If Front desk Lambda is compromised, it can …": what a taken-over principal behind a way in may do (blastOf: a frame
// can be a whole account with several roles), and for each frame with a way in the cards of other frames it calls in
// the same process; the rights by frame only for data without a principal's card (an older run). Pure.
export function secBlast(rows, arch, access = []) {
  const nodeOf = (id) => (arch?.nodes ?? []).find((n) => n.id === id), label = (id) => nodeOf(id)?.label ?? (arch?.groups ?? []).find((g) => g.id === id)?.label ?? (id === "internet" ? "Internet" : id);
  const groupOf = (id) => nodeOf(id)?.group ?? null, frames = [...new Set(rows.filter((r) => r.kind === "entry").map((r) => groupOf(r.ends.to)).filter(Boolean))];
  const byPrincipal = blastOf(arch, access);
  const tails = new Map(), blast = [...frames.map((g) => {
    const name = (arch?.groups ?? []).find((x) => x.id === g)?.label ?? g, rights = byPrincipal.length ? [] : rows.filter((r) => r.kind === "right" && r.ends.from && (groupOf(r.ends.from) === g || runsIn(nodeOf(r.ends.from)).includes(g)));
    // What it reaches in one process: the cards of other frames its cards call without a boundary, and on from there.
    const reach = [], seen = new Set((arch?.nodes ?? []).filter((n) => n.group === g || runsIn(n).includes(g)).map((n) => n.id));
    for (const id of [...seen]) for (const e of arch?.edges ?? []) if (e.from === id && inProcess(e) && !seen.has(e.to)) { seen.add(e.to); reach.push(label(e.to)); for (const e2 of arch.edges) if (e2.from === e.to && inProcess(e2) && !seen.has(e2.to)) { seen.add(e2.to); reach.push(label(e2.to)); } }
    const can = [...rights.map((r) => `${(r.actions ?? []).join(", ") || "act"} on ${r.ends.to ? label(r.ends.to) : r.access?.resource ?? "a resource"}${r.unused ? " (granted, not used)" : ""}`), reach.length && `call ${reach.join(" and ")} in the same process`].filter(Boolean);
    // One principal in this frame (a function and its role): what it reaches in one process joins that principal's line.
    const mine = byPrincipal.filter((b) => b.frame === g);
    if (mine.length === 1 && can.length) { tails.set(mine[0], can.join("; ")); return null; }
    return can.length ? `If ${name} is compromised, it can ${can.join("; ")}.` : byPrincipal.length ? null : `If ${name} is compromised, it holds no right the data names.`;
  })].filter(Boolean);
  blast.unshift(...byPrincipal.map((b) => (tails.has(b) ? `${b.text.replace(/\.$/, "")}; ${tails.get(b)}.` : b.text)));
  return blast;
}
// Why an open path of the Resilience page has no picture, by its kind (the page's line and its Markdown).
export const RES_NO_PICTURE = { retry: "the run named no retry or redelivery on this path's calls", timeout: "the run named no batch size, time per record and timeout for this path",
  race: "the run named no steps of this race", state: "the run named no writers for this state" };
export const resNoPicture = (p) => `no picture: ${RES_NO_PICTURE[p?.kind] ?? "the run named no call on this path that multiplies or times out"}`;

// "#2 left In progress: its PR was merged.": the reviews that were listed a moment ago (before: a Set of urls) and are
// among the merged or closed ones now (left, from inProgressLeft); null when none moved.
export function leftNow(before, left) {
  const moved = (left ?? []).filter((r) => before?.has(r.url));
  return moved.length ? moved.map((r) => `#${r.number} left In progress: its PR was ${r.state}.`).join(" ") : null;
}

// The review's own risk signal from its finding counts (pr.js findingCounts: unresolved ones by severity, security by
// cause), in riskSignal's shape. It goes into the registry entry, so the minimized chip shows the mark the review shows.
// open: the unresolved findings themselves, for the mark's form and its words (signOf, signWords).
export const riskOfCounts = (c, open = null) => ({ top: c?.high ? "high" : c?.medium ? "medium" : c?.low ? "low" : null, open: c?.unresolved ?? 0, security: Boolean(c?.security),
  ...(open ? { form: signOf(open.some((f) => f.security) ? open.filter((f) => f.security) : open).form, words: signWords(open) } : {}) });

// ---- the text sizes (U34): named steps instead of fifteen sizes, in px at 100 % zoom. micro: text inside a picture
// (a call's text, a chip on a line); small: what is glanced at (meta lines, group headings, chips); body: what is
// read; title: a section's or a layer's title, the verdict; page: a page's title. panel: the PR panel's 280 px column,
// between micro and small, because its rows and buttons are laid out for it. Code is not on the ladder and keeps its
// sizes: in the diff (the probe that measures a character's width is drawn in it) and in the panel's narrow diff.
export const TYPE = Object.freeze({ micro: 10.5, panel: 11, small: 12, body: 13.5, title: 15, page: 22, code: 13, codePanel: 11 });

// ---- "This space": the PRs of the branches checked out in the active space (its panes and its agents' terminals)

// The folders a space works in: its panes' (by their tab) and those of the live terminals labelled with it or started
// by one of them (sub-agents run in the background, in worktrees of their own). Each folder once.
export function spaceFolders(spaceId, spaces, panes, terminals) {
  const tabs = new Set(((spaces ?? []).find((s) => s.id === spaceId)?.tabs ?? []).map((x) => x.id));
  const live = (terminals ?? []).filter((x) => x.state !== "finished"), mine = new Set(live.filter((x) => x.labels?.["herdr.space"] === spaceId).map((x) => x.address));
  for (let grew = true; grew;) { grew = false; for (const x of live) if (!mine.has(x.address) && x.parent && mine.has(x.parent)) { mine.add(x.address); grew = true; } }
  return [...new Set([...(panes ?? []).filter((p) => tabs.has(p.tab)).map((p) => p.cwd), ...live.filter((x) => mine.has(x.address)).map((x) => x.cwd)].filter(Boolean))];
}
// A checkout's branch from its HEAD file ("ref: refs/heads/feat/x"), null when detached.
export const headBranch = (text) => /^ref: refs\/heads\/(.+)$/.exec(String(text ?? "").trim())?.[1] ?? null;
// checkouts: [{cwd, root, slug, branch, base}] (slug: owner/name on GitHub or null; base: "origin/main"). Per GitHub
// repo the branches to ask about, without its default branch and detached heads: [{slug, branches, roots: {branch:
// root}}], sorted, so the same checkouts give the same list.
export function spaceBranches(checkouts) {
  const by = new Map();
  for (const c of checkouts ?? []) {
    if (!c?.slug || !c.branch || c.branch === String(c.base ?? "").replace(/^origin\//, "")) continue;
    const r = by.get(c.slug) ?? { slug: c.slug, branches: [], roots: {} };
    if (!r.branches.includes(c.branch)) { r.branches.push(c.branch); r.roots[c.branch] = c.root; }
    by.set(c.slug, r);
  }
  return [...by.values()].map((r) => ({ ...r, branches: [...r.branches].sort() })).sort((a, b) => a.slug.localeCompare(b.slug));
}
// One GraphQL query for one repo: the newest PRs of each of its branches (one gh call per repo, however many branches).
const PR_NODE = "number title url state isDraft headRefName headRefOid baseRefName updatedAt mergedAt isCrossRepository author{login} reviewDecision additions deletions";
export function branchPrQuery(slug, branches) {
  const [owner, name] = String(slug).split("/");
  return `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${branches.map((b, k) =>
    `b${k}: pullRequests(headRefName: ${JSON.stringify(b)}, first: 5, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${PR_NODE} } }`).join(" ")} } }`;
}
// Its answer as gh pr list gives PRs: the open ones and the ones merged within `days` (they keep the word "merged"),
// not a fork's PR that happens to use the same branch name; per branch the open one first.
export function branchPrs(answer, now = Date.now(), days = DONE_DAYS) {
  const recent = (p) => p.state === "MERGED" && now - Date.parse(p.mergedAt ?? 0) < days * 86400000;
  return Object.values(answer?.data?.repository ?? {}).flatMap((b) => (b?.nodes ?? []).filter((p) => !p.isCrossRepository && (p.state === "OPEN" || recent(p)))
    .sort((x, y) => Number(y.state === "OPEN") - Number(x.state === "OPEN")));
}
// The list in the order shown: open before merged, and in each group the PR of the focused pane's branch first
// (focus: {slug, branch} or null), the rest as it came. focusedPr tells those rows apart ("focused agent").
export const focusedPr = (p, focus) => Boolean(focus?.branch && p.repo === focus.slug && p.head === focus.branch);
export const spaceOrder = (prs, focus) => [...(prs ?? [])].sort((a, b) => Number(isOpenPr(b)) - Number(isOpenPr(a)) || Number(focusedPr(b, focus)) - Number(focusedPr(a, focus)));
// One sentence for an empty "This space": what is missing. checkouts as for spaceBranches, repos its result.
export function spaceEmpty(checkouts, repos) {
  if (!(checkouts ?? []).length) return "No pane or agent of this space is in a git repository.";
  if (!checkouts.some((c) => c.slug)) return "The repositories of this space have no GitHub remote, so there are no PRs to list.";
  if (!repos.length) return "Every checkout in this space is on its default branch, so there is no branch to look up a PR for.";
  const names = repos.flatMap((r) => r.branches), shown = names.slice(0, 3).join(", ");
  return `No open PR for ${shown}${names.length > 3 ? ` and ${names.length - 3} more` : ""}. Choose Current branch below to see the diff.`;
}

// ---- one sign for what stands behind a page, a row or a chip (the nav rows of Analysis, the bar's excerpt, the rows
// of "Needs your attention" and "Before merge", the panel's PR row, the minimized chip). The color says the highest
// severity among what is unresolved there, the form how sure that is, and the tip says both in words; the number
// stays beside the sign, so nothing is said by color alone.
const SIGN_SEV = ["critical", "high", "medium", "low"], SIGN_COLOR = { critical: "ansi1", high: "ansi1", medium: "ansi3", low: "ansi4" };
// How sure one finding is, in three steps: confirmed (something that ran shows it, also a probe: withProbes), derived
// (read from the code; also a finding from before the field existed), assumed (its certainty, or only its reach).
export const sureOf = (f) => (f?.certainty === "confirmed" ? "confirmed" : f?.certainty === "assumed" || f?.path_certainty === "assumed" ? "assumed" : "derived");
const sureWords = (f) => (f.certainty === "confirmed" ? `confirmed by a ${f.probed ? "probe" : "run"}${certaintyText(f).includes("modeled") ? ", platform modeled" : ""}`
  : f.certainty !== "assumed" && f.path_certainty === "assumed" ? "assumed reachable" : certaintyText(f));
// The sign of a set of unresolved findings: {top: the highest severity or null, color: a theme key, form}. form:
// "filled" when one of the top severity is confirmed, "plain" when the surest is derived, "open" when all of them
// are assumed, "quiet" when there is none.
export function signOf(findings) {
  const top = SIGN_SEV.find((s) => (findings ?? []).some((f) => f.severity === s)) ?? ((findings ?? []).length ? "low" : null);
  if (!top) return { top: null, color: "muted", form: "quiet" };
  const sure = new Set(findings.filter((f) => f.severity === top || !SIGN_SEV.includes(f.severity)).map(sureOf));
  return { top, color: SIGN_COLOR[top], form: sure.has("confirmed") ? "filled" : sure.has("derived") ? "plain" : "open" };
}
// "1 high, confirmed by a probe · 2 medium, assumed reachable": the same findings in words, worst and surest first.
export function signWords(findings) {
  const by = new Map();
  for (const f of findings ?? []) { const k = [f.severity ?? "low", sureWords(f)].filter(Boolean).join(", "); by.set(k, { n: (by.get(k)?.n ?? 0) + 1, sev: SIGN_SEV.indexOf(f.severity), sure: ["confirmed", "derived", "assumed"].indexOf(sureOf(f)) }); }
  return [...by].sort(([, a], [, b]) => (a.sev < 0 ? 9 : a.sev) - (b.sev < 0 ? 9 : b.sev) || a.sure - b.sure).map(([k, v]) => `${v.n} ${k}`).join(" · ");
}
// A page's sign. kind: overview | arch | security | resilience. findings: the unresolved findings behind the page.
// run: {state: done | running | failed | null (a run that is optional and did not run), n: the page's own number
// where it counts something else (security: causes, resilience: paths that block) with `unit`, its words ("paths
// block the merge"), more: a sentence for the tip
// ("1 path blocks once it is wired."), unsure: what stayed unchecked although the run is done ("1 path not assessed")}.
// -> {glyph, color (theme key), form (signOf's, or "quiet"), n, tip, state: open | clean | quiet | none | running}.
// clean: checked and nothing unresolved (a small ✓); quiet: nothing unresolved, yet not all of it checked; none: not run.
export const PAGE_SIGN = { overview: ["!", "Overview"], arch: ["!", "Architecture impact"], security: ["⛨", "Security"], resilience: ["↯", "Resilience"] };
export function pageBadge(kind, findings, run = {}) {
  const [glyph, name] = PAGE_SIGN[kind] ?? ["!", String(kind)], list = findings ?? [], more = run.more ? ` ${run.more}` : "";
  if (list.length) {
    const s = signOf(list), n = run.n ?? list.length, own = run.unit ? `${n} ${run.unit}. ` : "";
    return { glyph, color: s.color, form: s.form, n, state: "open", tip: `${name}: ${own}${signWords(list)}.${run.unsure ? ` ${run.unsure[0].toUpperCase()}${run.unsure.slice(1)}.` : ""}${run.state === "failed" ? ` The last ${name} run failed.` : run.state === null ? ` The ${name} run did not run.` : ""}${more}` };
  }
  const quiet = (g, state, tip) => ({ glyph: g, color: "dim", form: "quiet", n: run.n || 0, state, tip: `${name}: ${tip}${more}` });
  if (run.state === "running") return quiet("⋯", "running", "the run is going.");
  if (run.state === null || run.state === "failed") return quiet("○", "none", run.state === "failed" ? "the run failed, so nothing is known." : "not run.");
  if (run.unsure || run.n) return quiet(glyph, "quiet", `no unresolved finding${run.unsure ? `; ${run.unsure}` : ""}.`);
  return quiet("✓", "clean", "checked, nothing unresolved.");
}
// The sign as an element. div: gpui-kit's (passed in, so this module stays pure). Filled: the color is the ground;
// open: a dashed frame with "?" at reduced strength; else the glyph in its color.
export function signEl(div, t, sign, glyph = sign.glyph) {
  const c = t[sign.color] ?? t.muted, e = div().flex_none().px(3).rounded(4);
  return sign.form === "filled" ? e.bg(c).text_color(t.background).child(glyph) : sign.form === "open" ? e.border_1().border_dashed().border_color(c + "aa").text_color(c + "cc").child(`${glyph}?`) : e.text_color(c).child(glyph);
}
// A risk mark's label for a chip (rowMarks): the ⛨ as a sign before the word, or the text alone.
export const markLabel = (div, t, m) => (m.glyph ? div().flex().items_center().gap(3).child(signEl(div, t, m, m.glyph)).child(m.word) : m.text);

// ---- Resilience: the run's own ids out of its sentences (acceptance, UX 1). A path's id (p5) reads as the number the
// list shows ("path 6"; the list is sorted, blockers first, so the two differ); a ref the run gave one of its findings
// (r_f1: it is not stored, so nothing can show which finding it was) goes. nums: Map(path id -> number shown). Pure.
// ponytail: a word like "p5" in a sentence is read as the path with that id; the run writes its ids no other way.
export function resRefs(text, nums) {
  return String(text ?? "").replace(/\s*\((?:see\s+)?r_f\d+(?:(?:,|\s+and)\s*r_f\d+)*\)/g, "").replace(/[;,]?\s*\bsee r_f\d+(?:(?:,|\s+and)\s*r_f\d+)*/g, "")
    .replace(/\b(?:paths?\s+)?(p\d+)\b/g, (all, id) => (nums?.has(id) ? `path ${nums.get(id)}` : all));
}
// The paths as the page and its Markdown list them: in the page's order, each in the page's shape, their sentences
// (note, why not today, the race's note) with the numbers shown. -> {paths, nums, say}; say(text) does the same for
// another sentence of the run (a check's reason).
export function resShown(res) {
  const paths = resOrder((res?.paths ?? []).map((p) => resPathView(p, res ?? {}))), nums = new Map(paths.map((p, k) => [p.id, k + 1])), say = (s) => (s ? resRefs(s, nums) : s);
  return { nums, say, paths: paths.map((p) => ({ ...p, note: say(p.note), wired: p.wired && { ...p.wired, today: say(p.wired.today) }, race: p.race && { ...p.race, note: say(p.race.note) } })) };
}

// ---- Security page: a finding stands in full once among the crossings (acceptance, UX 3), at the first crossing that
// names it; a later crossing refers to that one by its number. rows: the crossings shown, in their order; num(r): a
// row's number in the list. -> Map(row key -> {first: [finding], again: [{f, at}]}). Pure.
export function crossOnce(rows, num = (r) => rows.indexOf(r) + 1) {
  const seen = new Map(), out = new Map();
  for (const r of rows ?? []) {
    const first = [], again = [];
    for (const f of r.findings ?? []) { if (seen.has(f.id)) again.push({ f, at: seen.get(f.id) }); else { seen.set(f.id, num(r)); first.push(f); } }
    out.set(r.key, { first, again });
  }
  return out;
}

// ---- Resilience: one statement about old or new (acceptance, UX 4). Where the diff dates a path (pr.js withResilience:
// pre_existing true or false, from the lines of its findings), that word counts, and its probe says only what the script
// did on the base ("on base: the script could not run there"); the probe's verdict ("new in this PR", from an ImportError on the base)
// dates only a path the diff could not date (resByProbe). x: the probe; byDiff: the diff dated its path; words:
// threads.js BASE_WORDS. -> {dates: the word is a verdict of old or new, word} | null without a base run.
// What the script did there, by the runner's verdict (an ImportError or AttributeError: the code it needs is not on the
// base, so it could not run; the runner's status says "not reproduced" for that too), else by its status.
const BASE_RAN = { already_on_base: "breaks the same way", new_in_pr: "the script could not run there", unknown: "the script failed there", not_on_base: "not reproduced" };
const BASE_DID = { reproduced: "breaks the same way", not_reproduced: "not reproduced", script_failed: "the script failed there", new_in_pr: "the script could not run there", new: "the script could not run there", unknown: "unknown", not_run: "not run" };
export function probeBaseWord(x, byDiff, words = {}) {
  const b = x?.base;
  if (!b || typeof b !== "object") return null;
  const verdict = byDiff ? null : words[b.verdict] ?? (b.verdict ? null : { new_in_pr: "new in this PR", new: "new in this PR" }[b.status]);
  return verdict ? { dates: true, word: verdict } : { dates: false, word: BASE_RAN[b.verdict] ?? BASE_DID[b.status] ?? resWord(b.status ?? "unknown") };
}
// The diff dated this path itself: old or new is known without a probe (resByProbe sets byProbe when the probe did).
export const datedByDiff = (p) => typeof p?.pre_existing === "boolean" && !p.byProbe;

// ---- what pr-review tells the Worktrees mod (its PROVIDERS.md: shared "worktrees.prs.review")
// The PRs pr-review knows, one per URL, as that mod takes them: {repo, branch (the head branch), number, state, url,
// base, headSha, updatedAt}. Open and draft ones, and the ones merged or closed within `weeks`; without a head branch
// a PR says nothing about a checkout and is left out. Sorted, so equal lists give equal text; at most `max`.
export function worktreePrs(lists, now = Date.now(), weeks = 4, max = 200) {
  const seen = new Map();
  for (const p of (lists ?? []).flat()) {
    if (!p?.url || !p.repo || !p.head || seen.has(p.url)) continue;
    const state = ["open", "draft", "merged", "closed"].includes(p.state) ? p.state : "open";
    if (state !== "open" && state !== "draft" && now - Date.parse(p.updatedAt ?? 0) > weeks * 7 * 86400000) continue;
    seen.set(p.url, { repo: p.repo, branch: p.head, number: p.number, state, url: p.url, ...(p.base ? { base: p.base } : {}), ...(p.headSha ? { headSha: p.headSha } : {}), ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}) });
  }
  return [...seen.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number).slice(0, max);
}

// ---- the panel's diff list (main.js): the buttons of its cards, drawn and hit from one description
// A virtual list's renderer holds no handler, so a press on a card is found by its place. panelButtons says which
// buttons a card's row has, left to right, each with its width, and the gap between them; the last one ends PANEL_EDGE
// px before the list's right edge. main.js draws them from it (diffItem) and panelHit finds the one under a press from
// it, so what is drawn and what is hit cannot drift apart.
// kind: "ca" the composer's buttons, "ch" its presets, "bh" a comment's Edit and Delete. o: {editing, presets: [label]}.
export const PANEL_EDGE = 21; // a card's margin (12), border (1) and padding (8)
export function panelButtons(kind, { editing = false, presets = [] } = {}) {
  if (kind === "ca") return { gap: 6, list: [{ key: "cancel", w: 58 }, { key: "comment", w: 78 }, ...(editing ? [] : [{ key: "ask", w: 46 }])] };
  if (kind === "ch") return { gap: 6, list: editing ? [] : presets.map((label, k) => ({ key: `preset:${k}`, w: textW(label, TYPE.panel) + 20 })) };
  if (kind === "bh") return { gap: 8, list: [{ key: "edit", w: 32 }, { key: "delete", w: 46 }] };
  return { gap: 0, list: [] };
}
// Where they stand in a list w px wide: [{key, x0, x1}], left to right.
export function panelZones(kind, w, o) {
  const { gap, list } = panelButtons(kind, o), out = [];
  for (let k = list.length - 1, r = w - PANEL_EDGE; k >= 0; r -= list[k].w + gap, k--) out.unshift({ key: list[k].key, x0: r - list[k].w, x1: r });
  return out;
}
/** The button under a press x px from the left edge of a list w px wide (null: none). */
export const panelHit = (kind, x, w, o) => panelZones(kind, w, o).find((z) => x >= z.x0 && x < z.x1)?.key ?? null;
// A press as the list's own handler gets it (logical px) in the items' px: the items are laid out in the person's zoom.
export const panelPress = (x, width, zoom, fallback) => { const z = zoom || 1; return { x: (x ?? 0) / z, w: width ? width / z : fallback }; };


// A place as the analysis writes it ("file", "file:9", "file:9-14", "file:9:3") as {file, line}: what "↗ editor" opens.
export function placeOf(at) {
  const m = /^(.*?)(?::(\d+)(?:[-:]\d+)?)?$/.exec(String(at ?? "").trim());
  return m?.[1] ? { file: m[1], line: m[2] ? Number(m[2]) : null } : null;
}

// A file's patch (its lines, header first) is about a symbolic link (git mode 120000): what it points at comes from
// the PR, so no editor link is offered for it.
export const patchSymlink = (lines) => (lines ?? []).slice(0, 8).some((l) => /^(new file mode|deleted file mode|old mode|new mode) 120000$/.test(l) || /^index [0-9a-f]+\.\.[0-9a-f]+ 120000$/.test(l));
// A file's head drags as its path in the local checkout (Herdr's drag_paths: dropped on a terminal, the quoted path
// is typed there, without Enter). Only a file that is there and is the checkout's own: null without a checkout, for
// a file the diff deletes, for a symlink it adds or changes (the path would name what the PR points it at) and for a
// path that is absolute or leaves the checkout (editor.js safeFile).
export const dragPath = (root, f) => (root && f && f.status !== "deleted" && !patchSymlink(f.lines) ? safeFile(root, f.path) : null);
