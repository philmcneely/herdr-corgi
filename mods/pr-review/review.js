// The review layout (layouts/review.json): one PR in the whole window, as two copies of this mod.
// Part "bar": back, PR, context tag, model picker, cost. Part "review": left the AI's steps in risk order (or the file
// tree), right every diff line in one virtual list with suggestions and comments inline. Mixed into PrReview
// (main.js), so comments, the pending review and "Send review" are the panel's own code.
// Tabs: Files (since your last review, or the full PR), Analysis (Overview, Architecture impact, Security blast radius,
// then the AI's layers; stack.js draws the pictures), Findings. Cheap context (since-diff, related PRs, CI checks)
// loads by itself; every LLM call (Analyze, Only new changes, Verify fixes) is a click.
// UI text is English; the AI's content stays as it answers. Keys (diff focused): j/k step (Files tab: file), n/p hunk, c comment, a/x take/drop suggestion, s/f Analysis/Files, Esc back.
// Commenting works like GitHub's "Files changed": a click on a line number (shift-click: a range) or c opens the
// composer under that line, pending comments show as threads there, and "Finish your review" in the bar opens the
// submit popover: one GitHub review (gh api) or, for a PR with an agent session, the prompt to that session.
import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, TextView, v_virtual_list, VirtualListScrollHandle, ScrollHandle, Textarea, TextareaState, Input, InputState, HoverCard } from "gpui-base";
import { exec, hc, run, focused, pickFolder, theme, settings, readTextFile, writeTextFile, shared, setShared, appHome, nextCommand, watchFolder, openOverlay, closeOverlay, props, home } from "herdr";
import { spaces, agents, terminals, watch } from "./live.js"; // never straight from Herdr (live.js says why)
import { parseReports, findingStatus, mergeFindings, findingCounts, countLine, runsOf, fixPrompt, hash, touchReview, expireReviews, resumeFields, itemKeys, expandTabs, tokenAt } from "./pr.js";
import * as C from "./context.js";
import { hasTool, copyText, openUrl, loadSetup, readConfig } from "./setup-view.js";
import { taskList, taskHead, verdictParts, reviewState, certaintyLine, severityTip, componentLine, doesList, checkGroups, costLine, alreadyThere, criteriaGroups, beforeMerge, verdictAction, notChecked, surfaceLine, realRules } from "./pr.js"; // the Overview page
import { findingSteps, funnel, funnelLine, ownerOf, quickFirst, hasEffort, publicFiles, funnelShort, diffPath } from "./pr.js"; // the Findings tab
import { withProof, PROOF_WORDS } from "./pr.js"; // Verify with an agent
import { overviewMd, findingMd, findingsMd, layerMd, architectureMd, securityMd, verifyContextMd, resilienceMd } from "./markdown.js"; // Copy this page as Markdown
import { mdParts, mdJoin, mdHead, mdLines, codeStats } from "./markdown.js"; // its preview: the text in sections, the code context counted
import { highlightJob, highlightStep, highlightLines, langOf, firstLineOf, colors, renderLine, refAt } from "./syntax.js";
import { lookup, warm, contents, where, setTrusted } from "./defs.js";
import { recommendModel, tierSteps } from "./pr.js";
import { diffRows, hunksOf, selection, uiLine, lineKey, rangeOf, MODELS, tierOf, codeModel, priceOf, reviewRequest, mapReview, suspectComment, stepKey, fileRows, fileTree, atLine, splitPatch, withSecurity, securityStart } from "./pr.js";
import { ghTarget, lowValue, markReviewed, sinceBase, verifyCandidates, applyVerification, blastArch, preMergeChecks, mergeBlockers, triageOf } from "./pr.js";
import { diffLines, inDiff, ghReview, lineThreads, suggestionBlock, buildReview, layoutPlan, specElements, diagramsState, codeOf, isStale } from "./pr.js";
import { wheelStep, foldOnOpen, allocate, recenter, hsVisible, pastTop } from "./views.js";
import { worst, byFocus, layerAccess, analysisAge, stateHints, noteRule, mergeGroups, mergeFirst, mergeHeld, runLabel, byCause, sessionCost, sessionDir, fixEstimate, fixCostLine } from "./views.js";
import { archView, archLegend, visualsCard, visualCard, segBar, foldCard, chip, legend, specTag, sourceLegend, SEVERITY_COLOR, bulletChart } from "./stack.js";
import { visualPlan, laidOut } from "./stack.js";
import { factRows, findingAnchor, rangeMarks, wrapCount, mdHeight, SEVERITY_SCALE } from "./views.js";
import { ghMd, mdBlocks } from "./views.js"; // GitHub comments as GitHub shows them
import { wrapCode, codeCols, sliceSpans } from "./views.js"; // long lines wrap
import { rowMarks, riskOfCounts, placeOf, patchSymlink } from "./views.js"; // the minimized chip's mark, from the registry entry; a card's place
import { editorFor, editorMark, editorLink, editorCommand, openEditorMenu, editorFull, editorMenuTip } from "./editor-view.js"; // "Open in <Editor>"
import { pageBadge, signOf, signEl, markLabel } from "./views.js"; // one sign for severity and certainty: nav rows, the bar, rows, chips
import { pairRows, pairSide, HALF_GUTTER, diffModeOf, oneSided, stackOf, chipAt, textW } from "./views.js"; // side by side; the bar's stack
import { mdTarget, secPicture, secBlast, resNoPicture } from "./views.js"; // Copy as Markdown: what it copies on each page; the Security page's picture and lines
const MD_W = textW("⧉ Copy as Markdown…", TYPE.small) + 22; // the button's width on a layer's head, where clicks are placed by x
import { plainText, tabName } from "./pr.js";
import { pollDue, pollAfter, windowActive } from "./pr.js"; // background fetches (ghTick)
import { hasSources, archBands, widthAt } from "./arch.js";
import { archMarks, transitionText, MARK_CARD_ROWS } from "./arch.js";
import { markRoom, FIT as ARCH_FIT, ARCH as ARCH_SIZE } from "./arch.js"; // a card's mark takes the lines its finding needs
import { resStartOf, resPicture, budgetBar, resCardOf, resSentence, resMarksOn } from "./views.js";
import { resWord, resToolText, resVerdict, resWatch, resTwice, PROBE_TYPICAL, resEdgeMarks, resByProbe, RES_MARK_ROW, resMarkRows, resMarkLines, resVerdictParts, resStartCard } from "./views.js";
import { withProbes, certaintyText, probedText } from "./views.js"; // wave C2 V3: a reproduced probe confirms its findings // wave R2: words, verdict, watch, doubled ways
import { withThreats, secNote, secOldLine, secByEffect, secWhy } from "./pr.js"; // the Security page: one count, and a run from before its current rules
import { withResilience, resilienceStart, RUN_TYPICAL } from "./pr.js"; // the Resilience run's data // the Resilience page
import { keepLast } from "./views.js"; // every cache has a limit
import { resDepRows, resMeta, resFade, resShown, resRefs, probeBaseWord, datedByDiff } from "./views.js"; // Resilience: dependencies that fail or are overloaded; a path's second line; readable dimming
import { wayOf, wayText, passZones, runsIn } from "./views.js"; // panel round 3: ways through every gate, zones passed on
import { SecPicsMode } from "./sec-view.js"; // the Security page's sections "Where sensitive data goes" and "Who may do what"
import { ImpactMode } from "./impact-view.js"; // the Architecture page's Impact section: changed functions and their callers
import { SchemaMode } from "./schema-view.js"; // the Architecture page's "Schema changes": tables and relations before and after
import { transitionMarks, effectiveFrom, inProcess, mapArch, crossingsOf, crossingChanged, crossOnce, secSentence, TRUST_ORDER, asideOf, threatCited, blastOf, skipText, guardLine } from "./views.js";
import { trustLegend, hasTrust } from "./stack.js";
import { timelineOf, timelineLayout } from "./timeline.js"; // Resilience: the picture "Timing"
import { timelineView, faultTreeView } from "./stack.js";
import { faultTrees, FAULT_NOTE } from "./faulttree.js"; // Resilience: a case's fault tree under "When a dependency fails"
import { scopeTable, scopeConflicts, runSummary, AREA_NAME, areaFindings, surfaceOf, EXPOSURE, reachLevel, secOrder, extraWays } from "./views.js";
import * as TH from "./threads.js";
import { leftWidth, rowClick, CHIP_W, ASK_W, keyRoute, scopeLine, pictureOf, scopeOf, scopeFiles, hunksFor, mapAnswer, threadAdd, threadOf, history, highlightOf, rangeLabel, pinAnchor, pinAdd, pinDrop, pinsOf, pinsOn, codePins, drillPush, drillTo, crumbs, drillKey, cachePut, mapDrill, exploreId, exploreIndex, exploreAi, pathOf, lineOf, repoOfRemote, exploreTrust, layersForNode } from "./explore.js";
import { TYPE } from "./views.js"; // the text sizes (U34)
import { isIac, dirOf, infraModel, infraPicture, isDense, infraDense } from "./infra.js"; // "Infrastructure changes" on the Architecture page
import { infraSection } from "./infra-view.js";

const LEVEL = { high: "ansi1", medium: "ansi3", low: "ansi4", skim: "muted" };
const COVER = { seen: ["done", "ansi2"], partly: ["partly", "ansi3"], absent: ["missing", "ansi1"], extra: ["extra (not asked)", "ansi4"] };
// ponytail: GitHub's saturated diff hues; the theme's olive ansi2 under alpha turned the code background grey and dulled the syntax colors.
const tint = (kind) => (kind === "+" ? "#2ea043" : "#f85149");
const GH_GREEN = "#238636"; // GitHub's "Review changes" button
const STATUS = { added: ["A", "ansi2"], deleted: ["D", "ansi1"], renamed: ["R", "ansi4"], modified: ["M", "ansi3"] };
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Diff column geometry: clicks inside the virtual list are placed by x (one click handler per list).
const FOLD_MARGIN = 1500 * 22; // px: open the files around the view again this close to a folded one
const SPLIT = 6, ROW = 22, GUTTER = 4 + 48 + 48 + 22, GAP_SEG = 110, BTN = 110, BTN_GAP = 8, ACT = 44;
const FILE_CHEV = 30, FILE_SEEN = 100, FILE_WHOLE = 124;
const FILE_EDIT = 124, FILE_EDIT_MORE = 24; // a file head's "IntelliJ ↗" (or "Opening IntelliJ …") and its ▾: zones after "Whole file" (a list row holds no handler)
const MORE = 20; // lines per ↑/↓ click
const ONE_LINE = [0]; // a code line that fits: one visual line from its start (wrapsOf)
// A fenced block in a GitHub comment (codeView): font size, line height, padding; GH_GAP between a comment's blocks (as
// TextView's between paragraphs, MD.GAP).
const CODE_SIZE = 12.5, CODE_LH = 19, CODE_PAD_X = 10, CODE_PAD_Y = 7, GH_GAP = 10;
const NO_WRAP = 1e9; // the columns of a line that does not wrap (rowLayout)
// An object's JSON, made once per object: for a memo key on a part of the analysis (the map, the ways in), which is
// replaced, never changed in place. securityNow makes a new map with the same content, so identity alone would lay
// the map out again each time; the text is compared, and written once per object, not on every frame.
const jsonMemo = new WeakMap();
const jsonOf = (o) => {
  if (!o || typeof o !== "object") return JSON.stringify(o ?? null);
  let x = jsonMemo.get(o);
  if (x === undefined) jsonMemo.set(o, (x = JSON.stringify(o)));
  return x;
};
// resilienceStart reads every added line of the diff: once per patch (securityNow asks on every read of a file).
const resStartMemo = new WeakMap();
const resStartOfPatch = (patch) => { if (!resStartMemo.has(patch)) resStartMemo.set(patch, resilienceStart(patch)); return resStartMemo.get(patch); };
const STEP_LINES = 3000; // diff lines the Walkthrough lists at once (stepsItems): 4 000 took 23 ms per frame in Herdr on a busy machine (load 10 to 17), a frame is stopped at about 50
const LEAN_MS = 5 * 60000; // how long a view draws less after its frames were stopped (frameCut), before it tries all of it again
const NO_HUNKS = []; // a file outside the diff has no hunks: always this array, so memoRows sees the same input (rowsFor)
// A patch's file by its path (the first with it, as find gives): a Map per patch array, since rowsFor asks per finding.
const byPath = new WeakMap();
const fileOf = (patch, path) => {
  let m = byPath.get(patch);
  if (!m) { m = new Map(); for (const f of patch) if (!m.has(f.path)) m.set(f.path, f); byPath.set(patch, m); }
  return m.get(path);
};
// The items that start a card under a line: side by side they carry the mark of their half (item).
const SIDE_HEAD = new Set(["find", "ch", "gh", "compose", "sug", "def", "hidden"]);
const KEYS_POP = { width: 340, height: 330 }; // the "?" popup: sized to its rows and the last line
const COMPOSE = 168; // the composer row: header + a fixed-height textarea (the list needs every row's height up front)
const progressFile = () => `${appHome()}/pr-data/review-progress.json`; // per PR: progress and where you were (bounded)
const MAX_PROGRESS = 100;
// Open reviews, for other mods (PROVIDERS.md). Resume contract for any mod:
//   setShared("review.target", <a PR from pr-data/prs.json, or a registry entry's `target`>); run("layout.switch", { name: shared("review.layout") ?? "review" })
// shared("review.open") is this file's in-progress and sent entries: [{url, number, repo, title, context, startedAt,
// lastTouched, headSha, status, progress: {stepsChecked, steps, filesViewed, files, comments, findingsOpen}, target}].
const openFile = () => `${appHome()}/pr-data/open-reviews.json`;
// A shared value written only when it is another one: every write redraws every mod of the window and writes the
// whole shared.json again (about 100 KB with a few reviews in it), and the review published the same value several
// times while it opened.
const putShared = (key, value) => { if (JSON.stringify(shared(key) ?? null) !== JSON.stringify(value ?? null)) setShared(key, value); };
const TOUCH_MS = 5 * 60000; // a review's "last touched" on file may be this old before a visit alone writes it again (registerReview)
// shared("review.registry") is every entry, done ones too, with {at}: for plug-ins that mirror reviews elsewhere
// (PROVIDERS.md). Written on each registry change, 1.5 s after the last edit.
// The AI analysis' model: any value the claude CLI offers (models.py), Sonnet until one is picked.
// At least Sonnet (pr.js codeModel): every use reads or judges code, which Haiku is too weak for.
const model = () => { const m = shared("review.model"); return codeModel(typeof m === "string" && m ? m : "sonnet"); };
// The models the CLIs offer per context ({at, claude, codex}, models.py), shared so the Reviews popup sees them too;
// pr-data/models.json keeps them across restarts.
const modelsFile = () => `${appHome()}/pr-data/models.json`;
const modelsDoc = () => shared("review.models") ?? {};
// A model's name as its CLI calls it ("Opus 5.5"), else the class label, else the value itself.
export const modelLabel = (m) => Object.values(modelsDoc()).flatMap((d) => d?.claude ?? []).find((x) => x.value === m)?.label ?? MODELS[m]?.label ?? m;
// Codex's models (one login for every context): from whichever context asked last.
const codexChoices = () => Object.values(modelsDoc()).map((d) => d?.codex ?? []).find((l) => l.length) ?? [];
// The model id a picker value stands for ("opus" -> "claude-opus-5-5"), from the CLI's list.
const resolvedOf = (m) => Object.values(modelsDoc()).flatMap((d) => d?.claude ?? []).find((x) => x.value === m)?.resolved ?? m;
// "$4 / $20 per MTok": input and output.
const priceText = (m) => { const [i, o] = priceOf(resolvedOf(m)); return `$${i} / $${o} per MTok`; };
// The choices for a context: the CLI's aliases (opus, fable, sonnet: each its family's newest model; older models by
// full id are left out, unless one is the current pick), or the classes until the CLI answered. Never Haiku: every
// choice here reads or judges code (codeModel).
const modelChoices = (ctx) => {
  const list = modelsDoc()[ctx]?.claude ?? [], cur = model();
  const shown = list.filter((c) => (!c.value.startsWith("claude-") || c.value === cur) && tierOf(c.value) !== "haiku");
  return shown.length ? shown : Object.entries(MODELS).filter(([k]) => k !== "haiku").map(([value, v]) => ({ value, label: v.label, description: "" }));
};
const cacheDir = () => `${appHome()}/pr-data/cache`;
const valuesOn = () => shared("review.values") !== false; // inline example values (flow traces), on by default
const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const CAP = { haiku: 1, sonnet: 3, opus: 10 }; // review.py BUDGET, per tierOf class
const findDir = () => `${appHome()}/pr-data/findings`;
const threadsFile = () => `${appHome()}/pr-data/threads.json`; // sent and posted comments as threads (threads.js bounds it)
const repliesDir = () => `${appHome()}/pr-data/replies`; // the agent's answers, <pr hash>.jsonl
const exploreDir = () => `${appHome()}/pr-data/explore`; // explorations: <id>.json and index.json (the newest 20)
const deepFile = () => `${appHome()}/pr-data/deep.json`; // Ask threads per PR and drill-downs per node (explore.js bounds both)
const ctxDoc = () => shared(C.CONTEXTS_KEY);
const prCtx = (pr) => C.prContext(ctxDoc(), pr, home());
const ALL_REVIEWERS = { claude: ["Claude code review", "ansi5"], security: ["Security review", "ansi1"], resilience: ["Resilience review", "ansi4"], codex: ["Codex review", "ansi6"] };
// Codex is optional: offered only when `codex` is on PATH (Setup's last check). Labels stay for findings already there.
// The analysis files its own findings inside its layers, and an AI suggestion can be one source of a finding (pr.js
// mergeFindings): a label and colour here, never a run of their own.
const REVIEWERS = { ...ALL_REVIEWERS, analysis: ["Analysis", "ansi4"], ai: ["AI note", "ansi3"] }; // the same word as the one-line notes in the diff
const reviewersNow = () => Object.entries(ALL_REVIEWERS).filter(([k]) => k !== "codex" || hasTool("codex"));
// A finding's state words (pr.js findingStatus): "Fixed" only after a passed verification.
const FSTATUS = { open: ["Unresolved", "muted"], progress: ["Fix sent", "ansi3"], fixed: ["Fixed", "ansi2"], dismissed: ["Dismissed", "dim"], recheck: ["Unresolved, line changed", "ansi3"] };
const SEV = { high: "ansi1", medium: "ansi3", low: "ansi4" };
// Where a card comes from: its stripe, and the Show switch's colours.
const SOURCE = { mine: "accent", ai: "ansi3", agents: "ansi6", github: "ansi4", notes: "ansi5" };
// Hover texts for the Show chips, the Comments tab's filters and its state chips.
const SHOW_TIP = { mine: "Comments you wrote: drafts (local until you finish the review), sent to agents, or posted", ai: "Findings and AI notes under their lines", agents: "Replies from agent sessions", github: "Comments other people left on GitHub", notes: "Your pinned notes, private to you" };

const TAB_TIP = { files: "The changed files; tick the ones you have viewed", steps: "The AI analysis: the PR's pages and the layers of this change, with explanations and pictures", findings: "Every finding once, with its sources and its state; fixes sent to an agent and their verification", comments: "All comments on this PR: yours, the agents' and GitHub's" };
const COVER_TIP = { seen: "The diff does what this asks", partly: "The diff does only part of what this asks", absent: "Nothing in the diff does this", extra: "The diff does this, but it was not asked for" };
const COMPOSE_TIP = { insertSuggestion: "Insert the selected lines as a GitHub suggestion block", closeComposer: "Close the composer without saving (Esc)", addDraft: "Add to your pending review; nothing is posted yet (⌘↩)", singleComment: "Post this one comment at once, or preview it first when it goes to an agent" };
const STATE_TIP = { pending: "Pending: written by you, not sent yet", waiting: "Sent to agent: no reply yet", replied: "Agent replied, or someone answered on GitHub", fixed: "Reported fixed: the agent says it is done; nothing has checked it", declined: "Declined: the agent chose not to change it", github: "A comment from GitHub", note: "A pinned note, private to you" };
const STALE_TIP = "The code here changed since this comment was written";
const CARD_W = 720, CARD_MIN = 420, CARD_HEAD = 32, CARD_REPLY = 34, CARD_GAP = 6;
// The "select to fix" box of a card that is one item of the list (a finding's card, a GitHub comment): it stands in
// the gutter, left of the card's head, because a press on an item is known by its x only. Its zone, x from the list's
// left edge; sideBox draws it (off: a security finding about access or data, which goes alone).
const SIDE_BOX = [GUTTER - 30, GUTTER - 4];
const sideBox = (t, id, top, { sel = false, off = false, lit = false, tip }) => div().id(id).tooltip(tip).accessibility_label("Select to fix").absolute().left(SIDE_BOX[0] + 6).top(top).w(14).h(14).rounded(3).border_1()
  .border_color(sel ? t.accent : off ? t.border : t.input).bg(sel ? t.accent : off ? t.raised : t.background).flex().items_center().justify_center().text_size(TYPE.micro).text_color(t.accent_foreground)
  .opacity(sel || lit ? 1 : 0.45).hover((s) => s.opacity(1)).child(sel ? "✓" : "");
const THREAD_COLOR = { fixed: "ansi2", answered: "accent", wontfix: "muted", question: "ansi3", sent: "ansi4", posted: "ansi4" };
const PROBE = "0".repeat(40);
const CTX_MS = 10 * 60000; // related PRs, CI checks, mergeability (related.py): asked again after this when the review opens, else by ↻
const GH_MS = 5 * 60000; // the PR's head and its GitHub review comments while the review is open and the window in front (ghTick)
const OPEN_ST = ["open", "progress", "recheck"];
// A finding's card in the diff: its height folded, the label column of an open one, the link at its head's right end.
const FIND_FOLDED = 34, FIND_LABEL = 112, FIND_LINK = 150;
const FIND_TEXT = 760; // the widest a text that is read gets in a card of the diff: about 110 characters at 13.5 px
// A layer's head over its code: its texts wrap at about 95 characters instead of running across the whole column.
const LAYER_TEXT = 640;
// The Analysis tab's pages (at its top, above the layers); null: the diff of the current layer.
const PAGES = [["overview", "Overview"], ["blast", "Security"], ["arch", "Architecture impact"], ["res", "Resilience"]]; // measures the mono font's character width, for clicks on tokens inside the virtual list

// "Reviews ▾" in the bar opens this popup (props {part: "reviews"}): each reviewer with its last run; Run reaches the
// review copy through its nextCommand.
// Every run that makes findings is a row, the analysis first: what it found (a zero says whether it ran, threads.js
// runLine), its price and when. Below: who gets the code, on which account. The popup is as high as its rows.
const REVIEW_CAP = { haiku: 0.5, sonnet: 3, opus: 8 }; // reviewers.py BUDGET, per tierOf class
const codexMenu = () => [{ value: "", label: "Codex default" }, ...codexChoices()];
const openCodexMenu = () => { const cur = shared("review.codexModel") || ""; return openOverlay({ mod: "pr-review", props: { part: "cmenu", key: "codex",
  items: codexMenu().map((c) => [`${c.value === cur ? "✓ " : ""}${c.label}`, false, `codex-model:${c.value}`]) }, kind: "popup", width: 240, height: 14 + 32 * codexMenu().length }); };
const reviewsPop = () => { const cx = hasTool("codex"); return { width: 500, height: 28 + 60 * (reviewersNow().length + 1) + (cx && codexChoices().length ? 36 : 0) + (cx ? 152 : 60) }; };
export function renderReviews() {
  const t = theme(), runs = runsOf(shared("review.reviewers") ?? {}), meta = shared("review.meta") ?? {}, pr = shared("review.target"), mine = meta.url === pr?.url;
  const total = mine ? meta.findings?.total ?? 0 : 0, a = mine ? meta.shown : null, cap = REVIEW_CAP[tierOf(model())];
  const row = (k, label, c, line, bad, right) => h_flex().id(`rv-rr-${k}`).gap(10).px(8).py(6).rounded(7).items_center()
    .child(div().w(8).h(8).flex_none().rounded_full().bg(t[c]))
    .child(v_flex().flex_1().min_w(0).child(div().font_semibold().child(label)).child(div().text_size(TYPE.small).line_height(1.4).whitespace_normal().text_color(bad ? t.ansi1 : t.muted).child(line)))
    .children([right].filter(Boolean));
  const cur = codexMenu().find((c) => c.value === (shared("review.codexModel") || "")) ?? codexMenu()[0];
  return v_flex().id("rv-reviews").size_full().p(8).gap(4).bg(t.popover).text_color(t.foreground).text_size(TYPE.body)
    .child(row("analysis", REVIEWERS.analysis[0], REVIEWERS.analysis[1], mine && meta.busy ? `Running with ${modelLabel(meta.busy)}`
      : a ? [`${meta.findings?.analysis ?? 0} ${meta.findings?.analysis === 1 ? "finding" : "findings"}`, a.cost != null ? `$${Number(a.cost).toFixed(3)}` : null, modelLabel(a.model)].filter(Boolean).join(" · ")
      : "Not run on this PR yet. It starts from the Overview page.", false, null))
    .children(reviewersNow().map(([k, [label, c]]) => {
      const r = runs[k], n = r?.count ?? 0, done = r?.state === "done";
      const line = TH.runLine(r, n ? 0 : total, { running: r?.started ? clock(Date.now() - Date.parse(r.started)) : "", took: r?.ms ? clock(r.ms) : null, ago: r?.at ? ago(r.at) : null })
        + (k === "codex" ? (done ? " · Codex does not report its price" : "") : !r?.state ? ` · capped at $${cap}` : "") + (k === "security" && mine && meta.securityOffer ? `. ${meta.securityOffer}` : "");
      return row(k, label, c, line, r?.state === "failed", r?.state === "running" ? div().flex_none().child(SPIN[0]).frames(SPIN, 90)
        : pill(`rv-rrun-${k}`, t, runLabel(r, k === "codex" || !mine ? null : meta.prices?.[k] ?? null, "", true), () => { run(`pr-review.reviewer:${k}`); closeOverlay(props().overlay); }).flex_none()
          .tooltip(k === "codex" ? `Run the codex CLI on the PR head, with its own login; its price is not reported. ${TH.CODEX_MAY} On someone else's PR in Restricted Mode it asks once first.` : `One read-only review of the PR head with ${modelLabel(model())}, capped at $${cap}`));
    }))
    .when(hasTool("codex") && codexChoices().length > 0, (e) => e.child(h_flex().px(8).gap(8).items_center()
      .child(div().text_size(TYPE.small).text_color(t.muted).child("Codex review model"))
      .child(pill("rv-cxm", t, `${cur.label} ▾`, () => openCodexMenu()).tooltip(cur.description || "The model in Codex's own settings"))))
    .child(div().px(8).pt(4).text_size(TYPE.small).line_height(1.45).whitespace_normal().text_color(t.muted)
      .child(`Claude reviews: ${accountOf(pr ? prCtx(pr) : C.defaultOf(ctxDoc()))}. They read the PR head in a checkout, read-only, and send the diff and the files they open to the provider.`
        + (hasTool("codex") ? ` Codex review: the codex CLI with its own login. It is a second provider (OpenAI) and gets the same checkout. ${TH.CODEX_MAY}` : "")));
}

// "?" in the bar (or the ? key) opens this popup (props {part: "keys"}): the review's keys.
export function renderKeys() {
  const t = theme();
  return v_flex().id("rv-keys-pop").size_full().p(12).gap(7).bg(t.popover).text_color(t.foreground).text_size(TYPE.body)
    .child(div().font_semibold().child("Keyboard shortcuts"))
    .child(div().pb(2).text_size(TYPE.small).whitespace_normal().child("Click a line number or press c to comment; shift-click for a range."))
    .children([["j k", "next / previous file (Analysis tab: layer)"], ["n p", "next / previous hunk"], ["c", "comment on the selected line"], ["a x", "add the open AI note as a comment / hide it"],
      ["⌘ click", "go to definition"], ["⌘ ↩", "add the comment (in the composer)"], ["Esc", "close composer or popover, else back"]].map(([k, what]) =>
      h_flex().gap(10).items_center().child(h_flex().w(74).flex_none().gap(3).children(k.split(" ").map((x) => kbd(t, x)))).child(div().text_color(t.muted).child(what))));
}

// A small menu (props {part: "cmenu", key, items: [[label, danger, command?]]}): an item runs pr-review.<command>, or
// for a comment card's "⋯" pr-review.cmenu:<index>|<card key>, in the review copy.
export function renderCardMenu() {
  const t = theme(), { key, items = [], overlay } = props();
  return v_flex().id("rv-cmenu").size_full().p(4).gap(1).bg(t.popover).text_color(t.foreground).text_size(TYPE.body)
    .children(items.map(([label, danger], k) => div().id(`rv-cm-${k}`).px(10).py(5).rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
      .text_color(danger ? t.ansi1 : t.foreground).on_click(() => { run(`pr-review.${items[k][2] ?? `cmenu:${k}|${key}`}`); closeOverlay(overlay); }).child(label)));
}

// The title bar of the floating agent terminal (props {part: "agentbar", title}): drag it, close it.
export function renderAgentBar() {
  const t = theme();
  return h_flex().id("rv-agentbar").size_full().px(12).gap(8).items_center().bg(t.chrome).text_size(TYPE.body).text_color(t.foreground)
    .child(div().flex_1().min_w(0).truncate().font_semibold().child(props().title ?? "Agent"))
    .child(div().text_size(TYPE.small).text_color(t.muted).child("prompt pasted, not sent: add words, Enter to send"))
    .child(pill("rv-agent-close", t, "Close", () => closeOverlay(props().overlay)).tooltip("Close this agent window"));
}
const stop = (_e, cx) => cx.stop_propagation(); // a control in the window-drag bar

// ponytail: last writer wins per key; a retry covers a concurrent write, not two copies editing one key at once.
export async function saveKey(path, key, value) {
  for (let attempt = 0; ; attempt++) {
    const before = await readTextFile(path).catch(() => null);
    const doc = before ? JSON.parse(before) : {};
    if (value === undefined) delete doc[key]; else doc[key] = value;
    try { return await writeTextFile(path, JSON.stringify(doc, null, 1), before); } catch (e) { if (attempt) throw e; }
  }
}

// Opens a PR in the review layout; Back returns to the layout shown now. The first time, the layout is copied from
// this folder into layouts/ ("review", or "pr-review" when another "review" layout is there; pr.js layoutPlan).
export async function startReview(target) {
  const dir = `${appHome()}/layouts`, read = (name) => readTextFile(`${dir}/${name}.json`).catch(() => null);
  const plan = layoutPlan(await read("review"), await read("pr-review"));
  if (plan.write) {
    await exec("mkdir", ["-p", dir]).catch(() => null);
    const text = await readTextFile(`${appHome()}/mods/pr-review/review-layout.json`);
    await writeTextFile(`${dir}/${plan.name}.json`, text, null).catch(() => null); // null: only when still missing
  }
  const back = shared("layout");
  if (back && back !== plan.name) setShared("review.back", back);
  setShared("review.layout", plan.name);
  setShared("review.explore", null);
  setShared("review.target", target);
  if (shared("review.minimized")?.target?.url === target?.url) setShared("review.minimized", null); // back in it: no entry
  run("layout.switch", { name: plan.name });
}

// Opens Explore in the review layout (pr-review.explore, the panel's "Explore a topic…", the review's ⋯ menu): a topic
// walked through in existing code, no PR. root: the repo to explore (default: the active space's repo, chosen there).
// resume: the page as it was minimized (review.minimized.explore): it opens again with its topic, its run, its result.
export async function startExplore(root = null, resume = null) {
  const dir = `${appHome()}/layouts`, read = (name) => readTextFile(`${dir}/${name}.json`).catch(() => null);
  const plan = layoutPlan(await read("review"), await read("pr-review"));
  if (plan.write) {
    await exec("mkdir", ["-p", dir]).catch(() => null);
    await writeTextFile(`${dir}/${plan.name}.json`, await readTextFile(`${appHome()}/mods/pr-review/review-layout.json`), null).catch(() => null);
  }
  const back = shared("layout");
  if (back && back !== plan.name) setShared("review.back", back);
  setShared("review.layout", plan.name);
  setShared("review.explore", resume ? { ...resume, at: Date.now() } : { start: true, root, space: focused()?.space ?? null, at: Date.now() });
  if (resume) setShared("review.minimized", null); // back in it: no entry
  run("layout.switch", { name: plan.name });
}
// Leaving hands the review's PR to the panel (shared "pr.fromReview"): back there it shows this PR, whichever way the
// review was opened (a Resume in a list, the minimized chip, Go to, a related PR), not the one picked before.
const leave = () => { const pr = shared("review.target"); if (pr?.url) setShared("pr.fromReview", pr); run("layout.switch", { name: shared("review.back") || "main" }); };
// Minimize: back to the previous layout with the review kept as one entry (part "mini", a float in the main layout):
// Open brings it back where it was, ✕ drops it. One at a time: minimizing another review replaces it.
const minimize = () => { const pr = shared("review.target"); if (pr) setShared("review.minimized", { target: pr, at: Date.now() }); leave(); };
// run: what became of a minimized Explore run ({id, state: "done" | "failed"}; main.js miniPoll reads its status file).
export function renderMini(run = null) {
  const t = theme(), pr = shared("review.minimized")?.target, ex = shared("review.minimized")?.explore;
  if (ex) return miniExplore(t, ex, run);
  if (!pr) return div();
  const open = (shared("review.open") ?? []).find((r) => r.url === pr.url); // the review's own count, as the panel shows it
  // A small chip, so it covers little of the terminal under it: the PR number, its full title in the tooltip.
  return h_flex().id("rv-mini").h(28).pl(10).pr(3).gap(6).items_center().rounded_full().border_1().border_color(t.border).bg(t.popover)
    .text_size(TYPE.small).text_color(t.foreground).tooltip(`${pr.repo ?? ""}#${pr.number ?? ""} ${pr.title ?? ""}`)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation()) // a press the mod doesn't stop would drag the float
    .child(div().flex_none().font_semibold().child(`Review #${pr.number ?? ""}`))
    .when(Boolean(pr.title), (e) => e.child(div().flex_none().max_w(220).truncate().text_color(t.muted).child(pr.title)))
    // The review's own mark, as its rows carry it: "⛨ high" in red when an unresolved finding is about security.
    // Its color is the severity's, its form how sure that is (views.js signOf), as on the review's own rows.
    .children(rowMarks(open?.risk, null).map((m) => div().id("rv-mini-risk").tooltip(`The highest severity among this review's unresolved findings${m.words ? `: ${m.words}` : ""}`).flex_none().px(5).rounded(4).text_size(TYPE.small)
      .text_color(t[m.color] ?? t.muted).bg((t[m.color] ?? t.muted) + "26").child(markLabel(div, t, m))))
    .when(Boolean(open?.progress?.findingsOpen), (e) => e.child(div().flex_none().text_color(t.muted).child(`${open.progress.findingsOpen} unresolved`)))
    .child(div().id("rv-mini-open").px(8).h(22).flex().items_center().rounded_full().cursor_pointer().text_color(t.accent).hover((x) => x.bg(t.hover))
      .tooltip("Back to the review, where you left it").on_click(() => startReview(pr)).child("Resume"))
    .child(div().id("rv-mini-x").w(22).h(22).flex().items_center().justify_center().rounded_full().cursor_pointer().text_color(t.muted).hover((x) => x.bg(t.hover))
      .tooltip("Remove this chip. The review stays in progress with its comments; the panel's In progress resumes it.").accessibility_label("Remove the minimized review's chip").on_click(() => setShared("review.minimized", null)).child("✕"));
}

// Explore, minimized: what it is about (the topic, else "Explore: <repo>"), a run that is going or has ended meanwhile,
// Resume (the page again with its topic, its run and its result) and ✕.
export const miniExploreText = (ex, run = null, now = Date.now()) => {
  const repo = ex.repo ?? ex.exRoot?.repo ?? (ex.root ?? ex.exRoot?.root ?? "").split("/").pop() ?? "", topic = String(ex.topic ?? ex.busy?.topic ?? ex.draft ?? "").trim();
  const ended = ex.busy && run?.id === ex.busy.id ? run.state : null;
  return { head: topic ? "Explore" : `Explore${repo ? `: ${repo}` : ""}`, topic, repo,
    state: !ex.busy ? (ex.err ? "failed" : null) : ended === "done" ? "done" : ended === "failed" ? "failed" : "running",
    text: !ex.busy ? (ex.err ? "the run failed" : "") : ended === "done" ? "the walkthrough is ready" : ended === "failed" ? "the run failed" : `running · ${clock(now - ex.busy.started)}` };
};
function miniExplore(t, ex, run) {
  const m = miniExploreText(ex, run);
  return h_flex().id("rv-mini").h(28).pl(10).pr(3).gap(6).items_center().rounded_full().border_1().border_color(t.border).bg(t.popover)
    .text_size(TYPE.small).text_color(t.foreground).tooltip([m.topic || "Explore a topic", m.repo, m.state === "running" ? "The run goes on while this is minimized." : null].filter(Boolean).join("\n"))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation()) // a press the mod doesn't stop would drag the float
    .child(div().flex_none().font_semibold().child(m.head))
    .when(Boolean(m.topic), (e) => e.child(div().flex_none().max_w(260).truncate().text_color(t.muted).child(m.topic)))
    .when(m.state === "running", (e) => e.child(div().flex_none().text_color(t.muted).child(SPIN[0]).frames(SPIN, 90)))
    .when(Boolean(m.text), (e) => e.child(div().id("rv-mini-run").flex_none().text_color(m.state === "failed" ? t.ansi1 : m.state === "done" ? t.ansi2 : t.muted).child(m.text)))
    .child(div().id("rv-mini-open").px(8).h(22).flex().items_center().rounded_full().cursor_pointer().text_color(t.accent).hover((x) => x.bg(t.hover))
      .tooltip("Back to Explore: the topic, the run and its result as you left them").on_click(() => startExplore(ex.root ?? null, ex)).child("Resume"))
    .child(div().id("rv-mini-x").w(22).h(22).flex().items_center().justify_center().rounded_full().cursor_pointer().text_color(t.muted).hover((x) => x.bg(t.hover))
      .tooltip("Remove this chip. A run that is going finishes anyway; its walkthrough is then listed under Explorations.").accessibility_label("Remove the minimized Explore chip").on_click(() => setShared("review.minimized", null)).child("✕"));
}

const pill = (id, t, label, click, on = false, color) => div().id(id).flex_none().whitespace_nowrap().px(9).h(26).flex().items_center().rounded(6).border_1()
  .border_color(on ? t.accent : t.border).text_size(TYPE.small).text_color(color ?? (on ? t.foreground : t.muted)).cursor_pointer()
  .hover((s) => s.text_color(t.foreground)).on_mouse_down("left", stop).on_click(click).child(label);
// A state, not a button: tinted, without the frame that buttons (pill) have.
const badge = (t, label, color) => div().flex_none().px(6).py(1).rounded(5).bg(color + "1f").text_size(TYPE.small).font_semibold().text_color(color).child(label);
// A layer's "risk" is how closely to read it (what its code touches), not a finding: named and coloured as reading
// depth, so it doesn't look like a problem next to the findings' high/medium/low.
const FOCUS = { high: ["Read closely", "it touches security, data or migrations, auth or concurrency"], medium: ["Read", "it changes core logic or an API/contract"],
  low: ["Glance", "configuration or small things"], skim: ["Skim", "tests, renames, formatting, generated code or docs"] };
const focusLabel = (s) => FOCUS[s.risk]?.[0] ?? s.risk;
const focusTip = (s) => (FOCUS[s.risk] ? `How closely to read this layer: ${FOCUS[s.risk][1]}. Not a finding.` : "How closely to read this layer");
const focusColor = (t, s) => (s.risk === "high" ? t.accent : t.muted);
const riskBadge = (t, s) => badge(t, focusLabel(s), focusColor(t, s));
const kbd = (t, k) => div().px(5).min_w(18).h(18).flex().items_center().justify_center().rounded(4).border_1().border_color(t.border).bg(t.raised)
  .text_size(TYPE.small).text_color(t.foreground).child(k);
// A button drawn inside the virtual list (no handler there: onItem places the click by x).
const button = (t, label, border, color) => div().w(BTN).h(28).flex_none().flex().items_center().justify_center().rounded(6).border_1()
  .border_color(border).bg(t.background).text_size(TYPE.small).text_color(color).child(label);
// The model picker (shared "review.model": the AI analysis, Sonnet by default).
// The picker's short form: the CLI's aliases (opus, sonnet, …: each its family's newest), else the three classes.
export const modelPills = (t, id) => {
  const seen = new Map();
  for (const c of Object.values(modelsDoc()).flatMap((d) => d?.claude ?? [])) if (!c.value.startsWith("claude-") && tierOf(c.value) !== "haiku" && !seen.has(c.value)) seen.set(c.value, c.label);
  const pills = seen.size ? [...seen] : Object.entries(MODELS).filter(([k]) => k !== "haiku").map(([k, v]) => [k, v.label]);
  return h_flex().gap(4).flex_wrap().children(pills.map(([k, label]) =>
    pill(`${id}-${k}`, t, label, () => setShared("review.model", k), model() === k).tooltip(`Use ${label} for the AI calls`)));
};

// What goes into and out of a changed function (review.py "flows"): signature, In and Out examples, side effects.
// onJump(event, cx): the function name was clicked.
export function flowCard(f, t, id, onJump) {
  const mono = settings().font_family ?? "JetBrains Mono";
  const code = (text) => v_flex().p(8).rounded(6).bg(t.background).font_family(mono).text_size(TYPE.small).text_color(t.foreground)
    .children(String(text ?? "").split("\n").slice(0, 14).map((l) => div().child(l.replace(/^ +/, (m) => " ".repeat(m.length)) || " ")));
  const block = (label, parts) => v_flex().gap(4)
    .child(h_flex().gap(6).items_center().text_size(TYPE.small).text_color(t.muted).child(div().font_semibold().child(label)).child(div().child("example")))
    .children(parts.map(([head, ex], k) => v_flex().id(`${id}-${label}-${k}`).gap(2)
      .child(div().font_family(mono).text_size(TYPE.small).text_color(t.accent).child(head)).child(code(ex))));
  return v_flex().id(id).flex_none().mt(4).p(10).gap(8).rounded(8).border_1().border_color(t.border).bg(t.surface).text_size(TYPE.body)
    .child(h_flex().gap(8).items_center()
      .child(div().id(`${id}-fn`).font_family(mono).font_semibold().text_color(t.accent).when(Boolean(onJump), (e) => e.cursor_pointer().on_click(onJump))
        .child(`${f.function}(${(f.inputs ?? []).map((i) => i.name).join(", ")})`))
      .child(div().flex_1().min_w(0).truncate().text_size(TYPE.small).text_color(t.muted).child(f.at ?? "")))
    .when((f.inputs ?? []).length > 0, (e) => e.child(block("In", f.inputs.map((i) => [`${i.name}: ${i.type}`, i.example]))))
    .when(Boolean(f.output), (e) => e.child(block("Out", [[f.output.type, f.output.example]])))
    .when((f.side_effects ?? []).length > 0, (e) => e.child(h_flex().flex_wrap().gap(4).children(f.side_effects.map((x) =>
      div().px(6).py(1).rounded(5).bg(t.raised).text_size(TYPE.small).text_color(t.foreground).child(x)))))
    .when((f.calls ?? []).length > 0, (e) => e.child(div().text_size(TYPE.small).text_color(t.muted).child(`calls: ${f.calls.join(", ")}`)));
}

// Markdown markers dropped where a line is drawn as plain text (list rows).
const plain = plainText; // one plain line of a Markdown text: its first paragraph, no code blocks, no marks (pr.js)
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return !Number.isFinite(m) ? "" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };


export const ReviewMode = {
  initReview(cx) {
    this.tab = "files"; this.cur = 0; this.focusHunk = null; this.fsel = null; this.sug = null;
    this.ai = null; this.aiBusy = false; this.aiError = null; this.aiModel = null; this.diaBusy = null; this.diaError = null;
    this.prog = { visited: new Set(), checked: {}, handled: {}, seen: new Set() };
    this.full = {}; this.gaps = {}; this.whole = new Set(); this.collapsed = new Set(); this.closedDirs = new Set();
    // Handles are made here only: creating one later (in a task) throws, which broke the definition view.
    this.lists = { steps: VirtualListScrollHandle.new(), files: VirtualListScrollHandle.new(), def: VirtualListScrollHandle.new() };
    this.leftScroll = ScrollHandle.new(); // the Layers tab's left column
    this.pageScrolls = Object.fromEntries(PAGES.map(([k]) => [k, ScrollHandle.new()])); // the right pane's pages (page-part:<name>)
    this.order = "reading"; this.flowSel = null;
    this.page = "overview"; this.archMode = "diff"; this.fold = { summary: true, blockers: true, checks: false }; this.blastOpen = false;
    this.ctx = null; this.since = null; this.sinceOn = false; this.lastReviewed = null; this.verifyBusy = false;
    this.find = { list: [], runs: {}, status: {}, reports: {} };
    // Reviewer runs and the fixing agent's reports land in pr-data/findings: follow that folder.
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", findDir()]).catch(() => null);
      while (!this.closed) { this.findWatch = watchFolder(findDir()); await this.findWatch.catch(() => null); await this.loadFindings(cx); } // close() cancels it (main.js)
    });
    this.press = { x: 0, w: 0, shift: false }; this.items = []; this.at = {};
    // The inline composer (one at a time, under the selection) and the Finish-your-review popover's summary.
    this.composing = false; this.finishOpen = false; this.event = null; this.route = null; this.posted = null; this.gh = [];
    this.draft = TextareaState.new({ placeholder: "Leave a comment" });
    this.summary = TextareaState.new({ placeholder: "Leave a comment" });
    // Threads: sent/posted comments with their replies; the GitHub preview's ticks and inline edit; the agent preview.
    this.threadDoc = {}; this.replies = {}; this.openThreads = new Set(); this.off = new Set(); this.summaryOn = true; this.editItem = null; this.replyTo = null; this.sendP = null;
    this.itemEdit = TextareaState.new({ placeholder: "Comment text" });
    this.sendText = TextareaState.new({ placeholder: "What the agent gets" });
    this.sendText.set_auto_grow(4, 11); // short texts get a short box; a long one scrolls inside (the preview says so)
    this.replyIn = InputState.new({ placeholder: "Reply in this thread… (Enter: preview)" });
    this.exTopic = InputState.new({ placeholder: "How does the reminder job get scheduled and sent? (Enter)" });
    this.exTopic.on("submit", (_e, cx) => this.runExplore(cx));
    this.replyIn.on("submit", (_e, cx) => this.followup(cx));
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", repliesDir()]).catch(() => null);
      while (!this.closed) { this.replyWatch = watchFolder(repliesDir()); await this.replyWatch.catch(() => null); await this.loadThreads(cx); }
    });
    this.ghPoll = pollAfter(null, true, Date.now()); // opening asks GitHub (onSource, refresh): the first tick is GH_MS later
    cx.timer.every(60000, (cx) => this.ghTick(cx)); // a time check; GitHub at most every GH_MS (ghTick)
    cx.timer.every(20000, (cx) => this.fixCostTick(cx)); // a running fix agent's cost so far, from its session log
    cx.timer.every(10000, (cx) => { this.proofTick(cx); this.probeTick(cx); }); // Verify with an agent and the probes: their answer files, while one runs
    for (const [st, k] of [[this.draft, "draft"], [this.summary, "summary"], [this.itemEdit, "item"], [this.sendText, "send"]]) {
      st.on("focus", (_e, cx) => { this.typing = k; cx.notify(); });
      st.on("blur", (_e, cx) => { if (this.typing === k) this.typing = false; cx.notify(); });
    }
    this.prSel = shared("review.target") ?? null;
    // An old pick of Haiku: switched to Sonnet once, with the reason.
    if (tierOf(String(shared("review.model") ?? "sonnet")) === "haiku") {
      setShared("review.model", "sonnet");
      this.note = "Switched the model from Haiku to Sonnet: Haiku is fine for text, but too weak to reason about code.";
    }
    cx.spawn(async (cx) => { this.cfg = await readConfig(); await loadSetup(this, cx); });
    if (!shared("review.models")) cx.spawn(async (cx) => { try { setShared("review.models", JSON.parse(await readTextFile(modelsFile()))); cx.notify(); } catch { /* none yet */ } });
    // Ask about this: one input (the Architecture page's or the shown layer's), threads and drill-downs from deep.json.
    this.askIn = InputState.new({ placeholder: "Ask about this… (Enter)" });
    this.askIn.on("submit", (_e, cx) => this.askNow(cx));
    this.deep = { threads: {}, drills: {}, pins: {}, drawer: {} }; this.askBusy = null; this.askErr = null; this.askAbout = null;
    cx.spawn(async (cx) => { const d = JSON.parse(await readTextFile(deepFile()).catch(() => null) ?? "null"); if (d) this.deep = { threads: d.threads ?? {}, drills: d.drills ?? {}, pins: d.pins ?? {}, drawer: d.drawer ?? {}, runModels: d.runModels ?? {}, probes: d.probes ?? {} }; cx.notify(); });
    this.refresh(cx);
    this.fh.focus();
    cx.timer.after(400, () => this.fh.focus());
    // Commands for keys.json ("pr-review.files") and scripts (herdr-app do pr-review.step:2).
    this.listen(cx, (c, cx) => this.command(c, cx)); // main.js: goes on after a command that threw or was stopped
  },

  command(c, cx) {
    const [name, ...rest] = c.split(":"), arg = rest.join(":");
    this.note = null; // the next action ends a note that stays (an error); its own note follows
    if (editorCommand(this, c, cx, copyText)) return cx.notify(); // editor:<path>[:<line>], and the ▾ menu's entries
    if (name === "steps" || name === "files" || name === "findings" || name === "comments") this.tab = name;
    else if (name === "analysis") this.tab = "steps"; // the tab's name; "steps" stays valid
    else if (name === "def") this.defineAt(arg, cx);
    else if (name === "cfile") { this.tab = "comments"; this.openCommentFile(arg); } // a file heading's click in the Comments tab
    else if (name === "crow") { const r = this.commentRowsNow().find((x) => x.id === arg); if (r) { this.tab = "comments"; this.openCommentRow(r, cx); } } // a row's click in the Comments tab
    // page:verify is the Findings tab now: fixes sent and their verification sit there, under "Fix sent".
    else if (name === "page" && arg === "verify") this.tab = "findings";
    else if (name === "page") { this.tab = "steps"; this.page = PAGES.some(([k]) => k === arg) ? arg : "overview"; this.defFile = null; }
    else if (name === "finding") { const f = this.findingById(arg); if (f) { this.openFinding(f); this.jumpTo(`${f.file}:${f.line}`, cx); } } // finding:<id>: a click on its row in the Findings tab
    // The same as their clicks in the Findings tab: a step of the open finding (finding-step:sent | verified, again to
    // fold it) and the order (findings-sort:quick, findings-sort: for the usual one).
    else if (name === "finding-step") this.fstep = this.fstep?.id === this.ffocus && this.fstep.key === arg ? null : { id: this.ffocus, key: arg };
    else if (name === "findings-sort") this.fsort = arg === "quick";
    else if (name === "verify") this.runVerify(cx);
    else if (name === "step") this.goStep(arg === "next" ? this.cur + 1 : arg === "prev" ? this.cur - 1 : Number(arg), cx);
    else if (name === "hunk") this.goHunk(arg === "prev" ? -1 : 1, cx);
    else if (name === "file") { this.tab = "files"; this.fileFocus = arg; this.unfold(arg); this.scrollTo("files", arg); }
    else if (name === "whole") { this.tab = "files"; this.toggleWhole(arg, cx); this.scrollTo("files", arg); }
    else if (name === "gap") { const [path, k] = arg.split("#"); this.tab = "files"; this.expand(path, Number(k), "all", cx); }
    else if (name === "analyze") this.loadAi(cx, "run");
    else if (name === "cancel") this.cancelAi(cx);
    else if (name === "reviewer") this.runReviewer(arg, cx);
    else if (name === "done") { this.registerReview(cx, { status: "done", doneAt: Date.now() }); this.note = "Marked done: it leaves the open reviews"; }
    else if (name === "findings") this.tab = "findings";
    else if (name === "back") leave();
    else if (name === "finish") { this.finishOpen = !this.finishOpen; this.approveAsk = this.discardAsk = false; if (this.finishOpen) this.loadGhLogin(cx); }
    else if (name === "discuss") { const f = this.findingById(arg); if (f) this.discuss(f, cx); } // discuss:<finding id> (scripts, keys)
    else if (name === "keys") openOverlay({ mod: "pr-review", props: { part: "keys" }, kind: "popup", ...KEYS_POP });
    else if (name === "comment") { // comment:<path>:<line>[-<end>]: the composer under that new-side line (scripts, tests)
      const m = /^(.*):(\d+)(?:-(\d+))?$/.exec(arg);
      if (m) { this.tab = "files"; this.unfold(m[1]); this.fsel = { path: m[1], a: `+${m[2]}`, b: `+${m[3] ?? m[2]}` }; this.openComposer(cx, null, true); }
    }
    // Scripts and tests: the composer's text, then its "Post now / Send to agent…" button; the preview's "Send to agent".
    else if (name === "draft") { this.draft.set_value(arg); }
    else if (name === "single") this.singleComment(cx);
    // The same as their clicks: the ▾ beside the composer's main button, and a finding's card in the diff
    // (finding-card:<finding id> opens or folds it).
    else if (name === "compose-more") this.toggleComposeMore();
    else if (name === "comment-row") { // comment-row:<id>: a click on that row of the Comments tab (its whole text shows, the diff jumps to it)
      const r = this.commentRowsNow().find((x) => x.id === arg);
      if (r) { this.tab = "comments"; this.crow = r.id; this.jumpTo(`${r.file}:${r.line}`, cx); }
    }
    else if (name === "note") { const n = this.openSugs().find((x) => `${x.path}:${x.line}` === arg); this.sug = n && this.sug !== n.key ? n.key : null; } // note:<path>:<line>: a click on the AI note there
    else if (name === "finding-card") { const f = this.findingById(arg); if (f) (this.fopen ??= new Map()).set(f.id, !this.findOpen(f)); }
    else if (name === "send") this.sendConfirmed(cx);
    // The same as their clicks, for scripts: the preview's Cancel; "Fix several…" and a tick in its list; the Codex
    // model in the reviewers popup; in "Finish your review" a verdict, "Insert blockers" and the submit button.
    else if (name === "send-cancel") this.sendP = null;
    else if (name === "fix-several") this.fixSeveral(cx);
    else if (name === "pick-finding") this.pickFinding(arg, cx); // pick-finding:<id>: its box in the Findings tab
    else if (name === "pick-comment") this.toggleSel(arg, cx); // pick-comment:<id>: a comment's box (your own, a sent thread, gh<id> for a GitHub comment)
    else if (name === "fix-picked") this.fixSelected(cx); // "Fix selected (n)…": the same as "fix" without ids
    else if (name === "clear-selection") this.clearSel(cx);
    else if (name === "fix-pick") this.fixPick(arg, cx);
    else if (name === "codex-model") setShared("review.codexModel", arg);
    else if (name === "codex-menu") openCodexMenu();
    else if (name === "verdict") { this.event = arg; this.approveAsk = false; }
    else if (name === "insert-blockers") this.insertBlockers();
    else if (name === "submit") this.submitClick(cx);
    else if (name === "discard-pending") this.discardAsk = true; // the first click on "Discard N pending…": it only asks
    else if (name === "add-finding") { const f = this.findingById(arg); if (f) this.findingComment(f, cx); } // a finding's "Add to review"
    else if (name === "route") this.route = arg; // github | agent: where Submit and single comments go
    else if (name === "fix") { if (arg) this.fixComments(arg.split(","), cx); else this.fixSelected(cx); } // fix:<comment id>[,<id>…], else everything selected, comments and findings (the preview opens)
    else if (name === "fix-target") this.fixTarget(arg); // sub | main, in the open preview
    else if (name === "explore") startExplore(arg || null);
    else if (name === "explore-min") this.minimizeExplore(); // the Explore bar's "Minimize"
    else if (name === "explore-open") this.openExploration(arg, cx);
    else if (name === "trust-repo") { // the explored repo, or the folder when it has no github.com remote
      const key = this.ex?.repo ? "pr-review.trustedRepos" : "pr-review.trustedRoots", v = this.ex?.repo ?? this.ex?.root;
      if (v) setShared(key, [v, ...(shared(key) ?? []).filter((x) => x !== v)].slice(0, 200));
      this.applyExploreTrust();
    }
    // line:<l|r>:<line key>:<select|shift|comment|chip>:<path>: a click on that line in the shown diff, on its half side
    // by side (the unified view takes the line): on its code, shift-click on its code, on its line number, on its
    // "+ Comment" chip. The same handler as the click (onItem).
    else if (name === "line") this.pressLine(arg, cx);
    else if (name === "code-x") { const c = this.hsOf("rv-code"); c.x = Math.max(0, Math.min(c.maxX, arg === "end" ? c.maxX : Number(arg) || 0)); } // code-x:<px> | end: the long lines' scroll bar, as a drag
    else if (name === "stack") { if (arg) this.openRelated({ url: arg }, cx); } // stack:<url>: a click on a PR of the bar's "Stack: #1 → #2"
    else if (name === "wrap") setShared("review.wrap", arg === "on"); // wrap:on | off, the top bar's "Wrap" switch
    else if (name === "diff") setShared("review.diff", arg === "split" || arg === "unified" ? arg : null); // diff:split | unified (the top bar's switch), diff:auto: what fits
    else if (name === "gh-details") { const id = Number(arg) || arg; if (!(this.ghOpen ??= new Set()).delete(id)) this.ghOpen.add(id); } // gh-details:<comment id>: a click on that GitHub comment
    else if (name === "copy-link") copyText(this.prSel?.url ?? "");
    else if (name === "copy-state") this.copyState();
    else if (name === "copy-md") this.copyMd(arg);
    // The preview of Copy as Markdown: md-part:<n> ticks a section, md-code the code context, md-copy copies, md-close closes.
    else if (name === "md-part" && this.mdPrev) { const x = this.mdShown().parts[Number(arg)]; if (x && !this.mdPrev.off.delete(x.title)) this.mdPrev.off.add(x.title); }
    else if (name === "md-code" && this.mdPrev) this.mdPrev.code = !this.mdPrev.code;
    else if (name === "md-copy") this.mdCopy();
    else if (name === "md-close") this.mdPrev = null; // copy-md: this page; copy-md:verify: the context for an agent that checks the open finding, or the unresolved security findings
    else if (name === "criterion") this.toggleAsk(arg); // criterion:<ask id> | other: a click on a row of the Overview's task check
    else if (name === "open-gh") { if (this.prSel?.url) openUrl(this.prSel.url); }
    else if (name === "impact") this.impactCommand(arg, cx); // the Impact section: impact (Find callers), impact:list, impact:<path>:<line> (a card's click)
    else if (name === "model") { if (arg) setShared("review.model", codeModel(arg)); }
    // For keys and scripted demos: a card's panel on the Architecture page (card:<node id>), the layers' order
    // (order:reading | order:risk) and Minimize, the same as their clicks.
    else if (name === "card") { this.page = "arch"; this.tab = "steps"; this.archFocus = arg || null; const n = arg ? this.archL()?.nodes.find((x) => x.id === arg) : null; if (n && !this.archWrapOn()) this.hsOf("rv-arch-canvas").x = Math.max(0, n.x - 40); } // and the card in view
    // The picture's switches, the same as their clicks: arch-view:diff | before | after, arch-fit and arch-wrap (toggles);
    // sec-card:<node id> for a card of the Security page's picture.
    // page-part:<name> scrolls the open page until that part shows (pageView lists the names), as the wheel would.
    else if (name === "arch-view") { if (["diff", "before", "after"].includes(arg)) this.archMode = arg; }
    else if (name === "arch-fit") { this.archFit = !this.archFitOn(); this.hsOf("rv-arch-canvas").x = 0; this.doorShown = false; }
    else if (name === "arch-wrap") this.setArchWrap(!this.archWrapOn());
    else if (name === "infra-card") { this.page = "arch"; this.tab = "steps"; this.infraFocus = (this.infra?.cards ?? []).find((c) => c.addr === arg)?.id ?? null; } // a card of the list by file ("Infrastructure changes" with many resources) chosen by its address ("": none)
    else if (name === "sec-card") { this.page = "blast"; this.tab = "steps"; this.secCard(arg || null, cx); } // a click on a card of the Security page's picture ("": unlight)
    else if (name === "res-path") { this.page = "res"; this.tab = "steps"; this.resOpen = this.resOpen === arg ? null : arg || null; } // a click on a path of the Resilience page (its id; "" folds)
    else if (name === "res-add") { this.page = "res"; this.resAddOpen = !this.resAddOpen; } // the parts this PR adds, folded or open
    else if (name === "res-more") { this.page = "res"; this.resAll = !this.resAll; }
    else if (name === "res-clean") { this.page = "res"; this.resClean = !this.resClean; }
    else if (name === "res-tree") { this.page = "res"; this.resTreeOpen = this.resTreeOpen === arg ? null : arg || null; } // res-tree:<dependency's index>:<case>, a case's fault tree ("" folds)
    else if (name === "res-time") { this.page = "res"; this.resTimeOpen = this.resTimeOpen === false; } // the picture "Timing", folded or open
    else if (name === "res-probe-open") { this.page = "res"; this.resProbeOpen = this.resProbeOpen === arg ? null : arg; } // a probe's script and output
    else if (name === "cross") { this.page = "blast"; this.tab = "steps"; if (arg === "quiet") this.crossQuiet = !this.crossQuiet; else if (arg === "unchanged") this.crossAll = !this.crossAll; else this.crossOpen = this.crossOpen === arg ? null : arg || null; } // a click on a row of "Trust boundary crossings" (its key: a:<access id> | e:<edge index>)
    else if (name === "sec-data" || name === "sec-rights") { this.page = "blast"; this.tab = "steps"; this.secPicCommand(name, arg); } // the sections under the boundary map: fold or open; sec-data:<id> chooses a kind of data, sec-rights:all the folded rows
    else if (name === "cross-also") { this.page = "blast"; this.tab = "steps"; this.crossAlso = new Set(this.crossAlso ?? []); if (!this.crossAlso.delete(arg)) this.crossAlso.add(arg); } // a click on "2 more at this place" of a crossing (its key)
    else if (name === "vis") { this.toggleVis(arg); } // a click on a folded or open state diagram over a layer's code (vis|<layer>|<k>)
    else if (name === "run-model") { const [kind, tier] = String(arg).split(":"); if (["sonnet", "opus"].includes(tier)) this.updateDeep(cx, (d) => ({ ...d, runModels: { ...(d.runModels ?? {}), [`${this.deepKey()}|${kind}`]: tier === this.runTier(kind).tier ? null : tier } })); else this.offerMenu = this.offerMenu === kind ? null : kind; } // run-model:<kind> opens Change model, run-model:<kind>:<tier> picks one
    else if (name === "scope-row") { this.page = "blast"; this.scopeRow = this.scopeRow === arg ? null : arg || null; } // a click on a row of "What each run checked" (<area> or run:<kind>)
    else if (name === "page-part") { const k = (this.pageParts ?? []).indexOf(arg); if (k >= 0) this.pageScrolls[this.page]?.scroll_to_item(k); }
    // The same model calls as their buttons (a click each, never by themselves): Refresh diagrams, and a card's
    // Look inside / Explain (inside:<node id>).
    else if (name === "diagrams") this.refreshDiagrams(cx);
    else if (name === "inside") {
      const n = (this.ai?.arch?.nodes ?? []).find((x) => x.id === arg);
      if (n) { this.page = "arch"; this.tab = "steps"; this.archFocus = n.id;
        this.showDetails({ id: n.id, label: n.label ?? n.id, group: (this.ai.arch.groups ?? []).find((g) => g.id === n.group)?.label, at: n.at ?? n.evidence, kind: "node", description: n.description }, `arch:${n.id}`, cx, false, true); }
    }
    else if (name === "order") { if (arg === "reading" || arg === "risk") { this.order = arg; this.cur = 0; } }
    else if (name === "viewed") { if (this.patch?.some((f) => f.path === arg)) this.toggleSeen(arg, cx); } // viewed:<path>: a click on that file's "Viewed" box
    else if (name === "minimize") minimize();
    // The same as their clicks: "Run review" (the reviewers popup), the composer's "Start a review / Add review
    // comment" (add), and a finding's "Fix…" (fix-finding:<finding id>: the preview opens).
    else if (name === "reviews") { // reviews[:<x>,<y>]: where a click on the button would open it (default: the pointer)
      const [x, y] = arg.split(",").map(Number);
      openOverlay({ mod: "pr-review", props: { part: "reviews" }, kind: "popup", ...reviewsPop(), ...(Number.isFinite(y) ? { at: { x, y } } : {}) });
    }
    else if (name === "add") this.addDraft(cx);
    else if (name === "fix-finding") { const f = this.findingById(arg); if (f) this.fix([f], cx); }
    // Verify with an agent: verify-agent:<finding id>, or verify-agent:security for the unresolved security findings.
    else if (name === "fstep") { const [id, key] = String(arg).split(":"); this.fstep = id && key ? { id, key } : null; } // fstep:<finding id>:<step key>, the step's click
    else if (name === "verify-agent") this.verifyAgent(arg === "security" ? this.secOpen() : [this.findingById(arg)], cx);
    else if (name === "probe") this.probeCmd(arg, cx); // probe:<id> starts a probe of the resilience run (or asks first); probe:<id>:yes after the question
    else if (name === "trust") this.trust("pr", cx);
    else if (name === "cmenu") { const [k, ...key] = arg.split("|"), card = this.cardByKey(key.join("|")); card?.menu[Number(k)]?.[2]?.(cx); }
    else if (name === "ask") this.setDrawer(arg === "close" ? null : arg === "fold" ? "collapsed" : "open", cx); // the Ask drawer: open | fold | close
    else if (name === "worktrees") { const [x, y] = arg.split(",").map(Number); this.listWorktrees(cx, Number.isFinite(y) ? { x, y } : null); } // the ⋯ menu's "Fix worktrees…"; worktrees:<x>,<y>: where the list opens (default: the pointer)
    else if (name === "wt-remove") this.removeWorktree(Number(arg), cx); // wt-remove:<index>: a row of that list
    else if (name === "apply") { const j = this.fixes().find((f) => f.id === arg) ?? this.fixes().filter((f) => f.state === "running").at(-1); if (j) this.applyFix(j, cx); }
    else if (name === "open") {
      cx.spawn(async () => {
        const prs = JSON.parse(await readTextFile(`${appHome()}/pr-data/prs.json`).catch(() => null) ?? "{}").prs ?? [];
        const pr = prs.find((p) => p.url === arg) ?? (shared("pr.picked") ?? {})[arg];
        if (pr) setShared("review.target", pr);
      });
    }
  },

  resetReview() {
    this.reviewKey = null; this.ai = null; this.aiError = null; this.aiModel = null; this.cur = 0; this.focusHunk = null; this.fsel = null; this.sug = null;
    this.composing = false; this.editing = null; this.finishOpen = false; this.posted = null; this.gh = []; this.route = null; this.event = null;
    this.full = {}; this.gaps = {}; this.whole = new Set(); this.collapsed = new Set(); this.hunks = null;
    this.rowsMemo = null; this.ghMemo = null; this.fitMemos = null; this.kept = null; this.openH = null; this.leanBy = null; this.cut = 0; // what was computed for the PR before goes with it
    this.ctx = null; this.since = null; this.sinceOn = false; this.lastReviewed = null; this.page = "overview"; this.aiFile = null; this.needClone = null;
    this.resumed = null; this.resumeIn = null; this.pendingScroll = null; this.infra = null; this.infraMemo = null;
  },

  // A new diff: its hunks, progress and the cached analysis, if any.
  async onSource(cx) {
    const url = this.prSel?.url;
    if (!url || !this.patch) return;
    // Herdr stops a script slice after ~50 ms ("interrupted"): a big PR's hunks are made file by file, with a pause
    // (a timer, so a fresh slice) every 12 ms; the same ids and aliases as hunksOf over the whole patch.
    const patch = this.patch, hunks = [], fileHunks = new Map();
    this.hunks = null; // until they match this patch (loadAi reuses them)
    let t = Date.now();
    for (const f of patch) {
      const hs = hunksOf([f]).map((h, i) => ({ ...h, alias: `h${hunks.length + i + 1}`, rows: diffRows(h.lines) }));
      hunks.push(...hs);
      if (hs.length) fileHunks.set(f.path, hs);
      if (Date.now() - t > 12) { await new Promise((r) => cx.timer.after(0, r)); t = Date.now(); if (this.patch !== patch) return; }
    }
    // Progress, folds and where you were before the list exists: the first frame with the diff has the viewed files
    // folded and stands where you left (it used to come after the threads were read, half a second of the top of Files).
    const p = await this.resumeOf(url);
    this.resumeIn = null; // a later load (a new head) reads what was saved since
    if (this.patch !== patch) return;
    this.prog = { visited: new Set(p.visited ?? []), checked: p.checked ?? {}, handled: p.handled ?? {}, seen: new Set(p.seen ?? []) };
    this.collapsed = new Set([...this.prog.seen, ...foldOnOpen(this.patch)]);
    this.takeResume(url, p);
    this.hunks = hunks; this.fileHunks = fileHunks;
    this.byId = new Map(this.hunks.map((h) => [h.id, h]));
    this.diffLines = diffLines(this.hunks);
    this.loadGhComments(cx);
    await this.loadThreads(cx);
    this.uiSaved = JSON.stringify(this.uiState());
    this.head = this.prSel.headSha ?? null; // from prs.json (prs.py) or the branch's gh pr view; else asked when a file is opened
    // Since your last review: the mark before this visit (registerReview moves it to this head as "seen" afterwards).
    const reg = JSON.parse(await readTextFile(openFile()).catch(() => null) ?? "[]").find((r) => r.url === url);
    this.lastReviewed = reg?.reviewed ?? null;
    this.makeWorktree(cx);
    this.loadInfra(cx);
    this.loadAi(cx, "cache"); // never runs by itself: Analyze is a click
    await this.loadFindings(cx);
    this.registerReview(cx); // opened: an open review from now on
    this.publish(); cx.notify();
  },

  // The PR head as files (worktree.py: a detached worktree of a dedicated clone under the clone root, kept in Herdr's
  // folder for worktrees: <worktrees.directory>/<repo>/pr-review, never inside the clone), for reviewers,
  // whole files and the LSP bridge: shared("review.worktree") = {url, head, path}. The current branch: its repo root.
  // clone: the "Clone to …" click; never otherwise (worktree.py exits 3 with the folder it would use).
  // Someone else's PR is untrusted: its language servers run in safe mode (no build scripts, proc macros, project
  // TypeScript, module downloads) and aren't warmed up. Trusted: your branch, your sessions' PRs, PRs you authored,
  // and PRs (or repos) you chose to trust.
  trustedPr(pr = this.prSel) {
    if (!pr) return false;
    if (pr.space || !pr.source || pr.source === "mine") return true;
    if (pr.author && pr.author === shared("gh.login")) return true;
    return (shared("pr-review.trusted") ?? []).includes(pr.url) || (shared("pr-review.trustedRepos") ?? []).includes(pr.repo);
  },
  // Like VS Code's Workspace Trust: asked once per PR (Restricted Mode stays until you trust it).
  trustAsked(pr = this.prSel) { return (shared("pr-review.trustAsked") ?? []).includes(pr?.url); },
  trust(kind, cx) {
    const pr = this.prSel, add = (key, v) => setShared(key, [v, ...(shared(key) ?? []).filter((x) => x !== v)].slice(0, 200));
    if (kind === "pr") add("pr-review.trusted", pr.url);
    if (kind === "repo" && pr.repo) add("pr-review.trustedRepos", pr.repo);
    add("pr-review.trustAsked", pr.url);
    this.applyTrust(); cx.notify();
  },
  trustPrompt(t) {
    const pr = this.prSel, who = pr.author ? `@${pr.author}` : "someone else";
    return v_flex().flex_none().px(14).py(10).gap(8).bg(t.ansi3 + "1c").border_b(1).border_color(t.border).text_size(TYPE.small)
      .child(div().font_semibold().text_color(t.foreground).child(`Do you trust the authors of this code? This PR is by ${who}.`))
      // Everything trusting turns on (threads.js TRUST_TURNS_ON), so the choice is made knowing it.
      .child(div().whitespace_normal().text_color(t.muted).child("Trusting it turns on:"))
      .child(v_flex().gap(2).pl(8).children(TH.TRUST_TURNS_ON.map((x, k) => h_flex().id(`rv-trust-on-${k}`).gap(6).items_start().text_color(t.muted)
        .child(div().flex_none().child("·")).child(div().flex_1().min_w(0).whitespace_normal().child(x)))))
      .child(div().whitespace_normal().text_color(t.muted).child("In Restricted Mode each of these asks you first or stays off: agents ask before every command and read only your own settings, the security review is offered instead of started, Java has no build import and Rust no go-to-definition, and the Codex review asks once before it runs. Reading the diff, the Claude reviewers you start and the AI analysis work the same either way."))
      .child(h_flex().gap(8).flex_wrap()
        .child(pill("rv-trust-pr", t, "Trust this PR", (_e, cx) => this.trust("pr", cx), false, t.foreground).tooltip("Turn on everything listed above for this PR"))
        .when(Boolean(pr.repo), (e) => e.child(pill("rv-trust-repo", t, `Trust all PRs in ${pr.repo}`, (_e, cx) => this.trust("repo", cx)).tooltip(`Turn on everything listed above for every PR in ${pr.repo} from now on, also those by other people${this.repoVis?.[pr.repo] === "PUBLIC" ? ": this repository is public, so anyone can open one" : ""}`)))
        .child(pill("rv-trust-no", t, "Stay in Restricted Mode", (_e, cx) => this.trust("ask", cx)).tooltip("Keep everything listed above off for this PR; agents ask first and go-to-definition may find less")));
  },
  applyTrust() {
    const w = this.worktree, yes = this.trustedPr();
    if (!w?.path) return;
    setTrusted(w.path, yes);
    if (yes) warm(w.path, (this.patch ?? []).map((f) => f.path)); // Java needs ~25 s cold
  },

  // Herdr's folder for worktrees as its settings.json has it now (read when a checkout is made, as Herdr does).
  async wtDir() { return TH.worktreesDir(await readTextFile(`${appHome()}/settings.json`).catch(() => null), home()); },

  makeWorktree(cx, clone = false) {
    const url = this.prSel.url, want = this.prSel.headSha ?? null, job = `${url}|${want}|${clone}`;
    if (this.wtIn === job) return; // the same checkout is being made
    this.worktree = null;
    if (this.prSel.space && this.root) {
      this.worktree = { url, head: this.head, path: this.root, local: true }; putShared("review.worktree", this.worktree); this.applyTrust();
      this.loadSince(cx); this.loadContext(cx); return;
    }
    // A PR you didn't open may use the active space's checkout of its repo (cwd); your own PRs keep the dedicated clones.
    const local = this.prSel.source && this.root ? ["--local", this.root] : [];
    this.cloning = clone; this.checkout = { busy: true }; // shown at the top of the Analysis tab (stateHints)
    this.wtIn = job;
    cx.spawn(async (cx) => {
      const roots = C.cloneRoots(ctxDoc(), this.ctxId(), this.cfg?.cloneRoot ?? "~/code").flatMap((d) => ["--root", d.replace(/^~(?=\/|$)/, home())]);
      const env = this.ctxEnv(this.ctxId()), argv = [...env, "python3", `${appHome()}/mods/pr-review/worktree.py`, url, ...roots, "--worktrees", await this.wtDir(), ...local, ...(clone ? ["--clone"] : [])];
      // The checkout from last time still at this head (its HEAD file says so): no fetch, no checkout. A new head
      // (checkHead) comes back here with another sha and runs worktree.py.
      const had = shared("review.worktree"), same = !clone && want && had?.url === url && had.head === want && !had.local && await worktreeAt(had.path, want);
      const r = same ? { code: 0, stdout: JSON.stringify({ head: want, path: had.path }) } : await exec(argv[0], argv.slice(1), { timeout: 600000 })
        .catch((e) => ({ code: 1, stderr: String(e) }));
      if (this.wtIn === job) this.wtIn = null;
      this.cloning = false; this.checkout = null;
      if (this.prSel?.url !== url) return;
      if (r.code === 3) { this.needClone = JSON.parse(r.stdout).need_clone; this.loadContext(cx); cx.notify(); return; }
      this.needClone = null;
      if (r.code !== 0) { this.checkout = { error: r.stderr.trim().slice(0, 200) }; cx.notify(); return; }
      const w = JSON.parse(r.stdout);
      this.head ??= w.head;
      this.worktree = { url, head: w.head, path: w.path };
      putShared("review.worktree", this.worktree);
      if (!shared("gh.login")) exec("gh", ["api", "user", "--jq", ".login"]).then((r) => { if (r.code === 0) { setShared("gh.login", r.stdout.trim()); this.applyTrust(); } }).catch(() => null);
      this.applyTrust();
      if (this.pendingRun) { this.pendingRun = false; this.loadAi(cx, "run"); }
      this.loadSince(cx); this.loadContext(cx); this.loadInfra(cx);
      cx.notify();
    });
  },

  // What changed since the head you last reviewed (worktree.py since: git in the checkout, no LLM). The Files tab
  // shows only that while "Since last review" is on.
  loadSince(cx) {
    const url = this.prSel?.url, w = this.worktree, base = sinceBase({ reviewed: this.lastReviewed }, w?.head ?? this.head);
    if (!w || !base) return;
    cx.spawn(async (cx) => {
      const r = await exec("python3", [`${appHome()}/mods/pr-review/worktree.py`, "since", w.path, base.sha, w.head ?? this.head, ...(this.patch ?? []).flatMap((f) => [f.path, ...(f.from ? [f.from] : [])])], { timeout: 400000 })
        .catch((e) => ({ code: 1, stderr: String(e) }));
      if (this.prSel?.url !== url) return;
      const d = r.code === 0 ? JSON.parse(r.stdout) : { mode: "full", patch: "", note: `Could not diff: ${r.stderr.trim().slice(0, 160)}` };
      const files = splitPatch(d.patch || ""), hunks = hunksOf(files).map((h) => ({ ...h, rows: diffRows(h.lines) })), fileHunks = new Map();
      for (const h of hunks) fileHunks.set(h.path, [...(fileHunks.get(h.path) ?? []), h]);
      this.since = { base, head: w.head ?? this.head, mode: d.mode, note: d.note, files: d.patch ? files : [], hunks, fileHunks };
      this.sinceOn = files.length > 0 && d.mode !== "full"; // start on the new changes; the banner switches back
      this.gaps = {};
      cx.notify();
    });
  },

  // Related PRs, CI checks and mergeability (related.py: gh and git, no LLM), cached per PR head in pr-data/cache.
  // force: ask GitHub even when the cached one is fresh (the Overview's ↻). One related.py per file at a time.
  loadContext(cx, force = false) {
    const url = this.prSel?.url, head = this.worktree?.head ?? this.head;
    if (!url?.startsWith("https://") || !head) return;
    const out = `${cacheDir()}/ctx-${hash(url)}-${head}.json`;
    if (this.ctxIn === out) return;
    cx.spawn(async (cx) => {
      const before = JSON.parse(await readTextFile(out).catch(() => null) ?? "null");
      if (this.prSel?.url !== url) return;
      if (before) { this.ctx = before; this.securityNow(cx); this.publish(); cx.notify(); }
      if (before && !force && Date.now() - Date.parse(before.at) < CTX_MS) return;
      if (this.ctxIn === out) return;
      this.ctxIn = out; cx.notify();
      const req = { url, head, base: this.prSel.base ?? "main", branch: this.prSel.head ?? null, worktree: this.worktree?.path ?? null, files: (this.patch ?? []).map((f) => f.path).filter((f) => !lowValue(f)), out }; // lockfiles would relate everything
      const r = await exec("python3", [`${appHome()}/mods/pr-review/related.py`, JSON.stringify(req)], { timeout: 400000 }).catch(() => null);
      if (this.ctxIn === out) this.ctxIn = null;
      if (this.prSel?.url !== url || r?.code !== 0) return cx.notify();
      this.ctx = JSON.parse(r.stdout);
      this.securityNow(cx);
      exec("python3", [`${appHome()}/mods/pr-review/prs.py`, "--prune"]).catch(() => null); // bounds the cache folder
      this.publish(); cx.notify();
    });
  },

  // Where you were in this PR's review (review-progress.json), read once as soon as the PR is known: render holds its
  // frame for that read (a few ms), so the first frame drawn is on the tab and page you left, and the list scrolls to
  // your place in the frame it first appears (pendingScroll). Taken once per PR: a later load keeps what you did since.
  resumeOf(url) {
    if (this.resumeIn?.url !== url) this.resumeIn = { url, p: readTextFile(progressFile()).then((x) => JSON.parse(x ?? "{}")[url] ?? {}).catch(() => ({})) };
    return this.resumeIn.p;
  },
  takeResume(url, p) {
    if (this.prSel?.url !== url || this.resumed === url) return;
    this.resumed = url;
    const back = resumeFields(p.ui);
    if (!back) return;
    Object.assign(this, back.fields);
    if (back.model && codeModel(back.model) !== shared("review.model")) setShared("review.model", codeModel(back.model));
    if (back.values !== undefined && back.values !== valuesOn()) setShared("review.values", back.values);
    this.pendingScroll = back.scroll;
  },
  async applyResume(cx) {
    const url = this.prSel?.url;
    if (!url || this.resumed === url) return;
    this.takeResume(url, await this.resumeOf(url));
    cx.notify();
  },

  // Progress and where you were (tab, file, hunk, step, order, selection, model, values) for resuming; the oldest
  // PRs beyond MAX_PROGRESS go.
  saveProgress(cx) {
    const url = this.prSel?.url, p = this.prog;
    if (!url) return;
    const value = { visited: [...p.visited], checked: p.checked, handled: p.handled, seen: [...p.seen], ui: this.uiState(), at: Date.now() };
    cx.spawn(async (cx) => {
      try {
        for (let attempt = 0; ; attempt++) {
          const before = await readTextFile(progressFile()).catch(() => null), doc = before ? JSON.parse(before) : {};
          doc[url] = value;
          for (const k of Object.keys(doc).sort((a, b) => (doc[b].at ?? 0) - (doc[a].at ?? 0)).slice(MAX_PROGRESS)) delete doc[k];
          try { await writeTextFile(progressFile(), JSON.stringify(doc, null, 1), before); break; } catch (e) { if (attempt) throw e; }
        }
        if (this.saveErr) { this.saveErr = null; this.note = "Your progress is saved again."; cx.notify(); }
      } catch (e) { this.saveErr = String(e).replace(/^Error: /, "").replace(/^`[^`]+`: /, ""); cx.notify(); } // saveErrBar: said with what is kept, and Save again
    });
    this.registerReview(cx);
  },

  uiState() {
    return { tab: this.tab, fileFocus: this.fileFocus ?? null, focusHunk: this.focusHunk ?? null, cur: this.cur, order: this.order,
      fsel: this.fsel ?? null, page: this.page ?? null, model: model(), values: valuesOn() };
  },

  // Saves where you are a second after it last changed (render calls this; no timer runs while nothing changes).
  uiChanged(cx) {
    const now = JSON.stringify(this.uiState());
    if (now === this.uiSaved || !this.hunks) return;
    this.uiSaved = now;
    const gen = (this.uiGen = (this.uiGen ?? 0) + 1);
    cx.timer.after(1000, (cx) => { if (this.uiGen === gen) this.saveProgress(cx); });
  },

  progressNow() {
    const steps = this.ai?.steps ?? [];
    const th = TH.threadCounts(this.threads(), this.replies, this.gh);
    return { steps: steps.length, stepsChecked: steps.filter((s) => this.done(s)).length, files: this.patch?.length ?? 0, filesViewed: this.prog.seen.size,
      comments: this.comments.length, threads: th.threads, replies: th.replies, fixedThreads: th.fixed, findingsOpen: this.counts().unresolved };
  },

  // This PR in pr-data/open-reviews.json (and shared "review.open"), 1.5 s after the last change: opened, worked on,
  // sent, done. Merged/closed PRs turn done, old done/sent entries go (pr.js expireReviews).
  registerReview(cx, extra = {}) {
    const pr = this.prSel;
    if (!pr?.url || !this.hunks) return;
    this.regExtra = { ...this.regExtra, ...extra };
    if (extra.status === "sent" || extra.status === "done") { this.since = null; this.sinceOn = false; } // reviewed up to this head now
    const gen = (this.regGen = (this.regGen ?? 0) + 1);
    cx.timer.after(1500, (cx) => cx.spawn(async (cx) => {
      if (this.regGen !== gen || this.prSel?.url !== pr.url) return;
      const entry = { url: pr.url, number: pr.number, repo: pr.repo, title: pr.title ?? this.pr?.title, context: this.ctxId(), headSha: this.head,
        progress: this.progressNow(), target: pr, triage: this.triageNow(), risk: riskOfCounts(this.counts(), this.openFindings()), ...this.regExtra };
      const how = this.regExtra.status === "sent" || this.regExtra.status === "done" ? this.regExtra.status : "seen";
      this.regExtra = {};
      const prs = JSON.parse(await readTextFile(`${appHome()}/pr-data/prs.json`).catch(() => null) ?? "{}").prs ?? [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await readTextFile(openFile()).catch(() => null), old = before ? JSON.parse(before) : [], was = old.find((r) => r.url === pr.url), now = Date.now();
        entry.reviewed = markReviewed(was?.reviewed, this.worktree?.head ?? this.head, how, now);
        const list = expireReviews(touchReview(old, entry, now), prs, now);
        // Nothing but the time of the last touch is new, and the one on file is young: no write. Every tab, page,
        // layer and line picked comes here (saveProgress), and each time the file, "review.open" and
        // "review.registry" were written: 45 KB of shared state, twice the whole shared.json, two frames of every mod.
        if (was && now - was.lastTouched < TOUCH_MS && JSON.stringify(list.map((r) => (r.url === pr.url ? { ...r, lastTouched: was.lastTouched } : r))) === JSON.stringify(old)) return;
        try {
          await writeTextFile(openFile(), JSON.stringify(list, null, 1), before);
          setShared("review.open", list.filter((r) => r.status !== "done"));
          setShared("review.registry", { at: Date.now(), touched: entry.url, entries: list }); // already debounced (1.5 s)
          return;
        } catch { /* written meanwhile: again */ }
      }
    }));
  },

  // ---- the AI analysis (review.py), cached per hunk set and model

  // mode: "cache" shows what is there (exact, else this PR's last one for the model) and follows a run still going;
  // "run" (a click) starts review.py detached: it may take 15 minutes, longer than exec waits. Its status file says
  // busy/done/error; a gentle poll (5 s) follows it while it runs.
  // incremental (a click on "Only new changes"): sends only the changes since your last review plus the shown analysis;
  // review.py merges the new layers into it and saves the result for today's whole diff.
  loadAi(cx, mode, incremental = false) {
    const m = model(), url = this.prSel?.url;
    this.aiModel = m;
    if (!url || !this.patch) return;
    const job = reviewRequest({ url, pr: url.startsWith("https://") ? url : null, worktree: this.worktree?.path ?? null, files: this.patch, hunks: this.hunks, model: m, context: this.ctxReq(), dir: cacheDir() });
    if (mode === "run") {
      if (this.aiBusy) return;
      if (!job.req.hunks.length) { this.aiError = "No diff"; return cx.notify(); }
      if (!this.worktree && !this.prSel.space) { this.pendingRun = true; return cx.notify(); } // the Analysis tab says it waits (stateHints)
      // Every hunk goes along: review.py inlines what fits and lets the model read the rest (no "too large" cut).
      const all = (hs) => hs.map(({ alias, id, path, lines }) => ({ alias, id, path, lines }));
      let req = { ...job.req, hunks: all(job.hunks), cut: [] };
      if (incremental) {
        if (!this.since?.files.length || !this.aiFile) return;
        const inc = reviewRequest({ url, files: this.since.files, model: m, context: this.ctxReq(), dir: cacheDir() }), n = (a) => a.replace(/^h/, "n");
        req = { ...job.req, hunks: all(inc.hunks).map((h) => ({ ...h, alias: n(h.alias) })), cut: [], previous: this.aiFile,
          since: { base: this.since.base.sha, head: this.since.head }, full: job.hunks.map((h) => ({ alias: h.alias, id: h.id, path: h.path, head: h.lines[0] })) };
      }
      req.head = this.worktree?.head ?? this.head ?? null; // saved with the analysis: the column says which head it read
      this.aiError = null; this.aiBusy = { model: m, started: Date.now(), status: job.status, incremental };
      // The request as a file: a big PR's hunks outgrow a command line.
      const reqFile = `${job.out}.req.json`;
      cx.spawn(async (cx) => {
        const before = await readTextFile(reqFile).catch(() => null);
        await writeTextFile(reqFile, JSON.stringify(req), before).catch((e) => { this.aiError = String(e); });
        exec("sh", ["-c", 'nohup python3 "$0" "$1" >/dev/null 2>&1 &', `${appHome()}/mods/pr-review/review.py`, `@${reqFile}`])
        .catch((e) => { this.aiError = String(e); this.aiBusy = false; cx.notify(); });
      });
      this.publish(); this.pollAi(cx, job, url, m);
      return cx.notify();
    }
    cx.spawn(async (cx) => {
      const [text, fallback, st] = await Promise.all([readTextFile(job.out).catch(() => null), readTextFile(job.latest).catch(() => null), readTextFile(job.status).catch(() => null)]);
      if (this.prSel?.url !== url || model() !== m) return;
      const status = st ? JSON.parse(st) : null;
      this.ai = text || fallback ? this.mapSaved(JSON.parse(text ?? fallback), Boolean(text)) : null;
      this.securityNow(cx); // the findings file may have been read before the analysis: its resilience block is derived on the analysis (withResilience)
      this.aiFile = text ? job.out : fallback ? job.latest : null;
      if (status?.busy && Date.now() - Date.parse(status.started) < 20 * 60000) { // a run started earlier, maybe from another copy
        this.aiBusy = { model: m, started: Date.parse(status.started), status: job.status, pid: status.pid };
        this.pollAi(cx, job, url, m);
      }
      if (this.ai && !this.focusHunk) this.goStep(0, cx, false);
      this.publish(); cx.notify();
    });
  },

  // Refresh diagrams (a click, never by itself): review.py redraws only the pictures of the shown analysis for today's
  // diff, with its layers as context (one cheaper call, "Review diagrams" in the ledger), and writes them into the
  // files holding this analysis. The old pictures stay until the new ones arrive.
  refreshDiagrams(cx) {
    const url = this.prSel?.url, file = this.aiFile, m = model();
    if (!url || !file || !this.patch || this.diaBusy) return;
    const job = reviewRequest({ url, pr: url.startsWith("https://") ? url : null, worktree: this.worktree?.path ?? null, files: this.patch, hunks: this.hunks, model: m, context: this.ctxReq(), dir: cacheDir() });
    const status = `${file}.diagrams.status`;
    const req = { diagrams: file, also: [job.out, job.latest].filter((x) => x !== file), head: this.head, model: m, context: this.ctxReq(), pr: job.req.pr,
      worktree: job.req.worktree, hunks: job.req.hunks, status };
    this.diaBusy = { status, file, url }; this.diaError = null;
    exec("sh", ["-c", 'nohup python3 "$0" "$1" >/dev/null 2>&1 &', `${appHome()}/mods/pr-review/review.py`, JSON.stringify(req)])
      .catch((e) => { this.diaError = String(e); this.diaBusy = null; cx.notify(); });
    this.pollDiagrams(cx);
    cx.notify();
  },

  pollDiagrams(cx) {
    cx.timer.after(5000, (cx) => cx.spawn(async (cx) => {
      const b = this.diaBusy;
      if (!b || this.prSel?.url !== b.url) { this.diaBusy = null; return; }
      const st = JSON.parse(await readTextFile(b.status).catch(() => null) ?? "null");
      if (!st || st.busy) return this.pollDiagrams(cx);
      this.diaBusy = null;
      if (st.error) this.diaError = st.error;
      else if (this.aiFile === b.file) {
        const text = await readTextFile(b.file).catch(() => null);
        if (text) { this.ai = this.mapSaved(JSON.parse(text), this.ai?.exact ?? true); this.securityNow(cx); } // mapSaved has no resilience block: derive it again
      }
      cx.notify();
    }));
  },

  // The Refresh diagrams button with its state: Refreshing…, "updated for <head>", "diagrams from an older diff".
  diagramsBar(t, id, label) {
    if (!this.ai || !this.aiFile) return div();
    const st = diagramsState({ diagrams: this.ai.diagrams, generated: this.ai.generated }, this.head, this.ai.exact);
    return h_flex().flex_wrap().gap(8).items_center().text_size(TYPE.small)
      .child(this.diaBusy ? h_flex().gap(6).text_color(t.muted).child(div().child(SPIN[0]).frames(SPIN, 90)).child("Refreshing…")
        : pill(id, t, `↻ ${label}`, (_e, cx) => { this.refreshDiagrams(cx); cx.stop_propagation(); }).tooltip("Rebuild the diagrams for the current diff: one model call"))
      .when(st.updated && Boolean(st.short), (e) => e.child(div().text_color(t.muted).child(`updated for ${st.short}`)))
      .when(st.older, (e) => e.child(div().text_color(t.ansi3).child("diagrams from an older diff")))
      .when(Boolean(this.diaError), (e) => e.child(div().max_w(260).truncate().text_color(t.ansi1).tooltip(this.diaError ?? "").child(this.diaError ?? "")));
  },

  pollAi(cx, job, url, m) {
    cx.timer.after(5000, (cx) => cx.spawn(async (cx) => {
      if (this.prSel?.url !== url || !this.aiBusy) return;
      const st = JSON.parse(await readTextFile(job.status).catch(() => null) ?? "null");
      if (st?.busy || !st) { if (st?.pid) this.aiBusy.pid = st.pid; if (st?.passes) Object.assign(this.aiBusy, { pass: st.pass, passes: st.passes }); cx.notify(); return this.pollAi(cx, job, url, m); }
      this.aiBusy = false;
      if (st.error) this.aiError = st.error;
      else {
        const text = await readTextFile(job.out).catch(() => null);
        if (text && model() === m) { this.ai = this.mapSaved(JSON.parse(text), true); this.aiFile = job.out; this.goStep(0, cx, false); }
      }
      this.securityNow(cx);
      this.publish(); cx.notify();
    }));
  },

  cancelAi(cx) {
    const b = this.aiBusy;
    if (!b) return;
    this.aiBusy = false; this.aiError = "Cancelled";
    cx.spawn(async (cx) => {
      if (b.pid) await exec("sh", ["-c", 'pkill -P "$0"; kill "$0"', String(b.pid)]).catch(() => null); // review.py and its claude
      const before = await readTextFile(b.status).catch(() => null);
      await writeTextFile(b.status, JSON.stringify({ error: "Cancelled" }), before).catch(() => null);
      this.publish(); cx.notify();
    });
  },

  // A saved analysis on today's diff: hunks by id (gone ones make a step "veraltet"), plus the hunks no step covers.
  mapSaved(saved, exact) {
    const hs = saved.hunks.map((h) => ({ ...h, ...(this.byId.get(h.id) ?? {}) }));
    const r = mapReview(saved.answer, hs), covered = new Set(r.steps.flatMap((s) => s.hunks));
    const cut = new Set(exact ? saved.cut : []), left = this.hunks.filter((h) => !covered.has(h.id));
    const extra = (title, why, list) => (list.length ? [{ title, why, text: "", risk: "low", order: 9999, questions: [], flows: [], hunks: list.map((h) => h.id), pseudo: true }] : []);
    r.steps.push(...extra(`Not analyzed (${left.filter((h) => cut.has(h.alias)).length} hunks)`, "Too large for the model: read these yourself.", left.filter((h) => cut.has(h.alias))),
      ...extra(`In no step (${left.filter((h) => !cut.has(h.alias)).length} hunks)`, exact ? "The model put these hunks in no step." : "New since the analysis.", left.filter((h) => !cut.has(h.alias))));
    for (const s of r.steps) s.stale = s.hunks.length > 0 && !s.hunks.some((id) => this.byId.has(id));
    return withSecurity({ ...r, exact, diagrams: saved.diagrams ?? null, cost: saved.cost, ms: saved.ms, budget: saved.budget, model: saved.model, model_id: saved.model_id, generated: saved.generated, head: saved.head ?? null, cut: saved.cut ?? [], task: saved.task ?? {},
      incremental: saved.incremental ?? null, scope: saved.scope ?? null, usage: saved.usage ?? null }, this.find.loaded === this.prSel?.url ? this.find.security : null, this.ctx, this.worktree?.head ?? this.head); // scope.checked and usage: newer analyses only
  },

  // What the bar shows: the analysis on screen, or the one running.
  publish() {
    const a = this.ai;
    putShared("review.meta", { url: this.prSel?.url ?? null, pending: this.comments?.length ?? 0, selected: this.prSel ? this.selCount() : 0, model: this.aiModel, busy: this.aiBusy?.model ?? null, error: this.aiError,
      shown: a ? { model: a.model, model_id: a.model_id, cost: a.cost, exact: a.exact, mergeRisk: a.mergeRisk, effort: a.effort } : null,
      checks: this.prSel ? this.checksNow().reduce((n, c) => ({ ok: n.ok + (c.ok === true), fail: n.fail + (c.ok === false) }), { ok: 0, fail: 0 }) : null,
      // For the bar's "Dry run" chip and the "Run review" popup (findings: all, and the analysis' own).
      stack: this.prSel ? stackOf(this.ctx, this.prSel.number) : null, // the bar's "Stack: #1 → #2" (views.js stackOf)
      // The "Run review" popup's price per reviewer, on the model picked in the bar (its runs start on that one).
      prices: this.prSel ? Object.fromEntries(["claude", "security", "resilience"].map((k) => [k, this.runPrice(k, tierOf(model()))])) : null,
      dry: Boolean(this.cfg?.dryRun), securityOffer: this.secOfferText(), findings: this.prSel ? { total: this.findings().length, analysis: this.findings().filter((f) => f.sources.some((y) => y.reviewer === "analysis")).length } : null });
  },

  // The AI steps in reading order or by focus (the toggle: views.js byFocus, by the grade each row shows); without an
  // analysis one step with every hunk. The focus order is kept while only states change (a dismissed finding does not
  // move the open layer away); new findings or a new analysis sort again.
  steps() {
    const all = this.ai?.steps ?? (this.hunks?.length ? [{ title: "All changes", why: "No analysis yet.", text: "", risk: "low", order: 1, questions: [], flows: [], hunks: this.hunks.map((h) => h.id), pseudo: true }] : []);
    const read = [...all].sort((a, b) => a.order - b.order);
    return this.order === "reading" ? read : this.focusOrder(read).list;
  },
  focusOrder(read = [...(this.ai?.steps ?? [])].sort((a, b) => a.order - b.order)) {
    const deps = [this.ai, this.find.list, this.byId, read.length];
    if (!this.focusOf || this.focusOf.deps.some((d, i) => d !== deps[i])) {
      const list = byFocus(read, (s) => this.layerFindings(s).filter((f) => OPEN_ST.includes(this.fstatus(f))));
      this.focusOf = { deps, list, differs: list.some((s, i) => s !== read[i]) };
    }
    return this.focusOf;
  },
  present(s) { return s.hunks.filter((id) => this.byId?.has(id)); },
  // A layer is done once you ticked every file in it as "Viewed": never by opening it, and there is no tick of its own.
  done(s) {
    const files = this.filesOf(s);
    return files.length > 0 && files.every((p) => this.prog.seen.has(p));
  },
  // The AI suggestions that stay margin notes (not merged into a finding, not handled yet); path: of that file.
  openSugs(path) { return this.merged().notes.filter((s) => !path || s.path === path); },

  // ---- findings: one per defect (pr.js mergeFindings); every view reads findings(), counts() and fstatus()

  // The reviewers' findings (reviewers.py: pr-data/findings/<url hash>.json), the analysis' own, read live from its
  // layers (so one the newest analysis no longer has is gone everywhere), and the AI suggestions on their lines,
  // merged per file and line. Only statuses are stored. Memoized: render calls this often.
  // A reviewer's line on an empty line, or just outside the shown rows, first moves to the next code line within its
  // function (views.js findingAnchor), so it meets the analysis' finding there; its code then no longer belongs to it.
  merged() {
    const ai = this.ai, list = this.find.list, st = this.find.status, handled = this.prog.handled, n = Object.keys(handled).length, m = this.findMemo;
    const probes = this.deep?.probes; // a probe that ends confirms its path's findings (withProbes below)
    // What it reads of the analysis, part by part: securityNow puts a new object around the same layers every time the
    // findings file or the context is read, and merging again for that took 50 ms and more on a big review.
    const steps = ai?.steps, suspects = ai?.suspects, access = ai?.access, nodes = ai?.arch?.nodes, res = ai?.resilience ?? this.find?.resilience;
    const same = m && m.steps === steps && m.suspects === suspects && m.list === list && m.st === st && m.handled === handled && m.n === n;
    // Nothing changed, the rows the anchors were found in included (rowsSig): the answer from before. A view asks
    // this dozens of times per frame, so not one row is looked at here.
    if (same && m.access === access && m.nodes === nodes && m.res === res && m.probes === probes && m.rows === this.rowsSig()) return m;
    // A reviewer's line moved to the next line of code (views.js findingAnchor), remembered per row array: this runs
    // for every lookup of a finding while a view draws, and scanning every file's rows each time timed the render out.
    const anchor = (f) => {
      const rows = this.rowsFor(f.file, true), key = `${f.line}:${f.end}`;
      let memo = (this.anchorMemo ??= new WeakMap()).get(rows);
      if (!memo) this.anchorMemo.set(rows, (memo = new Map()));
      if (!memo.has(key)) memo.set(key, findingAnchor(rows, f.line, f.end));
      return memo.get(key);
    };
    const lines = list.map((f) => (f.line > 0 ? anchor(f) : f.line)), at = lines.join(), pub = publicFiles(access, nodes), pubKey = [...pub].join("\n");
    const rows = this.rowsSig(); // after the anchors: reading a file's rows for the first time counts as a change of them
    const merge = () => {
      const moved = list.map((f, i) => (lines[i] === f.line ? f : { ...f, line: lines[i], end: Math.max(lines[i], f.end ?? 0), head: undefined, code: undefined }));
      return mergeFindings([...moved, ...(steps ?? []).flatMap((s) => s.findings ?? [])], (suspects ?? []).filter((s) => !handled[s.key]), st, pub);
    };
    const m2 = same && m.at === at && m.pubKey === pubKey ? m.m2 : merge();
    if (m2 === m?.m2 && m.res === res && m.probes === probes) return Object.assign(m, { access, nodes, rows });
    // An agent's check on each (Verify with an agent); a reproduced probe of the Resilience page confirms its path's findings.
    const proved = res?.paths && typeof this.probesNow === "function" ? withProbes(withProof(m2.findings, st), res.paths, this.probesNow()) : withProof(m2.findings, st);
    return (this.findMemo = { steps, suspects, access, nodes, res, list, st, handled, n, at, pubKey, probes, rows, m2, notes: m2.notes, findings: proved });
  },
  findings() { return this.merged().findings; },
  findingById(id) { return this.findings().find((f) => f.ids.includes(id)) ?? null; },
  // The one count every view shows (pr.js findingCounts): unresolved, of them with a fix sent, by severity, security.
  counts() { return this.perFindings("counts", (fs) => findingCounts(fs, (f) => this.fstatus(f))); },
  // A value kept while its inputs are the same objects (the analysis' parts and the lists from merged() are replaced,
  // never changed in place): for what a page computes from them on every frame.
  keep(name, deps, make) {
    const all = (this.kept ??= {}), k = all[name];
    if (k && k.deps.length === deps.length && k.deps.every((d, i) => d === deps[i])) return k.v;
    return (all[name] = { deps, v: make() }).v;
  },
  // The Security page's crossings (views.js crossingsOf: every call against every zone, gate and threat; on a map of
  // 80 cards 3 ms per call in Herdr, asked twice per frame of the page).
  crossingsNow() {
    const ai = this.ai, a = ai?.arch ?? null, open = this.openFindings();
    return this.keep("crossings", [a, ai?.access, ai?.threats, ai?.gates, ai?.bypasses, open], () => crossingsOf({ arch: a, access: ai?.access ?? [], threats: ai?.threats ?? [], gates: ai?.gates ?? [], bypasses: ai?.bypasses ?? [], findings: open }));
  },
  // A value made from the findings and their statuses, kept until one of them changes (the list from merged(), and
  // what fstatus reads): the tab, the bar and every page ask for the same counts and lists in one frame.
  perFindings(name, make) {
    const fs = this.findings(), st = this.find.status, rep = this.find.reports, head = this.head, rows = this.rowsSig(), k = this.perMemo;
    const memo = k && k.fs === fs && k.st === st && k.rep === rep && k.head === head && k.rows === rows ? k : (this.perMemo = { fs, st, rep, head, rows, got: {} });
    return name in memo.got ? memo.got[name] : (memo.got[name] = make(fs));
  },
  // "Security review: high · Analysis: medium": a finding's sources with their own severities (one source: its name).
  sourcesOf(f) {
    const name = (x) => REVIEWERS[x.reviewer]?.[0] ?? x.reviewer;
    return f.sources.length === 1 ? name(f.sources[0]) : f.sources.map((x) => `${name(x)}: ${x.severity}`).join(" · ");
  },
  // The Findings tab with f open.
  openFinding(f) { this.tab = "findings"; this.ffocus = f.id; },
  // A finding's card in the diff is one line until a click opens it (fopen: id -> bool); a security finding from high
  // on starts open.
  findOpen(f) { return this.fopen?.get(f.id) ?? Boolean(f.security && ["critical", "high"].includes(f.severity)); },
  // An open card's rows under its title: what the finding claims (views.js factRows), its text and its suggestion.
  // The texts are Markdown (inline code, paragraphs, a code block in a suggestion) and are drawn as such.
  // A card's rows: the facts, its text and suggestion, and what each other source says in its own words when that
  // differs (on PR #2 the CodeUri note inside the token finding at template.yaml:14).
  findRows(f) {
    const others = (f.sources ?? []).filter((y) => y.title !== f.title || y.detail !== f.detail).map((y) => [REVIEWERS[y.reviewer]?.[0] ?? y.reviewer, `(${y.severity}) ${plain(y.title)}${y.detail ? `. ${y.detail}` : ""}`]);
    return [...factRows(f), f.detail && ["Detail", f.detail], f.suggestion && ["Suggestion", f.suggestion], ...others].filter(Boolean);
  },
  // The index (in steps()) of the layer an analysis finding belongs to, or -1.
  layerOf(f) { return f.step ? this.steps().findIndex((s) => s.findings?.some((x) => f.ids.includes(x.id))) : -1; },
  // A layer's findings: the ones the analysis filed in it, and every other finding in one of its files (a reviewer's).
  layerFindings(s) {
    const files = new Set(this.filesOf(s)), own = new Set((s.findings ?? []).map((x) => x.id));
    return this.findings().filter((f) => f.ids.some((id) => own.has(id)) || (!f.step && files.has(f.file)));
  },
  // The fix a finding was sent to: its newest job, also once applied or discarded.
  fixJob(f) { return [...this.fixes()].reverse().find((j) => j.items.some((x) => f.ids.includes(x.id))) ?? null; },
  // What is known about a finding's fix, as [label, text] pairs: agent, branch, commit, report, check. Empty when it
  // was never sent.
  fixFacts(f) {
    const st = this.find.status[f.id] ?? {}, r = this.find.reports[f.id], fv = this.fixView(this.fixJob(f)), job = fv?.job, v = st.verify;
    if (!st.fixHead && !r) return [];
    return [
      job && ["Agent", `${job.target === "main" ? "the PR's agent" : "a sub-agent"}${job.terminal ? ` (${job.terminal})` : ""}, ${job.state === "running" ? fv.status : job.state}`],
      job?.branch && ["Branch", job.branch],
      ["Commit", r?.commit ? String(r.commit).slice(0, 8) : "none reported yet"],
      r && ["Report", `${r.status === "fixed" ? "The agent reports it fixed" : "The agent declined"}${r.note ? `: ${r.note}` : "."}`],
      ["Check", TH.checkText(v)],
      this.fixCost?.[job?.id] && ["Cost", fixCostLine(this.fixCost[job.id].usd, tierOf(this.fixCost[job.id].model ?? model()), job.items?.length ?? 1).text],
    ].filter(Boolean);
  },
  // Every 20 s while a sub-agent fix runs: its cost so far from its session log (views.js sessionCost) in the context's
  // config folder, the newest log there written since the job started (an earlier fix in the same folder has its own).
  fixCostTick(cx) {
    // A job stays "running" until it is applied or discarded, also long after its agent ended: its cost is read once
    // more after the agent's terminal is gone (as fixView looks for it), then it is left alone (it listed and read
    // session logs every 20 s for as long as the review was open). Nobody reads the cost behind another window either.
    const done = (this.fixCostDone ??= new Set());
    const live = (j) => Boolean(j.terminal) && (agents().some((a) => a.address === j.terminal) || terminals().some((x) => x.address === j.terminal && x.state === "live"));
    const running = this.prSel && windowActive() ? this.fixes().filter((j) => j.state === "running" && j.target === "sub" && j.path && (live(j) ? (done.delete(j.id), true) : !done.has(j.id))) : [];
    if (!running.length || this.fixCostBusy) return;
    for (const j of running) if (!live(j)) done.add(j.id);
    const cfg = String(C.infoOf(ctxDoc(), this.ctxId()).env?.CLAUDE_CONFIG_DIR ?? `${home()}/.claude`).replace(/^~(?=\/|$)/, home());
    this.fixCostBusy = true;
    cx.spawn(async (cx) => {
      try {
        for (const j of running) {
          const r = await exec("sh", ["-c", 'ls -t "$0"/*.jsonl 2>/dev/null | head -3', sessionDir(cfg, j.path)]).catch(() => null);
          for (const f of (r?.stdout ?? "").split("\n").filter(Boolean)) {
            const text = await readTextFile(f).catch(() => null), first = /"timestamp":"([^"]+)"/.exec(text ?? "")?.[1];
            if (!text || Date.parse(first) < j.at - 60000) continue; // a log of an earlier fix in the same folder
            const c = sessionCost(text);
            if (this.fixCost?.[j.id]?.usd !== c.usd) { this.fixCost = { ...this.fixCost, [j.id]: c }; cx.notify(); }
            break;
          }
        }
      } finally { this.fixCostBusy = false; }
    });
  },
  // The same in one line, for a card in the diff: "sub-agent t12 · fix/2-x · commit 22e31c88 · agent reports fixed · not verified".
  fixLine(f) {
    const st = this.find.status[f.id] ?? {}, r = this.find.reports[f.id], job = this.fixJob(f), v = st.verify;
    if (!st.fixHead && !r) return "";
    return [job && `${job.target === "main" ? "PR agent" : "sub-agent"}${job.terminal ? ` ${job.terminal}` : ""}`, job?.branch, r?.commit && `commit ${String(r.commit).slice(0, 8)}`,
      r && (r.status === "fixed" ? "agent reports fixed" : "agent declined"), TH.checkText(v, true)].filter(Boolean).join(" · ");
  },

  async loadFindings(cx) {
    const url = this.prSel?.url;
    if (!url) return;
    const base = `${findDir()}/${hash(url)}`;
    const [doc, rep] = await Promise.all([readTextFile(`${base}.json`).catch(() => null), readTextFile(`${base}.jsonl`).catch(() => null)]);
    if (this.prSel?.url !== url) return;
    const d = doc ? JSON.parse(doc) : {};
    this.find = { ...this.find, list: withThreats(d.findings ?? [], d.security), runs: runsOf(d.runs), status: d.status ?? {}, reports: parseReports(rep), security: d.security ?? null, resilience: d.resilience ?? null, loaded: url };
    for (const r of Object.values(this.find.runs)) if (r.busy && Date.now() - Date.parse(r.started) > 30 * 60000) { r.busy = false; r.state = "failed"; r.error = "Stopped without a result"; }
    putShared("review.reviewers", this.find.runs);
    this.securityNow(cx);
    cx.notify();
  },

  // The security run's view on the analysis (pr.js withSecurity) once the findings file or the context changed, and
  // the security review started by itself (pr.js securityStart): once per head, after the analysis, when related.py's
  // security_trigger gives a reason, and only on a trusted PR. On someone else's PR it is offered (this.secStart.offer:
  // the reasons and a button on the Security page and in the Reviews popup), never started.
  securityNow(cx) {
    const w = this.worktree, head = w?.head ?? this.head, mine = this.find.loaded === this.prSel?.url; // the findings file of this PR, not the one before
    this.secStart = securityStart({ trigger: this.ctx?.security_trigger, trusted: this.trustedPr(), head, ctxHead: this.ctx?.head, run: this.find.runs.security, known: mine,
      ready: Boolean(this.ai) && !this.exMode && !this.aiBusy && Boolean(w) && !w.local });
    if (this.exMode || !this.ai) return;
    this.ai = withSecurity(this.ai, mine ? this.find.security : null, this.ctx, head);
    // The Resilience run's block with its derived parts (pr.js withResilience), and where it would start (resilienceStart).
    // Where the run would start is counted from every added line of the diff (pr.js resilienceStart: 100 ms on
    // 10 000 diff lines in Herdr, the longest single piece of work while a review opened). Once per patch, and a
    // second after the review is there instead of before its first frame; until then the Resilience page words the
    // start from the map (views.js resStartOf), as it does for an analysis without the count.
    const patch = this.patch;
    if (patch && !resStartMemo.has(patch) && this.resStartFor !== patch) {
      this.resStartFor = patch;
      cx.timer.after(1000, (cx) => { if (this.patch !== patch) return; const start = resStartOfPatch(patch); if (this.ai && !this.exMode) { this.ai = { ...this.ai, resilienceStart: start }; cx.notify(); } });
    }
    this.ai = { ...withResilience(this.ai, mine ? this.find.resilience : null, head, this.ai ? this.findings() : this.find.list ?? []), resilienceStart: patch ? resStartMemo.get(patch) : resilienceStart([]) };
    if (this.secStart.start) this.runReviewer("security", cx, this.secStart.reasons.slice(0, 3).join("; "));
  },
  // Why the security review would run, for someone else's PR where it does not start by itself; null otherwise.
  secOfferText() {
    const o = this.secStart?.offer && this.find.runs.security?.state !== "running" ? this.secStart : null;
    return o ? `The diff gives reasons for a security review: ${o.reasons.slice(0, 3).join("; ")}${o.reasons.length > 3 ? `, and ${o.reasons.length - 3} more` : ""}. It does not start by itself on someone else's PR, because the reviewer reads the PR's code and text.` : null;
  },

  runReviewer(kind, cx, auto = null, use = null) { // auto: why it started by itself (securityNow); use: a model for this run only (runOffer)
    const pr = this.prSel, w = this.worktree;
    if (!reviewersNow().some(([k]) => k === kind) || !pr?.url) return;
    if (!w || w.local) { this.note = !w ? "Could not run: the PR head is not checked out yet" : "Could not run: reviewers need a PR (not a branch diff)"; return cx.notify(); }
    // Codex on someone else's PR in Restricted Mode: asked once per PR (the note says what the run may do), the next click runs it.
    if (kind === "codex" && !this.trustedPr(pr) && this.codexAsked !== pr.url) { this.codexAsked = pr.url; this.note = TH.CODEX_ASK; return cx.notify(); }
    const req = { kind, url: pr.url, number: pr.number, context: this.ctxReq(), model: use ?? model(), codexModel: shared("review.codexModel") || null, worktree: w.path, base: pr.base ?? "main",
      head: w.head, level: "medium", file: `${findDir()}/${hash(pr.url)}.json`, ...(auto ? { auto } : {}) };
    this.find.runs[kind] = { state: "running", busy: true, started: new Date().toISOString(), scope: null, error: null, head: w.head, ...(auto ? { auto } : {}) };
    setShared("review.reviewers", { ...this.find.runs });
    exec("sh", ["-c", 'nohup python3 "$0" "$1" >/dev/null 2>&1 &', `${appHome()}/mods/pr-review/reviewers.py`, JSON.stringify(req)])
      .catch((e) => { this.note = `Could not start ${REVIEWERS[kind][0]}: ${e}`; cx.notify(); });
    cx.notify();
  },

  // A finding's line in the diff's rows (hunks plus opened context), or -1: then it is "outside the diff".
  findRow(f) { return this.rowsFor(f.file, true).findIndex((r) => atLine(r, f.line, false)); },
  // Remembered per finding until a status, a report, the head or a file's rows change (rowsSig): a frame asks this
  // for every finding in every count and list, and each answer looked for the finding's line in its file's rows.
  fstatus(f) {
    const st = this.find.status, rep = this.find.reports, head = this.head, rows = this.rowsSig(), k = this.fstMemo;
    const memo = k && k.st === st && k.rep === rep && k.head === head && k.rows === rows ? k : (this.fstMemo = { st, rep, head, rows, of: new WeakMap() });
    let s = memo.of.get(f);
    if (s === undefined) { s = findingStatus(f, st, rep, head, this.rowsFor(f.file, true).find((x) => atLine(x, f.line, false))?.text); memo.of.set(f, s); }
    return s;
  },
  // A status set by hand drops an earlier verification; extra: {fixHead} when it goes to Fix.
  setFinding(f, st, cx, extra = {}) {
    const at = new Date().toISOString();
    this.writeStatus(cx, (status) => ({ ...status, [f.id]: { ...status[f.id], s: st, at, verify: undefined, ...extra } }));
  },
  // Dismiss says what goes: the one finding, with every source merged into it.
  dismiss(f, cx) {
    this.setFinding(f, "dismissed", cx, { ids: f.ids }); // a source that joins the line later was not dismissed (pr.js findingStatus)
    this.note = `Dismissed "${f.title}"${f.sources.length > 1 ? `, all ${f.sources.length} sources of it (${this.sourcesOf(f)})` : ` (${this.sourcesOf(f)})`}. It stays in the Findings tab under Dismissed; Reopen brings it back.`;
  },

  // The findings' status map changed by fn, here and in the file (compare-and-swap against reviewers.py writing it).
  writeStatus(cx, fn) {
    const file = `${findDir()}/${hash(this.prSel.url)}.json`;
    this.find.status = fn(this.find.status);
    cx.spawn(async (cx) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await readTextFile(file).catch(() => null), doc = before ? JSON.parse(before) : {};
        doc.status = fn(doc.status ?? {});
        try { await writeTextFile(file, JSON.stringify(doc, null, 1), before); return; } catch { /* changed meanwhile: again */ }
      }
      this.note = "Could not save the finding's status"; cx.notify();
    });
    cx.notify();
  },

  headNow() { return this.worktree?.head ?? this.head; },
  verifyList() { return verifyCandidates(this.findings(), this.find.status, this.headNow(), (f) => this.fstatus(f)); },

  // Fixes that can be checked on their own branch, before they are in the PR (threads.js branchChecks); a finding
  // whose PR head moved is checked there instead.
  branchVerifyList() {
    const onHead = new Set(this.verifyList().map((f) => f.id));
    return TH.branchChecks(this.findings(), this.fixes(), this.find.status, this.find.reports, (f) => this.fstatus(f)).filter((c) => !onHead.has(c.f.id));
  },

  // "Verify fixes (N)" (a click): one call (verify.py, "PR fix verification") in the PR's context with the review's
  // model. On the PR head: fixed → ✓, not fixed → open again with the reason, unclear → as it was with the note. On a
  // fix branch the verdict only stands next to the finding: it stays "Fix sent" until the fix is in the PR head.
  runVerify(cx) {
    const list = this.verifyList(), onBranch = this.branchVerifyList(), head = this.headNow(), w = this.worktree, url = this.prSel?.url;
    if (this.verifyBusy) return;
    if (!list.length && !onBranch.length) { this.note = "No fix to verify yet: no fix agent has reported a commit, and the PR head has not moved since the fixes were sent."; return cx.notify(); }
    if (!w) { this.note = "Could not verify: the PR head is not checked out yet"; return cx.notify(); }
    this.verifyBusy = { started: Date.now(), n: list.length + onBranch.length };
    const item = (f) => ({ id: f.id, file: f.file, line: f.line, title: f.title, detail: f.detail, suggestion: f.suggestion });
    const req = { context: this.ctxReq(), model: model(), worktree: w.path, head,
      items: [...list.map((f) => ({ ...item(f), since: this.find.status[f.id].fixHead })),
        ...onBranch.map((c) => ({ ...item(c.f), since: c.job.head, head: c.commit, worktree: c.job.path, branch: c.job.branch }))] };
    cx.spawn(async (cx) => {
      const r = await exec("python3", [`${appHome()}/mods/pr-review/verify.py`, JSON.stringify(req)], { timeout: 600000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      this.verifyBusy = false;
      if (this.prSel?.url !== url) return;
      if (r.code !== 0) { this.note = `Could not verify: ${r.stderr.trim().slice(0, 200)}`; return cx.notify(); }
      const { results, cost } = JSON.parse(r.stdout);
      const there = new Set(onBranch.map((c) => c.f.id)), pr = results.filter((x) => !there.has(x.id)), br = results.filter((x) => there.has(x.id));
      this.writeStatus(cx, (st) => TH.applyBranchChecks(applyVerification(st, pr, head, Date.now()), br, onBranch, Date.now()));
      const say = (rs, fixed) => `${rs.filter((x) => x.verdict === "fixed").length} ${fixed}, ${rs.filter((x) => x.verdict === "not_fixed").length} not fixed, ${rs.filter((x) => x.verdict === "unclear").length} unclear`;
      this.note = [pr.length && `On the PR head: ${say(pr, "fixed")}`, br.length && `On a fix branch, not in the PR yet: ${say(br, "verified")}`].filter(Boolean).join(". ") + (cost != null ? ` · $${Number(cost).toFixed(3)}` : "");
      cx.notify();
    });
    cx.notify();
  },

  findingText(f) {
    const rows = this.rowsFor(f.file), i = rows.findIndex((r) => atLine(r, f.line, false));
    const code = i >= 0 ? selection(rows, i, rows.findIndex((r) => atLine(r, f.end ?? f.line, false)) >= 0 ? rows.findIndex((r) => atLine(r, f.end ?? f.line, false)) : i).hunk : f.code;
    // Where it is and who found it in the first line (the preview is editable), then the finding as paragraphs.
    return `${REVIEWERS[f.reviewer]?.[0] ?? f.reviewer} (${f.severity}): \`${f.file}\`:${f.line}\n\n${TH.findingCommentText(f, { fold: false })}\n\n\`\`\`\n${code ?? ""}\n\`\`\`\n\n`;
  },

  findingComment(f, cx) {
    const rows = this.rowsFor(f.file), i = rows.findIndex((r) => atLine(r, f.line, false));
    const anchor = i >= 0 ? selection(rows, i) : { start: f.line, end: f.line, old: false, hunk: f.code };
    this.comments = [...this.comments, { id: Date.now().toString(36), file: f.file, ...anchor, head: this.head, text: TH.findingCommentText(f), from: f.reviewer, ...(secByEffect(f) ? { security: true } : {}) }]; // the note about public comments: only for access or data
    this.persist(cx); this.note = `Added to the pending review.${secByEffect(f) ? ` ${PUBLIC_TIP}` : ""}`; cx.notify();
  },

  // "Ask an agent…": what a click would start, decided before the preview so that it can say so. live: the PR's agent
  // runs already, the text goes into its input as a draft; resume: its session comes back in a new tab; new: a fresh
  // agent tab in the review's checkout of the PR head.
  askPlan() {
    const origin = this.prSel;
    // A PR picked from a list or handed over by Go to has no space: the agent is the one in a space at the PR's checkout.
    const space = origin?.space ?? spaces().find((s) => origin?.cwd && s.folder === origin.cwd)?.id ?? null;
    const agent = origin?.session ? this.sessionAgent(origin) : this.target(space);
    if (agent) return { kind: "live", agent, name: agent.tab_name || agent.title || "the agent", chat: Boolean(shared("chatbar.api")) };
    if (origin?.session && origin.cwd) return { kind: "resume", where: origin.cwd };
    return { kind: "new", where: this.worktree?.path ?? origin?.cwd ?? this.root ?? null };
  },
  // The preview first, always. With a live agent the text is pasted, not sent: through the chatbar mod's bubble when
  // it is there (shared "chatbar.api"; PROVIDERS.md, chatbar.request), else into the agent's terminal in a floating
  // window. ponytail: that goes through the clipboard (hc send always presses Enter), which holds the text after.
  discuss(f, cx) {
    const text = this.findingText(f);
    this.previewSend(cx, { what: "Ask an agent", own: `${f.title}: ${f.detail}`, ownLabel: "FINDING", ask: this.askPlan(), prompt: text, go: (edited, cx) => this.discussNow(edited, cx) });
  },
  discussNow(text, cx) {
    const origin = this.prSel, plan = this.askPlan(), agent = plan.agent;
    cx.spawn(async (cx) => {
      if (agent && plan.chat) { // the chat bubble drafts it; nothing is sent
        setShared("chatbar.request", { action: "draft", terminal: agent.address, text, from: "pr-review", at: Date.now() });
        return cx.notify(); // a question changes nothing about the finding: it stays unresolved
      }
      if (plan.kind === "new" && plan.where) {
        // Asked from the review, which shows no terminals: the tab starts in the background (focus: false), so the
        // space and tab shown before the review are still the ones shown after it. Its name says where to find it.
        const name = tabName(origin?.repo ?? this.root, origin?.number ? `ask PR #${origin.number}` : "ask");
        run("tab.new", { space: this.spaceFor(this.ctxId(), origin?.cwd, this.root), folder: plan.where, name, focus: false,
          argv: TH.tabArgs({ env: this.ctxEnv(this.ctxId()), model: model(), ask: true, trusted: this.trustedPr() }), task: text });
        this.note = `Started the agent tab "${name}" in the background with your question. The finding stays as it is.`;
        return cx.notify();
      }
      await copyText(text);
      if (!agent) {
        // Resumed to paste the finding there: this tab takes the focus, so leaving the review lands on it.
        if (plan.kind === "resume") run("tab.new", { space: this.spaceFor(this.ctxId(), origin.cwd), folder: origin.cwd, name: tabName(origin.repo, `PR #${origin.number}`),
          argv: [...this.ctxEnv(origin.sessionContext ?? this.ctxId()), "claude", "--resume", origin.session] });
        this.note = plan.kind === "resume" ? "Resumed the PR's session in a new tab; the finding is on the clipboard (⌘V)" : "No checkout to start an agent in: the finding is on the clipboard";
        return cx.notify();
      }
      openOverlay({ kind: "window", key: "review-agent", width: 920, height: 620, layout: { type: "column", children: [
        { type: "block", size: { px: 34 }, content: { mod: "pr-review", props: { part: "agentbar", title: agent.tab_name || agent.title || "Agent" } } },
        { type: "block", content: { terminal: agent.address } }] } });
      cx.timer.after(450, () => { run("pane.focus", { terminal: agent.address }); run("terminal.paste"); });
    });
  },

  // Fix with agent: one finding, or the ones ticked in the preview. pool: the findings "Fix several…" offers (then
  // list is what is ticked so far, which may be nothing yet); alone: how many security findings it leaves out.
  fix(list, cx, pool = null, alone = 0) {
    if (!list.length && !pool) return;
    const report = `${findDir()}/${hash(this.prSel.url)}.jsonl`;
    const labels = list.map((f) => `${f.title} (${f.file}:${f.line})`), target = pool ? this.sendP?.fix?.target : null;
    this.previewFix(cx, { what: "Fix with agent", own: labels.join("\n"), ownLabel: list.length === 1 ? "FINDING" : "FINDINGS", items: list.map((f) => ({ kind: "finding", id: f.id })), labels,
      pool, alone, target,
      prompt: (sub) => [fixPrompt(list, this.pr, report, this.lang()), sub ? TH.worktreeNote(sub.branch, sub.path) : null].filter(Boolean).join("\n\n"),
      sent: (cx) => { for (const f of list) this.setFinding(f, "progress", cx, { fixHead: this.headNow() }); this.clearSel(cx); } });
  },
  // "Fix several…": the reviewer picks which unresolved findings one agent fixes together. Security findings about
  // access or data (pr.js secByEffect) are not offered: each goes alone, so that its change stays one commit to check.
  // A finding that is ⛨ only because a threat stands on it (a flood, a script that stops halfway) is offered.
  // ticked: the ids ticked so far (the boxes of the Findings tab: "Fix selected (n)…" opens the same preview with them).
  fixSeveral(cx, ticked = []) {
    const open = this.findings().filter((f) => ["open", "recheck"].includes(this.fstatus(f))), pool = open.filter((f) => !secByEffect(f));
    this.fix(pool.filter((f) => ticked.includes(f.id)), cx, pool, open.length - pool.length);
  },
  // ONE selection for "Fix selected": the comments ticked (your own, sent threads, other people's GitHub comments) and
  // the findings ticked in the Findings tab. Every place that names it says the same number (the bar's button, the
  // pill over the diff, the Findings tab's button), and each of them sends all of it to one fix agent (fixSelected).
  // It is kept per PR in two lists (threads.js: "selected" and FINDINGS); a send and Esc empty both.
  // Kept while what it is made of is the same (it is asked for by every card of a frame).
  selection() {
    return this.keep("selection", [this.threadDoc, this.comments, this.gh, this.findings(), this.find.status, this.find.reports, this.head, this.rowsSig(), this.prSel?.url], () => {
      const comments = this.commentsById(this.selected()), findings = this.pickedFindingsNow();
      return { comments, findings, n: comments.length + findings.length };
    });
  },
  selCount() { return this.selection().n; },
  // Findings alone: the list of "Fix several…" with them ticked. Comments alone: their preview. Both: one preview,
  // one agent, one branch (fixTogether).
  fixSelected(cx) {
    const { comments, findings } = this.selection(), ids = comments.map((c) => c.id);
    if (!findings.length) return this.fixComments(ids, cx);
    if (!comments.length) return this.fixSeveral(cx, findings);
    this.fixTogether(ids, this.findings().filter((f) => findings.includes(f.id)), cx);
  },
  fixTogether(ids, list, cx) {
    const c = this.commentFix(ids), report = `${findDir()}/${hash(this.prSel.url)}.jsonl`, found = list.map((f) => `${f.title} (${f.file}:${f.line})`);
    this.previewFix(cx, { what: "Fix with agent", ownLabel: "SELECTED",
      own: [`COMMENTS · ${c.comments.length}`, ...c.labels, "", `FINDINGS · ${list.length}`, ...found].join("\n"),
      items: [...c.items, ...list.map((f) => ({ kind: "finding", id: f.id }))], labels: [...c.labels, ...found],
      prompt: (sub) => TH.fixBothPrompt(c.prompt(sub, null), fixPrompt(list, this.pr, report, this.lang())), foreign: c.foreign,
      sent: (cx, how) => { for (const f of list) this.setFinding(f, "progress", cx, { fixHead: this.headNow() }); c.sent(cx, how); } });
  },
  // The findings ticked in the Findings tab's "No fix sent". Only what can still be ticked counts: unresolved, no fix
  // sent, and not a security finding about access or data (those go alone).
  pickedFindings() { return this.selection().findings; },
  pickedFindingsNow() {
    const ids = TH.selectedOf(this.threadDoc, this.threadKey(), TH.FINDINGS);
    return ids.length ? this.findings().filter((f) => ids.includes(f.id) && ["open", "recheck"].includes(this.fstatus(f)) && !secByEffect(f)).map((f) => f.id) : [];
  },
  pickFinding(id, cx) {
    const f = this.findingById(id), key = this.threadKey();
    if (f && ["open", "recheck"].includes(this.fstatus(f)) && !secByEffect(f)) this.updateThreads(cx, (d) => TH.toggleSelected(d, key, f.id, Date.now(), TH.FINDINGS));
  },
  // A tick in that list: the preview is built again for what is ticked now (branch name and text follow).
  fixPick(id, cx) {
    const f = this.sendP?.fix;
    if (!f?.pool) return;
    const ids = new Set(f.items.map((x) => x.id));
    if (ids.has(id)) ids.delete(id); else ids.add(id);
    this.fix(f.pool.filter((x) => ids.has(x.id)), cx, f.pool, f.alone);
  },

  // ---- definitions (defs.js: language servers through lsp_bridge.py, on the PR head checkout)

  lspRoot() { return this.exMode ? this.ex?.root ?? null : this.worktree?.path ?? (this.prSel?.space ? this.root : null); },

  define(it, r, cx, x = this.press.x, left = GUTTER, ri = it.ri) {
    const spans = this.spanMap?.get(it.src)?.spans?.[ri] ?? [];
    const tok = tokenAt(r, spans, x, left, this.charW ?? 7.8);
    if (!tok) { this.note = "⌘-click a name for its definition"; return cx.notify(); }
    this.lookupDef(it.path, r, tok, cx);
  },

  // The command "def:<path>:<line>:<name>": the definition of the first <name> on that new-side line, like a ⌘-click.
  defineAt(arg, cx) {
    const [path, line, name] = String(arg ?? "").split(":"), r = path && this.rowsFor(path).find((x) => atLine(x, Number(line), false));
    const character = r && name ? r.text.indexOf(name) : -1;
    if (character < 0) { this.note = `No ${name ?? "name"} on ${path}:${line}`; return cx.notify(); }
    this.tab = "files"; this.jumpTo(`${path}:${line}`, cx);
    this.lookupDef(path, r, { name, line: Number(line), character, side: "+" }, cx);
  },

  lookupDef(path, r, tok, cx) {
    const q = { root: this.lspRoot(), rev: this.worktree?.head ?? this.head ?? "", path, line: tok.line, character: tok.character, side: tok.side };
    const d = { key: `${path}:${lineKey(r)}`, name: tok.name, res: null };
    this.defAt = d;
    cx.spawn(async (cx) => {
      d.res = await lookup(q).catch((e) => ({ status: "error", message: String(e), definitions: [] }));
      // The last lookup, for debugging: what was clicked, where it was asked, what came back.
      setShared("pr.defs.last", { ...q, name: tok.name, status: d.res.status, message: d.res.message, def: d.res.definitions?.[0] ? where(d.res.definitions[0]) : null, at: new Date().toISOString() });
      if (this.defAt === d) cx.notify();
    });
    cx.notify();
  },

  // ⌘-click a name in the file view: its definition (the language servers of the repo; Restricted Mode as for PRs).
  defViewClick(i, cx) {
    const f = this.defFile, line = f?.lines[i];
    if (!f || line === undefined || !this.press.cmd) return;
    const row = { text: line, number: f.from + i + 1, n: f.from + i + 1, kind: " " }, tok = tokenAt(row, f.spans[i] ?? [], this.press.x, 56, this.charW ?? 7.8);
    if (!tok) { this.note = "⌘-click a name for its definition"; return cx.notify(); }
    const q = { root: this.lspRoot(), rev: this.exMode ? "" : this.worktree?.head ?? this.head ?? "", path: f.path, line: tok.line, character: tok.character, side: "+" };
    const d = { key: `view:${f.path}:${tok.line}`, name: tok.name, res: null, inView: true };
    this.defAt = d;
    cx.spawn(async (cx) => { d.res = await lookup(q).catch((e) => ({ status: "error", message: String(e), definitions: [] })); if (this.defAt === d) cx.notify(); });
    cx.notify();
  },

  // Jump to a definition: in the diff, its line; else the file at that line in a read-only view (Back or Esc returns).
  // Files beyond 6000 lines (system headers) show 6000 lines around it.
  goDef(def, cx) {
    const at = def.inRoot ? diffPath(this.fileHunks?.keys() ?? [], def.path) : null;
    const inDiff = at && this.rowsFor(at).some((r) => atLine(r, def.line, false));
    if (inDiff) { this.defAt = null; return this.jumpTo(`${at}:${def.line}`, cx, { fromDef: true }); } // fromDef: never back here
    const root = this.lspRoot();
    cx.spawn(async (cx) => {
      const text = def.inRoot ? await readTextFile(`${root}/${def.path}`).catch(() => null) : await contents(root, def.uri).catch(() => null);
      if (text === null || text === undefined) { this.note = this.jumpNote = `Could not open ${where(def)}`; return cx.notify(); }
      const all = text.replace(/\n$/, "").split("\n"), from = Math.max(0, def.line - 3000);
      const lines = all.slice(from, from + 6000).map(expandTabs);
      this.defFile = { path: def.path, line: def.line, from, lines, spans: highlightLines(lines, langOf(def.path, all[0]), `def:${def.uri ?? def.path}:${from}`) };
      this.lists.def.scroll_to_item(Math.max(0, def.line - from - 1), "center"); // "top" only reveals at the near edge: the line would sit under the view's bottom
      cx.notify();
    });
  },

  // What a lookup that found nothing says, per status.
  defMessage(res) {
    return { none: "no definition found", starting: "the language server is starting (first use can take ~25 s): ⌘-click again in a moment",
      timeout: "the language server took too long: ⌘-click again", "no-root": "the PR head is not checked out yet", "old-side": "removed lines have no definition (new side only)" }[res.status]
      ?? res.message ?? res.status;
  },

  defItem(it, t) {
    const d = it.d, res = d.res, def = res?.definitions?.[0], c = colors(t);
    const head = !res ? `Looking up ${d.name}…` : def ? `${d.name} → ${where(def)}${res.definitions.length > 1 ? ` (+${res.definitions.length - 1})` : ""}` : `${d.name}: ${this.defMessage(res)}`;
    // The bridge sends the preview as lines (an array): splitting it as text threw and took the whole review down.
    const raw = Array.isArray(def?.preview) ? def.preview : String(def?.preview ?? "").split("\n");
    const pre = raw.slice(0, 5).map(expandTabs), first = def?.previewStart ?? def?.line ?? 1, spans = def ? highlightLines(pre, langOf(def.path, first === 1 ? pre[0] : "")) : [];
    return div().w_full().h(this.sizeOf(it)).pl(GUTTER).pr(16).py(6).child(v_flex().size_full().px(12).py(8).gap(6).rounded(8).border_1().border_l(4)
      .border_color(t.accent).bg(t.surface).text_size(TYPE.body)
      .child(h_flex().h(18).gap(8).items_center().child(div().font_semibold().child(head)).when(!res, (e) => e.child(div().child(SPIN[0]).frames(SPIN, 90))))
      .child(v_flex().flex_1().min_h(0).overflow_hidden().p(6).rounded(6).bg(t.background).font_family(settings().font_family ?? "JetBrains Mono").text_size(TYPE.small)
        .children(pre.map((l, i) => h_flex().h(18).overflow_hidden().when(first + i === def?.line, (e) => e.bg(t.accent + "1f"))
          .child(div().w(40).flex_none().pr(8).text_right().text_color(t.muted).child(String(first + i))).children(renderLine(div, l, spans[i] ?? [], c)))))
      .child(h_flex().gap(BTN_GAP)
        .child(div().id("rv-di-go").tooltip("Open the file that defines this in the review").w(BTN + 40).h(26).flex().items_center().justify_center().rounded(6).border_1().border_color(def ? t.accent : t.border).text_size(TYPE.small).text_color(def ? t.foreground : t.muted).child("Go to definition"))
        .child(div().id("rv-di-code").tooltip(this.edOn ? "Open the defining file in your editor" : "No editor was found to open the file in").w(BTN + 40).h(26).flex().items_center().justify_center().rounded(6).border_1().border_color(t.border).text_size(TYPE.small).text_color(def && this.edOn ? t.foreground : t.muted).child(this.edOn ? "Open in editor" : "No editor"))
        .child(div().id("rv-di-x").tooltip("Close this definition preview").px(10).h(26).flex().items_center().text_size(TYPE.small).text_color(t.muted).child("Close"))));
  },

  // The file behind a definition outside the diff, highlighted, read-only.
  defView(t) {
    const f = this.defFile, c = colors(t), mono = settings().font_family ?? "JetBrains Mono";
    return v_flex().flex_1().min_h(0)
      .child(h_flex().flex_none().h(40).px(12).gap(10).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(TYPE.body)
        .child(pill("rv-def-back", t, this.exMode ? "← Back" : "← Back to the diff", (_e, cx) => { this.defFile = null; this.defAt = null; cx.notify(); }).tooltip("Return to the previous view (Esc)"))
        .child(div().flex_1().min_w(0).truncate().font_family(mono).font_semibold().child(`${f.path}:${f.line}`))
        .children(editorLink(this, t, "def", { root: this.lspRoot(), file: f.path, line: f.line, foreign: this.editorForeign(), where: "in the checkout this view reads" }, null))) // the same root this view reads from
      .when(Boolean(this.defAt?.inView), (e) => { const d = this.defAt, def = d.res?.definitions?.[0];
        return e.child(h_flex().flex_none().px(12).py(6).gap(8).items_center().border_b(1).border_color(t.border).bg(t.surface).text_size(TYPE.small)
          .child(div().flex_1().min_w(0).truncate().child(!d.res ? `Looking up ${d.name}…` : def ? `${d.name} → ${where(def)}` : `${d.name}: ${this.defMessage(d.res)}`))
          .when(Boolean(def), (x) => x.child(pill("rv-defv-go", t, "Go to definition", (_e, cx) => this.goDef(def, cx), false, t.foreground).tooltip("Open the file that defines this")))
          .child(pill("rv-defv-x", t, "✕", (_e, cx) => { this.defAt = null; cx.notify(); }).tooltip("Dismiss this hint").accessibility_label("Dismiss"))); })
      .child(div().flex_1().min_h(0).relative()
        .on_mouse_down("left", (e) => { this.press = { x: e.local_position?.x ?? 0, w: e.bounds?.width ?? 0, shift: e.modifiers.shift, cmd: e.modifiers.platform }; })
        .child(v_virtual_list("rv-def-list", f.lines.length, ROW, (i) => String(i), (range) => f.lines.slice(range.start, range.end).map((l, k) => {
          const i = range.start + k;
          return h_flex().h(ROW).w_full().font_family(mono).text_size(TYPE.code).when(f.from + i + 1 === f.line, (e) => e.bg(t.accent + "26"))
            .child(div().w(56).flex_none().pr(10).text_right().text_color(t.muted).child(String(f.from + i + 1)))
            .child(h_flex().flex_1().min_w(0).overflow_hidden().children(renderLine(div, l, f.spans[i] ?? [], c)));
        })).track_scroll(this.lists.def).on_item_click((key, cx) => this.defViewClick(Number(key), cx)).size_full())
        .child(Scrollbar.vertical("rv-def-list").absolute().inset_0()));
  },

  // ---- navigation

  visit(id, cx) {
    this.focusHunk = id;
    if (id && !this.prog.visited.has(id)) { this.prog.visited.add(id); this.saveProgress(cx); }
  },

  itemsOf(view) { return view === "steps" ? this.stepsItems() : this.filesItems(); }, // the Findings tab shows the Files list

  // Bring an item of a list (by its key in `at`, or its index) to the top of the view. The kit's scroll_to_item only
  // reveals an item at the near edge, so a target below the view would land at its bottom, under the code read
  // before. renderReview settles it in two frames (settleTop): just past the target first, then exactly to the top.
  scrollTo(view, key) { this.top = { view, key }; this.defFile = null; }, // a jump shows the list: a file opened read-only goes
  settleTop(view, at, sizes, cx) {
    const go = this.top, i = go?.i ?? at[go?.key];
    if (!go || go.view !== view) return;
    if (i === undefined || i >= sizes.length) { this.top = null; return; }
    if (go.past) { this.top = null; this.lists[view].scroll_to_item(i, "top"); return; } // cut off above now: "top" aligns it
    // on_size_change reports logical px, item heights scale with the person's zoom: the view's height in item px.
    go.past = true; this.lists[view].scroll_to_item(pastTop(sizes, i, (this.listH ?? 800) / (settings().zoom || 1)), "center");
    cx.timer.after(0, (cx) => cx.notify());
  },

  // A flow's "path:line" to the hunk that holds it (in the AI list, else the Files view). A line outside the diff (a
  // finding on unchanged code) opens its file read-only at that line, as a definition outside the diff does; what a
  // jump could not do is said until the next jump.
  jumpTo(at, cx, { fromDef = false } = {}) {
    this.hsDrag = null; // a click in a picture lands here, and its mouse-up never reached the root (see hsMove)
    if (this.note && this.note === this.jumpNote) this.note = null;
    if (this.exMode) return this.openExploreFile(pathOf(at), lineOf(at) ?? 1, cx); // no diff: the file itself
    const [, path, line] = /^(.*?):(\d+)/.exec(at ?? "") ?? [];
    const fp = diffPath(new Set((this.hunks ?? []).map((x) => x.path)), path), file = fp ? this.hunks.find((x) => x.path === fp) : null;
    const h = (this.hunks ?? []).find((x) => file && x.path === file.path && x.rows.some((r) => r.n === Number(line)))
      ?? (file && (!line || this.rowsFor(file.path, true).some((r) => atLine(r, Number(line), false))) ? file : null); // or context opened around a hunk
    if (!h && line && this.lspRoot() && !fromDef) return this.goDef({ path: fp ?? path, line: Number(line), inRoot: true }, cx);
    if (!h) { this.note = this.jumpNote = `Could not find ${at} in the diff`; return cx.notify(); }
    this.visit(h.id, cx); this.page = null; this.defFile = null; // from a Layers page or a file outside the diff: show the diff
    const view = this.tab === "steps" && this.itemsOf("steps").at[h.id] !== undefined ? "steps" : "files";
    if (view === "files") { if (this.tab !== "findings" && this.tab !== "comments") this.tab = "files"; this.unfold(h.path); this.sinceOn = false; } // the whole PR has every hunk
    const k = `+${line}`, { items } = this.itemsOf(view), row = items.findIndex((x) => x.t === "row" && x.path === h.path && lineKey(x.src[x.ri]) === k);
    if (view === "files") this.fileFocus = h.path; // marked in the file tree
    if (line && row >= 0) { this.fsel = { path: h.path, a: k, b: k }; this.top = { view, i: Math.max(0, row - 3) }; }
    else this.scrollTo(view, h.id);
    cx.notify();
  },

  goStep(i, cx, scroll = true) {
    const steps = this.steps();
    if (!steps.length) return;
    this.cur = Math.max(0, Math.min(i, steps.length - 1));
    this.visit(this.present(steps[this.cur])[0] ?? null, cx);
    this.fsel = null; this.sug = null;
    if (scroll) { this.tab = "steps"; this.page = null; this.scrollTo("steps", `s${this.cur}`); this.leftTop = 1; } // the open layer to the top on both sides
  },

  // n/p: the next hunk of the step (Layers) or of the whole diff (Files).
  goHunk(dir, cx) {
    const list = this.tab === "steps" ? this.present(this.steps()[this.cur] ?? { hunks: [] }) : this.shown().hunks.map((h) => h.id);
    const id = list[list.indexOf(this.focusHunk) + dir] ?? (list.includes(this.focusHunk) ? null : list[0]);
    if (!id) return;
    if (this.tab === "files") { const fp = (this.byId.get(id) ?? this.shown().hunks.find((h) => h.id === id))?.path; if (fp) this.unfold(fp); }
    this.visit(id, cx); this.fsel = null; this.sug = this.openSugs().find((s) => s.hunk === id)?.key ?? null;
    this.scrollTo(this.tab, id);
  },

  goFile(dir) {
    const paths = this.shown().patch.map((f) => f.path);
    const path = paths[paths.indexOf(this.fileFocus) + dir] ?? paths[0];
    if (path) { this.fileFocus = path; this.scrollTo("files", path); }
  },

  // ---- the diff as list items (one virtual list per tab)

  // room: the caller decided (stepsItems gives the open layer its room first): true, or the note to show instead.
  pushRows(items, at, rows, path, hunkOf, room) {
    // ponytail: gpui-kit's virtual list holds at most 10000 items; past the budget a file's lines fold to one note
    // (collapse other files to open it) instead of crashing the render. A paged list would lift the limit.
    const cap = this.rowCap ?? this.rowsCap(9000);
    if (room === undefined ? items.length + rows.length > cap : room !== true) { items.push({ t: "note", text: room ?? `${rows.length} lines not shown: the view holds about ${cap} lines at once. Collapse other files (click their header) to open this one.` }); return []; }
    const sugs = this.openSugs(path), cms = this.comments.filter((c) => c.file === path), used = new Set();
    const finds = this.findings().filter((f) => f.file === path && OPEN_ST.includes(this.fstatus(f))); // a fix sent stays here until it is verified
    // A card sits under the first code line of its finding's range; an open one marks the range in the gutter.
    const under = new Map(finds.map((f) => [f, findingAnchor(rows, f.line, f.end)]));
    (this.fmarks ??= new Map()).set(path, rangeMarks(rows, finds.filter((f) => this.findOpen(f)).map((f) => ({ line: f.line, end: Math.max(f.end ?? f.line, under.get(f)), mark: SEV[f.severity] }))));
    const own = this.ghOwn(), gh = this.ghNow().list.filter((g) => g.path === path && !own(g)), ghUsed = new Set(), f = this.fsel, range = this.composing && f?.path === path && rangeOf(rows, f.a, f.b);
    const ths = this.threads().filter((x) => x.file === path), notes = codePins(this.pins(), path);
    const show = this.show();
    const thread = { gh, editId: this.composing ? this.editing?.id ?? null : null, composeKey: range && at.compose === undefined ? lineKey(rows[range[1]]) : null };
    // The lines something hangs under (a suggestion, a comment, a thread, a note, a finding's card, the composer), by
    // their number on either side: underRow is asked only there. It pushes nothing for any other line, and asking it
    // for each was most of what a frame did to list 2 500 lines. (A definition's hint: every line, it is rare.)
    const hot = this.defAt?.key.startsWith(`${path}:`) ? null
      : new Set([...sugs.map((x) => x.line), ...cms.map((c) => c.end), ...gh.map((g) => g.line), ...ths.map((x) => x.end), ...notes.map((x) => x.anchor.end), ...under.values(), ...(range ? [rows[range[1]].number] : [])]);
    const cardsUnder = (r, side) => {
      if (hot && !hot.has(r.number)) return;
      const from = items.length;
      underRow(r);
      if (side) for (let k = from; k < items.length; k++) items[k] = { ...items[k], side };
    };
    const underRow = (r) => {
      if (r.number === undefined) return;
      if (this.defAt && this.defAt.key === `${path}:${lineKey(r)}`) items.push({ t: "def", d: this.defAt });
      // The Show switch: a kind switched off folds away here, never silently ("n hidden").
      const hidden = {}, hide = (k) => { hidden[k] = (hidden[k] ?? 0) + 1; };
      for (const s of sugs) if (atLine(r, s.line, s.old)) { if (show.ai) items.push({ t: "sug", s }); else hide("Findings"); }
      for (const it of lineThreads(r, cms, thread)) {
        if (it.c) used.add(it.c);
        if (it.t === "compose") { if (at.compose !== undefined) continue; at.compose = items.length; } // one composer, even when a hunk shows twice
        if (it.t === "composeact" && at.compose !== items.length - 1) continue;
        if (it.t === "comment") { if (show.mine) items.push(...this.cardItems("c", it.c)); else hide("Yours"); continue; } // also one taken from an AI note: it is yours now
        if (it.t === "cact") continue;
        if (it.t === "gh") ghUsed.add(it.g);
        if (it.t === "gh" && !show.github) { hide("GitHub"); continue; }
        items.push(it);
      }
      for (const th of ths) if (atLine(r, th.end, th.old)) { if (show.mine) items.push(...this.cardItems("th", th)); else hide("Yours"); }
      for (const pin of notes) if (atLine(r, pin.anchor.end, pin.anchor.old)) { if (show.notes) items.push(...this.cardItems("pin", pin)); else hide("Notes"); }
      if (r.kind !== "-") for (const f of finds) if (under.get(f) === r.number) { if (show.ai) items.push({ t: "find", f }, ...(this.findOpen(f) ? [{ t: "fact", f }] : [])); else hide("Findings"); }
      const n = Object.values(hidden).reduce((a, b) => a + b, 0);
      if (n) items.push({ t: "hidden", text: `${n} hidden · ${Object.keys(hidden).join(", ")}`, key: `${path}:${lineKey(r)}` });
    };
    // Side by side a unit is a pair of rows (l old, r new; one may be null), else one row; a longer line wraps: one
    // item per visual line (part). What hangs under a line follows its unit, over the whole width, marked with its side.
    const { cols, units, parts } = this.rowLayout(rows);
    for (const u of units) {
      const r = rows[u.ri];
      if (r.kind === "gap") { items.push({ t: "gap", path, r }); continue; }
      const hunk = hunkOf(r);
      if (hunk && at[hunk] === undefined) at[hunk] = items.length;
      for (let part = 0, n = parts(u); part < n; part++) items.push({ t: "row", path, src: rows, ri: u.ri, hunk, part, cols, ...(u.l === undefined ? {} : { l: u.l, r: u.r }) });
      if (u.l === undefined || u.l === u.r) cardsUnder(r, null);
      else { if (u.l !== null) cardsUnder(rows[u.l], "l"); if (u.r !== null) cardsUnder(rows[u.r], "r"); }
    }
    // What found no line here (pending comments, GitHub's outdated ones): the file's end shows them (filesItems).
    return [...cms.filter((c) => !used.has(c)), ...gh.filter((g) => !ghUsed.has(g)).map((g) => ({ gh: g }))];
  },
  // How a file's rows are drawn: the code columns per visual line, the units top to bottom ({ri} one row; side by side
  // {ri, l, r}, ri the row the item's key names) and how many visual lines a unit takes (its longer half's).
  rowLayout(rows) {
    const split = this.diffMode() === "split" && !oneSided(rows), lw = this.listW ?? 900, cw = this.codeCharW();
    const cols = !this.wrapOn() ? NO_WRAP : split ? codeCols(lw / 2, HALF_GUTTER, cw) : codeCols(lw, GUTTER, cw), n = (ri) => (ri === null ? 1 : this.wrapsOf(rows, ri, cols).length);
    const units = split ? pairRows(rows).map((p) => (p.full !== undefined ? { ri: p.full } : { ri: p.r ?? p.l, l: p.l, r: p.r })) : rows.map((_, ri) => ({ ri }));
    return { split, cols, units, parts: (u) => (u.l === undefined ? n(u.ri) : Math.max(n(u.l), n(u.r))) };
  },
  // Side by side or unified: the person's choice (shared "review.diff", the switch in the top bar), else what fits.
  // A layer's "Depends on": the shown layers by title (step.dependsOn) with each chip's width.
  stepDeps(s) { return (s.dependsOn ?? []).map((title) => this.steps().find((x) => x.title === title)).filter(Boolean).map((d) => [d, Math.min(220, textW(d.title, TYPE.small) + 14)]); },
  diffMode() { return diffModeOf(shared("review.diff"), this.listW ?? 900, this.codeCharW()); },
  // Long lines wrap only when the person switched it on (shared "review.wrap"); else the code scrolls sideways
  // (hsOf("rv-code"): the wheel or shift+wheel over the list, the bar at its foot), gutters and cards stay.
  wrapOn() { return shared("review.wrap") === true; },
  codeShift() { return this.wrapOn() ? 0 : this.hsOf("rv-code").x; },
  // The sideways room of the diff's code: its longest line (whole row arrays, memoized) against the code column.
  codeScroll(items) {
    const s = this.hsOf("rv-code"), m = (this.longest ??= new WeakMap()), lw = this.listW ?? 900, cw = this.codeCharW();
    let n = 0;
    // ponytail: the lines on screen in the last frame decide; one scroll for the whole list, not per file.
    const v = this.visCode, shown = v && v.end <= items.length ? items.slice(v.start, v.end) : items;
    for (const it of shown) {
      if (it.t !== "row") continue;
      if (!m.has(it.src)) m.set(it.src, it.src.reduce((k, r) => (r.number === undefined ? k : Math.max(k, expandTabs(r.text).length)), 0));
      n = Math.max(n, m.get(it.src));
    }
    const vis = this.diffMode() === "split" ? lw / 2 - HALF_GUTTER - 12 : lw - GUTTER - 12;
    s.contentW = n * cw + 8; s.visW = lw; s.maxX = this.wrapOn() ? 0 : Math.max(0, s.contentW - vis); s.x = Math.min(s.x, s.maxX); s.view = vis;
    return s;
  },

  stepsItems(steps = this.steps()) {
    const items = [], at = {};
    // Its own number of lines, every time: it used to take what the Files list had left (2 500), or 9 000 when that
    // list was never drawn, and 9 000 lines take 40 to 50 ms per frame in Herdr (a frame is stopped at about 50).
    // STEP_LINES take about half of what a frame may; when frames are stopped all the same, it halves (rowsCap).
    // The open layer's hunks get the room first, then the layers after it, then the ones before: the layer you read
    // always has its lines, whatever stands above it.
    const cap = this.rowCap = this.rowsCap(STEP_LINES), cur = Math.min(this.cur ?? 0, steps.length - 1), fits = new Set();
    let left = cap;
    for (const i of steps.map((_s, k) => k).sort((a, b) => (a >= cur ? a - cur : steps.length + cur - a) - (b >= cur ? b - cur : steps.length + cur - b))) {
      for (const id of this.present(steps[i])) { const n = this.byId.get(id).rows.length; if (n <= left) { fits.add(`${i}|${id}`); left -= n; } }
    }
    steps.forEach((s, i) => {
      at[`s${i}`] = items.length;
      items.push({ t: "step", s, i }, ...(s.visuals ?? []).flatMap((v, k) => this.visItems(v, i, k)));
      const present = this.present(s);
      if (s.stale) items.push({ t: "note", text: "Outdated: these hunks are no longer in the diff." });
      const seen = new Set();
      for (const id of present) {
        const h = this.byId.get(id);
        at[id] = items.length;
        items.push({ t: "path", h });
        // A file this layer shares with others: under its first path, how many of its hunks are elsewhere.
        const more = seen.has(h.path) ? 0 : (this.hunks ?? []).filter((x) => x.path === h.path && !present.includes(x.id)).length;
        seen.add(h.path);
        if (more) items.push({ t: "more", path: h.path, n: more, text: `more|${i}|${h.path}` });
        this.pushRows(items, at, h.rows, h.path, () => id, fits.has(`${i}|${id}`) || `${h.rows.length} lines not shown: the view holds about ${cap} lines at once.${i === cur ? "" : " Open this layer to see them."}`);
      }
    });
    return { items, at };
  },

  // The diff the Files tab shows: only the changes since your last review while that is on, else the whole PR.
  shown() {
    return this.sinceOn && this.since ? { patch: this.since.files, fileHunks: this.since.fileHunks, hunks: this.since.hunks }
      : { patch: this.patch ?? [], fileHunks: this.fileHunks, hunks: this.hunks ?? [] };
  },

  // Open a file and give it the list's room first (filesItems: overBudget).
  unfold(p) { this.collapsed.delete(p); this.recentOpen = [p, ...(this.recentOpen ?? []).filter((x) => x !== p)].slice(0, 200); },
  filesItems() {
    const items = [], at = {}, sh = this.shown();
    // 2500 lines open at most: every render walks the list's items, and Herdr stops a slice after ~50 ms; 9000 open
    // lines took that long. The virtual list's own limit (10000) leaves room for every file's header and one note.
    const cap = this.rowCap = this.rowsCap(Math.min(2500, Math.max(1000, 9700 - 2 * sh.patch.length)));
    // The virtual list holds at most 10000 items: the files around the one you read (this.center, autoFold) and the
    // ones you opened last get the room (views.js allocate); the rest fold to one item of their height (overBudget).
    const rowsOf = new Map(), open = [], heads = []; // not `rows`: the loop below has its own
    sh.patch.forEach((f, i) => {
      if (this.collapsed.has(f.path) || f.binary || !sh.fileHunks?.get(f.path)?.length) return;
      rowsOf.set(f.path, this.memoRows(`0\0${f.path}`, f.path, sh.fileHunks.get(f.path), Array.isArray(this.full[f.path]) ? this.full[f.path] : null, f));
      open.push({ path: f.path, i, n: rowsOf.get(f.path).length });
    });
    this.overBudget = allocate({ files: open, center: this.center ?? 0, recent: this.recentOpen ?? [], cap });
    for (const f of sh.patch) {
      at[f.path] = items.length;
      heads.push(items.length);
      items.push({ t: "file", f });
      if (this.overBudget.has(f.path)) { items.push({ t: "fold", path: f.path, n: rowsOf.get(f.path).length, h: this.foldH(f.path, rowsOf.get(f.path)) }); continue; }
      if (this.collapsed.has(f.path)) continue;
      const hs = sh.fileHunks?.get(f.path) ?? [], full = Array.isArray(this.full[f.path]) ? this.full[f.path] : null;
      if (typeof this.full[f.path] === "string") items.push({ t: "note", text: this.full[f.path] });
      if (f.binary) { items.push({ t: "note", text: "Binary file" }); continue; }
      if (!hs.length) { items.push({ t: "note", text: f.status === "renamed" ? `Renamed from ${f.from}, content unchanged` : "No text change" }); continue; }
      const rows = this.memoRows(`0\0${f.path}`, f.path, hs, full, f);
      const loose = this.pushRows(items, at, rows, f.path, (r) => (r.h === undefined ? null : hs[r.h].id));
      for (const c of loose) {
        if (c.gh) { if (this.show().github) items.push({ t: "gh", g: c.gh, loose: true }); continue; }
        if (this.composing && this.editing?.id === c.id && at.compose === undefined) { at.compose = items.length; items.push({ t: "compose", c, loose: true }, { t: "composeact", c }); }
        else items.push(...this.cardItems("c", c, true));
      }
    }
    return { items, at, heads };
  },
  // A folded file's height: what it took when last open (renderReview keeps openH), else its rows'.
  foldH(path, rows) {
    const o = this.openH?.get(path), L = this.rowLayout(rows), key = `${L.split}|${L.cols}`;
    if (o?.rows === rows && o.key === key) return o.h;
    const memo = (this.rowsH ??= new WeakMap());
    if (memo.get(rows)?.key !== key) memo.set(rows, { key, h: L.units.reduce((h, u) => h + (rows[u.ri].kind === "@" || rows[u.ri].kind === "gap" ? 30 : ROW * L.parts(u)), 0) });
    return memo.get(rows).h;
  },
  // A code character's width in the list's px: the probe measures it zoomed, listW is not (renderReview).
  codeCharW() { return (this.charW ?? 7.8 * (settings().zoom || 1)) / (settings().zoom || 1); },
  // A row's visual lines at `cols` columns of code (views.js wrapCode): the offset each starts at in its tab-expanded
  // text, kept per row array and width (rows are memoized across renders, memoRows).
  wrapsOf(src, ri, cols) {
    const r = src[ri];
    if (r?.number === undefined || (r.text.length <= cols && !r.text.includes("\t"))) return ONE_LINE;
    const m = (this.wraps ??= new WeakMap());
    if (!m.has(src)) m.set(src, {});
    const at = (m.get(src)[cols] ??= []);
    return (at[ri] ??= wrapCode(expandTabs(r.text), cols));
  },
  // Scrolled near a folded file in another file than the room was given around: give it around this one, keeping
  // the item at the top of the view where it is (renderReview: anchor).
  autoFold(cx) {
    const L = this.filesList, v = this.vis;
    if (!L || !v || this.tab === "steps") return;
    const c = recenter({ heads: L.heads, top: L.top, folds: L.folds, start: v.start, end: v.end, center: this.center ?? 0, margin: FOLD_MARGIN });
    if (c === null) return;
    this.center = c; this.anchor = { key: L.keys[v.start], y: L.top[v.start] }; cx.notify();
  },


  // ---- clicks in the list: one handler for all rows (gpui-kit); where in the row comes from the press

  pressLine(arg, cx) {
    const [side, k, how, ...p] = String(arg).split(":"), path = p.join(":"), w = this.listW ?? 900, hits = [];
    for (const [key, it] of this.byKey ?? []) {
      if (it.t !== "row" || it.path !== path) continue;
      const ri = it.l === undefined ? it.ri : side === "l" ? it.l : it.r;
      if (ri !== null && lineKey(it.src[ri]) === k) hits.push([key, it, ri]);
    }
    if (!hits.length) { this.note = `Line ${k} of ${path} is not in the shown diff`; return; }
    const [, it0, ri] = hits[0], pair = it0.l !== undefined, hw = pair ? w / 2 : w, base = pair && side === "r" ? hw : 0, gw = pair ? HALF_GUTTER : GUTTER;
    const [key] = how === "chip" ? hits[Math.min(hits.length, this.wrapsOf(it0.src, ri, it0.cols).length) - 1] : hits[0]; // the chip: on the line's last visual line
    this.press = { x: base + (how === "comment" ? 10 : how === "chip" ? hw - 12 - CHIP_W / 2 : gw + 4), w, shift: how === "shift", cmd: false };
    this.onItem(key, cx);
  },

  onItem(key, cx) {
    const it = this.byKey?.get(key); // a stable key: the item pressed, even if the list changed since
    if (!it) return;
    const { x, shift } = this.press;
    if (it.t === "compose") return this.draft.focus();
    this.fh.focus();
    if (it.t === "row") {
      if (it.hunk) this.visit(it.hunk, cx);
      // Side by side: the half pressed is the line, x and the width are the half's (views.js pairSide).
      const h = it.l === undefined ? { ri: it.ri, x, w: this.press.w, side: null } : pairSide(x, this.press.w, it.l, it.r), r = h.ri === null ? null : it.src[h.ri];
      if (!r || r.number === undefined) return;
      // A wrapped line's next visual line: its code starts that many columns into the line.
      const starts = this.wrapsOf(it.src, h.ri, it.cols), part = it.part ?? 0, a = starts[part], lastPart = part === starts.length - 1, gw = h.side ? HALF_GUTTER : GUTTER;
      if (a === undefined) return; // the blank under a half's shorter line
      if (this.press.cmd) return this.define(it, r, cx, h.x < gw ? h.x : h.x + (a + this.codeShift() / this.codeCharW()) * (this.charW ?? 7.8), gw, h.ri); // ⌘-click a name: its definition (scrolled sideways: that many columns on)
      // Selections are (file, line keys), not row indexes: rows are rebuilt on every render.
      // A line number (GitHub's gutter "+") opens the composer there; shift-click makes it a range. Side by side a
      // selection stays on its half: a press on the other half starts a new one there.
      const k = lineKey(r), same = !h.side || !this.fsel?.side || this.fsel.side === h.side, f = same ? this.fsel : null;
      // The selection's chips sit on a wrapped line's last visual line: as far right on the others is code.
      const d = rowClick({ x: lastPart ? h.x : Math.min(h.x, h.w - 21 - CHIP_W - ASK_W), w: h.w, shift, gutterW: gw, composing: this.composing, editing: Boolean(this.editing), sel: f, path: it.path, k,
        rangeOk: Boolean(f && f.path === it.path && rangeOf(this.rowsFor(it.path), f.a, k)) });
      if (d.focus) return this.draft.focus(); // the open composer keeps its line
      if (d.ask) { this.setDrawer("open", cx, null); return cx.notify(); }
      this.fsel = d.sel && h.side ? { ...d.sel, side: h.side } : d.sel; this.sug = null;
      if (d.open) this.openComposer(cx);
    } else if (it.t === "gh") {
      if (x >= SIDE_BOX[0] && x < SIDE_BOX[1]) this.toggleSel(`gh${it.g.id}`, cx); // its box, in the gutter beside the card
      else if (!(this.ghOpen ??= new Set()).delete(it.g.id)) this.ghOpen.add(it.g.id); // its <details> open and fold, as on GitHub
    }
    else if (it.t === "sug") { this.sug = this.sug === it.s.key ? null : it.s.key; this.visit(it.s.hunk, cx); }
    else if (it.t === "ch" || it.t === "cb" || it.t === "cr") this.cardClick(it, x, cx);

    else if (it.t === "composeact") { const b = this.composeButtons().find((b) => x >= b.x && x < b.x + b.w); if (b) this[b.act](cx); }
    else if (it.t === "def") {
      const b = x - GUTTER - 12, which = b >= 0 && b < BTN + 40 ? 0 : b >= BTN + 40 + BTN_GAP && b < 2 * (BTN + 40) + BTN_GAP ? 1 : b >= 2 * (BTN + 40 + BTN_GAP) ? 2 : -1;
      const d = it.d.res?.definitions?.[0];
      if (which === 2) this.defAt = null;
      else if (d && which === 0) this.goDef(d, cx);
      else if (d && which === 1) { if (d.inRoot && this.lspRoot() && this.edOn) this.openEditor({ root: this.lspRoot(), file: d.path, line: d.line, foreign: this.editorForeign() }, cx); else this.note = this.edOn ? "Could not open: the definition is not a file of this checkout" : "No editor was found to open the file in"; }
    } else if (it.t === "fact") {
      const b = x - GUTTER - 12, which = Math.floor(b / (BTN + BTN_GAP)), inside = b >= 0 && b % (BTN + BTN_GAP) < BTN;
      if (inside && which === 0) this.findingComment(it.f, cx);
      else if (inside && which === 1) this.discuss(it.f, cx);
      else if (inside && which === 2) { const job = this.fixOf(it.f.id); if (job?.terminal) this.goFix(job); else this.fix([it.f], cx); }
      else if (inside && which === 3) this.dismiss(it.f, cx);
    } else if (it.t === "find") {
      if (x >= SIDE_BOX[0] && x < SIDE_BOX[1]) this.pickFinding(it.f.id, cx); // its box, in the gutter beside the card (nothing for one that cannot be ticked)
      else if (this.findOpen(it.f) && x >= this.press.w - 16 - FIND_LINK) this.openFinding(it.f);
      else (this.fopen ??= new Map()).set(it.f.id, !this.findOpen(it.f));
    }
    else if (it.t === "cact") {
      const b = x - GUTTER - 12, which = b >= 0 && b < BTN ? 0 : b >= BTN + BTN_GAP && b < 2 * BTN + BTN_GAP ? 1 : -1;
      if (it.t === "cact" && which === 0) this.openComposer(cx, it.c);
      else if (it.t === "cact" && which === 1) this.dropComment(it.c, cx);
      else if (it.t === "cact" && which === 2) this.fixComments([TH.commentId(it.c)], cx);
    } else if (it.t === "gap") this.expand(it.path, it.r.gap, x < GUTTER + GAP_SEG ? "down" : x < GUTTER + 2 * GAP_SEG ? "up" : "all", cx);
    else if (it.t === "file") {
      const p = it.f.path;
      this.fileFocus = p;
      if (x >= FILE_CHEV && x < FILE_CHEV + FILE_SEEN) this.toggleSeen(p, cx);
      else if (x >= FILE_CHEV + FILE_SEEN && x < FILE_CHEV + FILE_SEEN + FILE_WHOLE && this.shown().fileHunks?.has(p)) this.toggleWhole(p, cx);
      else if (this.fileEditMark(it.f) && x >= FILE_CHEV + FILE_SEEN + FILE_WHOLE && x < FILE_CHEV + FILE_SEEN + FILE_WHOLE + FILE_EDIT) this.openEditor(this.fileEditTarget(it.f), cx);
      else if (this.fileEditMark(it.f) && x >= FILE_CHEV + FILE_SEEN + FILE_WHOLE + FILE_EDIT && x < FILE_CHEV + FILE_SEEN + FILE_WHOLE + FILE_EDIT + FILE_EDIT_MORE) openEditorMenu(this, this.fileEditTarget(it.f));
      else if (this.collapsed.has(p) || this.overBudget?.has(p)) this.unfold(p); else this.collapsed.add(p);
    } else if (it.t === "fold") this.unfold(it.path);
    else if (it.t === "step") {
      const md = it.i === this.cur && !it.s.pseudo ? [MD_W] : []; // the open layer's "Copy as Markdown", after the chips
      const deps = this.stepDeps(it.s), k = chipAt(x, this.press.w - 16, [...deps.map(([, w]) => w), ...md], 10); // the head's "Depends on" chips: px(16), gap(10)
      if (k >= deps.length) this.copyMd(); else if (k >= 0) this.goStep(this.steps().indexOf(deps[k][0]), cx); else this.goStep(it.i, cx, false);
    }
    else if (it.t === "path") this.visit(it.h.id, cx);
    else if (it.t === "visfold" || (it.t === "vis" && it.bare)) this.toggleVis(it.text);
    else if (it.t === "vtr" && (it.e.at || it.e.evidence)) this.jumpTo(it.e.at ?? it.e.evidence, cx);
    else if (it.t === "more") this.command(`file:${it.path}`, cx); // the Files tab at that file, all its hunks (as pr-review.file:<path>)
    cx.notify();
  },

  toggleSeen(path, cx) {
    if (this.prog.seen.has(path)) { this.prog.seen.delete(path); this.collapsed.delete(path); }
    else { this.prog.seen.add(path); this.collapsed.add(path); }
    this.saveProgress(cx);
  },

  toggleWhole(path, cx) {
    this.rowsTouched();
    if (this.whole.has(path)) this.whole.delete(path);
    else { this.whole.add(path); this.unfold(path); this.loadFull(path, cx); }
  },

  expand(path, k, how, cx) {
    const g = (this.gaps[path] ??= {}), cur = g[k] ?? { down: 0, up: 0 };
    g[k] = how === "all" ? { down: 1e9, up: 0 } : { ...cur, [how]: cur[how] + MORE };
    this.rowsTouched(); this.loadFull(path, cx);
  },

  // The file at the PR head: from the local clone when it has that commit, else from GitHub.
  loadFull(path, cx) {
    if (this.full[path] !== undefined && !String(this.full[path]).startsWith("Could not load")) return;
    this.full[path] = "Loading file…"; this.rowsTouched();
    const url = this.prSel.url, repo = /github\.com\/([^/]+\/[^/]+)\/pull/.exec(url)?.[1];
    cx.spawn(async (cx) => {
      let text = null;
      try {
        if (!this.head) {
          const v = await exec("gh", ["pr", "view", url, "--json", "headRefOid"], { timeout: 30000 });
          if (v.code !== 0) throw new Error("PR head unknown");
          this.head = JSON.parse(v.stdout).headRefOid;
        }
        const head = this.head, w = this.worktree;
        // The worktree's file needs no process; a clone that has the commit one; GitHub the network.
        if (w && w.head === head && !w.local) text = await readTextFile(`${w.path}/${path}`).catch(() => null);
        const local = text === null && this.root ? await exec("git", ["cat-file", "-p", `${head}:${path}`], { cwd: this.root }).catch(() => null) : null;
        if (text !== null) {} else if (local?.code === 0) text = local.stdout;
        else {
          const r = await exec("gh", ["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${head}`], { timeout: 60000 });
          if (r.code !== 0) throw new Error(r.stderr.trim().slice(0, 160));
          text = r.stdout;
        }
      } catch (e) { if (this.prSel?.url === url) { this.full[path] = `Could not load the file: ${String(e).replace(/^Error: /, "")}`; this.rowsTouched(); } }
      if (this.prSel?.url !== url) return;
      if (text !== null) { this.full[path] = text.replace(/\n$/, "").split("\n"); this.rowsTouched(); }
      cx.notify();
    });
  },

  // ---- suggestions and comments

  focusedSug() {
    const open = this.openSugs();
    return open.find((s) => s.key === this.sug) ?? open.find((s) => s.hunk === this.focusHunk) ?? null;
  },

  takeSug(s, cx) {
    const h = this.byId.get(s.hunk), c = h && suspectComment(s, h.rows, Date.now().toString(36));
    if (!c) { this.note = "Could not accept: that line is no longer in the diff"; return; }
    this.comments = [...this.comments, { ...c, head: this.head }]; this.persist(cx);
    this.prog.handled[s.key] = "taken"; this.saveProgress(cx); this.sug = null;
  },

  dropSug(s, cx) { this.prog.handled[s.key] = "dropped"; this.saveProgress(cx); this.sug = null; },

  // One file's rows as the Files view shows them (hunks plus opened context): what selections are measured on.
  // whole: of the whole PR even while only the changes since your last review are shown (findings are on the PR).
  rowsFor(path, whole = false) {
    const sh = whole ? { patch: this.patch ?? [], fileHunks: this.fileHunks } : this.shown();
    // NO_HUNKS: one array for every file outside the diff (a finding on unchanged code), so its rows stay memoized.
    const hs = sh.fileHunks?.get(path) ?? NO_HUNKS, f = fileOf(sh.patch, path), full = Array.isArray(this.full[path]) ? this.full[path] : null;
    return this.memoRows(`${whole ? 1 : 0}\0${path}`, path, hs, full, f);
  },
  // What rowsFor reads (the patch, its hunks, whole files, opened context) as one value to compare by identity: the
  // same object as long as none of them changed. this.full, this.gaps and this.whole change in place: whoever writes
  // one calls rowsTouched(). A new row array from memoRows counts as well, so a write that forgot to say so is
  // noticed the next time that file's rows are asked for.
  rowsTouched() { this.rowsGen = (this.rowsGen ?? 0) + 1; },
  rowsSig() {
    const k = this.rowsKey, gen = this.rowsGen ?? 0;
    if (k && k.patch === this.patch && k.fh === this.fileHunks && k.full === this.full && k.gaps === this.gaps && k.whole === this.whole && k.gen === gen) return k;
    return (this.rowsKey = { patch: this.patch, fh: this.fileHunks, full: this.full, gaps: this.gaps, whole: this.whole, gen });
  },
  // Memoized on their inputs: findings call rowsFor per finding on every render, and the Files view keeps the same row
  // arrays across renders, which the highlight cache (spanMap) is keyed on (a big PR timed the render out).
  memoRows(key, path, hs, full, f) {
    const g = this.gaps[path], deps = [hs, full, g ? JSON.stringify(g) : "null", this.whole.has(path), f?.status];
    const memo = (this.rowsMemo ??= new Map()), hit = memo.get(key);
    if (hit && hit.deps.every((d, i) => d === deps[i])) return hit.rows;
    this.rowsTouched();
    const rows = fileRows(hs.map((h) => h.rows), full, this.gaps[path], this.whole.has(path), f?.status === "modified" || f?.status === "renamed");
    if (memo.size > 8000) memo.clear(); // ponytail: two entries per file (whole/shown); 3000-file PRs fit
    memo.set(key, { deps, rows });
    return rows;
  },

  // The selected range as a comment anchor (lines, side, quoted code); null when nothing (or nothing valid) is selected.
  selAnchor() {
    // Side by side a selection is one half's lines: the other half's changed lines between its ends are not in it.
    const f = this.fsel, all = f ? this.rowsFor(f.path) : null, drop = f?.side && this.diffMode() === "split" ? (f.side === "l" ? "+" : "-") : null;
    const rows = all && drop ? all.filter((r) => r.kind !== drop) : all, range = rows && rangeOf(rows, f.a, f.b);
    return range ? selection(rows, range[0], range[1]) : null;
  },

  // c: the selection, else the focused suggestion's line, else the first change of the focused hunk.
  ensureSel() {
    if (this.fsel) return;
    const h = this.byId?.get(this.focusHunk) ?? this.hunks?.[0];
    if (!h) return;
    const s = this.focusedSug(), i = s ? h.rows.findIndex((r) => atLine(r, s.line, s.old)) : h.rows.findIndex((r) => r.kind === "+" || r.kind === "-");
    if (i >= 0) this.fsel = { path: h.path, a: lineKey(h.rows[i]), b: lineKey(h.rows[i]) };
  },

  // ---- threads: comments that went out stay under their lines with the agent's or GitHub's replies

  threadKey() { return this.prSel?.url ?? null; },
  repliesFile() { return `${repliesDir()}/${hash(this.threadKey() ?? "")}.jsonl`; },
  threads() { return TH.threadsOf(this.threadDoc, this.threadKey()); },
  async loadThreads(cx) {
    const key = this.threadKey();
    if (!key) return;
    const [doc, rep] = await Promise.all([readTextFile(threadsFile()).catch(() => null), readTextFile(this.repliesFile()).catch(() => null)]);
    if (this.threadKey() !== key) return;
    // The same two texts as read last for this PR: nothing to parse and no frame (the watch on the replies folder and
    // every GitHub poll come through here).
    if (this.threadsRead?.key === key && this.threadsRead.doc === doc && this.threadsRead.rep === rep) return;
    this.threadsRead = { key, doc, rep };
    this.threadDoc = doc ? JSON.parse(doc) : {}; this.replies = TH.parseReplies(rep);
    cx.notify();
  },
  // threads.json changed by fn, here and in the file (compare-and-swap, like the findings' status).
  // The change shows at once, from what is kept here: this copy is drawn again and what the bar shows of it (the
  // number selected) is published in the same call, so a tick costs one frame. The file follows in the background
  // (its write, the registry and publish() after it find nothing new to draw). Before, a tick was only drawn when
  // something else drew the review: the registry's write 1.5 s later, or nothing at all.
  updateThreads(cx, fn) {
    this.threadDoc = fn(this.threadDoc); this.publish(); cx.notify();
    cx.spawn(async (cx) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await readTextFile(threadsFile()).catch(() => null);
        try { await writeTextFile(threadsFile(), JSON.stringify(fn(before ? JSON.parse(before) : {})), before); this.registerReview(cx); this.publish(); return; } catch { /* written meanwhile: again */ }
      }
      this.note = "Could not save the sent comments"; cx.notify();
    });
  },
  // GitHub comments this review shows itself (a posted thread and the replies to it) stay out of the plain list.
  ghOwn() {
    const ids = new Set(this.threads().map((t) => t.ghId).filter(Boolean));
    return (g) => ids.has(g.id) || ids.has(g.in_reply_to_id);
  },
  // A fixed thread folds, unless its fix still waits for Apply to PR.
  threadOfView(th) { return TH.threadView(th, this.replies[th.id] ?? [], TH.ghRepliesTo(this.gh, th.ghId), this.openThreads.has(th.id) || Boolean(this.fixOf(th.id))); },

  // The agent a send goes to (as deliver picks it) and how that reads.
  sendAgent() {
    const origin = this.prSel, space = origin?.space ?? focused()?.space ?? null;
    const agent = origin?.session ? this.sessionAgent(origin) : space ? this.target(space) : null;
    return { agent, label: TH.agentLabel(agent, origin?.session ? "the PR's session, resumed in a new tab (claude --resume)" : "a new Claude tab in this repo") };
  },
  // Nothing is typed into an agent's session without this preview: who gets it, the reviewer's own words apart, the
  // exact text (editable). go(text, cx): what "Send to agent" does with the confirmed text (default: deliver it).
  // guard: the text holds someone else's GitHub comment (threads.js foreignComment): it goes to a new agent tab in
  // manual mode, never into a running session (main.js deliver).
  previewSend(cx, { what, own, prompt, onSent, go, ownLabel = "YOUR COMMENT", ask = null, guard = false }) {
    const { agent, label } = this.sendAgent();
    this.sendP = { ...TH.preview({ what, agent: label, own, prompt }), onSent, go, ownLabel, ask, guard, address: agent?.address ?? null };
    this.sendText.set_value(prompt); this.finishOpen = false;
    cx.notify();
  },
  sendConfirmed(cx) {
    const p = this.sendP;
    if (!p || this.sending) return;
    if (p.fix?.pool && !p.fix.items.length) return; // "Fix several…" with nothing ticked: the button is off
    const out = TH.confirm(p, this.sendText.value());
    this.sendP = null;
    if (p.fix?.target === "sub") return this.startSubFix(p, out.text, cx);
    if (p.verify) return this.startVerify(p, out.text, cx);
    if (p.go) p.go(out.text, cx);
    else this.deliver(out.text, cx, out.what, (cx) => p.onSent?.(cx), Boolean(p.guard));
    cx.notify();
  },

  // "Reply" in a thread: one follow-up to the same agent with the thread as context (through the preview).
  followup(cx) {
    const th = this.threads().find((t) => t.id === this.replyTo), text = this.replyIn.value().trim();
    if (!th || !text) return;
    const replies = this.replies[th.id] ?? [], key = this.threadKey();
    this.previewSend(cx, { what: "Reply", own: text, guard: TH.foreignComment(th, shared("gh.login")), prompt: TH.followupPrompt({ pr: this.pr, thread: th, replies, text, file: this.repliesFile(), lang: this.lang(), login: shared("gh.login") }),
      onSent: (cx) => { this.updateThreads(cx, (d) => TH.addFollowup(d, key, th.id, text, replies.length)); this.replyIn.set_value(""); this.replyTo = null; } });
  },
  // A thread's buttons, left to right (clicks placed by x in onItem): Reply, the agent's last commit, GitHub, fold.
  threadButtons(th, v = this.threadOfView(th)) {
    const fv = this.fixView(this.fixOf(th.id));
    const fix = !fv ? [{ label: "Fix…", act: (cx) => this.fixComments([th.id], cx) }]
      : [...(fv.job.terminal ? [{ label: "Go to fix", act: () => this.goFix(fv.job) }] : []), ...(fv.commit && fv.job.target === "sub" ? [{ label: "Apply to PR", primary: true, act: (cx) => this.applyFix(fv.job, cx) }] : []),
        ...(fv.job.target === "sub" ? [{ label: "Discard fix", act: (cx) => this.discardFix(fv.job, cx) }] : [])];
    return [...fix, { label: "Reply", primary: !fv?.commit, act: (cx) => { this.replyTo = th.id; this.replyIn.set_value(""); cx.timer.after(0, () => this.replyIn.focus()); } },
      ...(v.fixedIn || v.entries.some((e) => e.commit) ? [{ label: `Open ${String(v.fixedIn ?? [...v.entries].reverse().find((e) => e.commit).commit).slice(0, 7)}`, act: () => this.openCommit(v.fixedIn ?? [...v.entries].reverse().find((e) => e.commit).commit) }] : []),
      ...(th.url ? [{ label: "On GitHub ↗", act: () => openUrl(th.url) }] : []),
      ...(v.status === "fixed" ? [{ label: "Fold", act: () => this.openThreads.delete(th.id) }] : [])];
  },
  // ---- Fix: comments (pending or sent) and findings to a sub-agent in its own worktree (default) or the main agent,
  // always through the preview; the sub-agent never pushes and hands its fix to nobody: it stays on its branch until
  // the reviewer picks "Apply to PR" (cherry-pick onto the PR's checkout) or "Hand over…" (the main agent takes it).

  selected() { return TH.selectedOf(this.threadDoc, this.threadKey()); },
  toggleSel(id, cx) { const key = this.threadKey(); this.updateThreads(cx, (d) => TH.toggleSelected(d, key, id)); },
  fixes() { return TH.fixesOf(this.threadDoc, this.threadKey()); },
  fixOf(id) { return TH.fixFor(this.threadDoc, this.threadKey(), id); },
  // The local checkout a fix branch is made in and applied to: the session's folder or the clone the PR was picked in
  // (which may be on another branch: the fix still starts at the PR head, threads.js fixStart), the branch's repo, else
  // the review's checkout of the PR head.
  fixBase() { return this.prSel?.cwd ?? (this.prSel?.space ? this.root : null) ?? this.worktree?.path ?? null; },
  // A job's state for its rows: running (with its agent's status), ready (a fixed report with a commit), main.
  fixView(job) {
    const commit = job && TH.fixCommit(job, this.replies, this.find.reports);
    // agents() has only terminals shown in a pane; a sub-agent runs in the background, so terminals() (hc ls) too.
    const agent = job?.terminal ? agents().find((a) => a.address === job.terminal) ?? terminals().find((x) => x.address === job.terminal && x.state === "live") : null;
    const status = agent?.status === "blocked" ? "waits for your OK" : agent?.status;
    return job ? { job, commit, status: status ?? (job.target === "main" ? "main agent" : "ended") } : null;
  },
  // Comments by id: the pending ones, the sent threads, and other people's GitHub comments ("gh<id>", threads.js
  // ghComment; one already sent to a fix is its thread).
  commentsById(ids) {
    if (!ids.length) return [];
    const all = [...TH.withIds(this.comments), ...this.threads(), ...(ids.some((id) => String(id).startsWith("gh")) ? this.gh.filter((g) => !g.in_reply_to_id).map(TH.ghComment) : [])];
    return ids.map((id) => all.find((c) => c.id === id)).filter(Boolean);
  },
  // What a fix of these comments needs for its preview and after it was sent (fixComments, fixTogether).
  commentFix(ids) {
    const comments = this.commentsById(ids), said = (c) => `${c.by ? `@${c.by} on GitHub · ` : ""}${c.file} ${uiLine(c)}: ${c.text}`;
    // foreign: one of them is a GitHub comment by someone else (threads.js foreignComment): its fix never runs
    // unattended and never in the PR's own session, whatever the PR's trust (previewFix, startSubFix, mainOffered).
    return { comments, items: comments.map((c) => ({ kind: "comment", id: c.id })), labels: comments.map(said), foreign: TH.hasForeign(comments, shared("gh.login")),
      prompt: (sub, lang = this.lang()) => TH.fixCommentsPrompt({ pr: this.pr, comments, file: this.repliesFile(), lang, login: shared("gh.login"), ...sub }),
      sent: (cx, how) => {
        const key = this.threadKey(), pending = TH.withIds(this.comments).filter((c) => ids.includes(c.id)), had = new Set(this.threads().map((t) => t.id));
        if (pending.length) { this.comments = TH.withIds(this.comments).filter((c) => !ids.includes(c.id)); this.persist(cx); }
        // A GitHub comment sent to a fix becomes a thread here: its fix, the agent's answer and Apply to PR show at
        // it. Nothing is written to GitHub for it, now or after a verification; its thread there stays as it is.
        this.updateThreads(cx, (d) => TH.addThreads(d, key, [...pending, ...comments.filter((c) => c.from === "github" && !had.has(c.id))], how));
        this.clearSel(cx);
      } };
  },
  fixComments(ids, cx) {
    const f = this.commentFix(ids), n = f.comments.length;
    if (!n) return;
    this.previewFix(cx, { what: "Fix with agent", ownLabel: `${f.comments.some((c) => c.from === "github") ? "" : "YOUR "}COMMENT${n === 1 ? "" : "S"}`, own: f.labels.join("\n\n"), items: f.items, prompt: (sub) => f.prompt(sub), labels: f.labels, sent: f.sent, foreign: f.foreign });
  },
  // The preview with the target choice; prompt(sub) gives the text for a sub-agent (sub: {branch, path, head}: its
  // worktree and the PR head it starts from) or, with null, for the main agent.
  previewFix(cx, { what, own, ownLabel, items, labels, prompt, sent, pool = null, alone = 0, target = null, foreign = false }) {
    const ids = items.map((x) => x.id), branch = TH.fixBranch(this.prSel?.number, ids), repo = this.prSel?.repo, base = this.fixBase();
    cx.spawn(async (cx) => {
      const path = TH.fixPath(await this.wtDir(), repo, branch);
      const at = base ? (await exec("git", ["-C", base, "rev-parse", "HEAD"], { timeout: 20000 }).catch(() => null))?.stdout?.trim() || null : null;
      const head = TH.fixStart({ local: Boolean(this.worktree?.local), prHead: this.headNow(), checkoutHead: at });
      const { label } = this.sendAgent(), sub = { branch, path, head };
      this.previewSend(cx, { what, own, ownLabel, prompt: prompt(sub), onSent: (cx) => {
        const job = { id: `${Date.now().toString(36)}`, items, target: "main", at: Date.now(), state: "running" };
        this.updateThreads(cx, (d) => TH.addFix(d, this.threadKey(), job));
        sent(cx, { route: "agent", agent: label });
      } });
      this.sendP.fix = { target: "sub", ...sub, items, labels, prompt, sent, pool, alone, foreign };
      if (target) this.fixTarget(target);
    });
  },
  // "Main agent" is a choice only when the PR has a live agent session and the PR is trusted: someone else's PR is
  // fixed in a separate checkout, never in a session with its own rights. Nor is a task that holds someone else's
  // GitHub comment (sendP.fix.foreign): that session's permissions are its own, and the text is a stranger's.
  mainOffered() { return Boolean(this.sendAgent().agent) && this.trustedPr() && !this.sendP?.fix?.foreign; },
  // The target switch in the preview: the text follows (a sub-agent gets its worktree note).
  fixTarget(target) {
    const f = this.sendP?.fix;
    if (!f || f.target === target || (target === "main" && !this.mainOffered())) return;
    f.target = target;
    this.sendText.set_value(f.prompt(target === "sub" ? f : null));
  },
  // The push lock for an agent that works in a worktree of `base` (threads.js noPushEnv): every remote of the clone
  // gets a push URL no git can open, and git itself is asked where it would push now. A remote it would still push
  // to (a git before 2.46 cannot clear a remote's own pushurl) stops the start: no agent without the lock.
  async pushLock(base) {
    const names = ((await exec("git", ["-C", base, "remote"], { timeout: 20000 })).stdout ?? "").split("\n").filter(Boolean), lock = TH.noPushEnv(names);
    const asked = await exec(lock[0], [...lock.slice(1), ...TH.pushLockProbe(names)], { cwd: base, timeout: 20000 });
    const open = asked.code === 0 ? TH.pushLockOpen(asked.stdout, names) : ["?"];
    // The URLs themselves are not shown: a push URL may carry a token.
    if (open.length) throw new Error("git in this checkout could still push to a remote, so no agent starts. A remote's own push URL can be turned off from git 2.46 on; update git or remove the remote's pushurl.");
    return lock;
  },
  // A new Claude in a fresh worktree on the fix branch from the PR head the preview named (shown under the PR's agent
  // when one runs). Nothing is typed into another session: the fix stays on its branch until the reviewer applies it.
  startSubFix(p, text, cx) {
    const f = p.fix, base = this.fixBase(), key = this.threadKey(), trusted = this.trustedPr(); // trust of the PR the prompt is for
    if (!base) { this.note = "Not started: the PR has no local checkout to branch the fix from"; return cx.notify(); }
    this.sending = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const lock = await this.pushLock(base), { git, head } = await this.addWorktree(base, f);
        const id = Date.now().toString(36), { agent } = this.sendAgent();
        const r = await hc(TH.subAgentArgs({ parent: agent?.address ?? null, cwd: f.path, name: `fix-${id}`, env: this.ctxEnv(this.ctxId()), task: text, job: id, auto: trusted && !f.foreign, model: model(), lock })); // someone else's GitHub comment in the task: never auto mode
        if (r.code !== 0) { await git(["worktree", "remove", "--force", f.path]); await git(["branch", "-D", f.branch]); throw new Error((r.stderr || r.stdout).trim().slice(0, 200)); }
        const terminal = JSON.parse(r.stdout).address;
        this.updateThreads(cx, (d) => TH.addFix(d, key, { id, branch: f.branch, path: f.path, base, head, items: f.items, terminal, target: "sub", at: Date.now(), state: "running" }));
        f.sent(cx, { route: "agent", agent: `Fix sub-agent · ${f.branch}` });
        this.note = `Fix started: a sub-agent works on ${f.branch} in its own worktree. Its fix stays there until you apply it.`;
      } catch (e) { this.note = `Not started: ${String(e).replace(/^Error: /, "")}`; }
      finally { this.sending = false; cx.notify(); }
    });
  },
  // A finding's buttons in the Findings tab, by where it stands. At most one is lit, the next step: "Add to review" on
  // an unresolved finding, "Go to fix" while the agent works or after a failed check, "Apply to PR" once the fix is
  // verified on its branch (before that the section's "Verify fixes" is the lit one). What ends something (Discard
  // fix, Dismiss finding) comes last and stays quiet. A settled finding only reopens.
  findingActions(x, settled, t) {
    if (settled) return [pill(`rv-fro-${x.id}`, t, "Reopen", (_e, cx) => this.setFinding(x, "open", cx)).tooltip("Make this finding unresolved again")];
    const fv = this.fixView(this.fixOf(x.id)), v = this.find.status[x.id]?.verify, lit = t.foreground;
    const add = (on) => pill(`rv-fcm-${x.id}`, t, "Add to review", (_e, cx) => this.findingComment(x, cx), false, on ? lit : undefined).tooltip("Add this finding to your pending review comments; nothing is posted until you finish the review");
    const ask = pill(`rv-fdi-${x.id}`, t, "Ask an agent…", (_e, cx) => this.discuss(x, cx)).tooltip("Ask an agent about this finding: a preview first says what starts and what it may do");
    const refuted = x.proof?.result === "refuted";
    const dismiss = pill(`rv-fdm-${x.id}`, t, "Dismiss finding", (_e, cx) => this.dismiss(x, cx), false, refuted ? lit : undefined).tooltip(refuted ? `An agent refuted this finding: ${x.proof.reason || "see Evidence"}. Dismiss it if you agree; nothing happens by itself.` : `Dismiss this finding${x.sources.length > 1 ? ` with all ${x.sources.length} of its sources` : ""}; it stays here under Dismissed`);
    // The same order as on the card in the diff: Add, Ask, Fix, Dismiss; Verify with an agent before Dismiss.
    if (!fv) return [add(!refuted), ask, pill(`rv-ffx-${x.id}`, t, "Fix with agent…", (_e, cx) => this.fix([x], cx)).tooltip("Have an agent fix this: a preview first says where it works, what it may do and that it never pushes"), this.verifyPill(x, t), dismiss];
    const sub = fv.job.target === "sub", ready = Boolean(fv.commit) && sub, checked = v?.branch ? v.result : null;
    return [badge(t, fv.commit ? `Fix ready on ${fv.job.branch ?? "the PR"}` : `Fixing · ${fv.status}`, fv.commit ? t.ansi2 : t.ansi3).id(`rv-ffb-${x.id}`).tooltip("The fix agent's progress on this finding"),
      ...(fv.job.terminal ? [pill(`rv-fgo-${x.id}`, t, "Go to fix", () => this.goFix(fv.job), false, !ready || checked === "not_fixed" ? lit : undefined).tooltip("Show the fix agent's terminal")] : []),
      ...(ready ? [pill(`rv-fap-${x.id}`, t, "Apply to PR", (_e, cx) => this.applyFix(fv.job, cx), false, checked === "fixed" ? t.ansi2 : undefined)
        .tooltip("Cherry-pick the fix commits onto the local checkout of the PR's branch; nothing is pushed")] : []),
      add(false), ask,
      ...(sub ? [pill(`rv-fdc-${x.id}`, t, "Discard fix", (_e, cx) => this.discardFix(fv.job, cx)).tooltip("Delete the fix's worktree and branch")] : []), dismiss];
  },
  goFix(job) { if (job?.terminal) run("terminal.peek", { terminal: job.terminal }); },
  // Apply to PR: the branch's commits cherry-picked onto
  // the PR's checkout, only when it is clean (else the main agent can do it, through the preview); then the worktree and
  // branch go. Nothing is pushed here.
  applyFix(job, cx) {
    const key = this.threadKey(), git = (args) => exec("git", ["-C", job.base, ...args], { timeout: 120000 });
    cx.spawn(async (cx) => {
      const plan = TH.applyPlan({ status: (await git(["status", "--porcelain"])).stdout, head: job.head, branch: job.branch,
        onHead: (await git(["merge-base", "--is-ancestor", job.head, "HEAD"])).code === 0, where: (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() });
      if (!plan.ok) {
        this.note = plan.off ? plan.reason : `${plan.reason} Hand the cherry-pick to the main agent instead (Hand over…).`; this.applyBlocked = plan.off ? null : job;
        return cx.notify();
      }
      const r = await git(plan.args);
      if (r.code !== 0) { await git(["cherry-pick", "--abort"]); this.note = `Not applied (conflict?): ${r.stderr.trim().slice(0, 200)}`; return cx.notify(); }
      await git(["worktree", "remove", "--force", job.path]); await git(["branch", "-D", job.branch]);
      if (job.terminal) run("terminal.kill", { terminal: job.terminal });
      this.updateThreads(cx, (d) => TH.setFix(d, key, job.id, { state: "applied", appliedAt: Date.now() }));
      this.applyBlocked = null; this.note = `Applied ${job.branch} to the PR's checkout (not pushed). Verify when you're ready.`;
      cx.notify();
    });
  },
  handOverApply(job, cx) {
    this.previewSend(cx, { what: "Apply fix", own: "", prompt: TH.applyPrompt(job), onSent: () => { this.applyBlocked = null; } });
  },
  discardFix(job, cx) {
    const key = this.threadKey(), git = (args) => exec("git", ["-C", job.base, ...args], { timeout: 60000 });
    cx.spawn(async (cx) => {
      if (job.terminal) run("terminal.kill", { terminal: job.terminal });
      if (job.path) { await git(["worktree", "remove", "--force", job.path]); await git(["branch", "-D", job.branch]); }
      this.updateThreads(cx, (d) => TH.setFix(d, key, job.id, { state: "discarded" }));
      this.note = `Discarded ${job.branch ?? "the fix"}`; cx.notify();
    });
  },

  // A commit an agent named: its diff on GitHub (a PR there), else a note.
  openCommit(sha) {
    const m = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(this.prSel?.url ?? "");
    if (m) openUrl(`https://github.com/${m[1]}/commit/${sha}`); else this.note = `Commit ${sha}: open it with git show ${sha}`;
  },

  // ---- comment cards (GitHub-like, compact): pending comments, sent threads and notes under their line. A card is up to
  // three rows of the list: its head (avatar, author, time, status, a ghost action and ⋯), its body (text and replies)
  // and, for a sent thread, a one-line Reply. Clicks are placed by x in each row (cardClick).

  cardItems(k, obj, loose = false) {
    const card = { t: "ch", k, obj, loose }, c = this.cardOf(card);
    if (c.folded) return [card];
    return [card, { t: "cb", k, obj, loose }, ...(k === "th" ? [{ t: "cr", k, obj }] : [])];
  },
  cardMax() { return Math.max(320, Math.min(CARD_W, (this.listW ?? 900) - GUTTER - 16)); },
  // A card is as wide as its text needs, 420 to 720 px (narrower only when the diff is).
  cardW(c) {
    if (c && c.src !== "notes") return Math.max(320, (this.listW ?? 900) - GUTTER - 16); // your own words: as wide as a finding's card
    const longest = c ? Math.max(String(c.text).split("\n").reduce((n, l) => Math.max(n, l.length), 0) * 7.4 + 28, ...c.replies.map((r) => r.text.length * 7 + 60), 300 + c.status[0].length * 6.5) : CARD_W;
    return Math.min(this.cardMax(), Math.max(CARD_MIN, Math.round(longest)));
  },
  // Lines a text takes in a card (UI font ≈ 7.4 px per char at 13.5 px).
  cardLines(text, w = this.cardMax()) { return Math.max(1, Math.ceil(String(text).length / Math.max(30, (w - 28) / 7.4))) + (String(text).match(/\n/g)?.length ?? 0); },
  cardByKey(key) {
    const [k, ...rest] = key.split(":"), id = rest.join(":");
    const obj = k === "c" ? TH.withIds(this.comments).find((c) => c.id === id) : k === "th" ? this.threads().find((x) => x.id === id) : this.pins().find((x) => x.id === id);
    return obj ? this.cardOf({ k, obj }) : null;
  },
  // What a card shows and offers: {key, src, author, time, status: [label, colour], text, replies, action: [label, fn] |
  // null, menu: [[label, danger, fn]], folded: one-line text | null, sel}.
  cardOf(it) {
    const o = it.obj, hm = (ms) => (Number.isFinite(ms) ? new Date(ms).toTimeString().slice(0, 5) : "");
    const where = (x) => `${x.file}:${x.start ?? x.end}${x.end !== x.start && x.start !== undefined ? `-${x.end}` : ""}`;
    if (it.k === "c") {
      const id = TH.commentId(o);
      return { key: `c:${id}`, id, src: o.from === "ki" ? "ai" : "mine", author: "You", time: hm(Number.parseInt(o.id, 36)), sel: true,
        status: [it.loose ? `Pending · ${uiLine(o)}, not shown` : o.from === "ki" ? "Pending · from an AI note" : "Pending", "ansi3"], text: o.text, replies: [], folded: null,
        action: ["Fix", (cx) => this.fixComments([id], cx)],
        menu: [["Edit", false, (cx) => this.openComposer(cx, o)], ["Fix…", false, (cx) => this.fixComments([id], cx)], ["Select", false, (cx) => this.toggleSel(id, cx)],
          ["Copy position", false, () => copyText(where(o))], ["Delete", true, (cx) => this.dropComment(o, cx)]] };
    }
    if (it.k === "th") {
      const v = this.threadOfView(o), fv = this.fixView(this.fixOf(o.id)), agent = o.agent?.split(" · ")[0] || "Agent";
      const status = fv?.commit ? ["Fix ready", "ansi2"] : fv ? [`Fixing · ${fv.status}`, "ansi3"] : v.status === "fixed" ? [`Reported fixed${v.fixedIn ? ` in ${v.fixedIn.slice(0, 7)}` : ""}`, "ansi2"]
        : v.status === "wontfix" ? ["Declined", "muted"] : v.status === "answered" || v.status === "question" ? ["Agent replied", "accent"]
        : o.route === "github" ? [o.dry ? "Dry run: not posted" : "Posted", "ansi4"] : ["Sent to agent", "ansi6"];
      const action = fv?.commit && fv.job.target === "sub" ? ["Apply to PR", (cx) => this.applyFix(fv.job, cx)] : fv ? ["Go to fix", () => this.goFix(fv.job)] : ["Fix", (cx) => this.fixComments([o.id], cx)];
      const by = o.by ? `${o.by} · GitHub` : "You"; // someone else's GitHub comment that was sent to a fix (commentFix)
      return { key: `th:${o.id}`, id: o.id, src: o.by ? "github" : "mine", author: by, time: hm(o.sentAt), sel: true, status, text: o.text, action,
        folded: v.collapsed ? `${by}: ${plain(o.text)} · ${status[0]}` : null,
        replies: v.entries.filter((e) => this.show().agents || e.who !== "agent").map((e) => ({ author: e.who === "you" ? "You" : e.who === "agent" ? agent : e.who, src: e.who === "you" ? "mine" : e.who === "agent" ? "agents" : "github",
          text: e.text, status: e.status ? [{ fixed: `Reported fixed${e.commit ? ` in ${String(e.commit).slice(0, 7)}` : ""}`, wontfix: "Declined", answered: "Answered", question: "Question" }[e.status] ?? e.status, THREAD_COLOR[e.status] ?? "muted"] : null })),
        menu: [["Reply", false, (cx) => this.startReply(o.id, cx)], ...(fv?.job.terminal ? [["Go to fix", false, () => this.goFix(fv.job)]] : []),
          ...(fv?.job.target === "sub" ? [["Discard fix", true, (cx) => this.discardFix(fv.job, cx)]] : []), ...(v.status === "fixed" || v.status === "wontfix" ? [[this.openThreads.has(o.id) ? "Fold" : "Unfold", false, () => { if (this.openThreads.has(o.id)) this.openThreads.delete(o.id); else this.openThreads.add(o.id); }]] : []),
          ["Select", false, (cx) => this.toggleSel(o.id, cx)], ...(o.url ? [["Open on GitHub", false, () => openUrl(o.url)]] : []), ["Copy position", false, () => copyText(where(o))]] };
    }
    const open = this.openNotes?.has(o.id);
    return { key: `pin:${o.id}`, id: o.id, src: "notes", author: "Note · private", time: hm(o.at), sel: false, status: [o.q ? `on: ${o.q}` : "Ask answer", "muted"], text: open ? o.text : o.summary,
      replies: [], folded: null, action: ["To comment", (cx) => this.noteToComment(o, cx)],
      menu: [[open ? "Show less" : "Show the whole answer", false, () => { this.openNotes ??= new Set(); if (open) this.openNotes.delete(o.id); else this.openNotes.add(o.id); }],
        ["Turn into comment", false, (cx) => this.noteToComment(o, cx)], ["Copy position", false, () => copyText(where(o.anchor))], ["Unpin", true, (cx) => this.unpin(o.id, cx)]] };
  },
  startReply(id, cx) { this.replyTo = id; this.replyIn.set_value(""); cx.timer.after(0, () => this.replyIn.focus()); },
  // Header geometry (x from the list's left edge): the box, the ghost action, ⋯.
  cardZones(c) {
    const right = GUTTER + this.cardW(c), aw = c.action ? Math.round(c.action[0].length * 7.2 + 30) : 0;
    return { box: [GUTTER + 6, GUTTER + 26], menu: [right - 30, right - 6], action: [right - 34 - aw, right - 34] };
  },
  cardClick(it, x, cx) {
    const c = this.cardOf(it), z = this.cardZones(c), inz = ([a, b]) => x >= a && x < b;
    if (it.t === "ch" && c.folded) { this.openThreads.add(c.id); return; }
    if (it.t === "ch" && c.sel && inz(z.box)) return this.toggleSel(c.id, cx);
    if (it.t === "ch" && inz(z.menu)) {
      openOverlay({ mod: "pr-review", props: { part: "cmenu", key: c.key, items: c.menu.map(([label, danger]) => [label, danger]) }, kind: "popup", width: 210, height: 12 + 30 * c.menu.length });
      return;
    }
    if (it.t === "ch" && c.action && inz(z.action)) return c.action[1](cx);
    if (it.t === "cr") return this.startReply(c.id, cx);
    if (it.k === "c") return this.openComposer(cx, it.obj);
    if (it.k === "pin") { this.openNotes ??= new Set(); if (this.openNotes.has(c.id)) this.openNotes.delete(c.id); else this.openNotes.add(c.id); }
  },
  cardRow(it, t) {
    const c = this.cardOf(it), W = this.cardW(c), col = c.src === "notes" ? t[SOURCE.notes] : t.foreground, selMode = this.selCount() > 0, sel = this.selected().includes(c.id);
    const avatar = (name, src, size = 18) => div().w(size).h(size).flex_none().rounded_full().flex().items_center().justify_center().bg((t[SOURCE[src]] ?? t.accent) + "33")
      .text_size(size * 0.58).font_semibold().text_color(t.foreground).child(String(name).replace(/^Note.*/, "N")[0]?.toUpperCase() ?? "?");
    const pillC = ([label, k]) => div().flex_none().px(6).h(18).flex().items_center().rounded(9).border_1().border_color(t[k] ?? t.muted).text_size(TYPE.small).text_color(t[k] ?? t.muted).child(label);
    // The card's surface: lighter than the diff, a 1 px border all round (the head, body and reply rows draw their parts
    // of it), rounded 8, the source's stripe on the left.
    const bg = c.src === "notes" ? t.ansi5 + "14" : t.raised, stripe = (e) => e.child(div().absolute().left(0).top(0).bottom(0).w(3).bg(col));
    const frame = (e) => e.relative().w(W).bg(bg).border_color(t.border).border_l(1).border_r(1);
    if (it.t === "ch" && c.folded) {
      return div().w_full().h(28 + 2 * CARD_GAP).pl(GUTTER).py(CARD_GAP).child(stripe(frame(h_flex()).id(`rv-cfold-${c.key}`).tooltip("Unfold this thread").h(28).pl(12).pr(10).gap(8).items_center().border_t(1).border_b(1).rounded(8).overflow_hidden().text_size(TYPE.small).cursor_pointer()
        .child(div().flex_none().text_color(t.muted).child("▸")).child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(c.folded))));
    }
    if (it.t === "ch") {
      const z = this.cardZones(c);
      return div().w_full().h(CARD_HEAD).pl(GUTTER).pt(CARD_GAP).child(stripe(frame(h_flex()).h(CARD_HEAD - CARD_GAP).pl(8).pr(6).gap(6).items_center().border_t(1).rounded_tl(8).rounded_tr(8).overflow_hidden().text_size(TYPE.small)
        .when(c.sel, (e) => e.child(div().id(`rv-cbox-${c.key}`).tooltip("Select to fix this comment with an agent").accessibility_label("Select comment").w(14).h(14).flex_none().rounded(3).border_1().border_color(sel ? t.accent : t.input).bg(sel ? t.accent : t.background)
          .flex().items_center().justify_center().text_size(TYPE.micro).text_color(t.accent_foreground).opacity(selMode ? 1 : 0).hover((s) => s.opacity(1)).child(sel ? "✓" : "")))
        .child(avatar(c.author, c.src)).child(div().flex_none().font_semibold().text_color(c.src === "notes" ? t.ansi5 : t.foreground).child(c.author))
        .child(div().flex_none().text_color(t.muted).child(c.time)).child(pillC(c.status).id(`rv-chs-${c.key}`).tooltip(`Where this comment stands: ${c.status[0]}`))
        .when(this.staleNow().has(c.id), (e) => e.child(pillC(["STALE", "ansi3"]).id(`rv-chst-${c.key}`).tooltip(STALE_TIP)))
        .child(div().flex_1())
        .when(Boolean(c.action), (e) => e.child(div().id(`rv-cha-${c.key}`).tooltip(c.action[0] === "Fix" ? "Fix this with an agent: a preview first; a sub-agent works on its own branch and never pushes" : c.action[0] === "Apply to PR" ? "Cherry-pick the fix onto the PR's checkout; nothing is pushed" : c.action[0] === "Go to fix" ? "Show the fix agent's terminal" : "Turn this note into a pending comment").accessibility_label(c.action[0]).w(z.action[1] - z.action[0]).h(22).flex_none().flex().items_center().justify_center().gap(4).rounded(5)
          .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).child(c.action[0] === "Fix" ? "✦ Fix" : c.action[0])))
        .child(div().id(`rv-chm-${c.key}`).tooltip("More actions for this comment").accessibility_label("More actions").w(24).h(22).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).child("⋯"))));
    }
    if (it.t === "cr") {
      return div().w_full().h(CARD_REPLY + CARD_GAP).pl(GUTTER).pb(CARD_GAP).child(stripe(frame(h_flex()).h(CARD_REPLY).px(12).items_center().border_b(1).rounded_bl(8).rounded_br(8).overflow_hidden()
        .child(div().id(`rv-crr0-${c.key}`).tooltip("Reply in this thread; a preview comes before anything is sent").flex_1().h(24).px(8).flex().items_center().rounded(5).border_1().border_color(t.border).bg(t.background).text_size(TYPE.small).text_color(t.muted).cursor_text().child("Reply…"))));
    }
    const reply = (r, k) => v_flex().id(`rv-crp-${c.key}-${k}`).ml(22).gap(1).pt(4)
      .child(h_flex().h(20).gap(6).items_center().text_size(TYPE.small).child(avatar(r.author, r.src, 16)).child(div().font_semibold().child(r.author)).when(Boolean(r.status), (e) => e.child(pillC(r.status).id(`rv-crps-${c.key}-${k}`).tooltip(`What the reply reported: ${r.status[0]}`))))
      .child(div().pl(22).max_w(FIND_TEXT - 22).text_size(TYPE.small).line_height(1.5).text_color(t.foreground).child(TextView.markdown(`rv-crm-${c.key}-${k}`, String(r.text ?? ""))));
    const last = it.k !== "th";
    return div().w_full().h(this.sizeOf(it)).pl(GUTTER).when(last, (e) => e.pb(CARD_GAP)).child(stripe(frame(v_flex()).h_full().px(12).pt(2).pb(8).overflow_hidden()
      .when(last, (e) => e.border_b(1).rounded_bl(8).rounded_br(8)).text_size(TYPE.body)
      .child(div().max_w(FIND_TEXT).line_height(1.48).text_color(t.foreground).child(TextView.markdown(`rv-cbm-${c.key}`, String(c.text ?? ""))))
      .children(c.replies.map(reply))));
  },

  // ---- the inline composer (a row of the diff list under the selection; edit: in place of that comment)

  openComposer(cx, edit = null, scroll = false) {
    if (edit) {
      const side = edit.old ? "-" : "+";
      this.editing = edit; this.fsel = { path: edit.file, a: `${side}${edit.start ?? edit.end}`, b: `${side}${edit.end}` };
      this.draft.set_value(edit.text);
    } else {
      this.ensureSel();
      if (!this.fsel) { this.note = "Select a line first (click its number; shift-click: a range)"; return cx.notify(); }
      if (this.editing) { this.editing = null; this.draft.set_value(""); }
    }
    this.composing = true; this.note = null; this.scrollCompose = scroll;
    cx.timer.after(0, (cx) => { this.draft.focus(); cx.notify(); }); // its row exists once the list drew it
    cx.notify();
  },

  closeComposer(cx) {
    this.composing = false; this.editing = null; this.composeMore = false; this.draft.set_value(""); this.fh.focus(); cx.notify();
  },

  // The composer's buttons, left to right: x from the list's left edge (clicks are placed by x, see onItem). The main
  // button adds to the pending review. Posting this one comment to GitHub at once is public and cannot be taken back,
  // so it waits behind the ▾ beside the main button (composeMore) instead of sitting next to it.
  composeButtons() {
    const now = this.routeNow() === "github" ? [["▾", 28, "toggleComposeMore"], ...(this.composeMore ? [["Post now to GitHub", 160, "singleComment"]] : [])] : [["Send to agent…", 160, "singleComment"]];
    const list = this.editing ? [["Suggestion", 104, "insertSuggestion"], ["Cancel", 80, "closeComposer"], ["Update comment", 140, "addDraft", true]]
      : [["Suggestion", 104, "insertSuggestion"], ["Cancel", 80, "closeComposer"], [this.comments.length ? "Add review comment" : "Start a review", 160, "addDraft", true], ...now];
    let x = GUTTER + 16; // the card's 4 px border and 12 px padding
    return list.map(([label, w, act, primary], i) => { const b = { label, w, act, primary, x: x + (i === 1 ? 24 : 0) }; x = b.x + w + (list[i + 1]?.[2] === "toggleComposeMore" ? 2 : BTN_GAP); return b; });
  },
  toggleComposeMore() { this.composeMore = !this.composeMore; },

  // A ```suggestion block with the selected lines, for GitHub's "Commit suggestion".
  insertSuggestion() {
    const f = this.fsel, rows = f && this.rowsFor(f.path), range = rows && rangeOf(rows, f.a, f.b);
    if (!range) return;
    const cur = this.draft.value();
    this.draft.set_value(`${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${suggestionBlock(rows.slice(range[0], range[1] + 1))}`);
    this.draft.focus();
  },

  // The composer's comment: its text with the selection as anchor (file, lines, side, quoted code); null when empty.
  draftComment() {
    const text = this.draft.value().trim(), anchor = this.selAnchor();
    if (!text) return null;
    if (!anchor) { this.note = "Select a line first (click its number; shift-click: a range)"; return null; }
    return { id: Date.now().toString(36), file: this.fsel.path, ...anchor, head: this.head, text };
  },

  // "Start a review" / "Add review comment" / "Update comment" (⌘↩): into the pending review.
  addDraft(cx) {
    if (this.editing) {
      const text = this.draft.value().trim();
      if (!text) return;
      this.comments = this.comments.map((c) => (c.id === this.editing.id ? { ...c, text } : c));
    } else {
      const c = this.draftComment();
      if (!c) return cx.notify();
      this.comments = [...this.comments, c];
    }
    this.fsel = null; this.closeComposer(cx); this.persist(cx);
  },

  // "Post now to GitHub" / "Send to agent…": this one comment alone, now. GitHub: one review comment at once; agent: the
  // preview first. Either way it then stays under its line as a thread; on failure it stays in the composer.
  singleComment(cx) {
    const c = this.draftComment(), key = this.threadKey();
    if (!c) return cx.notify();
    const done = (cx, how) => { this.updateThreads(cx, (d) => TH.addThreads(d, key, [c], how)); this.fsel = null; this.closeComposer(cx); };
    if (this.routeNow() === "github") { setShared("review.hintPostNow", true); return this.postSingleGh(c, cx, done); }
    const { label } = this.sendAgent();
    this.previewSend(cx, { what: "Comment", own: c.text, prompt: buildReview({ pr: this.pr, base: this.base, comments: [c], lang: this.lang(), replies: this.repliesFile(), contract: TH.repliesContract }),
      onSent: (cx) => done(cx, { route: "agent", agent: label }) });
  },

  // One line comment on GitHub now (POST pulls/{n}/comments), as the PR's context; dry run: the payload into a file.
  postSingleGh(c, cx, done) {
    const pr = this.prSel, m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(pr?.url ?? "");
    if (!m || this.sending) return;
    const payload = TH.singlePayload(c, this.head, inDiff(this.diffLines ?? new Map(), c));
    if (!payload) { this.note = "Not posted: GitHub takes line comments only on lines of the PR diff. Use Start a review: it goes into the review body."; return cx.notify(); }
    this.sending = true; this.note = null;
    const env = this.ctxEnv(this.ctxId()), sh = (script, ...args) => exec(env[0] ?? "sh", [...env.slice(1), ...(env.length ? ["sh"] : []), "-c", script, ...args], { timeout: 60000 });
    cx.spawn(async (cx) => {
      try {
        if (this.cfg?.dryRun) {
          const file = `${appHome()}/pr-data/review-dry-run.json`, before = await readTextFile(file).catch(() => null);
          await writeTextFile(file, JSON.stringify({ endpoint: `repos/${m[1]}/pulls/${m[2]}/comments`, payload }, null, 1), before);
          this.note = `Dry run: nothing posted, the payload is in ${file.replace(home(), "~")}`;
          return done(cx, { route: "github", dry: true });
        }
        const r = await sh('printf %s "$1" | gh api -X POST "$0" --input -', `repos/${m[1]}/pulls/${m[2]}/comments`, JSON.stringify(payload));
        if (r.code !== 0) { let msg = (r.stderr || "").trim(); try { msg = JSON.parse(r.stdout).message ?? msg; } catch { /* not JSON */ } throw new Error(msg || "gh api failed"); }
        const j = JSON.parse(r.stdout);
        this.note = `Posted to GitHub: ${j.html_url ?? pr.url}`;
        done(cx, { route: "github", gh: { [c.id]: { ghId: j.id, url: j.html_url } } });
        this.loadGhComments(cx);
      } catch (e) { this.note = `Not posted: ${String(e).replace(/^Error: /, "")}`; } // the composer keeps the draft
      finally { this.sending = false; cx.notify(); }
    });
    cx.notify();
  },

  // ---- where reviews go: GitHub (any PR there) or the PR's agent session (a PR made in a session; branch diffs)

  routes() {
    const gh = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(this.prSel?.url ?? "");
    return [...(gh ? ["github"] : []), ...(this.prSel?.session || !gh ? ["agent"] : [])];
  },
  routeNow() {
    const all = this.routes();
    return all.includes(this.route) ? this.route : all.includes("agent") && this.prSel?.session ? "agent" : all[0];
  },

  // Submit review (the popover): every pending comment, the verdict and the summary, in one go.
  // GitHub: exactly the ticked items (threads.js ghPlan); agent: every pending comment, through the preview. What went
  // out stays as threads.
  submitReview(cx) {
    const gh = this.routeNow() === "github", key = this.threadKey(), summary = this.summary.value();
    const sent = gh ? this.ghPlanNow().picked : TH.withIds(this.comments);
    const done = (cx, how) => {
      const ids = new Set(sent.map((c) => c.id));
      this.comments = TH.withIds(this.comments).filter((c) => !ids.has(c.id)); this.summary.set_value(""); this.event = null; this.off = new Set(); this.summaryOn = true;
      this.updateThreads(cx, (d) => TH.addThreads(d, key, sent, how));
      this.persist(cx); this.registerReview(cx, { status: "sent", sentAt: Date.now() });
    };
    const event = this.verdict();
    if (!event) { this.note = "Not sent: choose Comment, Approve or Request changes first"; return cx.notify(); }
    if (gh) return this.postGh(sent, event, this.summaryOn ? summary : "", cx, done);
    if (!sent.length) { this.note = "Nothing to send: add a comment first"; return cx.notify(); }
    const { label } = this.sendAgent();
    this.previewSend(cx, { what: "Review", own: [summary.trim(), ...sent.map((c) => `${c.file} ${uiLine(c)}: ${c.text}`)].filter(Boolean).join("\n\n"),
      prompt: buildReview({ pr: this.pr, base: this.base, comments: sent, lang: this.lang(), event, summary, replies: this.repliesFile(), contract: TH.repliesContract }),
      onSent: (cx) => done(cx, { route: "agent", agent: label }) });
  },
  // The gh login that posts for this PR's context (its env picks the account), asked once per context.
  loadGhLogin(cx) {
    const id = this.ctxId();
    if (this.ghLogin?.[id] !== undefined) return;
    this.ghLogin = { ...this.ghLogin, [id]: null };
    const argv = [...this.ctxEnv(id), "gh", "api", "user", "--jq", ".login"];
    cx.spawn(async (cx) => {
      const r = await exec(argv[0], argv.slice(1), { timeout: 20000 }).catch(() => null);
      if (r?.code === 0 && r.stdout.trim()) { this.ghLogin = { ...this.ghLogin, [id]: r.stdout.trim() }; cx.notify(); }
    });
  },
  ghPlanNow() {
    const repo = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(this.prSel?.url ?? "");
    return TH.ghPlan({ comments: this.comments, off: this.off, summary: this.summary.value(), summaryOn: this.summaryOn, event: this.verdict(), commit: this.head,
      lines: this.diffLines ?? new Map(), repo: repo ? `${repo[1]}#${repo[2]}` : null, login: this.ghLogin?.[this.ctxId()] ?? null });
  },

  // One GitHub review with these comments (pr.js ghReview), JSON on stdin, as the PR's context (its gh account).
  // Config "dryRun": true writes the payload to pr-data/review-dry-run.json instead of posting.
  postGh(comments, event, summary, cx, done) {
    const pr = this.prSel, m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(pr?.url ?? "");
    if (!m || this.sending) return;
    this.sending = true; this.note = null; this.posted = null;
    const env = this.ctxEnv(this.ctxId()), sh = (script, ...args) => exec(env[0] ?? "sh", [...env.slice(1), ...(env.length ? ["sh"] : []), "-c", script, ...args], { timeout: 60000 });
    cx.spawn(async (cx) => {
      try {
        if (!this.head) {
          const v = await sh('gh pr view "$0" --json headRefOid --jq .headRefOid', pr.url);
          if (v.code !== 0 || !v.stdout.trim()) throw new Error("PR head unknown");
          this.head = v.stdout.trim();
        }
        const { payload, outside } = ghReview({ comments, event, summary, commit: this.head, lines: this.diffLines ?? new Map() });
        if (!payload.comments.length && !payload.body && payload.event !== "APPROVE") throw new Error("Nothing to post: add a comment or a summary");
        if (this.cfg?.dryRun) {
          const file = `${appHome()}/pr-data/review-dry-run.json`, before = await readTextFile(file).catch(() => null);
          await writeTextFile(file, JSON.stringify({ endpoint: `repos/${m[1]}/pulls/${m[2]}/reviews`, payload }, null, 1), before);
          this.posted = { dry: file, outside: outside.length, items: TH.postedItems(payload) };
          this.note = `Dry run: nothing posted, the payload is in ${file.replace(home(), "~")}`;
          return done(cx, { route: "github", dry: true });
        }
        const r = await sh('printf %s "$1" | gh api -X POST "$0" --input -', `repos/${m[1]}/pulls/${m[2]}/reviews`, JSON.stringify(payload));
        if (r.code !== 0) {
          let msg = (r.stderr || "").trim();
          try { const j = JSON.parse(r.stdout); msg = [j.message, ...(j.errors ?? []).map((e) => (typeof e === "string" ? e : e.message ?? JSON.stringify(e)))].filter(Boolean).join(": "); } catch { /* not JSON */ }
          const where = payload.comments.map((c) => `${c.path}:${c.start_line ? `${c.start_line}–` : ""}${c.line}`).join(", ");
          throw new Error(`${msg || "gh api failed"}${/diff|line|position/i.test(msg) && where ? ` (line comments: ${where})` : ""}`);
        }
        const review = JSON.parse(r.stdout), url = review.html_url ?? pr.url;
        // The posted line comments' ids (by path, line and text), so their GitHub replies land in their threads.
        const mine = review.id ? await sh('gh api "$0" --jq ".[] | {id, path, line, body, url: .html_url}"', `repos/${m[1]}/pulls/${m[2]}/reviews/${review.id}/comments`).catch(() => null) : null;
        const got = (mine?.stdout ?? "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean), map = {};
        for (const c of TH.withIds(comments)) { const g = got.find((x) => x.path === c.file && x.line === c.end && x.body === c.text.trim()); if (g) map[c.id] = { ghId: g.id, url: g.url }; }
        this.posted = { url, items: TH.postedItems(payload) }; this.note = `Review posted: ${url}`;
        done(cx, { route: "github", gh: map });
        this.loadGhComments(cx);
      } catch (e) { this.note = `Not posted: ${String(e).replace(/^Error: /, "")}`; }
      finally { this.sending = false; cx.notify(); }
    });
    cx.notify();
  },

  // GitHub's review comments on this PR, under their lines (read only). Outdated ones (no line now, GitHub's "Outdated")
  // stay and show like other comments whose line is gone. One GraphQL call adds each thread's resolved state; when it
  // fails the comments still show, just none as resolved.
  loadGhComments(cx) {
    const url = this.prSel?.url;
    cx.spawn(async (cx) => { const g = await this.ghComments(); if (g && this.prSel?.url === url) { this.gh = g; cx.notify(); } });
  },
  // The comments themselves: a list, false when gh failed, null when not asked (no GitHub PR, dry run). One fetch at a
  // time: an ask while one runs for this PR gets the same answer.
  ghComments() {
    const pr = this.prSel, m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(pr?.url ?? "");
    if (!m || this.cfg?.dryRun) return Promise.resolve(null); // dry run: no network (the demo)
    if (this.ghIn?.url === pr.url) return this.ghIn.p;
    const env = this.ctxEnv(this.ctxId()), [owner, name] = m[1].split("/");
    const rest = [...env, "gh", "api", "--paginate", `repos/${m[1]}/pulls/${m[2]}/comments?per_page=100`,
      "--jq", ".[] | {id, path, line, original_line, side, user: .user.login, user_type: .user.type, commit_id, original_commit_id, outdated: (.line == null and .subject_type != \"file\"), body, at: .created_at, in_reply_to_id, url: .html_url}"];
    const query = "query($owner: String!, $name: String!, $number: Int!, $endCursor: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { " +
      "reviewThreads(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { isResolved isOutdated comments(first: 1) { nodes { databaseId } } } } } } }";
    const graph = [...env, "gh", "api", "graphql", "--paginate", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${m[2]}`,
      "--jq", ".data.repository.pullRequest.reviewThreads.nodes[] | {id: .comments.nodes[0].databaseId, resolved: .isResolved, outdated: .isOutdated}"];
    const lines = (r) => (r?.code === 0 ? r.stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : null);
    const p = Promise.all([rest, graph].map((a) => exec(a[0], a.slice(1), { timeout: 30000 }).catch(() => null)))
      .then(([r, t]) => (r?.code === 0 ? TH.withThreadState(lines(r), lines(t) ?? []) : false))
      .finally(() => { if (this.ghIn?.p === p) this.ghIn = null; });
    this.ghIn = { url: pr.url, p };
    return p;
  },
  // GitHub's comments as the review shows them (threads.js ghShown), memoized: the Show switch's resolved and bots.
  ghNow() {
    const deps = [this.gh, this.showResolved, this.allBots];
    if (!this.ghOf || this.ghOf.deps.some((d, i) => d !== deps[i])) this.ghOf = { deps, ...TH.ghShown(this.gh, { resolved: this.showResolved, allBots: this.allBots }) };
    return this.ghOf;
  },

  onReviewKey(e, cx) {
    const route = keyRoute({ typing: this.typing, rootFocused: this.fh.is_focused(), key: e.key });
    if (route === "pass") return; // an input inside the review has the keyboard: its letters are text
    if (route === "blur") { this.fh.focus(); cx.notify(); return cx.stop_propagation(); }
    if (route === "typing") {
      if (this.typing === "draft" && e.keystroke === "cmd-enter") this.addDraft(cx);
      else if (e.key === "escape" && this.typing === "send") { this.sendP = null; this.fh.focus(); cx.notify(); }
      else if (e.key === "escape" && this.typing === "item") { this.editItem = null; this.fh.focus(); cx.notify(); }
      else if (e.key === "escape" && this.typing === "summary") { this.finishOpen = false; this.fh.focus(); cx.notify(); }
      else if (e.key === "escape") this.closeComposer(cx);
      else return;
      return cx.stop_propagation();
    }
    const k = e.keystroke;
    if (k === "j" || k === "k") {
      const d = k === "j" ? 1 : -1;
      if (this.tab === "steps") this.goStep(this.cur + d, cx); else this.goFile(d);
    }
    else if (k === "n" || k === "p") this.goHunk(k === "n" ? 1 : -1, cx);
    else if (k === "c") this.openComposer(cx, null, true);
    else if (k === "shift-/" || e.key === "?") this.command("keys", cx);
    else if (k === "a" || k === "x") { const s = this.openSugs().find((x) => x.key === this.sug); if (s) (k === "a" ? this.takeSug(s, cx) : this.dropSug(s, cx)); } // only the note that is open: its line says so
    else if (k === "s" || k === "f") this.tab = k === "s" ? "steps" : "files";
    else if (k === "escape") { if (this.mdPrev) this.mdPrev = null; else if (this.sendP) this.sendP = null; else if (this.replyTo) this.replyTo = null; else if (this.selCount()) this.clearSel(cx); else if (this.finishOpen) this.finishOpen = false; else if (this.composing) this.closeComposer(cx); else if (this.defFile) this.defFile = null; else if (this.defAt) this.defAt = null; else if (this.drawerState() === "open") this.setDrawer(null, cx); else if (this.archFocus || this.blastFocus || this.askHl) this.archFocus = this.blastFocus = this.askHl = null; else leave(); }
    else return;
    cx.stop_propagation(); cx.notify();
  },

  // The submit button. An approval while a finding of high severity is unresolved is asked about once: the first
  // click only says what is open, the second one submits.
  // The verdict in force (threads.js verdictOf): null while a high finding is unresolved and nothing is picked.
  verdict() { return TH.verdictOf(this.event, this.counts()); },
  submitClick(cx) {
    if (this.event === "approve" && this.counts().high > 0 && !this.approveAsk) { this.approveAsk = true; return cx.notify(); }
    this.approveAsk = false;
    this.submitReview(cx);
  },
  // "Insert blockers": the unresolved findings of high severity as the review's text, under what is written already.
  insertBlockers() {
    const draft = TH.blockersDraft(this.openFindings()), now = this.summary.value().trim();
    if (draft && !now.includes(draft)) this.summary.set_value([now, draft].filter(Boolean).join("\n\n"));
  },

  // ---- render: Finish your review (opened from the bar's button: the "finish" command)

  finishPopover(t) {
    const all = TH.withIds(this.comments), n = all.length, routes = this.routes(), route = this.routeNow(), gh = route === "github";
    const plan = gh ? this.ghPlanNow() : null, inline = new Set((plan?.picked ?? []).filter((c) => inDiff(this.diffLines ?? new Map(), c)).map((c) => c.id));
    const label = { comment: "Comment", approve: "Approve", request_changes: "Request changes" };
    // What the review found, next to what is about to go out: the findings suggest a verdict (threads.js
    // suggestVerdict) and never pick it; an approval over unresolved high findings is asked about once (submitClick).
    const fc = this.counts(), sug = TH.suggestVerdict(fc), ev = this.verdict(), risky = ev === "approve" && fc.high > 0;
    const radio = (k, what) => h_flex().id(`rv-ev-${k}`).gap(10).px(6).py(4).rounded(6).items_start().cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.event = k; this.approveAsk = false; cx.notify(); })
      .child(div().w(16).flex_none().text_color(ev === k ? t.accent : t.muted).child(ev === k ? "◉" : "○"))
      .child(v_flex().flex_1().min_w(0).child(h_flex().gap(8).items_center().child(div().font_semibold().child(label[k]))
        .when(sug?.event === k, (e) => e.child(div().id(`rv-ev-sug-${k}`).tooltip("A suggestion from the findings, which are a model's claims. The choice is yours.").text_size(TYPE.small).text_color(t.ansi3).child(`Suggested: ${sug.why}`))))
        .child(div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(what)));
    const tick = (id, on, click) => tickBox(t, on).id(id).tooltip("Tick to include this in what is posted, untick to leave it out").accessibility_label("Include in review").mt(1).cursor_pointer().on_click((_e, cx) => { click(); cx.notify(); });
    const origin = (c) => (c.from === "ki" ? "from an AI note" : c.from ? `from a finding (${REVIEWERS[c.from]?.[0] ?? c.from})` : null);
    // Each item that can go out, ticked or not; GitHub: the summary too, and Edit in place.
    const item = (c) => {
      const on = !gh || !this.off.has(c.id), editing = this.editItem === c.id;
      return h_flex().id(`rv-fi-${c.id}`).gap(8).items_start().p(6).rounded(6).bg(on ? t.surface : t.background)
        .when(gh, (e) => e.child(tick(`rv-fit-${c.id}`, on, () => { if (on) this.off.add(c.id); else this.off.delete(c.id); })))
        .child(v_flex().id(`rv-fir-${c.id}`).flex_1().min_w(0).gap(3).when(gh && !editing, (e) => e.cursor_pointer().on_click((_e, cx) => { if (on) this.off.add(c.id); else this.off.delete(c.id); cx.notify(); }))
          .child(h_flex().gap(6).items_center().text_size(TYPE.small)
            .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(on ? t.foreground : t.muted).child(`${c.file} ${uiLine(c)}`))
            .when(gh, (e) => e.child(div().flex_none().text_color(inline.has(c.id) || !on ? t.muted : t.ansi3).child(inDiff(this.diffLines ?? new Map(), c) ? "line comment" : "goes into the body")))
            .when(!editing, (e) => e.child(pill(`rv-fie-${c.id}`, t, "Edit", (_e, cx) => { this.editItem = c.id; this.itemEdit.set_value(c.text); cx.timer.after(0, () => this.itemEdit.focus()); cx.stop_propagation(); cx.notify(); }).tooltip("Edit the text before it is posted"))))
          .when(Boolean(origin(c)), (e) => e.child(div().text_size(TYPE.small).text_color(t.ansi5).child(origin(c))))
          .when(gh && on && Boolean(c.security), (e) => e.child(div().id(`rv-fi-pub-${c.id}`).text_size(TYPE.small).line_height(1.4).whitespace_normal().text_color(t.ansi1).child(PUBLIC_TIP)))
          .child(editing
            ? v_flex().gap(6).child(div().h(90).px(8).py(4).rounded(6).border_1().border_color(t.accent).bg(t.background).cursor_text().on_click(() => this.itemEdit.focus())
              .child(Textarea.new(this.itemEdit).size_full().text_size(TYPE.body).text_color(t.foreground)))
              .child(h_flex().gap(6).child(pill(`rv-fis-${c.id}`, t, "Save", (_e, cx) => { const text = this.itemEdit.value().trim(); if (text) { this.comments = all.map((x) => (x.id === c.id ? { ...x, text } : x)); this.persist(cx); } this.editItem = null; cx.notify(); }, false, t.foreground).tooltip("Keep the edited text"))
                .child(pill(`rv-fic-${c.id}`, t, "Cancel", (_e, cx) => { this.editItem = null; cx.notify(); }).tooltip("Discard the edit")))
            : div().text_size(TYPE.small).line_height(1.45).text_color(on ? t.foreground : t.muted).child(TextView.markdown(`rv-fim-${c.id}`, c.text))));
    };
    const summary = this.summary.value().trim(), repo = plan ? /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(this.prSel?.url ?? "") : null;
    const ready = !this.sending && Boolean(ev) && (gh ? plan.ready : n > 0);
    return v_flex().id("rv-finish").absolute().top(8).right(12).w(520).max_h(760).p(14).gap(10).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .text_size(TYPE.body).text_color(t.foreground).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().gap(8).items_center().child(div().font_semibold().text_size(TYPE.title).child("Finish your review"))
        .when(Boolean(this.cfg?.dryRun), (e) => e.child(badge(t, "Dry run", t.ansi3).id("rv-finish-dry").tooltip(DRY_TIP))).child(div().flex_1())
        .child(pill("rv-finish-x", t, "✕", (_e, cx) => { this.finishOpen = false; this.fh.focus(); cx.notify(); }).tooltip("Close without sending anything").accessibility_label("Close")))
      .when(routes.length > 1, (e) => e.child(h_flex().gap(6).items_center().child(div().text_size(TYPE.small).text_color(t.muted).child("Send to"))
        .child(pill("rv-route-github", t, "GitHub", (_e, cx) => { this.route = "github"; cx.notify(); }, route === "github").tooltip("Post these as one GitHub review"))
        .child(pill("rv-route-agent", t, "Agent session", (_e, cx) => { this.route = "agent"; cx.notify(); }, route === "agent").tooltip("Send these as a prompt to the PR's agent session instead"))))
      .child(div().text_size(TYPE.small).text_color(t.muted).child(gh ? `Target: ${repo ? `${repo[1]}#${repo[2]}` : "GitHub"} on GitHub` : `Target: ${this.sendAgent().label}`))
      .child(div().id("rv-summary").tooltip("The review's summary: posted as the review body").h(76).px(10).py(6).rounded(6).border_1().border_color(this.typing === "summary" ? t.accent : t.border).bg(t.background).cursor_text()
        .on_click(() => this.summary.focus()).child(Textarea.new(this.summary).size_full().text_size(TYPE.body).text_color(t.foreground)))
      .when(fc.unresolved > 0, (e) => e.child(h_flex().id("rv-finish-found").gap(8).items_center().text_size(TYPE.small)
        .child(div().flex_1().min_w(0).whitespace_normal().text_color(t.muted).child(`${fc.unresolved} unresolved ${fc.unresolved === 1 ? "finding is" : "findings are"} not part of this review${fc.high ? `, ${fc.high} of high severity` : ""}.`))
        .when(fc.high > 0, (x) => x.child(pill("rv-blockers", t, "Insert blockers", (_e, cx) => { this.insertBlockers(); cx.notify(); }).flex_none()
          .tooltip("Put the unresolved findings of high severity into the text above, to edit. A security finding goes in with its title only.")))
        .when(typeof this.copyState === "function", (x) => x.child(pill("rv-copy-state", t, "Copy review state", (_e, cx) => { this.copyState(); cx.notify(); }).flex_none()
          .tooltip("Copy the verdict, the task check and the findings by state as text for a colleague. Nothing is posted; security findings are in it with their title only.")))))
      .child(v_flex().gap(1)
        .child(radio("comment", "Submit general feedback without explicit approval."))
        .child(radio("approve", "Give your approval to merge these changes."))
        .child(radio("request_changes", "Submit feedback that must be addressed before merging.")))
      .when(risky, (e) => e.child(div().id("rv-approve-ask").p(8).rounded(6).bg(t.ansi1 + "1c").text_size(TYPE.small).line_height(1.45).whitespace_normal()
        .child(`${fc.high} unresolved ${fc.high === 1 ? "finding is" : "findings are"} of high severity${fc.security ? `, ${fc.security} about security` : ""}. An approval on GitHub says nothing about them.${this.approveAsk ? " Click the button again to approve anyway." : ""}`)))
      // Exactly what goes out: nothing else (AI suggestions, findings, the analysis) unless it was added as a comment.
      .child(div().text_size(TYPE.small).font_semibold().text_color(t.muted).child(gh ? "WHAT IS POSTED (only what is ticked)" : `WHAT IS SENT · ${n} ${n === 1 ? "comment" : "comments"}`))
      .child(div().flex_1().min_h(0).relative().max_h(250)
        .child(v_flex().id("rv-finish-items").gap(4).max_h(250).overflow_y_scroll()
          .when(gh && Boolean(summary), (e) => e.child(h_flex().id("rv-fi-summary").gap(8).items_start().p(6).rounded(6).bg(this.summaryOn ? t.surface : t.background)
            .child(tick("rv-fit-summary", this.summaryOn, () => { this.summaryOn = !this.summaryOn; }))
            .child(v_flex().id("rv-fir-summary").flex_1().min_w(0).gap(2).cursor_pointer().on_click((_e, cx) => { this.summaryOn = !this.summaryOn; cx.notify(); })
              .child(div().text_size(TYPE.small).font_semibold().text_color(this.summaryOn ? t.foreground : t.muted).child("Review body (your text in the box above)"))
              .child(div().text_size(TYPE.small).whitespace_normal().text_color(this.summaryOn ? t.foreground : t.muted).child(summary.length > 160 ? `${summary.slice(0, 160)}… (${summary.split("\n").length} lines)` : summary)))))
          .children(all.map(item))
          .when(!n, (e) => e.child(div().p(6).text_size(TYPE.small).text_color(t.muted).child("No pending comments. AI notes and findings go out only after you add them as comments.")))))
      .when(Boolean(this.posted?.url || this.posted?.dry), (e) => e.child(v_flex().gap(2).p(8).rounded(6).bg(t.surface).text_size(TYPE.small)
        .child(h_flex().gap(8).items_center().text_color(this.posted.dry ? t.muted : t.ansi2)
          .child(div().flex_1().min_w(0).truncate().child(this.posted.dry ? "Dry run: this is what would have been posted" : `Posted: ${this.posted.url}`))
          .when(Boolean(this.posted.url), (x) => x.child(pill("rv-posted-open", t, "Show on GitHub", () => openUrl(this.posted.url)).tooltip("Show the posted review on GitHub"))))
        .children((this.posted.items ?? []).map((w) => div().truncate().text_color(t.muted).child(`· ${w}`)))))
      .when(Boolean(this.note) && /^(Not posted|Not sent|Dry run|Nothing)/.test(this.note ?? ""), (e) => e.child(div().text_size(TYPE.small).whitespace_normal()
        .text_color(/^Dry run/.test(this.note) ? t.muted : t.ansi1).child(this.note)))
      .when(gh, (e) => e.child(div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().text_right().child(plan.target)))
      .child(h_flex().gap(8).items_center()
        .when(n > 0 && !this.discardAsk, (e) => e.child(pill("rv-rdrop", t, `Discard ${n} pending ${n === 1 ? "comment" : "comments"}…`, (_e, cx) => { this.discardAsk = true; cx.notify(); }, false, t.ansi1).tooltip("Delete your pending comments on this PR; asks first")))
        .when(n > 0 && Boolean(this.discardAsk), (e) => e.child(div().text_size(TYPE.small).text_color(t.ansi1).child(`Delete ${n === 1 ? "this comment" : `these ${n} comments`} for good?`))
          .child(pill("rv-rdrop-yes", t, "Delete", (_e, cx) => { this.comments = []; this.discardAsk = false; this.persist(cx); cx.notify(); }, false, t.ansi1).tooltip("Delete them now; this cannot be undone"))
          .child(pill("rv-rdrop-no", t, "Keep", (_e, cx) => { this.discardAsk = false; cx.notify(); }).tooltip("Keep your pending comments")))
        .child(div().flex_1())
        .when(!this.discardAsk, (e) => e.child(div().id("rv-submit").tooltip(this.cfg?.dryRun && gh ? DRY_TIP : "Sends only what is listed above, to the target shown; nothing leaves before this click").px(14).h(32).flex().items_center().rounded(8).text_size(TYPE.body).font_semibold().bg(ready ? GH_GREEN : t.raised)
          .text_color(ready ? "#ffffff" : t.muted).when(ready, (e) => e.cursor_pointer())
          .on_click((_e, cx) => { if (ready) this.submitClick(cx); }).child(this.sending ? "Submitting…" : !ev ? "Choose a verdict first" : risky && this.approveAsk ? "Approve anyway" : gh ? plan.label : "Send to agent…"))));
  },

  // The preview before an agent starts or anything is typed into a session: what it is about (the finding or the
  // reviewer's words), who gets it (a fix: the choice between a sub-agent and the PR's agent, each with what separates
  // it from the PR), the facts (threads.js sendFacts: account, what it gets, what it may do, push, result, cost) and
  // the exact text, editable. Only the button at the bottom sends.
  sendPopover(t) {
    const p = this.sendP, fix = p.fix, sub = fix?.target === "sub", kind = fix ? fix.target : p.verify ? "verify" : p.ask?.kind ?? null, short = (x) => (x ? String(x).replace(home(), "~") : null);
    const live = this.sendAgent().agent, name = live ? p.agent.split(" · ")[0] : null;
    const facts = kind ? TH.sendFacts({ kind, account: accountOf(this.ctxId()), trusted: this.trustedPr(), foreign: Boolean(fix?.foreign), branch: fix?.branch ?? p.verify?.branch, name: p.ask?.name ?? name, chat: p.ask?.chat, where: short(p.ask?.where), model: modelLabel(model()), estimate: kind === "sub" ? fixEstimate(tierOf(model())) : null }) : [];
    const picking = Boolean(fix?.pool), n = fix?.items.length ?? 0, some = !picking || n > 0, ready = !this.sending && some, text = this.sendText.value();
    const go = this.sending ? "Sending…" : p.verify ? "Start verify agent" : sub ? (picking && n ? `Start fix agent for ${n} ${n === 1 ? "finding" : "findings"}` : "Start fix agent") : fix ? "Send to main agent"
      : p.ask ? { new: "Start agent", resume: "Resume its session", live: p.ask.chat ? "Draft in chat" : "Paste to agent" }[p.ask.kind] : "Send to agent";
    const head = (label) => div().text_size(TYPE.small).font_semibold().text_color(t.muted).child(label);
    const choice = (k, title, what) => h_flex().id(`rv-fix-${k}`).gap(10).px(6).py(4).rounded(6).items_start().cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.fixTarget(k); cx.notify(); })
      .child(div().w(16).flex_none().text_color(fix.target === k ? t.accent : t.muted).child(fix.target === k ? "◉" : "○"))
      .child(v_flex().flex_1().min_w(0).child(div().font_semibold().child(title)).child(div().text_size(TYPE.small).line_height(1.45).text_color(t.muted).whitespace_normal().child(what)));
    const picked = new Set((fix?.items ?? []).map((x) => x.id));
    return v_flex().id("rv-send").absolute().top(8).right(12).w(640).max_h_full().overflow_y_scroll().p(14).gap(10).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .text_size(TYPE.body).text_color(t.foreground).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().items_center().child(div().flex_1().font_semibold().text_size(TYPE.title).child(fix || p.ask || p.verify ? `${p.what}: preview` : `${p.what}: send to agent`))
        .child(pill("rv-send-x", t, "✕", (_e, cx) => { this.sendP = null; this.fh.focus(); cx.notify(); }).tooltip("Close the preview without sending").accessibility_label("Close")))
      // "Fix several…": the reviewer ticks what one agent fixes together; nothing is ticked for them.
      .when(picking, (e) => e.child(v_flex().gap(4).child(head(`FINDINGS · tick the ones one agent should fix together · ${n} of ${fix.pool.length} ticked`))
        .child(v_flex().id("rv-fix-pool").max_h(178).overflow_y_scroll().gap(1).children(fix.pool.map((f) => h_flex().id(`rv-fxp-${f.id}`).h(26).flex_none().px(6).gap(8).items_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.fixPick(f.id, cx)).child(tickBox(t, picked.has(f.id)))
          .child(div().w(52).flex_none().text_size(TYPE.small).text_color(t[SEV[f.severity]] ?? t.muted).child(f.severity)).child(div().flex_1().min_w(0).truncate().child(f.title))
          .child(div().flex_none().text_size(TYPE.small).text_color(t.muted).child(`${f.file.split("/").pop()}:${f.line}`)))))
        .when(fix.alone > 0, (x) => x.child(div().text_size(TYPE.small).line_height(1.45).text_color(t.muted).whitespace_normal()
          .child(`${fix.alone} security ${fix.alone === 1 ? "finding is" : "findings are"} not in this list. Each is fixed on its own, so that its change stays one commit to check.`)))))
      .when(Boolean(fix?.foreign || p.guard), (e) => e.child(div().id("rv-send-foreign").p(8).rounded(6).border_l(3).border_color(t.ansi3).bg(t.ansi3 + "14").text_size(TYPE.small).line_height(1.45).whitespace_normal()
        .child(p.guard ? `${TH.FOREIGN_NOTE} It does not go into a running session: a new agent tab gets it.` : TH.FOREIGN_NOTE)))
      .when(!picking && Boolean(p.own), (e) => e.child(v_flex().gap(4).child(head(p.ownLabel))
        .child(div().max_h(110).overflow_hidden().p(8).rounded(6).border_l(3).border_color(t.accent).bg(t.surface).text_size(TYPE.small).line_height(1.45).whitespace_normal().child(p.own))))
      .when(Boolean(fix) && some, (e) => e.child(v_flex().gap(1).child(head("WHO FIXES IT"))
        .child(choice("sub", "Sub-agent", `A new agent in a separate checkout, on the new branch ${fix.branch} from ${this.worktree?.local ? "this branch's head" : "the PR head"}${fix.head ? ` ${fix.head.slice(0, 7)}` : ""}. It works apart from the PR's checkout and hands its fix to nobody: nothing reaches the PR until you apply it.`))
        .when(this.mainOffered(), (x) => x.child(choice("main", "Main agent", `${name}, the PR's own agent session. It changes the PR's checkout directly, with its own permissions; nothing separates the fix from the PR.`)))
        .when(!this.mainOffered(), (x) => x.child(div().pl(32).text_size(TYPE.small).text_color(t.muted).whitespace_normal()
          .child(`The PR's own agent is not offered: ${this.trustedPr() ? "this PR has no live agent session" : "this is someone else's PR, so its code is only changed in a separate checkout"}.`)))))
      .when(!kind, (e) => e.child(h_flex().gap(6).items_center().text_size(TYPE.small).child(div().text_color(t.muted).child("To")).child(div().flex_1().min_w(0).whitespace_normal().font_semibold().child(p.agent))))
      .when(facts.length > 0 && some, (e) => e.child(v_flex().id("rv-send-facts").p(8).gap(3).rounded(6).border_1().border_color(t.border)
        .children(facts.map(([label, what]) => h_flex().gap(8).items_start().text_size(TYPE.small).line_height(1.45)
          .child(div().w(58).flex_none().text_color(t.muted).child(label)).child(div().flex_1().min_w(0).whitespace_normal().child(what))))))
      .when(some, (e) => e.child(head(`EXACT TEXT SENT · ${text.split("\n").length} lines, editable${text.length > 700 || text.split("\n").length > 11 ? " · longer than the box: scroll inside it to read the end" : ""}`))
        .child(div().id("rv-send-text").tooltip("The exact text the agent gets; you can edit it").px(10).py(6).rounded(6).border_1().border_color(this.typing === "send" ? t.accent : t.border).bg(t.background).cursor_text()
          .on_click(() => this.sendText.focus()).child(Textarea.new(this.sendText).w_full().text_size(TYPE.small).text_color(t.foreground))))
      .child(h_flex().gap(8).items_center().child(div().flex_1())
        .child(pill("rv-send-cancel", t, "Cancel", (_e, cx) => { this.sendP = null; this.fh.focus(); cx.notify(); }).tooltip("Close the preview without sending"))
        .child(div().id("rv-send-go").tooltip(picking && !n ? "Tick at least one finding first" : "The only click that sends or starts anything").px(14).h(32).flex().items_center().rounded(8).text_size(TYPE.body).font_semibold()
          .bg(ready ? t.solid : t.raised).text_color(ready ? t.solid_foreground : t.muted).when(ready, (x) => x.cursor_pointer())
          .on_click((_e, cx) => { if (ready) this.sendConfirmed(cx); }).child(go)));
  },

  // ---- the Comments tab and the Show switch (shared "review.show": per user, all on by default)

  show() { return TH.showOf(shared("review.show")); },
  toggleShow(k) { setShared("review.show", { ...this.show(), [k]: !this.show()[k] }); },
  // Every comment of the PR as rows (threads.js commentRows), memoized on what they come from.
  commentRowsNow() {
    const gh = this.ghNow().list, stale = this.staleNow(), deps = [this.comments, this.threadDoc, this.replies, gh, this.deep.pins, this.prSel?.url, stale];
    if (!this.rowsOf || this.rowsOf.deps.some((d, i) => d !== deps[i])) {
      // Your own posted threads keep all their GitHub replies; the rest is what the Show switch lets through.
      const own = this.ghOwn();
      this.rowsOf = { deps, rows: TH.commentRows({ pending: this.comments ?? [], threads: this.threads(), replies: this.replies, gh: [...this.gh.filter(own), ...gh.filter((g) => !own(g))],
        ghOwn: own, notes: this.pins(), stale: (id) => stale.has(id) }) };
    }
    return this.rowsOf.rows;
  },
  // Your comments and notes whose lines changed since you wrote them (pr.js isStale), by id; memoized, since the
  // cards ask on every render. Only ones that recorded their lines (new since this check) can be marked.
  staleNow() {
    const deps = [this.comments, this.threadDoc, this.deep.pins, this.fileHunks, this.head, this.prSel?.url];
    if (!this.staleOf || this.staleOf.deps.some((d, i) => d !== deps[i])) {
      const ids = new Set(), check = (id, a) => { if (a?.code != null && a.file && isStale(a, this.head, codeOf(this.rowsFor(a.file, true), a))) ids.add(id); };
      for (const c of TH.withIds(this.comments ?? [])) check(c.id, c);
      for (const th of this.threads()) check(th.id, th);
      for (const p of this.pins()) check(p.id, p.anchor);
      this.staleOf = { deps, ids };
    }
    return this.staleOf.ids;
  },
  showCountsNow() {
    const agents = Object.values(this.replies ?? {}).reduce((n, r) => n + r.length, 0);
    return TH.showCounts({ rows: this.commentRowsNow(), findings: this.counts().unresolved, agents });
  },
  // The one filter for what sits under the diff's lines and in the Comments list, as chips with counts (the bar only).
  // Findings carries the Findings tab's number, or says whether anything has looked for findings yet; a kind of
  // comment with nothing in it has no chip. Resolved GitHub threads (off by default) get a chip of their own while
  // there are any; older bot comments a muted line that shows them all.
  showChips(t, id) {
    const show = this.show(), counts = this.showCountsNow(), g = this.ghNow();
    const sw = (k, on, label, n, tip, click) => div().id(`${id}-${k}`).tooltip(tip).px(10).h(28).flex().items_center().gap(5).rounded(14).border_1().cursor_pointer().text_size(TYPE.small)
      .border_color(on ? t[SOURCE[k]] ?? t.accent : t.border).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { click(); cx.notify(); }).child(label).when(n !== null, (e) => e.child(div().text_color(t.muted).child(String(n ?? 0))));
    const looked = Boolean(this.ai) || Object.values(this.find.runs).some((r) => r.state === "done");
    const label = (k, l) => (k === "ai" && !this.findings().length ? (looked ? "Findings: none" : "Findings: not run") : l);
    return h_flex().flex_none().gap(6).items_center().child(div().text_size(TYPE.small).text_color(t.muted).child("In the diff:"))
      .children(TH.SHOW_KINDS.filter(([k]) => k === "ai" || counts[k] > 0).map(([k, l]) => sw(k, show[k], label(k, k === "mine" ? "Your comments" : l), k === "ai" && !this.findings().length ? null : counts[k], `${SHOW_TIP[k]}: click to hide or show them in the diff`, () => this.toggleShow(k))))
      .when(g.resolved > 0, (e) => e.child(sw("resolved", this.showResolved, "Resolved", g.resolved, "GitHub threads marked resolved: hidden by default, click to show or hide them", () => { this.showResolved = !this.showResolved; })))
      .when(g.botsHidden > 0, (e) => e.child(div().id(`${id}-bots`).tooltip(this.allBots ? "Show only each bot's comments on the commit it reviewed last" : "Bots comment again on every push: only each bot's comments on the commit it reviewed last show. Click to show them all")
        .flex_none().text_size(TYPE.small).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.allBots = !this.allBots; cx.notify(); })
        .child(this.allBots ? `Hide ${g.botsHidden} older bot comments` : `${g.botsHidden} older bot ${g.botsHidden === 1 ? "comment" : "comments"} hidden`)));
  },
  // A click on a row of the Comments tab (and the command crow:<id>): its whole text under it, its thread or note open
  // in the diff, and the diff at its line.
  openCommentRow(r, cx) {
    this.crow = r.id;
    if (r.kind === "thread") this.openThreads.add(r.id);
    if (r.kind === "note") (this.openNotes ??= new Set()).add(r.id);
    this.jumpTo(`${r.file}:${r.line}`, cx);
  },
  // A click on a file's heading in the Comments tab: the diff at that file's head, the tab stays.
  openCommentFile(file) { this.page = null; this.defFile = null; this.unfold(file); this.sinceOn = false; this.fileFocus = file; this.scrollTo("files", file); },
  commentsPane(t) {
    // No filters here: the bar's Show switch is the one filter, each row carries its state. A comment's states are
    // its own (the talk with the agent), not a finding's: "Fixed" is a finding's word, after a verification.
    const all = this.commentRowsNow(), rows = TH.filterRows(all, "all", this.show()), sel = new Set(this.selected());
    const STATE = { pending: ["Pending", "ansi3"], waiting: ["Sent to agent", "ansi6"], replied: ["Agent replied", "accent"], fixed: ["Reported fixed", "ansi2"], declined: ["Declined", "muted"], github: ["GitHub", "ansi4"], note: ["Note", "ansi5"] };
    const files = [...new Set(rows.map((r) => r.file))];
    return v_flex().flex_1().min_h(0)
      .child(v_flex().flex_none().px(14).py(10).gap(8).border_b(1).border_color(t.border)
        .child(div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(TH.commentSummary(all) || "No comments yet")))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("rv-comments-left").absolute().inset_0().overflow_y_scroll().p(8).gap(2)
          .when(!rows.length, (e) => e.child(div().p(6).text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(all.length ? "The Show switch in the bar hides these comments." : "Comments you write, send or post show here, with their replies.")))
          // A file's heading jumps to that file in the diff (its rows jump to their lines).
          .children(files.flatMap((file) => [div().id(`rv-cfile-${file}`).tooltip("Show this file in the diff").flex_none().pt(8).pb(2).px(6).text_size(TYPE.small).font_semibold().text_color(t.muted).truncate()
            .cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.openCommentFile(file); cx.notify(); }).child(file),
            ...rows.filter((r) => r.file === file).flatMap((r) => {
              const st = STATE[r.state], mine = r.kind !== "note"; // yours, a sent thread, someone's GitHub comment: all can go to a fix; a private note cannot
              // A row is one line; the one clicked last shows its whole text under it, as Markdown.
              const whole = this.crow === r.id ? [div().id(`rv-crw-${r.id}`).ml(68).mr(6).mb(6).px(10).py(6).rounded(6).bg(t.surface).text_size(TYPE.body).line_height(1.5).child(TextView.markdown(`rv-crwm-${r.id}`, r.src === "github" ? ghMd(r.text, true) : String(r.text ?? "")))] : [];
              // The box stands beside the part of the row that jumps to the comment, not inside it (as in the Findings tab).
              return [h_flex().id(`rv-crow-${r.id}`).flex_none().gap(8).items_center().px(6).h(30).rounded(6).hover((s) => s.bg(t.hover))
                .child(div().id(`rv-crb-${r.id}`).tooltip((mine ? "Select to fix this comment with an agent" : "A private note cannot be selected. Turn it into a comment first.")).accessibility_label("Select comment").w(14).h(14).flex_none().rounded(3).border_1().border_color(sel.has(r.id) ? t.accent : mine ? t.input : "#00000000").bg(sel.has(r.id) ? t.accent : "#00000000")
                  .flex().items_center().justify_center().text_size(TYPE.micro).text_color(t.accent_foreground).child(sel.has(r.id) ? "✓" : "")
                  .when(mine, (e) => e.cursor_pointer().on_click((_e, cx) => { this.toggleSel(r.id, cx); cx.stop_propagation(); })))
                .child(h_flex().id(`rv-cr-${r.id}`).tooltip("Jump to this comment in the diff").flex_1().min_w(0).h_full().gap(8).items_center().cursor_pointer()
                .on_click((_e, cx) => this.openCommentRow(r, cx))
                .child(div().w(40).flex_none().text_size(TYPE.small).text_color(t.muted).child(`${r.old ? "−" : ""}${r.line}`))
                .child(div().flex_1().min_w(0).truncate().text_size(TYPE.body).child(plain(r.text)))
                .when(r.replies > 0, (e) => e.child(div().id(`rv-crr-${r.id}`).tooltip(`${r.replies} replies in this thread`).flex_none().text_size(TYPE.small).text_color(t.muted).child(`↩ ${r.replies}`)))
                .when(Boolean(r.stale), (e) => e.child(badge(t, "STALE", t.ansi3).id(`rv-crst-${r.id}`).tooltip(STALE_TIP)))
                .when(Boolean(r.outdated), (e) => e.child(badge(t, "Outdated", t.muted).id(`rv-cro-${r.id}`).tooltip("GitHub marks this comment outdated: the code it was on changed since")))
                .when(Boolean(r.resolved), (e) => e.child(badge(t, "Resolved", t.ansi2).id(`rv-crv-${r.id}`).tooltip("This thread is resolved on GitHub")))
                .child(div().id(`rv-crs-${r.id}`).tooltip(STATE_TIP[r.state] ?? st[0]).flex_none().px(6).h(18).flex().items_center().rounded(9).border_1().border_color(t[st[1]] ?? t.muted).text_size(TYPE.small).text_color(t[st[1]] ?? t.muted).child(st[0]))), ...whole];
            })])))
        .child(Scrollbar.vertical("rv-comments-left").absolute().inset_0()));
  },

  // While comments are selected: a toolbar floating at the bottom centre of the diff (the list keeps room for it).
  selectionBar(t) {
    const n = this.selCount(), w = 340, left = Math.max(8, Math.round(((this.listW ?? 900) - w) / 2));
    return h_flex().id("rv-selbar").absolute().bottom(12).left(left).w(w).h(38).pl(14).pr(5).gap(10).items_center().rounded_full().bg(t.popover).border_1().border_color(t.border).shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(div().flex_none().text_size(TYPE.body).font_semibold().child(`${n} selected`))
      .child(div().w(1).h(18).flex_none().bg(t.border))
      .child(div().id("rv-selfix").tooltip("Fix everything selected, comments and findings, with one agent; a preview first. A sub-agent works on its own branch and never pushes").flex_none().px(14).h(28).flex().items_center().rounded_full().bg(t.accent).text_color(t.accent_foreground).text_size(TYPE.body).font_semibold().cursor_pointer()
        .on_click((_e, cx) => this.fixSelected(cx)).child(`✦ Fix selected (${n})`))
      .child(div().flex_1())
      .child(div().id("rv-selx").w(28).h(28).flex_none().flex().items_center().justify_center().rounded_full().text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Clear selection (Esc)").accessibility_label("Clear selection").on_click((_e, cx) => this.clearSel(cx)).child("✕"));
  },
  clearSel(cx) { const key = this.threadKey(); if (this.selected().length || TH.selectedOf(this.threadDoc, key, TH.FINDINGS).length) this.updateThreads(cx, (d) => TH.clearSelected(TH.clearSelected(d, key), key, Date.now(), TH.FINDINGS)); },

  // "Reply" in a thread: the follow-up's input under the diff (Enter: the preview).
  replyBar(t) {
    const th = this.threads().find((x) => x.id === this.replyTo);
    if (!th) return div();
    return h_flex().flex_none().px(14).py(8).gap(8).items_center().border_t(1).border_color(t.border).bg(t.surface)
      .child(div().flex_none().text_size(TYPE.small).text_color(t.muted).child(`Reply on ${th.file.split("/").pop()} ${uiLine(th)}`))
      .child(div().id("rv-reply-in").tooltip("Your follow-up in this thread; Enter opens a preview").flex_1().min_w(0).h(30).px(8).flex().items_center().rounded(6).border_1().border_color(t.accent).bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.replyIn).h_full().text_size(TYPE.body).text_color(t.foreground)))
      .child(pill("rv-reply-go", t, "Send to agent…", (_e, cx) => this.followup(cx), false, t.foreground).tooltip("Preview your follow-up; it goes to the agent only after you confirm"))
      .child(pill("rv-reply-x", t, "Cancel", (_e, cx) => { this.replyTo = null; cx.notify(); }).tooltip("Close the reply without sending"));
  },

  // ---- render: the bar

  // Row 1, the bar copy: back, the title (all the room left, cut only at its end, whole as tooltip), repo#n, state and
  // context; on the right only actions: Fix selected (while some are), Run review, Finish your review. The rest (risk,
  // effort, checks, model, values, help, ⋯) is row 2 at the top of the review (metaRow).
  renderBar() {
    if (shared("review.explore")) return this.renderExploreBar(shared("review.explore"));
    const t = theme(), pr = shared("review.target"), meta = shared("review.meta") ?? {};
    const pending = meta.url === pr?.url ? meta.pending ?? 0 : 0, selected = meta.url === pr?.url ? meta.selected ?? 0 : 0;
    const title = pr ? `#${pr.number} ${pr.title ?? ""}` : "Review";
    const runs = Object.values(shared("review.reviewers") ?? {}), openRuns = () => openOverlay({ mod: "pr-review", props: { part: "reviews" }, kind: "popup", ...reviewsPop() });
    const runLabel = runs.some((r) => r.busy) ? "Reviews running ⋯" : "Run review ▾";
    return h_flex().id("rv-bar").size_full().pl(84).pr(16).gap(12).items_center().bg(t.chrome).text_color(t.foreground).text_size(TYPE.body)
      .child(pill("rv-back", t, "← Back", () => leave()).tooltip("Leave the review and return to the previous layout (Esc)").flex_none())
      .when(Boolean(pr), (e) => e.child(pill("rv-min", t, "▁ Minimize", () => minimize()).flex_none()
        .tooltip("Go back to your chats and keep this review as one entry at the top; open it from there where you left it")))
      .child(div().id("rv-title").flex_1().min_w(0).truncate().font_semibold().text_size(TYPE.title).tooltip(title).child(title))
      // A stacked PR: "Stack: #1 → #2", this one in bold, a click on another opens its review (pr-review.stack:<url>).
      .when(Boolean(pr && meta.url === pr.url && meta.stack), (e) => e.child(h_flex().id("rv-bar-stack").flex_none().gap(4).items_center().text_size(TYPE.small).text_color(t.muted)
        .tooltip("PRs stacked on each other: each one's base is the branch of the one before it, so they merge in this order").child("Stack:")
        .children(meta.stack.flatMap((p, k) => [...(k ? [div().child("→")] : []), p.self ? div().font_semibold().text_color(t.foreground).child(`#${p.number}`)
          : div().id(`rv-bar-stack-${p.number}`).tooltip(`Open #${p.number}${p.title ? ` ${p.title}` : ""} in its own review`).text_color(t.accent).cursor_pointer().hover((s) => s.underline())
            .on_mouse_down("left", stop).on_click(() => run(`pr-review.stack:${p.url}`)).child(`#${p.number}`)]))))
      .when(Boolean(pr), (e) => e.child(div().id("rv-bar-repo").tooltip("Repository and PR number").flex_none().text_size(TYPE.small).text_color(t.muted).child(`${pr.repo ?? ""}#${pr.number ?? ""}`))
        .child(badge(t, `PR ${pr.state ?? "?"}`, t[{ open: "ansi2", draft: "dim", merged: "ansi5", closed: "ansi1" }[pr.state]] ?? t.dim).id("rv-bar-state").tooltip("The PR's state on GitHub"))
        .when(C.tagged(ctxDoc()), (e) => e.child(badge(t, C.labelOf(ctxDoc(), prCtx(pr)), C.colorOf(ctxDoc(), prCtx(pr), t)).id("rv-bar-ctx").tooltip("The context this PR belongs to"))))
      .when(selected > 0, (e) => e.child(div().id("rv-bar-fixsel").tooltip("Fix everything selected, comments and findings, with one agent; a preview first. A sub-agent works on its own branch and never pushes").flex_none().px(14).h(32).flex().items_center().rounded(7).bg(t.accent).text_color(t.accent_foreground)
        .text_size(TYPE.body).font_semibold().cursor_pointer().on_mouse_down("left", stop).on_click(() => run("pr-review.fix")).child(`✦ Fix selected (${selected})`)))
      // Until a reviewer ran, the deep review is the button to find: green, like Finish your review.
      .child(runs.some((r) => r.at || r.busy) ? pill("rv-reviews-btn", t, runLabel, openRuns).tooltip("Run Claude or security reviews of this PR, read-only; see each run's status").flex_none()
        : div().id("rv-reviews-btn").tooltip("Run Claude or security reviews of this PR, read-only; see each run's status").flex_none().px(14).h(32).flex().items_center().rounded(7).bg(GH_GREEN).text_color("#ffffff").text_size(TYPE.body).font_semibold()
          .cursor_pointer().on_mouse_down("left", stop).on_click(openRuns).child(runLabel))
      .when(meta.url === pr?.url && Boolean(meta.dry), (e) => e.child(badge(t, "Dry run", t.ansi3).id("rv-bar-dry").tooltip(DRY_TIP)))
      // The green "Finish your review", with the pending count (one name for the step, with or without comments); the
      // review copy draws the popover.
      .child(div().id("rv-finish-btn").tooltip("Preview your pending comments, then post them to GitHub or send them to an agent").flex_none().px(14).h(32).flex().items_center().gap(6).rounded(7).bg(GH_GREEN).text_color("#ffffff").text_size(TYPE.body).font_semibold()
        .cursor_pointer().on_mouse_down("left", stop).on_click(() => run("pr-review.finish"))
        .child("Finish your review")
        .when(pending > 0, (e) => e.child(div().px(6).rounded_full().bg("#ffffff").text_color(GH_GREEN).text_size(TYPE.small).child(String(pending))))
        .child("▾"));
  },

  // Row 2, at the top of the review: the facts as plain text with separators (risk, the rules and checks by name),
  // then the model as one dropdown, Example values, help and ⋯ (Mark done, Copy link, Copy review state, Open on
  // GitHub). Narrow: it wraps.
  metaRow(t) {
    const ai = this.ai, m = model(), ck = this.checkFacts();
    const sep = () => div().flex_none().text_color(t.dim).child("·"), cap = (x) => x[0].toUpperCase() + x.slice(1);
    const link = (id, child, click) => h_flex().id(id).flex_none().gap(4).items_center().px(6).h(28).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(click).child(child);
    const menu = (id, items, w = 230) => (_e, cx) => { openOverlay({ mod: "pr-review", props: { part: "cmenu", key: id, items }, kind: "popup", width: w, height: 12 + 30 * items.length }); cx.stop_propagation(); };
    // The verdict's excerpt ("⛨ 2 high · 0/5 criteria"), from the same parts as the Overview's verdict line.
    // Not on the Overview: its verdict line and its "Repo rules" line say the same a few lines below (one place each).
    const onPage = !this.defFile && this.tab === "steps" && Boolean(this.page), onOverview = onPage && this.page === "overview";
    const vd = this.prSel && !onOverview ? this.verdictNow() : [];
    const facts = [
      vd.length > 0 && link("rv-mr", h_flex().gap(6).children(vd.flatMap((p, k) => [k > 0 && div().text_color(t.dim).child("·"), this.verdictSign(t, p, p.short)].filter(Boolean))),
        (_e, cx) => { this.tab = "steps"; this.page = "overview"; cx.notify(); }).tooltip([`${vd.map((p) => p.text).join(" · ")}. Click for the Overview.`, ...vd.map((p) => this.pageBadges()[SIGN_PAGE[p.key]]?.tip).filter(Boolean)].join("\n")),
      ck && !onOverview && link("rv-ck", h_flex().gap(4).children(ck.parts.map(([text, bad]) => div().child(`${bad ? "✗ " : ""}${text}`))), // a symbol, not red: red is the security part's
        (_e, cx) => { this.tab = "steps"; this.page = "overview"; this.pagePart("checks", cx); cx.notify(); }).tooltip(ck.tip),
    ].filter(Boolean);
    const modelText = this.aiBusy ? `${modelLabel(this.aiBusy.model)} analyzing…` : modelLabel(m); // without the analysis' cost: the Overview's total says it by run, the menu estimates the next one
    return h_flex().id("rv-meta").flex_none().flex_wrap().min_h(40).px(16).py(6).gap(10).items_center().border_b(1).border_color(t.border).bg(t.chrome).text_size(TYPE.small).text_color(t.muted)
      .children(facts.flatMap((f, k) => (k ? [sep(), f] : [f])))
      .child(div().flex_1())
      // What only acts on a diff (which cards stand under its lines, one or two columns, line wrap, example values)
      // shows while the right pane is a diff, not beside a page.
      .when(!onPage, (e) => e.child(this.showChips(t, "rv-show")).child(sep()))
      .when(Boolean(this.worktree?.path) && !this.trustedPr(), (e) => e.child(link("rv-trust", div().text_color(t.ansi3).child("Restricted Mode · Trust"), (_e, cx) => this.trust("pr", cx))
        .tooltip("Someone else's code: language servers don't run anything from the repository, so go-to-definition may find less. Click to trust this PR.")))
      .child(link("rv-model", h_flex().gap(4).child(this.aiBusy ? div().child(SPIN[0]).frames(SPIN, 90) : div()).child(modelText).child("▾"),
        menu("models", modelChoices(this.ctxId()).map((c) => [`${c.value === m ? "✓ " : ""}${c.label} · ${priceText(c.value)} · ${this.estimate(c.value)}`, false, `model:${c.value}`]), 470)).tooltip("Pick the model for the AI analysis; each option shows its cost estimate").accessibility_label("Model"))
      .when(!onPage, (e) => e.child(sep())
      .child(h_flex().gap(10).items_center().child(link("rv-diffmode", div().child(this.diffMode() === "split" ? "Side by side" : "Unified"), () => setShared("review.diff", this.diffMode() === "split" ? "unified" : "split"))
        .tooltip(`The diff ${this.diffMode() === "split" ? "shows the old and the new lines side by side" : "shows old and new lines in one column"}. Click to switch; your choice is kept.`)).child(sep())
        .child(link("rv-wrap", div().text_color(this.wrapOn() ? t.foreground : t.muted).child(`Line wrap ${this.wrapOn() ? "on" : "off"}`), () => setShared("review.wrap", !this.wrapOn()))
          .tooltip(this.wrapOn() ? "Long lines wrap. Click to keep them on one line and scroll sideways." : "Long lines stay on one line: scroll sideways with shift+wheel or the bar under the diff. Click to wrap them.")).child(sep()))
      .child(link("rv-values", div().text_color(valuesOn() ? t.foreground : t.muted).child(`Example values ${valuesOn() ? "on" : "off"}`), () => setShared("review.values", !valuesOn())).tooltip("Example values from the flow traces, shown inline in the diff: click to switch")))
      .child(link("rv-keys", div().child("?"), () => openOverlay({ mod: "pr-review", props: { part: "keys" }, kind: "popup", ...KEYS_POP })).tooltip("Keyboard shortcuts").accessibility_label("Keyboard shortcuts"))
      .child(link("rv-more", div().child("⋯"), menu("more", [["Explore a topic…", false, "explore"], ["Mark done", false, "done"], ...(this.fixBase() ? [["Fix worktrees…", false, "worktrees"]] : []), ["Copy link", false, "copy-link"], ["Copy review state", false, "copy-state"], ["Copy this page as Markdown", false, "copy-md"], ...(this.checkList().length ? [["Copy context to check findings", false, "copy-md:verify"]] : []), ...(this.prSel?.url?.startsWith("https://github.com") ? [["Open on GitHub", false, "open-gh"]] : [])])).tooltip("Explore a topic, mark done, list the fix worktrees left on disk, copy the link, the review's state, this page or the context to check findings as text, open on GitHub").accessibility_label("More actions"));
  },

  // ---- render: the left column

  stepRow(s, i, t) {
    const on = i === this.cur && !this.page, done = this.done(s), files = this.filesOf(s), seen = files.filter((p) => this.prog.seen.has(p)).length;
    const list = on && !s.pseudo, w = worst(this.layerFindings(s).filter((f) => OPEN_ST.includes(this.fstatus(f)))), n = (k) => `${k} unresolved ${k === 1 ? "finding" : "findings"}`;
    const acc = s.pseudo ? null : layerAccess(this.ai?.access, files); // a way in or a right this layer adds, finding or not
    // Title and marks only: the layer's sentence is in its head over the code (once it is open) and in this tooltip.
    return v_flex().id(`rv-step-${i}`).tooltip(`${s.why ? `${plain(s.why)} ` : ""}Click to open this layer: its explanation, flows and changed code.`).flex_none().px(10).py(8).gap(6).rounded(8).cursor_pointer().when(on, (e) => e.bg(t.selected)).hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => { this.goStep(i, cx); cx.notify(); })
      .child(h_flex().gap(8).items_center()
        .child(div().id(`rv-chk-${i}`).tooltip(done ? "You ticked every file in this layer as viewed" : "The layer gets its tick once you ticked every file in it as viewed").w(18).flex_none().text_size(TYPE.title).text_color(done ? t.ansi2 : t.muted).child(done ? "✓" : String(i + 1)))
        .child(div().flex_1().min_w(0).text_size(TYPE.title).font_semibold().text_color(s.stale ? t.muted : t.foreground).when(!on, (e) => e.truncate()).child(plain(s.title)))
        .when(Boolean(s.isNew), (e) => e.child(badge(t, "new", t.accent).id(`rv-new-${i}`).tooltip("New since the previous analysis")))
        .when(Boolean(s.stale), (e) => e.child(badge(t, "outdated", t.ansi3).id(`rv-old-${i}`).tooltip("These hunks are no longer in the diff: the code changed since the analysis")))
        // Its unresolved findings, whoever found them: the highest severity with its count, security with its own mark.
        .when(Boolean(w?.security), (e) => e.child(div().id(`rv-sec-${i}`).tooltip(`${w.security} of them ${w.security === 1 ? "is a security finding" : "are security findings"}${w.signWords ? `: ${w.signWords}` : ""}${acc ? `. ${acc.text}` : ""}`).flex_none().text_size(TYPE.body).child(signEl(div, t, w.sign, "⛨"))))
        // Without a security finding the mark still says what the layer opens: not red (red is for findings).
        .when(Boolean(acc) && !w?.security, (e) => e.child(div().id(`rv-acc-${i}`).tooltip(acc.text).flex_none().text_size(TYPE.small).text_color(t.ansi3).child(acc.entries ? "⛨ Way in" : "⛨ Rights")))
        .when(Boolean(w), (e) => e.child(badge(t, w.label, t[SEV[w.severity]] ?? t.ansi1).id(`rv-risk-${i}`).tooltip(`${n(w.total)} in this layer: ${w.words}`))))
      .when(!list && files.length > 0, (e) => e.child(div().pl(26).text_size(TYPE.small).text_color(t.muted).child(`${seen} of ${files.length} ${files.length === 1 ? "file" : "files"} viewed`)))
      // The open layer: its files, each with the same "Viewed" tick as in the Files tab (a long list: its first ones).
      .when(list, (e) => e.child(v_flex().pl(22).children(files.slice(0, LAYER_FILES).map((p, k) => h_flex().id(`rv-lfile-${i}-${k}`).tooltip("Tick this file as viewed; the layer is ticked once all its files are").accessibility_label("Viewed")
        .h(26).px(4).gap(8).items_center().rounded(5).cursor_pointer().hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => { this.toggleSeen(p, cx); cx.stop_propagation(); cx.notify(); })
        .child(viewedBox(t, this.prog.seen.has(p)))
        .child(div().flex_1().min_w(0).truncate().text_size(TYPE.body).text_color(this.prog.seen.has(p) ? t.muted : t.foreground).child(p))))
        .when(files.length > LAYER_FILES, (x) => x.child(div().h(22).px(4).text_size(TYPE.small).text_color(t.muted).child(`${seen} of ${files.length} files viewed: the other ${files.length - LAYER_FILES} are in the Files tab`)))))
      .when(on, (e) => e.children(this.layerParts(s, t, "rv", i, i, s.visuals?.length > 0 && this.diagramsBar(t, `rv-dia-${i}`, "Refresh this view")).map((x) => div().pl(26).child(x))))
      .when(on && !s.pseudo && Boolean(this.ai), (e) => e.child(h_flex().pl(26).gap(6).child(pill(`rv-ask-l${i}`, t, "Ask about this layer", (_e, cx) => {
        const k = (this.ai?.steps ?? []).indexOf(s); this.setDrawer("open", cx, k >= 0 ? { layer: k } : null); cx.stop_propagation(); }).tooltip("Ask one model question about this layer; the answer stays private"))
        .child(pill(`rv-drill-l${i}`, t, "Show details", (_e, cx) => { this.showDetails(this.layerSubject(s), `layer:${stepKey(s)}`, cx); cx.stop_propagation(); }).tooltip("One model call breaks this layer down further")))
        .child(div().pl(26).child(this.drillPanel(t, `layer:${stepKey(s)}`))))
      .when(on, (e) => e.children((s.flows ?? []).map((f, k) => {
        const picked = this.flowOf()?.f === f;
        return div().pl(26).child(div().rounded(9).border_1().border_color(picked ? t.accent : t.chrome).child(flowCard(f, t, `rv-flow-${i}-${k}`,
          (_e, cx) => { this.flowSel = { step: stepKey(s), k }; this.jumpTo(f.at, cx); cx.stop_propagation(); })));
      })))
      ;
  },

  // A layer's explanation, findings and pictures; a card's "In the layer analysis" shows them. The Layers view (p
  // "rv") has the pictures, like the check questions, once: over the layer's code (item: "step" and "vis").
  // p, n: keep the ids unique per place; tab: the key of the shown picture in this.visTab; bar: drawn above the pictures.
  layerParts(s, t, p, n, tab, bar = null) {
    const pics = p !== "rv" && s.visuals?.length > 0;
    return [
      Boolean(s.text) && div().text_size(TYPE.body).line_height(1.5).text_color(t.foreground).child(TextView.markdown(`${p}-ex-${stepKey(s)}`, s.text)),
      // Every finding in this layer's files, whoever found it: one line each with its source and state.
      this.layerFindings(s).length > 0 && v_flex().pt(2).gap(6)
        .child(div().text_size(TYPE.small).font_semibold().text_color(t.muted).child("FINDINGS"))
        .children(this.layerFindings(s).map((f, k) => {
          const st = this.fstatus(f), settled = ["fixed", "dismissed"].includes(st);
          return h_flex().id(`${p}-f-${n}-${k}`).tooltip(`${this.sourcesOf(f)}: open this finding in the Findings tab`).gap(8).items_center().text_size(TYPE.body).cursor_pointer()
            .on_click((_e, cx) => { this.openFinding(f); cx.stop_propagation(); cx.notify(); })
            .child(badge(t, f.severity, t[SEVERITY_COLOR[f.severity]] ?? t.accent)) // also "critical", which SEV does not have: without a colour the element, and with it the frame, failed
            .child(div().flex_1().min_w(0).truncate().text_color(settled ? t.muted : t.foreground).child(f.title))
            .child(div().flex_none().text_size(TYPE.small).text_color(t.muted).child(f.sources.length === 1 ? this.sourcesOf(f) : `${f.sources.length} sources`))
            .when(st !== "open", (e) => e.child(div().flex_none().text_size(TYPE.small).text_color(t[FSTATUS[st]?.[1]] ?? t.muted).child(FSTATUS[st]?.[0] ?? st)));
        })),
      pics && bar,
      pics && visualsCard(s.visuals, t, `${p}-vis-${n}`, (at, cx) => this.jumpTo(at, cx),
        this.visTab?.[tab] ?? 0, (k, cx) => { this.visTab = { ...this.visTab, [tab]: k }; cx.notify(); }, this.wrapX()),
    ].filter(Boolean);
  },

  // The flow whose trace shows inline: the one picked in the current step, else its first.
  flowOf() {
    const s = this.steps()[this.cur];
    if (!s?.flows?.length) return null;
    const k = this.flowSel?.step === stepKey(s) ? this.flowSel.k : 0;
    return { f: s.flows[k] ?? s.flows[0] };
  },

  // Inline example values (IntelliJ-style) for rows: "path:line" -> "name = value, …" from the shown flow's trace.
  traceMap() {
    const f = valuesOn() ? this.flowOf()?.f : null, out = new Map();
    for (const tr of f?.trace ?? []) {
      const path = this.patch?.find((x) => x.path === tr.path || x.path.endsWith(`/${tr.path}`))?.path ?? tr.path;
      out.set(`${path}:${tr.line}`, tr.values);
    }
    return out;
  },

  // ---- the left column: the Analysis tab (its pages, what needs attention, the layers), the pages

  checksNow() { return preMergeChecks({ title: this.pr?.title ?? this.prSel?.title, rules: realRules(this.ai?.rules ?? []), ctx: this.ctx }); }, // the criteria count once, as criteria
  openFindings() { return this.perFindings("open", (fs) => fs.filter((f) => OPEN_ST.includes(this.fstatus(f)))); },
  blockersNow(checks = this.checksNow()) { return mergeBlockers({ checks, findings: this.openFindings(), unverified: this.verifyList().length, related: this.ctx, sent: (f) => this.fstatus(f) === "progress" }); },
  // The triage for this PR (pr.js triageOf, no LLM), for the registry and its consumers.
  triageNow() {
    const lines = (this.patch ?? []).reduce((n, f) => n + f.add + f.del, 0);
    return triageOf({ pr: this.prSel ?? {}, analysis: this.ai, size: { files: this.patch?.length ?? 0, lines },
      security: this.openFindings().filter((f) => f.security), related: this.ctx });
  },
  filesOf(s) { return [...new Set(this.present(s).map((id) => this.byId.get(id).path))]; },
  // "file.ts — question": a check question with the file it is about (the analysis names it; none when the question
  // is about several files, or in an analysis from before it did).
  asked(s, q, k) { const f = s.questionFiles?.[k]; return f ? `${f.split("/").pop()} — ${q}` : q; },

  // What stands before the merge: the Overview's "Before merge" rows (mergeRows), the same list in the same order with
  // the same click. No layers: those are the list below.
  attention() {
    return this.mergeRows().map((r) => {
      const f = r.finding ?? null;
      return { row: r, severity: f?.severity ?? null, label: r.kind === "ask" ? `${r.title}: ${r.ask.state === "not_done" ? "not done" : r.ask.state}` : r.title, why: r.why || r.title, security: r.kind === "security",
        certainty: f?.certainty ?? null, path_certainty: f?.path_certainty ?? null, probed: f?.probed ?? null, finding: Boolean(f), sent: Boolean(f) && this.fstatus(f) === "progress", at: r.where ? r.where.split("/").pop() : "", go: (cx) => this.goMergeRow(r, cx) };
    });
  },
  // A click on a row of "Before merge" (or the box over the layers): the finding, the criterion, the check or the path.
  goMergeRow(r, cx) {
    const f = r.finding;
    if (f) { this.openFinding(f); this.jumpTo(`${f.file}:${f.line}`, cx); }
    else if (r.kind === "ask") { this.page = "overview"; (this.askOpen ??= new Set()).add("crit"); this.askOpen.add(r.ask.id); }
    else if (r.kind === "verify") this.tab = "findings";
    else if (r.kind === "overlap" && r.url) this.openRelated({ url: r.url }, cx);
    else if (r.kind === "resilience") { this.page = "res"; this.resOpen = r.path; }
    else { this.page = "overview"; this.rulesOpen = true; }
  },

  // The box above the layers: the first few blockers, one line each. Folded to its heading while a layer is open
  // (attFold: your own click on the heading, until another page or layer view opens).
  attentionBox(t, list, folded) {
    const shown = mergeFirst(list, 5, (a) => a.row), rest = list.filter((a) => !shown.includes(a)), SYM = { criterion: "✗", ask: "○", verify: "↻", overlap: "⇄", resilience: "↯" };
    return v_flex().flex_none().p(10).gap(4).rounded(8).border_1().border_l(3).border_color(t.ansi3).bg(t.ansi3 + "10")
      .child(h_flex().id("rv-att-head").tooltip(folded ? "Show what stands in the way of a merge" : "Fold this list").flex_wrap().gap(6).items_center().cursor_pointer().text_size(TYPE.small)
        .on_click((_e, cx) => { this.attFold = !folded; cx.notify(); })
        .child(div().flex_none().w(10).text_color(t.ansi3).child(folded ? "▸" : "▾"))
        .child(div().flex_1().font_semibold().text_color(t.ansi3).child("NEEDS YOUR ATTENTION"))
        .child(h_flex().flex_wrap().gap(4).text_color(t.muted).children(mergeGroups(list.map((a) => a.row))
          .flatMap((p, k) => [...(k ? [div().text_color(t.dim).child("·")] : []), div().when(p.key === "security", (e) => e.text_color(t.ansi1)).child(p.text)]))))
      // A row as in "Before merge": the severity as a stripe, the kind as a symbol (⛨ security, ↯ resilience, ✗ criterion).
      .when(!folded, (e) => e.children(shown.map((a, k) => h_flex().id(`rv-att-${k}`).tooltip(a.why || "Go to this item").h(26).pl(6).pr(4).gap(8).items_center().rounded(4).border_l(3)
        .border_color(a.severity ? t[SEV[a.severity]] ?? t.muted : t.border).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { a.go(cx); cx.notify(); })
        .child(a.security || a.row.kind === "resilience" ? rowSign(t, a.security ? "⛨" : "↯", this.rowFindings(a.row)).text_size(TYPE.body)
          : div().w(SIGN_W).flex_none().text_size(TYPE.body).text_color(t.muted).child(SYM[a.row.kind] ?? (a.finding ? "!" : "✗")))
        .children([certaintyWord(t, a, `rv-att-c-${k}`)].filter(Boolean))
        .child(div().flex_1().min_w(0).truncate().text_size(TYPE.body).child(a.label))
        .when(a.sent, (x) => x.child(div().flex_none().text_size(TYPE.small).text_color(t[FSTATUS.progress[1]]).child(FSTATUS.progress[0])))
        .when(Boolean(a.at), (x) => x.child(div().flex_none().text_size(TYPE.small).text_color(t.muted).child(a.at)))))
        .when(rest.length > 0, (x) => x.child(div().id("rv-att-more").tooltip("Open the Overview: its Before merge list has them all").h(22).px(4).flex().items_center().rounded(5).cursor_pointer()
          .text_size(TYPE.small).text_color(t.muted).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.page = "overview"; (this.askOpen ??= new Set()).add("bm-all"); cx.notify(); })
          .child(`${rest.length} more: ${mergeGroups(rest.map((a) => a.row)).map((p) => p.text).join(", ")} →`))));
  },

  // The PR's pages (Overview, Architecture, Security) at the top of the Analysis tab, above its layers: they are part
  // of the analysis. A count stands plain at the row's right, the security one in its worst severity's color.
  pagesGroup(t) {
    const changed = (this.ai?.arch?.nodes ?? []).some((n) => n.status && n.status !== "unchanged"), b = this.pageBadges();
    const plain = (id, tip, color, text) => div().id(id).tooltip(tip).flex_none().text_size(TYPE.small).font_semibold().text_color(color).child(text);
    // A page's sign (views.js pageBadge): the color is the highest severity among its unresolved findings, the form how
    // sure that is, the number the page's own (security: causes, resilience: paths that block); the tip says it in words.
    const sign = (id, x) => h_flex().id(id).tooltip(x.tip).flex_none().gap(4).items_center().text_size(TYPE.small).font_semibold().child(signEl(div, t, x))
      .when(x.state === "open" && x.n > 0, (e) => e.child(div().text_color(t[x.color] ?? t.muted).child(String(x.n))));
    const mark = { overview: sign("rv-nav-ov", b.overview), blast: sign("rv-nav-sec", b.blast), res: sign("rv-nav-res", b.res),
      // The map's own word stays while no finding stands on it: "Changed" says what the page shows, not what is wrong.
      arch: b.arch.state !== "open" && changed ? plain("rv-nav-arch", "The architecture picture differs before and after this PR", t.accent, "Changed") : sign("rv-nav-arch", b.arch) };
    return v_flex().flex_none().px(8).pt(8).gap(2)
      .children(["overview", "arch", "blast", "res"].map((k) => {
        const label = PAGES.find(([p]) => p === k)[1], on = this.page === k;
        return h_flex().id(`rv-nav-${k}`).tooltip(`Open the ${label} page`).min_w(0).h(28).px(10).gap(6).items_center().rounded(7).cursor_pointer()
          .when(on, (e) => e.bg(t.selected).font_semibold()).hover((st) => st.bg(t.hover)).on_click((_e, cx) => { this.page = k; cx.notify(); })
          .child(div().flex_1().min_w(0).truncate().text_size(TYPE.body).text_color(on ? t.foreground : t.muted).child(label))
          .children([mark[k]].filter(Boolean));
      }));
  },

  // The four pages' signs (views.js pageBadge), also for the tab's label, the bar's excerpt and the Security page's
  // chip: the unresolved findings behind each page, its run's state and the page's own number.
  pageBadges() {
    const open = this.prSel ? this.openFindings() : [], runs = this.find?.runs ?? {}, stateOf = (k) => (runs[k]?.busy ? "running" : runs[k]?.state ?? null);
    const res = this.resNow(), paths = res?.paths ?? [], ids = new Set(paths.flatMap((p) => p.findings ?? [])), n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
    const blockers = paths.filter((p) => p.blocker).length, wired = paths.filter((p) => p.wired && !p.blocker).length, na = paths.filter((p) => p.result === "not_assessed").length;
    const secN = this.prSel ? this.counts().security : 0;
    return { overview: pageBadge("overview", open, { state: this.ai ? "done" : this.aiBusy ? "running" : null }),
      arch: pageBadge("arch", open.filter((f) => f.breaks), { state: this.ai?.arch ? "done" : this.aiBusy ? "running" : null }),
      blast: pageBadge("security", open.filter((f) => f.security), { state: stateOf("security"), n: secN, unit: secN === 1 ? "unresolved cause" : "unresolved causes" }),
      res: pageBadge("resilience", open.filter((f) => (f.ids ?? [f.id]).some((id) => ids.has(id))), { state: res ? "done" : stateOf("resilience"), n: blockers, unit: blockers === 1 ? "path blocks the merge" : "paths block the merge",
        more: wired ? `${n(wired, "path blocks", "paths block")} once wired.` : "", unsure: na ? `${n(na, "path", "paths")} not assessed` : "" }) };
  },
  // The unresolved findings behind a row of "Before merge": its own, or the ones of its Resilience path.
  rowFindings(r) {
    if (r.finding) return [r.finding];
    const ids = r.kind === "resilience" && r.path ? new Set(this.resNow()?.paths?.find((p) => p.id === r.path)?.findings ?? []) : null;
    return ids ? this.openFindings().filter((f) => (f.ids ?? [f.id]).some((id) => ids.has(id))) : [];
  },
  // A part of the verdict (the Overview's line, the bar's excerpt): the security and the resilience part carry their
  // page's sign in place of the bare ⛨ or ↯, and the security part its severity's color.
  verdictSign(t, p, text) {
    const b = SIGN_PAGE[p.key] ? this.pageBadges()[SIGN_PAGE[p.key]] : null;
    return b ? h_flex().gap(4).items_center().child(signEl(div, t, b, PAGE_GLYPH[p.key])).child(div().when(p.key === "security", (e) => e.text_color(t[b.color] ?? t.ansi1)).child(String(text).replace(/^[⛨↯] /, ""))) : div().child(text);
  },

  // The Analysis tab's label: its layers, and "⛨ n" while security findings are unresolved (the one security signal
  // that shows from every tab, since the pages are inside this tab).
  analysisLabel(t) {
    const sec = this.prSel ? this.counts().security : 0, b = sec > 0 ? this.pageBadges().blast : null; // once per cause, the number of the verdict
    return h_flex().gap(6).items_center().child(`Analysis${this.ai ? ` · ${this.ai.steps.filter((s) => !s.pseudo).length}` : ""}`)
      .when(sec > 0, (e) => e.child(h_flex().gap(3).items_center().child(signEl(div, t, b, "⛨")).child(div().text_color(t[b.color] ?? t.ansi1).child(String(sec)))));
  },

  // The attention box starts folded while a layer is open, and on a page when, open under the pages, the block would
  // take about half the column. A click on its heading (attFold) decides until another page or layer.
  attFolded(list) {
    if (this.attFold != null) return this.attFold;
    const boxH = 46 + 30 * Math.min(list.length, 5) + (list.length > 5 ? 26 : 0);
    // ponytail: estimated heights (150 px: the pages and the buttons); the block may take 45 % of the column. paneH is
    // logical px, the boxes grow with the zoom: the column in their px.
    return !this.page || 150 + boxH > 0.45 * ((this.paneH ?? Infinity) / (settings().zoom || 1));
  },

  stepsPane(t, cx) {
    const steps = this.steps(), ai = this.ai, m = model(), all = this.patch ?? [], viewed = all.filter((f) => this.prog.seen.has(f.path)).length;
    const run = (label) => div().id("rv-run").tooltip("Starts the AI analysis: one model call, it can take several minutes").px(12).h(30).flex().items_center().rounded(8).text_size(TYPE.body).bg(t.solid).text_color(t.solid_foreground)
      .cursor_pointer().on_click((_e, cx) => this.loadAi(cx, "run")).child(label);
    const attention = this.prSel ? this.attention() : [];
    // The run's cost, time and age are not for the first line of this column: they are in Re-analyze's tooltip.
    const last = ai ? ` The shown run: ${modelLabel(ai.model) ?? ai.model}${ai.cost != null ? `, $${Number(ai.cost).toFixed(3)}` : ""}${ai.budget ? ` of $${ai.budget} cap` : ""}${ai.ms ? `, ${clock(ai.ms)}` : ""}, ${ago(ai.generated)}${ai.incremental ? ", with the changes since your last review merged in" : ""}.` : "";
    // goStep: the open layer to the top of this column too. A plain scroll area only reveals a child at its near edge
    // (one below the view lands at its bottom), so the last child first, then, a frame later, the layer: it is above
    // the view then and lands at the top. The layers come after the heading.
    if (this.page !== this.leftPage) { this.leftPage = this.page; this.attFold = null; if (this.page) this.leftScroll.scroll_to_item(0); } // a page opened: the list from its top, the attention box open again
    if (this.leftTop && steps.length) {
      const first = 1;
      if (this.leftTop === 1) { this.leftTop = 2; this.leftScroll.scroll_to_item(first + steps.length - 1); cx.timer.after(0, (cx) => cx.notify()); }
      else { this.leftTop = 0; this.leftScroll.scroll_to_item(first + this.cur); }
    }
    const canInc = Boolean(ai && this.aiFile && this.since?.files.length && !this.aiBusy);
    return v_flex().flex_1().min_h(0).on_size_change((size, cx) => { if (Math.abs((this.paneH ?? 0) - size.height) > 8) { this.paneH = size.height; cx.notify(); } })
      .child(this.pagesGroup(t))
      .child(v_flex().flex_none().px(14).py(10).gap(8).border_b(1).border_color(t.border)
        .when(!ai && !this.aiBusy, (e) => e.child(v_flex().gap(8).py(4)
          .child(div().text_size(TYPE.body).line_height(1.5).child(`No ${modelLabel(m)} analysis for this diff yet. One thorough run reads the code around the changes and groups them into layers by intent, with explanations, check questions, suspicious lines, merge risk, review effort, repo rule checks, pictures and example values. It can take several minutes.`))
          .child(h_flex().gap(10).items_center().child(run(`Analyze with ${modelLabel(m)}`))
            .child(div().text_size(TYPE.small).text_color(t.muted).child(this.estimate(m))))))
        .when(Boolean(this.aiBusy), (e) => e.child(h_flex().gap(8).items_center().text_size(TYPE.body).text_color(t.foreground).child(div().child(SPIN[0]).frames(SPIN, 90))
          .child(div().flex_1().child(`${modelLabel(this.aiBusy.model)} is reading ${this.aiBusy.incremental ? "the new changes" : "the code"}${this.aiBusy.passes ? ` · Pass ${this.aiBusy.pass} of ${this.aiBusy.passes}` : ""} · ${clock(Date.now() - this.aiBusy.started)} · cap $${CAP[tierOf(this.aiBusy.model)]}`))
          .child(pill("rv-cancel", t, "Cancel", (_e, cx) => this.cancelAi(cx), false, t.ansi1).tooltip("Stop the running analysis"))))
        .when(Boolean(this.aiError), (e) => e.child(div().text_size(TYPE.small).text_color(t.ansi1).whitespace_normal().child(this.aiError)))
        // What is going on (checkout, an analysis waiting for it, reviewer runs), in the text color with a spinner while
        // it runs: here, not as a grey line under the page.
        .children(stateHints({ checkout: this.checkout, pendingRun: this.pendingRun, runs: this.find.runs, names: Object.fromEntries(Object.entries(REVIEWERS).map(([k, v]) => [k, v[0]])) })
          .map((h) => h_flex().id(`rv-hint-${h.key}`).gap(8).items_center().text_size(TYPE.small).text_color(h.error ? t.ansi1 : t.foreground)
            .when(Boolean(h.spin), (x) => x.child(div().flex_none().child(SPIN[0]).frames(SPIN, 90))).child(div().flex_1().min_w(0).whitespace_normal().child(h.text))))
        // Which head the analysis read and how old it is, in sight (the run's model and cost stay in Re-analyze's tooltip);
        // amber once the PR moved on, with what to do about it.
        .when(Boolean(ai), (e) => { const a = analysisAge({ head: ai.head, exact: ai.exact, now: this.worktree?.head ?? this.head, age: ago(ai.generated) });
          // Beside the Overview its context line says the head and the age: here only once the PR moved on (what to do).
          if (this.page === "overview" && !a.stale) return e;
          return e.child(div().id("rv-ai-age").tooltip(last.trim() || "The analysis shown").text_size(TYPE.small).text_color(a.stale ? t.ansi3 : t.muted).whitespace_normal()
            .child(a.stale ? `${a.text}: ${canInc ? "re-analyze, or analyze only the new changes." : "re-analyze for the current state."}` : a.text)); })
        .when(Boolean(ai?.scope?.skimmed), (e) => e.child(div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(scopeLine(ai.scope)))) // only when something was not read in detail
        .when(Boolean(ai?.cut.length) && !ai?.scope, (e) => e.child(div().text_size(TYPE.small).text_color(t.ansi3).whitespace_normal().child(`${ai.cut.length} hunks were too large for ${modelLabel(ai.model) ?? ai.model} and are not analyzed (an older analysis: re-analyze to read them).`)))
        .child(h_flex().flex_wrap().gap(6).items_center().text_size(TYPE.small)
          .when(Boolean(ai) && this.focusOrder().differs, (e) => e.child(h_flex().gap(2).p(2).rounded(7).border_1().border_color(t.border).children([["reading", "Layers"], ["risk", "By focus"]].map(([k, label]) =>
            div().id(`rv-order-${k}`).tooltip((k === "risk" ? "List the layers that need the closest reading first" : "List the layers in the order to read them")).px(8).h(22).flex().items_center().rounded(5).cursor_pointer().bg(this.order === k ? t.selected : t.chrome)
              .text_color(this.order === k ? t.foreground : t.muted).on_click((_e, cx) => { this.order = k; this.cur = 0; cx.notify(); }).child(label)))))
          .child(pill("rv-prev", t, "‹ Prev", (_e, cx) => { this.goStep(this.cur - 1, cx); cx.notify(); }).tooltip("Previous layer (k)"))
          .child(pill("rv-next", t, "Next ›", (_e, cx) => { this.goStep(this.cur + 1, cx); cx.notify(); }).tooltip("Next layer (j)"))
          .when(Boolean(ai || this.aiError), (e) => e.child(pill("rv-rerun", t, this.aiBusy ? "Running…" : "Re-analyze", (_e, cx) => this.loadAi(cx, "run")).tooltip(`Run the AI analysis again: one model call.${last}`)))
          .when(canInc, (e) => e.child(pill("rv-reinc", t, "Only new changes", (_e, cx) => this.loadAi(cx, "run", true), false, t.accent)
            .tooltip(`Analyze only the ${this.since.files.length} files changed since your last review and merge the new layers in`))))
        // Above the list, not in it: folded to one line while a layer is open, it still says what is left to decide.
        // Not beside the Overview: its "Before merge" is the same list, and one ranking on a screen is enough.
        .when(attention.length > 0 && this.page !== "overview", (e) => e.child(this.attentionBox(t, attention, this.attFolded(attention)))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("rv-steps-left").absolute().inset_0().overflow_y_scroll().track_scroll(this.leftScroll).p(8).gap(4)
          .child(h_flex().flex_none().mt(2).px(10).gap(8).items_center().text_size(TYPE.small).font_semibold().text_color(t.muted)
            .child(div().flex_1().child("LAYERS")).child(div().id("rv-lv-seen").tooltip("Files you ticked as viewed; a layer is ticked once all its files are").child(`${viewed} of ${all.length} files viewed`)))
          .children(steps.map((s, i) => this.stepRow(s, i, t))))
        .child(Scrollbar.vertical("rv-steps-left").absolute().inset_0()));
  },

  riskBadges(t, ai, id) {
    const r = ai.mergeRisk, e = ai.effort, cap = (x) => x[0].toUpperCase() + x.slice(1);
    return h_flex().flex_wrap().gap(6)
      .when(Boolean(r), (x) => x.child(badge(t, `Merge risk: ${cap(r.level)}`, t[SEVERITY_COLOR[r.level]]).id(`${id}-risk`).tooltip(r.why || r.level)))
      .when(Boolean(e), (x) => x.child(badge(t, `Review effort ${e.score}/5`, e.score >= 4 ? t.ansi3 : t.muted).id(`${id}-eff`).tooltip(e.why || "")));
  },

  // The page beside the Layers nav (instead of the diff). A page made of named parts (Architecture, Security) has
  // them as the scroll area's own children, so page-part:<name> can scroll to one.
  pageView(t) {
    const body = { overview: () => this.overviewPage(t), arch: () => this.archPage(t, true), blast: () => this.blastPage(t), res: () => this.resPage(t) }[this.page];
    const parts = [].concat(body ? body() : div()), named = Array.isArray(parts[0]);
    this.pageParts = named ? parts.map(([k]) => k) : [];
    // Copy as Markdown at the top right of every page: beside the first part (the head), which keeps the rest of the row.
    const els = named ? parts.map(([, el]) => el) : parts;
    if (body && this.prSel) els[0] = h_flex().w_full().gap(12).items_start().child(div().flex_1().min_w(0).child(els[0])).child(this.mdButton(t));
    return div().flex_1().min_h(0).relative()
      .child(v_flex().id(`rv-page-${this.page}`).absolute().inset_0().overflow_y_scroll().when(Boolean(this.pageScrolls[this.page]), (e) => e.track_scroll(this.pageScrolls[this.page])).px(24).py(18).gap(named ? 12 : 14).children(els))
      .child(Scrollbar.vertical(`rv-page-${this.page}`).absolute().inset_0());
  },

  // "4 files changed since your last review (abc1234 → def5678)" with Since last review / Full PR.
  sinceBanner(t) {
    const s = this.since;
    if (!s) return null;
    const seg = (on, label, click) => div().id(`rv-since-${on}`).tooltip((on ? "Show only the files changed since your last review" : "Show the whole PR")).px(10).h(24).flex().items_center().rounded(5).cursor_pointer().text_size(TYPE.small)
      .bg(this.sinceOn === on ? t.selected : t.chrome).text_color(this.sinceOn === on ? t.foreground : t.muted).on_click(click).child(label);
    const text = s.files.length ? `${s.files.length} ${s.files.length === 1 ? "file" : "files"} changed since your last review (${s.base.sha.slice(0, 7)} → ${String(s.head).slice(0, 7)})`
      : `The PR moved since your last review (${s.base.sha.slice(0, 7)} → ${String(s.head).slice(0, 7)})`;
    return v_flex().flex_none().px(14).py(8).gap(4).bg(t.accent + "14").border_b(1).border_color(t.border)
      .child(h_flex().gap(10).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(TYPE.body).font_semibold().child(text))
        .when(s.files.length > 0, (e) => e.child(h_flex().gap(2).p(2).rounded(7).border_1().border_color(t.border)
          .child(seg(true, "Since last review", (_e, cx) => { this.sinceOn = true; this.gaps = {}; this.tab = "files"; cx.notify(); }))
          .child(seg(false, "Full PR", (_e, cx) => { this.sinceOn = false; this.gaps = {}; cx.notify(); })))))
      .when(Boolean(s.note), (e) => e.child(div().text_size(TYPE.small).text_color(t.ansi3).whitespace_normal().child(s.note)));
  },

  // The Overview answers one question: can this be merged, and what has to change? At the top the title, the verdict
  // counted by what decides (security, the task's criteria, blockers; only the security part red) and one line of
  // context (size, stack, which head the analysis read and when, model and cost). Below, two columns when the page is
  // wide enough, else one under the other: on the left the decision (asksPane: Security, the criteria, what is not in
  // the task, the other findings), on the right the understanding (doesPane: what the PR does, new parts, repo rules,
  // related PRs). It returns its parts by name ([[name, element]]: top, main) for pageView.
  overviewPage(t) {
    const pr = this.prSel ?? {}, ai = this.ai, fc = this.counts(), list = this.taskNow(), verdict = this.verdictNow(), rows = this.mergeRows(), ctx = this.ctx;
    const dot = () => div().flex_none().text_color(t.dim).child("·");
    const go = { security: [(_e, cx) => { this.page = "blast"; cx.notify(); }, "Unresolved security causes: click for the Security page"],
      criteria: [(_e, cx) => { (this.askOpen ??= new Set()).add("crit"); cx.notify(); }, "How many of the task's criteria this PR meets: click to show them"],
      findings: [(_e, cx) => { this.tab = "findings"; cx.notify(); }, "Unresolved findings: click for the Findings tab"],
      checks: [(_e, cx) => this.pagePart("checks", cx), "Repo rules or CI checks that failed: click for the list"],
      verify: [(_e, cx) => { this.tab = "findings"; cx.notify(); }, "Fixes sent before the last push, not verified on the new head: click for the Findings tab"],
      resilience: [(_e, cx) => { this.tab = "steps"; this.page = "res"; cx.notify(); }, `Ways a failure spreads that block the merge: ${[...new Set((this.resNow()?.paths ?? []).filter((p) => p.blocker).map((p) => p.blocker.reason ?? p.blocker.why))].join("; ")}. Click for the Resilience page`] };
    const part = (p) => div().id(`rv-vd-${p.key}`).tooltip(go[p.key][1]).text_color(p.tone === "security" ? t.ansi1 : t.foreground)
      .when(Boolean(go[p.key][0]), (e) => e.cursor_pointer().hover((s) => s.underline()).on_click(go[p.key][0])).child(this.verdictSign(t, p, p.text));
    // The stack: the base this PR builds on, and the PRs that build on this one (related.py stacked_above).
    const action = verdictAction(rows), above = ctx?.stacked_above ?? [];
    // The window's top bar says the PR's state and, once it knows the stack, "Stack: #1 → #2": this line only says
    // what that bar does not (the stack while the bar has none yet).
    const barStack = Boolean(shared("review.meta")?.stack);
    const state = [!barStack && ctx?.stacked_on && `stacked on #${ctx.stacked_on.number}`, !barStack && above.length > 0 && `${above.map((p) => `#${p.number}`).join(", ")} ${above.length === 1 ? "builds" : "build"} on this PR`].filter(Boolean).join(" · ");
    // The title with the PR's state; the verdict: the suggested action, then the numbers it rests on (only ⛨ red).
    const head = v_flex().flex_none().gap(6).max_w(1100)
      .child(h_flex().flex_wrap().gap(12).items_baseline().child(div().min_w(0).text_size(TYPE.page).font_semibold().line_height(1.3).whitespace_normal().child(pr.title ?? `#${pr.number}`))
        .when(Boolean(state), (e0) => e0.child(div().id("rv-ov-state").flex_none().text_size(TYPE.small).text_color(t.muted).tooltip([ctx?.stacked_on ? `This PR's base is the branch of #${ctx.stacked_on.number} ${ctx.stacked_on.title ?? ""}, so it merges after it. Click to open it in its own review.` : "The PR's state on GitHub",
            ...above.map((p) => `#${p.number} ${p.title ?? ""} builds on this PR: it merges after this one.`)].join("\n"))
          .when(Boolean(ctx?.stacked_on), (e) => e.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.openRelated(ctx.stacked_on, cx))).child(state))))
      .when(verdict.length > 0 || Boolean(ai), (e) => e.child(h_flex().id("rv-verdict").max_w(860).flex_wrap().gap(8).items_center().text_size(TYPE.title).font_semibold().line_height(1.35)
        .child(div().id("rv-vd-action").tooltip("The action this review suggests; Finish your review leaves the choice to you").text_color(action === "Approve" ? t.ansi2 : t.foreground).child(`${action}${verdict.length ? ":" : ""}`))
        .children(verdict.flatMap((p, k) => (k ? [dot(), part(p)] : [part(p)])))))
      .child(this.contextLine(t, rows))
      .when(Boolean(this.since), (e) => e.child(div().rounded(8).overflow_hidden().border_1().border_color(t.border).child(this.sinceBanner(t))))
      .when(!ai && !this.aiBusy, (e) => e.child(this.startCards(t)));
    const cols = h_flex().w_full().flex_wrap().items_start().gap(36)
      .when(Boolean(ai) || fc.total > 0, (e) => e.child(v_flex().flex_1().min_w(440).max_w(760).child(this.asksPane(t, list, rows))))
      .child(v_flex().flex_1().min_w(340).max_w(620).child(this.doesPane(t)));
    return [["top", head], ["main", cols]];
  },

  // A related PR in the review layout (the resume contract): prs.json's entry, else one built from gh pr view on this
  // review's context; the browser when gh can't read it.
  openRelated(p, cx) {
    cx.spawn(async () => {
      const prs = JSON.parse(await readTextFile(`${appHome()}/pr-data/prs.json`).catch(() => null) ?? "{}").prs ?? [];
      const known = prs.find((x) => x.url === p.url);
      if (known) return startReview(known);
      const r = p.url ? await exec("gh", ["pr", "view", p.url, "--json", "number,title,author,headRefName,headRefOid,baseRefName,updatedAt,isDraft,state,url,additions,deletions,reviewDecision"], { timeout: 30000 }).catch(() => null) : null;
      if (r?.code === 0) startReview(ghTarget(JSON.parse(r.stdout), { context: this.ctxId(), source: "related", cwd: this.prSel?.cwd ?? null }));
      else if (p.url) openUrl(p.url);
    });
  },

  // The picture's highlight (hovered badge or legend row), focus (clicked card; Esc or a second click clears it) and
  // hover (a lighter focus) for the picture of the Architecture page ("arch") or the Security page ("blast").
  archOpts(k) {
    const set = (name, v, cx) => { if (this[name] !== v) { this[name] = v; cx.notify(); } };
    return { hl: this[`${k}Hl`] ?? (k === "arch" ? this.askHl : null), focus: this[`${k}Focus`] ?? null, hover: this[`${k}Hover`] ?? null,
      // A click on a card or a call ends a drag its press began (see hsMove).
      onHl: (v, cx) => set(`${k}Hl`, v, cx), onHover: (v, cx) => set(`${k}Hover`, v, cx),
      onFocus: (v, cx) => { this.hsDrag = null; this.fh.focus(); set(`${k}Focus`, v, cx); }, onJump: (at, cx) => this.jumpTo(at, cx),
      onFinding: (f, cx) => { this.openFinding(f); this.jumpTo(`${f.file}:${f.line}`, cx); cx.notify(); } }; // a mark's click: its finding, open in the Findings tab and at its line
  },

  // parts: the page as [[name, element]] for pageView (page-part:<name>); else one column (Explore).
  archPage(t, parts = false) {
    const a = this.ai?.arch;
    const seg = (k, label) => div().id(`rv-av-${k}`).tooltip((k === "diff" ? "What changed in the architecture" : k === "before" ? "The architecture before this PR" : "The architecture after this PR")).px(10).h(24).flex().items_center().rounded(5).cursor_pointer().text_size(TYPE.small)
      .bg(this.archMode === k ? t.selected : t.chrome).text_color(this.archMode === k ? t.foreground : t.muted).on_click((_e, cx) => { this.archMode = k; cx.notify(); }).child(label);
    const more = () => visualsCard(this.ai.visuals, t, "rv-arch-vis", (at, cx) => this.jumpTo(at, cx), this.archVisTab ?? 0, (k, cx) => { this.archVisTab = k; cx.notify(); }, this.wrapX());
    const out = (list) => (parts ? list : v_flex().gap(12).children(list.map(([, el]) => el)));
    if (!a) return out([["head", this.diagramsBar(t, "rv-dia-arch", "Refresh diagrams")], ["none", div().text_size(TYPE.body).text_color(t.muted).child(this.ai ? "This analysis has no architecture picture (older analysis, or the PR touches no architecture). Re-analyze for one." : "No analysis yet: Analyze in the left column.")],
      ...this.impactParts(t), ...this.infraPart(t), ...this.schemaParts(t), ...(this.ai?.visuals?.length > 0 ? [["views", div().w_full().child(more())]] : [])]);
    const groups = new Set(a.nodes.map((n) => n.group)).size, L = this.archL(), fit = this.archFitOn(), marks = this.archMarksNow();
    // The first time, and after Fit changed the layout, the picture starts at the way in (the Internet card), wherever
    // the layout put it. Not before the view is measured: Fit switches itself on then, and the cards move.
    if (!this.doorShown && L && this.hsOf("rv-arch-canvas").viewW && !this.archWrapOn()) { const d = L.nodes.find((n) => n.id === "\0in"); if (d) this.hsOf("rv-arch-canvas").x = Math.max(0, d.x - 40); this.doorShown = true; }
    // The frames are the systems; a card's trust zone is a dot on it, ringed when it is really reachable from further out.
    const opts = { ...this.archOpts("arch"), marks, zoom: settings().zoom || 1, zones: a.zones ?? [], effective: this.effZones(a) }, count = (...st) => L.nodes.filter((n) => st.includes(n.status)).length; // of the cards shown (Before hides the added ones)
    const head = ["head", h_flex().gap(12).items_center().flex_wrap().child(div().text_size(TYPE.page).font_semibold().child("Architecture impact")).child(this.diagramsBar(t, "rv-dia-arch", "Refresh diagrams"))
        .when(this.drawerState() !== "open", (e) => e.child(pill("rv-ask-open", t, "Ask", (_e, cx) => this.setDrawer("open", cx, null)).tooltip("Ask one model question about the architecture picture")))];
    if (!L) return out([head]); // no map
    return out([
      head,
      ["switches", h_flex().w_full().gap(12).items_center().flex_wrap() // wraps onto two rows when narrow
        .child(div().flex_none().text_size(TYPE.body).text_color(t.muted).child(`${groups} ${groups === 1 ? "system" : "systems"} | ${(a.edges ?? []).length} edges`))
        .child(div().flex_none().child(legend(t, { unchanged: count("unchanged"), changed: count("changed"), added: count("new", "added"), removed: count("removed") })))
        .when(hasSources(a) || (this.ai.visuals ?? []).some(hasSources), (e) => e.child(div().flex_none().child(sourceLegend(t))))
        .when(hasTrust(L), (e) => e.child(div().flex_none().child(trustLegend(L, t, a.zones))))
        .child(h_flex().flex_none().gap(2).p(2).rounded(7).border_1().border_color(t.border).child(seg("diff", "Structural diff")).child(seg("before", "Before")).child(seg("after", "After")))
        .child(div().id("rv-av-fit").flex_none().px(10).h(28).flex().items_center().rounded(7).border_1().border_color(fit ? t.accent : t.border).cursor_pointer().text_size(TYPE.small)
          .text_color(fit ? t.foreground : t.muted).tooltip(typeof this.archFit === "boolean" ? "Narrow cards with shorter texts, so more of the picture shows. It stays one row: scroll sideways for the rest" : "Narrow cards with shorter texts: on by itself while the picture is wider than the view. It stays one row: scroll sideways for the rest. A click decides for you").on_click((_e, cx) => { this.archFit = !fit; this.hsOf("rv-arch-canvas").x = 0; this.doorShown = false; cx.notify(); }).child("Fit"))
        .child(div().id("rv-av-wrap").flex_none().px(10).h(28).flex().items_center().rounded(7).border_1().border_color(this.archWrapOn() ? t.accent : t.border).cursor_pointer().text_size(TYPE.small)
          .text_color(this.archWrapOn() ? t.foreground : t.muted).tooltip("On: a picture wider than the view goes on in a second row. Off: one row to scroll sideways")
          .on_click((_e, cx) => { this.setArchWrap(!this.archWrapOn()); cx.notify(); }).child("Wrap"))],
      // Fit only narrows the cards: the picture stays one row and scrolls sideways when it is still wider than the view.
      // Rows (archBands) come from the Wrap switch alone.
      ["map", this.archCanvas(t, L, opts)],
      ...(this.archFocus && a.nodes.some((x) => x.id === this.archFocus) ? [["card", this.archCard(t, a, marks)]] : []),
      ...(this.archFocus && this.drillAt(`arch:${this.archFocus}`) ? [["inside", this.drillPanel(t, `arch:${this.archFocus}`)]] : []),
      // Only the calls whose text is not on their line in the picture (a fan's, a stub's, a text cut short).
      // Folded to one line with their number; open, the list (archLegend).
      ...(L.paths.some((p) => !p.text || p.text.cut) ? [["calls", v_flex().gap(6)
        .child(h_flex().id("rv-arch-calls").gap(8).items_center().cursor_pointer().text_size(TYPE.body).text_color(t.muted).hover((x) => x.text_color(t.foreground))
          .tooltip(this.fold.archCalls ? "Fold this list" : "Show these calls with their whole text").on_click((_e, cx) => { this.fold.archCalls = !this.fold.archCalls; cx.notify(); })
          .child(this.fold.archCalls ? "▾" : "▸").child(`Calls without their whole text in the picture · ${L.paths.filter((p) => !p.text || p.text.cut).length}`))
        .when(Boolean(this.fold.archCalls), (e) => e.child(archLegend(L, t, "rv-arch-edges", "Calls without their whole text in the picture", opts)))]] : []),
      ...((this.ai.components ?? []).length ? [["components", this.componentsTable(t, a)]] : []),
      ...this.impactParts(t),
      ...this.infraPart(t),
      ...this.schemaParts(t),
      ...(this.ai?.visuals?.length > 0 ? [["views", v_flex().gap(12).child(div().pt(6).text_size(TYPE.body).font_semibold().text_color(t.muted).child("More views")).child(div().w_full().child(more()))]] : [])]);
  },

  // The infrastructure files of the patch with their text at the PR head, for "Infrastructure changes" (infra.js: static,
  // no model). Without a checkout: what the patch itself holds (added and deleted files). With one: the changed
  // files and, for Terraform, the other .tf files of their folders, read from the checkout. Which of them exist is
  // asked through safegit.py (ls-files -s: tracked regular files only, so a link out of the checkout is not followed).
  // The files are the PR's own text, read in a task of its own: a file the reader fails on (or one written to make
  // it fail) costs this section, never the opening of the PR (onSource goes on to the analysis and the findings).
  loadInfra(cx) {
    const url = this.prSel?.url, patch = this.patch ?? [], w = this.worktree, files = patch.filter((f) => isIac(f.path) && !f.binary);
    const model = (...a) => { try { return infraModel(...a); } catch { return null; } };
    this.infra = null; this.infraMemo = null;
    if (!files.length) return;
    cx.spawn(async (cx) => {
      if (this.prSel?.url !== url || this.patch !== patch) return;
      this.infra = model(files); this.infraMemo = null; cx.notify();
      if (!w?.path) return;
      const tf = [...new Set(files.filter((f) => /\.tf(vars)?$/.test(f.path)).map((f) => dirOf(f.path)))], want = files.filter((f) => f.status !== "added" && f.status !== "deleted").map((f) => f.path);
      if (!tf.length && !want.length) return;
      const r = await exec("python3", [`${appHome()}/mods/pr-review/safegit.py`, w.path, "ls-files", "-s", "--", ...tf.map((d) => `${d ? `${d}/` : ""}*.tf`), ...want], { timeout: 30000 }).catch(() => null);
      if (r?.code !== 0 || this.prSel?.url !== url || this.patch !== patch) return;
      const listed = r.stdout.split("\n").map((l) => /^100\d+ \S+ \d\t(.+)$/.exec(l)?.[1]).filter((p) => p && !p.startsWith('"')), texts = new Map();
      // ponytail: at most 200 files (Terraform first), one after the other, and one parse in one slice (about 50 ms
      // for a megabyte of .tf): a module larger than that is read in part; split the parse over timers if it matters.
      for (const p of listed.filter((x) => want.includes(x) || (/\.tf$/.test(x) && tf.includes(dirOf(x)))).sort((x, y) => /\.tf$/.test(y) - /\.tf$/.test(x)).slice(0, 200)) { const text = await readTextFile(`${w.path}/${p}`).catch(() => null); if (typeof text === "string") texts.set(p, text); }
      if (this.prSel?.url !== url || this.patch !== patch) return;
      this.infra = model(files.map((f) => ({ ...f, head: texts.get(f.path) })), [...texts].filter(([p]) => !files.some((f) => f.path === p)).map(([path, text]) => ({ path, text })));
      this.infraMemo = null; cx.notify();
    });
  },
  // "Infrastructure changes" as a part of the Architecture page, only when the diff has infrastructure code. A click on
  // a card leads to the resource in the diff (no panel of its own), a finding's mark to the finding.
  infraPart(t) {
    const m = this.exMode ? null : this.infra;
    if (!m) return [];
    const fs = this.openFindings(), key = fs.map((f) => `${f.id}|${f.severity}`).join(), o = this.archOpts("infra");
    // Many resources (infra.js isDense): cards by file, no layout and no lines; the chosen card (infraFocus, else
    // infraHover) shows its references. Kept per model and findings like the picture.
    if (m.cards.length && isDense(m)) {
      if (this.infraMemo?.model !== m || this.infraMemo.key !== key) { this.infraMemo = { model: m, key, dense: infraDense(m, fs) }; if (!this.infraMemo.dense.refs.has(this.infraFocus)) this.infraFocus = null; }
      return [["infra", infraSection(t, { model: m, pic: null, dense: this.infraMemo.dense, onJump: (at, cx) => this.jumpTo(at, cx), edit: (id, at) => this.editAt(t, id, at), focus: o.focus, hover: o.hover, onFocus: o.onFocus, onHover: o.onHover, onFinding: o.onFinding })]];
    }
    if (m.cards.length && (this.infraMemo?.model !== m || this.infraMemo.key !== key)) {
      // As archL (stack.js laidOut): what a frame can afford now, the better layout after it; a picture too big for
      // the frame comes with the first slice after it (until then the section without its picture, or with the one
      // from before when only the findings changed).
      const pic = infraPicture(m, fs, false, false), before = this.infraMemo?.model === m ? this.infraMemo.pic.L : null;
      this.infraMemo = { model: m, key, pic: laidOut(pic.args, pic, () => this.infraMemo?.pic, { wait: true, before }) };
    }
    return [["infra", infraSection(t, { model: m, pic: m.cards.length && this.infraMemo?.model === m && this.infraMemo.pic.L ? this.infraMemo.pic : null, onJump: (at, cx) => this.jumpTo(at, cx), edit: (id, at) => this.editAt(t, id, at), hl: o.hl, onHl: o.onHl,
      canvas: (L, decorate, marks) => this.archCanvas(t, L, { ...o, focus: null, onFocus: null, marks, zoom: settings().zoom || 1 }, { id: "rv-infra-canvas", pic: "rv-infra", wrap: false, decorate, notes: false }) })]];
  },

  // The picture: wider than the view and Wrap on (archWrapOn, off by default), in bands stacked top to bottom (arch.js
  // archBands); else one row in the sideways scroller (40 px of room after the last column). A line that goes on in the
  // next band ends at the band's right edge in a turn with its number, and starts again at the left edge of the next
  // one with the same number (at the same height of the picture; a band shows only from where its own frames start):
  // no line goes on unnamed.
  // o: {id, pic: the canvas's and the picture's element ids, wrap, decorate: archView's, notes: pinned notes on it}.
  archCanvas(t, L, opts, o = {}) {
    const { id = "rv-arch-canvas", pic: pid = "rv-arch", wrap = this.archWrapOn(), decorate = null, notes = true } = o;
    if (this.leanLevel()) return this.leanNote(t, id, L.nodes.length); // frames were stopped here (frameCut)
    const s = this.hsOf(id), M = 40; // the room for a turn's mark at a band's edge
    // The view is measured in logical px, the picture is drawn in the person's zoom: its width in the picture's px.
    const B = archBands(L, s.viewW && wrap ? hsVisible(s.viewW / (settings().zoom || 1), this.drawerCover()) - 4 - 2 * M : 0); // 0: not measured yet or Wrap off, one row
    const pic = (k) => [archView(L, t, `${pid}${k ? `-${k}` : ""}`, (n, _e, cx) => this.jumpTo(n.at ?? n.evidence ?? n.file, cx), decorate, opts), ...(notes ? this.pinNotes(t, L) : [])];
    if (B.length < 2) return this.hscroll(id, L.width + 4 + 40, L.height + 4, pic(0), t);
    const num = (n) => div().flex_none().w(18).h(18).flex().items_center().justify_center().rounded_full().border_1().border_color(t.muted).bg(t.background).text_size(TYPE.small).text_color(t.foreground).child(String(n));
    const turn = (m, k, end, y0 = 0) => h_flex().id(`${pid}-turn${k}-${end}-${m.y}`).absolute().top(m.y - y0 - 9).h(18).gap(2).items_center().text_size(TYPE.body).text_color(t.muted)
      .tooltip(`Call ${m.nums.join(", ")} ${end === "out" ? (m.back ? "comes in from the row below" : "goes on in the next row, at its left edge") : m.back ? "goes on in the row above, at its right edge" : "comes from the row above"}`)
      .children(end === "out" ? [...m.nums.slice(0, 1).map(num), div().child(m.back ? "←" : "⤵")] : [div().child(m.back ? "↰" : "↳"), ...m.nums.slice(0, 1).map(num)]);
    return v_flex().id(id).w_full().gap(6)
      .on_size_change((size, cx) => { if (Math.abs(s.viewW - size.width) > 2) { s.viewW = size.width; cx.notify(); } })
      .children(B.flatMap((b, k) => {
        // y0 (arch.js archBands): the strip over the picture this band does not need (no line runs up there).
        const w = b.x1 - b.x0, left = b.in.length ? M : 0, y0 = b.y0 ?? 0;
        return [
          ...(k ? [div().id(`${pid}-cut${k}`).w_full().h(0).border_t(1).border_dashed().border_color(t.border).tooltip("The picture goes on here: a line that leaves the row above on the right comes in on the left with the same number")] : []),
          div().id(`${pid}-band${k}`).w(left + w + (b.out.length ? M : 0)).h(b.h - y0 + 4).relative()
            .child(div().absolute().top(0).left(left).w(w).h(b.h - y0 + 4).overflow_hidden().child(div().absolute().top(-y0).left(-b.x0).w(L.width).h(L.height + 4).children(pic(k))))
            .children(b.in.map((m) => turn(m, k, "in", y0).left(0)))
            .children(b.out.map((m) => turn(m, k, "out", y0).left(left + w + 2)))];
      }));
  },
  // Where the unresolved findings sit on the picture (arch.js archMarks): on a card, or on a call they break.
  // Kept until the map, the ways in, the threats or the unresolved findings change: the page, the layout's key and
  // the card's panel each ask for the marks in one frame.
  archMarksNow() {
    const arch = this.ai?.arch, open = this.exMode ? null : this.openFindings(), access = this.ai?.access, threats = this.ai?.threats, m = this.marksMemo;
    if (m && m.arch === arch && m.open === open && m.access === access && m.threats === threats) return m.marks;
    return (this.marksMemo = { arch, open, access, threats, marks: archMarks(arch, open ?? [], access, threats ?? []) }).marks;
  },
  // What a model call for a card's inside costs, from the ones this review already paid for (deep.json).
  // ponytail: the mean of the kept results, whatever model they ran on; no result yet: no figure.
  insidePrice() {
    const costs = Object.values(this.deep.drills ?? {}).map((d) => d.cost).filter((c) => c > 0);
    return costs.length ? `about $${(costs.reduce((x, y) => x + y, 0) / costs.length).toFixed(2)}` : `one ${modelLabel(model())} call`;
  },
  // The clicked card, under the picture: its unresolved findings first (the ones the picture marks), then what it is
  // (file, connections, what running it needs, who may reach it), its description and the analysis's details, and
  // links to the layers that read its code. Look inside: one model call (the drill-down below), its price on the button.
  archCard(t, a, marks) {
    const n = a.nodes.find((x) => x.id === this.archFocus);
    const g = (a.groups ?? []).find((x) => x.id === n.group), at = n.at ?? n.evidence;
    const item = { id: n.id, label: n.label ?? n.id, group: g?.label, at, kind: "node", description: n.description };
    const paid = Boolean(this.drillResult([item])), price = this.insidePrice();
    const layers = this.cardLayerList(n), found = this.cardFindings(a, n, marks);
    const name = (id) => a.nodes.find((x) => x.id === id)?.label ?? id;
    return v_flex().id("rv-arch-card").gap(10).p(12).rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center().flex_wrap()
        .child(div().text_size(TYPE.title).font_semibold().child(n.label ?? n.id))
        .child(div().text_size(TYPE.small).text_color(t.muted).child([g?.label, n.type, n.status === "new" ? "added" : n.status].filter(Boolean).join(" · ")))
        .child(div().flex_1())
        .when(Boolean(at), (e) => e.child(pill("rv-arch-card-open", t, "Show in diff ↗", (_e, cx) => this.jumpTo(at, cx)).tooltip(`Show ${at} in the diff`)).children(this.editAt(t, "rv-arch-card-ed", at)))
        .child(pill("rv-arch-card-explain", t, paid ? "Look inside" : `Look inside (${price})`, (_e, cx) => this.showDetails(item, `arch:${n.id}`, cx, false, true), false, n.details ? null : t.foreground)
          .tooltip(paid ? "Show what the model found inside this card (already paid for)" : `One ${modelLabel(model())} call reads the code: what this does overall, what the PR changes in it, and a picture of its inside`))
        .when(this.drawerState() !== "open", (e) => e.child(pill("rv-arch-card-ask", t, "Ask", (_e, cx) => this.setDrawer("open", cx, null)).tooltip("Ask one model question about this card")))
        .child(pill("rv-arch-card-x", t, "✕", (_e, cx) => { this.archFocus = null; cx.notify(); }).tooltip("Close (Esc)").accessibility_label("Close card details")))
      .when(found.length > 0, (e) => e.child(v_flex().gap(2)
        .child(div().text_size(TYPE.small).font_semibold().text_color(t.muted).child(`UNRESOLVED FINDINGS · ${found.length}`))
        .children(found.slice(0, 6).map(({ f, edge }) => h_flex().id(`rv-arch-cf-${f.id}`).gap(8).items_start().px(6).py(3).rounded(6).text_size(TYPE.body).cursor_pointer().hover((x) => x.bg(t.hover))
          .tooltip("Open this finding and show its line in the diff").on_click((_e, cx) => { this.openFinding(f); this.jumpTo(`${f.file}:${f.line}`, cx); cx.notify(); })
          .child(badge(t, f.severity, t[SEV[f.severity]] ?? t.accent))
          .when(Boolean(f.security), (x) => x.child(secBadge(t, f).id(`rv-secwhy-${f.id}`).tooltip(secWhy(f) || "A security finding")))
          .child(div().flex_1().min_w(0).whitespace_normal().line_height(1.4).child(plain(f.title)))
          .when(Boolean(edge) || f.breaks?.node === n.id, (x) => x.child(div().flex_none().text_size(TYPE.small).text_color(t.muted).child(edge ? `breaks the call ${edge.from === n.id ? `to ${name(edge.to)}` : `from ${name(edge.from)}`}` : "breaks the flow here")))
          .child(div().flex_none().text_size(TYPE.small).text_color(t.muted).child(`${f.file.split("/").pop()}:${f.line}`))))
        .when(found.length > 6, (x) => x.child(div().px(6).text_size(TYPE.small).text_color(t.muted).child(`and ${found.length - 6} more in the Findings tab`)))))
      .child(this.archCardFacts(t, a, n, at))
      .when(Boolean(n.description), (e) => e.child(div().text_size(TYPE.body).text_color(t.muted).whitespace_normal().line_height(1.5).child(n.description)))
      .child(n.details ? div().pt(2).text_size(TYPE.body).line_height(1.55).child(TextView.markdown(`rv-arch-det-${this.ai?.generated}-${n.id}`, n.details))
        : div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(`This analysis has no further details for this card. “Look inside” reads its code with one model call (${price}). “↻ Refresh diagrams” at the top adds details to every card, also with one model call.`))
      // The layers that read this card's code: links, not copies (their text is in the Layers view).
      .when(layers.length > 0, (e) => e.child(v_flex().gap(2)
        .child(div().pt(4).text_size(TYPE.small).font_semibold().text_color(t.muted).child("LAYERS ON THIS CODE"))
        .children(layers.map((s, j) => {
          const fs = this.layerFindings(s).filter((f) => OPEN_ST.includes(this.fstatus(f))), top = fs[0]?.severity; // findings() sorts by severity
          return h_flex().id(`rv-acl-${j}`).gap(8).items_center().px(6).py(3).rounded(6).text_size(TYPE.body).cursor_pointer().hover((x) => x.bg(t.hover)).tooltip("Go to this layer in the Layers view")
            .on_click((_e, cx) => { this.goStep(this.steps().indexOf(s), cx); cx.notify(); })
            .child(div().min_w(0).truncate().child(plain(s.title)))
            .when(fs.length > 0, (x) => x.child(badge(t, `${top[0].toUpperCase()}${top.slice(1)} · ${fs.length}`, t[SEV[top]] ?? t.muted).id(`rv-acl-n${j}`).tooltip(`${fs.length} unresolved ${fs.length === 1 ? "finding" : "findings"} in this layer, the highest is ${top}`)))
            .child(div().flex_1())
            .child(div().flex_none().text_size(TYPE.small).text_color(t.accent).child("Open layer →"));
        }))));
  },
  // The unresolved findings at a card: the ones on the card (archMarks) and the ones that break a call into or out of
  // it ({f, edge}), most severe first.
  cardFindings(a, n, marks) {
    const own = (marks.nodes.get(n.id)?.findings ?? []).map((f) => ({ f, edge: null }));
    const calls = (a.edges ?? []).flatMap((e, i) => (e.from === n.id || e.to === n.id ? (marks.edges.get(i)?.findings ?? []).map((f) => ({ f, edge: e })) : []));
    const rank = (x) => ["high", "medium", "low"].indexOf(x.f.severity);
    return [...own, ...calls].sort((x, y) => rank(x) - rank(y));
  },
  // The layers that look at the card's code (explore.js layersForNode), the ones that hold the card's own file first.
  // Memoized per analysis and card: filesOf walks the hunks.
  cardLayerList(n) {
    const m = this.cardLayers;
    if (m?.ai !== this.ai || m.byId !== this.byId || m.n !== n) {
      const path = pathOf(n.at ?? n.evidence), own = (s) => (path && this.filesOf(s).some((p) => p === path || p.endsWith(`/${path}`) || path.endsWith(`/${p}`)) ? 0 : 1);
      const list = layersForNode(this.ai?.steps, n, (s) => this.filesOf(s));
      this.cardLayers = { ai: this.ai, byId: this.byId, n, list: list.map((s, i) => [s, i]).sort(([x, i], [y, k]) => own(x) - own(y) || i - k).map(([s]) => s) };
    }
    return this.cardLayers.list;
  },
  // What the card is, as key: value rows: its file (path:line, a click opens it; how many changed places of this PR are
  // in it), its links to the other cards, incoming first, one line each (a click shows that card), and from the
  // analysis' components and access lists what running it needs, who owns it and who may reach it.
  archCardFacts(t, a, n, at) {
    const path = at ? String(at).replace(/:\d+.*$/, "") : null;
    const hs = path ? [...(this.fileHunks ?? new Map())].filter(([p]) => p === path || p.endsWith(`/${path}`) || path.endsWith(`/${p}`)).flatMap(([, h]) => h) : [];
    const name = (id) => a.nodes.find((x) => x.id === id)?.label ?? id;
    const into = (e) => (e.to === n.id ? 0 : 1);
    const links = (a.edges ?? []).map((e, i) => [e, i]).filter(([e]) => e.from === n.id || e.to === n.id).sort(([x], [y]) => into(x) - into(y));
    const comps = (this.ai?.components ?? []).filter((c) => c.node === n.id), ops = [...new Set(comps.flatMap((c) => c.operate ?? []))], owners = [...new Set(comps.map((c) => c.owner).filter(Boolean))];
    const access = (this.ai?.access ?? []).filter((x) => x.node === n.id);
    const row = (label, body) => h_flex().gap(8).items_start().child(div().flex_none().w(84).text_color(t.muted).child(label)).child(body.flex_1().min_w(0));
    return v_flex().gap(4).text_size(TYPE.small).line_height(1.5)
      .child(row("File", at ? h_flex().gap(8).flex_wrap()
        .child(div().id("rv-arch-card-file").text_color(t.accent).cursor_pointer().hover((s) => s.underline()).tooltip("Open this place in the code").on_click((_e, cx) => this.jumpTo(at, cx)).child(String(at)))
        .child(div().text_color(t.muted).child(hs.length ? `${hs.length} changed ${hs.length === 1 ? "place" : "places"} in this PR` : "not in this PR's diff"))
        : div().text_color(t.muted).child("The analysis names no file for this card (Ask names it)")))
      .when(links.length > 0, (e) => e.child(row("Connections", v_flex().gap(2).children(links.map(([x, i]) => {
        const out = x.from === n.id, other = out ? x.to : x.from, arrow = out ? "→" : "←";
        // The label on one line; the whole text in the tooltip.
        return h_flex().id(`rv-arch-card-l${i}`).gap(6).min_w(0).rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip(`${arrow} ${name(other)}${x.label ? `: ${x.label}` : ""}. Click to show it`).on_click((_e, cx) => { this.archFocus = other; cx.notify(); })
          .child(div().flex_none().text_color(t.muted).child(arrow))
          .child(div().flex_none().font_semibold().child(name(other)))
          .when(Boolean(x.label), (e) => e.child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(x.label)));
      })))))
      .when(ops.length > 0, (e) => e.child(row("To operate", div().whitespace_normal().child(ops.join(" · ")))))
      .when(comps.length > 0 && this.ai?.componentCounts?.codeowners !== false, (e) => e.child(row("Owner", div().when(!owners.length, (x) => x.text_color(t.muted)).child(owners.join(", ") || "no owner named"))))
      .when(access.length > 0, (e) => e.child(row("Access", v_flex().gap(2).children(access.map((x) => div().whitespace_normal()
        .child(`${x.principal}: ${(x.actions ?? []).join(", ")}${x.public ? " · public" : ""}${x.used === false ? " · not used by the code" : ""}`))))));
  },
  // Under the picture: what the PR adds or changes as components (the analysis' `components`), where each is, what
  // running it needs and who owns it. A repo without a CODEOWNERS file gets a sentence instead of an empty column.
  // A row of the open card is lit; a click on a name shows its card.
  componentsTable(t, a) {
    const list = this.ai.components ?? [], c = this.ai.componentCounts ?? {}, owners = c.codeowners !== false;
    const n = (st) => c[st] ?? list.filter((x) => x.status === st).length, none = c.no_owner ?? list.filter((x) => !x.owner).length;
    const has = (id) => a.nodes.some((x) => x.id === id);
    const rows = list.map((x, k) => [
      has(x.node) ? div().id(`rv-comp-${k}`).font_semibold().cursor_pointer().hover((s) => s.underline()).tooltip("Show this component's card in the picture").on_click((_e, cx) => { this.archFocus = x.node; cx.notify(); }).child(x.name) : div().font_semibold().child(x.name),
      x.kind ?? "",
      div().text_color(x.status === "new" ? t.ansi2 : t.accent).child(x.status === "new" ? "Added" : "Changed"),
      x.at ? div().id(`rv-comp-at-${k}`).text_color(t.accent).cursor_pointer().hover((s) => s.underline()).tooltip("Show this place in the diff").on_click((_e, cx) => this.jumpTo(x.at, cx)).child(x.at) : "",
      (x.operate ?? []).length ? x.operate.join(" · ") : div().text_color(t.muted).child("nothing named"),
      ...(owners ? [x.owner ?? div().text_color(t.ansi3).child("no owner")] : [])]);
    return v_flex().id("rv-arch-comps").flex_none().gap(6).p(12).rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(10).items_center().flex_wrap()
        .child(div().text_size(TYPE.body).font_semibold().child("Components this PR adds or changes"))
        .child(div().text_size(TYPE.small).text_color(t.muted).child(`${n("new")} added · ${n("changed")} changed${owners ? ` · ${none} without an owner` : ""}`)))
      .when(!owners, (e) => e.child(div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child("This repository has no CODEOWNERS file, so no owner can be named.")))
      .child(this.table(t, "rv-comp-t", [["Component", 190], ["Kind", 76], ["Status", 66], ["Place", 190], ["To operate", null], ...(owners ? [["Owner", 130]] : [])], rows, (k) => Boolean(this.archFocus) && list[k].node === this.archFocus));
  },
  // A plain table for the pages: cols [[label, width in px, or null for a share of the rest]], rows [[cell]] (a cell:
  // text or an element; long text wraps), lit(k): a highlighted row.
  table(t, id, cols, rows, lit = () => false) {
    const box = ([, w]) => (w ? div().flex_none().w(w) : div().flex_1().min_w(0));
    const line = (cells) => cells.map((x, k) => box(cols[k]).whitespace_normal().child(x));
    return v_flex().id(id).w_full().text_size(TYPE.small).line_height(1.45)
      .child(h_flex().gap(10).px(6).pb(4).text_size(TYPE.small).font_semibold().text_color(t.muted).children(line(cols.map(([label]) => label))))
      .children(rows.map((r, k) => h_flex().id(`${id}-${k}`).gap(10).px(6).py(5).items_start().border_t(1).border_color(t.border).when(lit(k), (e) => e.bg(t.selected)).children(line(r))));
  },
  // Wrap: off by default (one row to scroll sideways); the choice is kept for every review (shared review.archWrap).
  archWrapOn() { return shared("review.archWrap") === true; },
  setArchWrap(on) { setShared("review.archWrap", on); this.hsOf("rv-arch-canvas").x = 0; },
  // Fit (narrow cards, never rows): the person's choice when there is one; else on as soon as the usual cards are wider
  // than the view, so more of the picture is in sight (the view's width is known after the first layout: until then, off).
  // Fit until it is chosen: on when the picture with the usual cards is wider than the view. Only one of the two
  // pictures is laid out to find out, the one a guess shows (narrow cards for a map of more than 8 cards: those are the
  // wide ones); the other's width follows from it (arch.js widthAt), and it is laid out only when the guess was wrong
  // or Fit is switched.
  // lay(fit): the layout of the map that asks (the Resilience map has its own).
  archFitOn(lay = (fit) => this.archL(fit)) {
    if (typeof this.archFit === "boolean") return this.archFit;
    const s = this.hsOf("rv-arch-canvas"), guess = (this.ai?.arch?.nodes.length ?? 0) > 8;
    if (!s.viewW) return false;
    const L = lay(guess);
    if (!L) return guess; // its layout comes after the frame (a big map): the guess stands until then
    return widthAt(L, guess, false) + 44 > hsVisible(s.viewW / (settings().zoom || 1), this.drawerCover());
  },
  // The picture shown: its layout with the calls' texts on their lines, a row in a card and above a call for the
  // findings there, normal or narrow cards (Fit). Memoized: the page renders often.
  archL(fit = this.archFitOn(), labelPx = null, more = null) { // labelPx: the calls' text size (the Resilience map: 13); more: cards with a line more (its marks), a Set, or a Map(card -> lines)
    const a = this.ai?.arch;
    if (!a) return null;
    const slot = labelPx || more ? `${fit}|${labelPx}|${[...(more ?? [])]}` : fit; // its own memo
    const m = this.archMarksNow(), key = `${slot}|${this.archMode}|${[...m.nodes.keys()]}|${[...m.edges.keys()]}|${jsonOf(a)}|${jsonOf(this.ai?.access ?? null)}`;
    // The map as the boundary really runs (views.js mapArch): the Internet card at the way in, no zone on shared code,
    // no "‖" on a call in one process.
    const memo = (this.fitMemos ??= {});
    if (!(slot in memo) && Object.keys(memo).length >= 8) delete memo[Object.keys(memo)[0]]; // a layout per kind of map shown, the oldest goes
    if (memo[slot]?.key !== key) {
      const args = [mapArch(a, this.ai?.access, this.ai?.bypasses ?? []), this.archMode, (n) => (m.nodes.has(n.id) ? markRoom(m.nodes.get(n.id), (fit ? ARCH_FIT.W : ARCH_SIZE.W) - 20).rows : 0) + (more?.has(n.id) ? resMarkRows(more.get?.(n.id) ?? 1) : 0), fit, { labels: true, labelPx: labelPx ?? undefined, marked: (es) => es.some((i) => m.edges.has(i)) }];
      // What a frame can afford now, the better layout after it (stack.js laidOut). A map too big even for a rough
      // pass in the frame keeps the layout from before while its own is searched (new marks; not another view of the
      // map), else the page is drawn without its picture until the first slice after the frame.
      memo[slot] = laidOut(args, { key, mode: this.archMode }, () => memo[slot], { wait: true, before: memo[slot]?.mode === this.archMode ? memo[slot].L : null });
    }
    return memo[slot].L;
  },
  // Herdr stops a frame that takes longer than about 50 ms and keeps showing the one before, under "This view could
  // not be re-rendered"; the next frame takes as long, so the view would stay there. cut: frames stopped in a row on
  // one tab and page. After three (two happen on a busy machine to a frame that takes half the time) the view draws
  // less there (leanLevel): no map picture but a sentence (archCanvas), and half the lines in the list per level
  // (rowsCap). After LEAN_MS it tries all of it again; "Draw it again" does so at once.
  frameCut(was) {
    const key = `${this.tab}|${this.page ?? ""}`;
    this.cut = was ? (this.cutKey === key ? (this.cut ?? 0) + 1 : 1) : 0; this.cutKey = key;
    if (this.cut >= 3) { (this.leanBy ??= new Map()).set(key, { level: this.leanLevel() + 1, at: Date.now() }); this.cut = 0; }
  },
  leanLevel() { const x = this.leanBy?.get(`${this.tab}|${this.page ?? ""}`); return x && Date.now() - x.at < LEAN_MS ? x.level : 0; },
  rowsCap(lines) { return Math.max(250, lines >> this.leanLevel()); },
  leanNote(t, id, cards) {
    return v_flex().id(`${id}-lean`).w_full().gap(8).p(12).rounded(8).border_1().border_color(t.border).text_size(TYPE.body).text_color(t.muted)
      .child(div().whitespace_normal().child(`The picture of ${cards} ${cards === 1 ? "card" : "cards"} is left out: drawing this page took longer than a frame may take (about 50 ms), twice in a row. Copy as Markdown has the picture as a diagram.`))
      .child(h_flex().child(pill(`${id}-again`, t, "Draw it again", (_e, cx) => { this.leanBy?.delete(`${this.tab}|${this.page ?? ""}`); this.cut = 0; cx.notify(); }).tooltip("Try to draw the picture again")));
  },
  // ---- sideways scrollers inside the scrolling page (the architecture canvas, the flow, state-machine and blast
  // pictures): clipped at their box, the content moved by left(-x); wheel and trackpad through wheelStep (one axis per
  // gesture, so page and picture never move together; shift+wheel sideways), drag to pan, a thumb bar when wider than
  // the view. Per id in this.hs: {x, viewW, maxX, contentW}; one gesture (this.gesture) and one drag (this.hsDrag).
  hsOf(id) { const m = (this.hs ??= new Map()); if (!m.has(id)) m.set(id, { x: 0, viewW: 0, maxX: 0, contentW: 0 }); return m.get(id); },
  // stack.js visualsCard's wrapX; room(id): the width that scroller shows, in the picture's px (0: not measured yet).
  wrapX() {
    if (!this.wrapXFn) { this.wrapXFn = (id, w, h, el) => this.hscroll(id, w, h, el); this.wrapXFn.room = (id) => { const s = this.hs?.get(id); return s?.viewW ? Math.floor(hsVisible(s.viewW / (settings().zoom || 1), this.drawerCover())) : 0; }; }
    return this.wrapXFn;
  },
  hscroll(id, contentW, h, content, t = theme()) {
    // viewW: what shows of the picture, the part under the Ask drawer (drawerCover) left out. The view is measured in
    // logical px, the picture is drawn in the person's zoom: its width in the picture's px.
    const s = this.hsOf(id), viewW = hsVisible((s.viewW || 800) / (settings().zoom || 1), this.drawerCover()), maxX = Math.max(0, contentW - viewW), x = Math.min(s.x, maxX);
    s.maxX = maxX; s.contentW = contentW; s.visW = viewW; // for the wheel and drag handlers
    return v_flex().w_full().gap(4)
      .child(div().id(id).w_full().h(h).relative().overflow_hidden().when(maxX > 0, (e) => e.cursor_grab())
        .on_size_change((size, cx) => { if (Math.abs(s.viewW - size.width) > 2) { s.viewW = size.width; cx.notify(); } })
        .on_scroll_wheel((e, cx) => this.hsWheel(id, e, cx))
        .on_mouse_down("left", (e) => { if (maxX > 0) this.hsDrag = { id, x0: e.position.x, from: x }; })
        .child(div().absolute().top(0).left(-x).w(contentW).h(h).children([].concat(content))))
      .when(maxX > 0, (e) => e.child(div().id(`${id}-hbar`).tooltip("Scroll bar for the picture").w(viewW).h(10).relative().rounded(5).bg(t.raised)
        .child(div().id(`${id}-thumb`).tooltip("Drag to scroll the picture sideways").absolute().top(1).left(Math.round((x / contentW) * viewW)).w(Math.max(30, Math.round((viewW * viewW) / contentW))).h(8).rounded(4).bg(t.muted).cursor_pointer()
          .on_mouse_down("left", (ev, cx) => { this.hsDrag = { id, x0: ev.position.x, from: x, thumb: true }; cx.stop_propagation(); }))));
  },
  hsWheel(id, e, cx) {
    this.hsDrag = null; // a wheel is never a drag: a press left over from a click must not pull the picture back
    const s = this.hsOf(id), r = wheelStep(this.gesture, { dx: e.delta?.x ?? 0, dy: e.delta?.y ?? 0, t: Date.now(), phase: e.touch_phase, shift: Boolean(e.modifiers?.shift) }, s.x, s.maxX);
    this.gesture = r.g;
    if (!r.used) return;
    s.x = r.x; cx.stop_propagation();
    // One render per frame at most: a trackpad sends more events than frames.
    if (!this.hsFlush) { this.hsFlush = true; cx.timer.after(16, (cx) => { this.hsFlush = false; cx.notify(); }); }
  },
  // A drag on a picture (pan) or its thumb, from the root's mouse move; the root's mouse up ends it.
  // A press on a picture starts a drag that the root's mouse-up ends. A click on a card, a call or a mark inside the
  // picture stops its mouse-up from reaching the root (cx.stop_propagation in its on_click), so the drag would stay
  // and every later mouse move would pull the picture back to where it was clicked: jumpTo, secCard and the wheel
  // end it.
  hsMove(e, cx) {
    const p = this.hsDrag, s = p && this.hs?.get(p.id);
    if (!s) return;
    const d = e.position.x - p.x0;
    s.x = Math.max(0, Math.min(s.maxX, p.thumb ? p.from + (d * s.contentW) / (s.visW || 1) : p.from - d)); cx.notify();
  },

  // The two deep looks, side by side on a fresh review: the analysis (understanding) and the code review (findings).
  startCards(t) {
    const m = model(), cr = this.find.runs.claude ?? {};
    const card = (id, label, what, click, busy) => v_flex().id(id).flex_1().min_w(0).gap(6).p(12).rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(div().id(`${id}-go`).flex_none().px(12).h(30).flex().items_center().justify_center().rounded(8).text_size(TYPE.body).font_semibold().bg(busy ? t.raised : t.solid)
        .text_color(busy ? t.muted : t.solid_foreground).cursor_pointer().on_click(click).child(busy ? `${label}…` : label))
      .child(div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(what));
    return h_flex().gap(12).items_start()
      .child(card("rv-start-ai", `Analyze with ${modelLabel(m)}`, `Understand the change: layers in reading order, pictures, sample values and a walkthrough. ${this.estimate(m)}.`, (_e, cx) => this.loadAi(cx, "run"), Boolean(this.aiBusy)))
      .child(card("rv-start-cr", "Run Claude code review", "Find problems: bugs and risks as findings on their lines, each with Fix and Verify.", (_e, cx) => this.runReviewer("claude", cx), Boolean(cr.busy)));
  },

  // ---- Ask about this (review.py main_ask, "Review: architecture question"): a question on the picture, a node or a
  // layer; the answer lights its nodes and edges (the focus mechanism) and links its evidence. One thread per PR.

  deepKey() { return this.exMode ? (this.ex?.id ? `explore:${this.ex.id}` : null) : this.prSel?.url ?? null; },
  // What a question is about: on the Architecture page the focused card (else the whole picture); else what was picked
  // to ask about (a layer), else the selected lines in the diff.
  askFocus() {
    if (this.tab === "steps" && this.page === "arch") return this.archFocus ? { node: this.archFocus } : null;
    if (this.askAbout) return this.askAbout;
    const a = this.fsel && this.selAnchor();
    return a ? { range: { file: this.fsel.path, start: a.start, end: a.end, old: a.old } } : null;
  },
  askLabel(scope) {
    return scope.kind === "node" ? scope.node.label ?? scope.node.id : scope.kind === "layer" ? plain(scope.layer.title) : scope.kind === "range" ? rangeLabel(scope.range) : "the architecture";
  },

  // ---- Show details (review.py main_drill, "Review: drill down"): a card or a layer from the inside, a sub-diagram
  // inline under the picture with a breadcrumb; its cards open further. Cached per node path and diff head (deep.json).

  layerSubject(s) {
    const files = this.filesOf ? this.filesOf(s) : [];
    return { id: `layer:${stepKey(s)}`, label: plain(s.title), kind: "layer", why: plain(s.why), text: s.text, files, evidence: s.evidence ?? [], hunks: s.hunks };
  },
  drillCacheKey(stack) { return drillKey(this.deepKey(), this.headNow?.() ?? this.head ?? "", stack); },
  drillResult(stack) { return this.deep.drills?.[this.drillCacheKey(stack)] ?? null; },
  // Drill-downs per place (from: a layer, "arch:<card id>"), each with its own stack: several run at once, and each
  // place shows its own when you come back to it. fresh: start at the item (a card's Explain), not one level deeper.
  drillAt(from) { return (this.drills ??= new Map()).get(from) ?? null; },
  setDrill(from, stack) { if (stack?.length) (this.drills ??= new Map()).set(from, { from, stack }); else this.drills?.delete(from); },
  showDetails(item, from, cx, force = false, fresh = false) {
    const stack = drillPush(fresh ? [] : this.drillAt(from)?.stack ?? [], item);
    this.setDrill(from, stack);
    if (force || !this.drillResult(stack)) this.runDrill(cx, from);
    cx.notify();
  },
  runDrill(cx, from) {
    const d = this.drillAt(from), ai = this.ai, key = this.deepKey(), busy = (this.drillsBusy ??= new Set()), errs = (this.drillErrs ??= new Map());
    if (!d || !ai) return;
    const top = d.stack.at(-1), ck = this.drillCacheKey(d.stack), root = d.from.startsWith("arch") ? "Architecture" : plain(d.stack[0]?.label ?? "Layer");
    if (busy.has(ck)) return;
    const subject = { ...top, parent: d.stack.length > 1 ? d.stack.at(-2).label : null };
    const scope = top.kind === "node" ? scopeOf(ai, { node: top.id }) : top.kind === "layer" ? { kind: "layer", layer: { title: top.label, why: top.why, text: top.text, visuals: [], evidence: top.evidence } }
      : { kind: "node", node: { id: top.id, label: top.label, evidence: top.at ?? null }, edges: [] };
    const files = [...new Set([...(top.files ?? []), ...scopeFiles(scope)])];
    const req = { drill: { label: top.label, path: crumbs(d.stack, root).map((c) => c.label), subject }, model: model(), context: this.ctxReq(), root: this.lspRoot(), explore: Boolean(ai.explore),
      analysis: { title: ai.title, summary: ai.summary, layers: ai.steps.filter((x) => !x.pseudo).map((x) => ({ title: plain(x.title), why: plain(x.why) })) },
      picture: pictureOf(ai.arch), scope, hunks: hunksFor(files, this.exMode ? [] : this.hunks, top.hunks ?? []) };
    busy.add(ck); errs.delete(ck);
    cx.spawn(async (cx) => {
      const r = await exec("python3", [`${appHome()}/mods/pr-review/review.py`, JSON.stringify(req)], { timeout: 600000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      busy.delete(ck);
      if (this.deepKey() !== key) return;
      if (r.code !== 0) { errs.set(ck, `Could not show details: ${(r.stderr || r.stdout).trim().slice(0, 200)}`); return cx.notify(); }
      const out = JSON.parse(r.stdout);
      this.updateDeep(cx, (doc) => ({ ...doc, drills: cachePut(doc.drills, ck, { ...mapDrill(out.answer), cost: out.cost }) }));
      cx.notify();
    });
  },
  // The sub-diagram under the picture (or the layer): breadcrumb (click a level to go back), the summary, the picture
  // with sample values, its cards to open further, Refresh and ✕.
  drillPanel(t, from) {
    const d = this.drillAt(from);
    if (!d) return div();
    const res = this.drillResult(d.stack), ck = this.drillCacheKey(d.stack), root = from.startsWith("arch") ? "Architecture" : "Layer", top = d.stack.at(-1);
    const busy = this.drillsBusy?.has(ck), err = this.drillErrs?.get(ck);
    const crumb = (c, k) => div().id(`rv-crumb-${k}`).flex_none().text_size(TYPE.small).text_color(c.depth === null ? t.muted : k === crumbs(d.stack, root).length - 1 ? t.foreground : t.accent)
      .when(c.depth !== null && k < crumbs(d.stack, root).length - 1, (e) => e.cursor_pointer().tooltip("Go back to this level").on_click((_e, cx) => { this.setDrill(from, c.depth === 0 ? null : drillTo(d.stack, c.depth)); cx.notify(); }))
      .child(c.label);
    return v_flex().id(`rv-drill-${from}`).gap(8).p(12).rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().flex_wrap().gap(6).items_center()
        .children(crumbs(d.stack, root).flatMap((c, k) => (k ? [div().text_color(t.dim).text_size(TYPE.small).child("›"), crumb(c, k)] : [crumb(c, k)])))
        .child(div().flex_1())
        .child(busy ? h_flex().gap(6).text_size(TYPE.small).text_color(t.muted).child(div().child(SPIN[0]).frames(SPIN, 90)).child("Reading the code…")
          : pill(`rv-drill-re-${from}`, t, "↻ Refresh", (_e, cx) => { this.runDrill(cx, from); cx.notify(); }).tooltip("Run the model call again for a fresh answer"))
        .child(pill(`rv-drill-x-${from}`, t, "✕", (_e, cx) => { this.setDrill(from, null); cx.notify(); }).tooltip("Close the details").accessibility_label("Close details")))
      .when(Boolean(err), (e) => e.child(div().text_size(TYPE.small).text_color(t.ansi1).whitespace_normal().child(err)))
      .when(!res && !busy && !err, (e) => e.child(div().text_size(TYPE.small).text_color(t.muted).child(`One ${modelLabel(model())} call opens up ${top.label}.`)))
      .when(Boolean(res), (e) => e.child(div().text_size(TYPE.body).line_height(1.5).child(TextView.markdown(`rv-drill-s-${from}-${d.stack.length}-${top.id}`, res.summary || "")))
        .child(visualCard(res.visual, t, `rv-drill-v-${from}`, (at, cx) => this.jumpTo(at, cx)))
        .when(res.visual.nodes.length > 0, (x) => x.child(h_flex().flex_wrap().gap(4).items_center().child(div().text_size(TYPE.small).text_color(t.muted).child("Open further:"))
          .children(res.visual.nodes.map((n) => pill(`rv-drill-n-${from}-${n.id}`, t, n.label, (_e, cx) => this.showDetails({ id: `${top.id}/${n.id}`, label: n.label, at: n.at, kind: "sub", note: n.note }, from, cx)).tooltip("Show details of this part: one more model call"))))));
  },

  // ---- Explore: a topic walked through in existing code (explore.py, "Explore: walkthrough"), shown like an analysis
  // without a diff: Overview, Layers, Architecture; Files lists the places it cites (the read-only file view, with
  // go-to-definition). Ask and Show details work as for a PR. Explorations are kept per repo and topic (the newest 20).

  async loadExploreIndex(cx) {
    const doc = JSON.parse(await readTextFile(`${exploreDir()}/index.json`).catch(() => null) ?? "[]");
    this.exIndex = Array.isArray(doc) ? doc : []; cx.notify();
  },
  // The repo a new exploration starts in: the one chosen, else the active space's (its git root).
  async exploreRoot(dir) {
    const r = dir ? await exec("git", ["-C", dir, "rev-parse", "--show-toplevel"]).catch(() => null) : null;
    const root = r?.code === 0 ? r.stdout.trim() : dir;
    const remote = root ? await exec("git", ["-C", root, "remote", "get-url", "origin"]).catch(() => null) : null;
    const repo = repoOfRemote(remote?.code === 0 ? remote.stdout : ""); // only a github.com remote names a repo
    return { root, repo };
  },
  // Your own repos are trusted (a github.com repo whose owner is your gh login, or a repo or folder you trusted); a
  // folder without a github.com remote starts in Restricted Mode, as PRs by someone else do.
  exploreTrusted(ex = this.ex) {
    return exploreTrust({ repo: ex?.repo ?? null, root: ex?.root ?? null, login: shared("gh.login"), trustedRepos: shared("pr-review.trustedRepos") ?? [], trustedRoots: shared("pr-review.trustedRoots") ?? [] });
  },
  applyExploreTrust() { if (this.ex?.root) setTrusted(this.ex.root, this.exploreTrusted()); },
  enterExplore(ex, cx) {
    if (!this.exMode) { this.prAiSaved = this.ai; this.exMode = true; }
    this.exStart = ex; this.ai = this.exAi ?? null;
    if (!this.exIndex) { this.exIndex = []; cx.timer.after(0, (cx) => this.loadExploreIndex(cx)); }
    // Back from the minimized chip: the repo, the topic typed, the last error, and a run that went on meanwhile (its
    // status file is read at once: it may have ended). Once per entry (its `at`): shared state comes as a new object
    // with every read, so this runs in every render.
    if (ex.exRoot && !this.exRoot) this.exRoot = ex.exRoot;
    if (this.exTaken !== ex.at) {
      this.exTaken = ex.at;
      if (typeof ex.draft === "string" && ex.draft && !this.exTopic.value()) this.exTopic.set_value(ex.draft);
      if (ex.err && !this.exErr && !this.exBusy) { this.exErr = ex.err; this.exDetail = ex.detail ?? null; }
      if (ex.busy && !this.exBusy) { this.exBusy = ex.busy; this.exErr = null; this.pollExplore(cx, 0); }
    }
    if (ex.start && !this.exRoot) {
      cx.timer.after(0, (cx) => cx.spawn(async (cx) => {
        const dir = ex.root ?? spaces().find((x) => x.id === ex.space)?.folder ?? spaces().find((x) => x.active)?.folder ?? null;
        this.exRoot = await this.exploreRoot(dir); cx.notify();
      }));
    }
  },
  // Minimize in Explore, as in a review: back to the chats with the page kept as one entry at the top. What only this
  // view holds goes into the entry: the topic typed, the repo, a run that is going (it is its own process and goes
  // on), the last error. Resume (the chip) opens the page with all of it.
  minimizeExplore() {
    const ex = shared("review.explore");
    if (!ex) return;
    setShared("review.minimized", { explore: { ...ex, draft: this.exTopic.value(), exRoot: this.exRoot ?? null, busy: this.exBusy ?? null, err: this.exErr ?? null, detail: this.exDetail ?? null }, at: Date.now() });
    leave();
  },
  leaveExplore() { if (this.exMode) { this.exMode = false; this.ai = this.prAiSaved ?? null; this.defFile = null; this.drills = null; } },
  chooseExploreRepo(cx) {
    cx.spawn(async (cx) => { const dir = await pickFolder({ prompt: "Repository to explore" }); if (dir) { this.exRoot = await this.exploreRoot(dir); cx.notify(); } });
  },
  runExplore(cx) {
    const topic = this.exTopic.value().trim(), r = this.exRoot, m = model();
    if (!topic || !r?.root || this.exBusy) return;
    const id = exploreId(r.root, topic), out = `${exploreDir()}/${id}.json`, status = `${out}.status`;
    const ctx = C.spaceContext(ctxDoc(), this.exStart?.space ?? focused()?.space);
    const req = { root: r.root, repo: r.repo, topic, model: m, context: this.ctxReq(ctx), out, status };
    this.exBusy = { id, topic, model: m, started: Date.now(), status, out, ctx }; this.exErr = null; this.exDetail = null; this.exDetailOpen = false;
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", exploreDir()]).catch(() => null);
      const reqFile = `${out}.req.json`, before = await readTextFile(reqFile).catch(() => null);
      await writeTextFile(reqFile, JSON.stringify(req), before).catch(() => null);
      await exec("sh", ["-c", 'nohup python3 "$0" "$1" >/dev/null 2>&1 &', `${appHome()}/mods/pr-review/explore.py`, `@${reqFile}`]).catch((e) => { this.exErr = String(e); this.exBusy = null; });
      this.pollExplore(cx); cx.notify();
    });
    cx.notify();
  },
  pollExplore(cx, wait = 5000) {
    cx.timer.after(wait, (cx) => cx.spawn(async (cx) => {
      const b = this.exBusy;
      if (!b) return;
      const st = JSON.parse(await readTextFile(b.status).catch(() => null) ?? "null");
      if (!st || st.busy) { cx.notify(); return this.pollExplore(cx); }
      this.exBusy = null;
      if (st.error) { this.exErr = st.error; this.exDetail = st.detail ?? null; return cx.notify(); } // the sentence (llm.py failure); what the CLI printed behind "Details"
      const entry = { id: b.id, topic: b.topic, root: this.exRoot.root, repo: this.exRoot.repo, model: b.model, ctx: b.ctx, at: Date.now() };
      const before = await readTextFile(`${exploreDir()}/index.json`).catch(() => null), next = exploreIndex(before ? JSON.parse(before) : [], entry);
      await writeTextFile(`${exploreDir()}/index.json`, JSON.stringify(next.list, null, 1), before).catch(() => null);
      for (const old of next.dropped) exec("rm", ["-f", `${exploreDir()}/${old}.json`, `${exploreDir()}/${old}.json.status`, `${exploreDir()}/${old}.json.req.json`]).catch(() => null);
      this.exIndex = next.list;
      this.openExploration(b.id, cx);
    }));
  },
  openExploration(id, cx) {
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${exploreDir()}/${id}.json`).catch(() => null);
      if (!text) { this.exErr = "That exploration is gone"; return cx.notify(); }
      const entry = (this.exIndex ?? []).find((x) => x.id === id) ?? {};
      this.exAi = exploreAi(JSON.parse(text));
      this.ex = { id, root: this.exAi.root, repo: this.exAi.repo, topic: this.exAi.topic, ctx: entry.ctx ?? null };
      this.ai = this.exAi; this.page = "overview"; this.tab = "steps"; this.defFile = null; this.drills = null; this.archFocus = null;
      this.applyExploreTrust();
      setShared("review.explore", { id, topic: this.ex.topic, repo: this.ex.repo, root: this.ex.root, at: Date.now() });
      cx.notify();
    });
  },
  // A cited file in the read-only view at a line (go-to-definition works there: the repo is local).
  openExploreFile(path, line, cx) {
    const root = this.ex?.root;
    if (!root || !path) return;
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${root}/${path}`).catch(() => null);
      if (text === null) { this.note = `Could not open ${path}`; return cx.notify(); }
      const all = text.replace(/\n$/, "").split("\n"), from = Math.max(0, line - 3000), lines = all.slice(from, from + 6000).map(expandTabs);
      this.defFile = { path, line, from, lines, spans: highlightLines(lines, langOf(path, all[0]), `explore:${root}:${path}:${from}`) };
      this.lists.def.scroll_to_item(Math.max(0, line - from - 1), "center"); // as in goDef
      cx.notify();
    });
  },

  // The bar in Explore: back, the topic, the repo, Restricted Mode, a new topic.
  renderExploreBar(ex) {
    const t = theme(), title = ex.topic ? `Explore: ${ex.topic}` : "Explore a topic", trusted = this.exploreTrusted(ex);
    return h_flex().id("rv-bar").size_full().pl(84).pr(16).gap(12).items_center().bg(t.chrome).text_color(t.foreground).text_size(TYPE.body)
      .child(pill("rv-back", t, "← Back", () => { setShared("review.explore", null); if (!shared("review.target")) leave(); }).tooltip("Leave Explore and return to the previous layout (Esc)").flex_none())
      .child(pill("rv-min", t, "▁ Minimize", () => run("pr-review.explore-min")).flex_none()
        .tooltip("Go back to your chats and keep this page as one entry at the top: the topic, a run that is going and its result stay; open it from there"))
      .child(div().id("rv-title").flex_1().min_w(0).truncate().font_semibold().text_size(TYPE.title).tooltip(title).child(title))
      .when(Boolean(ex.repo), (e) => e.child(div().id("rv-ex-repo").tooltip("The repository being explored").flex_none().text_size(TYPE.small).text_color(t.muted).child(ex.repo)))
      .when(Boolean(ex.id) && !trusted, (e) => e.child(div().id("rv-ex-trust-wrap").flex_none().tooltip("Restricted Mode: language servers run nothing from this code, so go-to-definition may find less. Trust it only if it is yours.")
        .child(pill("rv-ex-trust", t, ex.repo ? `Restricted Mode · Trust ${ex.repo}` : "Restricted Mode · Trust folder", () => run("pr-review.trust-repo"), false, t.ansi3))))
      .when(Boolean(ex.id), (e) => e.child(pill("rv-ex-new", t, "New topic", () => setShared("review.explore", { start: true, root: ex.root, at: Date.now() })).tooltip("Start another exploration").flex_none()));
  },

  renderExplore(cx, ex, root) {
    const t = theme();
    if (!ex.id || ex.start) return root.child(this.exploreStart(t));
    if (!this.exAi || this.ex?.id !== ex.id) { if (this.exOpening !== ex.id) { this.exOpening = ex.id; cx.timer.after(0, (cx) => this.openExploration(ex.id, cx)); } return root.child(div().p(20).text_color(t.muted).child("Opening…")); }
    const ai = this.exAi, files = ai.files ?? [], tab = this.tab === "files" ? "files" : "steps";
    const tabBtn = (id, label) => div().id(`rv-tab-${id}`).tooltip(id === "files" ? "The files this walkthrough cites" : "The walkthrough's layers, in reading order").flex_1().h(32).flex().items_center().justify_center().rounded(7).text_size(TYPE.body).cursor_pointer()
      .bg(tab === id ? t.selected : t.chrome).text_color(tab === id ? t.foreground : t.muted).on_click((_e, cx) => { this.tab = id; cx.notify(); }).child(label);
    const nav = (k, label) => h_flex().id(`rv-exnav-${k}`).tooltip(`Open the ${label} page`).flex_none().h(30).px(10).items_center().rounded(7).cursor_pointer().when(this.page === k, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.page = k; this.defFile = null; cx.notify(); }).child(div().text_size(TYPE.body).font_semibold().text_color(this.page === k ? t.foreground : t.muted).child(label));
    const left = tab === "files"
      ? v_flex().id("rv-exfiles").flex_1().min_h(0).overflow_y_scroll().p(8).gap(2).child(div().px(6).pb(4).text_size(TYPE.small).text_color(t.muted).child(`${files.length} files the walkthrough cites`))
        .children(files.map((f) => h_flex().id(`rv-exf-${f.path}`).tooltip("Open this file at the line the walkthrough cites").gap(8).px(8).h(28).items_center().rounded(6).cursor_pointer().when(this.defFile?.path === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.openExploreFile(f.path, f.lines[0] ?? 1, cx))
          .child(div().flex_1().min_w(0).truncate().text_size(TYPE.body).child(f.path)).child(div().flex_none().text_size(TYPE.small).text_color(t.muted).child(f.lines.slice(0, 3).map((l) => `:${l}`).join(" ")))))
      : v_flex().id("rv-exlayers").flex_1().min_h(0).overflow_y_scroll().p(8).gap(4)
        .child(nav("overview", "Overview")).child(nav("arch", "Architecture"))
        .child(div().pt(8).px(10).text_size(TYPE.small).font_semibold().text_color(t.muted).child("LAYERS"))
        .children(ai.steps.map((s, i) => v_flex().id(`rv-exl-${i}`).px(10).tooltip("Open this layer of the walkthrough").py(8).gap(2).rounded(8).cursor_pointer().when(this.page === `layer:${i}`, (e) => e.bg(t.selected)).hover((x) => x.bg(t.hover))
          .on_click((_e, cx) => { this.page = `layer:${i}`; this.cur = i; this.defFile = null; cx.notify(); })
          .child(h_flex().gap(8).child(div().w(18).flex_none().text_color(t.muted).child(String(i + 1))).child(div().flex_1().min_w(0).truncate().text_size(TYPE.title).font_semibold().child(plain(s.title))))
          .child(div().pl(26).text_size(TYPE.small).text_color(t.muted).truncate().child(plain(s.why)))));
    const page = this.defFile ? this.defView(t) : div().flex_1().min_h(0).relative()
      .child(v_flex().id(`rv-expage-${this.page}`).absolute().inset_0().overflow_y_scroll().px(24).py(18).gap(14)
        .child(this.page === "arch" ? this.archPage(t) : this.page?.startsWith("layer:") ? this.exploreLayer(t, Number(this.page.slice(6))) : this.exploreOverview(t)))
      .child(Scrollbar.vertical(`rv-expage-${this.page}`).absolute().inset_0());
    return root
      .child(h_flex().flex_1().min_h(0)
        .child(v_flex().w(this.leftW()).flex_none().h_full().bg(t.chrome)
          .child(h_flex().flex_none().p(8).gap(6).border_b(1).border_color(t.border).child(tabBtn("files", `Files · ${files.length}`)).child(tabBtn("steps", `Layers · ${ai.steps.length}`)))
          .child(left))
        .child(this.splitter(t))
        .child(v_flex().flex_1().min_w(0).h_full().relative()
          .child(div().id("rv-probe").absolute().top(-100).font_family(settings().font_family ?? "JetBrains Mono").text_size(TYPE.code).whitespace_nowrap()
            .on_size_change((size, cx) => { const w = size.width / PROBE.length; if (w > 0 && Math.abs((this.charW ?? 0) - w) > 0.01) { this.charW = w; cx.notify(); } }).child(PROBE))
          .child(page)
          .when(Boolean(this.note), (e) => e.child(noteBar(this, t, cx)))
          .when(this.drawerState() === "open", (e) => e.child(div().absolute().top(0).right(0).bottom(0).child(this.askDrawer(t))))
          .when(this.drawerState() === "collapsed", (e) => e.child(div().absolute().top(0).right(0).bottom(0).child(this.drawerStrip(t))))));
  },

  exploreOverview(t) {
    const ai = this.exAi;
    return v_flex().gap(14).max_w(1000)
      .child(div().text_size(TYPE.small).text_color(t.muted).child(`${modelLabel(ai.model) ?? ai.model ?? ""}${ai.cost != null ? ` · $${Number(ai.cost).toFixed(3)}` : ""}${ai.budget ? ` of $${ai.budget} cap` : ""} · ${ago(ai.generated)} · ${ai.repo ?? ai.root}`))
      .child(div().text_size(TYPE.page).font_semibold().line_height(1.3).whitespace_normal().child(ai.title || ai.topic))
      .child(div().text_size(TYPE.title).line_height(1.5).whitespace_normal().child(TextView.markdown(`rv-exs-${ai.generated}`, ai.summary || "")))
      .child(h_flex().gap(8).child(pill("rv-ex-ask", t, "Ask about this", (_e, cx) => this.setDrawer("open", cx, null)).tooltip("Ask one model question about this exploration")).child(pill("rv-ex-arch", t, "Architecture", (_e, cx) => { this.page = "arch"; cx.notify(); }).tooltip("Open the architecture picture")))
      .when(ai.intent?.length > 0, (e) => e.child(v_flex().gap(4).child(div().text_size(TYPE.small).font_semibold().text_color(t.muted).child("QUESTION")).child(this.statements(t, ai.intent, "rv-exq"))))
      .when(ai.behaviorPoints?.length > 0, (e) => e.child(v_flex().gap(4).child(div().text_size(TYPE.small).font_semibold().text_color(t.muted).child("HOW IT WORKS")).child(this.statements(t, ai.behaviorPoints, "rv-exh"))))
      .child(v_flex().gap(4).child(div().text_size(TYPE.small).font_semibold().text_color(t.muted).child("LAYERS, IN READING ORDER"))
        .children(ai.steps.map((s, i) => h_flex().id(`rv-exo-${i}`).tooltip("Open this layer of the walkthrough").gap(8).p(6).rounded(6).cursor_pointer().hover((x) => x.bg(t.hover)).on_click((_e, cx) => { this.page = `layer:${i}`; cx.notify(); })
          .child(div().w(18).flex_none().text_color(t.muted).child(String(i + 1))).child(div().flex_1().min_w(0).whitespace_normal().text_size(TYPE.body).child(`${plain(s.title)}: ${plain(s.why)}`)))));
  },

  exploreLayer(t, i) {
    const s = this.exAi.steps[i];
    if (!s) return div();
    return v_flex().gap(12).max_w(1000)
      .child(div().text_size(TYPE.page).font_semibold().whitespace_normal().child(`${i + 1}. ${plain(s.title)}`))
      .child(div().text_size(TYPE.title).text_color(t.muted).whitespace_normal().child(plain(s.why)))
      .child(div().text_size(TYPE.title).line_height(1.5).child(TextView.markdown(`rv-exl-${this.exAi.generated}-${i}`, s.text || "")))
      .when((s.evidence ?? []).length > 0, (e) => e.child(h_flex().flex_wrap().gap(6).children(s.evidence.map((ev, k) => pill(`rv-exev-${i}-${k}`, t, `${ev.split("/").pop()} ↗`, (_e, cx) => this.jumpTo(ev, cx)).tooltip("Open the cited code")))))
      .child(h_flex().gap(6).child(pill(`rv-exask-${i}`, t, "Ask about this layer", (_e, cx) => this.setDrawer("open", cx, { layer: this.exAi.steps.indexOf(s) })).tooltip("Ask one model question about this layer; the answer stays private"))
        .child(pill(`rv-exdrill-${i}`, t, "Show details", (_e, cx) => this.showDetails({ id: `layer:${i}`, label: plain(s.title), kind: "layer", why: plain(s.why), text: s.text, files: (s.evidence ?? []).map(pathOf), evidence: s.evidence ?? [] }, `exlayer:${i}`, cx)).tooltip("One model call breaks this layer down further")))
      .child(this.drillPanel(t, `exlayer:${i}`))
      .when(s.visuals?.length > 0, (e) => e.child(div().w_full().child(visualsCard(s.visuals, t, `rv-exvis-${i}`, (at, cx) => this.jumpTo(at, cx), this.visTab?.[`x${i}`] ?? 0, (k, cx) => { this.visTab = { ...this.visTab, [`x${i}`]: k }; cx.notify(); }, this.wrapX()))))
      .children((s.flows ?? []).map((f, k) => div().max_w(760).child(flowCard(f, t, `rv-exflow-${i}-${k}`, (_e, cx) => { this.jumpTo(f.at, cx); cx.stop_propagation(); }))));
  },

  // Start: the repo (the active space's, or any folder), the topic, the model with its cap, the explorations so far.
  exploreStart(t) {
    const r = this.exRoot, m = model(), busy = this.exBusy;
    return v_flex().id("rv-exstart").flex_1().min_h(0).overflow_y_scroll().items_center().py(40)
      .child(v_flex().w(640).gap(14)
        .child(div().text_size(TYPE.page).font_semibold().child("Explore a topic"))
        .child(div().text_size(TYPE.body).text_color(t.muted).whitespace_normal().child("For code you don't know: ask how something works and get a walkthrough of the existing code, like a PR analysis without a diff: the question, how it works, layers in reading order, the architecture, pictures and sample values, each with file:line."))
        .child(h_flex().gap(8).items_center().text_size(TYPE.body)
          .child(div().flex_none().text_color(t.muted).child("Repository"))
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(r?.root ? `${r.repo ?? r.root.split("/").pop()} · ${r.root.replace(home(), "~")}` : "Finding the active space's repo…"))
          .child(pill("rv-ex-pick", t, "Choose folder…", (_e, cx) => this.chooseExploreRepo(cx)).tooltip("Pick another folder to explore")))
        .child(div().id("rv-ex-topic").tooltip("Your topic or question about this code; Enter starts the walkthrough").h(36).px(10).flex().items_center().rounded(8).border_1().border_color(t.accent).bg(t.background).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.exTopic).h_full().text_size(TYPE.title).text_color(t.foreground)))
        .child(h_flex().gap(10).items_center()
          .child(modelPills(t, "rv-ex-m"))
          .child(div().text_size(TYPE.small).text_color(t.muted).child(`cap $${CAP[tierOf(m)]}`))
          .child(div().flex_1())
          .child(div().id("rv-ex-go").tooltip("One model call walks through the code for this topic; the cost is capped").px(14).h(32).flex().items_center().rounded(8).text_size(TYPE.body).font_semibold().bg(busy ? t.raised : t.solid).text_color(busy ? t.muted : t.solid_foreground)
            .cursor_pointer().on_click((_e, cx) => this.runExplore(cx)).child(busy ? "Exploring…" : "Explore")))
        .when(Boolean(busy), (e) => e.child(h_flex().gap(8).items_center().text_size(TYPE.body).text_color(t.muted).child(div().child(SPIN[0]).frames(SPIN, 90))
          .child(`${modelLabel(busy.model)} is reading the code · ${clock(Date.now() - busy.started)} · cap $${CAP[tierOf(busy.model)]}`)))
        // A run that gave no answer: what happened and what to do, in one sentence (llm.py failure), with Retry and
        // the model's choice beside it; what the CLI printed only behind "Details".
        .when(Boolean(this.exErr), (e) => e.child(v_flex().id("rv-ex-err").gap(8).p(12).rounded(8).border_1().border_color(t.ansi1 + "66").bg(t.ansi1 + "10")
          .child(div().text_size(TYPE.body).text_color(t.foreground).whitespace_normal().line_height(1.45).child(String(this.exErr).replace(/^Explore: walkthrough: /, "")))
          .child(h_flex().flex_wrap().gap(8).items_center()
            .child(pill("rv-ex-retry", t, "Retry", (_e, cx) => this.runExplore(cx), false, t.foreground).tooltip("Run it again, with the model chosen here"))
            .child(modelPills(t, "rv-ex-m2"))
            .child(div().flex_1())
            .when(Boolean(this.exDetail), (x) => x.child(pill("rv-ex-detail", t, this.exDetailOpen ? "Hide details" : "Details", (_e, cx) => { this.exDetailOpen = !this.exDetailOpen; cx.notify(); }).tooltip("What the claude command printed"))))
          .when(Boolean(this.exDetail) && Boolean(this.exDetailOpen), (x) => x.child(div().id("rv-ex-raw").max_h(160).overflow_y_scroll().p(8).rounded(6).bg(t.raised).font_family(settings().font_family ?? "JetBrains Mono")
            .text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(this.exDetail)))))
        .when((this.exIndex ?? []).length > 0, (e) => e.child(div().pt(10).text_size(TYPE.small).font_semibold().text_color(t.muted).child(`EXPLORATIONS · ${this.exIndex.length}`))
          .children(this.exIndex.map((x) => h_flex().id(`rv-exi-${x.id}`).tooltip("Open this saved exploration").gap(8).px(8).h(32).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.openExploration(x.id, cx))
            .child(div().flex_1().min_w(0).truncate().text_size(TYPE.body).child(x.topic))
            .child(div().flex_none().text_size(TYPE.small).text_color(t.muted).child(`${x.repo ?? String(x.root).split("/").pop()} · ${ago(new Date(x.at).toISOString())}`))))));
  },

  // ---- the Ask drawer, one for every view: open (380 px at the right), folded to a 28 px strip, or closed; kept per
  // review. Beside the Architecture page it takes its width from the page (the picture wraps anew, its switches stay
  // in reach); beside the diff it squeezes the diff when there is room (from 1100 px); else it lies on top.
  drawerState() { return this.deep.drawer?.[this.deepKey()] ?? null; },
  setDrawer(state, cx, about) {
    const key = this.deepKey();
    if (about !== undefined) this.askAbout = about;
    if (state === "open") { this.askUnseen = false; cx.timer.after(0, () => this.askIn.focus()); }
    this.updateDeep(cx, (d) => ({ ...d, drawer: { ...d.drawer, [key]: state } }));
    cx.notify();
  },
  // Px of the right column the drawer lies on (not when it squeezes the column): open 380, folded strip 28.
  drawerCover() { const d = this.drawerState(); return d === "open" ? (this.drawerSqueezes() ? 0 : 380) : d === "collapsed" ? 28 : 0; },
  drawerSqueezes() {
    if (this.drawerState() !== "open" || this.exMode) return false; // Explore draws it on top
    if (this.tab === "steps" && this.page) return this.page === "arch";
    return (this.winW ?? 0) - this.leftW() - SPLIT >= 1100;
  },

  askNow(cx) {
    const q = this.askIn.value().trim(), ai = this.ai, key = this.deepKey();
    if (!ai && q) { this.askErr = "Analyze first: answers build on the analysis"; return cx.notify(); }
    if (!q || !ai || !key || this.askBusy) return;
    const scope = scopeOf(ai, this.askFocus()), layer = scope.kind === "layer" ? this.ai.steps.find((s) => plain(s.title) === plain(scope.layer.title)) : null;
    const req = { ask: q, model: model(), context: this.ctxReq(), root: this.lspRoot(), explore: Boolean(ai.explore),
      analysis: { title: ai.title, summary: ai.summary, layers: ai.steps.filter((s) => !s.pseudo).map((s) => ({ title: plain(s.title), why: plain(s.why) })) },
      picture: pictureOf(ai.arch), scope, hunks: hunksFor(scopeFiles(scope), this.exMode ? [] : this.hunks, layer?.hunks ?? []), history: history(threadOf(this.deep.threads, key)) };
    const about = this.askLabel(scope);
    this.askBusy = { q, label: about, started: Date.now() }; this.askErr = null;
    cx.spawn(async (cx) => {
      const r = await exec("python3", [`${appHome()}/mods/pr-review/review.py`, JSON.stringify(req)], { timeout: 600000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      this.askBusy = null;
      if (this.deepKey() !== key) return;
      if (r.code !== 0) { this.askErr = `Could not ask: ${(r.stderr || r.stdout).trim().slice(0, 200)}`; return cx.notify(); }
      const out = JSON.parse(r.stdout), a = mapAnswer(out.answer, ai.arch);
      this.askIn.set_value("");
      const sc = scope.kind === "node" ? { kind: "node", node: { id: scope.node.id } } : scope.kind === "range" ? scope : { kind: scope.kind };
      this.updateDeep(cx, (d) => ({ ...d, threads: threadAdd(d.threads, key, { q, about, a, scope: sc, cost: out.cost }) }));
      if (this.drawerState() !== "open") this.askUnseen = true;
      this.showAnswer(a);
      cx.notify();
    });
    cx.notify();
  },

  // The answer's highlights on the Architecture page: its first node focused, its first edge's badge lit.
  showAnswer(a) {
    if (!this.ai?.arch) return;
    const h = highlightOf(this.archL(), a);
    if (h.focus) this.archFocus = h.focus;
    this.askHl = h.hl;
  },

  // deep.json changed by fn, here and in the file (compare-and-swap: another copy may write it too).
  updateDeep(cx, fn) {
    this.deep = fn(this.deep);
    cx.spawn(async () => {
      await exec("mkdir", ["-p", `${appHome()}/pr-data`]).catch(() => null);
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await readTextFile(deepFile()).catch(() => null), doc = before ? JSON.parse(before) : {};
        try { await writeTextFile(deepFile(), JSON.stringify(fn({ ...doc, threads: doc.threads ?? {}, drills: doc.drills ?? {}, pins: doc.pins ?? {}, drawer: doc.drawer ?? {} })), before); return; } catch { /* written meanwhile: again */ }
      }
    });
  },

  pins() { return pinsOf(this.deep.pins, this.deepKey()); },
  // A code note records what its lines read (STALE once they change, staleNow).
  pin(turn, cx) {
    const key = this.deepKey(), a = pinAnchor(turn), code = a?.file ? codeOf(this.rowsFor(a.file, true), a) : undefined;
    this.updateDeep(cx, (d) => ({ ...d, pins: pinAdd(d.pins, key, turn, Date.now(), code === undefined ? null : { code, head: this.head }) }));
  },
  unpin(id, cx) { const key = this.deepKey(); this.updateDeep(cx, (d) => ({ ...d, pins: pinDrop(d.pins, key, id) })); },
  // A code note: still on a line of the diff, else outdated (kept, shown in the drawer).
  pinOutdated(pin) { const a = pin.anchor; return Boolean(a?.file) && !this.rowsFor(a.file, true).some((r) => atLine(r, a.end, a.old)); },
  // A note (pinned answer) as a turn into a pending comment: the usual flow from there (pending, preview).
  noteToComment(pin, cx) {
    const a = pin.anchor, rows = a?.file ? this.rowsFor(a.file, true) : [], i = rows.findIndex((r) => atLine(r, a.end, a.old));
    if (i < 0) { this.note = "Not turned into a comment: its lines are no longer in the diff"; return cx.notify(); }
    const anchor = selection(rows, Math.max(0, rows.findIndex((r) => atLine(r, a.start, a.old))), i);
    this.comments = [...this.comments, { id: Date.now().toString(36), file: a.file, ...anchor, head: this.head, text: pin.text }]; this.persist(cx);
    this.note = "The note is a pending comment now: it goes out with your review"; cx.notify();
  },

  // The strip a folded drawer leaves: "Ask" down the edge, a dot when an answer came in meanwhile.
  drawerStrip(t) {
    return v_flex().id("rv-drawer-strip").tooltip("Open the Ask drawer").accessibility_label("Open the Ask drawer").w(28).h_full().flex_none().items_center().pt(12).gap(2).border_l(1).border_color(t.border).bg(t.chrome).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.setDrawer("open", cx))
      .children(["A", "s", "k"].map((c) => div().text_size(TYPE.small).font_semibold().text_color(t.muted).child(c)))
      .when(Boolean(this.askUnseen || this.askBusy), (e) => e.child(div().mt(6).w(8).h(8).rounded_full().bg(this.askBusy ? t.ansi3 : t.accent)));
  },

  // The drawer: what it is about, the input, the notes pinned in this review, the thread (newest first).
  askDrawer(t) {
    const ai = this.ai, scope = scopeOf(ai, this.askFocus()), turns = threadOf(this.deep.threads, this.deepKey()).slice().reverse(), id = "rv-drawer";
    const pins = this.pins(), pinned = new Set(pins.map((p) => p.id));
    const chipBtn = (cid, label, color, click) => div().id(cid).flex_none().px(6).py(1).rounded(5).border_1().border_color(color).text_size(TYPE.small).text_color(color)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { click(cx); cx.stop_propagation(); cx.notify(); }).child(label);
    const name = new Map((ai?.arch?.nodes ?? []).map((n) => [n.id, n.label ?? n.id])), edges = pictureOf(ai?.arch).edges;
    const L = ai?.arch ? this.archL() : null, off = new Set(pinsOn(pins, L).off.map((p) => p.id));
    const answer = (tu, k) => v_flex().id(`${id}-t${k}`).gap(6).pt(8).border_t(1).border_color(t.border)
      .child(h_flex().gap(6).items_start().child(div().flex_1().min_w(0).text_size(TYPE.body).font_semibold().whitespace_normal().child(tu.q))
        .child(div().flex_none().max_w(130).truncate().text_size(TYPE.small).text_color(t.muted).child(tu.about ?? "")))
      .child(div().text_size(TYPE.body).line_height(1.5).child(TextView.markdown(`${id}-a${tu.at}`, tu.a.text || "–")))
      .when((tu.a.highlights.nodes.length + tu.a.highlights.edges.length) > 0, (e) => e.child(h_flex().flex_wrap().gap(4)
        .children(tu.a.highlights.nodes.map((n) => chipBtn(`${id}-hn${k}-${n}`, name.get(n) ?? n, t.accent, () => { this.page = "arch"; this.tab = "steps"; this.archFocus = n; }).tooltip("Show this card on the Architecture page")))
        .children(tu.a.highlights.edges.map((x) => { const e = edges.find((y) => y.id === x); return chipBtn(`${id}-he${k}-${x}`, e ? `${name.get(e.from) ?? e.from} → ${name.get(e.to) ?? e.to}` : x, t.accent,
          () => { this.page = "arch"; this.tab = "steps"; this.archFocus = null; this.askHl = highlightOf(this.archL(), { highlights: { nodes: [], edges: [x] } }).hl; }).tooltip("Highlight this link on the Architecture page"); }))))
      .when(tu.a.evidence.length > 0, (e) => e.child(v_flex().gap(2).children(tu.a.evidence.map((ev, j) => h_flex().id(`${id}-ev${k}-${j}`).tooltip("Jump to this code in the diff").gap(6).text_size(TYPE.small).cursor_pointer()
        .on_click((_e, cx) => { this.jumpTo(ev.at, cx); cx.stop_propagation(); })
        .child(div().flex_none().text_color(t.accent).child(`${ev.at.split("/").pop()} ↗`)).child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(ev.why))))))
      .child(h_flex().gap(6).child(pinned.has(`p${tu.at}`) ? chipBtn(`${id}-unpin${k}`, "Pinned · unpin", t.ansi5, (cx) => this.unpin(`p${tu.at}`, cx)).tooltip("Remove this note from the review")
        : pinAnchor(tu) ? chipBtn(`${id}-pin${k}`, tu.scope?.kind === "range" ? "Pin to the code" : "Pin to diagram", t.muted, (cx) => this.pin(tu, cx)).tooltip((tu.scope?.kind === "range" ? "Keep this answer on the code as a private note; it is never sent anywhere" : "Keep this answer on the diagram as a private note; it is never sent anywhere")) : div()));
    const note = (p) => v_flex().id(`${id}-pin-${p.id}`).gap(3).p(8).rounded(6).border_l(3).border_color(t.ansi5).bg(t.ansi5 + "12")
      .child(h_flex().gap(6).items_center().text_size(TYPE.small)
        .child(div().id(`${id}-pv-${p.id}`).tooltip("A pinned answer: a private note, never sent anywhere").flex_none().font_semibold().text_color(t.ansi5).child("Note · private"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(p.anchor.file ? rangeLabel(p.anchor) : name.get(p.anchor.node) ?? p.anchor.node ?? p.anchor.edge))
        .when(off.has(p.id) || this.pinOutdated(p), (e) => e.child(badge(t, off.has(p.id) ? "unattached" : "outdated", t.ansi3).id(`${id}-pst-${p.id}`).tooltip(off.has(p.id) ? "Its card is not on the picture now" : "Its lines are no longer in the diff")))
        .child(chipBtn(`${id}-pinx-${p.id}`, "✕", t.muted, (cx) => this.unpin(p.id, cx)).tooltip("Remove this note").accessibility_label("Remove note")))
      .child(div().text_size(TYPE.small).line_height(1.45).whitespace_normal().child(p.summary))
      .when(Boolean(p.anchor.file), (e) => e.child(h_flex().child(chipBtn(`${id}-pinc-${p.id}`, "Turn into comment", t.foreground, (cx) => this.noteToComment(p, cx)).tooltip("Make this note a pending comment; it goes out only with your review"))));
    return v_flex().id(id).w(380).h_full().flex_none().border_l(1).border_color(t.border).bg(t.surface).shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(v_flex().flex_none().p(10).gap(8).border_b(1).border_color(t.border)
        .child(h_flex().gap(6).items_center().child(div().flex_1().min_w(0).truncate().text_size(TYPE.body).font_semibold().child(`Ask about ${this.askLabel(scope)}`))
          .child(pill(`${id}-fold`, t, "›", (_e, cx) => this.setDrawer("collapsed", cx)).tooltip("Fold to the edge").accessibility_label("Fold the Ask drawer"))
          .child(pill(`${id}-x`, t, "✕", (_e, cx) => this.setDrawer(null, cx)).tooltip("Close (Esc); the thread stays").accessibility_label("Close the Ask drawer")))
        .child(h_flex().gap(6).items_center()
          .child(div().id(`${id}-in`).tooltip("Your question: one model call about the selected code or layer; Enter asks").flex_1().min_w(0).h(30).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).bg(t.background).cursor_text()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.askIn).h_full().text_size(TYPE.body).text_color(t.foreground)))
          .child(this.askBusy ? div().flex_none().child(SPIN[0]).frames(SPIN, 90) : pill(`${id}-go`, t, "Ask", (_e, cx) => this.askNow(cx), false, t.foreground).tooltip("Ask: one model call about the selected code, card or layer (Enter)")))
        .child(div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(`One ${modelLabel(model())} call with the analysis${this.hunks ? ", the diff" : ""} and this thread. Click a card or select lines to ask about them.`)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id(`${id}-scroll`).absolute().inset_0().overflow_y_scroll().p(10).gap(8)
          .when(Boolean(this.askBusy), (e) => e.child(div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(`${this.askBusy.q} · reading…`)))
          .when(Boolean(this.askErr), (e) => e.child(div().text_size(TYPE.small).text_color(t.ansi1).whitespace_normal().child(this.askErr)))
          .when(pins.length > 0, (e) => e.child(div().text_size(TYPE.small).font_semibold().text_color(t.muted).child(`NOTES · ${pins.length}`)).children(pins.map(note)))
          .when(turns.length > 0, (e) => e.child(h_flex().pt(4).items_center().child(div().flex_1().text_size(TYPE.small).font_semibold().text_color(t.muted).child(`THREAD · ${turns.length}`))
            .child(pill(`${id}-clear`, t, "Clear", (_e, cx) => { const key = this.deepKey(); this.updateDeep(cx, (d) => { const th = { ...d.threads }; delete th[key]; return { ...d, threads: th }; }); this.askHl = null; cx.notify(); }).tooltip("Delete this thread of questions and answers; pinned notes stay"))))
          .children(turns.map((tu, k) => answer(tu, k))))
        .child(Scrollbar.vertical(`${id}-scroll`).absolute().inset_0()));
  },

  // Pinned answers on the picture: a note on the card or edge they are about (click: the drawer; ✕: unpin).
  pinNotes(t, L) {
    return pinsOn(this.pins(), L).on.map(({ pin, x, y, w }) => h_flex().id(`rv-pn-${pin.id}`).absolute().left(x).top(y).max_w(w).h(18).px(6).gap(4).items_center().rounded(9)
      .border_1().border_color(t.ansi5).bg(t.background).text_size(TYPE.micro).text_color(t.foreground).cursor_pointer().tooltip(pin.text.slice(0, 600))
      .on_click((_e, cx) => { this.setDrawer("open", cx); cx.stop_propagation(); })
      .child(div().flex_none().text_color(t.ansi5).child("✎")).child(div().min_w(0).truncate().child(`${pin.summary}${pin.evidence ? ` · ${pin.evidence.split("/").pop()}` : ""}`))
      .child(div().id(`rv-pnx-${pin.id}`).tooltip("Remove this note").accessibility_label("Remove note").flex_none().text_color(t.muted).hover((s) => s.text_color(t.foreground)).child("✕").on_click((_e, cx) => { this.unpin(pin.id, cx); cx.stop_propagation(); })));
  },

  // ---- the Security page (key "blast", from its former name), a boundary map (panel-secview): top to bottom a sentence
  // from the data, the trust boundary crossings (views.js crossingsOf: ways in, rights into another zone, calls over a
  // boundary, each with its check, what it holds on and its result, "not assessed" when nothing says), a picture of
  // them by trust zone from three crossings on, the unresolved security findings, the attack surface, what every run
  // says it checked, and the rights granted.
  blastPage(t) {
    // Security findings: ⛨ ones (pr.js isSecurity) and the category's own (a right granted and not used, low).
    const sec = this.findings().filter((f) => f.security || f.category === "security"), open = sec.filter((f) => OPEN_ST.includes(this.fstatus(f)));
    const runs = this.find.runs, sr = runs.security, title = (text) => div().text_size(TYPE.title).font_semibold().child(text);
    const secN = this.counts().security; // the one number: ⛨ findings once per cause (the verdict, the navigation and "Before merge" name the same)
    const secSign = this.pageBadges().blast; // its color and form, as in the navigation
    // The unresolved findings a named threat stands on that are no ⛨ finding (a flood, a script that leaves a guardrail
    // off): listed and marked here too, counted apart ("⛨" stays what pr.js isSecurity says).
    const threats = this.ai?.threats ?? [], cited = threatCited(threats, this.openFindings()).filter((f) => !open.includes(f)), shown = [...open, ...cited];
    const a = this.ai?.arch ?? null, marks = archMarks(a, shown, this.ai?.access, threats), surface = surfaceOf(this.ai?.access);
    // The card a finding sits on (a call it breaks: the calling card).
    const cardOf = new Map([...[...marks.nodes].flatMap(([id, m]) => m.findings.map((f) => [f.id, id])), ...[...marks.edges].flatMap(([i, m]) => m.findings.map((f) => [f.id, a.edges[i].from]))]);
    // The crossings (views.js crossingsOf), with the unresolved findings of every source. A finding stands at one
    // crossing: the row that names it; its head ("reachable from …, over a trust boundary") is built from that row.
    const crossings = this.crossingsNow(), changed = crossings.filter(crossingChanged);
    const rowOf = (f) => crossings.find((r) => r.findings.includes(f)) ?? null;
    // Without a row: the access rows the finding names (stated), else the ways in at its card or line (derived).
    const all = [...surface.entries, ...surface.grants];
    const waysOf = (f) => {
      const stated = (f.reachable_from ?? []).map((id) => all.find((x) => x.id === id)).filter(Boolean);
      return stated.length ? { ways: stated, stated: true } : { ways: surface.entries.filter((x) => (x.node && x.node === cardOf.get(f.id)) || x.at === `${f.file}:${f.line}`), stated: false };
    };
    const LEVEL = { public: "public", operator: "internal_only", authenticated: "authenticated", internal: "internal_only", data: "internal_only" }, zoned = (a?.zones ?? []).length > 0;
    const order = secOrder(shown.map((f) => { const r = rowOf(f); return r ? { f, level: r.kind === "entry" ? "public" : LEVEL[r.from.trust] ?? "unknown", crosses: r.kind !== "bypass" && r.kind !== "operator" }
      : { f, level: reachLevel(f, waysOf(f).ways), crosses: zoned ? (a.edges ?? []).some((e) => e.crosses && !inProcess(e) && e.to === cardOf.get(f.id)) : null }; }));
    const ctx = { open, marks, surface, cardOf, waysOf, rowOf, crossings, why: new Map(order.map((r) => [r.f.id, r.why])), focus: this.blastFocus ?? null, name: (id) => a?.nodes.find((n) => n.id === id)?.label ?? (a?.groups ?? []).find((g) => g.id === id)?.label ?? (id === "internet" ? "Internet" : id),
      // A finding's link to its crossing: that row open in the table above.
      show: (key, cx) => { this.crossOpen = key; this.pageScrolls.blast.scroll_to_item(this.pageParts.indexOf("crossings")); cx.notify(); },
      hover: (id) => (on, cx) => { const v = on ? id : null; if ((this.blastHover ?? null) !== v) { this.blastHover = v; cx.notify(); } } };
    // Where a card's first row is: its first finding, else the crossings (secCard scrolls there).
    this.secPart = (id) => { const f = order.map((r) => r.f).find((x) => cardOf.get(x.id) === id); return f ? `f:${f.id}` : crossings.some((r) => r.ends.to === id || r.ends.from === id) ? "crossings" : null; };
    // Nothing to show: no security run has delivered anything (it does not start by itself for every PR), no finding is
    // about security, and the analysis names no way in, right or trust zone.
    const empty = !sr?.state && !sec.length && !(this.ai?.access ?? []).length && !(a?.zones ?? []).length;
    // Without security data (no security run, no zone, no access row) no picture: the offer to make it (secEmpty, which
    // has the Run button and the reasons), then whatever the other runs found about security.
    const data = sr?.state === "done" || (this.ai?.access ?? []).length > 0 || zoned;
    const head = v_flex().gap(6)
      .on_size_change((_s, cx) => this.loadVisibility(cx)) // once the page is laid out: is the repo public
      .child(h_flex().gap(10).items_center().flex_wrap().child(div().flex_1().text_size(TYPE.page).font_semibold().child("Security"))
        .child(chip(t, h_flex().gap(3).items_center().child(signEl(div, t, secN ? secSign : { color: "muted", form: "quiet" }, "⛨")).child(`Security · ${secN}`), secN ? t[secSign.color] ?? t.ansi1 : t.muted, true, "rv-bl-secn",
          `Unresolved security findings from every source, counted once per cause: access or data, or what a named threat stands on.\n${secSign.tip}`))
        .when(data && sr?.state === "running", (e) => e.child(pill("rv-bl-run", t, "Security review running…", () => {}).tooltip("The security reviewer is reading the PR head"))))
      .when(data && sr?.state !== "running", (e) => e.child(this.runOffer("security", t)))
      // pr.js secNote: a run from before the current rules of the security view; what it left open may be the old prompt's.
      .when(data && sr?.state === "done" && Boolean(secNote(this.ai)), (e) => e.child(div().id("rv-sec-rules").text_size(TYPE.small).text_color(t.ansi3).whitespace_normal().line_height(1.5)
        .child(secOldLine(this.ai, this.taskNow().security) ?? "")))
      // Someone else's PR with reasons (pr.js securityStart offer): why the Run button is there, with its cap.
      .when(data && Boolean(this.secOfferText()), (e) => e.child(div().id("rv-sec-offer").text_size(TYPE.body).whitespace_normal().line_height(1.5).text_color(t.ansi3)
        .child(`${this.secOfferText()} Run security review: capped at $${REVIEW_CAP[tierOf(model())]}.`)));
    if (empty) return [["head", head], ["empty", this.secEmpty(t)]];
    // A picture only from three changed crossings on: below that the table says it all.
    const map = data && a && changed.length >= 3 ? this.secMap(t, a, ctx, changed) : null;
    return [["head", head], ...(data ? [] : [["empty", this.secEmpty(t)]]),
      ...(data ? [["sentence", div().id("rv-sec-sentence").text_size(TYPE.title).line_height(1.5).whitespace_normal().max_w(1000).child(secSentence(crossings, secN, cited.length, asideOf({ arch: a, access: this.ai?.access ?? [] }).guards.filter((g) => g.loosened).length))], ["crossings", this.secCrossings(t, title, crossings)]] : []),
      ...(map ? [["map", map]] : []),
      // Under the map, folded to a line each (sec-view.js): where sensitive data goes, and who may do what.
      ...(data ? this.secPicParts(t, { rows: crossings, show: ctx.show, goTo: (f) => (_e, cx) => { const j = this.pageParts.indexOf(`f:${f.id}`); if (j >= 0) this.pageScrolls.blast.scroll_to_item(j); else { this.openFinding(f); this.jumpTo(`${f.file}:${f.line}`, cx); } cx.stop_propagation(); cx.notify(); } }) : []),
      ["findings", this.secIntro(t, sec, open, cited)], ...order.map(({ f }) => [`f:${f.id}`, this.secFinding(t, f, ctx)]),
      ["scope", this.secScope(t, title)]];
  },
  // The crossings as a picture (from three changed ones on): the trust zones as columns, public → authenticated →
  // internal → data, only the cards at a crossing, each line numbered as its row in the table and labelled with its
  // check and the principal the check expects ("not assessed" dashed); whoever arrives from outside is a card of its
  // own, a right starts at its principal's frame (its first card), a call in one process is a line without "‖". A card
  // the security run says is reachable from further out says so. The finding marks are the architecture map's.
  // ponytail: the columns follow archLayout's order of the calls, which keeps the trust order unless a call runs from
  // an inner zone back out (then it is a stub); operator ways are a column before public.
  secMap(t, a, ctx, rows) {
    // The marks: the findings of this page (⛨ and the ones a threat stands on), not every finding of the PR.
    const marksAll = ctx.marks, eff = this.effZones(a), num = (r) => ctx.crossings.indexOf(r) + 1;
    const key = `${JSON.stringify(rows.map((r) => [r.key, r.result, r.check, num(r)]))}|${[...marksAll.nodes.keys()]}|${[...eff.keys()]}`;
    if (this.secMemo?.key !== key) {
      const { groups, nodes: cards, edges } = secPicture(rows, a, num), nodes = new Map(cards.map((n) => [n.id, n])); // views.js: the same picture as the page's Markdown
      const marks = { nodes: new Map([...marksAll.nodes].filter(([id]) => nodes.has(id))), edges: new Map() };
      // Fit: narrow cards, so the zones fit the page's width more often (the Data column was cut off).
      const args = [{ groups, nodes: [...nodes.values()], edges }, "diff", (n) => (marks.nodes.has(n.id) ? MARK_CARD_ROWS : 0) + (eff.has(n.id) ? 1 : 0), true, { labels: true, lines: () => true }];
      this.secMemo = laidOut(args, { key, marks }, () => this.secMemo, { wait: true, before: this.secMemo?.L }); // what a frame can afford now, the better layout after it (stack.js)
    }
    const { L, marks } = this.secMemo;
    if (!L) return null; // a map too big for the frame: there after its first slice
    // keep: the way of the kind of data chosen under the map (sec-view.js), lit; the rest dimmed.
    const opts = { ...this.archOpts("blast"), marks, numbers: false, zoom: settings().zoom || 1, keep: this.secDataLit(ctx.crossings), onFocus: (id, cx) => { this.fh.focus(); this.secCard(id, cx); } };
    const deco = (n) => (eff.has(n.id) ? [h_flex().flex_none().h(15).child(chip(t, eff.get(n.id).cond ? `${eff.get(n.id).trust[0].toUpperCase()}${eff.get(n.id).trust.slice(1)} if ${eff.get(n.id).cond.replace(/^if crossing /, "")}` : `Reachable as ${eff.get(n.id).trust}`, t.ansi3, false, `rv-sec-eff-${n.id}`, `Drawn in ${eff.get(n.id).zone.name ?? eff.get(n.id).drawn} (${eff.get(n.id).drawn}), but ${eff.get(n.id).why}${eff.get(n.id).cond ? `: reachable as ${eff.get(n.id).trust} ${eff.get(n.id).cond}` : ""}.`))] : []);
    return v_flex().id("rv-sec-map").gap(6)
      .child(h_flex().gap(10).items_center().flex_wrap().text_size(TYPE.small).text_color(t.muted)
        .child("Only the crossings, numbered as in the table, with what goes over them; a dashed line is not assessed.").when(hasTrust(L), (e) => e.child(trustLegend(L, t))))
      .child(this.archCanvas(t, L, opts, { id: "rv-sec-canvas", pic: "rv-sec-pic", decorate: deco, notes: false }));
  },
  // Where a card is really reachable from: the security run's effective zones (derived from its gates); nothing without
  // them (the red ring and "Reachable as" only with data).
  // ... and passed on over calls in one process without a check (views.js passZones), with the way in it hangs on.
  effZones(a) {
    const rows = this.crossingsNow();
    const door = (id) => { const k = rows.findIndex((r) => r.kind === "entry" && r.ends.to === id); return k >= 0 ? `if crossing ${k + 1} fails open` : null; };
    // The data's own (pr.js effectiveZonesOf, passed on already): its where names the crossing that must fail open.
    const eff = effectiveFrom(this.ai?.effectiveZones ?? [], a);
    for (const v of eff.values()) if (v.via?.length && v.where) { const k = rows.findIndex((r) => r.key === `a:${v.where.access}` || (r.aliases ?? []).includes(`a:${v.where.access}`) || r.key === `e:${String(v.where.edge ?? "").replace(/^e/, "")}`); if (k >= 0) v.cond = `if crossing ${k + 1} fails open`; }
    return passZones(eff, a, door); // and for an older run without that
  },
  // The trust boundary crossings as a list (wave C2: like the Resilience paths, nothing cut), the attack surface and the rights included: the changed ones (new,
  // widened, narrowed, removed, or not said), not assessed ones too; the unchanged ones folded to a line. A row: its
  // number, from zone → to zone and what crosses (with "can fail open", "granted, not used", a way in the task does not
  // ask for), who arrives (the access row's principal; "principal not mapped"), the check, where and whom it expects,
  // what it holds on, the change, the result (from threats[] only; "data disagree" when a finding's own place and its
  // threat's differ), the findings it names and the others at the same place ("Also here"). A click opens the way.
  // Under the table: what a compromised frame with a way in can do, from the rights its principal holds.
  secCrossings(t, title, rows) {
    const now = rows.filter(crossingChanged), hidden = rows.length - now.length, shown = [...now, ...(this.crossAll ? rows.filter((r) => !crossingChanged(r)) : [])];
    const RES = { finding: ["Finding", t.ansi1, true], mitigated: ["Mitigated", t.ansi2, false], not_assessed: ["Not assessed", t.muted, false] };
    const KIND = { entry: "Way in", right: "Right", call: "Call", bypass: "In-process call", operator: "Operator way" };
    const na = (x, word = "not assessed") => (x ? x : div().text_color(t.muted).child(word)); // muted, not dim: a word to read ("not named") needs 4.5:1
    // A path names cards, frames (a deployment) and "internet".
    const arch = this.ai?.arch, nodeOf = (id) => arch?.nodes.find((n) => n.id === id), label = (id) => nodeOf(id)?.label ?? (arch?.groups ?? []).find((g) => g.id === id)?.label ?? (id === "internet" ? "Internet" : id);
    // ponytail: an operator's row shares its card with the way in; its "Also here" would repeat that row's.
    const marks = this.archMarksNow(), here = (r) => (r.kind === "operator" ? [] : [...new Set([...(marks.nodes.get(r.ends.to)?.findings ?? []), ...(r.edge !== undefined ? marks.edges.get(r.edge)?.findings ?? [] : [])])].filter((f) => !r.findings.includes(f)));
    const extra = this.secExtra(rows); // a way in this PR opens that the task does not ask for
    const goTo = (f) => (_e, cx) => { const j = this.pageParts.indexOf(`f:${f.id}`); if (j >= 0) this.pageScrolls.blast.scroll_to_item(j); else { this.openFinding(f); this.jumpTo(`${f.file}:${f.line}`, cx); } cx.stop_propagation(); cx.notify(); };
    const flist = (k, list, id, max = 3) => v_flex().gap(2).children(list.slice(0, max).map((f) => h_flex().id(`rv-sec-cr-${id}-${k}-${f.id}`).gap(4).items_start().cursor_pointer().tooltip(plain(f.title)).on_click(goTo(f))
      .child(badge(t, f.severity, t[SEV[f.severity]] ?? t.accent)).child(div().flex_1().min_w(0).whitespace_normal().child(plain(f.title))))).when(list.length > max, (e) => e.child(div().text_color(t.muted).child(`and ${list.length - max} more`)));
    // A finding stands in full at the first crossing that names it; a later one refers to it (views.js crossOnce).
    const once = crossOnce(shown, (r) => rows.indexOf(r) + 1);
    const again = (k, { f, at }) => h_flex().id(`rv-sec-cr-r-${k}-${f.id}`).gap(4).items_center().cursor_pointer().text_color(t.muted).hover((x) => x.text_color(t.foreground)).tooltip(plain(f.title)).on_click(goTo(f))
      .child(div().flex_none().child(`shown at crossing ${at}:`)).child(div().min_w(0).truncate().child(plain(f.title)));
    const dot = (s) => String(s ?? "").replace(/\.+$/, "");
    const strip = (r) => {
      // The way as a chain (views.js wayOf): whoever arrives, each gate on it, this crossing's own gate before its
      // target; the crossing's own ends stand out, the rest of the path is grey (no boundary there).
      const arrow = () => div().text_color(t.muted).child("→");
      const chain = wayOf(r, rows, this.ai?.arch).flatMap((x, k2) => [...(k2 ? [arrow()] : []), x.kind === "gate"
        ? div().px(8).py(2).rounded(6).border_1().border_color(x.own && r.result === "finding" ? t.ansi1 : t.border).when(x.own && r.result === "not_assessed", (y) => y.border_dashed()).text_color(x.own ? t.foreground : t.muted).child(x.text)
        : div().id(`rv-sec-st-${r.key}-${k2}`).px(8).py(2).rounded(6).border_1().border_color(t.border).when(!x.strong, (y) => y.border_dashed()).text_color(x.strong ? t.foreground : t.muted).child(x.text)]);
      const said = (x) => (x && String(x).trim() ? dot(x) : null);
      return v_flex().pl(28).pt(4).gap(4).text_size(TYPE.small).line_height(1.5)
        .child(h_flex().gap(8).items_center().flex_wrap().children(chain))
        .child(r.result === "not_assessed"
          ? div().whitespace_normal().child(`${dot(r.reason)}.${r.carries?.length ? ` What crosses here: ${[].concat(r.carries).join(", ")}.` : ""}`)
          : div().whitespace_normal().child([r.kind !== "bypass" && `Holds only if: ${said(r.holds_if) ?? "not named"}.`, `An attacker controls: ${r.carries?.length ? [].concat(r.carries).join(", ") : "not named"}.`, `At the end they reach: ${said(r.goal) ?? "not named"}.`, `Evidence: ${said(r.evidence) ?? "none named"}.`].filter(Boolean).join(" ")))
        .children(r.conflicts.map((c, j) => div().id(`rv-sec-cr-c-${r.key}-${j}`).whitespace_normal().text_color(t.ansi3).child(`Data disagree: “${dot(c.f.title)}” names ${c.finding.join(", ") || "no way in"}, its threat ${c.threat.join(", ") || "no way in"}; the outer one counts here.`)))
        .children(r.threats.map((x, j) => div().id(`rv-sec-cr-t-${r.key}-${j}`).whitespace_normal().text_color(t.muted).child(`${x.stride ? `STRIDE ${x.stride} · ` : ""}${x.result ?? ""}: ${plain(x.threat ?? "")}${x.note ? ` (${plain(x.note)})` : ""}`)));
    };
    // Wave C2 V1: a crossing as an entry of a list, like a Resilience path, no cell cut: line 1 its number, the zones
    // and what crosses, the result and the change; then Who, Check, Holds only if as labelled fields that wrap; its
    // marks and notes; its findings and the others at the same place in full titles. A click shows the way.
    const field = (label2, el, w = 260) => v_flex().w(w).flex_none().gap(1).child(div().text_size(TYPE.small).text_color(t.muted).child(label2)).child(div().whitespace_normal().child(el));
    const line = (r, k) => {
      const open = this.crossOpen === r.key || (r.aliases ?? []).includes(this.crossOpen), num = rows.indexOf(r) + 1, res = RES[r.result], failOpen = r.kind === "entry" && r.findings.some((f) => f.impact === "unauthorized_access");
      const check = r.kind === "bypass" ? div().text_color(t.ansi3).child("none: one process, no boundary in between") : r.check ? v_flex().child(r.check).when(Boolean(r.expects), (e) => e.child(div().text_size(TYPE.small).text_color(t.muted).child(`expects ${r.expects}`)))
        .when(Boolean(r.at), (e) => e.child(div().id(`rv-sec-cr-at-${k}`).text_color(t.accent).cursor_pointer().hover((x) => x.underline()).on_click((_e, cx) => { this.jumpTo(r.at, cx); cx.stop_propagation(); }).child(`${r.at} ↗`))) : na(null, "no check named");
      const also = here(r), alsoOpen = Boolean(this.crossAlso?.has(r.key)), mine = once.get(r.key) ?? { first: r.findings, again: [] };
      return v_flex().id(`rv-sec-cr-${k}`).gap(6).pl(12).pr(8).py(8).rounded(8).border_l(3).border_color(r.result === "finding" ? t.ansi1 : r.result === "mitigated" ? t.ansi2 : t.border)
        .bg(open ? t.selected : t.background).when(!crossingChanged(r), (e) => e.text_color(t.muted))
        .child(v_flex().id(`rv-sec-crh-${k}`).gap(6).cursor_pointer().tooltip(open ? "Fold the way" : "Show the way: who arrives, the gate, what lies behind it").on_click((_e, cx) => { this.crossOpen = open ? null : r.key; cx.notify(); })
          .child(h_flex().gap(10).items_start()
            .child(div().flex_none().w(18).text_color(t.muted).child(`${num}`))
            .child(v_flex().flex_1().min_w(0).gap(2).child(div().font_semibold().whitespace_normal().child(`${r.from.name} → ${r.to.name}`))
              .child(div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(`${KIND[r.kind] ?? "Call"}: ${r.what || label(r.ends.to)}${r.kind === "right" && r.actions?.length && !r.aliases ? ` (${r.actions.join(", ")})` : ""}`)))
            .child(h_flex().flex_none().gap(6).items_center().child(chip(t, res[0], res[1], res[2], `rv-sec-cr-res-${k}`, r.result === "not_assessed" ? r.reason : r.threats.map((x) => x.threat).filter(Boolean).join("\n") || null))
              .when(r.conflicts.length > 0, (e) => e.child(chip(t, "data disagree", t.ansi3, false, `rv-sec-cr-dd-${k}`, r.conflicts.map((c) => `“${c.f.title}” names ${c.finding.join(", ") || "no way in"}, its threat ${c.threat.join(", ") || "no way in"}; the outer one counts.`).join("\n"))))
              .child(div().text_size(TYPE.small).text_color(t.muted).child(r.change ?? "not said")).child(div().text_color(t.muted).child(open ? "▾" : "▸"))))
          .child(h_flex().pl(28).gap(16).flex_wrap().items_start()
            .child(field("Who", v_flex().child(r.identity ?? "not named").when(Boolean(r.unmapped), (e) => e.child(div().text_size(TYPE.small).text_color(t.ansi3).child("principal not mapped"))), 200))
            .child(field("Check", check, 280))
            .child(field("Holds only if", na(r.holds_if, "not named"), 280))))
        .when(failOpen || r.unused || Boolean(r.breaks) || (r.kind === "operator" && r.valueFrom !== undefined) || extra.has(r.key), (e) => e.child(v_flex().pl(28).gap(3).text_size(TYPE.small)
          .when(failOpen || r.unused, (x) => x.child(h_flex().gap(4).flex_wrap().when(failOpen, (y) => y.child(chip(t, "can fail open", t.ansi1, false, `rv-sec-cr-fo-${k}`, "An unresolved finding says this way in's check can be passed")))
            .when(Boolean(r.unused), (y) => y.child(chip(t, "granted, not used", t.ansi3, false, `rv-sec-cr-un-${k}`, "The code in this PR never uses this right: least privilege says drop it")))))
          .when(Boolean(r.breaks), (x) => x.child(div().text_color(t.ansi3).child(`Breaks the condition of crossing ${rows.findIndex((y) => y.key === r.breaks) + 1}.`)))
          .when(r.kind === "operator" && r.valueFrom !== undefined, (x) => x.child(div().text_color(r.valueFrom ? t.muted : t.ansi3).child(r.valueFrom ? `set at ${r.valueFrom}` : "set nowhere in the repository")))
          .when(extra.has(r.key), (x) => x.child(div().id(`rv-sec-extra-${k}`).text_color(t.ansi3).whitespace_normal().tooltip(extra.get(r.key).why || "The task check marks this as extra")
            .child(`The task does not ask for “${extra.get(r.key).text}”, and this PR opens it here.`)))))
        .when(r.findings.length > 0, (e) => e.child(v_flex().pl(28).gap(2).child(flist(k, mine.first, "f")).children(mine.again.map((x) => again(k, x)))))
        // The other findings at the same place: folded to a line, so the six cards stay short and the picture under
        // them comes up; they are all in the list of findings under the picture.
        .when(also.length > 0, (e) => e.child(v_flex().pl(28).gap(2)
          .child(div().id(`rv-sec-cr-also-${k}`).text_size(TYPE.small).text_color(t.muted).cursor_pointer().hover((x) => x.text_color(t.foreground)).tooltip(alsoOpen ? "Fold them" : "Other unresolved findings on the same card or call, which this crossing's threats do not name")
            .on_click((_e, cx) => { this.crossAlso = new Set(this.crossAlso ?? []); if (!this.crossAlso.delete(r.key)) this.crossAlso.add(r.key); cx.stop_propagation(); cx.notify(); })
            .child(alsoOpen ? "Also at this place ▾" : `${also.length} ${r.findings.length ? "more" : also.length === 1 ? "finding" : "findings"} at this place ▸`))
          .when(alsoOpen, (x) => x.child(flist(k, also, "h", also.length)))))
        .when(open, (e) => e.child(strip(r)));
    };
    // If a frame with a way in is compromised: what its principal may do (views.js secBlast, by principal behind a way in).
    const aside = asideOf({ arch, access: this.ai?.access ?? [], threats: this.ai?.threats ?? [], findings: this.openFindings() });
    const blast = secBlast(rows, arch, this.ai?.access ?? []);
    return v_flex().id("rv-sec-crossings").gap(8).p(12).rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(10).items_center().flex_wrap().child(title("Trust boundary crossings")).child(div().text_size(TYPE.small).text_color(t.muted).child("The ways in, the rights and the calls this PR opens or changes across a trust boundary. A click shows the way.")))
      .child(rows.length ? v_flex().w_full().gap(6).text_size(TYPE.small).line_height(1.45)
        .children(shown.map(line))
        .when(hidden > 0, (e) => e.child(div().id("rv-sec-cr-all").px(6).pt(6).text_size(TYPE.small).text_color(t.muted).cursor_pointer().hover((x) => x.text_color(t.foreground))
          .on_click((_e, cx) => { this.crossAll = !this.crossAll; cx.notify(); }).child(this.crossAll ? `Hide the ${hidden} unchanged ${hidden === 1 ? "crossing" : "crossings"} ▴` : `${hidden} ${hidden === 1 ? "crossing is" : "crossings are"} unchanged by this PR ▸`)))
        : div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child("The data names no crossing: no zones, no way in and no right into another zone. Run the security review for them."))
      .children(blast.map((s, i) => h_flex().id(`rv-sec-blast-${i}`).gap(8).items_start().text_size(TYPE.small).line_height(1.5).child(div().flex_none().text_color(t.ansi3).child("⚠")).child(div().flex_1().min_w(0).whitespace_normal().child(s))))
      // No crossings: a rule that takes a right away guards its resource (with the threat it holds against), and a
      // right on something the map does not show.
      .children(aside.guards.map((g, i) => h_flex().id(`rv-sec-guard-${i}`).gap(8).items_start().text_size(TYPE.small).line_height(1.5).child(div().flex_none().text_color(g.loosened ? t.ansi1 : t.ansi2).child(g.loosened ? "⚠" : "⛨"))
        .child(div().flex_1().min_w(0).whitespace_normal().when(Boolean(g.loosened), (e) => e.text_color(t.ansi1)).child(plain(guardLine(g))))))
      .when(aside.rights.length > 0, (e) => e.child(div().id("rv-sec-offmap").text_size(TYPE.small).text_color(t.muted).whitespace_normal().line_height(1.5)
        .child(`Also granted, on nothing the map shows: ${aside.rights.map((r) => r.text).join(" ")}`)))
      .when(!rows.some((r) => r.kind === "operator"), (e) => e.child(div().text_size(TYPE.small).text_color(t.dim).child("Operator and CI ways (admin scripts, deploys, guardrails): none named by the data, not assessed.")));
  },
  // A way in this PR opens that the task does not ask for (views.js extraWays: an "extra" ask in its files):
  // Map(crossing key -> ask). For the page's rows and their Markdown.
  secExtra(rows) {
    const arch = this.ai?.arch, nodeOf = (id) => arch?.nodes.find((n) => n.id === id);
    const fileOf = (at) => (at ? /^(.*?)(:\d+)?$/.exec(String(at))[1] : null);
    return new Map(extraWays((this.ai?.asks ?? []).map((q) => ({ ...q, files: [...(q.hunks ?? []).map((h) => this.byId.get(h)?.path), ...(q.findings ?? []).map((id) => this.findingById(id)?.file)].filter(Boolean) })),
      rows.filter((r) => r.kind === "entry").map((r) => ({ ...r.access, k: r.key, files: [fileOf(r.access.at), fileOf(nodeOf(r.ends.to)?.at)].filter(Boolean) }))).map((m) => [m.entry.k, m.ask]));
  },
  // A card of the picture lit (null: none), and its first row below brought into view.
  secCard(id, cx) {
    this.blastFocus = id; this.hsDrag = null; // as in jumpTo
    const k = id ? (this.pageParts ?? []).indexOf(this.secPart?.(id)) : -1;
    if (k >= 0) this.pageScrolls.blast.scroll_to_item(k);
    cx.notify();
  },
  // Above the findings: who will read a finding once it is a comment. Or why there is none.
  secIntro(t, sec, open, cited = []) {
    const sr = this.find.runs.security, settled = sec.length - open.length;
    const none = sr?.state === "done" ? "The security review and the other runs left no unresolved security finding." : sr?.state === "failed" ? "No unresolved security finding from the other runs. The security review failed (see below), so it has not looked."
      : sr?.state === "running" ? "No unresolved security finding so far. The security review is still running." : "No unresolved security finding from the other runs. The security review has not run on this PR.";
    return v_flex().gap(4)
      // No "Add as comment" here: a finding with its way to use the weakness does not go into a PR comment from this page.
      .when(!open.length && !cited.length, (e) => e.child(div().text_size(TYPE.body).text_color(t.muted).whitespace_normal().child(none)))
      .when(cited.length > 0, (e) => e.child(div().id("rv-sec-cited").text_size(TYPE.body).text_color(t.muted).whitespace_normal()
        .child(`${open.length ? "" : "No unresolved finding is about access or data (⛨). "}${cited.length} unresolved ${cited.length === 1 ? "finding backs" : "findings back"} a threat named above without being about access or data: ${cited.length === 1 ? "it is" : "they are"} listed here too.`)))
      .when(open.length > 1 && !this.secOpen().some((f) => f.proof?.state === "running"), (e) => e.child(h_flex().child(pill("rv-sec-vfall", t, `Verify all ${open.length} with an agent…`, (_e, cx) => this.verifyAgent(this.secOpen(), cx))
        .tooltip("One agent in its own checkout of the PR head tries to show or refute each unresolved security finding, with the threat model, the map and what is not known as context. A preview first."))))
      .when(settled > 0, (e) => e.child(div().text_size(TYPE.small).text_color(t.muted).child(`${settled} more security ${settled === 1 ? "finding is" : "findings are"} fixed or dismissed: see the Findings tab.`)));
  },
  secReach() {
    const repo = this.prSel?.repo ?? "the repository", vis = this.repoVis?.[this.prSel?.repo];
    return vis === "PUBLIC" ? `This repository (${repo}) is public: anyone can read the comment.` : vis ? `This repository (${repo}) is ${vis.toLowerCase()}: everyone with access to it can read the comment.` : "Everyone who can see the PR can read the comment.";
  },
  // One unresolved security finding, whole: nothing to unfold. What it leads to, how sure its source is and what it
  // needs to happen, where it can be reached from (its crossing's row, the same as in the table; else its access rows),
  // its way, and who found it; "Open finding" has the rest (text, fix, dismiss) in the Findings tab.
  secFinding(t, f, ctx) {
    // ponytail: formatted here until the Diff package's helper for these facts (views.js) is merged; then use that.
    const CERTAIN = { confirmed: "Confirmed: something that ran shows it.", derived: "Derived from the code that was read; nothing ran.", assumed: "Assumed: it depends on something that could not be checked." };
    const st = this.fstatus(f), col = t[SEV[f.severity]] ?? t.accent, at = `${f.file}:${f.line}`, card = ctx.cardOf.get(f.id) ?? null, cr = ctx.rowOf(f), n = cr ? ctx.crossings.indexOf(cr) + 1 : 0;
    const REACH = { public: "anyone can reach it", authenticated: "an authenticated caller can reach it", internal_only: "it can only be reached from inside", unknown: "the analysis could not tell from where it can be reached" };
    const level = REACH[f.reachability] ?? null, { ways, stated } = ctx.waysOf(f), nm = (id) => (id ? ctx.name(id) : null);
    const conflict = cr?.conflicts.find((c) => c.f === f);
    const reach = cr ? `${cr.identity ?? cr.from.name} through ${cr.what || nm(cr.ends.to)} (crossing ${n}, ${cr.from.name} → ${cr.to.name}).${conflict ? ` Data disagree: the finding names ${conflict.finding.join(", ") || "no way in"}, its threat ${conflict.threat.join(", ") || "no way in"}; the outer one counts.` : ""}`
      : ways.length ? `${ways.map((x) => `${x.resource}: ${EXPOSURE[x.exposure].toLowerCase()}, reached by ${x.principal}`).join("; ")}. ${stated ? `Stated by the analysis${level && f.reachability !== "unknown" ? `: ${level}` : ""}.` : "Derived from the map: the finding sits at this way in."}`
      : level ? `${level[0].toUpperCase()}${level.slice(1)}${f.reachability === "unknown" ? "." : ". Stated by the analysis, which names no way in."}` : null;
    const way = cr ? `${wayText(wayOf(cr, ctx.crossings, this.ai?.arch))}.${cr.holds_if ? ` Holds only if: ${cr.holds_if.replace(/\.+$/, "")}.` : ""}` : null; // through every gate, from whoever arrives
    const facts = [f.effect && ["Effect", plain(f.effect)],
      f.certainty && ["Certainty", `${CERTAIN[f.certainty]}${probedText(f)} ${f.preconditions.length ? `It needs: ${f.preconditions.map(plain).join("; ")}.` : "It needs nothing else: it holds as the code stands."}`],
      reach && ["Reachable from", reach],
      way && ["Way", way],
      f.proof?.state === "done" && ["Agent check", `${PROOF_WORDS[f.proof.result]}${f.proof.reason ? `: ${plain(f.proof.reason)}` : "."}${f.proof.command ? ` (ran ${f.proof.command})` : ""}`],
      ["Found by", this.sourcesOf(f)]].filter(Boolean);
    return v_flex().id(`rv-sec-${f.id}`).gap(8).p(12).rounded(8).border_l(3).border_color(col).bg(card && card === ctx.focus ? t.selected : t.surface)
      .when(Boolean(card), (e) => e.on_hover(ctx.hover(card)))
      .when(ctx.why.has(f.id), (e) => e.child(h_flex().gap(8).items_center().child(div().id(`rv-sec-why-${f.id}`).text_size(TYPE.small).text_color(t.muted).tooltip("The findings are ordered by how far out they can be reached from, then by whether the way crosses a trust boundary, then by severity").child(ctx.why.get(f.id)))
        .when(Boolean(conflict), (x) => x.child(chip(t, "data disagree", t.ansi3, false, `rv-sec-dd-${f.id}`, "The finding's own way in and the threat that names it differ; the outer one counts")))))
      .child(h_flex().gap(8).items_start()
        .child(badge(t, f.severity, col))
        .child(div().flex_1().min_w(0).text_size(TYPE.title).font_semibold().whitespace_normal().line_height(1.4).child(plain(f.title)))
        .when(Boolean(cr), (e) => e.child(div().id(`rv-sec-card-${f.id}`).flex_none().text_size(TYPE.small).text_color(t.accent).cursor_pointer().hover((x) => x.underline()).tooltip("Open its crossing in the table above").on_click((_e, cx) => ctx.show(cr.key, cx)).child(`Crossing ${n} ↑`)))
        .child(div().id(`rv-sec-at-${f.id}`).flex_none().text_size(TYPE.small).text_color(t.accent).cursor_pointer().hover((x) => x.underline()).tooltip("Show this line in the diff").on_click((_e, cx) => this.jumpTo(at, cx)).child(`${f.file.split("/").pop()}:${f.line} ↗`))
        .children(this.editAt(t, `rv-sec-ed-${f.id}`, at))
        .child(div().flex_none().text_size(TYPE.small).font_semibold().text_color(t[FSTATUS[st]?.[1]] ?? t.muted).child(FSTATUS[st]?.[0] ?? st)))
      .child(v_flex().gap(3).children(facts.map(([label, text]) => h_flex().gap(8).items_start().text_size(TYPE.small).line_height(1.5)
        .child(div().w(98).flex_none().text_color(t.muted).child(label)).child(div().flex_1().min_w(0).whitespace_normal().child(text)))))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .child(pill(`rv-sec-open-${f.id}`, t, "Open finding", (_e, cx) => { this.openFinding(f); this.jumpTo(at, cx); cx.notify(); }).tooltip("Its whole text in the Findings tab, with Fix and Dismiss, and its line in the diff"))
        .child(this.verifyPill(f, t, "rv-sec-vf")));
  },
  // ---- the Resilience page (CONCEPT-RESILIENCE.md, page "res"): the ways a failure spreads (trigger → way → end),
  // blockers first. Before the run: where it would start (○ on the map) and the offer; during it: running; after it:
  // the verdict in a sentence, a context line, the map with the chosen path lit and its marks, the paths (two lines
  // each, at most 5 open, the first blocker unfolded with its one picture, the action and its probe), then other checks,
  // not checkable and what to watch after the merge. A head the run did not read greys it out with Re-run.
  // The data: this.ai.resilience (op-analysis' withResilience), else the findings file's raw block.
  // An unclear blocker takes the word of its probe on the base (views.js resByProbe), here, so every count agrees.
  resNow() { const res = this.ai?.resilience ?? this.find?.resilience ?? null; return res?.paths && typeof this.probesNow === "function" ? { ...res, paths: resByProbe(res.paths, this.probesNow()) } : res; },
  // The run in a few words, for the Overview: not run, running, failed, or its paths and blockers.
  resLine() {
    const res = this.resNow(), r = this.find.runs?.resilience, n = (res?.paths ?? []).length, b = (res?.paths ?? []).filter((p) => p.blocker).length;
    return res ? `${n} ${n === 1 ? "path" : "paths"}${b ? `, ${b} ${b === 1 ? "blocker" : "blockers"}` : ", all limited"}` : r?.state === "running" ? "running" : r?.state === "failed" ? "failed" : "not run";
  },
  resPage(t) {
    const res = this.resNow(), run = this.find.runs?.resilience, a = this.ai?.arch ?? null, title = (text) => div().text_size(TYPE.title).font_semibold().child(text);
    const head = v_flex().gap(6).child(h_flex().gap(10).items_center().flex_wrap().child(div().flex_1().text_size(TYPE.page).font_semibold().child("Resilience"))
      .when(run?.state === "running", (e) => e.child(div().id("rv-res-running").text_size(TYPE.body).text_color(t.muted).child("Resilience review running: reading the code, the template and the calls between them…"))));
    if (!res) {
      // Before the run: where it would start, the offer, what it does not do.
      // The count from the diff (pr.js resilienceStart) for the sentence; the cards from the map for the circles.
      const own = this.ai?.resilienceStart ?? (this.patch ? resStartMemo.get(this.patch) : null), map = resStartOf(a, this.ai?.access), start = own?.sentence ? { text: own.sentence, nodes: map.nodes } : map;
      return [["head", head], ["start", v_flex().id("rv-res-start").gap(10).max_w(1000)
        .child(div().text_size(TYPE.title).line_height(1.5).whitespace_normal().child(start.text))
        .when(run?.state !== "running", (e) => e.child(this.runOffer("resilience", t)))
        .child(div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child("It reads code. Probes that run PR code start separately, one click each."))
        .when(run?.state === "failed", (e) => e.child(div().text_size(TYPE.small).text_color(t.ansi1).whitespace_normal().child(`The last run failed: ${run.error || "no error text"}.`)))],
        ...(a ? [["map", this.resMap(t, a, null, start.nodes ?? [])]] : [])];
    }
    const listed = resShown(res), paths = listed.paths, blockers = paths.filter((p) => p.blocker), cur = this.resPathOf(paths), now = this.worktree?.head ?? this.head;
    const stale = Boolean(res.older) || Boolean(res.head && now && res.head !== now), short = (h) => String(h ?? "").slice(0, 7);
    const clean = (res.checks ?? []).filter((c) => c.result === "clean").length, nc = (res.checks ?? []).filter((c) => c.result === "not_checkable").length + (res.not_checked ?? []).length;
    const vp = resVerdictParts(paths); // wave C2 V2: a short sentence, the reasons counted under it
    const verdict = vp?.head || res.summary || (blockers.length ? `${blockers.length} ${blockers.length === 1 ? "path stands" : "paths stand"} before the merge.` : "No path grows without limit or doubles an effect.");
    const context = [`${paths.length} ${paths.length === 1 ? "path" : "paths"}`, `${clean} ${clean === 1 ? "check" : "checks"} clean`, `${nc} not checkable`, `analysis of ${short(res.head)}${res.at ? `, ${ago(res.at)}` : ""}`, (res.cost ?? this.find.runs?.resilience?.cost) != null && `$${Number(res.cost ?? this.find.runs.resilience.cost).toFixed(2)}`].filter(Boolean).join(" · ");
    const top = v_flex().id("rv-res-top").gap(4).when(stale, (e) => e.opacity(resFade(t)))
      .child(div().text_size(TYPE.title).font_semibold().line_height(1.4).whitespace_normal().child(`${blockers.length ? "" : "✓ "}${verdict}`))
      .when(Boolean(vp), (e) => e.child(div().id("rv-res-why").text_size(TYPE.body).whitespace_normal().line_height(1.45).child(vp.counts.join(" · "))))
      .child(div().text_size(TYPE.small).text_color(t.muted).child(context))
      .when((res.additions ?? []).length > 0, (e) => e.child(this.resAdditions(t, res)));
    // Another head: the whole page grey, the line that says so and Re-run not.
    head.when(stale, (e) => e.child(h_flex().gap(8).items_center().text_size(TYPE.small).child(div().text_color(t.ansi3).child(`Analysis of ${short(res.head)}; the PR is at ${short(now)}.`))
      .child(pill("rv-res-rerun", t, `Re-run (${this.runPrice("resilience", this.runTier("resilience").chosen ?? this.runTier("resilience").tier)})`, (_e, cx) => this.runReviewer("resilience", cx, null, this.runTier("resilience").chosen ?? this.runTier("resilience").tier)))));
    const shown = this.resAll ? paths : paths.slice(0, 5);
    this.resNums = listed.nums; // "same cause as path 2", "Path 6: lit on the map": by the number shown, never the run's id
    const deps = this.resDeps(t, res, paths, cur, stale);
    return [["head", head], ["top", top], ...(a ? [["map", this.resMap(t, a, cur, [])]] : []), ...(deps ? [["deps", deps]] : []),
      // The paths: their head, then each path a part of the page of its own ("p:<id>"), so a click on a dependency's
      // case can scroll to its path (resGo).
      ["paths", v_flex().id("rv-res-paths").gap(6).when(stale, (e) => e.opacity(resFade(t)))
        .child(h_flex().gap(8).items_center().child(title(`Paths · ${paths.length}${blockers.length ? "" : ", all limited"}`)).child(div().flex_1()).child(div().text_size(TYPE.small).text_color(t.muted).child("blockers first")))
        // pr.js edgeNote: a run from before the picture had edge ids; its ladders may sit one call off.
        .when(Boolean(res.edgeNote), (e) => e.child(div().id("rv-res-edgenote").text_size(TYPE.small).text_color(t.muted).whitespace_normal().child("This run is older than the numbered calls of the picture, so a ladder or a mark may sit one call off. A new run fixes that.")))],
      ...shown.map((p, k) => [`p:${p.id}`, this.resPath(t, res, p, k, p === cur).when(stale, (e) => e.opacity(resFade(t)))]),
      ...(shown.length < paths.length ? [["more", div().id("rv-res-more").text_size(TYPE.small).text_color(t.muted).cursor_pointer().hover((x) => x.text_color(t.foreground))
        .on_click((_e, cx) => { this.resAll = true; cx.notify(); }).child(`${paths.length - shown.length} more ▸`)]] : []),
      ...[this.resTiming(t, res, stale)].filter(Boolean).map((el) => ["timing", el]),
      ["rest", this.resRest(t, res)]];
  },
  // The picture "Timing" (timeline.js): per call the limit it runs inside as a frame and what runs inside it, over
  // seconds; a click on a row shows its line, a click on a row's words the path that shows it. Open unless folded.
  resTiming(t, res, stale) {
    const m = timelineOf(res, this.ai?.arch), open = this.resTimeOpen !== false, tier = this.runTier("resilience").chosen ?? this.runTier("resilience").tier;
    if (!m) return null;
    return v_flex().id("rv-res-time").gap(6).when(stale, (e) => e.opacity(resFade(t)))
      .child(h_flex().id("rv-res-time-h").gap(8).items_center().cursor_pointer().tooltip(open ? "Fold the picture" : "Timeouts, retries and pauses of each call over seconds").on_click((_e, cx) => { this.resTimeOpen = !open; cx.notify(); })
        .child(div().text_size(TYPE.title).font_semibold().child(`Timing · ${m.total}`)).child(div().text_color(t.muted).child(open ? "▾" : "▸")).child(div().flex_1())
        .child(div().text_size(TYPE.small).text_color(t.muted).child(m.line.replace(/^\d+ calls?: /, ""))))
      .when(open, (e) => e.child(div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(m.note))
        .child(timelineView(timelineLayout(m), t, "rv-res-tl", { jump: (at, cx) => this.jumpTo(at, cx), go: (id, cx) => this.resGo(id, this.resNums?.get(id), cx), num: (id) => this.resNums?.get(id) ?? null }))
        .when(m.more > 0, (x) => x.child(div().text_size(TYPE.small).text_color(t.muted).child(m.moreLine ?? "")))
        .when(Boolean(m.rerun), (x) => x.child(h_flex().gap(8).items_center().text_size(TYPE.small).child(div().min_w(0).text_color(t.muted).whitespace_normal().child(m.rerun ?? ""))
          .child(pill("rv-res-time-rerun", t, runLabel(this.find.runs?.resilience, this.runPrice("resilience", tier), "", true), (_e, cx) => this.runReviewer("resilience", cx, null, tier))))));
  },
  // Opens a path and brings it into view (a click on a dependency's case): the path may be under "n more", and its
  // part exists only after the next frame.
  resGo(id, number, cx) {
    this.resOpen = id; if (number > 5) this.resAll = true;
    cx.timer.after(30, (cx) => { const k = (this.pageParts ?? []).indexOf(`p:${id}`); if (k >= 0 && this.page === "res") this.pageScrolls.res?.scroll_to_item(k); cx.notify(); });
    cx.notify();
  },
  // Complexity against use (CONCEPT-RESILIENCE.md): the parts this PR adds, how many are justified, questionable or
  // solve nothing here, in one line; unfolded a sentence each: what it solves (or not), what it costs, the simpler way.
  resAdditions(t, res) {
    const adds = res.additions ?? [], open = Boolean(this.resAddOpen), WORD = { justified: ["✓ justified", t.ansi2], questionable: ["? questionable", t.ansi3], unjustified: ["✗ solves nothing here", t.foreground] };
    const line = res.additionsLine || `This PR adds ${adds.length} ${adds.length === 1 ? "part" : "parts"}.`;
    // A part as a short list, a line each: what it is, what it solves (and how likely that is), each cost, the simpler way.
    // R2: purpose (what it is for) first, next (what to do, a sentence with a verb) last.
    const lines = (x) => [x.purpose && `For: ${x.purpose}`, x.solves && `Solves: ${String(x.solves).replace(/\.$/, "")}${x.likelihood ? ` (${resWord(x.likelihood)})` : ""}.`,
      ...Object.entries(x.cost ?? {}).filter(([, v]) => v).map(([k, v]) => `Costs ${resWord(k)}: ${v}.`), x.simpler && `Simpler: ${x.simpler}`,
      // works_today (R2 D6): whether the part does its job today at all, apart from how it is rated.
      x.works_today === false && `Works today: no, ${String(x.broken_by || "the run says it does not").replace(/^./, (c) => c.toLowerCase())}`, x.works_today === true && "Works today: yes.", x.next && `Next: ${x.next}`].filter(Boolean).map((l) => l.replace(/\.(\)?)\.$/, ".$1").replace(/\.\.$/, "."));
    return v_flex().id("rv-res-add").gap(4).pt(2)
      .child(h_flex().id("rv-res-add-h").gap(6).cursor_pointer().text_size(TYPE.body).hover((x) => x.text_color(t.foreground)).tooltip(open ? "Fold the parts" : "For each part: what it solves here, what it costs, and the simpler way")
        .on_click((_e, cx) => { this.resAddOpen = !open; cx.notify(); }).child(line).child(div().text_color(t.muted).child(open ? "▾" : "▸")))
      .when(open, (e) => e.children(adds.map((x, k) => h_flex().id(`rv-res-add-${k}`).gap(10).items_start().pl(12).text_size(TYPE.small)
        .child(div().w(170).flex_none().font_semibold().text_color(WORD[x.result]?.[1] ?? t.muted).child(WORD[x.result]?.[0] ?? x.result ?? ""))
        .child(v_flex().flex_1().min_w(0).gap(1).line_height(1.45).child(div().whitespace_normal().font_semibold().child(`${x.what}${x.kind ? ` (${resWord(x.kind)})` : ""}`))
          .children(lines(x).map((l, j) => div().id(`rv-res-add-${k}-${j}`).whitespace_normal().text_color(this.softText(t)).child(l))))
        .when(Boolean(x.at), (y) => y.child(div().id(`rv-res-add-at-${k}`).flex_none().text_color(t.accent).cursor_pointer().on_click((_e, cx) => this.jumpTo(x.at, cx)).child(`${String(x.at).split("/").pop()} ↗`))))));
  },
  // Dependencies that fail or are overloaded (views.js resDepRows), a row each under the map: its name and kind, then
  // its cases as words with their mark ("slow: waits up to 7 s of the 10 s request ✗"). A click on a case opens the
  // path that shows how it spreads (lit on the map above, the dependency's card marked "✕ when slow"), without one its line; the
  // cases of the chosen path have the chosen path's background. What the code cannot decide is named only: it is asked under "After merge, watch".
  resDeps(t, res, paths, cur, stale) {
    const rows = resDepRows(res, paths);
    if (!rows.length) return null;
    const COLOR = { no: t.ansi1, partly: t.foreground, yes: t.ansi2 }; // red only for what breaks, and only its mark
    // A case's fault tree (faulttree.js), folded: "▸" at the case unfolds it under the dependency's row, one at a time.
    // A click on a card shows its line, on the path's card the path.
    const trees = new Map(faultTrees(res, paths, (id) => this.resNums?.get(id) ?? null).map((x) => [`${x.k}:${x.when}`, x.tree]));
    const treeGo = (at, cx) => (String(at).startsWith("path:") ? this.resGo(at.slice(5), this.resNums?.get(at.slice(5)), cx) : this.jumpTo(at, cx));
    const treeOf = (k) => { const key = [...trees.keys()].find((x) => x === this.resTreeOpen && x.startsWith(`${k}:`)); return key ? [v_flex().id(`rv-res-tree-${k}`).pl(12).gap(2)
      // as wide as the map above it (its scroller's measured room): the usual cards when they fit, else the narrow ones
      .child(div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(FAULT_NOTE)).child(faultTreeView(trees.get(key), t, `rv-res-tree-${key.replace(":", "-")}`, treeGo, this.wrapX(), (this.wrapX().room("rv-res-canvas") || 900) - 12))] : []; };
    const fold = (el, key, id) => el.when(trees.has(key), (e) => e.child(div().id(`${id}-t`).flex_none().text_color(t.muted).cursor_pointer().hover((x) => x.text_color(t.foreground)).tooltip(this.resTreeOpen === key ? "Fold what follows" : "What follows from it, step by step, down to what a caller and on-call see")
      .on_click((_e, cx) => { this.resTreeOpen = this.resTreeOpen === key ? null : key; cx.stop_propagation(); cx.notify(); }).child(this.resTreeOpen === key ? "▾" : "▸")));
    const one = (c, id, k) => {
      const go = c.path ? (_e, cx) => this.resGo(c.path, c.number, cx) : c.at ? (_e, cx) => this.jumpTo(c.at, cx) : null;
      const tip = [c.effect, c.path ? `Opens path ${c.number}${c.blocks ? ", a blocker" : ""}, and scrolls to it.` : c.at ? `Opens ${c.at}.` : ""].filter(Boolean).join(" ");
      return fold(h_flex().id(id).gap(5).items_start().min_w(0).px(4).rounded(4).when(Boolean(cur) && c.path === cur?.id, (e) => e.bg(t.selected))
        .when(Boolean(go), (e) => e.cursor_pointer().hover((x) => x.underline()).on_click(go)).when(Boolean(tip), (e) => e.tooltip(tip))
        .child(div().min_w(0).whitespace_normal().text_color(c.handled === "yes" ? this.softText(t) : t.foreground).child(c.words)).child(div().flex_none().font_semibold().text_color(COLOR[c.handled] ?? t.muted).child(c.mark)), `${k}:${c.when}`, id);
    };
    return v_flex().id("rv-res-deps").gap(6).when(stale, (e) => e.opacity(resFade(t)))
      .child(h_flex().gap(8).items_center().child(div().text_size(TYPE.title).font_semibold().child(`When a dependency fails · ${rows.length}`)).child(div().flex_1())
        .child(div().text_size(TYPE.small).text_color(t.muted).child(String(res.downstreamLine ?? "").replace(/^\d+ dependenc\w+, /, ""))))
      .children(rows.flatMap((d, k) => [h_flex().id(`rv-res-dep-${k}`).gap(12).items_start().text_size(TYPE.small).line_height(1.45)
        .child(v_flex().w(240).flex_none().child(div().font_semibold().whitespace_normal().child(d.dep))
          .child(div().id(`rv-res-dep-what-${k}`).text_size(TYPE.small).text_color(t.muted).truncate().tooltip([d.what, d.entry && `reached from ${d.entry}`].filter(Boolean).join(", ")).child([d.entry && `from ${d.entry}`, d.what].filter(Boolean).join(" · "))))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(h_flex().flex_wrap().gap_x(8).gap_y(1).children(d.cases.map((c) => one(c, `rv-res-dep-${k}-${c.when}`, k))))
          .when(d.open.length > 0, (e) => e.child(div().id(`rv-res-dep-${k}-open`).px(4).text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(`The code cannot tell: ${d.open.join(", ")}.`))))
        .when(Boolean(d.at), (e) => e.child(div().id(`rv-res-dep-at-${k}`).flex_none().text_color(t.accent).cursor_pointer().on_click((_e, cx) => this.jumpTo(d.at, cx)).child(`${String(d.at).split("/").pop()} ↗`))), ...treeOf(k)]));
  },
  // The chosen path: the person's (resOpen), else the first blocker, else the first path.
  resPathOf(paths) { return paths.find((p) => p.id === this.resOpen) ?? (this.resOpen === null ? null : paths.find((p) => p.blocker) ?? paths[0] ?? null); },
  // The map, the Architecture page's own: with a path chosen, its cards and calls lit and the rest dimmed, its marks
  // (⏱ timeout, ×n, DLQ, ✕ silent …) on its cards; before the run, ○ on the cards where the run would start.
  resMap(t, a, p, start) {
    // Every card any path marks keeps room for its longest marks (wrapped into the card: views.js resMarkLines), so
    // the cards do not grow from path to path; before the run, a line for the ○.
    const markedAt = (f) => {
      const w = (f ? ARCH_FIT.W : ARCH_SIZE.W) - 24, m = new Map((start ?? []).map((id) => [id, 1]));
      for (const x of this.resNow()?.paths ?? []) for (const [id, text] of resMarksOn(x.marks, a, true)) m.set(id, Math.max(m.get(id) ?? 1, resMarkLines(text, w).length));
      return m;
    };
    // Fit is decided from this map's own layout, so the plain map is not laid out for it.
    const fit = this.archFitOn((f) => this.archL(f, 13, markedAt(f))), cardW = (fit ? ARCH_FIT.W : ARCH_SIZE.W) - 24, marked = markedAt(fit);
    const L = this.archL(fit, 13, marked), on = new Set(p ? (Array.isArray(p.reach) ? p.reach : (p.steps ?? []).map((s) => resCardOf(s, a)).filter(Boolean)) : start); // pr.js reachOf, else places light the card of their file
    if (!L) return v_flex().id("rv-res-map"); // no map
    for (const id of resTwice(p, this.resNow(), a)) on.add(id); // an effect done twice: every way to it lit (views.js resTwice)
    const fs = p ? this.openFindings().filter((f) => (p.findings ?? []).some((id) => (f.ids ?? [f.id]).includes(id))) : [];
    // R-D marksOf: a call's marks on the call (resEdgeMarks), a queue's at the queue, a place's on the card of its file.
    const marks = archMarks(a, fs, this.ai?.access, this.ai?.threats ?? []), byNode = resMarksOn(p?.marks, a, true), byEdge = p ? resEdgeMarks(p, this.resNow()?.deps) : new Map();
    for (const id of byNode.keys()) on.add(id); // a card with a mark of the path is part of it (the mailer's ×3)
    for (const k of byEdge.keys()) for (const id of [a.edges?.[k]?.from, a.edges?.[k]?.to]) if (id) on.add(id); // and both ends of a marked call
    const opts = { ...this.archOpts("res"), marks, keep: on.size ? on : null, zoom: settings().zoom || 1, edgeNotes: byEdge.size ? byEdge : null };
    // A path chosen anew: the picture scrolls so that its cards are in view; when they do not fit, so that its end is
    // (Wrap shows it all anyway). Done once the scroller has measured its width.
    const key = p?.id ?? "start", s = this.hsOf("rv-res-canvas");
    if (this.resMapFor !== key) {
      const lit = L.nodes.filter((n) => on.has(n.id)), room = this.wrapX().room("rv-res-canvas");
      // Its start in view (wave C2 V2): the card of its first step, else the leftmost lit card; all of it when it fits.
      const first = L.nodes.find((n) => n.id === resStartCard(p, a));
      if (lit.length) { const lo = Math.min(...lit.map((n) => n.x)) - 40, hi = Math.max(...lit.map((n) => n.x + n.w)) + 40, from = first ? first.x - 40 : lo; s.x = Math.max(0, !room ? from : hi - lo > room ? from : lo < s.x || hi > s.x + room ? lo : s.x); }
      if (room || !lit.length) this.resMapFor = key;
    }
    // A card's marks, each line as wide as the card; red only on a mark that says what breaks (✕, no DLQ, no limit).
    const markLines = (id) => resMarkLines(byNode.get(id), cardW).map((line, j) => h_flex().id(`rv-res-mk-${id}-${j}`).h(RES_MARK_ROW.h).items_center().gap(5)
      .children(line.flatMap((m, k) => [...(k ? [div().flex_none().text_color(t.muted).child("·")] : []), div().min_w(0).truncate().text_color(m.bad ? t.ansi1 : t.foreground).child(m.text)])));
    const deco = (n) => (byNode.has(n.id) ? [v_flex().id(`rv-res-mk-${n.id}`).flex_none().mb(RES_MARK_ROW.below).text_size(TYPE.body).font_semibold().tooltip(byNode.get(n.id)).children(markLines(n.id))]
      : !p && on.has(n.id) ? [div().id(`rv-res-st-${n.id}`).flex_none().h(RES_MARK_ROW.h).mb(RES_MARK_ROW.below).flex().items_center().text_size(TYPE.body).text_color(t.muted).child("○ the run starts here")] : []);
    return v_flex().id("rv-res-map").gap(6)
      .child(div().text_size(TYPE.small).text_color(t.muted).child(p ? `Path ${this.resNums?.get(p.id) ?? p.id}: lit on the map, the rest dimmed.` : start.length ? "○: where the run would start." : "Open a path to light it on the map."))
      .child(this.archCanvas(t, L, opts, { id: "rv-res-canvas", pic: "rv-res-pic", decorate: deco, notes: false }));
  },
  // One path: line 1 trigger and end with the verdict (reason) and its evidence as symbol and word; line 2 in the
  // second colour the way, the failing checks, what is seen, the findings, "also in Security". Opened: its picture,
  // the action, the probe.
  resPath(t, res, p, k, open) {
    const probe = (typeof this.probesNow === "function" ? this.probesNow() : res.probes ?? []).find((x) => x.id === p.probe || x.of === p.id) ?? null;
    // The probe's word: a probe that never ran its script ("not run", with why) is not a failed script.
    const notRun = probe?.status === "done" && (probe.result === "not_run" || (probe.result === "script_failed" && !probe.head && !probe.ms));
    const ev = notRun ? ["·", "probe not run", t.muted] : probe?.status === "done" ? { reproduced: ["✓", "reproduced", t.foreground], not_reproduced: ["✗", "not reproduced", t.muted], script_failed: ["!", "script failed", t.ansi3], unknown: ["?", "unknown", t.muted] }[probe.result] ?? ["·", resWord(probe.result), t.muted]
      : p.budget ? ["=", "computed", t.muted] : ["·", probe ? "probe proposed" : "no probe", t.muted];
    // A blocker whose base was not comparable (pre_existing "unknown") says so at its reason; "✓ limited" only with a guard.
    // same_cause: another path's blocker (one cause blocks once); byProbe: the probe dated an unclear blocker on the base.
    const num = (id) => (this.resNums?.get(id) ?? id), dated = p.byProbe ? ` (${TH.BASE_WORDS[p.byProbe] ?? resWord(p.byProbe)}, from the probe on the base)` : "";
    // wired (C2 D3): it cannot happen today; it blocks once the missing part is there ("blocks once wired").
    const word = p.wired && !p.blocker ? `Blocks once wired: ${p.wired.reason}` : p.blocker ? `${p.blocker.unclear ? "Blocker? old or new unclear" : "Blocker"}: ${p.blocker.reason}${dated}` : p.same_cause ? `same cause as path ${num(p.same_cause)}`
      : p.pre_existing === true ? `finding, already on the base${dated}` : p.result === "mitigated" ? (p.limited_by ? `✓ limited at ${p.limited_by}` : "limited, no guard named")
        : p.result === "not_assessed" ? "not assessed" : "finding";
    // The way: each step's card (a call e<k> by both its ends, R2 runs name calls), each card once.
    const arch = this.ai?.arch, label = (id) => arch?.nodes.find((n) => n.id === id)?.label ?? id;
    const name = (s) => { const e = /^e(\d+)$/.exec(s); if (e) return arch?.edges?.[Number(e[1])] ? [label(arch.edges[Number(e[1])].from), label(arch.edges[Number(e[1])].to)] : []; const c = resCardOf(s, arch); return [c ? label(c) : s]; };
    const way = [...new Set((p.steps ?? []).flatMap(name).filter(Boolean))].join(" → ");
    const fs = this.findings().filter((f) => (p.findings ?? []).some((id) => (f.ids ?? [f.id]).includes(id)));
    // What on-call sees, two states (seen / ✕ silent) from signal and seen_as (an older run: visible), the detail in the tooltip.
    const silent = p.signal ? p.signal === "none" : !p.visible, seenAs = p.seen_as || p.seen || (p.signal && p.signal !== "none" ? `It shows in ${resWord(p.signal)}.` : "");
    // The second line (views.js resMeta): the way, at most three things it breaks and its findings, at most about 110
    // characters wide; why it cannot happen today on a line of its own.
    const meta = resMeta(p, way, fs.length);
    return v_flex().id(`rv-res-p-${p.id}`).gap(8).pl(12).pr(8).py(8).rounded(8).border_l(3).border_color(p.blocker ? t.ansi1 : p.wired ? t.ansi3 : p.result === "mitigated" ? t.ansi2 : t.border).bg(open ? t.selected : t.surface)
      .child(v_flex().id(`rv-res-ph-${p.id}`).gap(2).cursor_pointer().on_click((_e, cx) => { this.resOpen = open ? null : p.id; cx.notify(); }).tooltip(open ? "Fold this path" : "Open this path: its picture, the action and the probe, and light it on the map")
        .child(h_flex().gap(10).items_start()
          .child(div().flex_none().w(18).text_color(t.muted).child(`${k + 1}`))
          .child(div().flex_1().min_w(0).text_size(TYPE.title).font_semibold().whitespace_normal().line_height(1.4).child(resSentence(p)))
          .child(div().flex_none().max_w(320).text_size(TYPE.small).font_semibold().whitespace_normal().text_color(p.blocker ? t.ansi1 : p.wired ? t.ansi3 : p.result === "mitigated" ? t.ansi2 : t.muted).when(Boolean(p.wired?.today) && !p.blocker, (e) => e.id(`rv-res-wired-${p.id}`).tooltip(`Not today: ${p.wired.today}`)).child(word))
          .child(div().flex_none().text_size(TYPE.small).text_color(ev[2]).child(`${ev[0]} ${ev[1]}`))
          .child(div().flex_none().text_color(t.muted).child(open ? "▾" : "▸")))
        .when(Boolean(meta.today), (e) => e.child(div().id(`rv-res-today-${p.id}`).pl(28).max_w(760).text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(meta.today ?? "")))
        .child(h_flex().pl(28).gap(8).flex_wrap().text_size(TYPE.small).text_color(t.muted).child(div().id(`rv-res-meta-${p.id}`).min_w(0).max_w(732).whitespace_normal().when(Boolean(meta.tip), (e) => e.tooltip(meta.tip ?? "")).child(meta.text))
          .child(div().id(`rv-res-seen-${p.id}`).flex_none().text_color(silent ? t.ansi1 : t.muted).tooltip(silent ? "Nothing shows this failure: no alarm, no log line, no metric names it." : `What on-call sees: ${seenAs || "the run says it is visible, without saying how"}${p.signal_said ? `\nThe run said ${resWord(p.signal_said)}; the path raises, so at least the platform's error metric shows it.` : ""}`).child(silent ? "✕ silent" : "seen"))
          .when(Boolean(p.also_security), (e) => e.child(div().id(`rv-res-sec-${p.id}`).text_color(t.accent).cursor_pointer().on_click((_e, cx) => { this.page = "blast"; cx.stop_propagation(); cx.notify(); }).child("also in Security ↗")))))
      .when(open, (e) => e.child(v_flex().pl(28).gap(8)
        .children([this.resPicture(t, p)].filter(Boolean))
        .when(Boolean(p.note), (x) => x.child(div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(p.note)))
        .when(Boolean(p.action), (x) => x.child(div().text_size(TYPE.body).whitespace_normal().child(p.action)))
        .children(fs.slice(0, 4).map((f) => h_flex().id(`rv-res-f-${p.id}-${f.id}`).gap(6).items_center().text_size(TYPE.small).cursor_pointer().hover((x) => x.bg(t.hover)).rounded(4)
          .on_click((_e, cx) => { this.openFinding(f); this.jumpTo(`${f.file}:${f.line}`, cx); cx.notify(); })
          // Wave C2: the title in full; "confirmed" when the probe of this path reproduced it (views.js withProbes).
          .child(badge(t, f.severity, t[SEV[f.severity]] ?? t.accent)).child(div().min_w(0).whitespace_normal().child(plain(f.title)))
          .when(f.certainty === "confirmed", (x) => x.child(div().id(`rv-res-f-cf-${p.id}-${f.id}`).flex_none().text_color(t.ansi2).tooltip(`Confirmed: something that ran shows it.${probedText(f)}`).child(certaintyText(f))))
          .child(div().flex_none().text_color(t.muted).child(`${f.file.split("/").pop()}:${f.line} ↗`))))
        .when(Boolean(probe), (x) => x.child(this.resProbe(t, probe, datedByDiff(p))))));
  },
  // A path's one picture (views.js resPicture): the ladder, the budget's bullet chart, the race's timeline with what
  // on-call sees, or the writers of a shared state. On the surface, no grid.
  resPicture(t, p) {
    const kind = resPicture(p), at = (s, id) => (s ? div().id(id).flex_none().text_color(t.accent).cursor_pointer().hover((x) => x.underline()).on_click((_e, cx) => this.jumpTo(s, cx)).child(`${s} ↗`) : div());
    const box = (el) => v_flex().p(16).gap(6).rounded(8).border_1().border_color(t.border).bg(t.background).text_size(TYPE.small).child(el);
    if (kind === "ladder") return box(v_flex().gap(4)
      .children(p.ladder.map((r, k) => h_flex().gap(12).items_center().child(div().w(240).flex_none().text_color(t.muted).child(r.name)).child(div().w(90).flex_none().font_semibold().text_color(/no limit|∞/.test(r.factor) ? t.ansi1 : t.foreground).child(r.factor))
        .child(at(r.at, `rv-res-l-${p.id}-${k}`)).when(Boolean(r.note), (e) => e.child(div().min_w(0).truncate().text_color(t.muted).child(r.note)))))
      .when(Boolean(p.product), (e) => e.child(div().pt(4).font_semibold().whitespace_normal().child(`= ${p.product}`)))
      // A redelivered batch that also outlasts its timeout comes back by that too: its budget under the ladder (R2 V1).
      .when(p.budget?.over_s > 0, (e) => e.child(v_flex().pt(10).gap(6).child(bulletChart(t, `rv-res-b-${p.id}`, budgetBar(p.budget), `worst case ${p.budget.value_s} s`, `the ${p.budget.limit_s} s timeout`))
        .child(h_flex().gap(8).text_color(t.muted).child(div().min_w(0).whitespace_normal().child(p.budget.note ?? "")).child(at(p.budget.at, `rv-res-b-at-${p.id}`))))));
    if (kind === "budget") return box(v_flex().gap(6).child(bulletChart(t, `rv-res-b-${p.id}`, budgetBar(p.budget), `worst case ${p.budget.value_s} s`, `the ${p.budget.limit_s} s timeout`))
      .child(h_flex().gap(8).text_color(t.muted).child(div().min_w(0).whitespace_normal().child(p.budget.note ?? "")).child(at(p.budget.at, `rv-res-b-at-${p.id}`))));
    if (kind === "race") {
      // Columns: the first actor, the shared state, the others (a step's actor matched by its name's start: the run
      // says "send_reminders" for the actor "send_reminders run"). What on-call sees: a lane with a text per step (an
      // older run), a sentence under the timeline (races[].oncall), else nothing, never an invented "nothing". A race
      // that cannot happen today (possible_today false) says so first, in grey.
      const r = p.race, actors = (r.actors ?? ["A", "B"]).slice(0, 3), cell = (w, el, col = t.foreground) => div().w(w).flex_none().text_color(col).whitespace_normal().child(el);
      const is = (a, who) => a === who || String(a).startsWith(`${who} `) || String(who).startsWith(`${a} `), lane = Array.isArray(r.oncall) && r.oncall.some(Boolean);
      const row = (f, mid) => [f(actors[0]), mid, ...actors.slice(1).map(f)];
      return box(v_flex().gap(4)
        .when(r.possible_today === false, (e) => e.child(div().id(`rv-res-r-${p.id}-today`).text_color(t.muted).whitespace_normal().child(r.note || "Not possible today.")))
        .child(h_flex().gap(12).font_semibold().text_color(t.muted).children(row((a) => cell(180, a, t.muted), cell(140, r.shared ?? "state", t.muted))).when(lane, (e) => e.child(cell(180, "what on-call sees", t.muted))))
        .children(r.steps.slice(0, 6).map(([who, text], k) => {
          const breaks = k === r.breaks_at, mine = (a) => cell(180, is(a, who) ? `${breaks ? "✗ " : ""}${text}` : "", breaks && is(a, who) ? t.ansi1 : t.foreground);
          return h_flex().id(`rv-res-r-${p.id}-${k}`).gap(12).py(2).border_t(1).border_color(t.border).children(row(mine, cell(140, breaks ? "breaks here" : "│", breaks ? t.ansi1 : t.dim)))
            .when(lane, (e) => e.child(cell(180, r.oncall[k] ?? "", t.muted)));
        }))
        .when(typeof r.oncall === "string" && r.oncall.trim() !== "", (e) => e.child(div().pt(4).text_color(t.muted).whitespace_normal().child(`What on-call sees: ${r.oncall}`))));
    }
    // The writers of a shared state: the rule they keep (state[].invariant) on top, each writer with its guard and line,
    // in red the ones without a guard or that break the rule (writers[].breaks).
    if (kind === "writers") return box(v_flex().gap(4)
      .when(Boolean(p.invariant), (e) => e.child(div().pb(2).whitespace_normal().child(`Rule: ${p.invariant}`)))
      .child(h_flex().gap(12).font_semibold().text_color(t.muted).child(div().w(200).child(p.state ?? "state")).child(div().w(60).child("")).child(div().w(200).child("guard")))
      .children(p.writers.map((w, k) => h_flex().gap(12).items_center().child(div().w(200).child(this.ai?.arch?.nodes.find((n) => n.id === w.node)?.label ?? w.node ?? String(w.at ?? "").split("/").pop()))
        .child(div().w(60).font_semibold().text_color(w.kind === "W" && (!w.guard || w.guard === "none" || w.breaks) ? t.ansi1 : t.foreground).child(w.kind))
        .child(div().w(200).text_color(t.muted).whitespace_normal().child(w.kind === "W" ? w.guard || "none" : "")).child(at(w.at, `rv-res-w-${p.id}-${k}`))
        .when(Boolean(w.breaks), (e) => e.child(div().text_color(t.ansi1).child("breaks the rule"))))));
    // No picture of the path's kind: a grey line says which data is missing, never another path's picture.
    return div().id(`rv-res-nopic-${p.id}`).text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(resNoPicture(p)); // views.js: the same words as the page's Markdown
  },
  // A probe in its path: before its run the claim and Run probe (for someone else's PR the script and the sentence of
  // what it does first); after it the result as symbol and word, strength, the one number, the base, head and time,
  // script and output folded. A probe on an older head is grey.
  resProbe(t, x, byDiff = false) {
    // pre_existing: true (the base breaks the same way) greys the probe; "unknown" (the base was not comparable) says so.
    const done = x.status === "done", now = this.worktree?.head ?? this.head, old = x.older || x.pre_existing === true || (done && x.head && now && x.head !== now), open = this.resProbeOpen === x.id;
    // The base in words (views.js probeBaseWord): the runner's verdict (threads.js BASE_WORDS: already on the base, new in
    // this PR, unknown on the base, not on the base) where the diff could not date the path; where it could, that word
    // stands at the path and the probe says only what its script did on the base, so old and new are said once.
    // The base's line without the runner's temporary paths (a file by its name), at most about a line long.
    const short = (l) => { const v = String(l).replace(/(?:\/[^\s/'"()]+)+\/([^\s/'"()]+)/g, "$1"); return v.length > 140 ? `${v.slice(0, 139)}…` : v; };
    const bw = probeBaseWord(x, byDiff, TH.BASE_WORDS), base = bw ? `${bw.dates ? bw.word : `on base: ${bw.word}`}${x.base.line ? `, ${short(x.base.line)}` : ""}` : x.base && `on base: ${x.base}`;
    // Not run: the runner never ran a script (no head, no time), with why; never "script failed".
    const notRun = done && (x.result === "not_run" || (x.result === "script_failed" && !x.head && !x.ms));
    const RES = { reproduced: ["✓", "reproduced", t.foreground], not_reproduced: ["✗", "not reproduced", t.muted], script_failed: ["!", "script failed", t.ansi3], unknown: ["?", "unknown", t.muted] };
    const r = notRun ? ["·", "not run", t.muted] : RES[x.result] ?? ["·", resWord(x.result), t.muted];
    const STRENGTH = { runs_pr_code: "runs PR code", forced_schedule: "forced schedule", models_env: "models the environment" };
    // The fence the script ran in (probe.py: sandbox-exec, bwrap), from the runner's result, else this machine's.
    const fence = this.deep.probes?.[this.probeKey(x.id)]?.sandbox ?? x.sandbox ?? (this.probeBarrier && this.probeBarrier !== "none" ? this.probeBarrier : null);
    const sandbox = x.network_barrier === false ? "no sandbox" : x.network_barrier ? `${fence ?? "sandbox"}, no network` : null;
    const price = `about $${PROBE_TYPICAL.usd.toFixed(2)}, ${PROBE_TYPICAL.min} min`;
    const start = (_e, cx) => this.command(`probe:${x.id}`, cx), trusted = this.trustedPr();
    return v_flex().id(`rv-res-probe-${x.id}`).gap(4).p(10).rounded(6).border_1().border_color(t.border).text_size(TYPE.small).when(Boolean(old), (e) => e.opacity(resFade(t)))
      .when(done, (e) => e.child(h_flex().gap(8).flex_wrap().items_center().child(div().font_semibold().text_color(r[2]).child(`Probe ${r[0]} ${r[1]}`))
        .child(div().min_w(0).whitespace_normal().text_color(t.muted).child((notRun ? [x.reason || x.number || "no script ran"] : [STRENGTH[x.strength] ?? x.strength, x.ms != null && `${(x.ms / 1000).toFixed(1)} s`, sandbox, x.head && String(x.head).slice(0, 7), base,
          x.pre_existing === true && !byDiff && "breaks the same way on the base", x.pre_existing === "unknown" && "old or new unclear: the base was not comparable"]).filter(Boolean).join(" · "))))
        .when(Boolean(x.number) && !notRun, (y) => y.child(div().whitespace_normal().child(x.number)))
        .when(notRun, (y) => y.child(h_flex().child(pill(`rv-res-again-${x.id}`, t, `Run probe again (${price})`, start).tooltip("One model call writes a script; the runner starts it against the PR head and the base, in a sandbox without network, for at most 30 s"))))
        .when(!notRun, (y) => y.child(h_flex().gap(8).child(div().id(`rv-res-pso-${x.id}`).text_color(t.accent).cursor_pointer().on_click((_e, cx) => { this.resProbeOpen = open ? null : x.id; cx.notify(); }).child(open ? "script and output ▾" : "script and output ▸"))))
        .when(open && !notRun, (y) => y.child(div().p(8).rounded(4).bg(t.surface).font_family(settings().font_family ?? "JetBrains Mono").text_size(TYPE.small).whitespace_normal().child(`${x.script ?? ""}\n— output —\n${x.output ?? ""}`))))
      .when(!done, (e) => e.child(div().whitespace_normal().child(`Probe: ${x.claim ?? x.kind ?? "a script"} (${STRENGTH[x.strength] ?? x.strength ?? ""})`))
        // Someone else's PR, or no network barrier: R-P asks first (status confirm, its sentence in needs), no popup.
        .when(x.status === "confirm" || (!trusted && !x.status), (y) => y.child(div().text_color(t.ansi3).whitespace_normal().child(x.needs || "Runs code from this PR on your machine, without network, for at most 30 s.")))
        .when(x.status === "running", (y) => y.child(div().text_color(t.muted).child("Running…")))
        .when(x.status === "confirm", (y) => y.child(h_flex().gap(6).child(pill(`rv-res-yes-${x.id}`, t, `Run probe (${price})`, (_e, cx) => this.command(`probe:${x.id}:yes`, cx), false, t.foreground))
          .child(pill(`rv-res-no-${x.id}`, t, "Cancel", (_e, cx) => this.command(`probe:${x.id}:no`, cx)))))
        .when(x.status !== "running" && x.status !== "confirm", (y) => y.child(h_flex().gap(8).items_center().child(pill(`rv-res-run-${x.id}`, t, `Run probe (${price})`, start).tooltip("One model call writes a script; the runner starts it against the PR head and the base, in an empty export of the code, in a sandbox without network, for at most 30 s"))
          .child(div().text_color(t.muted).child("in a sandbox, without network, at most 30 s")))));
  },
  // Under the paths: Other checks (one word each, the clean ones folded), Not checkable with why (each once, the run's
  // texts about its own tools left out), what nothing shows after the merge (add a signal before it), and what to watch
  // after it (views.js resWatch: one line per entry, one entry per queue).
  resRest(t, res) {
    const checks = res.checks ?? [], bad = checks.filter((c) => c.result !== "clean" && c.result !== "not_checkable"), ok = checks.filter((c) => c.result === "clean"), open = Boolean(this.resClean);
    const WORD = { finding: ["finding", t.foreground], not_checkable: ["not checkable", t.ansi3], elsewhere: ["elsewhere", t.muted], clean: ["clean", t.ansi2] };
    const NAME = { cors: "CORS", cache_control: "Cache-Control", rollback: "Rollback", limits: "Limits", cardinality: "Metric cardinality", clocks: "Clocks", health: "Health", shutdown: "Shutdown", alarms: "Alarms" };
    const link = (at, id) => div().id(id).flex_none().text_color(t.accent).cursor_pointer().on_click((_e, cx) => this.jumpTo(at, cx)).child(`${at} ↗`);
    const row = (c, k) => h_flex().id(`rv-res-c-${k}`).gap(10).items_start().text_size(TYPE.small).child(div().w(150).flex_none().font_semibold().child(NAME[c.check] ?? resWord(c.check).replace(/^./, (ch) => ch.toUpperCase())))
      .child(div().w(100).flex_none().text_color(WORD[c.result]?.[1] ?? t.muted).child(WORD[c.result]?.[0] ?? resWord(c.result))).child(div().flex_1().min_w(0).whitespace_normal().text_color(t.muted).child(resRefs(c.why, this.resNums)))
      .when(Boolean(c.at), (e) => e.child(link(c.at, `rv-res-c-at-${k}`)));
    const label = (s) => div().w(170).flex_none().text_size(TYPE.body).font_semibold().child(s);
    const lines = (id, items, none) => v_flex().id(id).flex_1().min_w(0).gap(3).text_size(TYPE.small).children(items.length ? items.map((x, k) => h_flex().id(`${id}-${k}`).gap(10).items_start()
      .child(div().flex_1().min_w(0).whitespace_normal().child(x.text)).when(Boolean(x.at), (e) => e.child(link(x.at, `${id}-${k}-at`)))) : [div().text_color(t.muted).child(none)]);
    const nc = [...checks.filter((c) => c.result === "not_checkable").map((c) => ({ text: `${NAME[c.check] ?? resWord(c.check).replace(/^./, (ch) => ch.toUpperCase())}: ${resRefs(c.why, this.resNums)}`, at: c.at })),
      ...(res.not_checked ?? []).filter((s) => !resToolText(s)).map((s) => ({ text: resRefs(s, this.resNums) }))];
    // Without blind spots or calls (an older block) the run's own watch list stays.
    const w = resWatch(res, this.ai?.arch), watch = w.watch.length || w.before.length || (res.blind_spots ?? []).length ? w.watch : (res.watch ?? []).map((s) => ({ text: s }));
    return v_flex().id("rv-res-rest").gap(12).pt(8)
      .child(h_flex().gap(12).items_start().child(label("Other checks")).child(v_flex().flex_1().min_w(0).gap(4).children(bad.map(row))
        .when(ok.length > 0, (e) => e.child(div().id("rv-res-clean").text_size(TYPE.small).text_color(t.muted).cursor_pointer().on_click((_e, cx) => { this.resClean = !open; cx.notify(); }).child(`Checked, clean · ${ok.length} ${open ? "▾" : "▸"}`)))
        .when(open, (e) => e.children(ok.map((c, k) => row(c, `ok${k}`))))))
      .child(h_flex().gap(12).items_start().child(label("Not checkable")).child(div().flex_1().min_w(0).text_color(t.muted).child(lines("rv-res-nc", nc, "none"))))
      .when(w.before.length > 0, (e) => e.child(h_flex().gap(12).items_start().child(label("Before merge, not observable")).child(div().flex_1().min_w(0).text_color(t.ansi1).child(lines("rv-res-blind", w.before, "")))))
      .child(h_flex().gap(12).items_start().child(label("After merge, watch")).child(lines("rv-res-watch", watch, "nothing named")));
  },
  // No security data at all: why, and the run that makes it, with its price (the last run's, else the model's name).
  secEmpty(t) {
    const offer = this.secOfferText();
    return v_flex().id("rv-sec-empty").gap(10).p(16).rounded(10).border_1().border_color(t.border).bg(t.surface).max_w(760)
      .child(div().text_size(TYPE.body).whitespace_normal().line_height(1.5).child("Nothing here yet: the security review has not run on this PR, and it does not start by itself for every PR."))
      .when(Boolean(offer), (e) => e.child(div().id("rv-sec-offer").text_size(TYPE.body).whitespace_normal().line_height(1.5).text_color(t.ansi3).child(offer ?? "")))
      .child(this.runOffer("security", t));
  },
  // What each run says it checked: a line per run (not run, running, failed with its error, no findings, n findings;
  // what it read and left out), then a row per area with the run's own word for it. A self-report, and named so.
  secScope(t, title) {
    const runs = this.find.runs, all = this.findings(), tab = scopeTable(this.ai?.scope, runs);
    const from = (k) => all.filter((f) => f.sources.some((x) => x.reviewer === k)).length;
    const conflicts = scopeConflicts(tab, this.openFindings());
    // What a reviewer run was allowed to do: the run's own list (runs[kind].allowed, when reviewers.py writes it), else
    // what reviewers.py PERMISSIONS grants every Claude reviewer today. The analysis and Codex: not said.
    const allowedOf = (k, r) => (!r?.state || k === "analysis" || k === "codex" ? null : Array.isArray(r.allowed) && r.allowed.length ? `allowed: ${r.allowed.map((x) => String(x).replace(/(?:\/[^\s/()]+)+\/([^\s/()]+)/g, "$1")).join(", ")}` // a helper's path by its file name
      : "allowed: read files in the checkout and its git history; no network, no writes");
    const lines = [["analysis", "Analysis", this.aiBusy ? { state: "running" } : this.ai ? { state: "done" } : null, null], ...reviewersNow().map(([k, [label]]) => [k, label, runs[k] ?? null, runs[k]?.scope ?? null])];
    const RESULT = { finding: ["Finding", t.ansi1], clean: ["Clean", t.ansi2], not_checked: ["Not checked", t.ansi3] };
    // A row is one line each (its notes cut); a click on it shows the whole texts and, under a "Finding", that run's
    // findings for the area (views.js areaFindings), each a link to the finding. "Clean" names what the run read.
    const read = (k) => (k === "analysis" ? this.ai?.scope?.detailed ?? this.ai?.scope?.files ?? [] : runs[k]?.scope?.read ?? []);
    const open = (area) => this.scopeRow === area, toggle = (area) => (_e, cx) => { this.scopeRow = open(area) ? null : area; cx.notify(); };
    const cell = (c, area, k) => {
      if (!c) return div().text_color(t.dim).child("–");
      const found = c.result === "finding" ? this.keep(`area|${area}|${k}`, [all], () => areaFindings(area, k, all)) : [], files = read(k);
      return v_flex().id(`rv-sec-sc-${area}-${k}`).gap(4).cursor_pointer().on_click(toggle(area))
        .tooltip(c.result === "clean" ? (files.length ? `Clean, as this run reports it. It read:\n${files.join("\n")}` : "Clean, as this run reports it; it names no file it read.") : open(area) ? "Fold this row" : "Show the whole text and the findings behind it")
        .child(h_flex().gap(6).items_start().child(c.result === "clean" && !files.length ? chip(t, "Clean, no file named", t.ansi3, false) : chip(t, RESULT[c.result][0], RESULT[c.result][1], c.result !== "clean"))
          .child(div().flex_1().min_w(0).text_color(t.muted).when(!open(area), (e) => e.truncate()).when(open(area), (e) => e.whitespace_normal())
            .child(c.result === "clean" && files.length ? `${c.note ? `${c.note} · ` : ""}${files.length} ${files.length === 1 ? "file" : "files"} read` : c.note))
          .when(found.length > 0 && !open(area), (e) => e.child(div().flex_none().text_color(t.muted).child(`${found.length} ▸`))))
        .when(open(area) && c.result === "finding", (e) => e.children(found.length ? found.map((f) => h_flex().id(`rv-sec-sc-f-${area}-${k}-${f.id}`).gap(6).items_start().px(4).rounded(4).hover((x) => x.bg(t.hover))
          .tooltip("Open this finding and show its line in the diff").on_click((_e, cx) => { this.openFinding(f); this.jumpTo(`${f.file}:${f.line}`, cx); cx.stop_propagation(); cx.notify(); })
          .child(badge(t, f.severity, t[SEV[f.severity]] ?? t.accent)).child(div().flex_1().min_w(0).whitespace_normal().child(plain(f.title))))
          : [div().text_color(t.muted).whitespace_normal().child("None of this run's findings names this area in its words; see the Findings tab.")]));
    };
    return v_flex().id("rv-sec-scope").gap(8).p(12).rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(title("What each run checked"))
      .child(div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child("Each model run reports this about itself. It says where the run looked, not that the code is safe; “–” means the area was not part of that run."))
      .child(v_flex().gap(3).children(lines.map(([k, label, r, scope]) => {
        const failed = r?.state === "failed";
        const whole = this.scopeRow === `run:${k}`;
        return h_flex().id(`rv-sec-run-${k}`).gap(8).items_start().text_size(TYPE.small).line_height(1.5).cursor_pointer().on_click(toggle(`run:${k}`)).tooltip(whole ? "Fold this line" : "Show the whole line")
          .child(div().w(150).flex_none().font_semibold().child(label))
          .child(div().flex_1().min_w(0).when(whole, (e) => e.whitespace_normal()).when(!whole, (e) => e.truncate()).text_color(failed ? t.ansi1 : r?.state ? t.foreground : t.muted)
            .child([runSummary(r, from(k)), allowedOf(k, r), scope?.read?.length ? `read: ${scope.read.join(", ")}` : null, scope?.skipped?.length ? `left out: ${scope.skipped.map(skipText).filter(Boolean).join("; ")}` : null,
              r?.state === "done" && k !== "analysis" && !scope ? "it reported no scope" : null].filter(Boolean).join(" · ")));
      })))
      // An area the runs contradict each other on, or that a run calls clean while a finding names it in its effect
      // (views.js scopeConflicts): marked in its first cell, the reason in the tooltip and in the opened row.
      .child(tab.rows.length ? this.table(t, "rv-sec-scope-t", [["Area", 150], ...tab.cols.map((k) => [REVIEWERS[k]?.[0] ?? k, null])], tab.rows.map((r) => [
        conflicts.has(r.area) ? v_flex().id(`rv-sec-sc-x-${r.area}`).gap(2).cursor_pointer().on_click(toggle(r.area)).tooltip(conflicts.get(r.area).text)
          .child(div().child(AREA_NAME[r.area] ?? r.area)).child(div().text_size(TYPE.small).text_color(t.ansi3).child("⚠ Contradiction"))
          .when(open(r.area), (e) => e.child(div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(conflicts.get(r.area).text))) : AREA_NAME[r.area] ?? r.area,
        ...tab.cols.map((k) => cell(r.cells[k], r.area, k))]))
        : div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child("No run has reported what it checked: the analysis is older than this report, or nothing has run yet."));
  },
  // ---- a run's model: the recommended class (pr.js recommendModel) one click away, a class up or down in a small menu,
  // each with its price. The person's other choice is kept per review and kind (deep.json runModels).
  runFacts() {
    const files = this.patch ?? [];
    return { lines: files.reduce((n, f) => n + (f.add ?? 0) + (f.del ?? 0), 0), files: files.length, rules: (this.ctx?.security_trigger?.reasons ?? []).map((x) => x?.rule).filter(Boolean), risk: this.ai?.mergeRisk?.level ?? null };
  },
  runTier(kind) { return { ...recommendModel(kind, this.runFacts()), chosen: this.deep.runModels?.[`${this.deepKey()}|${kind}`] ?? null }; },
  // What a run of this kind costs on a class: the last run's cost scaled by the classes' output prices, else its cap.
  // ponytail: one past run as the measure; a mean over runs when there are several kinds of PRs to compare.
  runPrice(kind, tier) {
    const r = kind === "analysis" ? (this.ai?.cost > 0 ? { cost: this.ai.cost, model: this.ai.model_id ?? this.ai.model } : null) : this.find.runs[kind]?.cost > 0 ? this.find.runs[kind] : null;
    const typical = RUN_TYPICAL[kind]?.[tier]; // measured before a first run (pr.js RUN_TYPICAL)
    return r ? `about $${((r.cost * priceOf(tier)[1]) / priceOf(r.model)[1]).toFixed(2)}${r.ms > 0 ? `, ${Math.max(1, Math.round(r.ms / 60000))} min` : ""}` : typical ? `about $${typical.usd.toFixed(2)}, ${Math.round(typical.s / 60) || 1} min` : `capped at $${REVIEW_CAP[tier]}`;
  },
  // "<run>: <model> recommended because …" with Run on that model and Change model (a class up or down). kind: one
  // that can start from here (security; the Overview adds analysis); null for another.
  runOffer(kind, t) {
    const START = { security: (tier, cx) => this.runReviewer("security", cx, null, tier), resilience: (tier, cx) => this.runReviewer("resilience", cx, null, tier) }, NAME = { analysis: "Analysis", security: "Security review", resilience: "Resilience review", verify: "Verify", ask: "Ask", fix: "Fix" };
    if (!START[kind]) return null;
    const r = this.runTier(kind), tier = r.chosen ?? r.tier, steps = tierSteps(tier), menu = this.offerMenu === kind, label = (x) => MODELS[x]?.label ?? x, last = this.find.runs?.[kind];
    const choose = (to, cx) => { const k = `${this.deepKey()}|${kind}`; this.offerMenu = null; this.updateDeep(cx, (d) => ({ ...d, runModels: { ...(d.runModels ?? {}), [k]: to === r.tier ? null : to } })); cx.notify(); };
    return h_flex().id(`rv-offer-${kind}`).w_full().min_w(0).gap(8).items_center().flex_wrap().text_size(TYPE.body)
      .child(div().w_full().min_w(0).whitespace_normal().child(r.chosen && r.chosen !== r.tier ? `${NAME[kind]}: ${label(tier)}, your choice; ${label(r.tier)} is recommended because ${r.why}.` : `${NAME[kind]}: ${label(tier)} recommended because ${r.why}.`))
      .child(pill(`rv-offer-run-${kind}`, t, runLabel(last, this.runPrice(kind, tier), last?.at ? ago(last.at) : ""), (_e, cx) => { this.offerMenu = null; START[kind](tier, cx); }, false, t.foreground)
        .tooltip(`${last?.state === "done" ? "The same run again, paid again: " : ""}one ${label(tier)} call, read-only on the PR head; it stops at $${REVIEW_CAP[tier]}`))
      .child(pill(`rv-offer-ch-${kind}`, t, menu ? "Change model ▴" : "Change model ▾", (_e, cx) => { this.offerMenu = menu ? null : kind; cx.notify(); }).tooltip("A class up or down for this run; Haiku is not offered for code"))
      .when(menu, (e) => e.children([["up", steps.up], ["down", steps.down]].filter(([, x]) => x).map(([dir, x]) => pill(`rv-offer-${dir}-${kind}`, t, `${label(x)} (${this.runPrice(kind, x)})${x === r.tier ? " · recommended" : ""}`, (_e, cx) => choose(x, cx))
        .tooltip(dir === "up" ? "A larger model: slower and dearer, better at long and subtle code" : "A smaller model: faster and cheaper"))));
  },
  // Whether the PR's repo is public, asked once per repo (gh repo view): the Security page says who can read a comment.
  loadVisibility(cx) {
    const repo = this.prSel?.repo;
    if (!repo || this.repoVis?.[repo] !== undefined) return;
    this.repoVis = { ...this.repoVis, [repo]: null };
    const argv = [...this.ctxEnv(this.ctxId()), "gh", "repo", "view", repo, "--json", "visibility", "--jq", ".visibility"];
    cx.spawn(async (cx) => {
      const r = await exec(argv[0], argv.slice(1), { timeout: 20000 }).catch(() => null);
      if (r?.code === 0 && r.stdout.trim()) { this.repoVis = { ...this.repoVis, [repo]: r.stdout.trim() }; cx.notify(); }
    });
  },

  // The CLIs' models for this PR's context (models.py), asked at most once a day per context: Claude lists what that
  // account may use, Codex what it offers. Kept in shared "review.models" and pr-data/models.json.
  loadModels(cx) {
    const ctx = this.ctxReq(), id = ctx?.id ?? "default", d = modelsDoc()[id], busy = (this.modelsBusy ??= new Set());
    if ((d && Date.now() - d.at < 86400000) || busy.has(id)) return;
    busy.add(id);
    cx.spawn(async (cx) => {
      const r = await exec("python3", [`${appHome()}/mods/pr-review/models.py`, JSON.stringify({ context: ctx })], { timeout: 90000 }).catch(() => null);
      let out = null;
      try { out = r?.code === 0 ? JSON.parse(r.stdout) : null; } catch { /* no answer */ }
      if (!out?.claude?.length && !out?.codex?.length) return; // busy stays: no second try this session
      busy.delete(id);
      const doc = { ...modelsDoc(), [id]: { at: Date.now(), claude: out.claude ?? [], codex: out.codex ?? [] } };
      setShared("review.models", doc);
      readTextFile(modelsFile()).catch(() => null).then((before) => writeTextFile(modelsFile(), JSON.stringify(doc), before)).catch(() => null); // over the list from before (told nothing, writeTextFile leaves an existing file as it is)
      cx.notify();
    });
  },
  // A rough price before running: input from the diff size, output and thinking from earlier runs; the cap is review.py's.
  estimate(m) {
    const chars = Math.min(MODELS[tierOf(m)].chars, (this.hunks ?? []).reduce((n, h) => n + h.lines.reduce((k, l) => k + l.length + 1, 0), 0));
    const [inp, out] = priceOf(resolvedOf(m));
    // ponytail: reading the code with tools multiplies input; ×4 from the first runs, a guess until the ledger says more.
    const usd = (((chars / 3.5 + 3000) * 4) * inp + 15000 * out) / 1e6;
    return `≈ $${usd.toFixed(2)} · cap $${CAP[tierOf(m)]}`;
  },

  // Statements with their source: a "spec" tag before spec-only ones (only in the description/ticket, not in the
  // diff), existing ones muted, and the evidence (file:line) as a link into the diff.
  statements(t, list, id) {
    return v_flex().gap(3).children(list.map((x, k) => h_flex().id(`${id}-${k}`).gap(6).items_start().text_size(TYPE.body).line_height(1.5)
      .when(x.source === "spec", (e) => e.child(div().pt(2).child(specTag(t, `${id}-${k}-sp`))))
      .child(div().flex_1().min_w(0).whitespace_normal().text_color(x.source === "existing" ? t.muted : t.foreground).child(x.text))
      .when(Boolean(x.evidence) && x.source !== "spec", (e) => e.child(div().id(`${id}-${k}-ev`).tooltip("Jump to this code in the diff").flex_none().text_size(TYPE.small).text_color(t.accent).cursor_pointer()
        .child(`${String(x.evidence).split("/").pop()} ↗`).on_click((_e, cx) => { this.jumpTo(x.evidence, cx); cx.stop_propagation(); })))));
  },

  // Short points for the Overview's right column: each one line (cut, the whole sentence in the tooltip), the first
  // three shown and the rest behind "n more"; a spec-only one tagged, the file link muted.
  bullets(t, list, id) {
    const all = this.askOpen?.has(id), shown = all ? list : list.slice(0, 3);
    return v_flex().gap(2).max_w(600).children(shown.map((x, k) => h_flex().id(`${id}-${k}`).tooltip(plain(x.text)).gap(6).items_center().text_size(TYPE.body)
      .when(x.source === "spec", (e) => e.child(specTag(t, `${id}-${k}-sp`)))
      .child(div().flex_1().min_w(0).truncate().text_color(x.source === "existing" ? t.muted : t.foreground).child(plain(x.text)))
      .when(Boolean(x.evidence) && x.source !== "spec", (e) => e.child(div().id(`${id}-${k}-ev`).tooltip("Jump to this code in the diff").flex_none().text_size(TYPE.small).text_color(t.muted).cursor_pointer()
        .hover((s) => s.text_color(t.accent)).child(`${String(x.evidence).split("/").pop()} ↗`).on_click((_e, cx) => { this.jumpTo(x.evidence, cx); cx.stop_propagation(); })))))
      .when(list.length > 3, (e) => e.child(div().id(`${id}-more`).text_size(TYPE.small).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.toggleAsk(id); cx.notify(); }).child(all ? "Fewer ▴" : `${list.length - 3} more ▸`)));
  },

  // An ask's link to a spec-only element of the pictures: the Architecture page focused on it, or its layer.
  openSpec(el, cx) {
    if (el.page === "arch") { this.page = "arch"; if ((this.ai.arch?.nodes ?? []).some((n) => n.id === el.id)) this.archFocus = el.id; }
    else if (el.step !== null) { const i = this.steps().indexOf(this.ai.steps[el.step]); if (i >= 0) this.goStep(i, cx); }
    cx.notify();
  },

  // The Overview's left column: "Before merge" (pr.js beforeMerge, the most urgent first, the first six shown), then
  // one folded line each for the criteria, what is not in the task, the other findings and what nobody checked; "Not
  // checked" is open when nothing stands before the merge. Every row is one line, cut, the whole text in its tooltip.
  asksPane(t, list, rows) {
    const ai = this.ai, task = ai?.task ?? {}, specs = ai ? specElements(ai) : new Map(), n = (k, one) => `${k} ${k === 1 ? one : `${one}s`}`, soft = this.softText(t);
    const open = (k) => this.askOpen?.has(k), flip = (k) => (_e, cx) => { this.toggleAsk(k); cx.notify(); };
    // A criterion's state as a symbol in colour, its word in the tooltip: only the security part of the page is red.
    const STATE = { met: ["✓", "met", t.ansi2, "The diff does what this asks"], partly: ["◐", "partly", t.ansi3, "The diff does only part of what this asks"],
      broken: ["✗", "broken", t.foreground, "The code for this is there and breaks what this asks"], not_done: ["○", "not done", t.foreground, "Nothing in the diff does this"],
      extra: ["+", "extra", t.ansi4, "The diff does this, but the task did not ask for it"] };
    const place = (id, at) => div().id(id).tooltip("Jump to this line in the diff").flex_none().text_size(TYPE.small).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.accent))
      .on_click((_e, cx) => { this.jumpTo(at, cx); cx.stop_propagation(); }).child(`${at.split("/").pop()} ↗`);
    const placeEd = (id, at) => this.editAt(t, `${id}-ed`, at);
    // How sure a finding is, as words: a security finding in two parts (the flaw in the code, the way from outside),
    // another one only when it rests on an assumption.
    // The words of the Findings tab ("derived") and of the verdict line ("assumed reachable"), not a second pair.
    const REACH = { assumed: "assumed reachable", confirmed: "confirmed reachable", derived: "reachable by the code" };
    const sure = (f) => (f.security ? [f.certainty ? certaintyText(f) : "not rated", f.path_certainty && (REACH[f.path_certainty] ?? `reach ${f.path_certainty}`)].filter(Boolean).join(" · ") : f.certainty === "assumed" ? "assumed" : "");
    const finding = (f, id) => {
      const st = this.fstatus(f), settled = st === "fixed" || st === "dismissed", note = [sure(f), st !== "open" && FSTATUS[st]?.[0]].filter(Boolean).join(" · ");
      return h_flex().id(id).tooltip([f.title, `${f.severity[0].toUpperCase()}${f.severity.slice(1)}`, secWhy(f), certaintyLine(f), "Click to open this finding."].filter(Boolean).join("\n")).gap(8).items_center()
        .pl(10).pr(6).py(3).rounded(4).border_l(3).border_color(settled ? t.border : t[SEV[f.severity]] ?? t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.openFinding(f); this.jumpTo(`${f.file}:${f.line}`, cx); cx.stop_propagation(); })
        .child(f.security ? rowSign(t, "⛨", [f]) : div().w(SIGN_W).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_color(settled ? t.muted : t.foreground).child(f.title))
        .when(Boolean(note), (e) => e.child(div().flex_none().text_size(TYPE.small).text_color(t.muted).child(note)))
        .child(place(`${id}-at`, `${f.file}:${f.line}`)).children(placeEd(`${id}-at`, `${f.file}:${f.line}`));
    };
    // A criterion: symbol, short name and how many findings break it; one not met has its reason under it. A click
    // unfolds the whole wording, the reason and the findings.
    const ask = (r) => {
      const a = r.ask, [sym, word, col, tip] = STATE[a.state], on = open(a.id), fs = r.findings, hunk = a.hunks.find((x) => this.byId.has(x));
      const diff = (cx) => { this.tab = "files"; this.unfold(this.byId.get(hunk).path); this.visit(hunk, cx); this.scrollTo("files", hunk); cx.notify(); };
      return v_flex().id(`rv-ask-${a.id}`).px(6).py(3).gap(2).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(on ? "Fold this criterion" : "Show the whole criterion, why it stands so, and the findings that break it").on_click(flip(a.id))
        .child(h_flex().gap(8).items_center()
          .child(div().id(`rv-ask-${a.id}-st`).tooltip(`${word[0].toUpperCase()}${word.slice(1)}: ${tip.toLowerCase()}`).w(16).flex_none().font_semibold().text_color(col).child(sym))
          .child(div().min_w(0).when(!on, (e) => e.truncate()).when(on, (e) => e.whitespace_normal()).child(a.short || plain(a.text)))
          .when(fs.length > 0, (e) => e.child(div().flex_none().text_size(TYPE.small).text_color(t.muted).child(`${n(fs.length, "finding")} ${on ? "▾" : "▸"}`)))
          .when(!fs.length && Boolean(hunk), (e) => e.child(div().id(`rv-ask-${a.id}-diff`).tooltip("Show the code this is about in the diff").flex_none().text_size(TYPE.small).text_color(t.muted)
            .hover((s) => s.text_color(t.accent)).child("Show in diff ↗").on_click((_e, cx) => { diff(cx); cx.stop_propagation(); }))))
        .when(Boolean(a.why) && !on && ["broken", "partly", "not_done"].includes(a.state), (e) => e.child(div().pl(24).max_w(624).truncate().text_size(TYPE.small).text_color(soft).child(plain(a.why))))
        .when(on, (e) => e.child(v_flex().pl(24).max_w(624).gap(4)
          .when(Boolean(a.short), (x) => x.child(div().line_height(1.5).text_size(TYPE.small).child(TextView.markdown(`rv-ask-${ai.generated}-${a.id}`, a.text))))
          .when(Boolean(a.why), (x) => x.child(div().text_size(TYPE.small).line_height(1.45).text_color(soft).whitespace_normal().child(plain(a.why))))
          .when(r.unlinked, (x) => x.child(div().text_size(TYPE.small).text_color(t.muted).child("No finding names this yet.")))
          .when(a.elements.some((x) => specs.has(x)), (x) => x.child(h_flex().flex_wrap().gap(6).children(a.elements.filter((y) => specs.has(y)).map((y, k) => div().id(`rv-ask-${a.id}-sp${k}`).flex_none().px(5).rounded(4).border_1().border_dashed().border_color(t.ansi5)
            .text_size(TYPE.small).text_color(t.ansi5).cursor_pointer().tooltip("Spec only: in the picture, not found in the diff").child(`spec: ${specs.get(y).label} ↗`)
            .on_click((_e, cx) => { this.openSpec(specs.get(y), cx); cx.stop_propagation(); })))))
          .when(fs.length > 0, (x) => x.child(v_flex().pt(2).gap(2).children(fs.map((f) => finding(f, `rv-ask-${a.id}-f-${f.id}`)))))));
    };
    // A row of "Before merge": its symbol, what it is, the criteria it breaks, how sure, where.
    const SYM = { security: ["⛨", t.ansi1, "Security finding"], criterion: ["✗", t.foreground, "Finding that breaks a criterion"], finding: ["!", t.foreground, "High finding"], ask: ["○", t.foreground, "Criterion not met"],
      conflict: ["✗", t.foreground, "Merge conflict"], ci: ["✗", t.foreground, "Failed CI check"], rule: ["✗", t.foreground, "Failed repo rule"], verify: ["↻", t.ansi3, "Fix to verify"], overlap: ["⇄", t.muted, "Overlapping PR"],
      resilience: ["↯", t.foreground, "Resilience: a way a failure spreads"] };
    const mergeRow = (r, k) => {
      const f = r.finding, id = `rv-bm-${k}`, [sym, col, kindWord] = SYM[r.kind] ?? ["·", t.muted, ""], breaks = r.asks.map((a) => a.short || plain(a.text));
      const click = (_e, cx) => { this.goMergeRow(r, cx); cx.notify(); };
      return h_flex().id(id).tooltip([kindWord && `${sym} ${kindWord}`, r.title, r.why, breaks.length && `Breaks: ${breaks.join("; ")}`, f && certaintyLine(f), r.also && `Same cause also at ${r.also.join(", ")}`].filter(Boolean).join("\n")).gap(8).items_center().pl(10).pr(6).py(3).rounded(4).border_l(3)
        .border_color(f ? t[SEV[f.severity]] ?? t.muted : t.border).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(click)
        .child(r.kind === "security" || r.kind === "resilience" ? rowSign(t, sym, this.rowFindings(r)).font_semibold() : div().w(SIGN_W).flex_none().font_semibold().text_color(col).child(sym))
        .child(div().flex_1().min_w(0).truncate().child(r.kind === "ask" ? `${r.title}: ${r.ask.state === "not_done" ? "not done" : r.ask.state}` : r.title))
        .when(breaks.length > 0 && r.kind !== "ask", (e) => e.child(div().flex_none().max_w(200).truncate().text_size(TYPE.small).text_color(t.muted).child(`breaks ${breaks[0]}${breaks.length > 1 ? ` +${breaks.length - 1}` : ""}`)))
        .when(Boolean(f && sure(f)), (e) => e.child(div().flex_none().text_size(TYPE.small).text_color(t.muted).child(sure(f))))
        .when(Boolean(r.where), (e) => e.child(place(`${id}-at`, r.where)).children(placeEd(`${id}-at`, r.where)));
    };
    const head = (id, title, tip, right = null) => h_flex().id(id).tooltip(tip).pb(6).gap(8).items_center()
      .child(div().flex_1().min_w(0).text_size(TYPE.body).font_semibold().text_color(t.foreground).child(title)).when(Boolean(right), (e) => e.child(right));
    // A folded section: one line with what it holds and ▸; a click unfolds it under the line.
    const fold = (key, label, summary, tip, on) => h_flex().id(`rv-fold-${key}`).tooltip(on ? `Fold ${label.toLowerCase()}` : tip).mt(4).px(6).py(4).gap(10).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(flip(key))
      .child(div().flex_none().text_size(TYPE.body).font_semibold().child(label)).child(h_flex().flex_1().min_w(0).gap(6).items_center().text_size(TYPE.small).text_color(t.muted).child(summary))
      .child(div().flex_none().text_size(TYPE.small).text_color(t.muted).child(on ? "▾" : "▸"));
    const out = [];
    // Before merge: counted by group (views.js mergeGroups), at most five rows, the first of each group before a second
    const shown = open("bm-all") ? rows : mergeFirst(rows, 5), groups = mergeGroups(rows), hidden = rows.filter((r) => !shown.includes(r));
    // Its head has no counts by group: the verdict line two lines up says them (security, criteria, resilience), the
    // line under the five rows counts the rest by group. The counts in full are the head's tooltip.
    out.push(head("rv-bm", "Before merge", `What stands before the merge, most urgent first: security, the findings that break a criterion, criteria not met, then failed checks, fixes to verify and overlapping PRs.${groups.length ? `\n${rows.length} here: ${groups.map((p) => p.text).join(", ")}.` : ""}`));
    if (Boolean(task.note)) out.push(div().px(6).pb(4).text_size(TYPE.small).text_color(t.ansi3).truncate().child(task.note));
    if (!rows.length) out.push(div().px(6).text_size(TYPE.body).text_color(t.muted).child(ai ? "Nothing stands before the merge." : "No analysis yet: the reviewers' findings are below."));
    out.push(...shown.map(mergeRow));
    if (hidden.length) out.push(div().id("rv-bm-more").px(16).py(2).text_size(TYPE.small).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(flip("bm-all"))
      .child(`${hidden.length} more: ${mergeGroups(hidden).map((p) => p.text).join(", ")} ▸`));
    else if (open("bm-all") && rows.length > 5) out.push(div().id("rv-bm-less").px(16).py(2).text_size(TYPE.small).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(flip("bm-all")).child("Show the first five ▴"));
    out.push(div().h(14));
    // Criteria: met of all and their symbols in one line
    const crit = list.rows, extra = list.extra;
    // The symbols with their words ("3 broken · 1 partly · 1 not done"): "0 of 5 met" is the verdict line's, two lines up.
    const critWords = ["broken", "not_done", "partly", "met"].map((k) => [crit.filter((r) => r.ask.state === k).length, STATE[k][1]]).filter(([c]) => c).map(([c, w]) => `${c} ${w}`).join(" · ");
    if (crit.length) out.push(fold("crit", "Criteria", h_flex().gap(8).child(h_flex().gap(3).children(crit.map((r) => div().text_color(STATE[r.ask.state][2]).child(STATE[r.ask.state][0])))).child(critWords),
      `The task's criteria${list.marked ? " (the acceptance criteria and the rest of the description)" : ""}: click to show them`, open("crit")));
    if (crit.length && open("crit")) out.push(...crit.map(ask));
    if (ai && !crit.length && !extra.length) out.push(fold("crit", "Criteria", div().child("The analysis found no task in the PR description."), "No criteria", false));
    if (extra.length) out.push(fold("extra", "Not in the task", div().child(`${extra.length}`), "What the diff does that the task did not ask for: click to show it", open("extra")));
    if (extra.length && open("extra")) out.push(...extra.map(ask));
    // Other findings: unresolved, not before the merge; the ones already there before this PR folded inside
    const inRows = mergeHeld(rows, this.openFindings()), before = new Set(alreadyThere(this.openFindings()).map((x) => x.finding));
    const rest = this.openFindings().filter((f) => !inRows.has(f.id)), mine = rest.filter((f) => !before.has(f.id)), old = rest.filter((f) => before.has(f.id));
    const sevOf = (l) => ["high", "medium", "low"].map((k) => [k, l.filter((f) => f.severity === k).length]).filter(([, c]) => c).map(([k, c]) => `${c} ${k}`).join(", ");
    if (rest.length) out.push(fold("other", "Other findings", div().truncate().child(`${mine.length}${mine.length ? ` · ${sevOf(mine)}` : ""}${old.length ? ` · ${old.length} already there before this PR` : ""}`),
      "Unresolved findings that do not stand before the merge: click to show them", open("other")));
    if (rest.length && open("other")) {
      out.push(...mine.map((f) => finding(f, `rv-of-${f.id}`)));
      if (old.length) out.push(div().px(6).pt(6).text_size(TYPE.small).text_color(t.muted).child(`Already there before this PR · ${old.length}`), ...old.map((f) => finding(f, `rv-ob-${f.id}`)));
    }
    // Not checked: never missing; open when nothing stands before the merge
    const nc = notChecked({ ai, runs: this.find.runs, open: this.openFindings() }), ncOpen = open("nc") !== !rows.length;
    // Only what nobody checked: a finished security run is not offered again here (the Security page has Re-run), and
    // the findings that rest on an assumption are counted, not listed again (they stand above and in the Findings tab).
    const offer = this.find.runs?.security?.state === "done" ? null : this.runOffer?.("security", t) ?? null;
    // Folded: the summary; open: the lines under it say the same in full, so the head only keeps its name.
    out.push(fold("nc", "Not checked", div().truncate().child(ncOpen ? "" : `${nc.text} · resilience review: ${this.resLine()}`), "What no run says it checked, what rests on an assumption, and how far the security review got: click to show it", ncOpen));
    if (ncOpen) out.push(v_flex().pl(16).pr(6).gap(2).text_size(TYPE.small)
      .child(div().truncate().child(nc.areas.length ? `Areas no run checked: ${nc.areas.join(", ")}` : "Every area was checked by at least one run."))
      .when(nc.assumptions.length > 0, (e) => e.child(div().id("rv-nc-assumed").tooltip("They stand above and in the Findings tab, each with the word assumed").truncate()
        .child(`${nc.assumptions.length} ${nc.assumptions.length === 1 ? "finding rests" : "findings rest"} on an assumption nobody checked`)))
      .child(v_flex().w_full().min_w(0).gap(4).child(div().child(`Security review: ${nc.security}`)).when(Boolean(offer), (e) => e.child(offer)))
      .child(v_flex().w_full().min_w(0).gap(4).child(div().child(`Resilience review: ${this.resLine()}`)).when(!this.resNow() && this.find.runs?.resilience?.state !== "running", (e) => e.child(this.runOffer("resilience", t)))));
    return v_flex().flex_none().gap(2).text_size(TYPE.body).children(out);
  },

  // Each source with what it found: a number, "no findings" (it ran), "failed" or "not run" (the Findings tab's line
  // and its Markdown).
  findingSources(all = this.findings()) {
    const runs = this.find.runs, name = (k) => REVIEWERS[k]?.[0] ?? k;
    const ran = { analysis: Boolean(this.ai), ...Object.fromEntries(Object.keys(ALL_REVIEWERS).map((k) => [k, runs[k]?.state === "done"])) };
    return [...new Set(["analysis", ...reviewersNow().map(([k]) => k), ...all.flatMap((x) => x.sources.map((y) => y.reviewer))])].map((k) => {
      const n = all.filter((x) => x.sources.some((y) => y.reviewer === k)).length;
      return { k, n, text: runs[k]?.state === "running" ? `${name(k)}: running` : n ? `${name(k)} ${n}` : runs[k]?.state === "failed" ? `${name(k)}: failed` : ran[k] ? `${name(k)}: no findings` : `${name(k)}: not run` };
    }).filter((x) => x.k !== "ai" || x.n);
  },
  // The Findings tab: every finding once, one line each, in sections by state (pr.js findingStatus): the unresolved
  // ones with a fix sent (what is known about each fix, and Verify) and without, Fixed, Dismissed, then the AI notes. A click opens a finding in
  // place and shows its line in the diff. It has no filters of its own: the bar's Show switch is the one filter.
  findingsPane(t) {
    const all = this.findings(), c = this.counts(), runs = this.find.runs, toVerify = [...this.verifyList(), ...this.branchVerifyList()], notes = this.openSugs(), m = model();
    const by = (...st) => all.filter((x) => st.includes(this.fstatus(x)));
    const unresolved = by("open", "recheck"), sent = by("progress");
    const name = (k) => REVIEWERS[k]?.[0] ?? k, fun = funnel(all, (f) => this.fstatus(f));
    const ran = { analysis: Boolean(this.ai), ...Object.fromEntries(Object.keys(ALL_REVIEWERS).map((k) => [k, runs[k]?.state === "done"])) };
    const sources = this.findingSources(all);
    // The order "Quickest fix" is offered once a finding says how much work its fix is; it reorders every section.
    const efforts = hasEffort(all), order = (list) => (efforts && this.fsort ? quickFirst(list) : list);
    // A row under "No fix sent" starts with a box, as a row of the Comments tab: ticked ones go to one fix agent
    // together ("Fix selected (n)…"). A security finding about access or data keeps its box, switched off.
    // The box stands beside the part of the row that opens the finding, not inside it: its click is its own, on a
    // folded row as on an open one, whatever a press on the row does.
    const picked = new Set(this.pickedFindings()), total = this.selCount();
    const box = (x) => { const alone = secByEffect(x), sel = picked.has(x.id);
      return div().id(`rv-fbox-${x.id}`).tooltip(alone ? "Security findings about access or data are fixed one at a time: use Fix with agent… on the card." : "Select to fix this finding with an agent").accessibility_label("Select finding")
        .w(14).h(14).mt(3).flex_none().rounded(3).border_1().border_color(sel ? t.accent : alone ? t.border : t.input).bg(sel ? t.accent : alone ? t.raised : "#00000000")
        .flex().items_center().justify_center().text_size(TYPE.micro).text_color(t.accent_foreground).child(sel ? "✓" : "")
        .on_click((_e, cx) => { if (!alone) this.pickFinding(x.id, cx); cx.stop_propagation(); }); };
    const row = (x) => {
      const st = this.fstatus(x), on = this.ffocus === x.id, col = t[SEV[x.severity]] ?? t.accent, li = this.layerOf(x), settled = st === "fixed" || st === "dismissed";
      const wide = on || (x.security && x.severity === "high" && !settled); // an unresolved high security finding keeps its whole title
      const others = x.sources.filter((y) => y.title !== x.title || y.detail !== x.detail), owner = on ? ownerOf(x, this.ai?.components) : null;
      // Its way into the PR as five steps in one line; the step that is next says what is missing, a step with
      // details (the fix's agent, branch, commit and report, the check's result) opens them on a click.
      const steps = on ? findingSteps(x, this.find.status[x.id], { report: this.find.reports[x.id], facts: this.fixFacts(x) }) : [];
      const next = steps.find((s) => s.next), shown = steps.find((s) => this.fstep?.id === x.id && s.key === this.fstep.key && s.details.length);
      return v_flex().id(`rv-fc-${x.id}`).flex_none().px(8).py(on ? 8 : 4).gap(6).rounded(7).border_l(3).border_color(on ? t.accent : col).when(on, (e) => e.bg(t.surface)).text_size(TYPE.body)
        // A narrow column wraps the row: the place and the state go under the title instead of squeezing it to nothing.
        .child(h_flex().gap(8).items_start().when(st === "open" || st === "recheck", (e) => e.child(box(x))).child(h_flex().id(`rv-ft-${x.id}`).tooltip("Open this finding and show its line in the diff").flex_1().min_w(0).flex_wrap().gap(8).items_start().cursor_pointer().hover((h) => h.text_color(t.foreground))
          .on_click((_e, cx) => { this.ffocus = on ? null : x.id; if (!on) this.jumpTo(`${x.file}:${x.line}`, cx); cx.notify(); })
          .child(badge(t, x.severity, col))
          // The effort word stands in a row only while the list is sorted by it (it explains the order); else it is
          // one of the open finding's facts ("Fix effort").
          .when(Boolean(x.effort) && Boolean(this.fsort), (e) => e.child(div().id(`rv-fef-${x.id}`).tooltip("How much work the fix is, as the analysis sees it: quick, moderate or heavy").flex_none().pt(1).text_size(TYPE.small).text_color(t.muted).child(x.effort)))
          .when(Boolean(x.security), (e) => e.child(secBadge(t, x).id(`rv-fsec-${x.id}`).tooltip(secWhy(x) || "A security finding")))
          .children([certaintyWord(t, x, `rv-fcert-${x.id}`)].filter(Boolean))
          .child(div().flex_1().min_w(120).font_semibold().text_color(settled ? t.muted : t.foreground).when(!wide, (e) => e.truncate()).when(wide, (e) => e.whitespace_normal()).child(x.title))
          .child(div().flex_none().text_size(TYPE.small).text_color(t.muted).child(`${x.file.split("/").pop()}:${x.line}${this.findRow(x) < 0 ? " · outside the diff" : ""}`))
          .when(Boolean(stateWord(st)), (e) => e.child(div().flex_none().text_size(TYPE.small).font_semibold().text_color(t[FSTATUS[st]?.[1]] ?? t.muted).child(stateWord(st))))))
        .when(on, (e) => e
          .child(div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(`Found by ${this.sourcesOf(x)}${owner ? ` · Owner: ${owner}` : ""}${x.effort ? ` · Fix effort: ${x.effort}` : ""}`))
          // An analysis finding is part of its layer: name it, a click opens it.
          .when(li >= 0, (e) => e.child(div().id(`rv-fly-${x.id}`).tooltip("Open the layer this finding belongs to").truncate().text_size(TYPE.small).text_color(t.accent).cursor_pointer()
            .on_click((_e, cx) => { this.goStep(li, cx); cx.notify(); }).child(`${x.category} · layer: ${plain(this.steps()[li]?.title)} →`)))
          // What it claims, how sure that is and what it needs, as on its card in the diff (views.js factRows).
          .when(factRows(x).length > 0, (e) => e.child(v_flex().gap(3).children(factRows(x).map(([label, text]) => h_flex().gap(8).items_start().text_size(TYPE.small).line_height(1.5)
            .child(div().w(96).flex_none().text_color(t.muted).child(label)).child(div().flex_1().min_w(0).whitespace_normal().child(plain(text)))))))
          .child(div().line_height(1.5).child(TextView.markdown(`rv-fd-${x.id}`, x.detail + (x.suggestion ? `\n\n**Suggested:** ${x.suggestion}` : ""))))
          // What the other sources say about the same line, in their own words and with their own severity.
          .children(others.map((y, k) => div().id(`rv-fsrc-${x.id}-${k}`).text_size(TYPE.small).text_color(t.muted).line_height(1.5).whitespace_normal().child(`${name(y.reviewer)} (${y.severity}): ${plain(y.title)}${y.detail ? `. ${plain(y.detail)}` : ""}`)))
          .child(v_flex().gap(4)
            .child(h_flex().flex_wrap().gap(4).items_center().text_size(TYPE.small).children(steps.flatMap((s, k) => [k > 0 && div().flex_none().text_color(t.dim).child("→"),
              div().id(`rv-fstep-${x.id}-${s.key}`).tooltip(`${s.done ? `${s.label}: reached.` : s.missing}${s.details.length ? " Click for the details." : ""}`)
                .flex_none().px(7).h(20).flex().items_center().gap(4).rounded(10).border_1().border_color(s.done ? t.ansi2 : s.next ? t.ansi3 : t.border).text_color(s.done || s.next ? t.foreground : t.muted)
                .when(s.done, (e) => e.bg(t.ansi2 + "1f")).when(shown === s, (e) => e.border_color(t.accent))
                .when(s.details.length > 0, (e) => e.cursor_pointer().hover((h) => h.bg(t.hover)).on_click((_e, cx) => { this.fstep = shown === s ? null : { id: x.id, key: s.key }; cx.stop_propagation(); cx.notify(); }))
                .child(s.done ? `✓ ${s.label}` : s.label).when(s.details.length > 0, (e) => e.child(div().text_color(t.muted).child(shown === s ? "▾" : "▸")))].filter(Boolean))))
            .when(Boolean(next), (e) => e.child(div().id(`rv-fnext-${x.id}`).text_size(TYPE.small).line_height(1.5).text_color(t.muted).whitespace_normal().child(next.missing)))
            .when(Boolean(shown), (e) => e.child(v_flex().p(8).gap(3).rounded(6).border_1().border_color(t.border)
              .children(shown.details.map(([label, text]) => h_flex().gap(8).items_start().text_size(TYPE.small).line_height(1.5)
                .child(div().w(52).flex_none().text_color(t.muted).child(label)).child(div().flex_1().min_w(0).whitespace_normal().child(text)))))))
          .child(h_flex().flex_wrap().gap(6).items_center().children(this.findingActions(x, settled, t))));
    };
    const section = (title, list, right = null, hint = null) => v_flex().flex_none().gap(2)
      .child(h_flex().pt(10).pb(2).px(6).gap(8).items_center().child(div().flex_1().text_size(TYPE.small).font_semibold().text_color(t.muted).child(`${title} · ${list.length}`)).children([right].filter(Boolean)))
      .when(Boolean(hint), (e) => e.child(div().px(6).pb(2).text_size(TYPE.small).line_height(1.5).text_color(t.muted).whitespace_normal().child(hint)))
      .children(order(list).map(row));
    const verify = div().id("rv-verify").tooltip("One model call checks the fixes sent: a reported commit on its fix branch, or the PR head once it moved").px(9).h(26).flex().items_center().gap(6).rounded(6).border_1().text_size(TYPE.small)
      .border_color(toVerify.length && !this.verifyBusy ? t.foreground : t.border).text_color(toVerify.length && !this.verifyBusy ? t.foreground : t.muted)
      .when(toVerify.length > 0 && !this.verifyBusy, (e) => e.cursor_pointer().hover((h) => h.bg(t.hover)).on_click((_e, cx) => this.runVerify(cx)))
      .child(this.verifyBusy ? `Verifying ${this.verifyBusy.n}…` : `Verify fixes (${toVerify.length})`);
    const sentHint = !sent.length ? "No fix is out. A finding sent to Fix stays unresolved and shows here until it is verified."
      : `A fix sent does not resolve a finding. Verify is one ${modelLabel(m)} call: it checks a reported commit on its fix branch, and the PR head once the fix is pushed. Only a passed check on the PR head moves a finding to Fixed.${toVerify.length ? "" : " Nothing to verify yet."}`;
    return v_flex().flex_1().min_h(0)
      .child(v_flex().flex_none().px(14).py(10).gap(8).border_b(1).border_color(t.border)
        // How this number comes about: in short under it, as a sentence with every source in its help text.
        .child(h_flex().gap(8).items_start().child(div().id("rv-fcount").flex_1().min_w(0).whitespace_normal().tooltip(`${funnelLine(fun, name)} A finding with a fix sent stays unresolved until it is verified.`).text_size(TYPE.body).font_semibold().child(countLine(c)))
          .when(Boolean(this.prSel), (e) => e.child(this.mdButton(t, "rv-md-f"))))
        .when(Boolean(funnelShort(fun)), (e) => e.child(div().id("rv-ffunnel").tooltip(funnelLine(fun, name)).mt(-6).truncate().text_size(TYPE.small).text_color(t.muted).child(funnelShort(fun))))
        // The sources are counts, not switches: a line of text (framed chips read as a second filter beside the bar's
        // "In the diff:"). What the tab can change is the order, and that looks like the Layers / By focus switch.
        .child(h_flex().flex_wrap().gap(6).items_center().text_size(TYPE.small).line_height(1.5).child(div().flex_none().text_color(t.muted).child("By source:"))
          .children(sources.flatMap((x, k) => [k > 0 && div().flex_none().text_color(t.dim).child("·"), div().id(`rv-fsrcn-${x.k}`).tooltip(x.n ? `Findings ${name(x.k)} is a source of` : runs[x.k]?.state === "failed" ? `${name(x.k)} failed: ${runs[x.k].error ?? "no result"}` : ran[x.k] ? `${name(x.k)} ran and found nothing` : `${name(x.k)} has not run on this PR`)
            .flex_none().text_color(x.n ? t.foreground : t.muted).child(x.text)].filter(Boolean))))
        .when(efforts, (e) => e.child(h_flex().gap(8).items_center().text_size(TYPE.small).child(div().flex_none().text_color(t.muted).child("Sort by"))
          .child(h_flex().id("rv-fsort").gap(2).p(2).rounded(7).border_1().border_color(t.border).children([[false, "Severity", "The usual order: by severity, then by file and line"], [true, "Quickest fix", "The findings with the quickest fixes first; each row then says quick, moderate or heavy, as the analysis sees the fix"]].map(([k, label, tip]) =>
            div().id(`rv-fsort-${k ? "quick" : "sev"}`).tooltip(tip).px(8).h(28).flex().items_center().rounded(5).cursor_pointer().bg(Boolean(this.fsort) === k ? t.selected : t.chrome)
              .text_color(Boolean(this.fsort) === k ? t.foreground : t.muted).on_click((_e, cx) => { this.fsort = k; cx.notify(); }).child(label))))))
        .when(Object.values(runs).some((r) => r.busy), (e) => e.child(div().text_size(TYPE.small).text_color(t.muted).child("A reviewer is running…"))))
      .when(!all.length, (e) => e.child(h_flex().flex_none().flex_wrap().px(14).py(8).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(TYPE.small).text_color(t.muted).child("Run a reviewer:"))
        .children(reviewersNow().map(([k, [label]]) => pill(`rv-frun-${k}`, t, runs[k]?.busy ? `${label} running…` : label, (_e, cx) => this.runReviewer(k, cx), false, t.foreground).tooltip("Run this reviewer read-only on the PR head; its findings show here")))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("rv-find-left").absolute().inset_0().overflow_y_scroll().px(8).pb(12).gap(2)
          // The two kinds of unresolved findings add up to the number in the tab and in the line above.
          .child(section("FIX SENT", sent, verify, sentHint))
          .child(section("NO FIX SENT", unresolved, total > 0
            ? pill("rv-fixall", t, `Fix selected (${total})…`, (_e, cx) => this.fixSelected(cx), true).tooltip(total > picked.size ? `Hand everything selected to one agent together: ${picked.size} ${picked.size === 1 ? "finding" : "findings"} ticked here and ${total - picked.size} ${total - picked.size === 1 ? "comment" : "comments"}. A preview first.` : "Hand the ticked findings to one agent together; a preview first, where you can still change the ticks.")
            : unresolved.filter((x) => !secByEffect(x)).length > 1 && pill("rv-fixall", t, "Fix several…", (_e, cx) => this.fixSeveral(cx)).tooltip("Pick which of these findings one agent fixes together; a preview first. Security findings are fixed one at a time.")))
          .when(c.fixed > 0, (e) => e.child(section("FIXED", by("fixed"))))
          .when(c.dismissed > 0, (e) => e.child(section("DISMISSED", by("dismissed"))))
          // Suggestions alone on their lines: notes, not findings, not counted above.
          .when(notes.length > 0, (e) => e.child(v_flex().flex_none().gap(2)
            .child(div().pt(10).pb(2).px(6).text_size(TYPE.small).font_semibold().text_color(t.muted).child(`AI NOTES · ${notes.length} · not counted as findings`))
            .children(notes.map((s) => h_flex().id(`rv-fnote-${s.key}`).tooltip("Show this note's line in the diff").flex_none().px(8).h(26).gap(8).items_center().rounded(6).cursor_pointer().hover((h) => h.bg(t.hover)).text_size(TYPE.small).text_color(t.muted)
              .on_click((_e, cx) => { this.sug = s.key; this.jumpTo(`${s.path}:${s.line}`, cx); cx.notify(); })
              .child(div().flex_none().child(s.severity)).child(div().flex_1().min_w(0).truncate().child(plain(s.reason))).child(div().flex_none().child(`${s.path.split("/").pop()}:${s.line}`)))))))
        .child(Scrollbar.vertical("rv-find-left").absolute().inset_0()));
  },

  filesPane(t) {
    const files = this.shown().patch, byPath = new Map(files.map((f) => [f.path, f]));
    const seen = files.filter((f) => this.prog.seen.has(f.path)).length, open = this.openFindings(); // the flags add up to the Findings tab's number
    const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0);
    return v_flex().flex_1().min_h(0)
      .child(h_flex().flex_none().px(14).h(38).gap(10).items_center().border_b(1).border_color(t.border).text_size(TYPE.small)
        .child(div().id("rv-fp-seen").tooltip("Files you ticked as viewed").flex_1().text_color(t.muted).child(`${seen} of ${files.length} files viewed`))
        .child(div().id("rv-fp-add").tooltip("Lines added in the whole PR").text_color(t.ansi2).child(`+${add}`)).child(div().id("rv-fp-del").tooltip("Lines removed in the whole PR").text_color(t.ansi1).child(`−${del}`)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("rv-tree").absolute().inset_0().overflow_y_scroll().p(6)
          .children(fileTree(files.map((f) => f.path), this.closedDirs).map((n) => {
            // A file's unresolved findings in words, in the colour of the highest severity; security with its own mark.
            const f = byPath.get(n.path), cm = f ? this.comments.filter((c) => c.file === f.path).length : 0, w = f ? worst(open.filter((x) => x.file === f.path)) : null;
            return h_flex().id(`rv-t-${n.dir ? "d" : "f"}-${n.path}`).tooltip((n.dir ? "Fold or unfold this folder" : "Show this file's diff")).h(28).flex_none().pl(8 + 14 * n.depth).pr(n.dir ? 8 : 0).gap(8).items_center().rounded(6).text_size(TYPE.body).cursor_pointer()
              .when(!n.dir && this.fileFocus === n.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => {
                if (n.dir) { if (this.closedDirs.has(n.path)) this.closedDirs.delete(n.path); else this.closedDirs.add(n.path); }
                else { this.tab = "files"; this.fileFocus = n.path; this.unfold(n.path); this.scrollTo("files", n.path); }
                cx.notify();
              })
              .child(div().w(12).flex_none().text_color(t.muted).child(n.dir ? (this.closedDirs.has(n.path) ? "▸" : "▾") : ""))
              .when(!n.dir, (e) => e.child(div().id(`rv-tst-${n.path}`).tooltip(`File ${f.status}`).w(14).flex_none().text_size(TYPE.small).font_semibold().text_color(t[STATUS[f.status][1]]).child(STATUS[f.status][0])))
              .child(div().flex_1().min_w(0).truncate().text_color(n.dir ? t.muted : this.prog.seen.has(n.path) ? t.muted : t.foreground).child(n.dir ? `${n.name}/` : n.name))
              .when(Boolean(w?.security), (e) => e.child(div().id(`rv-tsec-${n.path}`).tooltip(`${w.security} of them ${w.security === 1 ? "is a security finding" : "are security findings"}${w.signWords ? `: ${w.signWords}` : ""}`).flex_none().child(signEl(div, t, w.sign, "⛨"))))
              .when(Boolean(w), (e) => e.child(div().id(`rv-tsg-${n.path}`).tooltip(`${w.total} unresolved ${w.total === 1 ? "finding" : "findings"} in this file: ${w.words}`).flex_none().text_size(TYPE.small).font_semibold().text_color(t[SEV[w.severity]] ?? t.ansi1).child(w.label)))
              .when(cm > 0, (e) => e.child(div().id(`rv-tcm-${n.path}`).tooltip(`${cm} pending ${cm === 1 ? "comment" : "comments"} of yours in this file`).flex_none().text_size(TYPE.small).text_color(t.accent).child(`${cm} ${cm === 1 ? "comment" : "comments"}`)))
              .when(!n.dir && f.add > 0, (e) => e.child(div().id(`rv-tad-${n.path}`).tooltip(`${f.add} lines added`).text_size(TYPE.small).text_color(t.ansi2).child(`+${f.add}`)))
              .when(!n.dir && f.del > 0, (e) => e.child(div().id(`rv-tdl-${n.path}`).tooltip(`${f.del} lines removed`).text_size(TYPE.small).text_color(t.ansi1).child(`−${f.del}`)))
              // The tick: a 16 px box, and the whole right end of the row takes the click.
              .when(!n.dir, (e) => e.child(div().id(`rv-seen-${n.path}`).tooltip("Mark this file as viewed; it collapses in the diff").accessibility_label("Viewed").w(36).h(28).flex_none().flex().items_center().justify_center()
                .on_click((_e, cx) => { this.toggleSeen(n.path, cx); cx.stop_propagation(); cx.notify(); }).child(viewedBox(t, this.prog.seen.has(n.path)))));
          })))
        .child(Scrollbar.vertical("rv-tree").absolute().inset_0()));
  },

  // ---- render: the diff list (inside the virtual list: no handlers, onItem places clicks by x)

  // Lines a wrapped text takes in a card of the diff column (views.js wrapCount); less: what a label column takes.
  lines(text, less = 0, max = Infinity) { return wrapCount(text, Math.min(max, (this.listW ?? 900) - GUTTER - 45 - less)); },
  // The height of a Markdown text in such a card (views.js mdHeight).
  md(text, less = 0, max = Infinity) { return mdHeight(text, Math.min(max, (this.listW ?? 900) - GUTTER - 45 - less)); },
  // A GitHub comment's body in blocks (views.js ghMd, mdBlocks): Markdown for TextView, fenced code drawn here. Its
  // <details> fold unless opened (a click on the card); memoized per comment, open state and body.
  ghBlocks(g) {
    const open = Boolean(this.ghOpen?.has(g.id)), memo = (this.ghMemo ??= new Map()), m = memo.get(g.id);
    if (m && m.body === g.body && m.open === open) return m.blocks;
    const blocks = mdBlocks(ghMd(g.body, open));
    keepLast(memo.set(g.id, { body: g.body, open, blocks }), 500);
    return blocks;
  },
  // A fenced block in a card: mono at the card's size, its long lines wrapped at the card's width (views.js wrapCode),
  // so its height is exact; a GitHub suggestion says so above its lines.
  codeRows(b) {
    const w = (this.listW ?? 900) - GUTTER - 45 - 2 * CODE_PAD_X, cols = Math.max(8, Math.floor(w / (this.codeCharW() * (CODE_SIZE / 13))));
    return (b.code.length ? b.code : [""]).flatMap((l) => { const at = wrapCode(l, cols); return at.map((a, k) => l.slice(a, at[k + 1])); });
  },
  codeH(b) { return 2 * CODE_PAD_Y + this.codeRows(b).length * CODE_LH + (b.lang === "suggestion" ? CODE_LH : 0); },
  codeView(b, t) {
    const sug = b.lang === "suggestion";
    return v_flex().w_full().h(this.codeH(b)).flex_none().px(CODE_PAD_X).py(CODE_PAD_Y).rounded(6).bg(t.surface).border_1().border_color(t.border)
      .when(sug, (e) => e.child(div().h(CODE_LH).flex_none().text_size(TYPE.small).text_color(t.muted).child("Suggested change")))
      .children(this.codeRows(b).map((l) => div().h(CODE_LH).flex_none().font_family(settings().font_family ?? "JetBrains Mono").text_size(CODE_SIZE).whitespace_nowrap().overflow_hidden().text_color(sug ? t.ansi2 : t.foreground).child(l || " ")));
  },

  sizeOf(it) {
    if (it.t === "row") return it.src[it.ri].kind === "@" ? 30 : ROW;
    if (it.t === "step") { const w = Math.min(LAYER_TEXT, (this.listW ?? 900) - 32), qs = it.s.questions; return 48 + mdHeight(it.s.why, w) + (qs.length ? 26 + qs.reduce((n, q, k) => n + 4 + mdHeight(this.asked(it.s, q, k), w - 20), 0) : 0); }
    if (it.t === "vis") return visualPlan(it.v, (this.listW ?? 900) - 32, Boolean(it.bare)).h + 8;
    if (it.t === "visfold") return 46;
    if (it.t === "vtr") return 26;
    if (it.t === "sug") return this.sug === it.s.key ? 56 + this.md(it.s.reason, 0, FIND_TEXT) : 26;
    if (it.t === "pad") return 60;
    if (it.t === "fold") return it.h;
    if (it.t === "hidden") return 24;
    if (it.t === "ch") return this.cardOf(it).folded ? 28 + 2 * CARD_GAP : CARD_HEAD;
    if (it.t === "cb") { const c = this.cardOf(it), w = Math.min(FIND_TEXT, this.cardW(c) - 26); return 12 + mdHeight(c.text, w, 20) + c.replies.reduce((n, r) => n + 26 + mdHeight(r.text, w - 44, 19, TYPE.small), 0) + (it.k === "th" ? 0 : CARD_GAP); }
    if (it.t === "cr") return CARD_REPLY + CARD_GAP;
    if (it.t === "gh") return 50 + this.ghBlocks(it.g).reduce((n, b, k) => n + (k ? GH_GAP : 0) + (b.code ? this.codeH(b) : this.md(b.text, 0, FIND_TEXT)), 0);
    if (it.t === "compose") return COMPOSE;
    if (it.t === "composeact") return ACT + 4;
    if (it.t === "cact" || it.t === "fact") return ACT;
    if (it.t === "def") return 190;
    if (it.t === "find") return this.findOpen(it.f) ? 60 + (this.fixLine(it.f) ? 21 : 0) + 21 * this.lines(it.f.title, 0, FIND_TEXT) + this.findRows(it.f).reduce((n, [, v]) => n + 4 + this.md(v, FIND_LABEL, FIND_TEXT), 0) : FIND_FOLDED;
    return { path: 30, file: 44, gap: 30, note: 30, more: 26 }[it.t];
  },

  item(it, t) {
    // Side by side, a card over the whole width says in the gutter which half's line it hangs under.
    if (it.side && SIDE_HEAD.has(it.t)) return div().w_full().relative().child(this.item({ ...it, side: null }, t))
      .child(div().absolute().top(0).left(0).w(GUTTER - 10).h(ROW).flex().items_center().justify_end().text_size(TYPE.small).text_color(it.side === "l" ? t.ansi1 : t.ansi2)
        .child(it.side === "l" ? "− old side" : "+ new side"));
    const mono = (e) => e.font_family(settings().font_family ?? "JetBrains Mono");
    if (it.t === "row") {
      const r = it.src[it.ri];
      if (r.kind === "@") {
        const m = /^(@@[^@]*@@)\s?(.*)$/.exec(r.text) ?? [null, r.text, ""];
        return mono(h_flex()).h(30).w_full().pl(GUTTER - 4).pr(12).gap(10).items_center().bg(t.accent + "14").border_t(1).border_b(1).border_color(t.border).text_size(TYPE.small)
          .child(div().flex_none().text_color(t.muted).child(m[1])).child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(m[2]));
      }
      // Side by side: two halves of equal width and height; an empty one (a line only on the other side) is grey.
      if (it.l !== undefined) return h_flex().h(ROW).w_full()
        .child(it.l === null ? div().flex_1().min_w(0).h_full().bg(t.muted + "14") : this.lineView(it, t, it.l, "l").flex_1().min_w(0))
        .child(it.r === null ? div().flex_1().min_w(0).h_full().bg(t.muted + "14").border_l(1).border_color(t.border) : this.lineView(it, t, it.r, "r").flex_1().min_w(0).border_l(1).border_color(t.border));
      return this.lineView(it, t, it.ri, null).w_full();
    }
    if (it.t === "gap") {
      const h = it.r.hidden, seg = (label) => div().w(GAP_SEG).flex_none().child(label);
      return h_flex().h(30).w_full().items_center().bg(t.surface).border_t(1).border_b(1).border_color(t.border).text_size(TYPE.small).text_color(t.accent).cursor_pointer()
        .child(div().w(GUTTER).flex_none().text_center().text_color(t.muted).child("⋯"))
        .child(seg(`↓ ${MORE} lines`).id(`rv-gap-${it.path}-${it.r.gap}-d`).tooltip(`Show ${MORE} more lines below the hunk above`)).child(seg(`↑ ${MORE} lines`).id(`rv-gap-${it.path}-${it.r.gap}-u`).tooltip(`Show ${MORE} more lines above the next hunk`))
        .child(div().id(`rv-gap-${it.path}-${it.r.gap}-a`).tooltip("Show every hidden line of this gap").flex_1().child(h === null ? "Load rest of file" : `Show all ${h} lines`));
    }
    // An AI suggestion alone on its line: a one-line margin note without buttons, not a finding and not counted. A
    // click opens its whole text (this.sug); a and x still take it as a comment or hide it.
    if (it.t === "sug") {
      const s = it.s, open = this.sug === s.key;
      return div().w_full().h(this.sizeOf(it)).pl(GUTTER).pr(16).py(2).cursor_pointer().child(v_flex().size_full().px(12).justify_center().gap(4).border_l(2).border_color(t[SEV[s.severity]] ?? t.border).text_size(TYPE.small)
        .child(h_flex().h(20).flex_none().gap(8).items_center().text_color(t.muted)
          .child(div().flex_none().child(`${open ? "▾" : "▸"} AI note · ${s.severity}${s.approx ? " · near this line" : ""}`))
          .when(!open, (e) => e.child(div().flex_1().min_w(0).truncate().child(plain(s.reason)))))
        .when(open, (e) => e.child(div().flex_1().min_h(0).max_w(FIND_TEXT).text_size(TYPE.body).line_height(1.55).text_color(t.foreground).child(TextView.markdown(`rv-sgm-${s.key}`, s.reason)))
          .child(div().h(20).flex_none().text_size(TYPE.small).text_color(t.muted).child("A note, not a finding. Press a to add it as a comment, x to hide it."))));
    }
    if (it.t === "find" || it.t === "fact") {
      const f = it.f, c = t[SEV[f.severity]] ?? t.accent, st = this.fstatus(f), line = this.fixLine(f);
      const card = (e) => e.border_l(4).border_r(1).border_color(c).bg(c + "12");
      if (it.t === "fact") {
        const live = Boolean(this.fixOf(f.id)?.terminal);
        return div().w_full().h(ACT).pl(GUTTER).pr(16).pb(6).child(card(h_flex()).size_full().px(12).gap(BTN_GAP).items_center().border_b(1)
          .child(button(t, "Add to review", live ? t.border : c, t.foreground).id(`rv-fa-c-${f.id}`).tooltip("Add this finding to your pending review comments; nothing is posted until you finish the review"))
          .child(button(t, "Ask an agent…", t.border, t.foreground).id(`rv-fa-d-${f.id}`).tooltip("Ask an agent about this finding: a preview first says what starts and what it may do"))
          .child(button(t, live ? "Go to fix" : "Fix with agent…", live ? c : t.border, t.foreground).id(`rv-fa-f-${f.id}`).tooltip(live ? "Show the fix agent's terminal" : "Have an agent fix this: a preview first says where it works, what it may do and that it never pushes"))
          .child(button(t, "Dismiss finding", t.border, t.muted).id(`rv-fa-x-${f.id}`).tooltip(`Dismiss this finding${f.sources.length > 1 ? ` with all ${f.sources.length} of its sources` : ""}; it stays in the Findings tab under Dismissed`)));
      }
      // One line folded (severity, title, sources, state); open: the head, the fix line, the title and findRows.
      const open = this.findOpen(f), state = stateWord(st) ? div().id(`rv-lfst-${f.id}`).tooltip("Where this finding stands: fix sent, fixed (verified), dismissed, or unresolved with its line changed since").flex_none().text_size(TYPE.small).font_semibold().text_color(t[FSTATUS[st]?.[1]] ?? t.muted).child(stateWord(st)) : null;
      const head = (e) => e.child(div().w(10).flex_none().text_size(TYPE.small).text_color(t.muted).child(open ? "▾" : "▸"))
        .child(badge(t, f.severity, c).id(`rv-lfs-${f.id}`).tooltip(`${f.severity} is the highest severity among this finding's sources. The scale:\n${SEVERITY_SCALE}`))
        .when(Boolean(f.security), (x) => x.child(secBadge(t, f).id(`rv-lfsec-${f.id}`).tooltip(secWhy(f) || "A security finding")));
      const sources = div().id(`rv-lfr-${f.id}`).tooltip("Where this finding comes from, each source with its own severity").min_w(0).truncate().text_size(TYPE.small).font_semibold().text_color(t.muted).child(this.sourcesOf(f));
      // An unresolved finding has its box beside the card, folded or open: the same selection as its row in the
      // Findings tab and as the comments (sideBox; a security finding about access or data: there, switched off).
      const alone = secByEffect(f), box = (top) => (st === "open" || st === "recheck" ? [sideBox(t, `rv-lfbox-${f.id}`, top, { sel: this.pickedFindings().includes(f.id), off: alone, lit: this.selCount() > 0,
        tip: alone ? "Security findings about access or data are fixed one at a time: use Fix with agent… on the card." : "Select to fix this finding with an agent" })] : []);
      if (!open) return div().id(`rv-lf-${f.id}`).tooltip("Open this finding: what it claims, its text, its suggestion and its actions").relative().w_full().h(FIND_FOLDED).pl(GUTTER).pr(16).pt(6).pb(2).cursor_pointer()
        .children(box(12)).child(head(card(h_flex())).size_full().px(12).gap(8).items_center().border_t(1).border_b(1).text_size(TYPE.body)
          .children([certaintyWord(t, f, `rv-lfc-${f.id}`)].filter(Boolean)).child(div().flex_1().min_w(0).truncate().child(f.title)).child(div().flex_none().max_w(300).child(sources)).children([state].filter(Boolean)));
      return div().relative().w_full().h(this.sizeOf(it)).pl(GUTTER).pr(16).pt(6).cursor_pointer().children(box(22)).child(card(v_flex()).size_full().px(12).pt(8).gap(4).border_t(1).text_size(TYPE.body).overflow_hidden()
        // The head is 30 px high so "Open in Findings" is a drawn button of 28 px (a visible target of 25 pt at 90 % zoom).
        .child(head(h_flex().h(30).flex_none().gap(8).items_center()).child(sources).children([state].filter(Boolean)).child(div().flex_1())
          .child(div().id(`rv-lfo-${f.id}`).tooltip("Open this finding in the Findings tab").w(FIND_LINK - 12).h(28).flex_none().flex().items_center().justify_center().rounded(6).border_1().border_color(t.border).bg(t.background).text_size(TYPE.small).text_color(t.accent).child("Open in Findings ↗")))
        .when(Boolean(line), (e) => e.child(div().h(17).flex_none().truncate().text_size(TYPE.small).text_color(t.muted).child(line)))
        .child(div().flex_none().max_w(FIND_TEXT).line_height(1.55).whitespace_normal().font_semibold().child(f.title))
        .children(this.findRows(f).map(([label, text]) => h_flex().flex_none().items_start().line_height(1.55)
          .child(div().w(FIND_LABEL).flex_none().text_size(TYPE.small).text_color(t.muted).child(label)).child(div().flex_1().min_w(0).max_w(FIND_TEXT).child(TextView.markdown(`rv-lfm-${f.id}-${label}`, text))))));
    }
    if (it.t === "ch" || it.t === "cb" || it.t === "cr") return this.cardRow(it, t);
    if (it.t === "pad") return div().w_full().h(60);
    if (it.t === "hidden") return div().w_full().h(24).pl(GUTTER + 4).flex().items_center().text_size(TYPE.small).italic().text_color(t.muted).child(it.text);
    if (it.t === "gh") {
      const g = it.g, sel = this.selected().includes(`gh${g.id}`);
      // Its box, to send it to a fix with the rest of the selection (sideBox).
      return div().relative().w_full().h(this.sizeOf(it)).pl(GUTTER).pr(16).pt(6)
        .child(sideBox(t, `rv-ghbox-${g.id}`, 16, { sel, lit: this.selCount() > 0, tip: "Select to fix this comment with an agent" }))
        .child(v_flex().size_full().px(12).pt(8).gap(6).border_l(4).border_r(1).border_t(1).border_b(1)
        .border_color(t.border).bg(t.raised).rounded(4).text_size(TYPE.body)
        .child(h_flex().h(18).gap(8).items_center().text_size(TYPE.small)
          .child(div().font_semibold().text_color(t.foreground).child(g.user ?? "?")).child(div().text_color(t.muted).child(`on GitHub · ${g.at ? ago(g.at) : ""}`))
          // Its line is gone: say which one it was on (GitHub's original line).
          .when(Boolean(it.loose), (e) => e.child(div().text_color(t.muted).child(g.line ?? g.original_line ? `· line ${g.line ?? g.original_line}, not shown` : "· on the file")))
          .when(Boolean(g.outdated), (e) => e.child(badge(t, "Outdated", t.muted).id(`rv-gho-${g.id}`).tooltip("GitHub marks this comment outdated: the code it was on changed since")))
          .when(Boolean(g.resolved), (e) => e.child(badge(t, "Resolved", t.ansi2).id(`rv-ghr-${g.id}`).tooltip("This thread is resolved on GitHub"))))
        .child(v_flex().flex_1().min_h(0).gap(GH_GAP).line_height(1.55).text_color(t.foreground).children(this.ghBlocks(g).map((b, k) => (b.code ? this.codeView(b, t)
          : div().w_full().max_w(FIND_TEXT).flex_none().child(TextView.markdown(`rv-ghm-${g.id}-${this.ghOpen?.has(g.id) ? 1 : 0}-${k}`, b.text)))))));
    }
    if (it.t === "compose") {
      const c = this.editing, a = c ?? this.selAnchor(), out = Boolean(a) && this.routeNow() === "github" && !inDiff(this.diffLines ?? new Map(), { file: this.fsel?.path, ...a });
      return div().w_full().h(COMPOSE).pl(GUTTER).pr(16).pt(6).child(v_flex().size_full().px(12).pt(8).pb(4).gap(6).border_l(4).border_r(1).border_t(1)
        .border_color(t.muted).bg(t.surface).rounded_tl(4).rounded_tr(4)
        .child(h_flex().h(18).gap(8).items_center().text_size(TYPE.small)
          .child(div().font_semibold().text_color(t.foreground).child(c ? `Edit comment · ${uiLine(c)}` : a ? `Comment on ${uiLine(a)}` : "Comment"))
          .when(out, (e) => e.child(badge(t, "not in the diff: will go into the review body", t.ansi3).id("rv-compose-out").tooltip("GitHub cannot attach a line comment outside the diff, so it goes into the review body")))
          .child(div().flex_1().min_w(0).truncate().text_right().text_color(t.muted).child(`⌘↩: ${this.composeButtons().find((b) => b.primary).label} · Esc: Cancel`)))
        .child(div().flex_1().min_h(0).px(10).py(6).rounded(6).border_1().border_color(this.typing === "draft" ? t.accent : t.border).bg(t.background).cursor_text()
          .child(Textarea.new(this.draft).size_full().text_size(TYPE.body).text_color(t.foreground))));
    }
    if (it.t === "composeact") {
      const bs = this.composeButtons();
      return div().w_full().h(ACT + 4).pl(GUTTER).pr(16).pb(6).child(h_flex().size_full().px(12).items_center().border_l(4).border_r(1).border_b(1)
        .border_color(t.muted).bg(t.surface).rounded_bl(4).rounded_br(4)
        .children(bs.map((b, i) => div().id(`rv-cb-${b.act}`).tooltip(COMPOSE_TIP[b.act] ?? (this.composeMore ? "Hide Post now to GitHub" : "Another way to send this comment: post it to GitHub at once, outside the review")).w(b.w).h(28).flex_none().ml(i === 0 ? 0 : b.x - bs[i - 1].x - bs[i - 1].w)
          .flex().items_center().justify_center().rounded(6).border_1().border_color(b.primary ? t.solid : t.border).bg(b.primary ? t.solid : t.background)
          .text_size(TYPE.small).text_color(b.primary ? t.solid_foreground : t.foreground).when(Boolean(b.primary), (e) => e.font_semibold())
          .child(this.sending && b.act !== "closeComposer" && b.act !== "insertSuggestion" ? "…" : b.label))));
    }
    if (it.t === "file") {
      const f = it.f, closed = this.collapsed.has(f.path) || Boolean(this.overBudget?.has(f.path)), seen = this.prog.seen.has(f.path), [letter, col] = STATUS[f.status];
      const n = this.comments.filter((c) => c.file === f.path).length, whole = this.whole.has(f.path);
      return h_flex().h(44).w_full().items_center().bg(this.fileFocus === f.path ? t.selected : t.raised).border_t(1).border_b(1).border_color(t.border).text_size(TYPE.body).cursor_pointer()
        .child(div().id(`rv-fh-chev-${f.path}`).tooltip(closed ? "Expand this file" : "Collapse this file").accessibility_label(closed ? "Expand file" : "Collapse file").w(FILE_CHEV).flex_none().text_center().text_color(t.muted).child(closed ? "▸" : "▾"))
        .child(div().id(`rv-fh-seen-${f.path}`).tooltip("Mark this file as viewed; it collapses and counts in your progress").accessibility_label("Viewed").w(FILE_SEEN).flex_none().flex().items_center().text_size(TYPE.small).text_color(seen ? t.ansi2 : t.muted).child(fileAct(t).child(viewedBox(t, seen)).child("Viewed")))
        .child(div().id(`rv-fh-whole-${f.path}`).when(this.shown().fileHunks?.has(f.path), (e) => e.tooltip("Show the whole file instead of only the changed hunks")).w(FILE_WHOLE).flex_none().flex().items_center().text_size(TYPE.small).text_color(whole ? t.foreground : t.muted).children(this.shown().fileHunks?.has(f.path) ? [fileAct(t).child(tickBox(t, whole)).child("Whole file")] : []))

        // "IntelliJ ↗" and its ▾ as zones of fixed width (onItem finds them by x); "Opening IntelliJ …" for three seconds after a click.
        .children(((m) => (m ? [div().id(`rv-fh-ed-${f.path}`).tooltip(m.tip).accessibility_label(`Open in ${editorFull(m.id)}`).w(FILE_EDIT).flex_none().truncate().text_size(TYPE.small).text_color(m.busy ? t.dim : t.muted).child(m.text),
          div().id(`rv-fh-edm-${f.path}`).tooltip(editorMenuTip).accessibility_label("Other editors").w(FILE_EDIT_MORE).flex_none().text_size(TYPE.small).text_color(t.muted).child("▾")] : []))(this.fileEditMark(f)))
        .child(div().id(`rv-fh-st-${f.path}`).tooltip(`File ${f.status} (${letter} in the file tree)`).w(70).flex_none().text_size(TYPE.small).font_semibold().text_color(t[col]).child(`${String(f.status ?? "")[0]?.toUpperCase() ?? ""}${String(f.status ?? "").slice(1)}`))
        // The name drags as the file's path in the checkout (main.js fileDragPath); a click on it still folds the file.
        .child(((drag) => mono(div()).flex_1().min_w(0).truncate().font_semibold().text_size(TYPE.body)
          .when(Boolean(drag), (e) => e.id(`rv-fh-path-${f.path}`).tooltip("Drag this onto a terminal to paste the file's path.").drag_paths([drag]))
          .child(f.status === "renamed" ? `${f.from} → ${f.path}` : f.path))(this.fileDragPath(f)))
        .when(n > 0, (e) => e.child(div().id(`rv-fh-cm-${f.path}`).tooltip(`${n} pending comments in this file`).px(8).text_size(TYPE.small).text_color(t.accent).child(`● ${n}`)))
        .child(div().id(`rv-fh-ad-${f.path}`).tooltip(`${f.add} lines added`).px(4).text_size(TYPE.small).text_color(t.ansi2).child(`+${f.add}`)).child(div().id(`rv-fh-dl-${f.path}`).tooltip(`${f.del} lines removed`).pl(2).pr(16).text_size(TYPE.small).text_color(t.ansi1).child(`−${f.del}`));
    }
    // A layer's head over its code: title, why, and the check questions, once and whole, each with the file the
    // analysis names for it. Its pictures follow as rows of their own, as wide as the column.
    if (it.t === "step") {
      const s = it.s, on = it.i === this.cur;
      return v_flex().w_full().h(this.sizeOf(it)).px(16).pt(10).gap(4).bg(on ? t.selected : t.raised).border_t(1).border_color(t.border).cursor_pointer()
        .child(h_flex().h(24).flex_none().gap(10).items_center()
          .child(div().id(`rv-lstep-${it.i}`).tooltip(this.done(s) ? "This layer is checked off" : "Layer number").text_size(TYPE.title).font_semibold().text_color(this.done(s) ? t.ansi2 : t.muted).child(this.done(s) ? "✓" : `${it.i + 1}`))
          .child(div().flex_1().min_w(0).truncate().text_size(TYPE.title).font_semibold().child(plain(s.title)))
          // "Depends on" the layers its code builds on (step.dependsOn): a click on one opens it (onItem, chipAt).
          .when(this.stepDeps(s).length > 0, (e) => e.child(div().id(`rv-ldeps-${it.i}`).flex_none().text_size(TYPE.small).text_color(t.muted).tooltip("The layers whose code this one builds on: read them first").child("Depends on"))
            .children(this.stepDeps(s).map(([d, w]) => div().w(w).h(22).flex_none().px(6).flex().items_center().rounded(6).border_1().border_color(t.border).text_size(TYPE.small).text_color(t.accent)
              .truncate().child(plain(d.title)))))
          // Copy as Markdown, on the open layer's head (it copies that one): the last chip of the row (onItem, chipAt).
          .when(on && !s.pseudo, (e) => e.child(div().id("rv-md-l").tooltip(this.mdNow().tip).accessibility_label("Copy this layer as Markdown").w(MD_W).h(22).flex_none().flex().items_center().justify_center().rounded(6).border_1().border_color(this.mdPrev ? t.accent : t.border).bg(t.raised)
            .text_size(TYPE.small).text_color(t.foreground).child("⧉ Copy as Markdown…"))))
        .child(div().flex_none().max_w(LAYER_TEXT).line_height(1.55).text_size(TYPE.body).text_color(t.foreground).child(TextView.markdown(`rv-lwhy-${it.i}`, s.why)))
        .when(s.questions.length > 0, (e) => e.child(div().id(`rv-lq-${it.i}`).tooltip("Questions to check while you read this layer's code").h(18).flex_none().mt(4).text_size(TYPE.small).font_semibold().text_color(t.muted).child("CHECK"))
          .children(s.questions.map((q, k) => h_flex().flex_none().max_w(LAYER_TEXT).gap(8).items_start().text_size(TYPE.body).line_height(1.55)
            .child(div().w(12).flex_none().text_color(t.accent).child("?")).child(div().flex_1().min_w(0).child(TextView.markdown(`rv-lqm-${it.i}-${k}`, this.asked(s, q, k)))))));
    }
    if (it.t === "vis") return div().w_full().h(this.sizeOf(it)).px(16).pb(8).bg(it.i === this.cur ? t.selected : t.raised).when(Boolean(it.bare), (e) => e.cursor_pointer().tooltip("Click to fold the state diagram to one line"))
      .child(visualCard(it.v, t, `rv-lvis-${it.i}-${it.text}`, null, null, (this.listW ?? 900) - 32, { bare: it.bare, marks: it.marks }));
    if (it.t === "visfold") return this.visFoldItem(it, t);
    if (it.t === "vtr") return this.visTransitionItem(it, t);
    if (it.t === "def") return this.defItem(it, t);
    if (it.t === "fold") return div().h(it.h).w_full().pl(GUTTER).pt(8).text_size(TYPE.small).text_color(t.muted).cursor_pointer().child(`${it.n} lines folded to keep the list fast · they open as you scroll here, or click`);
    if (it.t === "more") return h_flex().h(26).w_full().px(16).items_center().gap(6).text_size(TYPE.small).text_color(t.muted).cursor_pointer()
      .child(div().child(`This file has more lines outside this layer: ${it.n} more ${it.n === 1 ? "hunk" : "hunks"}.`)).child(div().text_color(t.accent).child("Show the whole file in Files →"));
    if (it.t === "path") return mono(h_flex()).h(30).w_full().px(16).items_center().text_size(TYPE.small).text_color(t.muted).truncate().child(it.h.path);
    return div().h(30).w_full().px(16).flex().items_center().text_size(TYPE.small).text_color(t.ansi3).child(it.text);
  },

  // A layer's picture over its code (rows of the diff list). A state diagram folds to one line (how many states and
  // transitions, the mark of a finding at a transition) and stays open only when a finding hangs on a transition
  // (views.js transitionMarks); open, its transitions follow as rows of their own, each opening its place on a click
  // (the list has no handlers inside a row: onItem). this.visOpen[text]: the person's choice; command vis:<text>.
  visItems(v, i, k) {
    const text = `vis|${i}|${k}`;
    if (v.kind !== "state_machine") return [{ t: "vis", v, i, text }];
    const marks = transitionMarks(v, this.openFindings());
    if (!(this.visOpen?.[text] ?? marks.size > 0)) return [{ t: "visfold", v, i, text, marks }];
    return [{ t: "vis", v, i, text, bare: true, marks }, ...[...(v.edges ?? []), ...(v.transitions ?? [])].map((e, j) => ({ t: "vtr", v, i, e, j, text: `vtr|${i}|${k}|${j}`, mark: marks.get(j) ?? null }))];
  },
  toggleVis(text) {
    const it = (this.items ?? []).find((x) => x.text === text && (x.t === "vis" || x.t === "visfold"));
    const now = it ? it.t === "vis" : Boolean(this.visOpen?.[text]);
    this.visOpen = { ...this.visOpen, [text]: !now };
  },
  visFoldItem(it, t) {
    const rank = { critical: 0, high: 1, medium: 2, low: 3 }, n = [...(it.v.edges ?? []), ...(it.v.transitions ?? [])].length, top = [...it.marks.values()].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9))[0];
    return div().w_full().h(this.sizeOf(it)).px(16).pb(8).bg(it.i === this.cur ? t.selected : t.raised).cursor_pointer().tooltip("Click to open the state diagram")
      .child(h_flex().h(36).px(10).gap(8).items_center().rounded(8).border_1().border_color(t.border).bg(t.surface).text_size(TYPE.small)
        .child(div().flex_none().text_color(t.muted).child("▸"))
        .child(div().flex_none().font_semibold().text_size(TYPE.small).text_color(t.muted).child("STATE DIAGRAM"))
        .child(div().flex_1().min_w(0).truncate().child(`${it.v.title ? `${it.v.title} · ` : ""}${it.v.nodes.length} ${it.v.nodes.length === 1 ? "state" : "states"}, ${n} ${n === 1 ? "transition" : "transitions"}`))
        .when(Boolean(top), (e) => e.child(chip(t, `${top.severity} · ${[...it.marks.values()].reduce((x, m) => x + m.findings.length, 0)} at a transition`, t[SEVERITY_COLOR[top.severity]] ?? t.ansi1, true))));
  },
  visTransitionItem(it, t) {
    const place = it.e.at ?? it.e.evidence, m = it.mark, name = (id) => it.v.nodes.find((n) => n.id === id)?.label ?? id;
    return h_flex().w_full().h(26).pl(28).pr(16).gap(8).items_center().bg(it.i === this.cur ? t.selected : t.raised).text_size(TYPE.small).when(Boolean(place), (e) => e.cursor_pointer())
      .tooltip([place ? `Click to open ${place}` : "This transition names no place in the code", m && m.findings.map((f) => `· ${f.title}`).join("\n")].filter(Boolean).join("\n"))
      .child(div().flex_none().w(22).text_color(t.muted).child(`${it.j + 1}.`))
      .when(Boolean(m), (e) => e.child(chip(t, m.severity, t[SEVERITY_COLOR[m.severity]] ?? t.ansi1, true)))
      .child(div().flex_1().min_w(0).truncate().text_color(it.e.changed && it.e.source !== "existing" ? t.foreground : t.muted).child(`${name(it.e.from)} → ${name(it.e.to)}${transitionText(it.e) ? ` · ${transitionText(it.e)}` : ""}`))
      .when(Boolean(place), (e) => e.child(div().flex_none().text_color(t.accent).child(`${String(place).split("/").pop()} ↗`)));
  },

  // A row's code: plain text now; phase 3 (syntax.js) swaps in highlighted spans here.
  // Highlights queued files outside render, ~12 ms per slice, then redraws; the next render finds them in the cache.
  // One file must not take the others' colors with it. hlBusy is the time the running slice started (0: none runs).
  // Herdr stops a slice that takes too long without throwing anything, so nothing here could catch that: the render
  // sees a slice busy for more than HL_STALE and starts the queue again. The job that was running then (it never got
  // to clear `running`) is dropped, and so is one that throws: its file stays plain (its spans stay empty and it is
  // not queued again), the files behind it get their colors.
  // A slice asks for no frame of its own (a frame draws the whole window, and a big review took 13 to 17 of them to
  // get its colors). The files on screen go first, and a frame is asked for once they are all colored; the files
  // off screen get theirs without one (the list reads the spans when it scrolls to them). One last frame follows when
  // the queue is empty, and while a long queue runs there is one every HL_FRAME ms at most.
  drainHighlight(cx) {
    const start = this.hlBusy = Date.now(), queue = this.hlQueue ?? new Map(), seen = this.shownSpans();
    for (const [k, job] of seen.size ? [...queue].sort(([a], [b]) => (seen.has(b) ? 1 : 0) - (seen.has(a) ? 1 : 0)) : [...queue]) {
      if (job.running) { this.hlQueue.delete(k); continue; }
      let out = null;
      job.running = true;
      try {
        job.hl ??= highlightJob(job.shown, job.lang); // a big file takes several slices: the job keeps its place
        out = highlightStep(job.hl, Math.max(1, 12 - (Date.now() - start)));
      } catch { this.hlQueue.delete(k); continue; }
      job.running = false;
      if (!out) break;
      job.inf.spans = out;
      this.hlQueue.delete(k);
      if (seen.has(k)) this.hlSeen = true; else this.hlUnseen = true; // colored since the last frame: on screen, off screen
      if (Date.now() - start > 12) break;
    }
    this.hlBusy = 0;
    if (queue.size) { this.hlBusy = Date.now(); cx.timer.after(0, (cx) => this.drainHighlight(cx)); }
    const some = this.hlSeen || this.hlUnseen, waiting = [...seen].some((inf) => queue.has(inf)); // a file on screen is still without its colors
    if ((this.hlSeen && !waiting) || (some && (!queue.size || Date.now() - (this.hlDrawn ?? 0) > HL_FRAME))) { this.hlSeen = this.hlUnseen = false; this.hlDrawn = Date.now(); cx.notify(); }
  },
  // The span holders (spanMap's values) of the files whose lines the list drew in its last frame: what a person sees.
  shownSpans() {
    const v = this.codeShown ? this.visCode : null, seen = new Set();
    if (v && this.items) for (let k = v.start; k < v.end && k < this.items.length; k++) { const inf = this.items[k].t === "row" && this.spanMap?.get(this.items[k].src); if (inf) seen.add(inf); }
    return seen;
  },
  // A row's code, highlighted (syntax.js); spans per row array are computed once per render (spanMap).
  // a, b: one visual line of a wrapped line (its columns a..b of the tab-expanded text, b undefined: to the end).
  // x: px the unwrapped code is scrolled sideways (codeShift).
  code(r, it, ri = it.ri, a = 0, b = undefined, x = 0) {
    const m = this.spanMap?.get(it.src), text = m?.shown[ri]?.text ?? r.text, spans = m?.spans[ri] ?? [];
    if (x > 0) return h_flex().flex_none().ml(-x).children(renderLine(div, text, spans, this.syn));
    if (!a && b === undefined) return h_flex().overflow_hidden().children(renderLine(div, text, spans, this.syn));
    return h_flex().overflow_hidden().children(renderLine(div, text.slice(a, b), sliceSpans(spans, a, b ?? text.length), this.syn));
  },
  // One visual line of a diff line (it.part; a wrapped line takes one list item per visual line, rows of ROW px): the
  // marks bar, line numbers and sign on its first, a muted "↪" and no number on the next ones; the example values and
  // the selection's chips on its last. side: null in the unified view, else the half ("l" old, "r" new) it draws.
  lineView(it, t, ri, side) {
    const r = it.src[ri], starts = this.wrapsOf(it.src, ri, it.cols), part = it.part ?? 0, first = part === 0, last = part === starts.length - 1;
    const on = Boolean(this.selKeys && this.fsel?.path === it.path && this.selKeys.has(lineKey(r)) && (!side || !this.fsel.side || this.fsel.side === side));
    const tone = r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : null, focus = it.hunk && it.hunk === this.focusHunk, newSide = side !== "l";
    if (starts[part] === undefined) return h_flex().h(ROW).when(Boolean(tone), (e) => e.bg(tint(r.kind) + "1a")).when(on, (e) => e.bg(t.selection)) // under a half's shorter line
      .child(div().w(4).h_full().flex_none().when(on, (e) => e.bg(t.accent))).child(div().w(side ? 48 : 96).h_full().flex_none().when(Boolean(tone), (e) => e.bg(tint(r.kind) + "40")));
    const num = (n) => div().w(48).h_full().flex_none().pr(8).flex().items_center().justify_end().text_color(t.muted).child(n === undefined || !first ? "" : String(n));
    const sel = on && !this.composing && this.fsel?.b === lineKey(r) && last, trace = last && newSide && r.kind !== "-" && this.traces?.get(`${it.path}:${r.n}`);
    return h_flex().h(ROW).font_family(settings().font_family ?? "JetBrains Mono").text_size(TYPE.code).cursor_pointer()
      .when(Boolean(tone), (e) => e.bg(tint(r.kind) + "1a")).when(on, (e) => e.bg(t.selection))
      .child(div().w(4).h_full().flex_none().when(on, (e) => e.bg(t.accent)).when(!on && Boolean(focus), (e) => e.bg(t.accent + "55"))
        .when(!on && !focus && newSide && Boolean(this.pinMarks?.has(`${it.path}:${r.n}`)), (e) => e.bg(t.ansi5))
        .when(!on && newSide && r.kind !== "-" && Boolean(this.fmarks?.get(it.path)?.get(r.n)), (e) => e.bg(t[this.fmarks.get(it.path).get(r.n)]))) // the lines of an open finding
      .child(h_flex().h_full().flex_none().relative().when(Boolean(tone), (e) => e.bg(tint(r.kind) + "40")).children(side === "l" ? [num(r.o)] : side === "r" ? [num(r.n)] : [num(r.o), num(r.n)])
        // GitHub's "+" on hover: the line numbers are the comment button (onItem: x inside the gutter).
        .when(first, (e) => e.child(h_flex().absolute().inset_0().justify_end().items_center().text_color("#00000000").hover((s) => s.text_color(t.accent_foreground).bg(t.accent + "26"))
          .child(div().w(18).h(18).mr(2).rounded(4).flex().items_center().justify_center().font_semibold().hover((s) => s.bg(t.accent)).child("+")))))
      .child(div().w(22).flex_none().text_center().font_semibold().text_color(first ? tone ?? t.muted : t.muted).when(!first, (e) => e.text_size(TYPE.small)).child(!first ? "↪" : r.kind === " " ? "" : r.kind === "-" ? "−" : "+"))
      .child(div().flex_1().min_w(0).pr(12).overflow_hidden().text_color(t.foreground).child(this.code(r, it, ri, starts[part], starts[part + 1], this.codeShift())))
      .when(Boolean(trace), (e) => e.child(div().id("rv-trace").tooltip("Example values from the flow trace; Values in the top bar switches them").flex_none().max_w(460).mr(12).px(8).h(18).flex().items_center()
        .rounded(9).bg(t.accent + "1f").italic().text_size(TYPE.small).text_color(t.muted).truncate().child(trace)))
      // The selection's last row: "+ Comment (c)" at its right end (onItem places the click by x, rowClick).
      .when(sel, (e) => e.child(div().w(ASK_W).h(18).mr(8).flex_none().flex().items_center().justify_center()
        .rounded(9).border_1().border_color(t.accent).text_size(TYPE.small).text_color(t.accent).child("Ask").id("rv-sel-ask").tooltip("Ask one model question about the selected lines")))
      .when(sel, (e) => e.child(div().w(CHIP_W).h(18).mr(12).flex_none().flex().items_center().justify_center()
        .rounded(9).bg(t.accent).text_size(TYPE.small).font_semibold().text_color(t.accent_foreground).child("+ Comment (c)").id("rv-sel-comment").tooltip("Comment on the selected lines (c)")));
  },

  // The left column's width: while dragging the pointer's, else the kept one (default 560, 340 to 65% of the window).
  leftW() { return leftWidth(this.dragW ?? shared("review.leftWidth"), this.winW); },
  // The 6 px divider between the column and the diff: drag to resize, double-click for the default width.
  // The Files list's geometry for autoFold (item tops, file headers, folded spans), each open file's height for
  // foldH, and the anchor: after the room moved, the item that was at the top of the view goes back there.
  layFiles(items, keys, sizes, heads) {
    const top = new Float64Array(items.length + 1), folds = [], openH = (this.openH ??= new Map());
    for (let i = 0; i < items.length; i++) top[i + 1] = top[i] + sizes[i];
    const n = items.at(-1)?.t === "pad" ? items.length - 1 : items.length; // the selection toolbar's room isn't a file's
    heads.forEach((h, k) => {
      const end = heads[k + 1] ?? n, it = items[h + 1];
      if (it?.t === "fold") folds.push([top[h + 1], top[h + 2]]);
      else if (it?.t === "row") openH.set(it.path, { rows: it.src, h: top[end] - top[h + 1], key: `${it.l !== undefined}|${it.cols}` }); // rows first: no "Loading file…" note; key: as drawn (foldH)
    });
    this.filesList = { heads, top, folds, keys };
    const a = this.anchor;
    if (a) { this.anchor = null; const i = keys.indexOf(a.key); if (i >= 0 && top[i] !== a.y && !this.top) this.top = { view: "files", i }; }
  },

  splitter(t) {
    return h_flex().id("rv-split").tooltip("Drag to resize the left column; double-click to reset").w(SPLIT).h_full().flex_none().justify_center().cursor_col_resize().bg(this.drag ? t.accent + "33" : t.chrome).hover((s) => s.bg(t.accent + "33"))
      .on_mouse_down("left", (_e, cx) => { this.drag = true; cx.stop_propagation(); cx.notify(); })
      .on_click((e, cx) => { if (e.click_count === 2) { this.drag = false; this.dragW = null; setShared("review.leftWidth", null); cx.notify(); } })
      .child(div().w(1).h_full().bg(this.drag ? t.accent : t.border));
  },

  renderReview(cx) {
    const t = theme(), target = shared("review.target") ?? null, ex = shared("review.explore");
    this.edOn = Boolean(editorFor({ root: this.checkoutRoot() ?? this.lspRoot() }, cx)); // an editor is installed (the first ask looks, by reading files); the links of this frame name theirs
    if (ex) {
      if (this.exStart !== ex) { if (ex.start && this.exStart?.at !== ex.at) this.exRoot = null; this.enterExplore(ex, cx); }
      const root = v_flex().id("rv-root").size_full().bg(t.background).text_color(t.foreground).text_size(TYPE.body)
        .on_size_change((size, cx) => { if (Math.abs((this.winW ?? 0) - size.width) > 8) { this.winW = size.width; cx.notify(); } })
        .on_mouse_move((e, cx) => { if (this.drag) { this.dragW = leftWidth(e.local_position?.x ?? e.position.x, this.winW); cx.notify(); } this.hsMove(e, cx); })
        .on_mouse_up("left", (_e, cx) => { this.hsDrag = null; if (this.drag) { this.drag = false; if (this.dragW !== null && this.dragW !== undefined) setShared("review.leftWidth", this.dragW); this.dragW = null; cx.notify(); } })
        .track_focus(this.fh).on_key_down((e, cx) => this.onReviewKey(e, cx));
      return this.renderExplore(cx, ex, root);
    }
    this.leaveExplore();
    if (target?.url !== this.prSel?.url) { this.prSel = target; this.resetReview(); }
    // The terminals whose state this review shows (a fix's agent, a check, a probe): the bar's copy tells when one of
    // them changed (live.js), so this copy is not drawn for every other agent's status.
    watch([...this.fixes().filter((j) => j.state === "running" && j.terminal).map((j) => j.terminal),
      ...Object.values(this.find.status ?? {}).filter((x) => x?.proof?.state === "running" && x.proof.terminal).map((x) => x.proof.terminal),
      ...Object.values(this.deep?.probes ?? {}).filter((x) => x?.state === "running" && x.terminal).map((x) => x.terminal)]);
    // After a refresh for the previous target ended; queued, since refresh() notifies and render may not.
    if (!this.refreshQueued && this.prSel && this.key() !== this.context) {
      this.refreshQueued = true;
      cx.timer.after(0, (cx) => { this.refreshQueued = false; this.refresh(cx); });
    }
    if (this.hunks && model() !== this.aiModel && !this.aiBusy) this.loadAi(cx, "cache");
    if (this.prSel) this.loadModels(cx);
    this.impactTick(cx); // the Impact section (impact-view.js): only on the Architecture page
    this.schemaTick(cx); // "Schema changes" (schema-view.js): the same
    // The diff column's width: card heights wrap to it. on_size_change reports the window in logical px; the column and
    // its rows are laid out in px scaled by the person's zoom (as in settleTop).
    if (this.winW) this.listW = this.winW / (settings().zoom || 1) - this.leftW() - SPLIT - (this.drawerSqueezes() ? 380 : 0);
    // Lines a pinned answer cites: marked in the diff's gutter (memoized on the pins).
    if (this.pinMarksOf !== this.pins()) { this.pinMarksOf = this.pins(); this.pinMarks = new Set(this.pinMarksOf.flatMap((p) => (p.evidence ? [p.evidence.replace(/^(.*?):(\d+).*$/, "$1:$2")] : []))); }
    const other = target && !C.shown(ctxDoc(), prCtx(target), shared);
    const root = v_flex().id("rv-root").size_full().bg(t.background).text_color(t.foreground).text_size(TYPE.body)
      .on_size_change((size, cx) => { if (Math.abs((this.winW ?? 0) - size.width) > 8) { this.winW = size.width; cx.notify(); } })
      // Dragging the divider: the column follows the pointer; the width is kept (shared "review.leftWidth") on release.
      // ponytail: a release outside the window keeps dragging until the next release here.
      .on_mouse_move((e, cx) => {
        if (this.drag) { this.dragW = leftWidth(e.local_position?.x ?? e.position.x, this.winW); cx.notify(); }
        this.hsMove(e, cx);
      })
      .on_mouse_up("left", (_e, cx) => { this.hsDrag = null; if (this.drag) { this.drag = false; if (this.dragW !== null && this.dragW !== undefined) setShared("review.leftWidth", this.dragW); this.dragW = null; cx.notify(); } })
      .track_focus(this.fh).on_key_down((e, cx) => this.onReviewKey(e, cx));
    if (!target || other) {
      return root.items_center().justify_center().gap(12).text_color(t.muted)
        .child(div().child(other ? `This PR belongs to ${C.nameOf(ctxDoc(), prCtx(target))}, which the current view hides.`
          : 'No PR selected: click "Review" on a PR in the PR panel.'))
        .child(pill("rv-empty-back", t, "← Back (Esc)", () => leave()).tooltip("Leave the review (Esc)"));
    }
    // Where you were is not read yet (applyResume): hold the frame, so the first one drawn stands there.
    if (this.resumed !== this.prSel?.url) {
      // The timer's cx is valid only inside its call; applyResume waits for a file, so it runs as a task with its own.
      if (!this.resumeQueued) { this.resumeQueued = true; cx.timer.after(0, (cx) => { this.resumeQueued = false; cx.spawn((cx) => this.applyResume(cx)); }); }
      return root;
    }
    // A page (Overview, Architecture…) or a definition covers the list: skip building it (a big PR's diff is the bulk
    // of a render, and a picture's sideways scroll renders per wheel event); this.items/at/byKey keep the last list.
    const listShown = !this.defFile && !(this.tab === "steps" && this.page);
    if (listShown) this.traces = this.traceMap();
    const { items, at, heads } = listShown ? this.itemsOf(this.tab === "steps" ? "steps" : "files") : { items: [], at: {} };
    if (this.selCount()) items.push({ t: "pad" }); // room for the selection toolbar
    // hold: the list stays unseen for the one frame settleTop needs to get there (it scrolls past, then aligns).
    if (this.pendingScroll && at[this.pendingScroll] !== undefined) { this.scrollTo(this.tab === "steps" ? "steps" : "files", this.pendingScroll); this.top.hold = true; this.pendingScroll = null; }
    if (this.scrollCompose && at.compose !== undefined) { this.lists[this.tab === "steps" ? "steps" : "files"].scroll_to_item(at.compose, "center"); this.scrollCompose = false; }
    this.uiChanged(cx);
    this.syn = colors(t);
    // Per row array (memoRows keeps them across renders), so a render neither hashes nor tokenizes a big diff again:
    // uncolored until drainHighlight fills in the spans.
    const head = this.worktree?.head ?? "";
    if (!this.spanMap || this.spanHead !== head) { this.spanMap = new WeakMap(); this.spanHead = head; }
    for (const it of items) {
      if (it.t !== "row" || this.spanMap.has(it.src)) continue;
      const shown = it.src.map((r) => (r.text?.includes("\t") ? { ...r, text: expandTabs(r.text) } : r)); // tabs drawn as spaces: clicks map back
      // A script without an ending is known by its first line: from the whole file where it is loaded, else from the diff.
      const whole = this.full[it.path], lang = langOf(it.path, Array.isArray(whole) ? whole[0] : firstLineOf((this.patch ?? []).find((f) => f.path === it.path)?.lines ?? []));
      const inf = { shown, spans: [] };
      this.spanMap.set(it.src, inf);
      if (lang) (this.hlQueue ??= new Map()).set(inf, { shown, lang, hkey: `${head}:${it.path}`, inf });
    }
    // A slice busy for longer than HL_STALE was stopped (or its timer never fired): the queue starts again.
    if (this.hlQueue?.size && (!this.hlBusy || Date.now() - this.hlBusy > HL_STALE)) { this.hlBusy = Date.now(); if (!this.hlSeen && !this.hlUnseen) this.hlDrawn = Date.now(); cx.timer.after(0, (cx) => this.drainHighlight(cx)); }
    if (items.length > 9990) items.length = 9990; // the virtual list's hard limit is 10000
    const keys = itemKeys(items), sizes = items.map((it) => this.sizeOf(it)), hcode = this.codeScroll(listShown ? items : []);
    this.codeShown = listShown; // for drainHighlight: whether lines of code are on screen at all
    if (listShown) { this.items = items; this.at = at; this.byKey = new Map(keys.map((k, i) => [k, items[i]])); }
    if (heads) this.layFiles(items, keys, sizes, heads.filter((h) => h < items.length));
    if (listShown) this.settleTop(this.tab === "steps" ? "steps" : "files", at, sizes, cx);
    const held = listShown && Boolean(this.top?.hold); // still on its way to where you were: drawn in the next frame
    const listId = `rv-list-${this.tab === "steps" ? "steps" : "files"}`;
    const range = this.fsel && rangeOf(this.rowsFor(this.fsel.path), this.fsel.a, this.fsel.b);
    this.selKeys = range ? new Set(this.rowsFor(this.fsel.path).slice(range[0], range[1] + 1).map(lineKey)) : null;
    // A tab is at least as wide as its label and shares what is left; a column too narrow for all four wraps them.
    const tabBtn = (id, label) => div().id(`rv-tab-${id}`).flex_grow(1).flex_shrink(0).px(8).h(32).flex().items_center().justify_center().rounded(7).text_size(TYPE.body).cursor_pointer()
      .bg(this.tab === id ? t.selected : t.chrome).text_color(this.tab === id ? t.foreground : t.muted).when(this.tab === id, (e) => e.font_semibold()).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.tab = id; cx.notify(); }).child(tabTip(`rv-tab-${id}`, t, TAB_TIP[id], div().whitespace_nowrap().child(label)));
    return root
      .child(this.metaRow(t))
      .child(h_flex().flex_1().min_h(0)
        .child(v_flex().w(this.leftW()).flex_none().h_full().bg(t.chrome)
          .child(h_flex().flex_none().flex_wrap().p(8).gap(6).border_b(1).border_color(t.border)
            .child(tabBtn("files", `Files · ${this.shown().patch.length}`)).child(tabBtn("steps", this.analysisLabel(t)))
            .child(tabBtn("comments", `Comments${this.commentRowsNow().length ? ` · ${this.commentRowsNow().length}` : ""}`))
            .child(tabBtn("findings", `Findings${this.findings().length ? ` · ${this.counts().unresolved}` : ""}`)))
          .child(this.tab === "steps" ? this.stepsPane(t, cx) : this.tab === "findings" ? this.findingsPane(t) : this.tab === "comments" ? this.commentsPane(t) : this.filesPane(t)))
        .child(this.splitter(t))
        .child(v_flex().flex_1().min_w(0).h_full().relative()
          .child(div().id("rv-probe").absolute().top(-100).font_family(settings().font_family ?? "JetBrains Mono").text_size(TYPE.code).whitespace_nowrap()
            .on_size_change((size, cx) => { const w = size.width / PROBE.length; if (w > 0 && Math.abs((this.charW ?? 0) - w) > 0.01) { this.charW = w; cx.notify(); } }).child(PROBE))
          .when(Boolean(this.defFile), (e) => e.child(this.defView(t)))
          .when(!this.defFile && this.tab === "steps" && Boolean(this.page), (e) => e.child(this.pageView(t)))
          .when(!this.defFile && this.tab === "files" && Boolean(this.since), (e) => e.child(this.sinceBanner(t)))
          .when(Boolean(this.worktree?.path) && !this.trustedPr() && !this.trustAsked(), (e) => e.child(this.trustPrompt(t)))
          .when(Boolean(this.needClone), (e) => e.child(h_flex().flex_none().px(14).py(8).gap(10).items_center().bg(t.ansi3 + "1c").border_b(1).border_color(t.border).text_size(TYPE.small)
            .child(div().flex_1().min_w(0).whitespace_normal().child(`No local clone of ${target.repo ?? "this repo"}: reviewers, whole files, definitions and the AI analysis need one. The diff works without.`))
            .child(pill("rv-clone", t, this.cloning ? "Cloning…" : `Clone to ${this.needClone.replace(home(), "~")}`, (_e, cx) => { if (!this.cloning) { this.makeWorktree(cx, true); cx.notify(); } }, false, t.foreground).tooltip("Clone the repository once, so the PR head can be checked out for reviewers and go-to-definition"))))

          .when(listShown, (e) => e.child(div().id(`${listId}-wrap`).flex_1().min_h(0).relative().when(held, (x) => x.opacity(0)).on_size_change((size) => { this.listH = size.height; })

            // The Files list: scrolling, or dragging its scrollbar, near a folded file opens the files around the view.
            .on_scroll_wheel((e, cx) => { if (heads) this.autoFold(cx); if (hcode.maxX > 0) this.hsWheel("rv-code", e, cx); }) // sideways: the code (codeScroll)
            .when(Boolean(heads), (e) => e.on_mouse_move((_e, cx) => this.autoFold(cx)).on_mouse_up("left", (_e, cx) => this.autoFold(cx)))
            // With the composer open, onItem decides where the keyboard goes (a press in the textarea keeps it).
            .on_mouse_down("left", (e, cx) => { this.press = { x: e.local_position?.x ?? 0, w: e.bounds?.width ?? this.listW ?? 900, shift: e.modifiers.shift, cmd: e.modifiers.platform }; if (!this.composing) this.fh.focus(); })
            .child(items.length
              ? v_virtual_list(listId, items.length, sizes, (i) => keys[i], (range) => { if (heads) this.vis = { start: range.start, end: range.end }; this.visCode = range; return items.slice(range.start, range.end).map((it) => this.item(it, t)); })
                .track_scroll(this.lists[this.tab === "steps" ? "steps" : "files"]).on_item_click((key, cx) => this.onItem(key, cx)).size_full()
              : div().p(20).text_size(TYPE.body).text_color(this.error ? t.ansi1 : t.muted).child(this.error || (this.loading || !this.patch
                ? h_flex().gap(8).child(div().child(SPIN[0]).frames(SPIN, 90)).child("Loading…") : "No diff")))
            .child(Scrollbar.vertical(listId).absolute().inset_0())
            .when(hcode.maxX > 0, (e) => e.child(div().id("rv-code-hbar").tooltip("Scroll bar for long lines: drag, or shift+wheel over the code").absolute().left(0).right(0).bottom(0).h(10).bg(t.raised)
              .child(div().absolute().top(1).left(Math.round((hcode.x / hcode.contentW) * hcode.visW)).w(Math.max(30, Math.round((hcode.view / hcode.contentW) * hcode.visW))).h(8).rounded(4).bg(t.muted).cursor_pointer()
                .on_mouse_down("left", (ev, cx) => { this.hsDrag = { id: "rv-code", x0: ev.position.x, from: hcode.x, thumb: true }; cx.stop_propagation(); }))))))
          .when(Boolean(this.note), (e) => e.child(noteBar(this, t, cx)))
          .when(Boolean(this.saveErr), (e) => e.child(this.saveErrBar(t)))
          .when(Boolean(this.replyTo), (e) => e.child(this.replyBar(t)))
          .when(this.selCount() > 0, (e) => e.child(this.selectionBar(t)))
          .when(Boolean(this.applyBlocked), (e) => e.child(h_flex().flex_none().px(14).py(8).gap(8).items_center().border_t(1).border_color(t.border).bg(t.ansi3 + "1c").text_size(TYPE.small)
            .child(div().flex_1().whitespace_normal().child(`${this.applyBlocked.branch}: the PR's checkout isn't clean, so it can't be applied here.`))
            .child(pill("rv-handover", t, "Hand over…", (_e, cx) => this.handOverApply(this.applyBlocked, cx), false, t.foreground).tooltip("Ask the main agent to apply the fix; a preview first"))
            .child(pill("rv-handover-x", t, "Later", (_e, cx) => { this.applyBlocked = null; cx.notify(); }).tooltip("Dismiss this notice"))))
          .when(this.finishOpen && !this.sendP, (e) => e.child(this.finishPopover(t)))
          .when(Boolean(this.sendP), (e) => e.child(this.sendPopover(t)))
          .when(Boolean(this.mdPrev) && !this.sendP, (e) => e.child(this.mdPopover(t)))
          .when(!this.drawerSqueezes() && this.drawerState() === "open", (e) => e.child(div().absolute().top(0).right(0).bottom(0).child(this.askDrawer(t))))
          .when(this.drawerState() === "collapsed", (e) => e.child(div().absolute().top(0).right(0).bottom(0).child(this.drawerStrip(t)))))
        .when(this.drawerSqueezes(), (e) => e.child(this.askDrawer(t))));
  },

  // ---- the Overview page's helpers

  taskNow() { return taskList(this.ai?.asks ?? [], this.findings(), this.ai?.unlinked ?? [], (f) => this.fstatus(f)); },
  toggleAsk(id) { if (!(this.askOpen ??= new Set()).delete(id)) this.askOpen.add(id); }, // the open rows of the task check
  // The verdict line's parts (pr.js verdictParts), for the Overview and the bar's excerpt alike; the Resilience run's
  // blockers as a part of their own ("↯ 2 resilience blockers", their reasons in its tooltip).
  verdictNow() {
    const fc = this.counts(), checks = this.checksNow(), rb = (this.resNow()?.paths ?? []).filter((p) => p.blocker).length;
    const res = rb ? [{ key: "resilience", text: `↯ ${rb} resilience ${rb === 1 ? "blocker" : "blockers"}`, short: `↯ ${rb} resilience`, tone: "plain" }] : []; // the bar's excerpt: the sign with its word, as "⛨ 1 high" has one
    return this.ai || fc.total ? [...verdictParts(this.taskNow(), fc, { failed: checks.filter((c) => c.ok === false).length, toVerify: this.verifyList().length, oldRules: Boolean(secNote(this.ai)) }), ...res] : [];
  },
  // The Overview's "Before merge" rows (pr.js beforeMerge on mergeBlockers).
  mergeRows() {
    // The Resilience run's blockers stand with the others, one row each with its line, right after the security rows;
    // then what nothing would show after the merge (views.js resWatch: a blind spot without any signal).
    const cur = this.resNow(), lineOf = (p) => [p.blocker.at, ...(p.steps ?? [])].find((s) => /:\d+$/.test(String(s ?? ""))) ?? null;
    const res = [...(cur?.paths ?? []).filter((p) => p.blocker).map((p) => ({ kind: "resilience", title: resSentence(p), why: `Blocker: ${p.blocker.reason ?? p.blocker.why}`, path: p.id, where: lineOf(p), asks: [] })),
      ...(cur ? resWatch(cur, this.ai?.arch).before : []).map((b) => ({ kind: "resilience", title: b.text, why: "Not observable after the merge: no alarm, log line or metric shows it", path: null, where: b.at ?? null, asks: [] }))];
    // One row per cause: a later finding of a cause whose first is still open stands at that first row (views.js byCause).
    const rows = byCause(beforeMerge({ list: this.taskNow(), findings: this.findings(), statusOf: (f) => this.fstatus(f), blockers: this.blockersNow() }), this.openFindings()), sec = rows.filter((r) => r.kind === "security").length;
    return [...rows.slice(0, sec), ...res, ...rows.slice(sec)]; // after the security rows: a way a failure grows without limit is as urgent
  },
  // What the AI runs on this PR cost, summed (pr.js costLine): the analysis, the reviewers, Look inside and Ask.
  costNow() {
    const sum = (l) => l.reduce((n, c) => n + (Number(c) || 0), 0);
    return costLine([["Analysis", this.ai?.cost], ...Object.entries(this.find.runs ?? {}).map(([k, r]) => [REVIEWERS[k]?.[0] ?? k, r?.cost]),
      ["Look inside", sum(Object.values(this.deep?.drills ?? {}).map((d) => d?.cost))], ["Questions", sum(Object.values(this.deep?.threads ?? {}).flatMap((x) => x?.turns ?? []).map((x) => x?.cost))]]);
  },
  // Text that is read, not glanced at (a criterion's reason): the foreground at about 78 %, Lc 60 and more on the page,
  // where the muted grey is Lc 46.
  softText(t) { return /^#[0-9a-f]{6}$/i.test(t.foreground) ? `${t.foreground}c8` : t.foreground; },

  // The line under the verdict: the PR's size, which head the analysis read and how long ago (amber when the PR moved
  // since), what the AI runs cost (the model in the tooltip), and where the numbers come from: reported by every source
  // → merged → before the merge (a click opens the Findings tab); then the model choice for the analysis.
  contextLine(t, rows = []) {
    const ai = this.ai, files = this.patch ?? [], head = this.headNow(), cost = this.costNow(), all = this.findings(), fn = funnel(all, (f) => this.fstatus(f));
    const add = files.reduce((n, f) => n + (f.add ?? 0), 0), del = files.reduce((n, f) => n + (f.del ?? 0), 0);
    const fact = (id, text, tip, click = null, color = null) => div().id(id).tooltip(tip).when(Boolean(color), (e) => e.text_color(color))
      .when(Boolean(click), (e) => e.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(click)).child(text);
    const facts = [
      files.length > 0 && fact("rv-ov-size", `${files.length} ${files.length === 1 ? "file" : "files"} +${add} −${del}`, "Files this PR changes, lines added and removed"),
      ai && (ai.exact ? fact("rv-ov-ana", `analysis of ${head ? String(head).slice(0, 7) : "this head"}, ${ago(ai.generated)}`, `The analysis (${modelLabel(ai.model) ?? ai.model}) read the PR's current head commit.`)
        : fact("rv-ov-ana", `analysis of an earlier head, ${ago(ai.generated)}`, "The PR has new commits since the analysis ran: its layers and findings may be out of date. Re-analyze in the left column.", null, t.ansi3)),
      Boolean(cost) && fact("rv-ov-cost", cost.split(" (")[0], `What the AI runs on this PR cost: ${cost}.`),
      // Two nouns instead of three stages with arrows; how many stand before the merge is that section's own count.
      fn.merged > 0 && fact("rv-ov-funnel", `${fn.merged} ${fn.merged === 1 ? "finding" : "findings"}${fn.reported > fn.merged ? ` from ${fn.reported} reports` : ""} ▸`, `${funnelLine(fn, (k) => REVIEWERS[k]?.[0] ?? k)} ${rows.length} stand before the merge. Click for the Findings tab.`,
        (_e, cx) => { this.tab = "findings"; cx.notify(); }),
      this.ctx?.at && this.freshFact(fact),
    ].filter(Boolean);
    const offer = this.runOffer?.("analysis", t) ?? null; // Paket A's model choice for the analysis, once there
    return h_flex().id("rv-ov-context").flex_wrap().gap(8).items_center().text_size(TYPE.small).text_color(t.muted)
      .children(facts.flatMap((f, k) => (k ? [div().flex_none().text_color(t.dim).child("·"), f] : [f]))).when(Boolean(offer), (e) => e.child(offer));
  },

  // The Overview's right column: what the PR does as a labeled list (pr.js doesList), a flow picture when the analysis
  // has one, then one line each for the new parts and the repo rules (unfolded when one failed), and the related PRs
  // when one besides the base is there (the base is in the context line).
  doesPane(t) {
    const ai = this.ai, task = ai?.task ?? {}, pr = this.prSel ?? {}, ctx = this.ctx, checks = this.checksNow(), rules = checkGroups(checks).rules, rows = ai ? doesList(ai) : [];
    const head = (title, first = false) => div().pt(first ? 0 : 22).pb(6).text_size(TYPE.body).font_semibold().text_color(t.foreground).child(title);
    const line = (id, label, child, tip, click = null) => h_flex().id(id).tooltip(tip).gap(10).items_start().py(3).px(6).rounded(6)
      .when(Boolean(click), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(click))
      .child(div().w(84).flex_none().text_size(TYPE.small).pt(1).text_color(t.muted).child(label)).child(div().flex_1().min_w(0).child(child));
    const intent = Boolean(task.jira || task.note || (task.title && task.title !== pr.title));
    // The rules and checks by name, what failed first; the count is the bar's (checkGroups: the repo rules only).
    const rank = (r) => [false, null, true, "n/a"].indexOf(r.ok);
    const all = [...checks.filter((c) => !c.rule).map((c) => ({ ok: c.ok, name: c.name, sub: c.ok === true ? "" : c.why ?? "", where: c.where })),
      ...realRules(ai?.rules ?? []).map((r) => ({ ok: r.status === "pass" ? true : r.status === "fail" ? false : "n/a", name: r.rule, sub: `${r.source}${r.where ? ` · ${r.where}` : ""}${r.why ? `: ${r.why}` : ""}`, where: r.where }))]
      .sort((a, b) => rank(a) - rank(b));
    const MARK = { true: ["✓", "ansi2", "Passed"], false: ["✗", "foreground", "Failed"], null: ["…", "ansi3", "Not decided yet"], "n/a": ["n/a", "muted", "Does not apply to this PR"] }; // red is the security part's
    const failed = all.some((r) => r.ok === false), open = this.rulesOpen ?? failed, passed = rules.filter((c) => c.ok === true).length, ci = checkGroups(checks).ci;
    const ruleText = `${passed} of ${rules.length} passed${ci.length ? ` · CI ${ci.filter((c) => c.ok === true).length} of ${ci.length}` : ""} ${open ? "▾" : "▸"}`;
    // The base is in the title's state; a PR that builds on this one stays here as "on top".
    const related = [...(ctx?.open ?? []).filter((p) => !p.stacked || p.above).map((p) => ({ ...p, state: p.above ? "on top" : "open" })), ...(ctx?.merged ?? []).map((p) => ({ ...p, state: "merged" }))];
    // A flow picture only when a path in it is broken or doubled: an unresolved finding breaks one of its calls.
    const flow = (ai?.visuals ?? []).find((v) => v.kind === "flow" && this.openFindings().some((f) => f.breaks?.node || f.breaks?.from));
    const surface = ai ? surfaceLine(ai.access, [...(ai.scope?.checked ?? []), ...(this.find.runs?.security?.scope?.checked ?? [])]) : null;
    return v_flex().flex_none().gap(2).text_size(TYPE.body)
      .when(Boolean(ai), (e) => e.child(head("What the PR does", true))
        .when(intent, (x) => x.child(v_flex().px(6).pb(4).gap(4)
          .child(h_flex().gap(6).items_center().when(Boolean(task.title) && task.title !== pr.title, (y) => y.child(div().min_w(0).truncate().child(task.title)))
            .when(Boolean(task.jira), (y) => y.child(chip(t, `Linked issue ${task.jira}`, t.accent, false, "rv-jira", "The issue this PR links to"))))
          .when(Boolean(task.note), (y) => y.child(div().id("rv-does-note").tooltip(task.note).text_size(TYPE.small).text_color(t.ansi3).truncate().child(task.note)))))
        // "Asked for" (the task's intent) is not here: the criteria on the left say it.
        .children(rows.map(([label, items], k) => line(`rv-does-${k}`, label, this.bullets(t, items, `rv-does-${k}`),
          ai.whatChanged ? `What the PR ${label === "Adds" ? "adds" : label === "Changes" ? "changes" : "does at run time"}` : "From the analysis' summary and behavior, sentence by sentence")))
        .when(Boolean(flow), (x) => x.child(div().pt(10).max_w(600).child(visualsCard([flow], t, "rv-ov-flow", (at, cx) => this.jumpTo(at, cx), 0, () => {}, this.wrapX())))))
      .child(div().h(ai ? 16 : 0))
      .when(Boolean(surface), (e) => e.child(line("rv-ov-surface", "Attack surface", div().truncate().child(surface), "Ways in, rights and secrets this PR touches, from the analysis and the security review: click for the Security page",
        (_e, cx) => { this.page = "blast"; cx.notify(); })))
      .when(Boolean(componentLine(ai?.componentCounts)), (e) => e.child(line("rv-ov-comp", "New parts", h_flex().gap(8).child(div().flex_1().min_w(0).truncate().child(componentLine(ai.componentCounts))).child(div().flex_none().text_size(TYPE.small).text_color(t.accent).child("Show ▸")),
        "Components this PR adds or changes, as the analysis counts them: click for the Architecture impact page", (_e, cx) => { this.page = "arch"; cx.notify(); })))
      .when(all.length > 0, (e) => e.child(line("rv-ov-rules", "Repo rules", div().child(ruleText), open ? "Hide the rules and checks" : "Show the rules and checks by name", (_e, cx) => { this.rulesOpen = !open; cx.notify(); })))
      // One line a rule: its name; where it comes from and why it failed in the tooltip.
      .when(all.length > 0 && open, (e) => e.children(all.map((r, k) => h_flex().id(`rv-ck-${k}`).tooltip([`${MARK[r.ok][2]}: ${r.name}`, r.sub && plain(r.sub), r.where && "Click to jump to the code."].filter(Boolean).join("\n")).gap(10).items_center().pl(100).pr(6).py(2).rounded(6).text_size(TYPE.small)
        .when(Boolean(r.where), (x) => x.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.jumpTo(r.where, cx)))
        .child(div().w(22).flex_none().font_semibold().text_color(t[MARK[r.ok][1]]).child(MARK[r.ok][0]))
        .child(div().flex_1().min_w(0).truncate().child(r.name))))
        .when(!ctx, (x) => x.child(div().pl(100).text_size(TYPE.small).text_color(t.muted).child("CI checks and mergeability load in the background…"))))
      .when(related.length > 0, (e) => e.child(line("rv-ov-related", "Related PRs", div().child(`${[related.some((p) => p.above) && `${related.filter((p) => p.above).length} on top of this PR`, related.some((p) => !p.above) && `${related.filter((p) => !p.above).length} touch the same files`].filter(Boolean).join(" · ")} ${this.relOpen ? "▾" : "▸"}`), "Other PRs that change the same files, and the ones that build on this PR: click to show them",
        (_e, cx) => { this.relOpen = !this.relOpen; cx.notify(); }))
        .when(Boolean(this.relOpen), (x) => x.children(related.map((p) => h_flex().id(`rv-rel-${p.number}`).tooltip("Open this related PR in its own review").gap(8).items_center().pl(100).pr(6).py(2).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.openRelated(p, cx))
          .child(div().flex_none().text_size(TYPE.small).text_color(p.state === "open" ? t.ansi2 : p.above ? t.accent : t.ansi5).child(p.state))
          .child(div().flex_none().text_size(TYPE.small).text_color(t.muted).child(`#${p.number}`))
          .child(div().flex_1().min_w(0).truncate().text_size(TYPE.small).child(p.title))
          .child(div().id(`rv-relf-${p.number}`).flex_none().text_size(TYPE.small).text_color(t.muted).tooltip((p.files ?? []).join("\n") || "-").child(p.above ? "it builds on this PR" : `${p.overlap} ${p.overlap === 1 ? "file" : "files"} overlap`))))));
  },

  // The bar's "Repo rules 2/2": the rules this PR is checked against (the title's form and the analysis' repo rules)
  // by name in the tooltip; CI and conflicts only when GitHub reports some. null: nothing to say yet.
  checkFacts() {
    if (!this.prSel) return null;
    const checks = this.checksNow(), { ci, rules } = checkGroups(checks), ok = (l) => l.filter((c) => c.ok === true).length;
    const parts = [rules.length > 0 && [`Repo rules ${ok(rules)}/${rules.length}`, rules.some((c) => c.ok === false)], ci.length > 0 && [`CI ${ok(ci)}/${ci.length}`, ci.some((c) => c.ok === false)],
      checks.some((c) => c.name === "No merge conflicts" && c.ok === false) && ["Merge conflicts", true]].filter(Boolean);
    if (!parts.length) return null;
    return { parts, tip: `${rules.length ? `Rules this PR is checked against: ${rules.map((c) => `${c.name} (${c.ok ? "met" : "not met"})`).join(", ")}. ` : ""}${this.ctx && !ci.length ? "GitHub reports no CI checks for this PR. " : ""}Click for the list on the Overview page.` };
  },

  // A click that leads to a part of the right pane's page (pageView's names): shown after the render that has it.
  pagePart(name, cx) {
    if (name === "checks" && this.page === "overview") { this.rulesOpen = true; name = "main"; } // the rules sit in the Overview's right column, unfolded
    cx.timer.after(30, (cx) => { const k = (this.pageParts ?? []).indexOf(name); if (k >= 0) this.pageScrolls[this.page]?.scroll_to_item(k); cx.notify(); });
  },

  // "Copy review state" (the ⋯ menu): the verdict, the task check and the findings by state as text for a colleague.
  copyState() {
    if (!this.prSel) return;
    const p = this.progressNow();
    const ai = this.ai, behavior = ai?.behaviorPoints?.length ? ai.behaviorPoints.map((x) => x.text).join(" ") : ai?.behavior ?? "";
    const fixOf = (f) => { const ff = Object.fromEntries(this.fixFacts(f)); return [ff.Agent, ff.Branch].filter(Boolean).join(", "); };
    const text = reviewState({ oldRules: Boolean(secNote(this.ai)), pr: this.prSel, head: this.worktree?.head ?? this.prSel.headSha ?? "", list: this.taskNow(), counts: this.counts(), findings: this.findings(), statusOf: (f) => this.fstatus(f),
      progress: `Reviewer's progress: ${p.filesViewed} of ${p.files} files viewed, ${p.comments} pending ${p.comments === 1 ? "comment" : "comments"}.`, behavior, fixOf, cost: this.costNow() });
    copyText(text);
    this.note = `Review state copied as text (${text.trim().split("\n").length} lines), nothing was posted.${this.findings().some((f) => secByEffect(f)) ? " Security findings about access or data are in it with their title only." : ""}`;
  },

  // "Copy as Markdown" (the button in a page's head, and "Copy this page as Markdown" in the ⋯ menu): what the right side shows, as text to hand to an agent (markdown.js):
  // the Overview, the open layer, the Architecture or the Security page; on the Findings tab the open finding, else
  // all unresolved ones; on Files and Comments the Overview. Pictures are Mermaid. Security findings are in it in
  // full: it goes to the clipboard only.
  copyMd(kind = "") {
    if (!this.prSel) return;
    const ai = this.ai, findings = this.findings(), statusOf = (f) => this.fstatus(f), base = { pr: this.prSel, head: this.headNow() ?? "" }, asks = ai?.asks ?? [];
    if (kind === "verify") {
      const list = this.checkList(), text = verifyContextMd(list, { ...base, ai, statusOf, threats: ai?.threats ?? this.find.runs?.security?.threats ?? null });
      if (!list.length) return;
      copyText(text);
      this.note = `The context to check ${list.length === 1 ? "the open finding" : `${list.length} unresolved security findings`} is on the clipboard as Markdown (${text.trim().split("\n").length} lines), nothing was posted.`;
      return;
    }
    this.mdPrev = this.mdPrev ? null : { off: new Set(), code: true, texts: {} }; // the preview first: what goes into the text, and how much
  },
  // The Markdown of what the person looks at (views.js mdTarget), whole and unfolded, as the page's own sources give
  // it; code: with the code blocks of the places it names (from the diff and the files this review has loaded).
  mdText(code = true) {
    const ai = this.ai, findings = this.findings(), statusOf = (f) => this.fstatus(f), asks = ai?.asks ?? [];
    const base = { pr: this.prSel, head: this.headNow() ?? "", code: code ? this.mdCode() : null, moreOf: (f) => this.mdMore(f) };
    const m = this.mdNow(), layer = this.steps()[this.cur], one = this.findingById(this.ffocus);
    const rows = this.mergeRows();
    return { finding: () => findingMd(one, { ...base, status: statusOf(one), asks, stepsOf: (f) => findingSteps(f, this.find.status[f.id], { report: this.find.reports[f.id], facts: this.fixFacts(f) }) }),
      findings: () => findingsMd(findings, { ...base, statusOf, asks, notes: this.openSugs(), sources: this.findingSources().map((x) => x.text) }),
      layer: () => layerMd(layer, { ...base, n: this.cur + 1, files: this.filesOf(layer), findings: this.layerFindings(layer), statusOf, open: this.openFindings(), deps: this.stepDeps(layer).map(([d]) => plain(d.title)),
        access: layerAccess(ai?.access, this.filesOf(layer))?.text ?? null, hunks: this.present(layer).map((id) => this.byId.get(id)).filter(Boolean).map((h) => ({ path: h.path, rows: h.rows })) }),
      arch: () => architectureMd({ ...base, ai, findings, statusOf, impact: this.impactNow(), infra: this.exMode ? null : this.infra, schema: this.schemaNow(), layersOf: (n) => this.cardLayerList(n).map((s) => plain(s.title)),
        placesIn: (path) => [...(this.fileHunks ?? new Map())].filter(([p]) => p === path || p.endsWith(`/${path}`) || path.endsWith(`/${p}`)).flatMap(([, h]) => h).length }),
      blast: () => securityMd({ ...base, ai, findings, statusOf, runs: this.find.runs, eff: ai?.arch ? this.effZones(ai.arch) : null, extra: this.secExtra(crossingsOf({ arch: ai?.arch ?? null, access: ai?.access ?? [], threats: ai?.threats ?? [], gates: ai?.gates ?? [], bypasses: ai?.bypasses ?? [], findings: this.openFindings() })) }),
      res: () => resilienceMd({ ...base, res: this.resNow(), arch: ai?.arch ?? null, names: new Map((ai?.arch?.nodes ?? []).map((n) => [n.id, n.label ?? n.id])), findings, statusOf, probes: this.resNow() ? this.probesNow() : null,
        cost: this.resNow()?.cost ?? this.find.runs?.resilience?.cost ?? null }),
      overview: () => overviewMd({ ...base, ai, findings, statusOf, checks: this.checksNow(), related: this.ctx, verdict: this.prSel ? this.verdictNow() : null, action: verdictAction(rows), rows,
        nc: notChecked({ ai, runs: this.find.runs, open: this.openFindings() }), resLine: this.resLine(), cost: this.costNow() || null, funnel: funnel(findings, statusOf),
        size: (this.patch ?? []).length ? `${this.patch.length} ${this.patch.length === 1 ? "file" : "files"} +${this.patch.reduce((n, f) => n + (f.add ?? 0), 0)} −${this.patch.reduce((n, f) => n + (f.del ?? 0), 0)}` : null,
        flow: (ai?.visuals ?? []).find((v) => v.kind === "flow" && this.openFindings().some((f) => f.breaks?.node || f.breaks?.from)) ?? null }) }[m.kind]();
  },
  // The code of a file as the review holds it: its diff rows, with the whole file where it is loaded; by the end of a
  // path too ("mailer.py:14"). Nothing is fetched for it.
  mdCode() {
    const paths = (this.patch ?? []).map((f) => f.path), known = [...new Set([...paths, ...Object.keys(this.full ?? {}).filter((k) => Array.isArray(this.full[k]))])];
    return (file) => { const hit = known.includes(file) ? file : known.filter((p) => p.endsWith(`/${file}`)); const path = Array.isArray(hit) ? (hit.length === 1 ? hit[0] : null) : hit; return path ? { path, rows: this.rowsFor(path, true) } : null; };
  },
  // What the view knows about a finding beyond its own fields: its layer, and what is known about its fix.
  mdMore(f) { const li = this.layerOf(f); return [li >= 0 && ["Layer", `${li + 1}. ${plain(this.steps()[li]?.title)}`], ...this.fixFacts(f)].filter(Boolean); },
  // The preview's text: whole, or without the code blocks; built once per choice while the preview is open.
  // A part left out is remembered by its title (the code context adds parts of its own).
  mdShown(code = this.mdPrev.code) {
    const p = this.mdPrev, at = `${this.mdNow().kind}|${this.cur}|${this.ffocus}`, k = code ? "code" : "plain";
    if (p.at !== at) { p.at = at; p.texts = {}; p.off = new Set(); }
    return (p.texts[k] ??= mdParts(this.mdText(code)));
  },
  mdOff(doc = this.mdShown()) { return new Set(doc.parts.map((x, k) => (this.mdPrev.off.has(x.title) ? k : -1)).filter((k) => k >= 0)); },
  // "Copy" in the preview: the chosen parts go to the clipboard, the footer says what and how much.
  mdCopy() {
    if (!this.mdPrev) return;
    const m = this.mdNow(), doc = this.mdShown(), off = this.mdOff(doc), text = mdJoin(doc, off), left = off.size, cs = codeStats(text);
    copyText(text);
    this.note = `Copied ${m.name} as Markdown (${mdLines(text)} lines${left ? `, ${doc.parts.length - left} of ${doc.parts.length} sections` : ""}${cs.blocks ? `, ${cs.blocks} code ${cs.blocks === 1 ? "block" : "blocks"}` : ""}) to the clipboard. Nothing was posted.`;
    this.mdPrev = null;
  },
  // The preview before copying: every section of the text with its size and a tick to leave it out, the code context
  // as one choice of its own, the size of what is chosen, the first lines as they will be copied, then Copy.
  mdPopover(t) {
    const m = this.mdNow(), p = this.mdPrev, doc = this.mdShown(), off = this.mdOff(doc), text = mdJoin(doc, off), lines = text.trim().split("\n"), total = mdLines(text);
    const cs = codeStats(mdJoin(this.mdShown(true))), box = (on) => div().w(16).flex_none().text_color(on ? t.accent : t.muted).child(on ? "☑" : "☐");
    const row = (id, on, label, size, click, tip) => h_flex().id(id).tooltip(tip).gap(8).px(6).h(24).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(click)
      .child(box(on)).child(div().flex_1().min_w(0).truncate().text_color(on ? t.foreground : t.muted).child(label)).child(div().flex_none().text_size(TYPE.small).text_color(t.muted).child(size));
    // In a frame as wide as the pane at most (a narrow window: the preview shrinks with it and never leaves the pane).
    return div().id("rv-mdprev-frame").absolute().top(8).bottom(8).right(0).w(664).max_w_full().px(12).child(v_flex().id("rv-mdprev").w_full().max_h_full().overflow_y_scroll().p(14).gap(10).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .text_size(TYPE.body).text_color(t.foreground).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().gap(8).items_center().child(div().flex_1().font_semibold().text_size(TYPE.title).child(`Copy ${m.name} as Markdown`))
        .child(pill("rv-mdprev-x", t, "✕", (_e, cx) => { this.mdPrev = null; cx.notify(); }).tooltip("Close without copying").accessibility_label("Close")))
      .child(div().text_size(TYPE.small).line_height(1.5).text_color(t.muted).whitespace_normal().child("Everything the page shows, also what is folded there, with every picture as Mermaid. It goes to the clipboard only; nothing is posted. Untick a section to leave it out."))
      .child(v_flex().gap(1)
        // The head is always in the text: no box, no pointer, no hover, so it does not look like a choice. Its size with
        // the line that names what is left out, so the sizes above the foot add up to the foot's.
        .child(h_flex().id("rv-mdprev-head").tooltip("The PR, the commit and the page's first lines. They are always in the text.").gap(8).px(6).h(24).items_center()
          .child(div().w(16).flex_none()).child(div().flex_1().min_w(0).truncate().child("Title and summary")).child(div().flex_none().text_size(TYPE.small).text_color(t.muted).child(`always in the text · ${mdLines(mdHead(doc, off))} lines`)))
        .children(doc.parts.map((x, k) => row(`rv-mdprev-p${k}`, !off.has(k), x.title, `${x.n} ${x.n === 1 ? "line" : "lines"}`, (_e, cx) => { if (!p.off.delete(x.title)) p.off.add(x.title); cx.notify(); }, off.has(k) ? "Left out. Click to put it back in" : "In the text. Click to leave it out")))
        .when(cs.blocks > 0, (e) => e.child(row("rv-mdprev-code", p.code, `Code context (${cs.blocks} ${cs.blocks === 1 ? "block" : "blocks"}, ${cs.lines} lines)`, "inside the sections above",
          (_e, cx) => { p.code = !p.code; cx.notify(); }, "The lines each place names, from the diff with + and − marks, at most 12 lines a place, each place once. Click to leave the code out or put it in"))))
      .child(div().id("rv-mdprev-first").p(8).rounded(6).border_1().border_color(t.border).bg(t.background).font_family(settings().font_family ?? "JetBrains Mono").text_size(TYPE.small).line_height(1.5).text_color(t.muted)
        .children(lines.slice(0, 14).map((l) => div().truncate().child(l || " "))).when(lines.length > 14, (e) => e.child(div().text_color(t.dim).child(`… ${total - mdLines(lines.slice(0, 14))} more lines`))))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(TYPE.small).text_color(t.muted).child(`${total} lines · ${doc.parts.length - off.size} of ${doc.parts.length} sections${p.code && cs.blocks ? ` · ${codeStats(text).blocks} code blocks` : ""}`))
        .child(pill("rv-mdprev-cancel", t, "Cancel", (_e, cx) => { this.mdPrev = null; cx.notify(); }).tooltip("Close without copying"))
        .child(pill("rv-mdprev-copy", t, "Copy", (_e, cx) => { this.mdCopy(); cx.notify(); }, true, t.foreground).tooltip("Copy the chosen sections to the clipboard as Markdown"))));
  },
  // What Copy as Markdown copies where the person is (views.js mdTarget): the open finding or the unresolved ones on
  // the Findings tab, the open layer of the analysis, the page shown, else the Overview.
  mdNow() {
    const layer = this.tab === "steps" && !this.page ? this.steps()[this.cur] : null;
    return mdTarget({ tab: this.tab, page: this.page, layer: layer && !layer.pseudo ? plain(layer.title) : null, finding: Boolean(this.tab === "findings" && this.ffocus && this.findingById(this.ffocus)) });
  },
  // The button for it, at the right end of the head of every page it can copy: a button to see (raised, its text in
  // the foreground). It opens the preview (what goes into the text and how much), which has Copy.
  mdButton(t, id = "rv-md") { return pill(id, t, "⧉ Copy as Markdown…", (_e, cx) => { this.copyMd(); cx.notify(); }, Boolean(this.mdPrev), t.foreground).bg(t.raised).tooltip(this.mdNow().tip).accessibility_label("Copy this page as Markdown"); },
  // What "Copy context to check findings" is about: the finding open in the Findings tab, else on the Security page
  // the unresolved security findings; [] elsewhere (the menu leaves the entry out).
  checkList() {
    const one = this.tab === "findings" && this.ffocus ? this.findingById(this.ffocus) : null;
    return one ? [one] : this.tab === "steps" && this.page === "blast" ? this.findings().filter((f) => f.security && OPEN_ST.includes(this.fstatus(f))) : [];
  },

  // ---- Verify with an agent: the way of Fix (a preview, then a sub-agent in its own worktree at the PR head that never
  // pushes), but the agent tries to show or refute findings, with the review's context (markdown.js verifyContextMd) and
  // a small test or command as evidence. Its answer file in its worktree (threads.js VERIFY_FILE) is read every 10 s
  // (proofTick); the result goes into the status map as status[id].proof (pr.js withProof), then the worktree goes.

  secOpen() { return this.findings().filter((f) => f.security && OPEN_ST.includes(this.fstatus(f))); },
  // Its button: "Verify with an agent…", "Verifying…" (shows the agent) while one runs, "Verify again…" after a result.
  verifyPill(f, t, id = "rv-fvf") {
    const p = f.proof;
    if (p?.state === "running") return pill(`${id}-${f.id}`, t, "Verifying…", () => this.goFix(p)).tooltip(`An agent checks this finding on ${p.branch}; click to show its terminal`);
    return pill(`${id}-${f.id}`, t, p ? "Verify again…" : "Verify with an agent…", (_e, cx) => this.verifyAgent([f], cx))
      .tooltip("An agent in its own checkout of the PR head tries to show or refute this finding, with a small test or command. It can run the PR's code there and never pushes. A preview first.");
  },
  verifyAgent(list, cx) {
    list = (list ?? []).filter(Boolean);
    if (!list.length || !this.prSel) return;
    const ids = list.map((f) => f.id), branch = TH.verifyBranch(this.prSel.number, ids), repo = this.prSel.repo, base = this.fixBase();
    cx.spawn(async (cx) => {
      const path = TH.fixPath(await this.wtDir(), repo, branch);
      const at = base ? (await exec("git", ["-C", base, "rev-parse", "HEAD"], { timeout: 20000 }).catch(() => null))?.stdout?.trim() || null : null;
      const head = TH.fixStart({ local: Boolean(this.worktree?.local), prHead: this.headNow(), checkoutHead: at });
      const context = verifyContextMd(list, { pr: this.prSel, head: head ?? "", ai: this.ai, statusOf: (f) => this.fstatus(f), threats: this.ai?.threats ?? this.find.runs?.security?.threats ?? null });
      this.previewSend(cx, { what: "Verify with an agent", own: list.map((f) => `${f.title} (${f.file}:${f.line})`).join("\n"), ownLabel: list.length === 1 ? "FINDING" : "FINDINGS",
        prompt: TH.verifyPrompt({ pr: this.pr, head, list, path, branch, context, lang: this.lang() }) });
      this.sendP.verify = { ids, branch, path, head };
    });
  },
  // A new Claude in a fresh worktree on the verify branch at the PR head; the findings are marked as being checked.
  // Someone else's PR: manual mode with the user's settings only (threads.js permissionArgs), as for a fix agent.
  startVerify(p, text, cx) {
    const v = p.verify, base = this.fixBase(), trusted = this.trustedPr(), n = v.ids.length;
    if (!base) { this.note = "Not started: the PR has no local checkout to make the agent's checkout from"; return cx.notify(); }
    this.sending = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const lock = await this.pushLock(base), { git, head } = await this.addWorktree(base, v);
        const id = Date.now().toString(36), { agent } = this.sendAgent();
        const r = await hc(TH.subAgentArgs({ parent: agent?.address ?? null, cwd: v.path, name: `verify-${id}`, env: this.ctxEnv(this.ctxId()), task: text, job: id, auto: trusted, model: model(), kind: "verify", deny: TH.NO_NET, lock }));
        if (r.code !== 0) { await git(["worktree", "remove", "--force", v.path]); await git(["branch", "-D", v.branch]); throw new Error((r.stderr || r.stdout).trim().slice(0, 200)); }
        const proof = { state: "running", job: id, ids: v.ids, path: v.path, branch: v.branch, base, terminal: JSON.parse(r.stdout).address, head, at: Date.now() };
        this.writeStatus(cx, (st) => ({ ...st, ...Object.fromEntries(v.ids.map((k) => [k, { ...st[k], proof }])) }));
        this.note = `Verify started: an agent checks ${n === 1 ? "the finding" : `${n} findings`} on ${v.branch} in its own checkout. The results appear at the ${n === 1 ? "finding" : "findings"}; nothing goes to the PR.`;
      } catch (e) { this.note = `Not started: ${String(e).replace(/^Error: /, "")}`; }
      finally { this.sending = false; cx.notify(); }
    });
  },
  // A running check is over once its file has a line for every finding, or once its agent is gone (not before a
  // minute: the terminal list may not have it yet). Then: the results into the status map, the agent, worktree and
  // branch removed (the evidence is kept as text), and a note with the count.
  proofTick(cx) {
    const jobs = new Map(Object.values(this.find.status ?? {}).filter((x) => x?.proof?.state === "running").map((x) => [x.proof.job, x.proof]));
    for (const p of jobs.values()) cx.spawn(async (cx) => {
      const text = await readTextFile(`${p.path}/${TH.VERIFY_FILE}`).catch(() => "");
      const all = terminals(), gone = all.length > 0 && Date.now() - p.at > 60000 && !all.some((x) => x.address === p.terminal && x.state === "live");
      const out = TH.proofOutcome(p.ids, TH.parseProof(text, p.ids), { ended: gone, head: p.head });
      if (!out || this.find.status[p.ids[0]]?.proof?.job !== p.job) return;
      this.writeStatus(cx, (st) => ({ ...st, ...Object.fromEntries(Object.entries(out).map(([k, x]) => [k, { ...st[k], proof: x }])) }));
      if (p.terminal) run("terminal.kill", { terminal: p.terminal });
      const git = (args) => exec("git", ["-C", p.base, ...args], { timeout: 60000 });
      await git(["worktree", "remove", "--force", p.path]); await git(["branch", "-D", p.branch]);
      const said = Object.values(out).map((x) => x.result);
      this.note = `Verify done: ${TH.PROOF_RESULTS.map((k) => [k, said.filter((x) => x === k).length]).filter(([, c]) => c).map(([k, c]) => `${c} ${PROOF_WORDS[k].toLowerCase()}`).join(", ")}. A reproduced finding is now confirmed; a refuted one only suggests Dismiss.`;
      cx.notify();
    });
  },
  // A worktree on a new branch at the PR head the preview named (the head may not be in this clone yet: fetched).
  async addWorktree(base, { branch, path, head: at = null }) {
    const git = (args) => exec("git", ["-C", base, ...args], { timeout: 60000 });
    const head = at ?? (await git(["rev-parse", "HEAD"])).stdout.trim();
    if (!head) throw new Error(`${base} is not a git checkout`);
    if ((await git(["cat-file", "-e", `${head}^{commit}`])).code !== 0 && this.prSel?.number) await git(["fetch", "--quiet", "origin", `pull/${this.prSel.number}/head`]);
    await exec("mkdir", ["-p", path.replace(/\/[^/]+$/, "")]).catch(() => null);
    const w = await git(["worktree", "add", "-b", branch, path, head]);
    if (w.code !== 0) throw new Error(w.stderr.trim().slice(0, 200));
    return { git, head };
  },

  // ---- Probes (Resilience): one suspected failure shown by a small script that runs the PR's code, in a sandbox
  // (probe.py) and through a verify agent of the kind "probe" (threads.js probeArgs) in its own worktree at the PR head.
  // State per probe in deep.json (`probes["<PR url>|<id>"]`): running {job, path, branch, base, head, terminal, at},
  // then done (threads.js probeOutcome). Before it starts it asks, as a state of the probe (probeAsk), not as a popup:
  // for someone else's PR, and for every PR when this machine has no sandbox (probe.py barrier: none).

  probeKey(id) { return `${this.deepKey()}|${id}`; },
  probeRunner() { return `${appHome()}/mods/pr-review/probe.py`; },
  // The run's probes: the derived view (pr.js withResilience), else the findings file's raw block.
  probeList() { return this.ai?.resilience?.probes ?? this.find?.resilience?.probes ?? []; },
  // Why a probe asks before it starts, or null: someone else's PR, or no network barrier on this machine.
  probeNeeds() { return TH.probeNeedsText({ barrier: this.probeBarrier ?? "none", trusted: this.trustedPr() }); },
  // A probe as the view reads it: the run's entry with status proposed | confirm | running | done, and when done the
  // runner's result (result: reproduced | not_reproduced | script_failed, number: the one line, base, pre_existing,
  // strength, head, ms, script, output, reason, network_barrier); older: run on another head than the PR's now.
  probeView(p) {
    const s = this.deep.probes?.[this.probeKey(p.id)] ?? null, done = s?.state === "done";
    return { ...p, status: s?.state === "running" ? "running" : this.probeAsk === p.id ? "confirm" : done ? "done" : "proposed", needs: this.probeNeeds(), barrier: this.probeBarrier ?? null,
      ...(done ? { result: s.status, number: s.line, base: s.base, pre_existing: s.pre_existing, strength: s.strength ?? p.strength, head: s.head, ms: s.ms, script: s.script, output: s.output,
        reason: s.reason, network_barrier: s.network_barrier, at: s.at } : {}),
      older: Boolean(done && s.head && this.headNow() && s.head !== this.headNow()), terminal: s?.state === "running" ? s.terminal : null };
  },
  probesNow() { return this.probeList().map((p) => this.probeView(p)); },
  // probe:<id> → asks first when it needs to (the view shows the sentence and a button that sends probe:<id>:yes),
  // else starts; probe:<id>:no drops the question.
  probeCmd(arg, cx) {
    const [id, answer] = String(arg ?? "").split(":"), p = this.probeList().find((x) => x.id === id);
    try { TH.probeId(id); } catch (e) { this.note = e.message; return cx.notify(); } // the id goes into a file name, a branch and write rules
    if (answer === "no") { this.probeAsk = null; return cx.notify(); }
    if (!p || !this.prSel) { this.note = `No probe ${id} in the resilience run of this PR.`; return cx.notify(); }
    if (this.deep.probes?.[this.probeKey(id)]?.state === "running") return;
    cx.spawn(async (cx) => {
      if (this.probeBarrier === undefined) this.probeBarrier = (await exec("python3", [this.probeRunner(), "--barrier"], { timeout: 20000 }).catch(() => null))?.stdout?.trim() || "none";
      if (this.probeNeeds() && answer !== "yes") { this.probeAsk = id; return cx.notify(); }
      this.probeAsk = null;
      this.startProbe(p, cx);
    });
  },
  // A worktree on probe/<n>-<id> at the PR head, the agent in it; the base commit for the runner's second run is the
  // merge base with the PR's base branch.
  startProbe(p, cx) {
    const base = this.fixBase();
    if (!base) { this.note = "Not started: the PR has no local checkout to make the probe's checkout from"; return cx.notify(); }
    const branch = TH.probeBranch(this.prSel.number, p.id), repo = this.prSel.repo, key = this.probeKey(p.id); // one branch per start
    this.updateDeep(cx, (d) => ({ ...d, probes: { ...(d.probes ?? {}), [key]: { state: "running", at: Date.now() } } }));
    cx.notify();
    cx.spawn(async (cx) => {
      const git = (args) => exec("git", ["-C", base, ...args], { timeout: 60000 }), path = TH.fixPath(await this.wtDir(), repo, branch);
      try {
        await git(["worktree", "prune"]); // worktrees of starts that were cut off (their folders are gone)
        const { head } = await this.addWorktree(base, { branch, path, head: this.headNow() });
        // The two places the agent may write are made new: whatever the PR checked in there (a link out of the
        // checkout that a write would follow, a script of its own) is gone before the agent starts. It has no shell to make a link.
        const fresh = await exec("sh", TH.probeFresh(path));
        if (fresh.code !== 0) throw new Error(`the probe folder could not be made: ${String(fresh.stderr).trim().slice(0, 160)}`);
        const mb = this.prSel.base ? (await git(["merge-base", head, `origin/${this.prSel.base}`]).catch(() => null))?.stdout?.trim() || null : null;
        const path_ = (this.ai?.resilience?.paths ?? this.find?.resilience?.paths ?? []).find((x) => x.id === p.of);
        const findings = this.findings().filter((f) => (path_?.findings ?? p.findings ?? []).some((x) => f.ids.includes(x)));
        const context = findings.length ? verifyContextMd(findings, { pr: this.prSel, head, ai: this.ai, statusOf: (f) => this.fstatus(f), threats: this.ai?.threats ?? null }) : "";
        const task = TH.probePrompt({ pr: this.pr, head, probe: { ...p, signal: p.signal ?? path_?.signal ?? (path_?.visible === false ? "none" : null) }, path, context, lang: this.lang() });
        const job = Date.now().toString(36), { agent } = this.sendAgent();
        const r = await hc(TH.probeArgs({ parent: agent?.address ?? null, cwd: path, name: `probe-${p.id}-${job}`, env: this.ctxEnv(this.ctxId()), task, job, model: codeModel(model()), id: p.id }));
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 200));
        this.updateDeep(cx, (d) => ({ ...d, probes: { ...(d.probes ?? {}), [key]: { state: "running", job, path, branch, base, head, mb, terminal: JSON.parse(r.stdout).address, at: Date.now() } } }));
        this.note = `Probe ${p.id} started: an agent writes a small script on ${branch}; the review then runs it in a sandbox. Nothing goes to the PR.`;
      } catch (e) {
        await git(["worktree", "remove", "--force", path]).catch(() => null); await git(["branch", "-D", branch]).catch(() => null);
        this.updateDeep(cx, (d) => { const probes = { ...(d.probes ?? {}) }; delete probes[key]; return { ...d, probes }; });
        this.note = `Probe not started: ${String(e).replace(/^Error: /, "")}`;
      }
      cx.notify();
    });
  },
  // A running probe: once the agent is done (its answer line, or its turn over for a minute, or its terminal gone, or
  // after 15 minutes at the latest), the review runs the script itself through probe.py (head and the merge base),
  // then keeps the result in deep.json and removes the agent, its worktree and its branch, also when something on the
  // way fails. A start that never got its worktree is dropped after 10 minutes.
  probeTick(cx) {
    for (const [key, p] of Object.entries(this.deep.probes ?? {})) {
      if (p?.state !== "running" || (this.probeBusy ??= new Set()).has(key)) continue;
      if (!p.path) {
        if (Date.now() - (p.at ?? 0) > 600000) this.updateDeep(cx, (d) => { const probes = { ...(d.probes ?? {}) }; delete probes[key]; return { ...d, probes }; });
        continue;
      }
      const id = key.slice(key.lastIndexOf("|") + 1);
      if (!TH.PROBE_ID.test(id)) continue; // never into a path or the runner's argv
      cx.spawn(async (cx) => {
        // The answer file was made new at the start (TH.probeFresh) and the agent has no shell: no link can be there.
        const answer = TH.parseProbeAnswer(await readTextFile(`${p.path}/${TH.VERIFY_FILE}`).catch(() => ""), id);
        const all = terminals(), t = all.find((x) => x.address === p.terminal), late = Date.now() - p.at;
        const ended = Boolean(answer) || late > 900000 || (all.length > 0 && late > 60000 && (!t || t.state !== "live" || (t.status?.state ?? t.status) === "done"));
        if (!ended || this.probeBusy.has(key) || this.deep.probes?.[key]?.job !== p.job) return;
        this.probeBusy.add(key);
        const git = (args) => exec("git", ["-C", p.base, ...args], { timeout: 60000 }).catch(() => null);
        try {
          if (p.terminal) run("terminal.kill", { terminal: p.terminal });
          // Script and result only as the runner prints them (TH.probeRan): it opens the script without following a
          // link and refuses anything but a plain file in the probe folder. The review reads neither file itself.
          const ran = TH.probeRan(await exec("python3", [this.probeRunner(), p.path, id, ...(p.mb ? ["--base", p.mb] : [])], { timeout: 120000 }).catch(() => null));
          const out = TH.probeOutcome(id, { ...ran, answer });
          this.updateDeep(cx, (d) => ({ ...d, probes: { ...(d.probes ?? {}), [key]: { ...out, branch: p.branch } } }));
          this.note = `Probe ${id}: ${out.status.replace("_", " ")}${out.line ? `, ${out.line}` : ""}.`;
        } finally {
          await git(["worktree", "remove", "--force", p.path]); await git(["branch", "-D", p.branch]);
          this.probeBusy.delete(key);
          cx.notify();
        }
      });
    }
  },

  // Progress that could not be saved: what that means, and the one thing to do about it.
  saveErrBar(t) {
    const why = /changed outside/i.test(this.saveErr) ? "the progress file changed while it was written" : this.saveErr;
    return h_flex().id("rv-save-err").flex_none().px(14).py(8).gap(10).items_center().border_t(1).border_color(t.border).bg(t.ansi1 + "26").text_size(TYPE.small)
      .child(div().flex_1().min_w(0).whitespace_normal().child(`Could not save your progress (viewed files, checked layers, your place): ${why}. It is kept in this window; it is lost if you close the review before it is saved.`))
      .child(pill("rv-save-again", t, "Save again", (_e, cx) => this.saveProgress(cx), false, t.foreground).tooltip("Write your progress to disk again"));
  },

  // While the review is open: the PR's head and its GitHub review comments, at most every GH_MS and only while the
  // window is in front (nobody reads it behind other windows; the next minute's tick catches up once it is). A failure
  // waits twice as long each time (pr.js pollDue). force: the Overview's ↻, CI checks and related PRs too. A new head
  // reloads the diff (checkHead's path), and with it the review's hunks (main.js syncSource).
  ghTick(cx, force = false) {
    const pr = this.prSel;
    if (!pr?.url || this.ghBusy || (!force && (!windowActive() || !pollDue(this.ghPoll, Date.now(), GH_MS)))) return;
    this.ghBusy = true;
    if (force) this.loadContext(cx, true);
    cx.spawn(async (cx) => {
      // The head as just asked (the panel, or this review's own load): not asked again within GH_MS, except by ↻.
      const seen = this.heads.get(pr.url), known = !force && seen?.sha && Date.now() - seen.at < GH_MS ? seen.sha : null;
      const [gh, sha] = await Promise.all([this.ghComments(), known ?? (pr.url.startsWith("https://") ? this.headOf(pr.url) : null)]);
      this.ghBusy = false;
      this.ghPoll = pollAfter(this.ghPoll, gh !== false && (sha !== null || !pr.url.startsWith("https://")), Date.now());
      if (this.prSel?.url !== pr.url) return;
      // A frame only for something new (a frame of the review redraws the whole window): the same comments again
      // keep the list they are in, and loadThreads draws when its files changed.
      const fresh = Boolean(gh) && JSON.stringify(gh) !== JSON.stringify(this.gh);
      if (fresh) this.gh = gh;
      await this.loadThreads(cx);
      if (sha && !known) this.heads.set(pr.url, { at: Date.now(), sha });
      if (sha && sha !== this.prSel.headSha) { this.prSel = { ...this.prSel, headSha: sha }; this.refresh(cx, true); }
      if (fresh || force) cx.notify();
    });
    if (force) cx.notify();
  },
  // The Overview's "GitHub read … ago ↻": how old the GitHub facts on this page are (CI checks, mergeability, related PRs),
  // and the way to fetch them again, instead of asking GitHub on a timer.
  freshFact(fact) {
    const busy = Boolean(this.ctxIn), at = Date.parse(this.ctx.at);
    const label = busy ? "Reading GitHub…" : Date.now() - at < 60000 ? "GitHub read just now ↻" : `GitHub read ${ago(this.ctx.at)} ↻`; // it names what is as old as it says
    return fact("rv-ov-fresh", label, "When CI checks, mergeability and related PRs were read from GitHub. New commits and review comments are checked every 5 minutes while this window is in front. Click to read all of it again now.",
      busy ? null : (_e, cx) => { this.ghTick(cx, true); cx.stop_propagation(); });
  },

  // ---- "Open in <Editor>" in the review (editor-view.js; main.js checkoutRoot, editorForeign, openEditor)
  // A file head's target: the file in the review's checkout at the topmost line of it the list shows (else its first
  // changed line). Null without a checkout, for a file the PR deletes and for a symlink the PR adds or changes.
  fileEditTarget(f) {
    const root = this.checkoutRoot();
    if (!root || f.status === "deleted" || patchSymlink(f.lines)) return null;
    const seen = (this.items ?? []).slice(this.vis?.start ?? 0, this.vis?.end ?? 0).find((it) => it.t === "row" && it.path === f.path && it.src?.[it.ri]?.n);
    const line = seen?.src[seen.ri].n ?? (this.shown().fileHunks?.get(f.path)?.[0]?.rows ?? []).find((r) => r.kind === "+" && r.n)?.n ?? null;
    return { root, file: f.path, line, foreign: this.editorForeign(), where: "in the checkout of this PR" };
  },
  fileEditMark(f) { const target = this.edOn ? this.fileEditTarget(f) : null; return target ? editorMark(target, null) : null; },
  // The monogram next to a place that jumps inside the mod ("file:line"): the same line in the person's editor.
  // Nothing without a checkout or an editor.
  editAt(t, id, at) {
    const root = this.checkoutRoot(), place = placeOf(at);
    return root && this.edOn && place ? editorLink(this, t, id, { root, ...place, foreign: this.editorForeign(), where: "in the checkout of this PR" }, null, true) : [];
  },

  // ---- fix worktrees left on disk (<Herdr's worktrees folder>/<repo>/fix-…): nothing removes them by age, because one may
  // hold a fix that exists nowhere else. "Fix worktrees…" lists them with what would be lost; a click removes one,
  // and one with commits or changes only there asks for a second click.
  listWorktrees(cx, at = null) {
    const base = this.fixBase();
    if (!base) { this.note = "This PR has no local checkout, so there are no fix worktrees to list."; return cx.notify(); }
    const git = (cwd, args) => exec("git", ["-C", cwd, ...args], { timeout: 30000 }).catch(() => ({ code: 1, stdout: "" }));
    cx.spawn(async (cx) => {
      const list = TH.leftWorktrees((await git(base, ["worktree", "list", "--porcelain"])).stdout, [...new Set([await this.wtDir(), `${home()}/.herdr/worktrees`])], this.prSel?.repo);
      this.wts = await Promise.all(list.map(async (w) => {
        // Commits of its branch that no other branch, tag or remote has (not --all: that counts this worktree's own
        // HEAD as a ref, and nothing would ever be "only there"); changes not committed.
        const [only, st] = await Promise.all([git(base, ["rev-list", "--count", w.branch, "--not", `--exclude=${w.branch}`, "--branches", "--tags", "--remotes"]), git(w.path, ["--no-optional-locks", "status", "--porcelain"])]);
        return { ...w, only: Number(only.stdout.trim()) || 0, dirty: st.stdout.trim().length > 0, unknown: only.code !== 0 || st.code !== 0 };
      }));
      if (!this.wts.length) this.note = "No fix worktrees are left on disk for this repository.";
      else openOverlay({ mod: "pr-review", props: { part: "cmenu", key: "wt", items: this.wts.map((w, k) => [TH.worktreeLine(w, this.wtAsk === w.path), TH.worktreeRisky(w), `wt-remove:${k}`]) }, kind: "popup", width: 520, height: 12 + 30 * this.wts.length, ...(at ? { at } : {}) });
      cx.notify();
    });
  },
  removeWorktree(k, cx) {
    const w = this.wts?.[k], base = this.fixBase();
    if (!w || !base) return;
    if (TH.worktreeRisky(w) && this.wtAsk !== w.path) {
      this.wtAsk = w.path;
      this.note = `${w.branch} holds work that exists only there. Nothing was removed. Open "Fix worktrees…" again and choose "Remove anyway" to delete it.`;
      return cx.notify();
    }
    this.wtAsk = null;
    const job = this.fixes().find((j) => j.path === w.path && j.state === "running");
    if (job) return this.discardFix(job, cx); // a fix job of this review: its agent ends and its state follows
    cx.spawn(async (cx) => {
      const git = (args) => exec("git", ["-C", base, ...args], { timeout: 60000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      const r = await git(["worktree", "remove", "--force", w.path]);
      if (r.code === 0) await git(["branch", "-D", w.branch]);
      this.note = r.code === 0 ? `Removed ${w.branch} and its worktree.` : `Could not remove ${w.branch}: ${String(r.stderr ?? "").trim().slice(0, 160)}`;
      cx.notify();
    });
  },
};
Object.assign(ReviewMode, ImpactMode);
Object.assign(ReviewMode, SchemaMode);
Object.assign(ReviewMode, SecPicsMode);

const LAYER_FILES = 12; // an open layer lists this many of its files in the left column
// An action in a file's header ("Viewed", "Whole file"): drawn as a button 30 px high (27 pt at the usual 90 % zoom; a
// click target needs 24 pt), so the target is visible; the header row still takes the click over its whole zone.
const fileAct = (t) => h_flex().h(30).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.border).bg(t.background);
// The "Viewed" tick of a file in the left column: a 16 px box, its row is the click target.
function viewedBox(t, seen) {
  return div().w(16).h(16).flex_none().flex().items_center().justify_center().rounded(4).border_1().border_color(seen ? t.ansi2 : t.muted)
    .text_size(TYPE.small).font_semibold().text_color(t.ansi2).child(seen ? "✓" : "");
}

// Who serves a model call of a context and where its login lives: the config folder, never an account's name.
function accountOf(ctx) {
  const env = C.infoOf(ctxDoc(), ctx).env ?? {};
  const via = env.CLAUDE_CODE_USE_BEDROCK ? "Amazon Bedrock" : env.CLAUDE_CODE_USE_VERTEX ? "Google Vertex AI" : "Anthropic";
  return `Claude Code (${via}) · account in ${String(env.CLAUDE_CONFIG_DIR ?? "~/.claude").replace(home(), "~")}`;
}

// A tick box big enough to hit (16 px), drawn: the glyphs ☑ and ☐ are 8 px marks in this font.
function tickBox(t, on) {
  return div().w(16).h(16).flex_none().flex().items_center().justify_center().rounded(4).border_1().border_color(on ? t.accent : t.muted).bg(on ? t.accent : t.background)
    .text_size(TYPE.small).font_semibold().text_color(t.accent_foreground).child(on ? "✓" : "");
}
const DRY_TIP = "Dry run: this installation posts nothing to GitHub. What a post would send is written to a file instead (\"dryRun\": true in pr-review.config.json).";
const PUBLIC_TIP = "This comes from a security finding: once posted, its text is readable by everyone who can see the PR.";

// A tab's help text: under the tab row and after a rest, in a hover card on the tab's label (the card takes no size
// styles, so the tab around it keeps its width). A tooltip there covered the neighbouring tabs' labels, and a
// tooltip's side and delay are not a script's to choose.
function tabTip(id, t, tip, label) {
  return HoverCard.new(`${id}-tip`).anchor("top_center").open_delay(700).trigger(label)
    .content(div().max_w(280).px(10).py(6).rounded(6).border_1().border_color(t.border).bg(t.popover).text_size(TYPE.small).text_color(t.foreground).whitespace_normal().child(tip));
}

// Whether a checkout (a linked worktree: its .git file names the gitdir) is at this commit: two file reads, no git.
async function worktreeAt(path, sha) {
  const dir = /^gitdir: (.+)$/m.exec(await readTextFile(`${path}/.git`).catch(() => null) ?? "")?.[1]?.trim();
  return Boolean(dir) && (await readTextFile(`${dir}/HEAD`).catch(() => null) ?? "").trim() === sha;
}

// The Findings tab and the diff's finding cards (package F): how sure a security finding is, as one word in a line
// that is folded (derived, assumed, confirmed; the open card says it in full).
const CERT_TIP = { confirmed: "Confirmed: something that ran shows it", derived: "Derived: it follows from the code that was read; check it yourself", assumed: "Assumed: it rests on something the reviewer could not check" };
function certaintyWord(t, f, id) {
  // A derived finding whose way in is only assumed says so: its sign beside this word is the dashed one with "?".
  const reach = f?.certainty === "derived" && f.path_certainty === "assumed";
  return f?.security && CERT_TIP[f.certainty] ? div().id(id).tooltip(`${CERT_TIP[f.certainty]}${reach ? ". That an attacker gets there is assumed" : ""}`).flex_none().text_size(TYPE.small).text_color(t.muted).child(reach ? "assumed reachable" : certaintyText(f)) : null;
}
const HL_FRAME = 250; // ms between two frames asked for while the queue of files to color runs
const HL_STALE = 2000; // ms a highlight slice may be busy before it counts as stopped (Herdr stops one after ~50 ms)
// A row's sign (views.js signOf, signEl): the kind's glyph in the color of the highest severity behind the row, on
// a filled ground when that is confirmed, in a dashed frame with "?" when it is only assumed. The column has one
// width, so the titles of a list line up whatever the sign's form.
const SIGN_W = 26, SIGN_PAGE = { security: "blast", resilience: "res" }, PAGE_GLYPH = { security: "⛨", resilience: "↯" };
const rowSign = (t, glyph, fs) => div().w(SIGN_W).flex_none().flex().items_center().child(signEl(div, t, signOf(fs), glyph));
// A finding's "⛨ Security" chip: the sign in the finding's severity color and certainty form, then the word.
const secBadge = (t, f) => { const s = signOf([f]), c = t[s.color] ?? t.ansi1; return h_flex().flex_none().pl(3).pr(6).py(1).gap(3).items_center().rounded(5).bg(c + "26").text_size(TYPE.small).font_semibold().text_color(c).child(signEl(div, t, s, "⛨")).child("Security"); };
// A finding's state as a word only when it is not the usual one: unresolved goes without saying.
const stateWord = (st) => (st === "open" ? null : st === "recheck" ? "line changed" : FSTATUS[st]?.[0] ?? st);

// The note about an action just taken, under the right pane (views.js noteRule): in the text color and gone after a
// few seconds, or, when the action did not happen, in red with a mark and a ✕, kept until closed or the next action.
function noteBar(v, t, cx) {
  const note = v.note, rule = noteRule(note);
  if (rule.ttl && v.noteTimed !== note) { v.noteTimed = note; cx.timer.after(rule.ttl, (cx) => { if (v.note === note) { v.note = null; cx.notify(); } }); }
  return h_flex().flex_none().px(14).py(8).gap(8).items_center().border_t(1).border_color(t.border).text_size(TYPE.small).text_color(rule.error ? t.ansi1 : t.foreground)
    .when(rule.error, (e) => e.child(div().flex_none().child("⚠")))
    .child(div().flex_1().min_w(0).whitespace_normal().child(note))
    .when(rule.error, (e) => e.child(div().id("rv-note-x").tooltip("Close this message").flex_none().px(4).cursor_pointer().text_color(t.muted).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { v.note = null; cx.notify(); }).child("✕")));
}
