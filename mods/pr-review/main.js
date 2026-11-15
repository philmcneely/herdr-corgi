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
import { v_flex, h_flex, InputState, Input, Scrollbar, Editor, EditorState, TextView } from "gpui-base";
import { spaces, panes, focused, agents, exec, hc, run, theme, settings, readTextFile, writeTextFile, shared, setShared, appHome, home, layout, props, watchFolder, nextCommand } from "herdr";
import { diffRows, buildPrompt, splitPatch, selection, nextChange, lineLabel, anchorRow, buildReview, hunksOf, hash, uiLine, reviewRequest, mapReview, triageOf, isSecurity } from "./pr.js";
import { parsePrRef, ghTarget, pruneSources, codeModel, windowActive } from "./pr.js";
import * as C from "./context.js";
import { tabArgs } from "./threads.js"; // a new Claude tab with the PR's text: no MCP servers
import { loadDiff, saveDiff } from "./diffcache.js";
import { setupBanner, renderSetup, loadSetup, runSetup, openUrl, readConfig } from "./setup-view.js";
import { chip, PRIORITY_TIP } from "./stack.js";
import { panelState, bodyTab, capped, IN_PROGRESS_MAX, diffTooLarge, filesToDiff, isOpenPr, byState, listRows, riskSignal, progressText, pendingText, rowMarks } from "./views.js";
import { ReviewMode, startReview, startExplore, saveKey, flowCard, modelPills, modelLabel, renderReviews, renderAgentBar, renderKeys, renderCardMenu, renderMini } from "./review.js";
import { highlightJob, highlightStep, langOf, colors, renderLine, editorSyntax } from "./syntax.js";

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
const SOURCES = [["mine", "Mine"], ["repo", "This repo"], ["review", "Review requested"]];
const SRC_TIP = { mine: "PRs found in your Claude sessions", repo: "Open PRs in this space's repository", review: "Open PRs waiting for your review" };
const sourcesFile = () => `${appHome()}/pr-data/sources.json`;
const SOURCE_MS = 3 * 60 * 1000, SOURCE_KEEP = 20, PICKED_KEEP = 20;
const GH_FIELDS = "number,title,author,headRefName,headRefOid,baseRefName,updatedAt,isDraft,reviewDecision,additions,deletions,url";
const REVIEW = { APPROVED: ["approved", "ansi2"], CHANGES_REQUESTED: ["changes requested", "ansi1"], REVIEW_REQUIRED: ["review required", "ansi3"] };
const BRANCH = "branch"; // shared "pr.selected": the current branch was picked (not a PR)
const SEC_MARK = "⛨"; // security's own mark in a PR row (a shield), next to the word
const age = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return !Number.isFinite(m) ? "" : m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, space: space?.id ?? null };
}

// Contexts (optional, a plug-in's shared "pr-review.contexts"; context.js): a space's, a PR's, whether the view shows it.
const ctxDoc = () => shared(C.CONTEXTS_KEY);
const spaceCtx = (spaceId) => C.spaceContext(ctxDoc(), spaceId);
const prCtx = (pr) => C.prContext(ctxDoc(), pr, home());
const shownIn = (pr) => C.shown(ctxDoc(), prCtx(pr), shared);
// The view's key for remembering the picked PR: the contexts it shows.
const viewKey = () => Object.keys(ctxDoc()?.contexts ?? {}).filter((id) => C.shown(ctxDoc(), id, shared)).join(",") || "all";
// A context tag (only with two or more contexts): label in its colour.
export const ctxTag = (t, id, key = null) => div().flex_none().px(5).rounded(4).border_1().border_color(C.colorOf(ctxDoc(), id, t)).text_size(10).text_color(C.colorOf(ctxDoc(), id, t)).when(Boolean(key), (e) => e.id(`ctx-${key}`).tooltip("Context this PR belongs to")).child(C.labelOf(ctxDoc(), id));

const find = (node, id) => node?.id === id ? node : (node?.children ?? []).map((c) => find(c, id)).find(Boolean) ?? null;
// Shown: the right panel is open and its stack has this tab up.
const inView = () => { const p = find(layout(), "panel"); return Boolean(p && !p.hidden && find(p, "panel-body")?.active === "pr"); };
// Worth loading for: shown, or in a layout without that panel (placed elsewhere).
const visible = () => inView() || !find(layout(), "panel-body");
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
const pill = (id, t, label, click, on = false, tip = "", alt = "") => div().id(id).when(Boolean(tip), (e) => e.tooltip(tip)).when(Boolean(alt), (e) => e.accessibility_label(alt)).px(6).py(1).rounded(4).border_1().border_color(on ? t.accent : t.border).text_size(10)
  .text_color(on ? t.foreground : t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(click).child(label);

export default class PrReview extends View {
  init(_props, cx) {
    this.part = props()?.part ?? null;
    this.uid = Math.random().toString(36).slice(2, 8);
    if (this.part === "bar" || this.part === "reviews" || this.part === "agentbar" || this.part === "keys" || this.part === "cmenu" || this.part === "mini") return;
    this.announces = true; // Go to's keys: published while this copy runs, cleared in close()
    this.files = []; this.rows = []; this.sel = null; this.selEnd = null; this.from = 0; this.question = "";
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
    this.repos = new Map(); this.prInfo = new Map(); this.memo = new Map(); this.dirty = new Set(); this.watching = new Map(); this.heads = new Map();
    if (this.part === "review") return this.initReview(cx);
    if (visible()) this.refresh(cx);
    // Key commands (keys.json "pr-review.<name>"): picker (the PR list), source:mine|repo|review, merged, setup, walkthrough, review, finish.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand()), [name, arg] = [c.split(":")[0], c.split(":").slice(1).join(":")];
        if (name === "source" && SOURCES.some(([k]) => k === arg)) { setShared("pr.source", arg); this.picking = true; this.loadSource(cx); }
        else if (c === "picker") { this.picking = !this.picking; if (this.picking) this.loadSource(cx); }
        else if (c === "setup") { this.view = "setup"; runSetup(this, cx, false); }
        else if (c === "walkthrough") this.openWalk(cx, false);
        else if (c === "review" && this.pr?.url) startReview(this.prSel ?? this.branchTarget());
        else if (c === "finish") this.finishReview(); // the pending comments' "Finish your review"
        else if (c === "merged") this.showDone = !this.showDone; // the list's "Merged or closed" row (a toggle)
        else if (name === "explore") startExplore(arg || null); // pr-review.explore[:<folder>]: a topic in existing code, no PR
        // For keys and scripted demos: a listed PR's row click (pick:<number>, the shown source's list).
        else if (name === "pick") { const pr = this.listNow().find((p) => String(p.number) === arg); if (pr) this.pickTarget(pr, cx); }
        cx.notify();
      }
    });
    cx.spawn(async (cx) => {
      this.cfg = await readConfig();
      await loadSetup(this, cx);
      // The open reviews as the registry file has them (it outlives shared state edits and format changes).
      const reg = JSON.parse(await readTextFile(`${appHome()}/pr-data/open-reviews.json`).catch(() => null) ?? "null");
      if (Array.isArray(reg) && JSON.stringify(reg.filter((r) => r.status !== "done")) !== JSON.stringify(shared("review.open"))) setShared("review.open", reg.filter((r) => r.status !== "done"));
      await this.loadPrs(cx);
      // The PR picked last in this view survives remounts (layout switch, a recreated block); one you didn't
      // open comes back from shared "pr.picked".
      const url = (shared("pr.selected") ?? {})[viewKey()];
      if (url === BRANCH && !this.prSel) this.branchPicked = true;
      const pr = url && url !== BRANCH && !this.prSel ? this.prs.find((p) => p.url === url) ?? (shared("pr.picked") ?? {})[url] : null;
      if (pr) this.choose(pr, cx);
      this.scanIfDue(cx);
    });
    cx.timer.every(60000, (cx) => this.scanIfDue(cx)); // a time check; prs.py itself at most every PRS_MS
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
    const doc = text ? JSON.parse(text) : null;
    if (doc) this.prs = doc.prs ?? [];
    if (this.prSel) this.prSel = this.prs.find((p) => p.url === this.prSel.url) ?? this.prSel; // fresh updatedAt: the diff cache stamp
    cx.notify();
    return doc;
  }

  // prs.py (about 20 s) only when prs.json is older than PRS_MS, and in one copy at a time: prs.lock holds the start
  // time, taken and given back by compare-and-swap (writeTextFile with the text read). True when it ran.
  async scanPrs(cx) {
    const doc = await this.loadPrs(cx), lock = `${appHome()}/pr-data/prs.lock`;
    if (this.scanning || Date.now() - Date.parse(doc?.generated ?? 0) < PRS_MS) return false;
    const held = await readTextFile(lock).catch(() => null), mine = String(Date.now());
    if (held && Date.now() - Number(held) < 600000) return false;
    try { await writeTextFile(lock, mine, held); } catch { return false; }
    this.scanning = true;
    const req = { dirs: C.claudeDirs(ctxDoc(), home()), rules: ctxDoc()?.rules ?? [], titles: this.cfg?.sessionTitles ?? null };
    try { await exec("python3", [`${appHome()}/mods/pr-review/prs.py`, JSON.stringify(req)], { timeout: 600000 }); } catch {}
    this.scanning = false;
    await writeTextFile(lock, "0", mine).catch(() => null);
    await this.loadPrs(cx);
    return true;
  }

  // prs.py only while someone can see the list: the panel shown (or placed in a layout without it) and the window in
  // front. Hidden or behind other windows it asks nothing; shown again, it asks once the last try is PRS_MS old.
  scanIfDue(cx) {
    if (!visible() || !windowActive() || Date.now() - (this.scanAt ?? 0) < PRS_MS) return;
    this.scanAt = Date.now();
    cx.spawn(async (cx) => { if (await this.scanPrs(cx) && this.prSel && inView()) this.refresh(cx); });
  }

  // A folder's repo: {root, gitdir, base: origin's default branch}, one spawn per folder; null outside a repo.
  repoOf(cwd) {
    if (!this.repos.has(cwd)) {
      this.repos.set(cwd, exec("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--abbrev-ref", "origin/HEAD"], { cwd }).then((r) => {
        const [root, gitdir, base] = r.stdout.trim().split("\n");
        return gitdir?.startsWith("/") ? { root, gitdir, base: r.code === 0 ? base : "origin/main" } : null;
      }).catch(() => null));
    }
    return this.repos.get(cwd);
  }

  // Watches a shown repo (at most WATCHES; the oldest is let go). A change that matters marks it dirty; shown, it
  // refreshes once a second later.
  watch(root, cx) {
    if (this.watching.has(root)) { const v = this.watching.get(root); this.watching.delete(root); this.watching.set(root, v); return; }
    this.watching.set(root, true);
    if (this.watching.size > WATCHES) this.watching.delete(this.watching.keys().next().value);
    cx.spawn(async (cx) => {
      while (this.watching.has(root)) {
        const paths = await watchFolder(root);
        if (!this.watching.has(root) || !paths.some((p) => !IGNORED.test(p))) continue;
        const was = this.dirty.has(root);
        this.dirty.add(root);
        if (!was) cx.timer.after(1000, (cx) => { if (this.root === root && !this.prSel && this.dirty.has(root) && visible()) this.refresh(cx, true); });
      }
    });
  }

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
    this.heads.set(pr.url, { at: Date.now(), sha: seen?.sha ?? pr.headSha });
    cx.spawn(async (cx) => {
      const sha = await this.headOf(pr.url);
      if (!sha) return;
      this.heads.set(pr.url, { at: Date.now(), sha });
      if (this.prSel?.url === pr.url && sha !== this.prSel.headSha) { this.prSel = { ...this.prSel, headSha: sha }; this.refresh(cx, true); }
    });
  }

  // A PR's head from GitHub (gh pr view), null when gh can't say; asked once at a time per PR (a second ask shares it).
  headOf(url) {
    const busy = (this.headIn ??= new Map());
    if (!busy.has(url)) busy.set(url, exec("gh", ["pr", "view", url, "--json", "headRefOid"], { timeout: 30000 })
      .then((v) => (v.code === 0 ? JSON.parse(v.stdout).headRefOid ?? null : null)).catch(() => null).finally(() => busy.delete(url)));
    return busy.get(url);
  }

  choose(pr, cx) {
    this.prSel = pr; this.branchPicked = !pr; this.picking = false; this.mode = "diff"; this.askTop = false;
    setShared("pr.selected", { ...(shared("pr.selected") ?? {}), [viewKey()]: pr?.url ?? BRANCH });
    if (pr && !this.prs.some((p) => p.url === pr.url)) { // not in prs.json: keep the whole target, the newest PICKED_KEEP
      const kept = Object.entries(shared("pr.picked") ?? {}).filter(([u]) => u !== pr.url).slice(0, PICKED_KEEP - 1);
      setShared("pr.picked", Object.fromEntries([[pr.url, pr], ...kept]));
    }
    this.refresh(cx); cx.notify();
  }

  // The last load, for measuring (shared "pr.perf", kept in shared.json): what happened and how long it took.
  perf(what, ms) { setShared("pr.perf", { what, ms, context: this.context, at: new Date().toISOString() }); }

  // The shown context's diff and view (file, selection, scroll), kept in memo for going back to it.
  snapshot() {
    return { root: this.root, pr: this.pr, base: this.base, files: this.files, patch: this.patch, branchFiles: this.branchFiles,
      open: this.open, rows: this.rows, sel: this.sel, selEnd: this.selEnd, from: this.from, mode: this.mode };
  }
  remember(context, at) {
    const old = this.memo.get(context);
    this.memo.delete(context);
    this.memo.set(context, { at: at ?? old?.at ?? Date.now(), state: this.snapshot() });
    if (this.memo.size > MEMO) this.memo.delete(this.memo.keys().next().value);
  }

  // force: diff again even when the remembered state is fresh (dirty repo, new head, ↻).
  refresh(cx, force = false) {
    if (this.loading) return;
    const { cwd } = location(), context = this.key(), picked = this.prSel;
    if (context !== this.context) {
      if (this.context && this.memo.has(this.context)) this.remember(this.context);
      this.context = context; this.root = null; this.files = []; this.open = null; this.rows = []; this.sel = null; this.selEnd = null; this.pr = null; this.error = null; this.patch = null; this.branchFiles = null; this.from = 0;
      const hit = this.memo.get(context);
      if (hit) {
        Object.assign(this, hit.state);
        this.remember(context); // most recently used
        cx.spawn(async (cx) => { await this.syncSource(cx).catch(() => null); cx.notify(); }); // its comments: a file read
        if (picked && visible()) this.checkHead(picked, cx);
        if (!force && Date.now() - hit.at < TTL_MS && !(this.root && this.dirty.has(this.root) && !picked)) { this.perf("restored, no exec", 0); return cx.notify(); }
      }
    }
    if ((!cwd && !picked) || (this.part === "review" && !picked)) return;
    if (this.root) this.dirty.delete(this.root); // changes from here on mark it again
    this.loading = true;
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
          this.branchFiles = splitPatch(r.stdout);
          this.root = root; this.pr = info?.pr ?? null; this.base = base; this.files = this.branchFiles; this.error = null;
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
              else { this.pr = pr; this.remember(context); await this.syncSource(cx); cx.notify(); }
            });
          }
        }
        if (this.open && !this.files.some((f) => f.path === this.open)) { this.open = null; this.rows = []; this.sel = null; }
        if (this.files.length) await this.load(this.open ?? this.files[0].path, context);
        this.remember(context, Date.now());
        this.perf(picked ? "picked PR loaded" : "branch diff loaded", Date.now() - started);
      } catch (e) { if (this.key() === context) this.error = String(e); }
      finally {
        this.loading = false;
        cx.notify();
        if (this.key() === context) await this.syncSource(cx).catch((e) => { this.note = `Could not load the review: ${e}`; });
        cx.notify();
      }
    });
    cx.notify();
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
    this.reviewKey = key; this.editing = null; this.walk = null; this.walkError = null; this.read = new Set(); this.step = 0;
    const text = key ? await readTextFile(reviews()).catch(() => null) : null;
    this.comments = (text ? JSON.parse(text)[key] : null) ?? [];
    if (this.view === "walk") this.openWalk(cx, false);
    if (this.part === "review") { this.srcHead = this.prSel?.headSha ?? null; await this.onSource(cx); }
  }

  async load(path, context) {
    const r = { code: 0, stdout: (this.patch ?? this.branchFiles ?? []).find((f) => f.path === path)?.lines.join("\n") ?? "" };
    if (this.key() !== context) return;
    const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
    const lines = r.code !== 0 ? [`Could not read the diff: ${r.stderr.trim()}`] : first < 0 ? ["No text diff"] : all.slice(first, first + 3000);
    if (this.open !== path) { this.sel = null; this.selEnd = null; this.from = 0; }
    this.open = path; this.mode = this.mode ?? "diff";
    if (this.mode === "file") await this.showFile(path, context);
    this.rows = diffRows(lines.map((l) => (l.length > 2000 ? l.slice(0, 2000) + "…" : l)));
  }

  // The whole file as it is now: markdown rendered, code highlighted read-only.
  async showFile(path, context) {
    this.code?.release(); this.code = null; this.md = null; this.fileError = null;
    const text = await readTextFile(`${this.root}/${path}`).catch(() => null);
    if (this.key() !== context || this.open !== path) return;
    if (text === null) { this.fileError = "File not in the working tree (deleted?)"; return; }
    if (text.includes("\0")) { this.fileError = "Binary file"; return; }
    const body = text.length > 400000 ? text.slice(0, 400000) + "\n… (truncated)" : text;
    const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "txt";
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

  // The panel's "Finish your review" (also the finish command here): the PR opens in the review layout, whose copy
  // takes shared "pr.finish" and opens its popover of that name with these pending comments (render, part "review").
  finishReview() {
    if (!this.pr?.url || !this.comments.length) return;
    setShared("pr.finish", { url: this.pr.url, at: Date.now() });
    startReview((shared("review.open") ?? []).find((r) => r.url === this.pr.url)?.target ?? this.prSel ?? this.branchTarget());
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
  // Claude when its folder is gone); the branch diff to this space's agent or a new Claude tab.
  deliver(prompt, cx, what, done) {
    const { space } = location(), origin = this.prSel;
    if (!space || this.sending || !(this.root || this.pr)) return;
    const ctx = this.ctxId(), agent = origin?.session ? this.sessionAgent(origin) : this.target(origin?.space ?? space);
    this.sending = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        if (agent) {
          const r = await hc(["send", agent.address, prompt]);
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
          run("tab.select", { id: agent.tab });
          this.note = `${what} sent to ${agent.tab_name || "agent"}`;
        } else if (origin?.session && this.root) {
          // The session lives in the config folder it ran under (sessionContext), which the rules' context may not be.
          run("tab.new", { space: this.spaceFor(ctx, origin.cwd, this.root), folder: origin.cwd, name: `PR #${origin.number}`, argv: [...this.ctxEnv(origin.sessionContext ?? ctx), "claude", "--resume", origin.session], task: prompt });
          this.note = `${what}: resumed the PR's session in a new tab`;
        } else {
          run("tab.new", { space: this.spaceFor(ctx, this.root), folder: this.root ?? location().cwd, name: "PR-Review", argv: tabArgs({ env: this.ctxEnv(ctx), model: walkModel() }), task: prompt });
          this.note = `${what}: started a new Claude tab`;
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
      if (i >= 0) { this.sel = i; this.selEnd = null; this.askTop = false; this.from = Math.max(0, i - 4); }
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
    if (analyze) { if (this.pr?.url) startReview(this.prSel ?? this.branchTarget()); return cx.notify(); }
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
        .child(div().text_size(12).text_color(t.muted).whitespace_normal().child(w.summary))
        .child(h_flex().gap(8).items_center().text_size(11).text_color(t.dim)
          .child(div().flex_1().min_w(0).truncate().child(`${done} of ${w.steps.length} layers read · ${modelLabel(w.model) ?? "model unknown"}${w.cost != null ? ` · $${w.cost.toFixed(3)}` : ""}${w.cut?.length ? ` · ${w.cut.length} hunks cut` : ""}`))
          .when(Boolean(this.walkBusy), (e) => e.child(div().child(SPIN[0]).frames(SPIN, 90)))
          .child(pill(`walk-more-${this.uid}`, t, "⋯", (_e, cx) => { this.walkMore = !this.walkMore; cx.notify(); }, this.walkMore, "Show or hide the model choice and more options", "More walkthrough options")))
        .when(Boolean(this.walkMore), (e) => e.child(h_flex().flex_wrap().gap(8).items_center().pt(2)
          .child(modelPills(t, `walk-m-${this.uid}`))
          .when(Boolean(this.pr?.url), (e) => e.child(pill(`walk-redo-${this.uid}`, t, "Open review ↗", (_e, cx) => this.openWalk(cx, true), false, "Open this PR in the review layout")))))
        .when(Boolean(this.walkError), (e) => e.child(div().text_size(11).text_color(t.ansi1).whitespace_normal().child(this.walkError))))
      .child(v_flex().px(6).py(4).border_t(1).border_b(1).border_color(t.border).children(steps.map((s, i) =>
        h_flex().id(`step-${i}-${this.uid}`).h(24).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().text_size(12.5).tooltip("Show this layer and mark it read (✓ read, ○ unread)")
          .when(cur === s, (e) => e.bg(t.selected)).hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => { this.step = i; if (i < w.steps.length) this.read.add(i); cx.notify(); })
          .child(div().w(12).flex_none().text_color(this.read.has(i) ? t.ansi2 : t.dim).child(i >= w.steps.length ? "·" : this.read.has(i) ? "✓" : "○"))
          .child(div().flex_1().min_w(0).truncate().text_color(s.stale ? t.dim : t.foreground).child(s.title))
          .when(Boolean(s.stale), (e) => e.child(div().id(`step-o-${i}-${this.uid}`).tooltip("The code changed since this layer was written").text_size(10.5).text_color(t.ansi3).child("outdated")))
          .when(Boolean(WEIGHT[s.weight]), (e) => e.child(div().id(`step-w-${i}-${this.uid}`).tooltip(s.weight === "key" ? "Key layer: worth reading closely" : "Minor layer: a skim is enough").text_size(10.5).text_color(t[WEIGHT[s.weight]?.[1]]).child(WEIGHT[s.weight]?.[0] ?? ""))))))
      .child(div().px(14).py(10).text_size(12.5).whitespace_normal().child(cur?.text ?? ""))
      .children((cur?.flows ?? []).map((f, k) => div().px(12).pb(6).child(flowCard(f, t, `wf-${this.uid}-${this.step}-${k}`))))
      .children((cur?.asks ?? []).map((a, i) => h_flex().id(`ask-${i}`).px(14).py(3).gap(8).text_size(12)
        .child(div().id(`ask-${i}-cov`).tooltip("How well this diff covers the requirement from the task").w(70).flex_none().text_color(t[COVER[a.coverage]?.[1]] ?? t.dim).child(COVER[a.coverage]?.[0] ?? a.coverage))
        .child(div().flex_1().min_w(0).whitespace_normal().child(a.text))))
      .children((cur?.hunks ?? []).filter((id) => now.has(id)).flatMap((id) => {
        const h = now.get(id);
        return [div().id(`wh-${id}`).tooltip(h.path).px(12).pt(8).pb(2).text_size(11).text_color(t.muted).truncate().child(h.path),
          v_flex().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
            .children(diffRows(h.lines.slice(0, 400)).map((r, i) => this.diffRow(r, `${id}-${i}`, t, true)))];
      })));
  }

  // ---- render

  // PRs created from Claude sessions (prs.json), newest first, filtered by the contexts the view shows.
  // ---- PR sources: Mine (prs.json), This repo and Review requested (gh, no LLM), Open PR… (any PR by reference)

  sourceNow() {
    const picked = shared("pr.source");
    if (SOURCES.some(([k]) => k === picked)) return picked;
    const slug = this.spaceSlug?.slug; // default: the space's repo when none of your session PRs is from it
    return slug && !this.prs.some((p) => p.repo === slug && shownIn(p)) ? "repo" : "mine";
  }

  // The active space's repo: {root, slug: owner/name from origin}, or null outside a GitHub repo.
  async spaceRepo() {
    const cwd = location().cwd, repo = cwd ? await this.repoOf(cwd) : null;
    if (!repo) return null;
    if (!this.slugs.has(repo.root)) {
      const r = await exec("git", ["remote", "get-url", "origin"], { cwd: repo.root }).catch(() => null);
      this.slugs.set(repo.root, /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(r?.stdout.trim() ?? "")?.[1] ?? null);
    }
    const slug = this.slugs.get(repo.root);
    return slug ? { root: repo.root, slug } : null;
  }

  // A PR's context for one you didn't open: the contexts' rules on its folder and remote, else the context your
  // session PRs of that repo have, else the space's (This repo) or the default.
  contextOfPr(repo, folder, fallback) {
    return C.ruleContext(folder, `https://github.com/${repo}`, ctxDoc()?.rules, home()) ?? (this.prs ?? []).find((p) => p.repo === repo)?.context ?? fallback ?? C.defaultOf(ctxDoc());
  }

  // The list of a source, from sources.json when fresh (force: ↻), else gh; the triage line follows.
  loadSource(cx, force = false) {
    this.srcAsked = true;
    cx.spawn(async (cx) => {
      this.spaceSlug = await this.spaceRepo();
      const now = this.sourceNow();
      if (now === "mine") { this.loadTriage(cx); return cx.notify(); }
      const sr = this.spaceSlug, key = now === "repo" ? (sr ? `repo:${sr.slug}` : null) : "review";
      if (!key) { this.srcLists.repo = { key: null, prs: [] }; this.loadTriage(cx); return cx.notify(); } // no GitHub repo here: the list says what to do
      const before = await readTextFile(sourcesFile()).catch(() => null), doc = JSON.parse(before ?? "{}");
      if (!force && doc[key] && Date.now() - doc[key].at < SOURCE_MS) { this.srcLists[now] = { key, ...doc[key] }; this.loadTriage(cx); return cx.notify(); }
      if (this.srcIn === key) return; // this list is being fetched: that answer serves this ask too
      this.srcIn = key;
      this.srcLists[now] = { key, prs: doc[key]?.prs ?? [], at: doc[key]?.at, loading: true }; cx.notify();
      const args = now === "repo" ? ["pr", "list", "-R", sr.slug, "--state", "open", "--limit", "50", "--json", GH_FIELDS]
        : ["search", "prs", "--review-requested=@me", "--state", "open", "--limit", "50", "--json", "repository,number,title,author,updatedAt,url,isDraft"];
      const r = await exec("gh", args, { timeout: 60000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      this.srcIn = null;
      if (r.code !== 0) { this.srcLists[now] = { ...this.srcLists[now], loading: false, error: `gh: ${r.stderr.trim().slice(0, 160)}` }; return cx.notify(); }
      const spaceC = spaceCtx(location().space);
      const prs = JSON.parse(r.stdout).map((p) => {
        const repo = now === "repo" ? sr.slug : p.repository?.nameWithOwner, cwd = sr && sr.slug === repo ? sr.root : null;
        return ghTarget(p, { repo, cwd, source: now, context: this.contextOfPr(repo, cwd, now === "repo" ? spaceC : null) });
      });
      this.srcLists[now] = { key, prs, at: Date.now() };
      for (let attempt = 0; attempt < 3; attempt++) { // compare-and-swap: another copy may write it too
        const old = await readTextFile(sourcesFile()).catch(() => null);
        try { await writeTextFile(sourcesFile(), JSON.stringify(pruneSources({ ...JSON.parse(old ?? "{}"), [key]: { at: Date.now(), prs } }, SOURCE_KEEP)), old); break; } catch { /* again */ }
      }
      this.loadTriage(cx); cx.notify();
    });
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
    if (target.headSha) return review ? startReview(target) : this.choose(target, cx);
    this.note = `Opening #${target.number}…`; cx.notify();
    cx.spawn(async (cx) => {
      try { const t = await this.resolve(target); this.note = null; if (review) startReview(t); else this.choose(t, cx); }
      catch (e) { this.note = `Could not open: ${String(e).replace(/^Error: /, "")}`; }
      cx.notify();
    });
  }

  // Optional Go to (mods/goto/PROVIDERS.md) integration: PR links there become "Review PR", and reviews in progress
  // are findable. Go to hands the PR over through shared "pr.goto"; render picks it up. Without goto nothing happens.
  publishGoto() {
    const p = shared("goto.providers") ?? [];
    if (!p.includes("review")) setShared("goto.providers", [...p, "review"]);
    const open = { key: "pr.goto", value: { url: "{url}", repo: "{owner}/{repo}", number: "{number}" } };
    setShared("goto.handlers.review", [{ pattern: "github\\.com/([\\w.-]+)/([\\w.-]+)/pull/(\\d+)", title: "Review PR #{number} · {title}",
      subtitle: "{owner}/{repo}", run: [["goto.set", open]] }]);
    setShared("goto.items.review", (shared("review.open") ?? []).map((r) => ({ id: `review:${r.url}`, title: `Resume review #${r.number} ${r.title ?? ""}`,
      subtitle: [r.repo, progressText(r.progress)].filter(Boolean).join(" · "), tag: "Review", url: r.url, keywords: [String(r.number), r.repo ?? ""],
      run: [["goto.set", { key: "pr.goto", value: { url: r.url } }]] })));
  }

  // A PR handed over by Go to: resume a review in progress, else open it in the review layout like "Open PR…".
  takeGoto(cx) {
    const g = shared("pr.goto");
    if (!g?.url) return;
    setShared("pr.goto", null);
    const r = (shared("review.open") ?? []).find((x) => x.url === g.url);
    if (r) return startReview(r.target ?? r);
    const mine = (this.prs ?? []).find((x) => x.url === g.url);
    const ref = mine ?? parsePrRef(g.url);
    if (!ref) return;
    const sr = this.spaceSlug?.slug === ref.repo ? this.spaceSlug.root : null;
    this.pickTarget(mine ?? { url: ref.url, repo: ref.repo, number: Number(ref.number), cwd: sr, source: "open", context: this.contextOfPr(ref.repo, sr, null) }, cx, true);
  }

  // One slice of the open file's highlighting; the next one after a timer, until the file is done (then a redraw).
  highlightMore(cx, hl) {
    cx.timer.after(0, (cx) => {
      if (this.hl !== hl) return; // another file opened meanwhile
      const out = highlightStep(hl.job, 10);
      if (out) { hl.spans = out; cx.notify(); } else this.highlightMore(cx, hl);
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
        const analysis = an?.answer ? mapReview(an.answer, []) : null;
        risk.set(pr.url, riskSignal({ analysis, findings: fd?.findings, status: fd?.status }));
        if (!listed.has(pr.url)) return;
        // The diff's size from its cache (in parts, diffcache.js); a missing one leaves the effort to the analysis.
        const [ctx, diff] = await Promise.all([pr.headSha ? read(`${cacheDir()}/ctx-${h}-${pr.headSha}.json`) : null, loadDiff(`${cacheDir()}/diff-${h}-${head}`, pr.url, head, readTextFile)]);
        const files = diff ? splitPatch(diff) : null;
        const security = (fd?.findings ?? []).filter((f) => isSecurity(f) && !["fixed", "dismissed"].includes(fd.status?.[f.id]?.s)); // as the review's ⛨
        out.set(pr.url, triageOf({ pr, analysis, size: files && { files: files.length, lines: files.reduce((n, f) => n + f.add + f.del, 0) },
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
    // One mark (views.js rowMarks): "⛨ high" in red when an open finding is about security, else the severity in grey.
    return rowMarks(this.risk?.get(url), null).map((m) => chip(t, m.text, m.security ? t.ansi1 : t.muted, m.security, `${id}-sev`,
      `The highest severity among this PR's open findings, from the cached analysis and reviews${m.security ? `; ${SEC_MARK}: at least one of them is about security` : ""}`));
  }

  // The list of the shown source, one row per PR: the ones under "In progress" are not repeated, open PRs come first
  // with one way into the review each (Resume once started), merged and closed ones are folded under their own row.
  picker(t) {
    const src = this.sourceNow(), sl = this.srcLists[src], inProgress = (shared("review.open") ?? []).filter(shownIn);
    const { list, above, started } = listRows(this.listNow(), inProgress, capped(inProgress, this.allOpen).shown), { open, done } = byState(list);
    const item = (id, on, top, sub, state, tag, click, pr) => v_flex().id(id).flex_none().px(8).py(4).rounded(7).cursor_pointer().tooltip(pr ? "Select this PR to see its diff" : "Use the diff of the focused pane's branch")
      .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click(click)
      .child(h_flex().gap(6).child(div().flex_1().min_w(0).truncate().child(top)).when(Boolean(state), (e) => e.child(div().id(`${id}-st`).tooltip(`PR state: ${state}`).flex_none().text_size(10.5).text_color(t[STATE[state]] ?? t.muted).child(state)))
        .when(Boolean(pr && isOpenPr(pr)), (e) => { // the one way into the review; a merged or closed PR has none
          const r = started.get(pr.url);
          return e.child(r ? pill(`${id}-rv`, t, "Resume", (_e, cx) => { cx.stop_propagation(); startReview(r.target ?? r); }, false, "Continue this review where you left it")
            : pill(`${id}-rv`, t, "Review", (_e, cx) => { cx.stop_propagation(); this.pickTarget(pr, cx, true); }, false, "Open this PR in the review layout"));
        }))
      .when(Boolean(sub), (e) => e.child(h_flex().gap(6).text_size(11).text_color(t.muted).child(div().id(`${id}-sub`).tooltip(src === "mine" ? "Repository and the session that opened it" : "Author, review status, lines added and removed, last update").flex_1().min_w(0).truncate().child(sub))
        .when(Boolean(tag), (e) => e.child(div().id(`${id}-tg`).tooltip("Agent that opened this PR").flex_none().max_w(140).truncate().px(5).rounded(4).bg(t.raised).text_size(10).child(tag)))))
      .when(Boolean(pr && (this.triage?.get(pr.url) || this.risk?.get(pr.url)?.top)), (e) => { // risk first, then the triage card: compact; the why shows on the picked PR
        const tri = this.triage?.get(pr.url);
        // At most three marks (views.js rowMarks): severity with ⛨, then priority and type as plain text.
        const marks = rowMarks(this.risk?.get(pr.url), tri);
        return e.child(h_flex().gap(8).pt(2).items_center().children(this.riskChips(t, pr.url, id))
          .children(marks.filter((m) => m.kind !== "risk").map((m) => div().id(`${id}-${m.kind}`).tooltip(m.kind === "priority" ? PRIORITY_TIP : "The kind of change, from the PR title")
            .text_size(11).text_color(m.kind === "priority" && tri.priority === 1 ? t.foreground : t.muted).child(m.text))))
          .when(on && Boolean(tri?.why), (e) => e.child(div().mt(3).pl(8).border_l(3).border_color(t.accent).text_size(11.5).line_height(1.4).whitespace_normal().text_color(t.foreground).child(tri.why)));
      });
    // A PR you didn't open: author, draft, review decision, +/−, age; its repo for review requests.
    const other = (p) => [src === "review" ? p.repo : null, p.author ? `@${p.author}` : null, REVIEW[p.review]?.[0],
      p.add != null ? `+${p.add} −${p.del}` : null, p.updatedAt ? age(p.updatedAt) : null].filter(Boolean).join(" · ");
    const row = (p) => (src === "mine"
      ? item(`pick-${p.url}`, this.prSel?.url === p.url, `#${p.number} ${p.title ?? ""}`,
        `${p.repo.split("/").pop()} · ${p.sessionTitle ?? p.session.slice(0, 8)}`, p.state, p.agent && `↳ ${p.agent}`, (_e, cx) => this.choose(p, cx), p)
      : item(`pick-${src}-${p.url}`, this.prSel?.url === p.url, `#${p.number} ${p.title ?? ""}`, other(p), p.state, null, (_e, cx) => this.pickTarget(p, cx), p));
    const inView = C.tagged(ctxDoc()) ? " (in this view)" : "", n = open.filter((p) => this.triage?.has(p.url)).length; // triaged rows of this list
    // One sentence for an empty list: what is going on, or what to do.
    const empty = src === "mine" ? (this.scanning ? "Searching transcripts for PRs…" : "No PRs from Claude sessions") : sl?.loading ? "Asking GitHub…"
      : src === "repo" && sl?.key === null ? "Open a space on a GitHub repo to list its PRs."
      : above ? "Every open PR here is in progress above." : src === "repo" ? `No open PRs in this repo${inView}` : `No open review requests${inView}`;
    return v_flex().flex_none().p(6)
        .child(h_flex().flex_none().px(4).py(2).gap(6).items_center()
          .child(h_flex().gap(2).p(2).rounded(7).border_1().border_color(t.border).children(SOURCES.map(([k, label]) =>
            div().id(`pr-src-${k}-${this.uid}`).tooltip(SRC_TIP[k]).px(8).h(22).flex().items_center().rounded(5).cursor_pointer().text_size(11.5)
              .bg(src === k ? t.selected : t.chrome).text_color(src === k ? t.foreground : t.muted)
              .on_click((_e, cx) => { setShared("pr.source", k); this.loadSource(cx); cx.notify(); }).child(label))))
          .child(div().id(`pr-srcinfo-${this.uid}`).tooltip(src === "repo" ? "Repository these PRs come from" : "How long ago this list was fetched from GitHub").flex_1().min_w(0).truncate().text_size(10.5).text_color(t.muted)
            .child(src === "repo" ? this.spaceSlug?.slug ?? "" : sl?.loading ? "loading…" : sl?.at ? `${age(new Date(sl.at).toISOString())} ago` : ""))
          .when(src !== "mine", (e) => e.child(pill(`pr-src-reload-${this.uid}`, t, sl?.loading ? "…" : "↻", (_e, cx) => this.loadSource(cx, true), false, "Fetch this list from GitHub again", "Reload PR list"))))
        .child(h_flex().flex_none().px(4).py(2).gap(6).items_center()
          .child(div().id(`pr-openref-${this.uid}`).flex_1().min_w(0).h(26).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).cursor_text().tooltip("Paste a PR URL or owner/repo#123, then Open")
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.openRefInput).h_full().text_size(11.5).text_color(t.foreground)))
          .child(pill(`pr-openref-go-${this.uid}`, t, "Open", (_e, cx) => this.openRef(cx), false, "Open the PR typed on the left")))
        .when(Boolean(sl?.error) && src !== "mine", (e) => e.child(div().px(8).py(4).text_size(11).text_color(t.ansi1).whitespace_normal().child(sl.error)))
        // The triage line only says something when PRs were triaged; without any, only Setup is left of it.
        .child(h_flex().flex_none().px(8).py(4).gap(6).items_center()
          .child(div().id(`pr-triage-info-${this.uid}`).tooltip("Priority and chips come from cached data; no GitHub or AI call").flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(n ? `${n} open ${n === 1 ? "PR" : "PRs"} triaged from cached data` : ""))
          .when(n > 0, (e) => e.child(pill(`pr-triage-${this.uid}`, t, this.triaging ? "Triaging…" : "Triage PRs", (_e, cx) => this.runTriage(cx), false, "Rank the listed open PRs with one small AI call per context")))
          .child(pill(`pr-setup-${this.uid}`, t, "Setup", (_e, cx) => { this.picking = false; this.view = "setup"; runSetup(this, cx, false); cx.notify(); }, false, "Check which programs this mod needs are installed")))
        .child(item("pick-branch", Boolean(this.branchPicked && !this.prSel), "Current branch", "Diff of the focused pane", null, null, (_e, cx) => this.choose(null, cx)))
        .children(open.map(row))
        .when(done.length > 0, (e) => e.child(h_flex().id(`pr-done-${this.uid}`).flex_none().mt(4).px(8).h(24).gap(6).items_center().rounded(6).cursor_pointer().text_size(11.5).text_color(t.muted)
          .tooltip(this.showDone ? "Hide the merged and closed PRs" : "Show the merged and closed PRs").hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.showDone = !this.showDone; cx.notify(); }).child(div().w(10).flex_none().child(this.showDone ? "▾" : "▸")).child(`Merged or closed (${done.length})`)))
        .when(done.length > 0 && Boolean(this.showDone), (e) => e.children(done.map(row)))
        .when(!list.length, (e) => e.child(div().p(8).whitespace_normal().text_color(t.muted).child(empty)));
  }

  diffRow(row, i, t, plain = false) {
    const { kind, number, text } = row;
    if (kind === "@") return div().id(`r-${i}`).w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    const selectable = !plain && (kind === "+" || kind === "-" || kind === " ");
    const lo = Math.min(this.sel ?? -1, this.selEnd ?? this.sel ?? -1), hi = Math.max(this.sel ?? -1, this.selEnd ?? this.sel ?? -1);
    return h_flex().id(`r-${i}`).w_full().h(20).flex_none().gap(10)
      .when(kind === "+", (e) => e.bg("#2ea0431a")).when(kind === "-", (e) => e.bg("#f851491a"))
      .when(!plain && i >= lo && i <= hi && this.sel !== null, (e) => e.bg(t.selection))
      .when(selectable, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((ev, cx) => {
        this.fh.focus();
        if (ev.modifiers.shift && this.sel !== null) this.selEnd = i;
        else { this.sel = this.sel === i && this.selEnd === null ? null : i; this.selEnd = null; }
        this.askTop = false;
        if (this.sel !== null) this.focusInput(cx); // the composer under it takes the typing
        cx.notify();
      }))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().children(renderLine(div, text, (plain ? null : this.spans?.[i]) ?? [], colors(t))));
  }

  commentBox(c, t, label) {
    return v_flex().id(`c-${c.id}`).flex_none().mx(12).my(3).px(8).py(5).gap(2).rounded(6).border_1().border_color(this.editing?.id === c.id ? t.accent : t.border).bg(t.surface)
      .font_family(settings().ui_font ?? "Geist").text_size(12)
      .child(h_flex().gap(8).text_size(10.5).text_color(t.dim).child(div().flex_1().min_w(0).truncate().child(label ?? uiLine(c)))
        .child(div().id(`ce-${c.id}`).tooltip("Edit this comment").cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.editComment(c, cx)).child("Edit"))
        .child(div().id(`cd-${c.id}`).tooltip("Delete this comment; it has not been sent").cursor_pointer().hover((s) => s.text_color(t.ansi1)).on_click((_e, cx) => this.dropComment(c, cx)).child("Delete")))
      .child(div().whitespace_normal().child(c.text));
  }

  // Reviews started and not done (shared "review.open", written by the review layout): Resume goes back to exactly
  // where it was, a click on the row shows the PR's diff here like a row of the list. Under the title the risk signal
  // and the progress, wrapped; when it was last touched is in the row's tooltip. Only the contexts the view shows,
  // each tagged when there are several.
  openReviews(t) {
    const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
    const list = (shared("review.open") ?? []).filter(shownIn), { shown, more } = capped(list, this.allOpen);
    return v_flex().flex_none().px(10).pt(8).pb(4).gap(2).border_b(1).border_color(t.border)
      .child(h_flex().px(4).gap(8).items_center().child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child("In progress"))
        .when(Boolean(this.allOpen) && list.length > IN_PROGRESS_MAX, (e) => e.child(pill(`pr-open-less-${this.uid}`, t, "Show fewer", (_e, cx) => { this.allOpen = false; cx.notify(); }, false, "Show only the most recent reviews"))))
      .children(shown.map((r) => [r, this.riskChips(t, r.url, `pr-open-${r.url}`)]).map(([r, risk]) => h_flex().id(`pr-open-${r.url}`).gap(8).px(4).py(3).rounded(6).items_start().cursor_pointer().tooltip(`Select this PR to see its diff. Last touched ${ago(r.lastTouched)}.`)
        .when(this.prSel?.url === r.url, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pickTarget(r.target ?? r, cx))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().text_size(12.5).child(`#${r.number} ${r.title ?? ""}`))
          .when(risk.length > 0, (e) => e.child(h_flex().flex_wrap().gap(4).children(risk)))
          .child(div().whitespace_normal().text_size(11).text_color(t.muted).child([r.status === "sent" ? "sent" : null, progressText(r.progress)].filter(Boolean).join(" · "))))
        .when(C.tagged(ctxDoc()), (e) => e.child(ctxTag(t, prCtx(r), r.url)))
        .child(pill(`pr-resume-${r.url}`, t, "Resume", (_e, cx) => { cx.stop_propagation(); startReview(r.target ?? r); }, false, "Continue this review where you left it"))))
      .when(more > 0, (e) => e.child(div().id(`pr-open-all-${this.uid}`).px(4).py(3).text_size(11.5).text_color(t.accent).cursor_pointer().tooltip("List every review in progress")
        .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.allOpen = true; cx.notify(); }).child(`Show all (${list.length})`)));
  }

  // The current branch's PR as a review target: no session, so what is sent goes to this space's agent.
  branchTarget() {
    const repo = /github\.com\/([^/]+\/[^/]+)\/pull/.exec(this.pr.url)?.[1];
    return { url: this.pr.url, number: this.pr.number, title: this.pr.title, repo, state: "open", base: this.pr.baseRefName,
      context: this.ctxId(), session: null, cwd: this.root, space: location().space, headSha: this.pr.headRefOid ?? null };
  }

  // Removed or closed: Go to stops offering "Review PR" (a stale handler would hand PRs to nobody). Another copy
  // that still runs announces them again on its next render.
  async close() {
    if (!this.announces) return;
    setShared("goto.handlers.review", null);
    setShared("goto.items.review", null);
  }

  render(cx) {
    if (this.announces && !shared("goto.handlers.review") && !this.announceQueued) {
      this.announceQueued = true;
      cx.timer.after(0, () => { this.announceQueued = false; this.publishGoto(); });
    }
    if (this.part === "bar") return this.renderBar(cx);
    if (this.part === "reviews") return renderReviews();
    if (this.part === "agentbar") return renderAgentBar();
    if (this.part === "keys") return renderKeys();
    if (this.part === "cmenu") return renderCardMenu();
    if (this.part === "mini") {
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
          startReview(r ? r.target ?? r : { url: ref.url, repo: ref.repo, number: Number(ref.number), source: "open" });
        });
      }
      return renderMini();
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
      return this.renderReview(cx);
    }
    if (this.view === "walk" && this.walkModel && walkModel() !== this.walkModel && !this.walkBusy) this.openWalk(cx, false); // picker changed: that model's cache
    // Go to: a handed-over PR (outside render), and the reviews-in-progress items when that list changes.
    if (shared("pr.goto")?.url && !this.gotoQueued) { this.gotoQueued = true; cx.timer.after(0, (cx) => { this.gotoQueued = false; this.takeGoto(cx); }); }
    if (shared("review.open") !== this.gotoOpen) { this.gotoOpen = shared("review.open"); cx.timer.after(0, () => this.publishGoto()); }
    if (!this.scanQueued && visible() && windowActive() && Date.now() - (this.scanAt ?? 0) >= PRS_MS) { this.scanQueued = true; cx.timer.after(0, (cx) => { this.scanQueued = false; this.scanIfDue(cx); }); }
    // The selection is never dropped here: a PR the view hides gets a banner instead.
    // refresh() notifies, which render may not: queue it once, right after this render.
    if (!this.refreshQueued && visible() && (this.key() !== this.context || (!this.prSel && this.root && this.dirty.has(this.root)))) {
      this.refreshQueued = true;
      cx.timer.after(0, (cx) => { this.refreshQueued = false; this.refresh(cx, this.key() === this.context); });
    }
    const t = theme();
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const title = this.pr ? `#${this.pr.number} ${this.pr.title}` : this.base ? `vs ${this.base}` : "PR";
    const anchor = this.anchor();
    const where = this.open ? `${this.open.split("/").pop()}${anchor?.start !== undefined ? " " + uiLine(anchor) : ""}` : "whole diff";
    const canSend = Boolean((this.root || this.pr) && !this.sending);
    // Comments of the open file under their last line; the rest (whole file, line gone) above the diff.
    const mine = this.comments.filter((c) => c.file === this.open), at = new Map(), loose = [];
    for (const c of mine) { const i = anchorRow(this.rows, c); if (i < 0) loose.push(c); else at.set(i, [...(at.get(i) ?? []), c]); }
    const shown = this.rows.slice(this.from, this.from + 1500);
    // Syntax colours outside render, a slice at a time (a big file takes longer than Herdr's ~50 ms per slice); the
    // rows show plain until their file is done.
    if (this.hl?.rows !== this.rows) { this.hl = { rows: this.rows, job: highlightJob(this.rows, langOf(this.open ?? "")), spans: null }; this.highlightMore(cx, this.hl); }
    this.spans = this.hl.spans;
    const diffId = `pr-diff-${this.uid}-${this.from}`; // a new id starts scrolled to the top: how j/k bring a change into view
    const state = this.view === "setup" ? "setup" : panelState({ chosen: this.prSel ?? this.branchPicked, picking: this.picking });
    const tab = bodyTab(this.view), chosen = this.prSel ? "PR" : "branch";
    if (state === "picking" && !this.srcAsked) { this.srcAsked = true; cx.timer.after(0, (cx) => this.loadSource(cx)); } // the list, once, after this render
    const back = (_e, cx) => { this.picking = true; this.loadSource(cx); cx.notify(); };
    const resume = this.pr?.url ? (shared("review.open") ?? []).find((r) => r.url === this.pr.url) : null; // this PR's review in progress
    // The header: picking shows the list's title (and the way back to the chosen PR); a chosen PR its title and actions.
    const header = state === "selected"
      ? h_flex().min_h(42).flex_none().pl(8).pr(10).py(5).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().id(`pr-back-${this.uid}`).flex_none().w(26).h(26).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("All PRs").on_click(back).child("←"))
        .child(div().id(`pr-title-${this.uid}`).tooltip(title).flex_1().min_w(0).max_h(36).overflow_hidden().whitespace_normal().line_height(1.35).font_semibold().child(title)) // two lines, then cut
        .child(pill(`pr-reload-${this.uid}`, t, this.loading ? "…" : "↻", (_e, cx) => { if (this.prSel) this.heads.delete(this.prSel.url); this.refresh(cx, true); }, false, "Reload this PR's diff and details", "Reload PR"))
        .when(Boolean(this.pr), (e) => e.child(pill("pr-web", t, "GitHub ↗", () => openUrl(this.pr.url), false, "Open this PR on GitHub in the browser")))
        // The way into the review is the header's one filled button; Resume once this PR's review was started.
        .when(Boolean(this.pr?.url), (e) => e.child(div().id(`pr-rv-${this.uid}`).tooltip(resume ? "Continue this review where you left it" : "Open this PR in the review layout").flex_none().px(12).h(26).flex().items_center().rounded(6)
          .text_size(12).font_semibold().bg(t.solid).text_color(t.solid_foreground).cursor_pointer().on_click(() => startReview(resume?.target ?? this.prSel ?? this.branchTarget())).child(resume ? "Resume" : "Review")))
      : h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(state === "setup" ? "Setup" : "Pull requests"))
        .when(state === "picking", (e) => e.child(pill(`pr-explore-${this.uid}`, t, "Explore a topic…", () => startExplore(location().cwd ?? null), false, "Ask about a topic in this repo's code, in the review layout")))
        .when(state === "picking" && Boolean(this.prSel ?? this.branchPicked), (e) => e.child(pill(`pr-pick-done-${this.uid}`, t, `Back to ${chosen} →`, (_e, cx) => { this.picking = false; cx.notify(); }, false, `Return to the selected ${chosen}`)));
    // The selected PR's tabs: Diff | Walkthrough, its size; a branch diff also offers its files as they are now.
    const seg = (k, label, click) => div().id(`pr-tab-${k}-${this.uid}`).px(10).h(22).flex().items_center().rounded(5).cursor_pointer().text_size(12).tooltip(k === "diff" ? "Changed files and the diff; click a line to comment" : "The review's AI analysis in reading order, if you ran it")
      .bg(tab === k ? t.selected : t.chrome).text_color(tab === k ? t.foreground : t.muted).on_click(click).child(label);
    const tabs = h_flex().flex_none().flex_wrap().px(10).py(6).gap(8).items_center().border_b(1).border_color(t.border)
      .child(h_flex().flex_none().p(2).gap(2).rounded(7).border_1().border_color(t.border)
        .child(seg("diff", "Diff", (_e, cx) => { this.view = "diff"; cx.notify(); }))
        .child(seg("walk", "Walkthrough", (_e, cx) => this.openWalk(cx, false))))
      .child(h_flex().flex_1().gap(6).items_center().text_size(11).child(div().id(`pr-add-${this.uid}`).tooltip("Lines added in this diff").text_color(t.ansi2).child(`+${add}`)).child(div().id(`pr-del-${this.uid}`).tooltip("Lines removed in this diff").text_color(t.ansi1).child(`−${del}`)))
      .when(tab === "diff" && Boolean(this.open && !this.patch), (e) => e
        .child(pill(`mode-${this.uid}`, t, this.mode === "file" ? "Diff view" : "File view", (_e, cx) => this.setMode(this.mode === "file" ? "diff" : "file", cx), false, "Switch between the diff and the whole file"))
        .child(pill(`vscode-${this.uid}`, t, "VS Code ↗", () => exec("code", ["-g", `${this.root}/${this.open}:${(this.sel !== null && this.rows[this.sel]?.number) || 1}`]), false, "Open this file at the selected line in VS Code")));
    // Picking: reviews in progress and the sources' list in one scroll, so nothing stacks over anything.
    const pickId = `pr-pick-${this.uid}`;
    const pickBody = div().flex_1().min_h(0).relative()
      .child(v_flex().id(pickId).absolute().inset_0().overflow_y_scroll()
        .when((shared("review.open") ?? []).some(shownIn), (e) => e.child(this.openReviews(t)))
        .child(this.picker(t)))
      .child(Scrollbar.vertical(pickId).absolute().inset_0());
    // The composer: under the selected lines, at the top for the whole file, or in place of the comment being edited.
    const lo = Math.min(this.sel ?? -1, this.selEnd ?? this.sel ?? -1), hi = Math.max(this.sel ?? -1, this.selEnd ?? this.sel ?? -1);
    const composeAt = this.editing || this.mode === "file" ? null : this.askTop ? "top" : this.sel !== null ? hi : null;
    const box = (c, label) => (this.editing?.id === c.id ? this.composer(t, where) : this.commentBox(c, t, label));
    const files = div().flex_none().h(Math.max(44, Math.min(this.files.length * 28 + 12, 200))).relative().border_b(1).border_color(t.border)
      .child(v_flex().id(`pr-files-${this.uid}`).absolute().inset_0().overflow_y_scroll().p(6).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop(), n = this.comments.filter((c) => c.file === f.path).length;
        return h_flex().id(`f-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().tooltip(f.path)
          .when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.fh.focus(); this.askTop = false; this.pick(f.path, cx); })
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().min_w(0).truncate().child(name)))
          .when(n > 0, (e) => e.child(div().id(`f-c-${f.path}`).tooltip(`${n} pending ${n === 1 ? "comment" : "comments"} on this file`).text_size(10.5).text_color(t.accent).child(`● ${n}`)))
          .when(f.add > 0, (e) => e.child(div().id(`f-a-${f.path}`).tooltip("Lines added in this file").text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
          .when(f.del > 0, (e) => e.child(div().id(`f-d-${f.path}`).tooltip("Lines removed in this file").text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).whitespace_normal().text_color(this.error ? t.ansi1 : t.dim).child(this.error || (this.loading ? Spin(t, "Loading…") : "No changes against the base")))))
      .child(Scrollbar.vertical(`pr-files-${this.uid}`).absolute().inset_0());
    const diffBody = this.mode === "file"
      ? div().flex_1().min_h(0).relative()
        .child(this.code ? Editor.new(this.code).size_full()
          : this.md !== null ? v_flex().id(`pr-md-${this.uid}`).absolute().inset_0().overflow_y_scroll().p(14).child(TextView.markdown(`pr-mdv-${this.uid}`, this.md))
          : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…"))
      : div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        // ponytail: plain list, capped at 1500 rows; the virtual list drew nothing here
        .child(v_flex().id(diffId).absolute().inset_0().overflow_y_scroll()
          .when(this.from > 0, (e) => e.child(div().id(`pr-above-${this.uid}`).px(12).h(22).flex_none().flex().items_center().text_color(t.dim).cursor_pointer().tooltip("Show the rows above, back to the top of the diff")
            .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.from = 0; cx.notify(); }).child(`▲ Show ${this.from} lines above`)))
          .when(Boolean(this.open) && composeAt !== "top", (e) => e.child(div().id(`pr-ask-file-${this.uid}`).px(12).h(24).flex_none().flex().items_center()
            .font_family(settings().ui_font ?? "Geist").text_size(11.5).text_color(t.dim).cursor_pointer().tooltip("Write a comment or question about the whole file (c)").hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.sel = null; this.selEnd = null; this.askTop = true; this.focusInput(cx); cx.notify(); })
            .child(`+ Comment or ask about ${this.open?.split("/").pop() ?? "this file"} (or click a line)`)))
          .when(composeAt === "top", (e) => e.child(this.composer(t, where)))
          .children(loose.map((c) => box(c, c.start === undefined ? "whole file" : `${uiLine(c)} · no longer in the diff`)))
          .children(shown.flatMap((r, k) => [this.diffRow(r, this.from + k, t), ...(at.get(this.from + k) ?? []).map((c) => box(c)),
            ...(composeAt === this.from + k && lo >= 0 ? [this.composer(t, where)] : [])])))
        .child(Scrollbar.vertical(diffId).absolute().inset_0());
    return dock(this, v_flex(), inView(), cx).size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.fh).on_key_down((e, cx) => this.onKey(e, cx))
      .child(header)
      .when(Boolean(setupBanner(this, t)), (e) => e.child(setupBanner(this, t)))
      .when(state === "setup", (e) => e.child(renderSetup(this, t)))
      .when(state === "picking", (e) => e.child(pickBody))
      .when(state === "selected", (e) => e
        .when(Boolean(this.prSel && !shownIn(this.prSel)), (e) => e.child(h_flex().flex_none().flex_wrap().px(14).py(6).gap(8).items_center().bg(t.ansi3 + "1c").border_b(1).border_color(t.border).text_size(12)
          .child(div().flex_1().min_w(0).child(`This PR belongs to ${C.nameOf(ctxDoc(), prCtx(this.prSel))}.`))
          .when(Boolean(C.revealOf(ctxDoc(), prCtx(this.prSel))), (e) => e.child(pill(`pr-acc-${this.uid}`, t, `Switch to ${C.labelOf(ctxDoc(), prCtx(this.prSel))}`, () => { const r = C.revealOf(ctxDoc(), prCtx(this.prSel)); setShared(r.key, r.value); }, false, "Switch the view to the context this PR belongs to")))
          .child(pill(`pr-clear-${this.uid}`, t, "Clear", (_e, cx) => this.choose(null, cx), false, "Drop this PR selection"))))
        .child(tabs)
        .when(tab === "walk", (e) => e.child(this.walkView(t)))
        .when(tab === "diff", (e) => e.child(files).child(diffBody)))
      .when(Boolean(this.note), (e) => e.child(div().flex_none().px(10).pt(6).text_size(11).whitespace_normal().text_color(/Could not|Not sent|Not a PR/.test(this.note ?? "") ? t.ansi1 : t.dim).child(this.note)))
      // The pending comments: a count, not a main button. For a PR it opens the review's "Finish your review" (post to
      // GitHub or send to an agent, after a preview); a branch without a PR has no review, so its comments go to the agent.
      .when(state === "selected" && this.comments.length > 0, (e) => e.child(h_flex().flex_none().m(8).px(10).h(32).gap(8).items_center().rounded(8).bg(t.surface).border_1().border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(pendingText(this.comments)))
        .child(pill(`rv-drop-${this.uid}`, t, "Discard", (_e, cx) => { this.comments = []; this.persist(cx); cx.notify(); }, false, "Delete all pending comments without sending them"))
        .child(this.pr?.url
          ? pill(`rv-finish-${this.uid}`, t, "Finish your review", () => this.finishReview(), false, "Open the review with a preview of these comments, then post them to GitHub or send them to an agent")
          : pill(`rv-send-${this.uid}`, t, this.sending ? "…" : "Send to agent", (_e, cx) => { if (canSend) this.sendReview(cx); }, false, "Send all pending comments to the coding agent as one prompt"))));
  }

  // The inline composer (GitHub style, one at a time): where it points, the presets, the field, Cancel / Comment / Ask.
  composer(t, where) {
    const canSend = Boolean((this.root || this.pr) && !this.sending), ready = Boolean(this.question.trim() && canSend);
    const btn = (id, label, on, click, solid = false, tip = "") => div().id(`${id}-${this.uid}`).tooltip(tip).flex_none().h(26).px(10).flex().items_center().rounded(6).text_size(12)
      .when(solid, (e) => e.bg(on ? t.solid : t.raised).text_color(on ? t.solid_foreground : t.dim))
      .when(!solid, (e) => e.border_1().border_color(t.border).text_color(on ? t.foreground : t.dim))
      .when(on, (e) => e.cursor_pointer()).on_click(click).child(label);
    return v_flex().id(`pr-compose-${this.uid}`).flex_none().mx(12).my(4).p(8).gap(6).rounded(8).border_1().border_color(t.accent).bg(t.surface)
      .font_family(settings().ui_font ?? "Geist").text_size(12)
      .child(h_flex().flex_wrap().gap(6).items_center()
        .child(div().flex_1().min_w(80).truncate().text_size(11).text_color(t.dim).child(this.editing ? "Editing comment (Esc: cancel)" : `On ${where}`))
        .when(!this.editing, (e) => e.children(PRESETS.map(([label, q], i) => pill(`preset-${i}-${this.uid}`, t, label, (_e, cx) => this.ask(cx, q), false, `Send this question to the agent now: ${q}`)))))
      .child(div().id("pr-question").tooltip("Type a comment or a question about the selected lines").h(30).px(8).flex().items_center().rounded(6).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().gap(6).justify_end()
        .child(btn("pr-cancel", "Cancel", true, (_e, cx) => this.closeAsk(cx), false, "Close without saving (Esc)"))
        .child(btn("pr-comment", this.editing ? "Save" : "Comment", Boolean(this.question.trim() && this.open), (_e, cx) => this.addComment(cx), false, this.editing ? "Save the changed comment" : "Add to the pending review; nothing is sent yet"))
        .when(!this.editing, (e) => e.child(btn("pr-ask", this.sending ? "…" : "Ask", ready, (_e, cx) => this.ask(cx), true, "Send this question to the coding agent now"))));
  }
}

Object.assign(PrReview.prototype, ReviewMode);
