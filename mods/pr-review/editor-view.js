// The Herdr side of "Open in <Editor>" (editor.js has the table and the rules; CONTRACT-EDITOR.md with its addendum:
// one process per click, no process to find the installed editors, the choice shared between the mods, a state
// "Opening …" for three seconds and a toast only when it failed).
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, shared, setShared, readTextFile, openOverlay, home, appHome, notify } from "herdr";
import * as E from "./editor.js";
import { TYPE } from "./views.js";
import { readConfig } from "./setup-view.js";

const KEY = "pr-review.editors", DAY = 86400000, NONE_MS = 10 * 60000, CHOICE = "editor.choice", OPENING_MS = 3000;
let dryRuns = []; // what the clicks of a dry run would have started (pr-review.config.json "dryRun": true), newest last
let known = null, looking = null, asked = false, extra = []; // {at, found}; the lookup under way; one was queued; the settings' own editors
const roots = new Map(); // checkout root → {marks, common, linked}: its project marks and its `.git` (file reads, once per root)
const opening = new Map(); // a target's key → until when its link says "Opening …" and takes no click
// Herdr's localStorage (per mod copy). Under node (the tests) there is none, and asking for it prints a warning.
const store = () => (typeof process !== "undefined" && process.versions?.node ? null : globalThis.localStorage ?? null);

export const setEditors = (list) => { extra = E.extraEditors(list); }; // pr-review.config.json "editors"
const stored = () => { if (!known) { try { known = JSON.parse(store()?.getItem(KEY) ?? "null"); } catch { known = null; } } return known; };
export const dryOpened = () => dryRuns;
export const forgetEditors = () => { known = null; looking = null; asked = false; roots.clear(); reads.clear(); opening.clear(); extra = []; dryRuns = []; try { store()?.removeItem(KEY); } catch { /* none */ } }; // tests

// Finds the installed editors by reading the files that say so (editor.js candidates): no process. Within a day the
// remembered answer is taken (force: the menu's "Look for installed editors again", and after an editor could not be started).
// The files of both systems are read (macOS apps first): which system this is need not be known, and is not at start.
// "None found" holds for ten minutes and is not stored: an editor installed since is found without a restart.
const fresh = (s) => Boolean(s) && Date.now() - s.at < (Object.keys(s.found ?? {}).length ? DAY : NONE_MS);
export function lookForEditors(force = false) {
  const s = stored();
  if (!force && fresh(s)) return Promise.resolve(s.found);
  return (looking ??= (async () => {
    const cands = ["darwin", "linux"].flatMap((o) => E.candidates(home(), o)), present = await Promise.all(cands.map((c) => readTextFile(c.path).then((x) => x !== null).catch(() => false)));
    known = { at: Date.now(), found: E.foundFrom(cands, present) };
    try { if (Object.keys(known.found).length) store()?.setItem(KEY, JSON.stringify(known)); else store()?.removeItem(KEY); } catch { /* kept in memory */ }
    return known.found;
  })().finally(() => { looking = null; })); // also after a failure: the next ask looks again
}

// A redraw once something read in the background is there. Herdr's cx is valid only inside the call that got it: the
// timer's cx starts a task, and the task's own cx is the one used after the wait (never the render's or the timer's).
const later = (cx, wait) => cx?.timer?.after?.(0, (cx) => cx.spawn(async (cx) => { await wait(); cx.notify(); }));

// What a checkout's root says about its project, read as files: the marks of a JVM project (`.idea` is a folder: a
// file IntelliJ keeps in it stands for it) and its `.git` (a file in a linked worktree; names the shared git folder).
// Until the files are read, a main checkout of no special kind is assumed; rootRead waits for them.
const reads = new Map(); // root → {done: Promise, told: a redraw was asked for}
function rootRead(root) {
  if (!reads.has(root)) {
    roots.set(root, { marks: [], ...E.gitLink(null, root) });
    const read = (f) => readTextFile(`${root}/${f}`).catch(() => null);
    reads.set(root, { told: false, done: Promise.all([read(".git"), ...E.PROJECT_MARKS.map((m) => read(m === ".idea" ? ".idea/misc.xml" : m))])
      .then(([git, ...got]) => { roots.set(root, { marks: E.PROJECT_MARKS.filter((_m, k) => got[k] !== null), ready: true, ...E.gitLink(git, root) }); }) });
  }
  return reads.get(root).done;
}
function rootInfo(root, cx) {
  const done = rootRead(root), r = reads.get(root);
  if (cx && !r.told && !roots.get(root).ready) { r.told = true; later(cx, () => done); }
  return roots.get(root);
}

// The editor a link for this target names: {id, why}, or null while the editors are not known yet or none is
// installed (then there is no link). An ask without a fresh answer (none yet, a day old, or "none found" ten minutes
// ago) starts the lookup after this render, and reads the root meanwhile; the answer from before is used until then.
export function editorFor(target, cx) {
  const root = target?.root;
  if (!root) return null;
  const s = stored(), r = rootInfo(root, cx);
  if (!fresh(s) && !looking && !asked && cx) { asked = true; later(cx, () => lookForEditors().finally(() => { asked = false; })); }
  if (!s) return null;
  return E.editorOf({ file: target.file ?? null, marks: r.marks, linked: r.linked, choice: shared(CHOICE), key: r.common, found: s.found, extra, foreign: Boolean(target.foreign) });
}

// Why a target has no link at all, or null: a PR that is not trusted never opens a folder, nor a file an editor acts
// on by opening it; a path that leaves the checkout is nobody's file.
function refused(target) {
  if (target.file && !E.safeFile(target.root, target.file)) return "This path is not a file of the checkout.";
  if (target.foreign && !target.file) return "This PR is not trusted yet: an editor can run a project's code when it opens its folder.";
  if (target.foreign && E.foreignBlocked(target.file)) return "This PR is not trusted yet, and an editor acts on this file by opening it. Read it here.";
  return null;
}

// A path of a PR that is not trusted, by what it is in the checkout and not by its text: safegit.py regular-file (one
// read-only process) asks git's index and then the disk. Only one tracked regular file passes: not a folder ("src/"),
// not a symlink the PR put there (it may name anything on this machine), not a submodule, and not a name that is a
// file in the index but a symlink on a disk that ignores case. → the file's real path (that one is opened, not the
// text that was clicked), or null. Every place that draws a link comes through openIn, also those whose path an
// analysis wrote.
async function foreignFile(target) {
  const rel = E.safeFile("/", target.file)?.slice(1);
  const r = await exec("python3", [`${appHome()}/mods/pr-review/safegit.py`, target.root, "regular-file", rel], { timeout: 20000 }).catch(() => null);
  return r?.code === 0 && r.stdout.startsWith("/") ? r.stdout : null;
}

// A click: ONE editor process (for a PR that is not trusted, git is asked what the path is first). target: {root
// (the checkout), file? (below it), line?, foreign?, where? (words for the tooltip)}. id: another editor than the
// target's own (the ▾ menu). Gives a sentence when it did not open.
export async function openIn(target, id = null) {
  const no = refused(target);
  if (no) return no;
  const real = target.foreign ? await foreignFile(target) : null;
  if (target.foreign && !real) return "This PR is not trusted yet, and this path is not a regular file of its checkout (a folder, a link or a submodule are not opened). Read it here.";
  if (target.foreign && id === "idea" && E.buildScript(target.file)) return "This PR is not trusted yet, and IntelliJ IDEA evaluates a build script when it opens one. Open it in another editor, or read it here.";
  const found = await lookForEditors();
  await rootRead(target.root); // a folder no link has shown yet: its kind of project and its `.git` first, then the editor
  const use = id ?? editorFor(target, null)?.id;
  // Read before anything starts (also for a click that comes before the mod's own read of its settings): with
  // "dryRun": true in the mod's settings, or with a file `editor.dry-run` in the Herdr home (one file for every mod
  // of the set: a test home's whole guard), no editor is started; what would have run is kept (dryOpened). A stand-in
  // `open` on the PATH is no guard: exec runs with the login shell's PATH, not the window's.
  const [cfg, mark] = await Promise.all([readConfig(), readTextFile(`${appHome()}/editor.dry-run`).catch(() => null)]), more = cfg.editors ? E.extraEditors(cfg.editors) : extra;
  const argv = use ? E.openArgv(use, found[use], target.file ? { file: real ?? E.safeFile(target.root, target.file), line: target.line ?? null } : { dir: target.root }, more) : null;
  if (!argv) return "No editor to open this in was found.";
  if (cfg.dryRun === true || mark !== null) { dryRuns = [...dryRuns.slice(-19), { at: Date.now(), argv: [argv[0], ...argv[1]] }]; notify({ title: "Dry run: no editor started", body: [argv[0], ...argv[1]].join(" "), level: "info" }); return null; }
  const r = await exec(argv[0], argv[1], { timeout: 20000 }).catch((e) => ({ code: 1, stderr: String(e) }));
  if (r.code === 0) return null;
  known = null; try { store()?.removeItem(KEY); } catch { /* none */ } // it may be gone: look again the next time
  return E.failedText(use, extra);
}

const keyOf = (target) => `${target.root}\n${target.file ?? ""}\n${target.line ?? ""}`;
export const isOpening = (target) => (opening.get(keyOf(target)) ?? 0) > Date.now();
// A view's click on a link: the link says "Opening …" at once and for three seconds and takes no second click
// (a lock per target, not for the whole mod); only a failure is said, as a toast.
export function startOpen(target, cx, id = null) {
  if (isOpening(target)) return;
  opening.set(keyOf(target), Date.now() + OPENING_MS); cx.notify();
  cx.timer.after(OPENING_MS, (cx) => { if (!isOpening(target)) opening.delete(keyOf(target)); cx.notify(); });
  cx.spawn(async (cx) => { const note = await openIn(target, id); if (note) { opening.delete(keyOf(target)); notify({ title: "Open in editor", body: note, level: "error" }); cx.notify(); } });
}

// The ▾ menu's pick: this editor for this project from now on, for its main checkout or for its worktrees (shared
// with the other mods; written only when it changed).
export async function chooseEditor(root, id) {
  await rootRead(root); // whether it is a worktree decides which of the project's two picks this is
  const r = roots.get(root), { choice, changed } = E.withChoice(shared(CHOICE), r.common, r.linked, id);
  if (changed) setShared(CHOICE, choice);
}

// The ▾ menu as a small menu's items ([label, danger, command]) for the mod's menu part. token: this menu's own
// (openEditorMenu), in the commands of the entries that act on its target.
export function editorMenu(target, token = "") {
  const r = roots.get(target.root) ?? { linked: false };
  return E.menuItems({ now: editorFor(target, null), found: stored()?.found ?? {}, extra, linked: r.linked, file: target.file ?? null, line: target.line ?? null })
    .map((m) => [m.kind === "copy" ? `${m.text} (${m.hint})` : m.hint ? `${m.text} · ${m.hint}` : m.text, false,
      m.kind === "editor" ? `editor-use:${token}:${m.id}` : m.kind === "copy" ? `editor-copy:${token}` : m.kind === "again" ? "editor-look" : "editor-none"]);
}
// A menu's commands go to every copy of the mod, and a menu closed with Esc leaves its target behind: each menu has a
// token, kept with the target and named in its commands, so only the copy whose menu it is acts, and only on the
// target of the menu that was clicked (editorCommand).
export function openEditorMenu(view, target) {
  const token = Math.random().toString(36).slice(2, 10);
  view.editorTarget = { ...target, token };
  // Once the root is read: the menu says "this repo" or "worktrees of this repo" by what it is.
  return Promise.all([rootRead(target.root), lookForEditors()]).then(() => { const items = editorMenu(target, token); openOverlay({ mod: "pr-review", props: { part: "cmenu", key: "editor", items }, kind: "popup", width: 440, height: 12 + 30 * items.length }); });
}

// The words of a link for a target.
export const editorTip = (id, target) => E.linkTip(id, { dir: target.root, file: target.file ?? null, line: target.line ?? null, where: target.where ?? "", foreign: Boolean(target.foreign) }, extra);
export const editorLabel = (id, short = false) => (short ? E.shortLabel(id, extra) : E.linkLabel(id, extra));
export const editorOpening = (id) => E.openingLabel(id, extra);
export const editorFull = (id) => E.editorName(id, extra);
export const editorMenuTip = E.MENU_TIP; // the ▾'s tooltip, for a ▾ a list row draws itself
// What a place shows for a target, as data (a list row draws it into its own zones): null when there is no link.
export function editorMark(target, cx, short = false) {
  if (!target?.root || refused(target)) return null;
  const ed = editorFor(target, cx);
  if (!ed) return null;
  const busy = isOpening(target);
  return { id: ed.id, busy, text: busy ? editorOpening(ed.id) : editorLabel(ed.id, short), tip: editorTip(ed.id, target) };
}

// The link for a place outside a virtual list: [] when there is nothing to open or no editor. Link form: the
// editor's name and a ▾ with the menu. Short form (a row of a list or a card): a place of SHORT_W that is always
// kept, so nothing moves, and the monogram in it only while the pointer is on that place: a list of rows is not a
// column of "VS ↗". After a click it says "Opening <Editor> …" for its three seconds, as wide as that is. A right
// click opens the menu. view.openEditor(target, cx) is the click.
// ponytail: the pointer on the link's own place shows it, not the pointer anywhere on its row; a row would have to
// report its hover and the view draw again for every row passed (gpui-kit has no hover of a parent in a child's style).
export const SHORT_W = 44;
export function editorLink(view, t, key, target, cx, short = false) {
  const m = editorMark(target, cx, short);
  if (!m) return [];
  const base = (id) => div().id(id).flex_none().flex().items_center().text_size(TYPE.panel).accessibility_label(`Open in ${editorFull(m.id)}`);
  const click = (e) => (m.busy ? e.text_color(t.dim) : e.cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); view.openEditor(target, cx); }));
  if (short) return [click(base(`ed-${key}`).min_w(SHORT_W).h(20).justify_end().text_color(`${t.foreground.slice(0, 7)}00`).hover((s) => s.text_color(t.foreground)).tooltip(E.shortTip(m.tip))
    .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openEditorMenu(view, target); })).child(m.text)];
  return [h_flex().flex_none().items_center().border_1().border_color(t.border).rounded(5)
    .child(click(base(`ed-${key}`).h(24).px(8).rounded(5).text_color(t.muted).hover((s) => s.text_color(t.foreground)).tooltip(m.tip)).child(m.text))
    .child(div().id(`ed-${key}-more`).flex_none().h(24).px(5).flex().items_center().border_l(1).border_color(t.border).text_size(TYPE.panel).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
      .tooltip(E.MENU_TIP).accessibility_label("Other editors").on_click((_e, cx) => { cx.stop_propagation(); openEditorMenu(view, target); }).child("▾"))];
}

// What every copy of the mod does with the editor commands (main.js panelCommand, review.js command): true when
// taken. editor:<path>[:<line>] is a click on a file's link in the copy's checkout (no path: the checkout itself);
// editor-use:<token>:<id>, editor-copy:<token> and editor-look are the menu's entries (the token: that menu's, see
// openEditorMenu). copy: the function that puts a text on the clipboard.
export function editorCommand(view, c, cx, copy = null) {
  const [name, ...rest] = c.split(":"), arg = rest.join(":");
  if (name === "editor") {
    const m = /^(.*?)(?::(\d+))?$/.exec(arg), root = view.checkoutRoot?.() ?? null;
    if (root) view.openEditor({ root, file: m[1] || null, line: m[2] ? Number(m[2]) : null, foreign: view.editorForeign?.() ?? false }, cx);
    else notify({ title: "Open in editor", body: "There is no local checkout of this PR to open.", level: "error" });
  } else if (name === "editor-use" || name === "editor-copy") {
    const [token, ...id] = rest, { token: mine, ...target } = view.editorTarget ?? {};
    if (!mine || mine !== token) return true; // another copy's menu, or a menu of this copy that was closed without a pick
    view.editorTarget = null;
    if (name === "editor-copy") { if (target.file && copy) copy(`${target.file}${target.line ? `:${target.line}` : ""}`); }
    else { chooseEditor(target.root, id.join(":")); view.openEditor(target, cx, id.join(":")); } // the pick is written once the root is read; the click opens with it at once
  }
  else if (name === "editor-look") cx.spawn(async (cx) => { await lookForEditors(true); cx.notify(); });
  else if (name !== "editor-none") return false;
  return true;
}
