// PR review panel: the focused branch's diff against its PR base (or origin's default branch), including
// uncommitted changes, or any PR made from a Claude session (found by prs.py).
// Two states (views.js panelState): picking (no PR chosen yet, or back with ← in the header: reviews in progress,
// three then "Show all", the sources and the list) and a chosen PR or the current branch (its title and actions, then
// Diff or Walkthrough as tabs). Click a line (shift-click: a range): a composer opens under it, GitHub style; Enter
// adds a comment for the pending review, "Ask" sends one question at once. The pending comments show as a count: for
// a PR, "Finish your review" opens the review layout's step of that name (post to GitHub or send to an agent); a
// branch without a PR sends them as one prompt to this space's Claude agent (or a new one). Keys, after clicking the
// diff: j/k change, n/p file, c comment, Esc.
// "Walkthrough": the review layout's AI analysis (review.py) read in reading order; it runs only on a click, there,
// cached in pr-data/cache. UI text is English. "Review": the PR in the review layout (review.js; this mod
// with props {part: "bar" | "review"}). The list shows a triage line per open PR from cached data (pr.js triageOf);
// "Triage PRs" (a click) asks Haiku for the why/priority (triage.py).
// Sources: Mine (session PRs), This repo (the active space's repo, gh pr list), Review requested (gh search
// prs); "Open PR…" takes a URL or owner/repo#123. Their context (optional, from a plug-in: context.js, PROVIDERS.md)
// follows its rules; a picked one is kept in shared "pr.picked" so the selection survives remounts.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, Editor, EditorState, TextView, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { focused, exec, hc, run, theme, settings, readTextFile, writeTextFile, shared, setShared, appHome, home, layout, props, watchFolder, nextCommand, checking } from "herdr";
import { spaces, panes, agents, terminals, feed, whenFed } from "./live.js"; // never straight from Herdr: one read and this copy is drawn on every agent's status change
import { diffRows, buildPrompt, splitPatch, selection, nextChange, lineLabel, anchorRow, buildReview, hunksOf, hash, uiLine, reviewRequest, mapReview, triageOf, isSecurity, withThreats, knownOf } from "./pr.js";
import { parsePrRef, ghTarget, pruneSources, codeModel, windowActive, pollDue, pollAfter, tabName } from "./pr.js";
import * as C from "./context.js";
import { tabArgs } from "./threads.js"; // a new Claude tab with the PR's text: no MCP servers
import { loadDiff, saveDiff } from "./diffcache.js";
import { setupBanner, renderSetup, loadSetup, runSetup, openUrl, readConfig } from "./setup-view.js";
import { chip, PRIORITY_TIP, layoutPump } from "./stack.js";
import { panelState, bodyTab, DONE_DAYS, diffTooLarge, filesToDiff, isOpenPr, byState, listRows, riskSignal, progressText, pendingText, rowMarks, mineGroups, progressRows, removedText, withPick, openSig, panelShown, byRef, fileRisk, leftNow, wrapCode, codeCols, sliceSpans, markLabel, textW, panelButtons, panelHit, panelPress, PANEL_EDGE, spaceFolders, headBranch, spaceBranches, branchPrQuery, branchPrs, spaceOrder, focusedPr, spaceEmpty, worktreePrs } from "./views.js";
import { keepLast, dragPath } from "./views.js"; // every cache has a limit; a file head's path to drag
import { ReviewMode, startReview, startExplore, saveKey, flowCard, modelPills, modelLabel, renderReviews, renderAgentBar, renderKeys, renderCardMenu, renderMini } from "./review.js";
import { highlightJob, highlightStep, langOf, firstLineOf, colors, renderLine, editorSyntax } from "./syntax.js";
import { TYPE } from "./views.js"; // the text sizes (U34)
import { editorLink, editorCommand, startOpen, setEditors } from "./editor-view.js"; // "Open in <Editor>"
import { copyText } from "./setup-view.js";

// Same mapping as the shipped files panel.
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PRESETS = [["Explain", "Explain this change to me: what it does and why."], ["Look up docs", "Look up the docs for the APIs, classes and functions used here and summarize what matters for this spot."]];
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const PRS_MS = 5 * 60 * 1000; // prs.py: transcripts by stamp, open PRs' state from GitHub; only while the list can be seen (scanIfDue)
const PR_INFO_MS = 5 * 60 * 1000; // a branch's PR / a picked PR's head (gh pr view): asked again in the background after this
const TTL_MS = 10 * 60 * 1000; // a remembered context is shown as is (no exec) unless dirty or older than this
const MEMO = 8, WATCHES = 3; // remembered contexts; repos watched at once
const IGNORED = /\/(node_modules|target|dist|build|\.venv|__pycache__)\/|\/\.git\/(?!HEAD$|index$|refs\/)/; // changes that don't make a diff dirty
const cacheDir = () => `${appHome()}/pr-data/cache`;
// The model for walkthroughs and the review analysis: the review layout's picker (shared), Sonnet by default and at
// least Sonnet (pr.js codeModel: an old haiku pick reads as sonnet).
const walkModel = () => { const m = shared("review.model"); return codeModel(typeof m === "string" && m ? m : "sonnet"); }; // as review.js model()
const STATE = { open: "ansi2", draft: "muted", merged: "ansi5", closed: "ansi1" };
const WEIGHT = { key: ["key", "ansi3"], skim: ["skim", "dim"] };
const COVER = { seen: ["done", "ansi2"], partly: ["partly", "ansi3"], absent: ["missing", "ansi1"] };
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const reviews = () => `${appHome()}/pr-data/reviews.json`;
const triageFile = () => `${appHome()}/pr-data/triage.json`; // triage.py's why/priority per PR url (bounded there)
const TRIAGE_MAX = 40; // open PRs triaged in the list
// PR sources (the picking list): your session PRs, the active space's repo, review requests. gh lists are cached per source and
// repo in pr-data/sources.json for SOURCE_MS (↻ asks again), the newest SOURCE_KEEP kept.
const SOURCES = [["mine", "Mine"], ["repo", "This repo"], ["space", "This space"], ["review", "Review requested"]];
const SRC_TIP = { mine: "PRs found in your Claude sessions", repo: "Open PRs in this space's repository", space: "PRs of the branches checked out in this space, in its panes and its agents' worktrees", review: "Open PRs waiting for your review" };
const sourcesFile = () => `${appHome()}/pr-data/sources.json`;
const SOURCE_MS = 3 * 60 * 1000, SOURCE_KEEP = 20, PICKED_KEEP = 20;
const GH_FIELDS = "number,title,author,headRefName,headRefOid,baseRefName,updatedAt,isDraft,reviewDecision,additions,deletions,url";
const REVIEW = { APPROVED: ["approved", "ansi2"], CHANGES_REQUESTED: ["changes requested", "ansi1"], REVIEW_REQUIRED: ["review required", "ansi3"] };
const BRANCH = "branch"; // shared "pr.selected": the current branch was picked (not a PR)
const CMD_STALE = 3000; // ms a command may be running before its loop counts as stopped (listen)
// The panel's diff is a virtual list (as the review's): only the lines on screen are built per frame, so a frame costs
// the same for 200 lines as for 9000. Its cards have no handler of their own (a list's renderer cannot hold one): a
// press is found by its place. views.js panelButtons says each card's buttons, their widths and gap: they are drawn
// from it (diffItem) and hit from it (onDiffItem, panelHit).
const ONE_LINE = [0]; // a line that does not wrap
const DIFF_MAX = 9000; // lines of one file's diff; the list itself holds at most 10000 items
const LINE_H = 20; // a line's height
const FILES_MAX = 200; // files listed at once in the panel; "Show n more files" lists the rest
const HL_STALE = 2000; // ms a highlight slice may be busy before it counts as stopped (Herdr stops one after ~50 ms)
const SEC_MARK = "⛨"; // security's own mark in a PR row (a shield), next to the word
// A PR's head as GitHub last gave it ({at, sha} by url) and the asks under way: one for every copy of the mod (the
// panel, then the review of the same PR), so opening the review does not ask again what the panel just asked.
const HEADS = new Map(), HEAD_ASKS = new Map();
// A folder's repo (git rev-parse: root, git dir, default branch) by folder, for every copy of the mod as well: the
// review of a PR is a new copy each time it opens, and waited for this one command (0.3 s, 0.7 to 2 s on a busy
// machine) before it built anything from the diff it had read from the cache in a few ms.
const REPOS = new Map();
const SIZES = new Map(); // a cached diff's size ({files, lines}) by PR and head, for the list's triage (loadTriage)
const age = (iso) => { const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)); return !Number.isFinite(m) ? "" : m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

// Where the person is: the active space and the folder of the focused pane. From focused() alone when it says both
// (it carries the pane's space and folder, and does not change with an agent's status); else from the spaces and
// panes as live.js has them.
function location() {
  const f = focused();
  if (f?.space && f.cwd) return { cwd: f.cwd, space: f.space };
  const space = spaces().find((s) => s.active), pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, space: f?.space ?? space?.id ?? null };
}

// Contexts (optional, a plug-in's shared "pr-review.contexts"; context.js): a space's, a PR's, whether the view shows it.
const ctxDoc = () => shared(C.CONTEXTS_KEY);
const spaceCtx = (spaceId) => C.spaceContext(ctxDoc(), spaceId);
const prCtx = (pr) => C.prContext(ctxDoc(), pr, home());
const shownIn = (pr) => C.shown(ctxDoc(), prCtx(pr), shared);
// The view's key for remembering the picked PR: the contexts it shows.
const viewKey = () => Object.keys(ctxDoc()?.contexts ?? {}).filter((id) => C.shown(ctxDoc(), id, shared)).join(",") || "all";
// ... and per Herdr space: a PR picked in one space is not shown in another (that one has its own pick, or the list).
const selKey = () => `${viewKey()}@${location().space ?? ""}`;
// A context tag (only with two or more contexts): label in its colour.
export const ctxTag = (t, id, key = null) => div().flex_none().px(5).rounded(4).border_1().border_color(C.colorOf(ctxDoc(), id, t)).text_size(TYPE.micro).text_color(C.colorOf(ctxDoc(), id, t)).when(Boolean(key), (e) => e.id(`ctx-${key}`).tooltip("Context this PR belongs to")).child(C.labelOf(ctxDoc(), id));

// Shown: the layout has this panel's block, not hidden and up in its stack (views.js panelShown), in any layout.
const inView = () => panelShown(layout()) === true;
// Worth loading for: shown, or placed some other way than as a block of the layout (a pane, a window).
const visible = () => panelShown(layout()) !== false;
const Spin = (t, label) => h_flex().gap(6).text_color(t.dim).child(div().child(SPIN[0]).frames(SPIN, 90)).child(label);
// ponytail: a one-shot flip (a transition), not an animation timer.
function dock(view, el, mode, cx, from = 12) {
  if (mode !== view.dockMode) {
    view.dockMode = mode;
    view.dockKey = (view.dockKey ?? 0) + 1;
    view.docked = false;
    cx.timer.after(30, (cx) => { view.docked = true; cx.notify(); });
  }
  return el.id(`dock-${view.dockKey}`).relative().left(view.docked ? 0 : from).opacity(view.docked ? 1 : 0)
    .transition("left", { duration: 180, easing: "ease-out" }).transition("opacity", { duration: 160, easing: "ease-out" });
}

// tip: hover explanation; alt: screen-reader label for a glyph-only pill.
const pill = (id, t, label, click, on = false, tip = "", alt = "") => div().id(id).when(Boolean(tip), (e) => e.tooltip(tip)).when(Boolean(alt), (e) => e.accessibility_label(alt)).flex_none().px(8).h(24).flex().items_center().rounded(5).border_1().border_color(on ? t.accent : t.border).text_size(TYPE.panel)
  .text_color(on ? t.foreground : t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(click).child(label);

// What the Worktrees mod gets (its PROVIDERS.md): the PRs as of now, the contexts they were listed for (view: the
// chip's copy empties a list of another view), and what a click on a mark runs: the wish to pick that PR here.
const wtList = (prs) => ({ at: Date.now(), view: viewKey(), run: [["pr-review.want:{repo}#{number}", {}]], prs });

export default class PrReview extends View {
  init(_props, cx) {
    this.part = props()?.part ?? null;
    this.uid = Math.random().toString(36).slice(2, 8);
    // The minimized chip's copy sits in the main layouts also while the panel does not: it keeps a click on a PR mark
    // of the Worktrees mod ("want:<owner/repo#n>") for the panel (wantPick).
    if (this.part === "mini") this.listen(cx, (c) => { if (c.startsWith("want:")) this.wantPick(c.slice(5)); }, false);
    // A minimized Explore whose run is going: its status file says when it has ended, so the chip can say so.
    if (this.part === "mini") cx.timer.every(5000, (cx) => this.miniPoll(cx));
    if (this.part === "bar" || this.part === "reviews" || this.part === "agentbar" || this.part === "keys" || this.part === "cmenu" || this.part === "mini") return;
    this.announces = true; // Go to's keys: published while this copy runs, cleared in close()
    this.files = []; this.rows = []; this.sel = null; this.selEnd = null; this.question = "";
    this.diffList = VirtualListScrollHandle.new(); // the diff's scroll position, to bring a line into view (scrollRow)
    // this.uid: list/scroll ids must not collide between copies
    this.fh = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Comment or question on this spot… (Enter: add to review)" });
    this.input.on("change", (_e, cx) => { this.question = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.addComment(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.openRefInput = InputState.new({ placeholder: "Open PR… URL or owner/repo#123 (Enter)" });
    this.openRefInput.on("submit", (_e, cx) => this.openRef(cx));
    this.publishGoto();
    this.srcLists = {}; this.slugs = new Map(); this.cfg = {};
    this.prs = []; this.prSel = null; // prSel: a PR from prs.json shown instead of the focused branch
    this.comments = []; this.reviewKey = null; this.editing = null;
    this.view = "diff"; this.walk = null; this.step = 0; this.read = new Set();
    // Speed: every spawn costs 0.3-0.5 s here. Repos and PR info are remembered; memo keeps the last MEMO contexts
    // (diff, open file, selection) so going back to one shows it with no exec; watchFolder marks a repo dirty.
    this.repos = REPOS; this.prInfo = new Map(); this.memo = new Map(); this.dirty = new Set(); this.watching = new Map(); this.heads = HEADS;
    // `herdr-app check` runs init for real (always the panel: a check has no props). What is set above is enough for
    // its one frame: no command loop, no task (setup check, prs.py, prs.lock) and no timer starts there.
    if (checking()) return;
    if (this.part === "review") return this.initReview(cx);
    // The pick from before (shared "pr.selected") is known at once: the list is not drawn (nor fetched) while prs.json
    // is read, and the branch's diff is only made when the branch is what the panel shows.
    // A review just left hands over its PR (shared "pr.fromReview", review.js leave): that one, not the older pick.
    const sel = shared("pr.selected") ?? {}, back = shared("pr.fromReview")?.url, before = back ?? sel[selKey()] ?? sel[viewKey()];
    if (back && shared("pr.listed")) this.picking = true; // the review was opened from the list: the list again
    if (before === BRANCH) this.branchPicked = true; else if (before) this.restoring = !this.picking;
    if (visible() && this.branchPicked) this.refresh(cx);
    // Key commands (keys.json "pr-review.<name>"): picker (the PR list), source:mine|repo|review, merged, setup, walkthrough, review, finish.
    this.listen(cx, (c, cx) => this.panelCommand(c, cx));
    cx.spawn(async (cx) => {
      try {
        await this.loadPrs(cx);
        // The PR picked last in this view survives remounts (layout switch, a recreated block); one you didn't
        // open comes back from shared "pr.picked".
        const from = shared("pr.fromReview");
        if (from) setShared("pr.fromReview", null); // taken once
        const sel = shared("pr.selected") ?? {}, url = from?.url ?? sel[selKey()] ?? sel[viewKey()]; // the view's pick from before picks per space
        this.spaceSeen = location().space;
        if (url === BRANCH && !this.prSel) this.branchPicked = true;
        const pr = url && url !== BRANCH && !this.prSel ? this.prs.find((p) => p.url === url) ?? (from?.url ? from : (shared("pr.picked") ?? {})[url]) : null;
        const listed = Boolean(from?.url && shared("pr.listed"));
        if (shared("pr.listed") !== null && shared("pr.listed") !== undefined) setShared("pr.listed", null); // taken once
        if (pr) this.choose(pr, cx);
        if (listed) { this.picking = true; this.loadSource(cx); } // opened from the list: the list again, the PR behind "Back to #n →"
      } finally { this.restoring = false; cx.notify(); } // a pick that is gone: the list after all
      this.cfg = await readConfig(); setEditors(this.cfg.editors);
      await loadSetup(this, cx);
      // The open reviews as the registry file has them (it outlives shared state edits and format changes).
      const reg = JSON.parse(await readTextFile(`${appHome()}/pr-data/open-reviews.json`).catch(() => null) ?? "null");
      if (Array.isArray(reg) && JSON.stringify(reg.filter((r) => r.status !== "done")) !== JSON.stringify(shared("review.open"))) setShared("review.open", reg.filter((r) => r.status !== "done"));
      this.scanIfDue(cx);
    });
    cx.timer.every(60000, (cx) => this.scanIfDue(cx)); // a time check; prs.py itself at most every PRS_MS
  }

  // A key command or scripted click for the panel (pr-review.<c>).
  panelCommand(c, cx) {
    const [name, arg] = [c.split(":")[0], c.split(":").slice(1).join(":")];
    if (editorCommand(this, c, cx, copyText)) return; // editor:<path>[:<line>], and the ▾ menu's entries
    if (name === "source" && SOURCES.some(([k]) => k === arg)) { this.pickSource(arg); this.picking = true; this.loadSource(cx); }
    else if (c === "picker") { this.picking = !this.picking; if (this.picking) this.loadSource(cx); }
    else if (c === "setup") { this.view = "setup"; runSetup(this, cx, false); }
    else if (c === "setup:close") this.view = "diff"; // Setup's "Close"
    else if (c === "walkthrough") this.openWalk(cx, false);
    else if (c === "review") this.reviewNow(cx);
    // review:<number | owner/repo#number | url>: a row's "Resume" (a review in progress) or "Review" (a listed PR).
    else if (name === "review" && arg) { const r = byRef((shared("review.open") ?? []).filter(shownIn), arg), pr = r ? null : byRef(this.listNow(), arg); if (r) this.toReview(r.target ?? r); else if (pr) this.pickTarget(pr, cx, true); }
    else if (c === "finish") this.finishReview(); // the pending comments' "Finish your review"
    else if (name === "wrap") setShared("review.wrap", arg === "on"); // wrap:on | off, the Diff tab's "Wrap" switch (as in the review)
    else if (c === "discard") this.discardAll(cx); // their "Discard" (asks once: again to delete)
    else if (c === "merged") this.showDone = !this.showDone; // the list's "Merged or closed" row (a toggle)
    else if (c === "other") this.showOther = !this.showOther; // Mine's "Other repos or older" row (a toggle)
    else if (name === "drop") { const r = byRef((shared("review.open") ?? []).filter(shownIn), arg); if (r) this.dropReview(r.url, cx); } // In progress row's ✕: drop:<number | owner/repo#number | url>
    else if (name === "want") this.wantPick(arg); // want:<owner/repo#n | url>: a click on a PR mark in the Worktrees mod (takePick picks it)
    else if (c === "undrop") this.undoDrop(cx); // the "Undo" after it
    else if (c === "progress-all") this.allOpen = !this.allOpen; // In progress: "Show all" / "Show fewer"
    else if (name === "explore") startExplore(arg || null); // pr-review.explore[:<folder>]: a topic in existing code, no PR
    // For keys and scripted demos: a listed PR's row click (pick:<number>, the shown source's list).
    else if (c === "pick:branch") this.choose(null, cx); // the list's "Current branch" row
    // press:<key> or press:<x>,<key>: a click on an item of the diff's list (r<row index>: a line; ask; ca: the composer's
    // buttons; bh<comment id>: a comment's Edit and Delete), x px from the list's left edge for the cards' buttons.
    else if (name === "press" && arg) { const m = /^(\d+),(.+)$/.exec(arg); this.press = { x: m ? Number(m[1]) : 0, w: this.panelW ?? 380, shift: false }; this.onDiffItem(m ? m[2] : arg, cx); }
    else if (name === "file" && arg && this.files.some((f) => f.path === arg)) this.pick(arg, cx); // file:<path>, a file row's click in the shown diff
    // pick:<number | owner/repo#number | url>: a row of the shown list; else a PR of another list (the source shown
    // stays as it is), else, named with its repo, any PR as "Open PR…" takes it (a click on a mark in the Worktrees mod).
    else if (name === "pick") {
      const pr = byRef(this.listNow(), arg) ?? byRef(this.knownPrs(), arg), ref = pr ? null : parsePrRef(arg);
      if (pr) this.pickTarget(pr, cx);
      else if (ref) { this.openRefInput.set_value(arg); this.openRef(cx); }
    }
  }

  key() { return this.prSel?.url ?? JSON.stringify(location()); }
  // Whose diff this is: the picked PR's context, else the focused space's.
  ctxId() { return this.exMode && this.ex?.ctx ? this.ex.ctx : this.prSel ? prCtx(this.prSel) : spaceCtx(location().space); }
  // What a Python script gets for this context: {id, env, tickets}.
  ctxReq(id = this.ctxId()) { return { ...C.contextReq(ctxDoc(), id), tickets: C.infoOf(ctxDoc(), id).tickets ?? true }; }
  // The command prefix that runs a program in a context (its env vars).
  ctxEnv(id) { return C.envArgv(ctxDoc(), id); }
  lang() { return this.cfg?.language ?? "English"; }
  // What reviews and walkthroughs are kept under: the PR, else the repo and its base.
  sourceKey() { return this.pr?.url ?? (this.root ? `${this.root}#${this.base}` : null); }

  async loadPrs(cx) {
    const text = await readTextFile(`${appHome()}/pr-data/prs.json`).catch(() => null);
    const doc = text ? JSON.parse(text) : null, sig = JSON.stringify(doc?.prs ?? null);
    if (sig === this.prsSig) return doc; // the same list as before (a scan found nothing new): nothing to draw
    this.prsSig = sig;
    if (doc) this.prs = doc.prs ?? [];
    this.dropMinimized();
    if (this.prSel) this.prSel = this.prs.find((p) => p.url === this.prSel.url) ?? this.prSel; // fresh updatedAt: the diff cache stamp
    this.publishWorktrees();
    cx.notify();
    return doc;
  }

  // prs.py (about 20 s) only when prs.json is older than PRS_MS, and in one copy at a time: prs.lock holds the start
  // time, taken and given back by compare-and-swap (writeTextFile with the text read). True when it ran, "failed" when
  // it could not run or reached GitHub for none of the PRs it asked about (prs.py exit 3).
  async scanPrs(cx) {
    const doc = await this.loadPrs(cx), lock = `${appHome()}/pr-data/prs.lock`;
    if (this.scanning || Date.now() - Date.parse(doc?.generated ?? 0) < PRS_MS) return false;
    const held = await readTextFile(lock).catch(() => null), mine = String(Date.now());
    if (held && Date.now() - Number(held) < 600000) return false;
    try { await writeTextFile(lock, mine, held); } catch { return false; }
    this.scanning = true; if (!this.prs.length) cx.notify(); // the empty list says it is searching
    const req = { dirs: C.claudeDirs(ctxDoc(), home()), rules: ctxDoc()?.rules ?? [], titles: this.cfg?.sessionTitles ?? null };
    const r = await exec("python3", [`${appHome()}/mods/pr-review/prs.py`, JSON.stringify(req)], { timeout: 600000 }).catch(() => null);
    this.scanning = false; if (!this.prs.length) cx.notify();
    await writeTextFile(lock, "0", mine).catch(() => null);
    await this.loadPrs(cx);
    return r && r.code !== 3 && (r.code === 0 || r.code === 2) ? true : "failed";
  }

  // prs.py only while someone can see the list: the panel shown (or placed in a layout without it) and the window in
  // front. Hidden or behind other windows it asks nothing; shown again, it asks once the last try is PRS_MS old. After
  // a scan that failed the wait doubles each time, up to half an hour (pr.js pollDue), until one works again.
  scanDue() { return visible() && windowActive() && pollDue(this.scanPoll, Date.now(), PRS_MS); }
  scanIfDue(cx) {
    if (!this.scanDue()) return;
    this.scanPoll = { at: Date.now(), fails: this.scanPoll?.fails ?? 0 };
    cx.spawn(async (cx) => {
      const ran = await this.scanPrs(cx);
      this.scanPoll = pollAfter(this.scanPoll, ran !== "failed", this.scanPoll.at);
      if (ran === true && this.prSel && inView()) this.refresh(cx);
    });
  }

  // A folder's repo: {root, gitdir, base: origin's default branch}, one spawn per folder; null outside a repo.
  repoOf(cwd) {
    if (!this.repos.has(cwd)) {
      this.repos.set(cwd, exec("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--abbrev-ref", "origin/HEAD"], { cwd }).then((r) => {
        const [root, gitdir, base] = r.stdout.trim().split("\n");
        return gitdir?.startsWith("/") ? { root, gitdir, base: r.code === 0 ? base : "origin/main" } : null;
      }).catch(() => { this.repos.delete(cwd); return null; })); // the command did not run: asked again next time
      keepLast(this.repos, 100);
    }
    return this.repos.get(cwd);
  }

  // Watches a shown repo (at most WATCHES; the oldest is let go). A change that matters marks it dirty; shown, it
  // refreshes once a second later. The map keeps each repo's pending watch (Herdr's FolderWatch): a repo let go, and
  // every repo when this copy closes, is cancelled, which frees its place among Herdr's watched folders at once and
  // ends its loop (a cancelled watch resolves with []).
  watch(root, cx) {
    if (this.watching.has(root)) { const v = this.watching.get(root); this.watching.delete(root); this.watching.set(root, v); return; }
    this.watching.set(root, null);
    if (this.watching.size > WATCHES) { const [old, w] = this.watching.entries().next().value; this.watching.delete(old); w?.cancel(); }
    cx.spawn(async (cx) => {
      while (this.watching.has(root)) {
        const w = watchFolder(root); this.watching.set(root, w);
        const paths = await w;
        if (!this.watching.has(root) || !paths.some((p) => !IGNORED.test(p))) continue;
        const was = this.dirty.has(root);
        this.dirty.add(root);
        if (!was) this.recheck(root, cx);
      }
    });
  }
  // A second after a change in a shown repo: its diff again, quietly (refresh).
  recheck(root, cx) { cx.timer.after(1000, (cx) => { if (this.root === root && this.showsBranch() && this.dirty.has(root) && visible()) this.refresh(cx, true, true); }); }

  // A picked PR's whole diff, immutable per head: pr-data/cache/diff-<url hash>-<head>.json (+ .<i>.txt parts, see diffcache.js), else gh pr diff.
  async prDiff(pr) {
    const head = pr.headSha ?? hash(`${pr.updatedAt}|${pr.head}`), base = `${cacheDir()}/diff-${hash(pr.url)}-${head}`;
    const before = await loadDiff(base, pr.url, head, readTextFile);
    if (before !== null) return before;
    const keep = (source, text) => saveDiff(base, pr.url, head, source, text, writeTextFile)
      .then(() => exec("python3", [`${appHome()}/mods/pr-review/prs.py`, "--prune"])).catch(() => null); // bounds the cache folder
    const r = await exec("gh", ["pr", "diff", pr.url, "--color", "never"], { timeout: 60000 });
    if (r.code !== 0 && diffTooLarge(r.stderr)) { const t = await this.apiPrDiff(pr); keep("api", t); return t; }
    if (r.code !== 0) throw new Error(`gh pr diff: ${r.stderr.trim()}`);
    keep("gh", r.stdout);
    return r.stdout;
  }

  // Over GitHub's 300-file limit: the diff built from the "List pull request files" API (at most 3000 files).
  async apiPrDiff(pr) {
    const r = await exec("gh", ["api", "--paginate", "--slurp", `repos/${pr.repo}/pulls/${pr.number}/files?per_page=100`], { timeout: 120000 });
    if (r.code !== 0) throw new Error(`gh api pulls/files: ${r.stderr.trim()}`);
    const files = JSON.parse(r.stdout).flat();
    if (files.length >= 3000) throw new Error("This PR changes 3000 or more files, and GitHub lists at most 3000, so it can't be reviewed here.");
    return filesToDiff(files);
  }

  // A shown PR's head, asked at most every PR_INFO_MS in the background; a new push marks it for a refresh.
  checkHead(pr, cx) {
    const seen = this.heads.get(pr.url);
    if (seen && Date.now() - seen.at < PR_INFO_MS) return;
    keepLast(this.heads.set(pr.url, { at: Date.now(), sha: seen?.sha ?? pr.headSha }), 300); // one entry per PR seen, the oldest goes
    cx.spawn(async (cx) => {
      const sha = await this.headOf(pr.url);
      if (!sha) return;
      this.heads.set(pr.url, { at: Date.now(), sha });
      if (this.prSel?.url === pr.url && sha !== this.prSel.headSha) { this.prSel = { ...this.prSel, headSha: sha }; this.refresh(cx, true); }
    });
  }

  // A PR's head from GitHub (gh pr view), null when gh can't say; asked once at a time per PR (a second ask shares it).
  headOf(url) {
    const busy = HEAD_ASKS;
    if (!busy.has(url)) busy.set(url, exec("gh", ["pr", "view", url, "--json", "headRefOid"], { timeout: 30000 })
      .then((v) => (v.code === 0 ? JSON.parse(v.stdout).headRefOid ?? null : null)).catch(() => null).finally(() => busy.delete(url)));
    return busy.get(url);
  }

  choose(pr, cx) {
    this.prSel = pr; this.branchPicked = !pr; this.picking = false; this.mode = "diff"; this.askTop = false; this.undo = null; this.leftNote = null;
    this.pickGen = (this.pickGen ?? 0) + 1;
    setShared("pr.selected", withPick(shared("pr.selected"), selKey(), pr?.url ?? BRANCH));
    if (pr && !this.prs.some((p) => p.url === pr.url)) { // not in prs.json: keep the whole target, the newest PICKED_KEEP
      const kept = Object.entries(shared("pr.picked") ?? {}).filter(([u]) => u !== pr.url).slice(0, PICKED_KEEP - 1);
      setShared("pr.picked", Object.fromEntries([[pr.url, pr], ...kept]));
    }
    this.refresh(cx); cx.notify();
  }

  // The last load, for measuring: what happened and how long it took. Kept on the view, not in shared state: a shared
  // write redraws every mod of the window, which a diff reloading once a second must not do.
  perf(what, ms) { this.lastLoad = { what, ms, context: this.context, at: Date.now() }; }
  // The branch's diff is what the panel shows now (not a PR, not the list): only then it is made and kept fresh.
  showsBranch() { return Boolean(this.branchPicked && !this.prSel && !this.picking); }

  // The shown context's diff and view (file, selection, scroll), kept in memo for going back to it.
  snapshot() {
    return { root: this.root, pr: this.pr, base: this.base, files: this.files, patch: this.patch, branchFiles: this.branchFiles,
      open: this.open, rows: this.rows, sel: this.sel, selEnd: this.selEnd, mode: this.mode };
  }
  remember(context, at) {
    const old = this.memo.get(context);
    this.memo.delete(context);
    this.memo.set(context, { at: at ?? old?.at ?? Date.now(), state: this.snapshot() });
    if (this.memo.size > MEMO) this.memo.delete(this.memo.keys().next().value);
  }

  // force: diff again even when the remembered state is fresh (dirty repo, new head, ↻). quiet: a check after a
  // change in the repo: no "…" while it runs, and nothing is drawn or replaced when the diff comes out the same.
  refresh(cx, force = false, quiet = false) {
    const { cwd } = location(), context = this.key(), picked = this.prSel;
    // One load per context. Another PR picked while a diff still loads starts its own at once (the older answer is
    // dropped where it arrives); before, the new title stood over the old PR's files until that load ended.
    if (this.loading && this.loadingFor === context) return;
    quiet = quiet && context === this.context && !picked;
    let unchanged = false;
    if (context !== this.context) {
      if (this.context && this.memo.has(this.context)) this.remember(this.context);
      this.context = context; this.branchSig = null; this.root = null; this.files = []; this.open = null; this.rows = []; this.sel = null; this.selEnd = null; this.pr = null; this.error = null; this.patch = null; this.branchFiles = null; this.scrollRow = "top";
      const hit = this.memo.get(context);
      if (hit) {
        Object.assign(this, hit.state);
        if (this.sel !== null) this.scrollRow = this.sel; // back at the line that was selected
        this.remember(context); // most recently used
        cx.spawn(async (cx) => { await this.syncSource(cx).catch(() => null); cx.notify(); }); // its comments: a file read
        if (picked && visible()) this.checkHead(picked, cx);
        if (!force && Date.now() - hit.at < TTL_MS && !(this.root && this.dirty.has(this.root) && !picked)) { this.perf("restored, no exec", 0); return cx.notify(); }
      }
    }
    if ((!cwd && !picked) || (this.part === "review" && !picked)) return;
    if (this.root) this.dirty.delete(this.root); // changes from here on mark it again
    this.loading = true; this.loadingFor = context; this.quietLoad = quiet;
    const started = Date.now();
    cx.spawn(async (cx) => {
      try {
        if (picked) {
          // Not necessarily checked out here: the whole diff from GitHub; root only if the session's folder still is a repo.
          const [text, repo] = await Promise.all([this.prDiff(picked), picked.cwd ? this.repoOf(picked.cwd) : null]);
          if (visible()) this.checkHead(picked, cx);
          if (this.key() !== context) return;
          this.patch = splitPatch(text);
          this.root = repo?.root ?? null; this.pr = { number: picked.number, title: picked.title ?? picked.repo, url: picked.url };
          this.base = picked.base; this.files = this.patch; this.error = null;
        } else {
          const repo = await this.repoOf(cwd);
          if (this.key() !== context) return;
          if (!repo) { this.error = "Not a git repository"; this.files = []; return; }
          this.dirty.delete(repo.root);
          const root = repo.root, head = (await readTextFile(`${repo.gitdir}/HEAD`).catch(() => null) ?? "").trim();
          const info = this.prInfo.get(`${root}#${head}`);
          const base = info?.pr ? `origin/${info.pr.baseRefName}` : repo.base;
          // One diff for every file, against the merge base, uncommitted changes included.
          const r = await exec("git", [...READ, "diff", "--merge-base", base, "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"], { cwd: root, timeout: 60000 });
          if (r.code !== 0) throw new Error(`git diff gegen ${base}: ${r.stderr.trim()}`);
          if (this.key() !== context) return;
          const sig = `${base}:${r.stdout.length}:${hash(r.stdout)}`;
          unchanged = quiet && sig === this.branchSig && this.root === root && !this.error;
          this.branchSig = sig;
          if (!unchanged) { this.branchFiles = splitPatch(r.stdout); this.root = root; this.pr = info?.pr ?? null; this.base = base; this.files = this.branchFiles; this.error = null; }
          this.watch(root, cx);
          // The branch's PR in the background; its base may differ from origin's default: then diff again.
          if (!info || Date.now() - info.at > PR_INFO_MS) {
            this.prInfo.set(`${root}#${head}`, { pr: info?.pr ?? null, at: Date.now() });
            cx.spawn(async (cx) => {
              const view = await exec("gh", ["pr", "view", "--json", "number,title,url,baseRefName,headRefOid"], { cwd: root }).catch(() => null);
              const pr = view?.code === 0 ? JSON.parse(view.stdout) : null;
              this.prInfo.set(`${root}#${head}`, { pr, at: Date.now() });
              if (this.key() !== context) return;
              if ((pr ? `origin/${pr.baseRefName}` : repo.base) !== base) this.refresh(cx);
              else if (JSON.stringify(pr) !== JSON.stringify(this.pr)) { this.pr = pr; this.remember(context); await this.syncSource(cx); cx.notify(); } // the same PR as shown: nothing to draw
            });
          }
        }
        if (unchanged) { this.remember(context, Date.now()); return; }
        if (this.open && !this.files.some((f) => f.path === this.open)) { this.open = null; this.rows = []; this.sel = null; }
        if (this.files.length) await this.load(this.open ?? this.files[0].path, context);
        this.remember(context, Date.now());
        this.perf(picked ? "picked PR loaded" : "branch diff loaded", Date.now() - started);
      } catch (e) { if (this.key() === context) this.error = String(e); }
      finally {
        if (this.loadingFor !== context) return; // a newer load runs: this one's end is not its end
        this.loading = false;
        if (!unchanged) {
          cx.notify();
          const key = this.reviewKey;
          if (this.key() === context) await this.syncSource(cx).catch((e) => { this.note = `Could not load the review: ${e}`; });
          if (this.part === "review" || this.reviewKey !== key || this.note) cx.notify(); // the source's comments came: once more
        }
        // Written again while this ran: once more in a second, also when no render comes to ask (a covered window draws nothing).
        if (this.root && this.dirty.has(this.root) && this.key() === context) this.recheck(this.root, cx);
      }
    });
    if (!quiet) cx.notify();
  }

  // A new source: its pending comments, and its walkthrough when that view is open.
  async syncSource(cx) {
    const key = this.sourceKey();
    if (key === this.reviewKey) {
      // The review on a new head of the same PR (checkHead): its hunks, checkout and analysis state again; whole files
      // were read at the old head.
      const head = this.prSel?.headSha;
      if (this.part === "review" && head && this.srcHead && head !== this.srcHead) { this.srcHead = head; this.full = {}; await this.onSource(cx); }
      return;
    }
    this.reviewKey = key; this.editing = null; this.discardAsk = false; this.walk = null; this.walkError = null; this.read = new Set(); this.step = 0;
    const text = key ? await readTextFile(reviews()).catch(() => null) : null;
    this.comments = (text ? JSON.parse(text)[key] : null) ?? [];
    if (!this.part) await this.loadMarks(key).catch(() => null);
    if (this.view === "walk") this.openWalk(cx, false);
    if (this.part === "review") { this.srcHead = this.prSel?.headSha ?? null; await this.onSource(cx); }
  }

  // What the review already knows of the chosen PR, from its cached analysis and findings file (no gh, no model): the
  // PR's risk signal for the tabs row and one per file for the file list (views.js riskSignal, fileRisk).
  async loadMarks(url) {
    this.fileMarks = new Map();
    if (!url?.startsWith("https://")) return;
    const read = (f) => readTextFile(f).then((x) => (x ? JSON.parse(x) : null)).catch(() => null), h = hash(url);
    const [an, fd] = await Promise.all([read(`${cacheDir()}/rv-${h}-${walkModel()}.json`), read(`${appHome()}/pr-data/findings/${h}.json`)]);
    if (this.reviewKey !== url) return;
    const known = knownOf(an, fd); // with the threats that stand on a finding, as the list's marks and the review have them
    this.fileMarks = fileRisk(known);
    (this.risk ??= new Map()).set(url, riskSignal(known));
  }

  async load(path, context) {
    const r = { code: 0, stdout: (this.patch ?? this.branchFiles ?? []).find((f) => f.path === path)?.lines.join("\n") ?? "" };
    if (this.key() !== context) return;
    const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
    const lines = r.code !== 0 ? [`Could not read the diff: ${r.stderr.trim()}`] : first < 0 ? ["No text diff"] : all.slice(first, first + DIFF_MAX);
    if (this.open !== path) { this.sel = null; this.selEnd = null; this.scrollRow = "top"; }
    this.open = path; this.mode = this.mode ?? "diff";
    if (this.mode === "file") await this.showFile(path, context);
    const shown = lines.map((l) => (l.length > 2000 ? l.slice(0, 2000) + "…" : l)), sig = shown.join("\n");
    if (this.rows.sig === sig) return; // the same text as shown: the rows and their syntax colours stay
    this.rows = Object.assign(diffRows(shown), { sig, first: firstLineOf(all) }); // first: line 1 where the diff has it, for a script without an ending
  }

  // The whole file as it is now: markdown rendered, code highlighted read-only.
  async showFile(path, context) {
    const file = `${this.root}/${path}`;
    if (this.fileOf !== file) { this.code?.release(); this.code = null; this.md = null; this.fileError = null; this.fileOf = file; this.fileText = undefined; }
    const text = await readTextFile(file).catch(() => null);
    if (this.key() !== context || this.open !== path) return;
    if (text === this.fileText) return; // as shown: the editor stays, and with it where it was scrolled to
    this.code?.release(); this.code = null; this.md = null; this.fileError = null; this.fileText = text;
    if (text === null) { this.fileError = "File not in the working tree (deleted?)"; return; }
    if (text.includes("\0")) { this.fileError = "Binary file"; return; }
    const body = text.length > 400000 ? text.slice(0, 400000) + "\n… (truncated)" : text;
    // No ending: the "#!" line says what it is (the Editor knows a language by its usual ending).
    const ext = path.split("/").pop().includes(".") ? path.split(".").pop().toLowerCase() : { shell: "sh", python: "py", js: "js" }[langOf(path, body.slice(0, 200).split("\n")[0])] ?? "txt";
    if (ext === "md" || ext === "markdown") { this.md = body; return; }
    const t = theme();
    this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true, value: body, font_family: settings().font_family, font_size: 12,
      syntax: editorSyntax(t) });
  }

  setMode(mode, cx) {
    this.mode = mode;
    const path = this.open, context = this.context;
    if (mode === "file" && path) cx.spawn(async (cx) => { await this.showFile(path, context); cx.notify(); });
    cx.notify();
  }

  pick(path, cx) {
    const context = this.context;
    cx.spawn(async (cx) => { try { await this.load(path, context); } catch (e) { this.error = String(e); } cx.notify(); });
  }

  // ---- review: pending comments, kept per source in pr-data/reviews.json until sent

  anchor(ctx, max) {
    return this.mode !== "file" && this.sel !== null ? selection(this.rows, this.sel, this.selEnd ?? this.sel, ctx, max) : null;
  }

  addComment(cx) {
    const text = this.question.trim();
    if (!text || !this.open || !this.reviewKey) return;
    if (this.editing) this.comments = this.comments.map((c) => (c.id === this.editing.id ? { ...c, text } : c));
    else this.comments = [...this.comments, { id: Date.now().toString(36), file: this.open, ...this.anchor(), text }];
    this.editing = null; this.question = ""; this.input.set_value(""); this.sel = null; this.selEnd = null; this.askTop = false;
    this.fh.focus(); this.persist(cx); cx.notify();
  }

  // The composer's field exists once the list drew it: focus it right after this render.
  focusInput(cx) { cx.timer.after(0, (cx) => { this.input.focus(); cx.notify(); }); }
  editComment(c, cx) { this.editing = c; this.question = c.text; this.input.set_value(c.text); this.focusInput(cx); cx.notify(); }
  dropComment(c, cx) { this.comments = this.comments.filter((x) => x.id !== c.id); if (this.editing?.id === c.id) this.cancel(cx); this.persist(cx); cx.notify(); }
  cancel(cx) { this.editing = null; this.question = ""; this.input.set_value(""); this.fh.focus(); cx.notify(); }
  // Closes the composer: the selection (or the file-level one) goes, the text too.
  closeAsk(cx) { this.sel = null; this.selEnd = null; this.askTop = false; this.cancel(cx); }

  // ponytail: last writer wins per source; two copies editing the same review at once can drop a comment.
  persist(cx) {
    const key = this.reviewKey, comments = this.comments;
    cx.spawn(async (cx) => {
      await saveKey(reviews(), key, comments.length ? comments : undefined).catch((e) => { this.note = `Could not save the review: ${e}`; cx.notify(); });
    });
    if (this.part === "review") { this.registerReview(cx); this.publish(); }
  }

  // "Discard" on the pending comments: the first click asks, the second deletes them all.
  discardAll(cx) {
    if (!this.discardAsk) this.discardAsk = true;
    else { this.discardAsk = false; this.comments = []; this.persist(cx); }
    cx.notify();
  }

  // The panel's "Finish your review" (also the finish command here): the PR opens in the review layout, whose copy
  // takes shared "pr.finish" and opens its popover of that name with these pending comments (render, part "review").
  finishReview() {
    if (!this.pr?.url || !this.comments.length) return;
    setShared("pr.finish", { url: this.pr.url, at: Date.now() });
    this.toReview((shared("review.open") ?? []).find((r) => r.url === this.pr.url)?.target ?? this.prSel ?? this.branchTarget());
  }

  sendReview(cx) {
    if (!this.comments.length) return;
    const sent = this.comments;
    this.deliver(buildReview({ pr: this.pr, base: this.base, comments: sent, lang: this.lang() }), cx, "Review", (cx) => {
      this.comments = this.comments.filter((c) => !sent.includes(c)); this.persist(cx);
      if (this.part === "review") this.registerReview(cx, { status: "sent", sentAt: Date.now() });
    });
  }

  ask(cx, preset) {
    const question = (preset ?? this.question).trim();
    if (!question) return;
    this.deliver(buildPrompt({ pr: this.pr, base: this.base, file: this.open, anchor: this.anchor(20, 40), question, lang: this.lang() }), cx, "Question",
      (cx) => { if (!preset) { this.question = ""; this.input.set_value(""); } this.sel = null; this.selEnd = null; this.askTop = false; cx.notify(); });
  }

  // The agent to ask: the focused one in this space, else one in the shown tab, else any in the space.
  target(spaceId) {
    const mine = agents().filter((a) => a.space === spaceId);
    const tab = spaces().find((s) => s.id === spaceId)?.tabs.find((t) => t.active)?.id;
    return mine.find((a) => a.focused) ?? mine.find((a) => a.tab === tab) ?? mine[0] ?? null;
  }

  // The live agent of the session that made a picked PR: the only Claude agent in that session's folder.
  // ponytail: agents carry no session id; one Claude in that folder is taken to be it, home folders say nothing.
  sessionAgent(origin) {
    if (!origin.cwd || origin.cwd === home()) return null;
    const there = agents().filter((a) => spaceCtx(a.space) === prCtx(origin) && /claude/i.test(a.app ?? a.program?.key ?? "") && panes().find((p) => p.pane === a.pane)?.cwd === origin.cwd);
    return there.length === 1 ? there[0] : null;
  }

  // A space of that context: one in one of these folders, else the focused one when it fits, else any.
  spaceFor(ctx, ...folders) {
    const ok = spaces().filter((s) => spaceCtx(s.id) === ctx), here = location().space;
    return (ok.find((s) => folders.includes(s.folder)) ?? ok.find((s) => s.id === here) ?? ok[0])?.id ?? here;
  }

  // Sends a prompt: a picked PR goes to its session (live agent, else `claude --resume` in a new tab, else a fresh
  // Claude when its folder is gone); the branch diff to this space's agent or a new Claude tab. Sending goes there:
  // the agent's tab is selected, and a new tab takes the focus (Herdr's default) the same way.
  // guard: the text holds someone else's words (a GitHub comment by another author, threads.js foreignComment). It
  // goes into no session that runs with rights of its own (a live agent, the PR's resumed session): a new tab gets
  // it, in manual mode with the person's own settings only.
  deliver(prompt, cx, what, done, guard = false) {
    const { space } = location(), origin = this.prSel;
    if (!space || this.sending || !(this.root || this.pr)) return;
    const ctx = this.ctxId(), agent = guard ? null : origin?.session ? this.sessionAgent(origin) : this.target(origin?.space ?? space);
    this.sending = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        if (agent) {
          const r = await hc(["send", agent.address, prompt]);
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
          run("tab.select", { id: agent.tab });
          this.note = `${what} sent to ${agent.tab_name || "agent"}`;
        } else if (!guard && origin?.session && this.root) {
          // The session lives in the config folder it ran under (sessionContext), which the rules' context may not be.
          run("tab.new", { space: this.spaceFor(ctx, origin.cwd, this.root), folder: origin.cwd, name: tabName(origin.repo, `PR #${origin.number}`), argv: [...this.ctxEnv(origin.sessionContext ?? ctx), "claude", "--resume", origin.session], task: prompt });
          this.note = `${what}: resumed the PR's session in a new tab`;
        } else {
          run("tab.new", { space: this.spaceFor(ctx, this.root), folder: this.root ?? location().cwd, name: tabName(origin?.repo ?? this.root, origin ? `PR #${origin.number}` : "review"), argv: tabArgs({ env: this.ctxEnv(ctx), model: walkModel(), ask: guard, trusted: false }), task: prompt });
          this.note = `${what}: started a new Claude tab${guard ? " in manual mode (it holds someone else's GitHub comment)" : ""}`;
        }
        done(cx);
      } catch (e) { this.note = `Not sent: ${e}`; }
      finally { this.sending = false; cx.notify(); }
    });
    cx.notify();
  }

  // ---- keys (the diff holds the keyboard after a click; the comment box keeps its own)

  onKey(e, cx) {
    if (this.typing) { if (e.key === "escape") { this.cancel(cx); cx.stop_propagation(); } return; }
    // Letters are shortcuts only while the panel itself has the keyboard: typed into a field (Open PR…), they're text.
    if (e.key !== "escape" && !this.fh.is_focused()) return;
    const k = e.keystroke;
    if (k === "j" || k === "k") {
      const i = nextChange(this.rows, this.sel, k === "j" ? 1 : -1);
      if (i >= 0) { this.sel = i; this.selEnd = null; this.askTop = false; this.scrollRow = i; }
    } else if (k === "n" || k === "p") {
      const next = this.files[this.files.findIndex((f) => f.path === this.open) + (k === "n" ? 1 : -1)];
      if (next) this.pick(next.path, cx);
    } else if (k === "c") { if (this.sel === null) this.askTop = true; this.focusInput(cx); }
    else if (k === "escape") { this.sel = null; this.selEnd = null; this.askTop = false; this.picking = false; }
    else return;
    cx.stop_propagation(); cx.notify();
  }

  // ---- walkthrough

  // The walkthrough is the review layout's AI analysis (review.py, one run per head and model) read in reading
  // order: this only reads its cache. Analyzing happens in the review layout, on a click.
  openWalk(cx, analyze) {
    this.view = "walk";
    if (analyze) { if (this.pr?.url) this.toReview(this.prSel ?? this.branchTarget()); return cx.notify(); }
    const key = this.sourceKey(), files = this.patch ?? this.branchFiles;
    if (!key || !files) return cx.notify();
    const m = walkModel(), job = reviewRequest({ url: key, pr: this.pr?.url ?? null, files, model: m, context: this.ctxReq(), dir: cacheDir() });
    this.walkModel = m; this.walkError = null;
    cx.spawn(async (cx) => {
      const text = await readTextFile(job.out).catch(() => null) ?? await readTextFile(job.latest).catch(() => null);
      if (this.sourceKey() !== key) return;
      const saved = text ? JSON.parse(text) : null, now = new Map(job.hunks.map((h) => [h.id, h]));
      this.walkHunks = job.hunks;
      if (!saved) { this.walk = null; return cx.notify(); }
      const r = mapReview(saved.answer, saved.hunks.map((h) => ({ ...h, ...(now.get(h.id) ?? {}) })));
      this.walk = { ...saved, title: r.title, summary: r.summary, asks: r.asks,
        steps: [...r.steps].sort((a, b) => a.order - b.order).map((s) => ({ ...s, text: s.text || s.why })) };
      cx.notify();
    });
    cx.notify();
  }

  // The Walkthrough tab: one scrolling column (so nothing overflows onto what's below at any width): title, summary,
  // a meta line with "⋯" (the model and "Open review ↗"), the compact list of layers, the picked layer's text and hunks.
  walkView(t) {
    const w = this.walk, now = new Map((this.walkHunks ?? []).map((h) => [h.id, h])), sid = `walk-${this.uid}`;
    const scroll = (el) => div().flex_1().min_h(0).relative().child(el.id(sid).absolute().inset_0().overflow_y_scroll())
      .child(Scrollbar.vertical(sid).absolute().inset_0());
    if (!w) {
      return scroll(v_flex().p(14).gap(10).text_color(t.dim)
        .child(div().whitespace_normal().child(this.sourceKey() ? `No ${modelLabel(walkModel())} analysis for this diff yet. The walkthrough is the review's AI analysis in reading order.` : "No diff."))
        .when(Boolean(this.pr?.url), (e) => e.child(h_flex().flex_wrap().gap(8).child(modelPills(t, `walk-m0-${this.uid}`))
          .child(pill(`walk-make-${this.uid}`, t, "Analyze in review ↗", (_e, cx) => this.openWalk(cx, true), false, "Open the review layout, where you start the AI analysis yourself")))));
    }
    const covered = new Set(w.steps.flatMap((s) => s.hunks));
    const left = [...now.values()].filter((h) => !covered.has(h.id));
    const steps = [...w.steps.map((s) => ({ ...s, stale: s.hunks.length > 0 && !s.hunks.some((id) => now.has(id)) }))];
    if (left.length) steps.push({ title: `Not covered (${left.length} hunks)`, text: w.cut?.length ? `${w.cut.length} of them were too large to send to the model.` : "No layer explains these hunks.", hunks: left.map((h) => h.id) });
    if (w.asks.length) steps.push({ title: "Check against the task", asks: w.asks, hunks: [] });
    const cur = steps[Math.min(this.step, steps.length - 1)];
    const done = w.steps.filter((_s, i) => this.read.has(i)).length;
    return scroll(v_flex().pb(10)
      .child(v_flex().px(14).pt(10).pb(8).gap(4)
        .child(div().font_semibold().whitespace_normal().child(w.title || "Walkthrough"))
        .child(div().text_size(TYPE.small).text_color(t.muted).whitespace_normal().child(w.summary))
        .child(h_flex().gap(8).items_center().text_size(TYPE.panel).text_color(t.dim)
          .child(div().flex_1().min_w(0).truncate().child(`${done} of ${w.steps.length} layers read · ${modelLabel(w.model) ?? "model unknown"}${w.cost != null ? ` · $${w.cost.toFixed(3)}` : ""}${w.cut?.length ? ` · ${w.cut.length} hunks cut` : ""}`))
          .when(Boolean(this.walkBusy), (e) => e.child(div().child(SPIN[0]).frames(SPIN, 90)))
          .child(pill(`walk-more-${this.uid}`, t, "⋯", (_e, cx) => { this.walkMore = !this.walkMore; cx.notify(); }, this.walkMore, "Show or hide the model choice and more options", "More walkthrough options")))
        .when(Boolean(this.walkMore), (e) => e.child(h_flex().flex_wrap().gap(8).items_center().pt(2)
          .child(modelPills(t, `walk-m-${this.uid}`))
          .when(Boolean(this.pr?.url), (e) => e.child(pill(`walk-redo-${this.uid}`, t, "Open review ↗", (_e, cx) => this.openWalk(cx, true), false, "Open this PR in the review layout")))))
        .when(Boolean(this.walkError), (e) => e.child(div().text_size(TYPE.panel).text_color(t.ansi1).whitespace_normal().child(this.walkError))))
      .child(v_flex().px(6).py(4).border_t(1).border_b(1).border_color(t.border).children(steps.map((s, i) =>
        h_flex().id(`step-${i}-${this.uid}`).h(24).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().text_size(TYPE.small).tooltip("Show this layer and mark it read (✓ read, ○ unread)")
          .when(cur === s, (e) => e.bg(t.selected)).hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => { this.step = i; if (i < w.steps.length) this.read.add(i); cx.notify(); })
          .child(div().w(12).flex_none().text_color(this.read.has(i) ? t.ansi2 : t.dim).child(i >= w.steps.length ? "·" : this.read.has(i) ? "✓" : "○"))
          .child(div().flex_1().min_w(0).truncate().text_color(s.stale ? t.dim : t.foreground).child(s.title))
          .when(Boolean(s.stale), (e) => e.child(div().id(`step-o-${i}-${this.uid}`).tooltip("The code changed since this layer was written").text_size(TYPE.micro).text_color(t.ansi3).child("outdated")))
          .when(Boolean(WEIGHT[s.weight]), (e) => e.child(div().id(`step-w-${i}-${this.uid}`).tooltip(s.weight === "key" ? "Key layer: worth reading closely" : "Minor layer: a skim is enough").text_size(TYPE.micro).text_color(t[WEIGHT[s.weight]?.[1]]).child(WEIGHT[s.weight]?.[0] ?? ""))))))
      .child(div().px(14).py(10).text_size(TYPE.small).whitespace_normal().child(cur?.text ?? ""))
      .children((cur?.flows ?? []).map((f, k) => div().px(12).pb(6).child(flowCard(f, t, `wf-${this.uid}-${this.step}-${k}`))))
      .children((cur?.asks ?? []).map((a, i) => h_flex().id(`ask-${i}`).px(14).py(3).gap(8).text_size(TYPE.small)
        .child(div().id(`ask-${i}-cov`).tooltip("How well this diff covers the requirement from the task").w(70).flex_none().text_color(t[COVER[a.coverage]?.[1]] ?? t.dim).child(COVER[a.coverage]?.[0] ?? a.coverage))
        .child(div().flex_1().min_w(0).whitespace_normal().child(a.text))))
      .children((cur?.hunks ?? []).filter((id) => now.has(id)).flatMap((id) => {
        const h = now.get(id);
        return [div().id(`wh-${id}`).tooltip(h.path).px(12).pt(8).pb(2).text_size(TYPE.panel).text_color(t.muted).truncate().child(h.path),
          v_flex().font_family(settings().font_family ?? "JetBrains Mono").text_size(TYPE.codePanel)
            .children(diffRows(h.lines.slice(0, 400)).map((r, i) => this.diffRow(r, `${id}-${i}`, t, true)))];
      })));
  }

  // ---- render

  // PRs created from Claude sessions (prs.json), newest first, filtered by the contexts the view shows.
  // ---- PR sources: Mine (prs.json), This repo and Review requested (gh, no LLM), Open PR… (any PR by reference)

  // The source shown: the one picked in this space (shared "pr.sourceBy", per space), else "This space" when a branch
  // checked out here has an open PR (spaceAuto, set by loadSource), else the last pick anywhere, else the space's repo
  // when none of your session PRs is from it.
  sourcePick() { const k = (shared("pr.sourceBy") ?? {})[location().space ?? ""]; return SOURCES.some(([x]) => x === k) ? k : null; }
  sourceNow() {
    const here = this.sourcePick();
    if (here) return here;
    if (this.spaceAuto) return "space";
    const picked = shared("pr.source");
    if (SOURCES.some(([k]) => k === picked)) return picked;
    const slug = this.spaceSlug?.slug;
    return slug && !this.prs.some((p) => p.repo === slug && shownIn(p)) ? "repo" : "mine";
  }
  // A click on a source: for this space (the newest 30 spaces kept), and as the last pick for spaces without one.
  pickSource(k) { setShared("pr.source", k); setShared("pr.sourceBy", withPick(shared("pr.sourceBy"), location().space ?? "", k)); }

  // The active space's repo: {root, slug: owner/name from origin}, or null outside a GitHub repo.
  async spaceRepo() {
    const cwd = location().cwd, repo = cwd ? await this.repoOf(cwd) : null, slug = repo ? await this.slugOf(repo.root) : null;
    return slug ? { root: repo.root, slug } : null;
  }
  // A repo's owner/name on GitHub from its origin (one git call per repo, remembered), null for another host or none.
  async slugOf(root) {
    if (!this.slugs.has(root)) {
      const r = await exec("git", ["remote", "get-url", "origin"], { cwd: root }).catch(() => null);
      this.slugs.set(root, /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(r?.stdout.trim() ?? "")?.[1] ?? null);
    }
    return this.slugs.get(root);
  }
  // A folder's checkout: its repo, GitHub name and branch. The branch is read from the HEAD file, so looking again
  // costs no git call (a worktree has its own); null outside a repo.
  async checkout(cwd) {
    const repo = await this.repoOf(cwd);
    if (!repo) return null;
    return { cwd, root: repo.root, base: repo.base, slug: await this.slugOf(repo.root), branch: headBranch(await readTextFile(`${repo.gitdir}/HEAD`).catch(() => null)) };
  }

  // A PR's context for one you didn't open: the contexts' rules on its folder and remote, else the context your
  // session PRs of that repo have, else the space's (This repo) or the default.
  contextOfPr(repo, folder, fallback) {
    return C.ruleContext(folder, `https://github.com/${repo}`, ctxDoc()?.rules, home()) ?? (this.prs ?? []).find((p) => p.repo === repo)?.context ?? fallback ?? C.defaultOf(ctxDoc());
  }

  // The list of the shown source, from sources.json when fresh (force: ↻), else gh; the triage line follows.
  loadSource(cx, force = false) {
    this.srcAsked = true;
    cx.spawn(async (cx) => {
      // The person may go to another space while this runs: that space loads its own lists, this answer is not shown.
      const space = location().space, stale = () => location().space !== space, slug = await this.spaceRepo();
      if (stale()) return;
      this.spaceSlug = slug;
      // No source picked in this space yet: "This space" is shown when a branch checked out here has an open PR. Asked
      // once per space visit; a space on default branches only costs no gh call for it.
      let looked = false;
      if (!this.sourcePick() && this.spaceAuto == null) {
        await this.loadList("space", cx, { space, stale, force: false, quiet: true });
        if (stale()) return;
        this.spaceAuto = (this.srcLists.space?.prs ?? []).some((p) => isOpenPr(p) && shownIn(p)); looked = true;
      }
      const now = this.sourceNow();
      if (now === "mine" || (now === "space" && looked && !force)) { this.loadTriage(cx); return cx.notify(); } // Mine is in memory; This space was just loaded
      await this.loadList(now, cx, { space, stale, force });
    });
  }

  // One source's list into this.srcLists[now]: its key in sources.json and how to fetch it; fresh from the file, else
  // gh (repo: one gh pr list; review: one search; space: one GraphQL call per repo with all its branches).
  async loadList(now, cx, { space, stale, force, quiet = false }) {
    const shown = () => { if (!quiet) { this.loadTriage(cx); cx.notify(); } }; // quiet: the look for a default source draws nothing of its own
    const sr = this.spaceSlug, spaceC = spaceCtx(space), gh = async (args) => { const r = await exec("gh", args, { timeout: 60000 }); if (r.code !== 0) throw new Error(r.stderr.trim()); return JSON.parse(r.stdout); };
    let key, fetch, why = null;
    if (now === "space") {
      // Local only: the folders of the space's panes and agents, their repos (remembered) and HEAD files.
      await whenFed(cx); // right after a start the chip may not have read the spaces yet (live.js)
      const found = (await Promise.all(spaceFolders(space, spaces(), panes(), terminals()).map((cwd) => this.checkout(cwd)))).filter(Boolean), repos = spaceBranches(found);
      if (stale()) return;
      this.spaceHeads = new Map(found.map((c) => [c.cwd, c]));
      key = repos.length ? `space:${hash(JSON.stringify(repos.map((r) => [r.slug, r.branches])))}` : null; why = spaceEmpty(found, repos);
      fetch = async () => (await Promise.all(repos.map(async (r) => branchPrs(await gh(["api", "graphql", "-f", `query=${branchPrQuery(r.slug, r.branches)}`]))
        .map((p) => ghTarget(p, { repo: r.slug, cwd: r.roots[p.headRefName] ?? null, source: now, context: this.contextOfPr(r.slug, r.roots[p.headRefName] ?? null, spaceC) }))))).flat();
    } else if (now === "repo") {
      key = sr ? `repo:${sr.slug}` : null;
      fetch = async () => (await gh(["pr", "list", "-R", sr.slug, "--state", "open", "--limit", "50", "--json", GH_FIELDS])).map((p) => ghTarget(p, { repo: sr.slug, cwd: sr.root, source: now, context: this.contextOfPr(sr.slug, sr.root, spaceC) }));
    } else {
      key = "review";
      fetch = async () => (await gh(["search", "prs", "--review-requested=@me", "--state", "open", "--limit", "50", "--json", "repository,number,title,author,updatedAt,url,isDraft"])).map((p) => {
        const repo = p.repository?.nameWithOwner, cwd = sr && sr.slug === repo ? sr.root : null;
        return ghTarget(p, { repo, cwd, source: now, context: this.contextOfPr(repo, cwd, null) });
      });
    }
    if (!key) { this.srcLists[now] = { key: null, prs: [], why }; return shown(); } // nothing to ask GitHub about here: the list says what to do
    const before = await readTextFile(sourcesFile()).catch(() => null), doc = JSON.parse(before ?? "{}");
    if (stale()) return;
    if (!force && doc[key] && Date.now() - doc[key].at < SOURCE_MS) { this.srcLists[now] = { key, why, ...doc[key] }; this.publishWorktrees(); return shown(); }
    const busy = (this.srcBusy ??= new Set()); // by list: neighbours can be fetched at the same time
    if (busy.has(key)) return; // this list is being fetched: that answer serves this ask too
    busy.add(key);
    this.srcLists[now] = { key, why, prs: doc[key]?.prs ?? [], at: doc[key]?.at, loading: true }; if (!quiet) cx.notify();
    const prs = await fetch().catch((e) => e);
    busy.delete(key);
    const here = now === "review" || !stale(); // another space's list: kept in sources.json for it, not shown in this one
    if (prs instanceof Error) { if (here) { this.srcLists[now] = { ...this.srcLists[now], loading: false, error: `gh: ${String(prs.message ?? prs).slice(0, 160)}` }; cx.notify(); } return; }
    if (here) { this.srcLists[now] = { key, why, prs, at: Date.now() }; this.dropMinimized(); this.publishWorktrees(); }
    for (let attempt = 0; attempt < 3; attempt++) { // compare-and-swap: another copy may write it too
      const old = await readTextFile(sourcesFile()).catch(() => null);
      try { await writeTextFile(sourcesFile(), JSON.stringify(pruneSources({ ...JSON.parse(old ?? "{}"), [key]: { at: Date.now(), prs } }, SOURCE_KEEP)), old); break; } catch { /* again */ }
    }
    if (here) shown();
  }

  // The listed PRs of the shown source, in the contexts the view shows.
  listNow() {
    const src = this.sourceNow();
    return (src === "mine" ? this.prs : this.srcLists[src]?.prs ?? []).filter(shownIn);
  }

  // A target with its head (gh pr view): search results and references have none; the diff cache is keyed by it.
  async resolve(target) {
    if (target.headSha) return target;
    const r = await exec("gh", ["pr", "view", target.url, "--json", `${GH_FIELDS},state`], { timeout: 30000 }).catch((e) => ({ code: 1, stderr: String(e) }));
    if (r.code !== 0) throw new Error(`gh pr view: ${r.stderr.trim().slice(0, 160)}`);
    return { ...ghTarget(JSON.parse(r.stdout), { repo: target.repo, cwd: target.cwd, source: target.source, context: target.context }) };
  }

  // Picks a listed PR (review: straight into the review layout), resolving its head first when needed.
  pickTarget(target, cx, review = false) {
    const gen = (this.pickGen = (this.pickGen ?? 0) + 1); // a later pick (or choose) makes this one void
    if (target.headSha) return review ? this.toReview(target) : this.choose(target, cx);
    this.note = `Opening #${target.number}…`; cx.notify();
    cx.spawn(async (cx) => {
      try { const t = await this.resolve(target); if (gen !== this.pickGen) return; this.note = null; if (review) this.toReview(t); else this.choose(t, cx); }
      catch (e) { if (gen === this.pickGen) this.note = `Could not open: ${String(e).replace(/^Error: /, "")}`; }
      cx.notify();
    });
  }

  // Optional Go to (mods/goto/PROVIDERS.md) integration: PR links there become "Review PR", and reviews in progress
  // are findable. Go to hands the PR over through shared "pr.goto"; render picks it up. Without goto nothing happens.
  // A PR someone asked the panel to pick (shared "pr.pick" {ref, at}): written by whichever copy gets the "want"
  // command, so the wish is kept while no panel is there, and taken once by the panel when it draws (takePick): now,
  // or when it appears within a minute. Two copies writing the same wish within two seconds count as one.
  wantPick(ref) {
    const was = shared("pr.pick");
    if (ref && !(was?.ref === ref && Date.now() - was.at < 2000)) setShared("pr.pick", { ref, at: Date.now() });
  }
  takePick(cx) {
    const w = shared("pr.pick");
    if (!w) return;
    setShared("pr.pick", null);
    if (w.ref && Date.now() - w.at < 60000) this.panelCommand(`pick:${w.ref}`, cx); // older: the click is forgotten
    cx.notify();
  }

  // Every PR the panel knows in the contexts the view shows: your session PRs, the lists fetched, the reviews in progress.
  knownPrs() {
    // this.prs ?? []: init announces to Go to (and with it to Worktrees) before the lists exist.
    return [...(this.prs ?? []), ...Object.values(this.srcLists ?? {}).flatMap((l) => l?.prs ?? []), ...(shared("review.open") ?? []).map((r) => r.target ?? r)].filter(shownIn);
  }
  // Optional Worktrees (its PROVIDERS.md) integration: which PR belongs to which branch, from what the panel already
  // has (no fetch, no timer). Only with that mod there (shared "worktrees.api"), and written only when the list
  // changed: a shared write redraws every mod of the window. A click on a mark there picks the PR here.
  publishWorktrees() {
    if (this.part || !shared("worktrees.api")) return;
    const prs = worktreePrs([this.knownPrs()]), sig = JSON.stringify(prs);
    if (sig === this.wtSig) return;
    this.wtSig = sig;
    const p = shared("worktrees.providers") ?? [];
    if (!p.includes("review")) setShared("worktrees.providers", [...p, "review"]);
    setShared("worktrees.prs.review", wtList(prs));
  }
  publishGoto() {
    this.publishWorktrees(); // the reviews in progress changed, or the copy starts
    const p = shared("goto.providers") ?? [];
    if (!p.includes("review")) setShared("goto.providers", [...p, "review"]);
    const open = { key: "pr.goto", value: { url: "{url}", repo: "{owner}/{repo}", number: "{number}" } };
    const handlers = [{ pattern: "github\\.com/([\\w.-]+)/([\\w.-]+)/pull/(\\d+)", title: "Review PR #{number} · {title}", subtitle: "{owner}/{repo}", run: [["goto.set", open]] }];
    // Written when they differ from what is there (a call per render wrote both keys each time).
    if (JSON.stringify(shared("goto.handlers.review")) !== JSON.stringify(handlers)) setShared("goto.handlers.review", handlers);
    this.gotoSig = openSig(shared("review.open"));
    const items = (shared("review.open") ?? []).map((r) => ({ id: `review:${r.url}`, title: `Resume review #${r.number} ${r.title ?? ""}`,
      subtitle: [r.repo, progressText(r.progress)].filter(Boolean).join(" · "), tag: "Review", url: r.url, keywords: [String(r.number), r.repo ?? ""],
      run: [["goto.set", { key: "pr.goto", value: { url: r.url } }]] }));
    if (JSON.stringify(shared("goto.items.review") ?? null) !== JSON.stringify(items)) setShared("goto.items.review", items); // as the handlers: only another value is written
  }

  // A PR handed over by Go to: resume a review in progress, else open it in the review layout like "Open PR…".
  takeGoto(cx) {
    const g = shared("pr.goto");
    if (!g?.url) return;
    setShared("pr.goto", null);
    const r = (shared("review.open") ?? []).find((x) => x.url === g.url);
    if (r) return this.toReview(r.target ?? r);
    const mine = (this.prs ?? []).find((x) => x.url === g.url);
    const ref = mine ?? parsePrRef(g.url);
    if (!ref) return;
    const sr = this.spaceSlug?.slug === ref.repo ? this.spaceSlug.root : null;
    this.pickTarget(mine ?? { url: ref.url, repo: ref.repo, number: Number(ref.number), cwd: sr, source: "open", context: this.contextOfPr(ref.repo, sr, null) }, cx, true);
  }

  // One slice of the open file's highlighting; the next one after a timer, until the file is done (then a redraw).
  // hl.at: when the slice was asked for. Herdr stops a slice that takes too long without throwing, so the render gives
  // a file up whose slice is older than HL_STALE (it stays plain); a tokenizer that throws leaves it plain as well.
  highlightMore(cx, hl) {
    hl.at = Date.now();
    cx.timer.after(0, (cx) => {
      if (this.hl !== hl || hl.spans) return; // another file opened meanwhile, or this one was given up
      let out;
      try { out = highlightStep(hl.job, 10); } catch { out = hl.rows.map(() => []); }
      if (out) { hl.spans = out; cx.notify(); } else this.highlightMore(cx, hl);
    });
  }

  // The minimized Explore's run (review.js minimizeExplore keeps {id, status}): done or failed once its status file
  // says so; nothing is read while no run is minimized.
  miniPoll(cx) {
    const b = shared("review.minimized")?.explore?.busy;
    if (!b?.status || this.miniRun?.id === b.id) return;
    cx.spawn(async (cx) => {
      const st = JSON.parse(await readTextFile(b.status).catch(() => null) ?? "null");
      if (!st || st.busy) return cx.notify(); // still going: the chip's time moves on
      this.miniRun = { id: b.id, state: st.error ? "failed" : "done" }; cx.notify();
    });
  }

  // "Open PR…": a URL or owner/repo#123, opened like a listed PR.
  openRef(cx) {
    const ref = parsePrRef(this.openRefInput.value());
    if (!ref) { this.note = "Not a PR: paste its URL or owner/repo#123"; return cx.notify(); }
    this.openRefInput.set_value("");
    const mine = this.prs.find((p) => p.url === ref.url);
    if (mine) return this.choose(mine, cx);
    const sr = this.spaceSlug?.slug === ref.repo ? this.spaceSlug.root : null;
    this.pickTarget({ url: ref.url, repo: ref.repo, number: ref.number, cwd: sr, source: "open", context: this.contextOfPr(ref.repo, sr, null) }, cx);
  }

  // The open PRs' triage (pr.js triageOf) from what is cached: the latest analysis, findings, related PRs, diff size,
  // and triage.py's why/priority; and each row's risk signal (views.js riskSignal), also for the reviews in progress
  // that are not in the list. Reads files only (no gh, no LLM); when the list opens.
  loadTriage(cx) {
    const open = this.listNow().filter(isOpenPr).slice(0, TRIAGE_MAX), listed = new Set(open.map((p) => p.url)), m = walkModel();
    const rest = (shared("review.open") ?? []).filter((r) => shownIn(r) && !listed.has(r.url)).map((r) => r.target ?? r);
    cx.spawn(async (cx) => {
      const llm = JSON.parse(await readTextFile(triageFile()).catch(() => null) ?? "{}"), read = (f) => readTextFile(f).then((x) => (x ? JSON.parse(x) : null)).catch(() => null);
      const out = new Map(), risk = new Map();
      await Promise.all([...open, ...rest].map(async (pr) => {
        const h = hash(pr.url), head = pr.headSha ?? hash(`${pr.updatedAt}|${pr.head}`);
        const [an, fd] = await Promise.all([read(`${cacheDir()}/rv-${h}-${m}.json`), read(`${appHome()}/pr-data/findings/${h}.json`)]);
        const known = knownOf(an, fd), analysis = known.analysis; // a finding a threat stands on is ⛨ (pr.js isSecurity)
        risk.set(pr.url, riskSignal(known));
        if (!listed.has(pr.url)) return;
        // The diff's size from its cache (in parts, diffcache.js); a missing one leaves the effort to the analysis.
        // Once per PR and head (SIZES): the diff of a head never changes, and each time the list opened every listed
        // PR's whole diff was read and split again for these two numbers (a big one: 0.9 MB, 20 ms to split).
        const sized = async () => { const diff = await loadDiff(`${cacheDir()}/diff-${h}-${head}`, pr.url, head, readTextFile), fs = diff ? splitPatch(diff) : null; return fs && { files: fs.length, lines: fs.reduce((n, f) => n + f.add + f.del, 0) }; };
        if (!SIZES.has(`${h}-${head}`)) { SIZES.set(`${h}-${head}`, sized().then((x) => { if (!x) SIZES.delete(`${h}-${head}`); return x; })); keepLast(SIZES, 300); }
        const [ctx, size] = await Promise.all([pr.headSha ? read(`${cacheDir()}/ctx-${h}-${pr.headSha}.json`) : null, SIZES.get(`${h}-${head}`)]);
        const security = (known.findings ?? []).filter((f) => isSecurity(f) && !["fixed", "dismissed"].includes(known.status?.[f.id]?.s)); // as the review's ⛨
        out.set(pr.url, triageOf({ pr, analysis, size,
          security, related: ctx, llm: llm[pr.url] ?? null }));
      }).map((one) => one.catch(() => null))); // a broken cache file costs that row its chips, not the whole list
      this.triage = out; this.risk = risk; cx.notify();
    });
  }

  // "Triage PRs" (a click): one Haiku call per context for the open PRs listed (triage.py, feature "PR triage").
  runTriage(cx) {
    if (this.triaging || !this.triage?.size) return;
    const items = this.listNow().filter((p) => this.triage.has(p.url)).map((p) => ({ url: p.url, context: this.ctxReq(prCtx(p)), title: p.title ?? "", repo: p.repo,
      state: p.state, chips: this.triage.get(p.url).chips, hint: this.triage.get(p.url).why }));
    this.triaging = true;
    cx.spawn(async (cx) => {
      const r = await exec("python3", [`${appHome()}/mods/pr-review/triage.py`, JSON.stringify({ items, out: triageFile() })], { timeout: 400000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      this.triaging = false;
      if (r.code !== 0) this.note = `Could not triage: ${r.stderr.trim().slice(0, 200)}`;
      this.loadTriage(cx); cx.notify();
    });
    cx.notify();
  }

  // A PR row's risk signal as chips (views.js riskSignal): the highest severity among its open findings, and
  // security's own mark. Nothing without a cached analysis or findings file.
  riskChips(t, url, id) {
    // One mark (views.js rowMarks): "⛨ high" when an open finding is about security, in the severity's color, on a
    // filled ground when that is confirmed and in a dashed frame with "?" when it is only assumed (as in the review);
    // else the severity in grey.
    // A review in progress has its own mark in the registry (review.js riskOfCounts: with what its probes and checks
    // confirmed): the row shows that one, so it agrees with the minimized chip.
    const own = (shared("review.open") ?? []).find((r) => r.url === url)?.risk;
    return rowMarks(own?.top ? own : this.risk?.get(url), null).map((m) => chip(t, markLabel(div, t, m), t[m.color] ?? t.muted, m.security, `${id}-sev`,
      `The highest severity among this PR's open findings, from the cached analysis and reviews${m.security ? `; ${SEC_MARK}: at least one of them is about security` : ""}${m.words ? `.\n${m.words}` : ""}`));
  }

  // The list of the shown source, one row per PR: the ones under "In progress" are not repeated, open PRs come first
  // with one way into the review each (Resume once started), merged and closed ones are folded under their own row.
  picker(t) {
    const src = this.sourceNow(), sl = this.srcLists[src], inProgress = (shared("review.open") ?? []).filter(shownIn);
    const { list, above, started } = listRows(this.listNow(), inProgress, this.panelProgress().shown);
    // Mine: this space's repo and recent first, the rest folded (views.js mineGroups); the other lists by state.
    // This space: the focused pane's PR first, the recently merged ones in the list with that word (not folded).
    const focus = src === "space" ? this.spaceHeads?.get(location().cwd) ?? null : null;
    const b = byState(list), g = src === "mine" ? mineGroups(list, this.spaceSlug?.slug ?? null) : src === "space" ? { here: spaceOrder(list, focus), other: [], done: [] } : { here: b.open, other: [], done: b.done };
    const open = g.here, done = g.done, rest = g.other;
    const item = (id, on, top, sub, state, tag, click, pr, tagTip = "Agent that opened this PR") => v_flex().id(id).flex_none().px(8).py(4).rounded(7).cursor_pointer().tooltip(pr ? "Select this PR to see its diff" : "Use the diff of the focused pane's branch")
      .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click(click)
      .child(h_flex().gap(6).child(div().flex_1().min_w(0).truncate().child(top)).when(Boolean(state) && state !== "open", (e) => e.child(div().id(`${id}-st`).tooltip(`PR state: ${state}`).flex_none().text_size(TYPE.micro).text_color(t[STATE[state]] ?? t.muted).child(state)))
        .when(Boolean(pr && isOpenPr(pr)), (e) => { // the one way into the review; a merged or closed PR has none
          const r = started.get(pr.url);
          return e.child(r ? pill(`${id}-rv`, t, "Resume", (_e, cx) => { cx.stop_propagation(); this.toReview(r.target ?? r); }, false, "Continue this review where you left it")
            : pill(`${id}-rv`, t, "Review", (_e, cx) => { cx.stop_propagation(); this.pickTarget(pr, cx, true); }, false, "Open this PR in the review layout"));
        }))
      .when(Boolean(sub), (e) => e.child(h_flex().gap(6).text_size(TYPE.panel).text_color(t.muted).child(div().id(`${id}-sub`).tooltip(src === "mine" ? "Repository and the session that opened it" : "Author, review status, lines added and removed, last update").flex_1().min_w(0).truncate().child(sub))
        .when(Boolean(tag), (e) => e.child(div().id(`${id}-tg`).tooltip(tagTip).flex_none().max_w(140).truncate().px(5).rounded(4).bg(t.raised).text_size(TYPE.micro).child(tag)))))
      .when(Boolean(pr && (this.triage?.get(pr.url) || this.risk?.get(pr.url)?.top)), (e) => { // risk first, then the triage card: compact; the why shows on the picked PR
        const tri = this.triage?.get(pr.url);
        // At most three marks (views.js rowMarks): severity with ⛨, then priority and type as plain text.
        const marks = rowMarks(this.risk?.get(pr.url), tri);
        return e.child(h_flex().gap(8).pt(2).items_center().children(this.riskChips(t, pr.url, id))
          .children(marks.filter((m) => m.kind !== "risk").map((m) => div().id(`${id}-${m.kind}`).tooltip(m.kind === "priority" ? PRIORITY_TIP : "The kind of change, from the PR title")
            .text_size(TYPE.panel).text_color(m.kind === "priority" && tri.priority === 1 ? t.foreground : t.muted).child(m.text))))
          .when(on && Boolean(tri?.why), (e) => e.child(div().mt(3).pl(8).border_l(3).border_color(t.accent).text_size(TYPE.panel).line_height(1.4).whitespace_normal().text_color(t.foreground).child(tri.why)));
      });
    // A PR you didn't open: author, draft, review decision, +/−, age; its repo for review requests.
    const other = (p) => [src === "review" ? p.repo : null, p.author ? `@${p.author}` : null, REVIEW[p.review]?.[0],
      p.add != null ? `+${p.add} −${p.del}` : null, p.updatedAt ? age(p.updatedAt) : null].filter(Boolean).join(" · ");
    const row = (p) => (src === "mine"
      ? item(`pick-${p.url}`, this.prSel?.url === p.url, `#${p.number} ${p.title ?? ""}`,
        `${p.repo.split("/").pop()} · ${p.sessionTitle ?? p.session.slice(0, 8)}`, p.state, p.agent && `↳ ${p.agent}`, (_e, cx) => this.choose(p, cx), p)
      : item(`pick-${src}-${p.url}`, this.prSel?.url === p.url, `#${p.number} ${p.title ?? ""}`, src === "space" ? [p.head, other(p)].filter(Boolean).join(" · ") : other(p), p.state,
        focusedPr(p, focus) ? "focused agent" : null, (_e, cx) => this.pickTarget(p, cx), p, "The PR of the branch the focused pane is on"));
    const inView = C.tagged(ctxDoc()) ? " (in this view)" : "", n = open.filter((p) => this.triage?.has(p.url)).length; // triaged rows of this list
    // One sentence for an empty list: what is going on, or what to do.
    const empty = src === "mine" ? (this.scanning ? "Searching transcripts for PRs…" : this.prs.length ? "No recent PRs from Claude sessions in this repository." : "No PRs from Claude sessions") : !sl || sl.loading ? "Asking GitHub…"
      : src === "space" ? (above ? "Every open PR of this space's branches is in progress above." : sl.why ?? "")
      : src === "repo" && sl?.key === null ? "Open a space on a GitHub repo to list its PRs."
      : above ? "Every open PR here is in progress above." : src === "repo" ? `No open PRs in this repo${inView}` : `No open review requests${inView}`;
    return v_flex().flex_none().p(6)
        .child(h_flex().flex_none().flex_wrap().px(4).py(2).gap(6).items_center()
          .child(h_flex().flex_wrap().gap(2).p(2).rounded(7).border_1().border_color(t.border).children(SOURCES.map(([k, label]) =>
            div().id(`pr-src-${k}-${this.uid}`).tooltip(SRC_TIP[k]).px(8).h(24).flex().items_center().rounded(5).cursor_pointer().text_size(TYPE.panel)
              .bg(src === k ? t.selected : t.chrome).text_color(src === k ? t.foreground : t.muted)
              .on_click((_e, cx) => { this.pickSource(k); this.loadSource(cx); cx.notify(); }).child(label))))
          .child(div().id(`pr-srcinfo-${this.uid}`).tooltip(src === "repo" ? "Repository these PRs come from" : "How long ago this list was fetched from GitHub").flex_1().min_w(0).truncate().text_size(TYPE.micro).text_color(t.muted)
            .child(src === "repo" ? this.spaceSlug?.slug ?? "" : sl?.loading ? "loading…" : sl?.at ? (Date.now() - sl.at < 60000 ? "just now" : `${age(new Date(sl.at).toISOString())} ago`) : ""))
          .when(src !== "mine", (e) => e.child(pill(`pr-src-reload-${this.uid}`, t, sl?.loading ? "…" : "↻", (_e, cx) => this.loadSource(cx, true), false, "Fetch this list from GitHub again", "Reload PR list"))))
        .child(h_flex().flex_none().px(4).py(2).gap(6).items_center()
          .child(div().id(`pr-openref-${this.uid}`).flex_1().min_w(0).h(26).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).cursor_text().tooltip("Paste a PR URL or owner/repo#123, then Open")
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.openRefInput).h_full().text_size(TYPE.panel).text_color(t.foreground)))
          .child(pill(`pr-openref-go-${this.uid}`, t, "Open", (_e, cx) => this.openRef(cx), false, "Open the PR typed on the left")))
        .when(Boolean(sl?.error) && src !== "mine", (e) => e.child(div().px(8).py(4).text_size(TYPE.panel).text_color(t.ansi1).whitespace_normal().child(sl.error)))
        // The triage line only when PRs were triaged (Setup is in the header).
        .when(n > 0, (e) => e.child(h_flex().flex_none().px(8).py(4).gap(6).items_center()
          .child(div().id(`pr-triage-info-${this.uid}`).tooltip("Priority and chips come from cached data; no GitHub or AI call").flex_1().min_w(0).truncate().text_size(TYPE.panel).text_color(t.muted).child(n ? `${n} open ${n === 1 ? "PR" : "PRs"} triaged from cached data` : ""))
          .when(n > 0, (e) => e.child(pill(`pr-triage-${this.uid}`, t, this.triaging ? "Triaging…" : "Triage PRs", (_e, cx) => this.runTriage(cx), false, "Rank the listed open PRs with one small AI call per context")))))
        .children(open.map(row))
        .when(rest.length > 0, (e) => e.child(h_flex().id(`pr-other-${this.uid}`).flex_none().mt(4).px(8).h(24).gap(6).items_center().rounded(6).cursor_pointer().text_size(TYPE.panel).text_color(t.muted)
          .tooltip(this.showOther ? "Hide the PRs of other repositories and the ones without activity for 30 days" : "Show the PRs of other repositories and the ones without activity for 30 days").hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.showOther = !this.showOther; cx.notify(); }).child(div().w(10).flex_none().child(this.showOther ? "▾" : "▸")).child(`Other repos or older (${rest.length})`)))
        .when(rest.length > 0 && Boolean(this.showOther), (e) => e.children(rest.map(row)))
        .when(done.length > 0, (e) => e.child(h_flex().id(`pr-done-${this.uid}`).flex_none().mt(4).px(8).h(24).gap(6).items_center().rounded(6).cursor_pointer().text_size(TYPE.panel).text_color(t.muted)
          .tooltip(src === "mine" ? `${this.showDone ? "Hide" : "Show"} this repository's PRs that were merged or closed in the last 14 days. Older ones are not listed: open them by URL above.` : this.showDone ? "Hide the merged and closed PRs" : "Show the merged and closed PRs").hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.showDone = !this.showDone; cx.notify(); }).child(div().w(10).flex_none().child(this.showDone ? "▾" : "▸")).child(`Merged or closed (${done.length})`)))
        .when(done.length > 0 && Boolean(this.showDone), (e) => e.children(done.map(row)))
        .when(!open.length && !rest.length && !done.length, (e) => e.child(div().p(8).whitespace_normal().text_color(t.muted).child(empty)))
        // The current branch last, under a line: it is not one of the listed PRs.
        .child(div().flex_none().mt(6).pt(6).border_t(1).border_color(t.border)
          .child(item("pick-branch", Boolean(this.branchPicked && !this.prSel), "Current branch", "The diff of the focused pane's branch against its base, without a PR", null, null, (_e, cx) => this.choose(null, cx))));
  }

  // One line of the diff. In the panel's list it is one visual line (part: which one of a wrapped line) and carries no
  // handler: the list's on_item_click selects (rowClick). In a walkthrough's hunk (plain) it is drawn whole.
  diffRow(row, i, t, plain = false, part = null) {
    const { kind, number, text } = row;
    if (kind === "@") return div().id(`r-${i}`).w_full().px(12).h(LINE_H).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    const selectable = !plain && (kind === "+" || kind === "-" || kind === " ");
    const lo = Math.min(this.sel ?? -1, this.selEnd ?? this.sel ?? -1), hi = Math.max(this.sel ?? -1, this.selEnd ?? this.sel ?? -1);
    // Wrap (the review's switch, shared "review.wrap"): a long line takes as many visual lines as the panel's width
    // asks for, broken as in the review (views.js wrapCode), each with its colours (sliceSpans).
    const spans = (plain ? null : this.spans?.[i]) ?? [], s = String(text ?? ""), starts = this.lineWraps(row);
    const line = (a, b) => h_flex().h(LINE_H).flex_none().overflow_hidden().children(renderLine(div, s.slice(a, b), starts.length > 1 ? sliceSpans(spans, a, b ?? s.length) : spans, colors(t)));
    return h_flex().id(part ? `r-${i}.${part}` : `r-${i}`).w_full().flex_none().gap(10).items_start()
      .when(kind === "+", (e) => e.bg("#2ea0431a")).when(kind === "-", (e) => e.bg("#f851491a"))
      .when(!plain && i >= lo && i <= hi && this.sel !== null, (e) => e.bg(t.selection))
      .when(selectable, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
      .child(div().w(30).h(LINE_H).flex_none().flex().items_center().justify_end().text_color(t.dim).child(number === undefined || part ? "" : String(number)))
      .child(v_flex().flex_1().min_w(0).overflow_hidden().children(part === null ? starts.map((a, k) => line(a, starts[k + 1])) : [line(starts[part] ?? 0, starts[part + 1])]));
  }
  // Where a line breaks with Wrap on (views.js wrapCode), kept per row and width: every render asks for every row.
  lineWraps(row) {
    if (shared("review.wrap") !== true || row.kind === "@") return ONE_LINE;
    const cols = codeCols(this.panelW ?? 380, 52, 6.6), m = (this.wraps ??= new WeakMap()), hit = m.get(row); // 52: padding, number and gap left of the code; 6.6 px per letter at 11 px
    if (hit?.cols === cols) return hit.starts;
    const starts = wrapCode(String(row.text ?? ""), cols);
    m.set(row, { cols, starts });
    return starts;
  }
  // A click on a line: it is selected (again: no longer), with shift the range from the selected one to it.
  rowClick(i, shift, cx) {
    const kind = this.rows[i]?.kind;
    if (kind !== "+" && kind !== "-" && kind !== " ") return;
    this.fh.focus();
    if (shift && this.sel !== null) this.selEnd = i;
    else { this.sel = this.sel === i && this.selEnd === null ? null : i; this.selEnd = null; }
    this.askTop = false;
    if (this.sel !== null) this.focusInput(cx); // the composer under it takes the typing
  }

  // The diff as the items of the virtual list, each with its key (k) and height (h): the line to comment on the whole
  // file, the comments no line holds any more, then every visual line with its comments and, under the selected
  // lines, the composer. at: Map(row index -> its comments). Also where each row starts (rowAt), for scrollRow.
  diffItems({ composeAt, at, loose, lo }) {
    const items = [], rowAt = new Array(this.rows.length);
    const compose = () => items.push({ t: "ch", k: "ch", h: 34 }, { t: "ci", k: "ci", h: 36 }, { t: "ca", k: "ca", h: 42 });
    const card = (c, label = null) => { if (this.editing?.id === c.id) compose(); else items.push({ t: "bh", k: `bh${c.id}`, c, label, h: 24 }, { t: "bb", k: `bb${c.id}`, c, h: this.boxH(c) }); };
    if (this.open && composeAt !== "top") items.push({ t: "ask", k: "ask", h: 24 });
    if (composeAt === "top") compose();
    for (const c of loose) card(c, c.start === undefined ? "whole file" : `${uiLine(c)} · no longer in the diff`);
    for (let i = 0; i < this.rows.length; i++) {
      const n = this.lineWraps(this.rows[i]).length;
      rowAt[i] = items.length;
      for (let p = 0; p < n; p++) items.push({ t: "row", k: p ? `r${i}.${p}` : `r${i}`, i, p, h: LINE_H });
      for (const c of at.get(i) ?? []) card(c);
      if (composeAt === i && lo >= 0) compose();
    }
    if (items.length > 9990) { const cut = items.length - 9989; items.length = 9989; items.push({ t: "more", k: "more", n: cut, h: 24 }); } // the list's hard limit is 10000
    return { items, rowAt };
  }
  // A comment's text takes the lines its length asks for at the card's width (a stated height, as the list needs).
  boxH(c) {
    const w = Math.max(120, (this.panelW ?? 380) - 2 * PANEL_EDGE);
    return 10 + 17 * String(c.text ?? "").split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(textW(l, TYPE.small) / w)), 0);
  }
  // One item as an element, without a handler (the list's renderer cannot hold one): onDiffItem acts on a press.
  diffItem(it, t, where) {
    if (it.t === "row") return this.diffRow(this.rows[it.i], it.i, t, false, it.p);
    const ui = (e) => e.font_family(settings().ui_font ?? "Geist").text_size(TYPE.small);
    if (it.t === "ask") return div().id(`pr-ask-file-${this.uid}`).w_full().px(12).h(it.h).flex().items_center().font_family(settings().ui_font ?? "Geist").text_size(TYPE.panel).text_color(t.dim).cursor_pointer()
      .tooltip("Write a comment or question about the whole file (c)").hover((s) => s.text_color(t.foreground)).child(`+ Comment or ask about ${this.open?.split("/").pop() ?? "this file"} (or click a line)`);
    if (it.t === "more") return ui(div().w_full().px(12).h(it.h).flex().items_center().text_color(t.dim)).child(`${it.n} more lines are not shown: the list holds about 10000 at once.`);
    // A card is drawn over two or three items: its frame's top on the first, its bottom on the last. Its inner right
    // edge is PANEL_EDGE from the list's (margin, 1 px border, 8 px padding), where panelButtons' last button ends.
    const frame = (color, top, bottom, child) => div().w_full().h(it.h).px(PANEL_EDGE - 9).when(top, (e) => e.pt(4)).when(bottom, (e) => e.pb(4))
      .child(ui(child.size_full().px(8).bg(t.surface).border_x(1).border_color(color).when(top, (e) => e.border_t(1).rounded_t(8)).when(bottom, (e) => e.border_b(1).rounded_b(8)).overflow_hidden()));
    // The row's buttons, in panelButtons' order and widths; look(key, element) gives each its label and colors.
    const o = this.buttonOpts(), row = panelButtons(it.t, o), canSend = Boolean((this.root || this.pr) && !this.sending), ready = Boolean(this.question.trim() && canSend);
    const buttons = (look) => row.list.map((b) => look(b.key, div().flex_none().w(b.w).flex().items_center().justify_center()));
    const act = (e, id, label, on, solid, tip) => e.id(`${id}-${this.uid}`).tooltip(tip).h(26).rounded(6)
      .when(solid, (x) => x.bg(on ? t.solid : t.raised).text_color(on ? t.solid_foreground : t.dim)).when(!solid, (x) => x.border_1().border_color(t.border).text_color(on ? t.foreground : t.dim))
      .when(on, (x) => x.cursor_pointer()).child(label);
    if (it.t === "bh") return frame(t.border, true, false, h_flex().gap(row.gap).items_center().text_size(TYPE.micro).text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().child(it.label ?? uiLine(it.c)))
      .children(buttons((key, e) => (key === "edit" ? e.id(`ce-${it.c.id}`).tooltip("Edit this comment").cursor_pointer().hover((s) => s.text_color(t.foreground)).child("Edit")
        : e.id(`cd-${it.c.id}`).tooltip("Delete this comment; it has not been sent").cursor_pointer().hover((s) => s.text_color(t.ansi1)).child("Delete")))));
    if (it.t === "bb") return frame(t.border, false, true, div().whitespace_normal().line_height(1.4).child(it.c.text));
    if (it.t === "ch") return frame(t.accent, true, false, h_flex().gap(row.gap).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(TYPE.panel).text_color(t.dim).child(this.editing ? "Editing comment (Esc: cancel)" : `On ${where}`))
      .children(buttons((key, e) => { const k = Number(key.split(":")[1]); return e.id(`preset-${k}-${this.uid}`).tooltip(`Send this question to the agent now: ${PRESETS[k][1]}`).h(22).rounded(5).border_1().border_color(t.border)
        .text_size(TYPE.panel).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground)).child(PRESETS[k][0]); })));
    if (it.t === "ci") return frame(t.accent, false, false, div().py(3).child(div().id("pr-question").tooltip("Type a comment or a question about the selected lines").h(30).px(8).flex().items_center().rounded(6).border_1()
      .border_color(this.typing ? t.accent : t.border).cursor_text().child(Input.new(this.input).h_full().text_size(TYPE.small).text_color(t.foreground))));
    return frame(t.accent, false, true, h_flex().gap(row.gap).justify_end().items_center().children(buttons((key, e) => // "ca": the composer's buttons
      (key === "cancel" ? act(e, "pr-cancel", "Cancel", true, false, "Close without saving (Esc)")
        : key === "comment" ? act(e, "pr-comment", this.editing ? "Save" : "Comment", Boolean(this.question.trim() && this.open), false, this.editing ? "Save the changed comment" : "Add to the pending review; nothing is sent yet")
          : act(e, "pr-ask", this.sending ? "…" : "Ask", ready, true, "Send this question to the coding agent now")))));
  }
  buttonOpts() { return { editing: Boolean(this.editing), presets: PRESETS.map(([label]) => label) }; }
  // A press on an item of the diff's list (its key): a line is selected; a card's button is the one under the press
  // (this.press: where the mouse went down, from the list's own handler; views.js panelHit finds the button).
  onDiffItem(key, cx) {
    const { x = 0, w = this.panelW ?? 380, shift = false } = this.press ?? {}, hit = (kind) => panelHit(kind, x, w, this.buttonOpts());
    if (key[0] === "r") this.rowClick(Number.parseInt(key.slice(1), 10), shift, cx); // "r12", or "r12.1": a wrapped line's second visual line
    else if (key === "ask") { this.sel = null; this.selEnd = null; this.askTop = true; this.focusInput(cx); }
    else if (key === "ci") this.focusInput(cx);
    else if (key === "ch") { const b = hit("ch"); if (b) this.ask(cx, PRESETS[Number(b.split(":")[1])][1]); else this.focusInput(cx); }
    else if (key === "ca") { const b = hit("ca"); if (b === "cancel") this.closeAsk(cx); else if (b === "comment") this.addComment(cx); else if (b === "ask") this.ask(cx); else this.focusInput(cx); }
    else if (key.startsWith("bh")) { const c = this.comments.find((c0) => `bh${c0.id}` === key), b = c ? hit("bh") : null; if (b === "edit") this.editComment(c, cx); else if (b === "delete") this.dropComment(c, cx); }
    cx.notify();
  }

  // Reviews started and not done (shared "review.open", written by the review layout): Resume goes back to exactly
  // where it was, a click on the row shows the PR's diff here like a row of the list. Under the title the risk signal
  // and the progress, wrapped; when it was last touched is in the row's tooltip. Only the contexts the view shows,
  // each tagged when there are several.
  openReviews(t) {
    const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
    const { shown, more, total, left } = this.panelProgress(), old = (r) => Date.now() - (r.lastTouched ?? 0) > DONE_DAYS * 86400000;
    // A review that stood here a moment ago and whose PR was merged or closed since: said once, in a line of its own.
    const gone = leftNow(this.inProg, left);
    if (gone) { this.leftNote = gone; this.leftUrls = new Set(left.map((r) => r.url)); }
    else if (this.leftNote && shown.some((r) => this.leftUrls?.has(r.url))) this.leftNote = null; // listed again (its state is unknown again): the line no longer holds
    this.inProg = new Set(shown.map((r) => r.url));
    const drop = (r) => pill(`pr-drop-${r.url}`, t, "✕", (_e, cx) => { cx.stop_propagation(); this.dropReview(r.url, cx); }, false, "Remove from In progress. Your comments and progress are kept; opening the review again brings it back.", "Remove from In progress");
    return v_flex().flex_none().px(10).pt(8).pb(4).gap(2).border_b(1).border_color(t.border)
      .child(h_flex().px(4).gap(8).items_center().child(div().flex_1().text_size(TYPE.panel).font_semibold().text_color(t.muted).child("In progress"))
        .when(Boolean(this.allOpen) && more > 0, (e) => e.child(pill(`pr-open-less-${this.uid}`, t, "Show fewer", (_e, cx) => { this.allOpen = false; cx.notify(); }, false, "Show only the most recent reviews"))))
      .children(shown.map((r) => [r, this.riskChips(t, r.url, `pr-open-${r.url}`)]).map(([r, risk]) => h_flex().id(`pr-open-${r.url}`).gap(8).px(4).py(3).rounded(6).items_start().cursor_pointer().tooltip(`Select this PR to see its diff. Last touched ${ago(r.lastTouched)}.`)
        .when(this.prSel?.url === r.url, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pickTarget(r.target ?? r, cx))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().text_size(TYPE.small).when(old(r), (e) => e.text_color(t.muted)).child(`#${r.number} ${r.title ?? ""}`))
          .when(risk.length > 0, (e) => e.child(h_flex().flex_wrap().gap(4).children(risk)))
          .child(div().whitespace_normal().text_size(TYPE.panel).text_color(t.muted).child([r.status === "sent" ? "sent" : null, progressText(r.progress), old(r) ? `last touched ${ago(r.lastTouched)}` : null].filter(Boolean).join(" · "))))
        .when(C.tagged(ctxDoc()), (e) => e.child(ctxTag(t, prCtx(r), r.url)))
        .child(pill(`pr-resume-${r.url}`, t, "Resume", (_e, cx) => { cx.stop_propagation(); this.toReview(r.target ?? r); }, false, "Continue this review where you left it"))
        .child(drop(r))))
      // Merged or closed since: dimmed, with the word; nothing leaves this list without saying why.
      .children(left.map((r) => h_flex().id(`pr-left-${r.url}`).gap(8).px(4).py(3).rounded(6).items_center().cursor_pointer().tooltip(`This PR was ${r.state}. Select it to see its diff, or remove it from In progress.`)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pickTarget(r.target ?? r, cx))
        .child(div().flex_1().min_w(0).truncate().text_size(TYPE.small).text_color(t.dim).child(`#${r.number} ${r.title ?? ""}`))
        .child(div().flex_none().text_size(TYPE.micro).text_color(t[STATE[r.state]] ?? t.muted).child(r.state))
        .child(drop(r))))
      .when(more > 0 && !this.allOpen, (e) => e.child(div().id(`pr-open-all-${this.uid}`).px(4).py(3).text_size(TYPE.panel).text_color(t.accent).cursor_pointer().tooltip("List every review in progress: also the ones of other repositories and the ones not touched for more than 14 days")
        .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.allOpen = true; cx.notify(); }).child(`Show ${more} more: other repos or older`)))
      .when(Boolean(this.leftNote), (e) => e.child(div().id(`pr-left-note-${this.uid}`).px(4).py(3).text_size(TYPE.panel).text_color(t.muted).whitespace_normal().child(this.leftNote)))
      .when(Boolean(this.undo), (e) => e.child(h_flex().px(4).py(3).gap(8).items_center().text_size(TYPE.panel).text_color(t.muted)
        .child(div().flex_1().min_w(0).whitespace_normal().child(removedText(this.undo)))
        .child(pill(`pr-undrop-${this.uid}`, t, "Undo", (_e, cx) => this.undoDrop(cx), false, "Put this review back into In progress"))));
  }

  // What "In progress" shows in this view (views.js progressRows): reviews with work in them, the recent ones first;
  // the older ones behind "Show all"; the merged and closed ones dimmed.
  panelProgress() { return progressRows((shared("review.open") ?? []).filter(shownIn), { states: this.statesNow(), slug: this.spaceSlug?.slug ?? null, all: Boolean(this.allOpen) }); }
  // What is known of PR states: prs.json and the lists fetched from GitHub (url -> open, draft, merged, closed).
  statesNow() {
    return new Map([...Object.values(this.srcLists ?? {}).flatMap((l) => l?.prs ?? []), ...this.prs].map((p) => [p.url, p.state]));
  }
  // The registry file with `change` applied to its list, compare-and-swap (the review layout writes it too).
  async writeRegistry(change) {
    const file = `${appHome()}/pr-data/open-reviews.json`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await readTextFile(file).catch(() => null);
      try { await writeTextFile(file, JSON.stringify(change(JSON.parse(before ?? "[]")), null, 1), before); return; } catch { /* written meanwhile: again */ }
    }
  }
  // ✕ on a row of In progress: the review counts as done (pr-data/open-reviews.json, shared "review.open"). Its
  // comments stay in reviews.json and its progress in review-progress.json: opening it again resumes where it was and
  // puts it back (pr.js touchReview). The entry is kept for "Undo" until the next pick.
  dropReview(url, cx) {
    this.undo = (shared("review.open") ?? []).find((r) => r.url === url) ?? null; this.leftNote = null;
    if (shared("review.minimized")?.target?.url === url) setShared("review.minimized", null); // its chip over the terminal goes with it
    setShared("review.open", (shared("review.open") ?? []).filter((r) => r.url !== url));
    cx.spawn(() => this.writeRegistry((list) => list.map((r) => (r.url === url ? { ...r, status: "done", doneAt: Date.now() } : r))));
  }
  // "Undo": the entry as it was, back where the file has it (or in front when it is gone from there).
  undoDrop(cx) {
    const entry = this.undo;
    if (!entry) return;
    this.undo = null;
    setShared("review.open", [entry, ...(shared("review.open") ?? []).filter((r) => r.url !== entry.url)].sort((a, b) => (b.lastTouched ?? 0) - (a.lastTouched ?? 0)));
    cx.spawn(() => this.writeRegistry((list) => (list.some((r) => r.url === entry.url) ? list.map((r) => (r.url === entry.url ? entry : r)) : [entry, ...list])));
    cx.notify();
  }
  // The minimized review's chip goes once its PR is merged or closed (it was kept in shared.json for good).
  dropMinimized() {
    const m = shared("review.minimized"), st = m?.target?.url && this.statesNow().get(m.target.url);
    if (st === "merged" || st === "closed") { setShared("review.minimized", null); this.leftNote = `The minimized review of #${m.target.number} was closed: its PR was ${st}.`; }
  }
  // Another Herdr space: its own pick (else the list) and its repo's lists; the diff follows (render: key changed).
  onSpace(cx) {
    const url = (shared("pr.selected") ?? {})[selKey()];
    this.prSel = url && url !== BRANCH ? this.prs.find((p) => p.url === url) ?? (shared("pr.picked") ?? {})[url] ?? null : null;
    this.branchPicked = url === BRANCH; this.picking = false; this.srcAsked = false; this.spaceSlug = null; this.showOther = false; this.spaceAuto = null; this.spaceHeads = null;
    if (!this.prSel && !this.branchPicked) this.loadSource(cx);
    cx.notify();
  }

  // ---- "Open in <Editor> ↗" (editor-view.js), for every part of the mod
  // The checkout a link opens: for a PR the one the review uses (shared "review.worktree": the PR's head as files),
  // for the current branch the repo of the focused pane; null: there is none, and no link.
  checkoutRoot() {
    if (this.part === "review") return this.worktree?.path ?? null;
    const pr = this.part === "mini" ? shared("review.minimized")?.target : this.prSel, w = shared("review.worktree");
    return pr ? (w?.url === pr.url ? w.path ?? null : null) : !this.part && this.branchPicked ? this.root ?? null : null;
  }
  // A file head's path to drag onto a terminal: the file in that checkout, or null (views.js dragPath).
  fileDragPath(f) { return dragPath(this.checkoutRoot(), f); }
  // A PR from a source that is not trusted: a click opens the file alone, never its folder.
  editorForeign() { const pr = this.part === "mini" ? shared("review.minimized")?.target : this.prSel; return pr ? !this.trustedPr(pr) : false; }
  // A click: one process; the link says "Opening …" for three seconds, a failure is a toast (editor-view.js startOpen).
  openEditor(target, cx, id = null) { startOpen(target, cx, id); }

  // Into the review from the panel. Whether the list was shown then is kept (shared "pr.listed"): back from a review
  // opened from the list, the list is shown again, with the review's PR as the pick behind "Back to #n →".
  toReview(target) {
    if (!this.part) setShared("pr.listed", Boolean(this.picking || !(this.prSel ?? this.branchPicked)));
    return startReview(target);
  }

  // The current branch's PR as a review target: no session, so what is sent goes to this space's agent.
  branchTarget(pr = this.pr, root = this.root) {
    const repo = /github\.com\/([^/]+\/[^/]+)\/pull/.exec(pr.url)?.[1];
    return { url: pr.url, number: pr.number, title: pr.title, repo, state: "open", base: pr.baseRefName,
      context: this.ctxId(), session: null, cwd: root, space: location().space, headSha: pr.headRefOid ?? null };
  }
  // The "review" command: the chosen PR, else the PR of the current branch. With the list shown that branch is not
  // loaded (nothing is diffed behind the list), so its PR is asked for here: one gh pr view.
  reviewNow(cx) {
    if (this.prSel) return this.toReview(this.prSel);
    if (this.pr?.url) return this.toReview(this.branchTarget());
    const { cwd } = location();
    cx.spawn(async (cx) => {
      const repo = cwd ? await this.repoOf(cwd) : null;
      const view = repo ? await exec("gh", ["pr", "view", "--json", "number,title,url,baseRefName,headRefOid"], { cwd: repo.root }).catch(() => null) : null;
      const pr = view?.code === 0 ? JSON.parse(view.stdout) : null;
      if (pr?.url) return this.toReview(this.branchTarget(pr, repo.root));
      this.note = repo ? "The current branch has no pull request to review." : "No pull request to review: the focused pane is not in a git repository.";
      cx.notify();
    });
  }

  // Removed or closed: Go to stops offering "Review PR" (a stale handler would hand PRs to nobody). Another copy
  // that still runs announces them again on its next render.
  async close() {
    // The folders this copy watched are let go: the shown repos (watch) and the review's findings and replies.
    this.closed = true;
    const watches = [this.findWatch, this.replyWatch, ...(this.watching?.values() ?? [])];
    this.watching?.clear();
    for (const w of watches) w?.cancel();
    if (!this.announces) return;
    setShared("goto.handlers.review", null);
    setShared("goto.items.review", null);
  }

  // This copy's commands (keys.json "pr-review.<name>", herdr-app do): a loop on nextCommand(). A command that throws
  // is said in the footer and the loop goes on. One whose slice Herdr stops (a task may run about a second: 0.4 s
  // went through, 1.5 s did not) takes the loop's task with it, and no key of the review did anything from then on:
  // cmdAt is the time the running command started (0: none runs), and a frame that finds it older than CMD_STALE
  // starts the loop again (stillListening). redraw: whether a command is followed by a frame.
  listen(cx, run, redraw = true) {
    this.cmdRun = run; this.cmdRedraw = redraw; this.cmdAt = 0;
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand());
        this.cmdAt = Date.now();
        try { run(c, cx); } catch (e) { this.note = `The command "${c.split(":")[0]}" failed: ${String(e).replace(/^Error: /, "")}`; }
        this.cmdAt = 0;
        if (redraw) cx.notify();
      }
    });
  }
  stillListening(cx) { if (this.cmdAt && Date.now() - this.cmdAt > CMD_STALE) this.listen(cx, this.cmdRun, this.cmdRedraw); }

  render(cx) {
    this.stillListening(cx);
    if (this.announces && !shared("goto.handlers.review") && !this.announceQueued) {
      this.announceQueued = true;
      cx.timer.after(0, () => { this.announceQueued = false; this.publishGoto(); });
    }
    // The small copies read Herdr's live data for the big ones (live.js). A terminal the review shows the state of
    // changed: one shared write makes the review draw.
    if ((this.part === "mini" || this.part === "bar") && feed() && !this.liveQueued) { this.liveQueued = true; cx.timer.after(0, () => { this.liveQueued = false; setShared("review.watched", Date.now()); }); }
    if (this.part === "bar") return this.renderBar(cx);
    if (this.part === "reviews") return renderReviews();
    if (this.part === "agentbar") return renderAgentBar();
    if (this.part === "keys") return renderKeys();
    if (this.part === "cmenu") return renderCardMenu();
    if (this.part === "mini") {
      // The view shows other contexts than the list for the Worktrees mod was made for, and no panel is there to
      // write it anew: an empty list as of now, so no PR of the other setup stays up as if it were current.
      const wl = shared("worktrees.prs.review");
      if (wl?.prs?.length && wl.view !== viewKey() && !this.wtQueued) {
        this.wtQueued = true;
        cx.timer.after(0, () => { this.wtQueued = false; const now = shared("worktrees.prs.review"); if (now?.prs?.length && now.view !== viewKey()) setShared("worktrees.prs.review", wtList([])); });
      }
      // Go to hands PRs over through "pr.goto"; with the PR panel hidden nothing else takes it, and the mini part is in
      // the main layout: resume a review in progress, else open the PR in the review layout.
      const g = shared("pr.goto");
      if (g?.url && !this.gotoQueued) {
        this.gotoQueued = true;
        cx.timer.after(0, () => {
          this.gotoQueued = false;
          const h = shared("pr.goto"), r = h?.url && (shared("review.open") ?? []).find((x) => x.url === h.url), ref = h?.url && !r ? parsePrRef(h.url) : null;
          if (!r && !ref) return;
          setShared("pr.goto", null);
          this.toReview(r ? r.target ?? r : { url: ref.url, repo: ref.repo, number: Number(ref.number), source: "open" });
        });
      }
      return renderMini(this.miniRun ?? null);
    }
    if (this.part === "review") {
      // Go to hands PRs over through "pr.goto"; the panel isn't mounted while the review layout shows, so take it here.
      if (shared("pr.goto")?.url && !this.gotoQueued) { this.gotoQueued = true; cx.timer.after(0, (cx) => { this.gotoQueued = false; this.takeGoto(cx); }); }
      // The panel's "Finish your review" hands over through "pr.finish" ({url, at}): once that PR's comments are
      // loaded here, the popover opens (the "finish" command, a toggle). A stale or foreign one is dropped.
      const fin = shared("pr.finish");
      if (fin && !this.finishQueued && (this.reviewKey === fin.url || Date.now() - fin.at > 60000)) {
        this.finishQueued = true;
        cx.timer.after(0, (cx) => { this.finishQueued = false; setShared("pr.finish", null); if (this.reviewKey === fin.url && !this.finishOpen) { this.command("finish", cx); cx.notify(); } });
      }
      // drawing: still set from the frame before when Herdr stopped that one before its end (not even a finally runs then).
      this.frameCut(Boolean(this.drawing));
      this.drawing = true;
      let el;
      try { el = this.renderReview(cx); } finally { this.drawing = false; } // an exception is not a stopped frame
      layoutPump(cx); // the pictures laid out in this frame: the search for their better layout after it (stack.js), a timer only when one was
      return el;
    }
    if (this.view === "walk" && this.walkModel && walkModel() !== this.walkModel && !this.walkBusy) this.openWalk(cx, false); // picker changed: that model's cache
    // Go to: a handed-over PR (outside render), and the reviews-in-progress items when that list changes.
    if (shared("pr.goto")?.url && !this.gotoQueued) { this.gotoQueued = true; cx.timer.after(0, (cx) => { this.gotoQueued = false; this.takeGoto(cx); }); }
    // shared() hands out a new object each time: compared by what the items are made of (views.js openSig), not by identity.
    if (openSig(shared("review.open")) !== this.gotoSig) { this.gotoSig = openSig(shared("review.open")); cx.timer.after(0, () => this.publishGoto()); }
    // Worktrees came (or went), or the view shows other contexts: its list again (written only when it differs).
    { const wk = `${Boolean(shared("worktrees.api"))}|${viewKey()}`; if (wk !== this.wtKey) { this.wtKey = wk; this.wtSig = null; cx.timer.after(0, () => this.publishWorktrees()); } }
    // A PR asked for by a click elsewhere (wantPick), also one from before this panel was there.
    if (shared("pr.pick") && !this.pickQueued) { this.pickQueued = true; cx.timer.after(0, (cx) => { this.pickQueued = false; this.takePick(cx); }); }
    if (this.spaceSeen !== undefined && location().space !== this.spaceSeen) { this.spaceSeen = location().space; cx.timer.after(0, (cx) => this.onSpace(cx)); }
    if (!this.scanQueued && this.scanDue()) { this.scanQueued = true; cx.timer.after(0, (cx) => { this.scanQueued = false; this.scanIfDue(cx); }); }
    // The selection is never dropped here: a PR the view hides gets a banner instead.
    // refresh() notifies, which render may not: queue it once, right after this render.
    // Only for what is shown: behind the list nothing is diffed (a focus change or a file written there costs nothing).
    if (!this.refreshQueued && visible() && (this.prSel ? !this.picking : this.showsBranch()) && (this.key() !== this.context || (!this.prSel && this.root && this.dirty.has(this.root)))) {
      this.refreshQueued = true;
      cx.timer.after(0, (cx) => { this.refreshQueued = false; const same = this.key() === this.context; this.refresh(cx, same, same); });
    }
    const t = theme();
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const named = this.pr ?? this.prSel, title = named ? `#${named.number} ${named.title ?? ""}` : this.base ? `vs ${this.base}` : "PR";
    const anchor = this.anchor();
    const where = this.open ? `${this.open.split("/").pop()}${anchor?.start !== undefined ? " " + uiLine(anchor) : ""}` : "whole diff";
    const canSend = Boolean((this.root || this.pr) && !this.sending);
    // Comments of the open file under their last line; the rest (whole file, line gone) above the diff.
    const mine = this.comments.filter((c) => c.file === this.open), at = new Map(), loose = [];
    for (const c of mine) { const i = anchorRow(this.rows, c); if (i < 0) loose.push(c); else at.set(i, [...(at.get(i) ?? []), c]); }
    // Syntax colours outside render, a slice at a time (a big file takes longer than Herdr's ~50 ms per slice); the
    // rows show plain until their file is done.
    // New rows (the file changed on disk): until they are coloured, a row whose text stayed keeps its colours.
    if (this.hl?.rows !== this.rows) {
      const old = this.hl?.spans && this.hl.file === this.open ? this.hl : null;
      this.hl = { rows: this.rows, file: this.open, job: highlightJob(this.rows, langOf(this.open ?? "", this.rows.first)), spans: null, kept: old && this.rows.map((r, i) => (old.rows[i]?.text === r.text ? old.spans[i] : null)) };
      this.highlightMore(cx, this.hl);
    } else if (!this.hl.spans && Date.now() - this.hl.at > HL_STALE) this.hl.spans = this.rows.map((_r, i) => this.hl.kept?.[i] ?? []); // its slice never came back
    this.spans = this.hl.spans ?? this.hl.kept;
    const diffId = `pr-diff-${this.uid}`;
    const state = this.view === "setup" ? "setup" : panelState({ chosen: this.prSel ?? (this.branchPicked || this.restoring), picking: this.picking });
    const tab = bodyTab(this.view), chosen = this.prSel ? `#${this.prSel.number}` : "branch";
    if (state === "picking" && !this.srcAsked) { this.srcAsked = true; cx.timer.after(0, (cx) => this.loadSource(cx)); } // the list, once, after this render
    const back = (_e, cx) => { this.picking = true; this.loadSource(cx); cx.notify(); };
    const resume = this.pr?.url ? (shared("review.open") ?? []).find((r) => r.url === this.pr.url) : null; // this PR's review in progress
    // The header: picking shows the list's title (and the way back to the chosen PR); a chosen PR its title and actions.
    const header = state === "selected"
      ? h_flex().min_h(42).flex_none().flex_wrap().justify_end().pl(8).pr(10).py(5).gap(6).items_center().border_b(1).border_color(t.border) // narrow: the buttons wrap under the title
        .child(div().id(`pr-back-${this.uid}`).flex_none().w(26).h(26).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("All PRs").on_click(back).child("←"))
        .child(div().id(`pr-title-${this.uid}`).tooltip(title).flex_1().min_w(150).max_h(36).overflow_hidden().whitespace_normal().line_height(1.35).font_semibold().child(title)) // two lines, then cut
        .child(pill(`pr-reload-${this.uid}`, t, this.loading && !this.quietLoad ? "…" : "↻", (_e, cx) => { if (this.prSel) this.heads.delete(this.prSel.url); this.refresh(cx, true); }, false, "Reload this PR's diff and details", "Reload PR"))
        .children(editorLink(this, t, `hd-${this.uid}`, { root: this.checkoutRoot(), foreign: this.editorForeign() }, cx)) // the PR's checkout (a trusted PR), or the branch's repo
        .when(Boolean(named?.url), (e) => e.child(pill("pr-web", t, "GitHub ↗", () => openUrl(named.url), false, "Open this PR on GitHub in the browser")))
        // The way into the review is the header's one filled button; Resume once this PR's review was started.
        .when(Boolean(this.pr?.url), (e) => e.child(div().id(`pr-rv-${this.uid}`).tooltip(resume ? "Continue this review where you left it" : "Open this PR in the review layout").flex_none().px(12).h(26).flex().items_center().rounded(6)
          .text_size(TYPE.small).font_semibold().bg(t.solid).text_color(t.solid_foreground).cursor_pointer().on_click(() => this.toReview(resume?.target ?? this.prSel ?? this.branchTarget())).child(resume ? "Resume" : "Review")))
      : h_flex().min_h(42).flex_none().flex_wrap().justify_end().px(14).py(5).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(110).truncate().font_semibold().child(state === "setup" ? "Setup" : "Pull requests"))
        .when(state === "picking", (e) => e.child(pill(`pr-explore-${this.uid}`, t, "Explore…", () => startExplore(location().cwd ?? null), false, "Explore a topic: ask about something in this repo's code, in the review layout"))
          .child(pill(`pr-setup-${this.uid}`, t, "Setup", (_e, cx) => { this.picking = false; this.view = "setup"; runSetup(this, cx, false); cx.notify(); }, false, "Check which programs this mod needs are installed")))
        .when(state === "picking" && Boolean(this.prSel ?? this.branchPicked), (e) => e.child(pill(`pr-pick-done-${this.uid}`, t, `Back to ${chosen} →`, (_e, cx) => { this.picking = false; cx.notify(); }, false, this.prSel ? `Return to PR ${chosen}` : "Return to the current branch's diff")));
    // The selected PR's tabs: Diff | Walkthrough, its size; a branch diff also offers its files as they are now.
    const seg = (k, label, click) => div().id(`pr-tab-${k}-${this.uid}`).px(10).h(22).flex().items_center().rounded(5).cursor_pointer().text_size(TYPE.small).tooltip(k === "diff" ? "Changed files and the diff; click a line to comment" : "The review's AI analysis in reading order, if you ran it")
      .bg(tab === k ? t.selected : t.chrome).text_color(tab === k ? t.foreground : t.muted).on_click(click).child(label);
    const tabs = h_flex().flex_none().flex_wrap().px(10).py(6).gap(8).items_center().border_b(1).border_color(t.border)
      .child(h_flex().flex_none().p(2).gap(2).rounded(7).border_1().border_color(t.border)
        .child(seg("diff", "Diff", (_e, cx) => { this.view = "diff"; cx.notify(); }))
        .child(seg("walk", "Walkthrough", (_e, cx) => this.openWalk(cx, false))))
      .child(h_flex().flex_1().gap(6).items_center().text_size(TYPE.panel).when(!this.files.length, (e) => e.invisible()).child(div().id(`pr-add-${this.uid}`).tooltip("Lines added in this diff").text_color(t.ansi2).child(`+${add}`)).child(div().id(`pr-del-${this.uid}`).tooltip("Lines removed in this diff").text_color(t.ansi1).child(`−${del}`))
        // What the review knows of this PR (loadMarks): its risk mark and how many findings are unresolved.
        .children(named?.url ? this.riskChips(t, named.url, `pr-sel-${this.uid}`) : [])
        // The count is the review's own (its registry entry: findings of several sources merged), so both places agree.
        .when(Boolean(resume?.progress?.findingsOpen), (e) => e.child(div().id(`pr-sel-n-${this.uid}`).tooltip("Unresolved findings in this PR's review. Resume shows them.")
          .text_color(t.muted).child(`${resume.progress.findingsOpen} unresolved`))))
      .when(tab === "diff" && this.files.length > 0, (e) => e.child(pill(`pr-wrap-${this.uid}`, t, shared("review.wrap") === true ? "Wrap on" : "Wrap off", () => setShared("review.wrap", shared("review.wrap") !== true), false,
        "Long lines wrap, or are cut at the panel's edge. The review's Line wrap switch is the same setting.")))
      .when(tab === "diff" && Boolean(this.open && !this.patch), (e) => e
        .child(pill(`mode-${this.uid}`, t, this.mode === "file" ? "Diff view" : "File view", (_e, cx) => this.setMode(this.mode === "file" ? "diff" : "file", cx), false, "Switch between the diff and the whole file")));
    // The open file at the picked line, in the person's editor: for a branch, and for a PR whose checkout the review
    // made. It stands at the file's name in the list (the open file's row), its ▾ at the link.
    const fileLink = () => editorLink(this, t, `file-${this.uid}`, { root: this.checkoutRoot(), file: this.open, line: (this.sel !== null && this.rows[this.sel]?.number) || this.rows.find((r) => r.number)?.number || null, foreign: this.editorForeign(), where: this.prSel ? "in the checkout of this PR" : "in this checkout" }, cx);
    // Picking: reviews in progress and the sources' list in one scroll, so nothing stacks over anything.
    // The bodies are built only when they are shown (pickBody, files, diffBody are asked for below): a frame with a
    // PR chosen built the whole list of PRs before, and one with the list shown every file and diff line.
    const pickId = `pr-pick-${this.uid}`;
    const pickBody = () => div().flex_1().min_h(0).relative()
      .child(v_flex().id(pickId).absolute().inset_0().overflow_y_scroll()
        .when((({ shown, left }) => shown.length + left.length > 0 || Boolean(this.undo))(this.panelProgress()), (e) => e.child(this.openReviews(t)))
        .child(this.picker(t)))
      .child(Scrollbar.vertical(pickId).absolute().inset_0());
    // The composer: under the selected lines, at the top for the whole file, or in place of the comment being edited.
    const lo = Math.min(this.sel ?? -1, this.selEnd ?? this.sel ?? -1), hi = Math.max(this.sel ?? -1, this.selEnd ?? this.sel ?? -1);
    const composeAt = this.editing || this.mode === "file" ? null : this.askTop ? "top" : this.sel !== null ? hi : null;
    const diffLines = () => {
      const list = this.diffItems({ composeAt, at, loose, lo });
      // A line to bring into view (j/k, a file just opened, a context come back to): asked of the list once it is
      // drawn with its items.
      if (this.scrollRow !== null && this.scrollRow !== undefined && list.items.length) {
        if (this.scrollRow === "top") this.diffList.scroll_to_item(0, "top"); else this.diffList.scroll_to_item(list.rowAt[this.scrollRow] ?? 0, "center");
        this.scrollRow = null;
      }
      return list.items.length
        ? v_virtual_list(diffId, list.items.length, list.items.map((it) => it.h), (i) => list.items[i].k, (range) => list.items.slice(range.start, range.end).map((it) => this.diffItem(it, t, where)))
          .track_scroll(this.diffList).on_item_click((key, cx) => this.onDiffItem(key, cx)).size_full()
        : div();
    };
    // At most FILES_MAX files at once, the rest behind one line: 2000 files would be 12000 elements in every frame.
    // The open file is always among the shown ones.
    const allFiles = this.files.length <= FILES_MAX || this.moreFiles === this.files || this.files.findIndex((f) => f.path === this.open) >= FILES_MAX, listed = allFiles ? this.files : this.files.slice(0, FILES_MAX);
    const files = () => div().flex_none().h(Math.max(44, Math.min(this.files.length * 28 + 12, Math.max(200, Math.floor((this.panelH ?? 0) * 0.4))))).relative() // every file, up to 40 % of the panel.border_b(1).border_color(t.border)
      .child(v_flex().id(`pr-files-${this.uid}`).absolute().inset_0().overflow_y_scroll().p(6).children(listed.map((f) => {
        const parts = f.path.split("/"), name = parts.pop(), n = this.comments.filter((c) => c.file === f.path).length, drag = this.fileDragPath(f);
        return h_flex().id(`f-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().tooltip(drag ? `${f.path}. Drag it onto a terminal to paste its path.` : f.path)
          .when(Boolean(drag), (e) => e.drag_paths([drag])) // a click still picks the file
          .when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.fh.focus(); this.askTop = false; this.pick(f.path, cx); })
          .child(h_flex().flex_1().min_w(0).items_center().child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().min_w(0).truncate().child(name))
            .when(this.open === f.path, (e) => e.child(h_flex().flex_none().ml(8).children(fileLink()))))
          .children(rowMarks(this.fileMarks?.get(f.path), null).map((m) => chip(t, markLabel(div, t, m), t[m.color] ?? t.muted, m.security, `f-r-${f.path}`,
            `The highest severity among this file's unresolved findings, from the cached analysis and reviews${m.words ? `: ${m.words}` : ""}. Open the review to see them.`)))
          .when(n > 0, (e) => e.child(div().id(`f-c-${f.path}`).tooltip(`${n} pending ${n === 1 ? "comment" : "comments"} on this file`).text_size(TYPE.micro).text_color(t.accent).child(`● ${n}`)))
          .when(f.add > 0, (e) => e.child(div().id(`f-a-${f.path}`).tooltip("Lines added in this file").text_size(TYPE.panel).text_color(t.ansi2).child(`+${f.add}`)))
          .when(f.del > 0, (e) => e.child(div().id(`f-d-${f.path}`).tooltip("Lines removed in this file").text_size(TYPE.panel).text_color(t.ansi1).child(`−${f.del}`)));
      })).when(!allFiles, (e) => e.child(div().id(`pr-files-more-${this.uid}`).h(28).flex_none().px(8).flex().items_center().rounded(7).text_size(TYPE.panel).text_color(t.accent).cursor_pointer()
        .tooltip("List every changed file").hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.moreFiles = this.files; cx.notify(); }).child(`Show ${this.files.length - FILES_MAX} more files`)))
        .when(!this.files.length, (e) => e.child(div().p(8).whitespace_normal().text_color(this.error ? t.ansi1 : t.dim).child(this.error || ((this.loading && !this.quietLoad) || this.restoring ? Spin(t, "Loading…") : "No changes against the base")))))
      .child(Scrollbar.vertical(`pr-files-${this.uid}`).absolute().inset_0());
    const diffBody = () => (this.mode === "file"
      ? div().flex_1().min_h(0).relative()
        .child(this.code ? Editor.new(this.code).size_full()
          : this.md !== null ? v_flex().id(`pr-md-${this.uid}`).absolute().inset_0().overflow_y_scroll().p(14).child(TextView.markdown(`pr-mdv-${this.uid}`, this.md))
          : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…"))
      : div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(TYPE.codePanel)
        // A virtual list, as the review's diff: only the lines on screen are built (diffItems, diffItem). The press is
        // kept here, outside the list, for onDiffItem: where it went down and whether shift was held.
        // The event is in logical px, the items are laid out in the person's zoom: both in the items' px (as panelW).
        .on_mouse_down("left", (e) => { this.press = { ...panelPress(e.local_position?.x, e.bounds?.width, settings().zoom, this.panelW ?? 380), shift: Boolean(e.modifiers?.shift) }; })
        .child(diffLines())
        .child(Scrollbar.vertical(diffId).absolute().inset_0()));
    return dock(this, v_flex(), inView(), cx).on_size_change((size, cx) => { const z = settings().zoom || 1, h = size.height / z, w = size.width / z; if (Math.abs((this.panelH ?? 0) - h) > 8 || Math.abs((this.panelW ?? 0) - w) > 8) { this.panelH = h; this.panelW = w; cx.notify(); } })
      .size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(TYPE.body)
      .track_focus(this.fh).on_key_down((e, cx) => this.onKey(e, cx))
      .child(header)
      .when(Boolean(setupBanner(this, t)), (e) => e.child(setupBanner(this, t)))
      .when(state === "setup", (e) => e.child(renderSetup(this, t)))
      .when(state === "picking", (e) => e.child(pickBody()))
      .when(state === "selected", (e) => e
        .when(Boolean(this.prSel && !shownIn(this.prSel)), (e) => e.child(h_flex().flex_none().flex_wrap().px(14).py(6).gap(8).items_center().bg(t.ansi3 + "1c").border_b(1).border_color(t.border).text_size(TYPE.small)
          .child(div().flex_1().min_w(0).child(`This PR belongs to ${C.nameOf(ctxDoc(), prCtx(this.prSel))}.`))
          .when(Boolean(C.revealOf(ctxDoc(), prCtx(this.prSel))), (e) => e.child(pill(`pr-acc-${this.uid}`, t, `Switch to ${C.labelOf(ctxDoc(), prCtx(this.prSel))}`, () => { const r = C.revealOf(ctxDoc(), prCtx(this.prSel)); setShared(r.key, r.value); }, false, "Switch the view to the context this PR belongs to")))
          .child(pill(`pr-clear-${this.uid}`, t, "Clear", (_e, cx) => this.choose(null, cx), false, "Drop this PR selection"))))
        .child(tabs)
        .when(tab === "walk", (e) => e.child(this.walkView(t)))
        .when(tab === "diff" && Boolean(this.error) && !this.files.length, (e) => e.child(v_flex().flex_1().min_h(0).p(14).gap(10)
          .child(div().whitespace_normal().text_size(TYPE.small).child("This diff could not be loaded."))
          .child(div().id(`pr-err-${this.uid}`).whitespace_normal().text_size(TYPE.panel).text_color(t.ansi1).child(String(this.error).replace(/^Error: /, "")))
          .child(h_flex().gap(8)
            .child(pill(`pr-retry-${this.uid}`, t, "Retry", (_e, cx) => { if (this.prSel) this.heads.delete(this.prSel.url); this.refresh(cx, true); }, false, "Load this diff again"))
            .when(Boolean(named?.url), (e) => e.child(pill(`pr-err-web-${this.uid}`, t, "Open on GitHub ↗", () => openUrl(named.url), false, "Open this PR on GitHub in the browser"))))))
        .when(tab === "diff" && !(this.error && !this.files.length), (e) => e.child(files()).child(diffBody())))
      .when(Boolean(this.note), (e) => e.child(div().flex_none().px(10).pt(6).text_size(TYPE.panel).whitespace_normal().text_color(/Could not|Not sent|Not a PR/.test(this.note ?? "") ? t.ansi1 : t.dim).child(this.note)))
      // The pending comments: a count, not a main button. For a PR it opens the review's "Finish your review" (post to
      // GitHub or send to an agent, after a preview); a branch without a PR has no review, so its comments go to the agent.
      // Discard deletes them all: it asks once (a second click), and stands apart from the one filled button.
      .when(state === "selected" && this.comments.length > 0, (e) => e.child(h_flex().flex_none().flex_wrap().justify_end().m(8).px(10).py(4).min_h(32).gap(8).items_center().rounded(8).bg(t.surface).border_1().border_color(t.border)
        .child(div().flex_1().min_w(120).truncate().text_size(TYPE.small).child(pendingText(this.comments)))
        .child(div().id(`rv-drop-${this.uid}`).flex_none().mr(8).h(24).px(4).flex().items_center().text_size(TYPE.panel).cursor_pointer().text_color(this.discardAsk ? t.ansi1 : t.muted).hover((x) => x.text_color(t.ansi1))
          .tooltip(this.discardAsk ? "Click again to delete all pending comments. They were not sent." : "Delete all pending comments without sending them; asks once")
          .on_click((_e, cx) => this.discardAll(cx)).child(this.discardAsk ? `Delete ${this.comments.length === 1 ? "this comment" : `all ${this.comments.length} comments`}?` : "Discard"))
        .child(div().id(this.pr?.url ? `rv-finish-${this.uid}` : `rv-send-${this.uid}`).flex_none().px(10).h(24).flex().items_center().rounded(6).text_size(TYPE.panel).font_semibold().bg(t.solid).text_color(t.solid_foreground).cursor_pointer()
          .tooltip(this.pr?.url ? "Open the review with a preview of these comments, then post them to GitHub or send them to an agent" : "Send all pending comments to the coding agent as one prompt")
          .on_click((_e, cx) => { if (this.pr?.url) this.finishReview(); else if (canSend) this.sendReview(cx); }).child(this.pr?.url ? "Finish your review" : this.sending ? "…" : "Send to agent"))));
  }

}

Object.assign(PrReview.prototype, ReviewMode);
