// Pure helpers for the PR review panel (tested by test_pr.mjs).

// Numbers each diff line once (as the shipped changes panel does): number is the line on its side (new, removed:
// old); o and n are the old and new line numbers where the line has one.
export function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0], text = line.slice(1) || " ";
    if (kind === "-") return { kind, number: old, o: old++, text };
    if (kind === "+") return { kind, number: next, n: next++, text };
    if (kind === " ") return { kind, number: next, o: old++, n: next++, text };
    return { kind: "", text: line };
  });
}

// What goes to the agent: where, the code, the question.
const headOf = (pr, base) => pr ? `PR #${pr.number} "${pr.title}"${pr.url ? ` (${pr.url})` : ""}` : `Branch diff against ${base}`;
// The answer language line for prompts to an agent: none for English (the default).
export const answerIn = (lang) => (lang && !/^english$/i.test(lang) ? `\n\nAnswer in ${lang}.` : "");

export function buildPrompt({ pr, base, file, anchor, question, lang }) {
  const label = anchor?.start !== undefined ? " " + lineLabel(anchor) : "";
  return [`${headOf(pr, base)}: question${file ? ` about \`${file}\`${label}` : ""}.`, anchor?.hunk ? "```diff\n" + anchor.hunk + "\n```" : null, question.trim()].filter(Boolean).join("\n\n") + answerIn(lang);
}

// A whole `gh pr diff` split per file: path (the new one; the old one if deleted), +/− counts, its lines.
export function splitPatch(text) {
  const files = [];
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const header = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (header) { files.push({ path: header[1], add: 0, del: 0, binary: false, status: "modified", lines: [], body: false }); continue; }
    const f = files[files.length - 1];
    if (!f) continue;
    if (line.startsWith("@@")) f.body = true;
    if (!f.body) {
      const name = /^(?:\+\+\+ b|--- a)\/(.*)$/.exec(line);
      if (name) f.path = name[1]; // "+++ b/" comes after "--- a/"; a deleted file only has the old name
      if (line.startsWith("Binary files")) f.binary = true;
      if (line.startsWith("new file mode")) f.status = "added";
      else if (line.startsWith("deleted file mode")) f.status = "deleted";
      else if (line.startsWith("rename from ")) { f.status = "renamed"; f.from = line.slice(12); }
    } else if (line[0] === "+") f.add++;
    else if (line[0] === "-") f.del++;
    f.lines.push(line);
  }
  return files.map(({ body, ...f }) => f);
}

// Rows a..b (either order) as a review anchor: line range (old numbers only when every line is removed)
// and the diff with up to ctx lines of context inside the hunk, at most max lines.
export function selection(rows, a, b = a, ctx = 3, max = 60) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const lines = rows.slice(lo, hi + 1).filter((r) => r.number !== undefined);
  const old = lines.length > 0 && lines.every((r) => r.kind === "-");
  const nums = lines.filter((r) => old || r.kind !== "-").map((r) => r.number);
  let start = lo, end = hi;
  const edge = (r) => r.kind === "@" || r.kind === "gap"; // context stops at a hunk header or hidden lines
  while (start > 0 && !edge(rows[start]) && lo - start < ctx) start--;
  while (end + 1 < rows.length && !edge(rows[end + 1]) && end - hi < ctx) end++;
  end = Math.min(end, start + max - 1);
  const prefix = { "+": "+", "-": "-", " ": " ", "@": "" }, at = { start: nums[0], end: nums[nums.length - 1], old };
  // code: the selected lines' text, so a later push that changes them marks the comment STALE (isStale).
  return { ...at, hunk: rows.slice(start, end + 1).filter((r) => r.kind !== "gap").map((r) => (prefix[r.kind] ?? "") + r.text).join("\n"), code: codeOf(rows.slice(lo, hi + 1), at) };
}

// The text of lines start..end on a comment's side; undefined unless every one of them is in the rows (a gap, or a
// line gone from the diff: unknown, never a false STALE).
export function codeOf(rows, { start, end, old }) {
  if (start === undefined || end === undefined) return undefined;
  const lines = rows.filter((r) => r.number >= start && r.number <= end && (old ? r.kind === "-" : r.kind === "+" || r.kind === " "));
  return lines.length === end - start + 1 ? lines.map((r) => r.text).join("\n") : undefined;
}
// A local comment or note whose lines changed since it was written: it recorded their text (code), the head moved
// (or one of the heads is unknown), and the same lines read otherwise now. Nothing recorded, or unknown now: not stale.
export const isStale = (a, head, now) => a?.code != null && !(a.head && head && a.head === head) && now !== undefined && now.trim() !== String(a.code).trim();

// The first row of the next (dir 1) or previous (-1) block of changed lines from row i; -1 when none.
export function nextChange(rows, i, dir) {
  const starts = rows.map((r, j) => (r.kind === "+" || r.kind === "-") && !(rows[j - 1]?.kind === "+" || rows[j - 1]?.kind === "-") ? j : -1).filter((j) => j >= 0);
  return (dir > 0 ? starts.find((j) => j > (i ?? -1)) : starts.reverse().find((j) => j < (i ?? rows.length))) ?? -1;
}

export const lineLabel = ({ start, end, old }) => start === undefined ? "" :
  (start === end ? `line ${start}` : `lines ${start}–${end}`) + (old ? " (old, removed)" : "");

// The row a comment hangs under: its last line, on its side. -1 when that line is no longer in the diff.
export const anchorRow = (rows, c) => rows.findIndex((r) => r.number === c.end && (c.old ? r.kind === "-" : r.kind === "+" || r.kind === " "));

// All pending comments as one prompt. event (comment | approve | request_changes) and summary: the Finish-your-review choice.
const VERDICT = { comment: "", approve: " (approved)", request_changes: " (changes requested)" };
// replies: the file the agent answers each point in, by its id (threads.js repliesContract); null: no contract.
export function buildReview({ pr, base, comments, lang, event = "comment", summary = "", replies = null, contract = null }) {
  const points = comments.map((c, i) => [`${i + 1}. ${c.id ? `[${c.id}] ` : ""}\`${c.file}\`${c.start === undefined ? "" : " " + lineLabel(c)}`,
    c.hunk ? "```diff\n" + c.hunk + "\n```" : null, c.text.trim()].filter(Boolean).join("\n"));
  return [`${headOf(pr, base)}: code review${VERDICT[event] ?? ""} with ${comments.length} ${comments.length === 1 ? "point" : "points"}. ` +
    "Work through the points one by one: answer questions, make the requested changes. At the end, say briefly per point what you did.",
    summary.trim() ? `Overall: ${summary.trim()}` : null, ...points, replies && contract ? contract(replies, comments[0]?.id) : null].filter(Boolean).join("\n\n") + answerIn(lang);
}

// ---- GitHub reviews (review.js "Finish your review", route GitHub)

export const GH_EVENT = { comment: "COMMENT", approve: "APPROVE", request_changes: "REQUEST_CHANGES" };

// The lines GitHub accepts review comments on: per path a Set of "R<new line>" and "L<old line>" (every hunk row).
export function diffLines(hunks) {
  const m = new Map();
  for (const h of hunks) {
    const s = m.get(h.path) ?? new Set();
    for (const r of h.rows) { if (r.n !== undefined) s.add(`R${r.n}`); if (r.o !== undefined) s.add(`L${r.o}`); }
    m.set(h.path, s);
  }
  return m;
}

// Whether a pending comment can be a line comment on GitHub: both ends of its range are in the PR diff.
export const inDiff = (lines, c) => c.start !== undefined && [c.start, c.end].every((n) => lines.get(c.file)?.has(`${c.old ? "L" : "R"}${n}`));

// One GitHub review (POST repos/{o}/{r}/pulls/{n}/reviews) from the pending comments: line comments for those in the
// diff, the rest appended to the body with file and line. outside: the comments moved into the body.
export function ghReview({ comments, event = "comment", summary = "", commit, lines }) {
  const inline = comments.filter((c) => inDiff(lines, c)), outside = comments.filter((c) => !inDiff(lines, c));
  const body = [summary.trim(), ...outside.map((c) => `**\`${c.file}\`${c.start === undefined ? "" : " " + lineLabel(c)}**\n\n${c.text.trim()}`)].filter(Boolean).join("\n\n");
  const payload = { commit_id: commit, event: GH_EVENT[event] ?? "COMMENT", body, comments: inline.map((c) => {
    const side = c.old ? "LEFT" : "RIGHT";
    return { path: c.file, line: c.end, side, ...(c.start !== c.end ? { start_line: c.start, start_side: side } : {}), body: c.text.trim() };
  }) };
  return { payload, outside };
}

// The selected rows' code as a GitHub suggestion block (new-side text of added and context lines).
export const suggestionBlock = (rows) => "```suggestion\n" + rows.filter((r) => r.kind === "+" || r.kind === " ").map((r) => r.text).join("\n") + "\n```";

// The items under one diff row: GitHub's comments on that line, the pending comments ending there (the one being
// edited replaced by the composer), and the composer when it opens under this row (composeKey: its row's lineKey).
export function lineThreads(r, comments, { composeKey = null, editId = null, gh = [] } = {}) {
  const out = [];
  for (const g of gh) if (atLine(r, g.line, g.side === "LEFT")) out.push({ t: "gh", g });
  for (const c of comments) {
    if (!atLine(r, c.end, c.old)) continue;
    if (c.id === editId) out.push({ t: "compose", c }, { t: "composeact", c });
    else out.push({ t: "comment", c }, { t: "cact", c });
  }
  if (!editId && composeKey && lineKey(r) === composeKey) out.push({ t: "compose" }, { t: "composeact" });
  return out;
}

// FNV-1a, 32 bit, hex: a short stable id, not security.
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

// Every hunk of a splitPatch result with a stable id (path + its lines without the @@ numbers, so a moved
// hunk keeps it) and a short alias h1..hn for the model.
export function hunksOf(files) {
  const out = [], seen = {};
  for (const f of files) {
    let cur = null;
    for (const line of f.lines) {
      if (line.startsWith("@@")) { cur = { path: f.path, lines: [line] }; out.push(cur); }
      else if (cur) cur.lines.push(line);
    }
  }
  return out.map((h, i) => {
    let id = `${h.path}:${hash(h.lines.slice(1).join("\n"))}`;
    seen[id] = (seen[id] ?? 0) + 1;
    if (seen[id] > 1) id += `#${seen[id]}`;
    return { ...h, id, alias: `h${i + 1}` };
  });
}

// The hunks that fit into max characters (in order), and the aliases of the rest.
export function budget(hunks, max = 60000) {
  const sent = [], cut = [];
  let used = 0;
  for (const h of hunks) {
    const size = h.path.length + h.alias.length + 6 + h.lines.reduce((n, l) => n + l.length + 1, 0);
    if (used + size > max) cut.push(h.alias); else { sent.push(h); used += size; }
  }
  return { sent, cut };
}

// ---- the review layout (review.js)

// The budget classes of the AI review's models: a label (until the CLI's list names the model) and how many diff
// characters a run is sent. The models themselves come from the claude CLI (models.py); tierOf files each one here.
export const MODELS = { haiku: { label: "Haiku", chars: 60000 }, sonnet: { label: "Sonnet", chars: 150000 }, opus: { label: "Opus", chars: 150000 } };
// A model's class, as llm.tier: haiku, sonnet, or opus (the bigger ones, and any model not named).
export const tierOf = (m) => (/haiku/i.test(m ?? "") ? "haiku" : /sonnet/i.test(m ?? "") ? "sonnet" : "opus");
// The model for anything that reads or judges code: at least Sonnet. Haiku is fine for text (triage, reshaping a
// reviewer's prose) but too weak to reason about code, so a stored or passed haiku becomes sonnet (llm.code_model).
export const codeModel = (m) => (!m || tierOf(m) === "haiku" ? "sonnet" : m);
// Dollars per million input and output tokens, by the longest prefix of the resolved model id. Neither CLI reports
// prices, so these are Anthropic's list prices (November 2026); a model not listed costs its class's price.
// ponytail: a hand-kept table; update it when Anthropic's prices change.
const PRICES = { "claude-fable-5-2": [8, 40], "claude-fable-5": [10, 50], "claude-opus-5-5": [4, 20], "claude-opus-5": [5, 25], "claude-opus-4": [5, 25],
  "claude-sonnet-5": [2, 10], "claude-haiku-5": [0.1, 0.5] };
const CLASS_PRICE = { haiku: [1, 5], sonnet: [3, 15], opus: [5, 25] };
export const priceOf = (resolved) => {
  const id = String(resolved ?? ""), k = Object.keys(PRICES).filter((p) => id.startsWith(p)).sort((a, b) => b.length - a.length)[0];
  return k ? PRICES[k] : CLASS_PRICE[tierOf(id)];
};

// Lockfiles, snapshots, minified and generated code: sent last, so they are what a size cap cuts first.
export const lowValue = (path) => /(^|\/)([^/]*\.lock|package-lock\.json|pnpm-lock\.yaml|go\.sum)$|\.snap$|\.min\.(js|css)$|(^|\/)(dist|vendor|generated|__generated__)\//.test(path);

// What review.py gets: the hunks that fit the model (low-value ones cut first, the rest in diff order), the aliases
// cut, the cache file for exactly this hunk set and model, the source's latest for that model, and a status file.
// source: what it is kept under (the PR url, or repo#base); pr: the PR url or null; worktree: the checkout to read.
// hunks: hunksOf(files) when the caller has it already (a big diff takes too long to hash twice in one slice).
export function reviewRequest({ url, pr = url, worktree = null, files, hunks: made = null, model, context, dir }) {
  const hunks = made ?? hunksOf(files);
  const { sent, cut } = budget([...hunks.filter((h) => !lowValue(h.path)), ...hunks.filter((h) => lowValue(h.path))], MODELS[tierOf(model)].chars);
  const at = new Map(hunks.map((h, i) => [h.alias, i]));
  sent.sort((a, b) => at.get(a.alias) - at.get(b.alias));
  cut.sort((a, b) => at.get(a) - at.get(b));
  const m = String(model).replace(/[^\w.-]/g, "_"); // a model id in a file name
  const base = `${dir}/rv-${hash(url)}`, out = `${base}-${hash(hunks.map((h) => h.id).sort().join(","))}-${m}.json`, latest = `${base}-${m}.json`;
  return { hunks, out, latest, status: `${out}.status`,
    req: { out, latest, status: `${out}.status`, model, context, pr, source: url, worktree, hunks: sent.map(({ alias, id, path, lines }) => ({ alias, id, path, lines })), cut } };
}

// Risk order: high, medium, low, then what is only skimmed. Older analyses (categories, suspects) map in.
export const RISKS = ["high", "medium", "low", "skim"];
export const RISK_LEVELS = ["minimal", "low", "medium", "high", "critical"]; // merge risk
const RULE_ORDER = ["fail", "pass", "n/a"];
const OLD_SKIM = new Set(["docs", "tests", "rename", "format", "generated"]);
const level = (x) => (RISKS.includes(x) ? x : "medium");

// Statements with their source (implemented | existing | spec, see arch.js sourceStyle) and evidence (file:line).
export const SOURCES = ["implemented", "existing", "spec"];
export const statementsOf = (list) => (Array.isArray(list) ? list : []).filter((x) => x?.text).map((x) => ({ text: String(x.text), source: SOURCES.includes(x.source) ? x.source : null, evidence: x.evidence || null }));

// The pictures' freshness: updated (refreshed after the text analysis, short: for which head) and older (made for
// another diff head than the shown one; without a refresh record: the analysis is not for today's hunks).
export function diagramsState(saved, head, exact = true) {
  const d = saved?.diagrams ?? null;
  return { updated: Boolean(d?.generated && saved?.generated && d.generated > saved.generated), short: d?.head ? String(d.head).slice(0, 7) : null,
    older: d?.head ? Boolean(head) && d.head !== head : !exact };
}

// A layer's (or the whole PR's) pictures: `visuals`, or the older single `visual`; only ones with nodes.
export const visualsOf = (x) => (Array.isArray(x?.visuals) ? x.visuals : x?.visual ? [x.visual] : []).filter((v) => v?.nodes?.length);

// Row r shows line n of the new side (old: of the removed side).
export const atLine = (r, n, old) => r.number === n && (old ? r.kind === "-" : r.kind === "+" || r.kind === " ");

// The model's analysis with aliases turned into hunk ids (unknown ones dropped): steps in risk order (then reading
// order), each with its explanation, questions (at most 3), flows (at most 3; traces at most 12 lines), its own
// findings (layerFindings); every
// suggested line put on a row of its hunk (the hunk's first change when the model named a line it doesn't have: approx).
export function mapReview(answer, hunks) {
  const byAlias = new Map(hunks.map((h) => [h.alias, h]));
  const ids = (list) => [...new Set((list ?? []).map((a) => byAlias.get(String(a).trim())?.id).filter(Boolean))];
  const steps = (answer.steps ?? []).map((s, n) => {
    const risk = OLD_SKIM.has(s.category) ? "skim" : level(s.risk);
    // Each check question with the file it is about (question_files, "" for several files or an older analysis).
    const asked = (s.check_questions ?? s.questions ?? []).map((q, k) => [q, String(s.question_files?.[k] ?? "")]).filter(([q]) => q).slice(0, 3);
    return { title: s.title ?? "", why: s.why_it_matters ?? s.why ?? "", text: s.explanation ?? s.text ?? "", risk, skim: risk === "skim", isNew: Boolean(s.new), visuals: visualsOf(s),
      weight: risk === "high" ? "key" : risk === "skim" ? "skim" : "normal", order: Number(s.reading_order) || n + 1,
      questions: asked.map(([q]) => q), questionFiles: asked.map(([, f]) => f), hunks: ids(s.hunks), n, dependsOn: (s.depends_on ?? []).map(String), // titles of the layers it builds on
      flows: (s.flows ?? []).slice(0, 3).map((f) => ({ function: f.function ?? "", at: f.at ?? "", inputs: f.inputs ?? [], output: f.output ?? null,
        side_effects: f.side_effects ?? [], calls: f.calls ?? [], trace: (f.trace ?? []).slice(0, 12) })) };
  }).map((st) => ({ ...st, findings: layerFindings(answer.steps[st.n].findings, stepKey(st)) })).sort((a, b) => RISKS.indexOf(a.risk) - RISKS.indexOf(b.risk) || a.order - b.order || a.n - b.n);
  const suspects = [];
  const lines = [...(answer.suspects ?? []).map((s) => ({ ...s, text: s.reason })), ...(answer.steps ?? []).flatMap((s) => s.suggestions ?? [])];
  for (const s of lines) {
    const h = byAlias.get(String(s.hunk).trim());
    if (!h) continue;
    const rows = diffRows(h.lines ?? []), exact = rows.find((r) => atLine(r, s.line, s.side === "old"));
    const row = exact ?? rows.find((r) => r.kind === "+" || r.kind === "-");
    if (!row) continue;
    const old = row.kind === "-", reason = s.text ?? "";
    suspects.push({ key: `${h.path}:${old ? "-" : "+"}${row.number}:${hash(reason)}`, hunk: h.id, path: h.path, line: row.number, old,
      severity: level(s.severity) === "skim" ? "low" : level(s.severity), reason, approx: !exact, ...(s.category ? { category: String(s.category) } : {}) });
  }
  // Newer analyses add behavior, merge risk, effort, repo rule checks, an architecture picture and the blast radius;
  // older ones have none of them (null / empty). Newer still: per ask an id, a state (an older one's comes from its
  // coverage), why, whether it is an acceptance criterion (null: not said) and the findings that break it; the asks
  // without a finding (unlinked), the components with their counts, and who can reach what (access).
  return { title: answer.title ?? "", summary: answer.summary ?? "", steps, suspects, behavior: answer.behavior ?? "",
    intent: statementsOf(answer.intent), behaviorPoints: statementsOf(answer.behavior_points),
    mergeRisk: RISK_LEVELS.includes(answer.merge_risk?.level) ? answer.merge_risk : null,
    effort: answer.effort?.score >= 1 ? { score: Math.min(5, Math.round(answer.effort.score)), why: answer.effort.why ?? "" } : null,
    rules: (answer.rule_checks ?? []).map((r) => ({ rule: r.rule ?? "", source: r.source ?? "", status: ["pass", "fail", "n/a"].includes(r.status) ? r.status : "n/a", where: r.where ?? null, why: r.why ?? "" }))
      .sort((a, b) => RULE_ORDER.indexOf(a.status) - RULE_ORDER.indexOf(b.status)),
    arch: answer.architecture?.nodes?.length ? answer.architecture : null, visuals: visualsOf(answer), blast: answer.blast_radius?.units?.length ? answer.blast_radius : null,
    asks: (answer.asks ?? []).map((a, k) => {
      const coverage = ["seen", "partly", "absent", "extra"].includes(a.coverage) ? a.coverage : "absent";
      return { id: String(a.id ?? `c${k + 1}`), text: a.text ?? "", coverage, state: ASK_STATES.includes(a.state) ? a.state : STATE_OF[coverage], why: a.why ?? "",
        acceptance: typeof a.acceptance === "boolean" ? a.acceptance : null, findings: (a.findings ?? []).map(String), hunks: ids(a.hunks), elements: (a.elements ?? []).map(String),
        short: String(a.short ?? "") }; // short: the criterion's name in at most eight words ("": an older analysis)
    }),
    // whatChanged: {adds, changes, runtime}, each up to three short sentences; null for an older analysis.
    whatChanged: answer.what_changed ? Object.fromEntries(["adds", "changes", "runtime"].map((k) => [k, (answer.what_changed[k] ?? []).map(String).slice(0, 3)])) : null,
    unlinked: (answer.unlinked ?? []).map(String), components: answer.components ?? [], componentCounts: answer.component_counts ?? null, access: answer.access ?? [] };
}

// An ask's state; an analysis from before it had one says only how far the diff covers the ask.
export const ASK_STATES = ["met", "partly", "broken", "not_done", "extra"];
const STATE_OF = { seen: "met", partly: "partly", absent: "not_done", extra: "extra" };

const CATEGORIES = ["structure", "security", "data", "scope", "requirement", "bug", "test", "availability"];
// A layer's architecture-review findings in the reviewer findings' shape (reviewers.py normalize). They stay in their
// layer: the id comes from the layer's key, file and title, so a status survives when a new analysis finds the same.
function layerFindings(list, step) {
  return (list ?? []).map((f) => ({ f, file: String(f.file ?? "").trim().replace(/^\.\//, ""), line: Number(f.line) || 0, title: String(f.title ?? "").trim() }))
    .filter((x) => x.file && x.title)
    // The id is what the finding is about (category, file, title), not its layer's hunks: those change with every push,
    // and a finding the next analysis reports again keeps its status (Fix sent, Dismissed). A newer analysis names the
    // id itself (the same way), so its asks can point at it. `step` links it to its layer.
    .map(({ f, file, line, title }) => ({ f, file, line, title, category: CATEGORIES.includes(f.category) ? f.category : "structure" }))
    .map(({ f, file, line, title, category }) => ({ id: f.id ? String(f.id) : `a${hash(`${category}|${file}|${title}`)}`, reviewer: "analysis", step, file, line, end: Number(f.end) || line,
      severity: ["high", "medium", "low"].includes(f.severity) ? f.severity : "medium", category,
      title, detail: String(f.detail ?? ""), suggestion: String(f.suggestion ?? ""), ...findingFacts(f) }))
    .filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i); // the same title twice in a file: one finding
}

// What a newer analysis or reviewer says about a finding beyond its text, in one shape whoever found it (an older one
// has none of it): impact (what the severity follows from), effect (one sentence), preconditions ([]: it always
// happens), certainty (confirmed | derived | assumed), criteria (ids of the asks it breaks), breaks ({node} or
// {from, to, edge} in the architecture picture, else null), effort (how much work the fix is: quick | moderate |
// heavy, null when the analysis does not say), and for a security finding reachable_from (ids of the access rows
// it can be reached through) and reachability (public | authenticated | internal_only | unknown).
export const EFFORTS = ["quick", "moderate", "heavy"];
export const findingFacts = (f) => ({ impact: f.impact ?? null, effect: String(f.effect ?? ""), preconditions: (f.preconditions ?? []).map(String),
  certainty: ["confirmed", "derived", "assumed"].includes(f.certainty) ? f.certainty : null, criteria: (f.criteria ?? []).map(String), breaks: f.breaks ?? null,
  effort: EFFORTS.includes(f.effort) ? f.effort : null,
  reachable_from: (f.reachable_from ?? []).map(String), reachability: ["public", "authenticated", "internal_only", "unknown"].includes(f.reachability) ? f.reachability : null,
  // introduced_here: the flaw is in what this PR adds or changes (false: it was there before; null: not said, an older
  // analysis). path_certainty / path_why: for a security finding, how sure the way from outside to it is, apart from
  // certainty (the flaw in the code).
  introduced_here: typeof f.introduced_here === "boolean" ? f.introduced_here : null,
  path_certainty: ["confirmed", "derived", "assumed"].includes(f.path_certainty) ? f.path_certainty : null, path_why: String(f.path_why ?? ""),
  // reach_conflict: the security run found the finding's reachable_from at another place than the threat that names it
  // ({finding: {reachable_from, reachability}, threat: {id, where, reachability}}; the more exposed side is already taken).
  reach_conflict: f.reach_conflict?.finding && f.reach_conflict?.threat ? f.reach_conflict : null });

// A suspicious line taken over as a pending review comment (rows: its hunk's or file's rows); null when not shown there.
export function suspectComment(s, rows, id) {
  const i = rows.findIndex((r) => atLine(r, s.line, s.old));
  return i < 0 ? null : { id, file: s.path, ...selection(rows, i), text: s.reason, from: "ki" };
}

// A step's identity across re-analyses: its hunks (or its title when it has none).
export const stepKey = (s) => hash(s.hunks.join(",") || s.title);

// The new-side lines a hunk covers, [first, last] (last < first when it only removes lines, after line first-1),
// and new minus old line number before it (shift) and after it (after).
function span(header) {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/.exec(header), num = (x, len) => (len === 0 ? x + 1 : x);
  const ol = m[2] === undefined ? 1 : +m[2], nl = m[4] === undefined ? 1 : +m[4], of = num(+m[1], ol), first = num(+m[3], nl);
  return [first, first + nl - 1, first - of, first + nl - (of + ol)];
}

// One file for the Files view: its hunks (each a diffRows result, @@ row first) with the unchanged lines between them,
// as far as they are opened. full: the new file's lines (null: not loaded); open: {gap: {down, up}}, lines shown below
// the previous hunk and above the next; whole: every line; tail: unchanged lines may follow the last hunk.
// Rows carry h, their hunk's index; a gap still hiding lines is {kind: "gap", gap, hidden} (hidden null: not known yet).
export function fileRows(hunks, full, open = {}, whole = false, tail = true) {
  const out = [];
  let next = 1, shift = 0;
  const ctx = (n) => ({ kind: " ", number: n, n, o: n - shift, text: full[n - 1] || " " });
  const gap = (k, to) => {
    const size = to === null ? null : to - next + 1;
    if (size !== null && size <= 0) return;
    if (!full) { out.push({ kind: "gap", gap: k, hidden: size }); return; }
    const { down = 0, up = 0 } = whole ? { down: size } : open[k] ?? {};
    const top = Math.min(down, size), bottom = Math.min(up, size - top);
    for (let n = next; n < next + top; n++) out.push(ctx(n));
    if (size - top - bottom > 0) out.push({ kind: "gap", gap: k, hidden: size - top - bottom });
    for (let n = to - bottom + 1; n <= to; n++) out.push(ctx(n));
  };
  hunks.forEach((rows, k) => {
    const [first, last, before, after] = span(rows[0].text);
    shift = before;
    gap(k, first - 1);
    for (const r of rows) out.push({ ...r, h: k });
    next = Math.max(next, last + 1); shift = after;
  });
  if (tail) gap(hunks.length, full ? full.length : null);
  return out;
}

// Paths (diff order: git sorts them, so a folder's files are together) as a tree: {dir, name, path, depth};
// a closed folder hides what is in it.
export function fileTree(paths, closed = new Set()) {
  const out = [], seen = new Set();
  for (const p of paths) {
    const parts = p.split("/");
    let hidden = false;
    for (let i = 1; i < parts.length && !hidden; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!seen.has(dir)) { seen.add(dir); out.push({ dir: true, name: parts[i - 1], path: dir, depth: i - 1 }); }
      hidden = closed.has(dir);
    }
    if (!hidden) out.push({ dir: false, name: parts[parts.length - 1], path: p, depth: parts.length - 1 });
  }
  return out;
}

// The same range for the UI (English); lineLabel stays for the prompts.
export const uiLine = ({ start, end, old }) => start === undefined ? "" :
  (start === end ? `line ${start}` : `lines ${start}–${end}`) + (old ? " (old, removed)" : "");

// A row's place for a selection that survives re-renders and refreshes: its side and line number ("+12" new side,
// added or context; "-7" removed). null for rows without a line (hunk headers, gaps).
export const lineKey = (r) => (r.number === undefined ? null : `${r.kind === "-" ? "-" : "+"}${r.number}`);

// The rows from line key a to line key b (either order) in one file's rows: [lo, hi], or null when either is not there.
export function rangeOf(rows, a, b) {
  const i = rows.findIndex((r) => lineKey(r) === a), j = rows.findIndex((r) => lineKey(r) === b);
  return i < 0 || j < 0 ? null : [Math.min(i, j), Math.max(i, j)];
}

// ---- reviewer findings (reviewers.py; review.js)

// Status reports the fixing agent appends, one JSON line each ({id, status: "fixed"|"wontfix", commit, note}): the
// last per id wins, broken lines (a half-written one) are skipped.
export function parseReports(text) {
  const out = {};
  for (const line of String(text ?? "").split("\n")) {
    try { const r = JSON.parse(line); if (r && r.id) out[r.id] = r; } catch { /* half a line */ }
  }
  return out;
}

// A finding's status: open ("Unresolved"), progress ("Fix sent"), fixed, dismissed, or recheck (unresolved, from an
// older head, and its line changed since). The fix agent's report never settles a finding: "fixed" comes only from a
// passed verification (applyVerification) or the reviewer's own mark, so a finding sent to Fix stays unresolved, in
// the diff and among the blockers, with the report next to it. progress needs a fix on its way (fixHead) that the
// agent did not decline; an older "progress" from a chat draft reads open. A dismissal covers the sources the finding
// had then (st.ids): when another source reports the same line later, it is unresolved again.
export function findingStatus(f, status, reports, head, lineNow) {
  const st = status[f.id], own = st?.s ?? "open";
  const s = (own === "progress" && (!st.fixHead || reports[f.id]?.status === "wontfix")) || (own === "dismissed" && st.ids && (f.ids ?? []).some((id) => !st.ids.includes(id))) ? "open" : own;
  if (s === "open" && head && f.head && f.head !== head && lineNow !== undefined && lineNow.trim() !== (f.code ?? "").trim()) return "recheck";
  return s;
}

// ---- one finding per defect (review.js: every view reads this list)

const rank = (x) => RISKS.indexOf(x.severity);
const RAISE = new Set(["security", "availability"]);
// A suggestion's text as a finding's title (its first sentence) and detail (the rest).
// The texts are Markdown: the cut is never inside inline code, and the title is plain (plainText).
const titled = (text) => {
  const s = String(text).trim();
  for (const m of s.matchAll(/[.;]\s+/g)) {
    if (m.index > 160) break;
    if (m.index >= 12 && s.slice(0, m.index).split("`").length % 2 === 1) return [plainText(s.slice(0, m.index)), s.slice(m.index + m[0].length)];
  }
  return [plainText(s.replace(/\.$/, "")), ""];
};

// Two titles say the same thing when their word sets (lower case, without filler words, a plural "s" dropped) share at
// least 35 % of their words (Jaccard). On PR #2 the pairs that are one defect score 0.40 to 1, the different statements
// next to each other 0 to 0.27. ponytail: a word measure, no synonyms; a model call per pair if it lets duplicates through.
const FILLER = new Set("a an the and or of to in on is are be by for from with no not does do it its this that as at only".split(" "));
const words = (t) => new Set((String(t).toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((w) => !FILLER.has(w)).map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)));
export function sameClaim(a, b) {
  const x = words(a), y = words(b), both = [...x].filter((w) => y.has(w)).length;
  return both > 0 && both / (x.size + y.size - both) >= 0.35;
}
// ⛨ only for real security: a source whose effect is access without permission or exposed data (or lost data, when
// its category says security), or one a named threat of the threat model stands on (`threats`: the ids of the threats
// with result "finding" that cite it; a flood at a public way in is about availability and still an attack). Any other
// finding of a security reviewer about availability or correctness is a finding with its source, without ⛨. A source without an impact (an older cache, an AI suggestion) keeps the rule from before: the
// security reviewer found it or its category says security.
const SEC_IMPACT = new Set(["unauthorized_access", "data_exposure"]);
export const isSecurity = (x) => (x.threats?.length > 0) || (x.impact ? SEC_IMPACT.has(x.impact) || (x.impact === "data_loss" && x.category === "security") : x.reviewer === "security" || x.category === "security");
const NEAR = 3; // lines between two findings of one defect at most (PR #2: 19/20, 21/23, 33/35; template.yaml 14-17/18)
const SPAN = 30; // a finding's own range counts up to this many lines past its first (a model's end can be anything)
// Lines between two findings' ranges (line..end), 0 when they overlap.
const gap = (a, b) => { const end = (x) => Math.min(Math.max(x.end || x.line, x.line), x.line + SPAN); return Math.max(0, a.line - end(b), b.line - end(a)); };
// The named resources a finding's title is about: an UPPER_CASE name with an underscore (an environment variable,
// FRONT_DESK_TOKEN) or a `backticked` name. Two findings about the same resource in one file are one defect also further
// apart (RES_NEAR: PR #2 has the token once at the env block, template.yaml:14, and once at the function, 18-20) when
// they make the same claim or name the same impact; two titles that name only different resources are never one.
const RES_NEAR = 20;
export const resourcesOf = (title) => new Set([...String(title).matchAll(/`([^`\s]{2,})`|\b([A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9])\b/g)].map((m) => m[1] ?? m[2]));
export function sameDefect(x, y) {
  const rx = resourcesOf(x.title), ry = resourcesOf(y.title), shared = [...rx].some((r) => ry.has(r));
  if (rx.size && ry.size && !shared) return false;
  const claim = sameClaim(x.title, y.title), impact = Boolean(x.impact) && x.impact === y.impact;
  // One cause, worded differently: first lines at most NEAR apart with the same effect or a criterion in common (PR #2:
  // events.py 19/20/20, all dead_path). The first lines, not the ranges: a range over a whole function (13-31) would
  // take in every finding inside it.
  const crit = (x.criteria ?? []).some((c) => (y.criteria ?? []).includes(c));
  // One effect, said by each source in its own sentence (`effect`), at ranges at most NEAR apart (acceptance, PR #2,
  // reminders.py:21-23: the double mail in three wordings, "Members get two identical reminder mails per loan." and
  // "Members get two reminder mails per loan, not one."; the security review's title scores 0.18 and 0.27 against the other two, the effects
  // 0.55 to 0.78; the effect of the finding about atomicity on line 22 scores 0.07 to 0.15 against them). Only in one file and only this near: across files the same effect
  // has different causes (no reminder goes out because nothing publishes, and because nothing calls the job).
  const effect = Boolean(x.effect && y.effect) && sameClaim(x.effect, y.effect);
  return (gap(x, y) <= NEAR && (claim || effect)) || (Math.abs(x.line - y.line) <= NEAR && (impact || crit)) || (shared && gap(x, y) <= RES_NEAR && (claim || impact));
}
// Two findings in different files are one cause (same_cause) when they have the same effect and make the same claim,
// or when one's text names the other's file and both name the same resource (PR #2: the empty token, handler.py:9
// defaults it, template.yaml:14 never sets FRONT_DESK_TOKEN; each names the other's file).
const textOf = (f) => [f.title, f.detail, f.code, ...(f.sources ?? []).flatMap((s) => [s.title, s.detail])].filter(Boolean).join("\n");
const names = (f, file) => textOf(f).includes(String(file).split("/").pop());
export function sameCause(x, y) {
  if (x.file === y.file || !x.impact || x.impact !== y.impact) return false;
  const titles = (f) => (f.sources?.length ? f.sources.map((s) => s.title) : [f.title]);
  if (titles(x).some((a) => titles(y).some((b) => sameClaim(a, b)))) return true;
  const rx = resourcesOf(textOf(x)), ry = resourcesOf(textOf(y));
  return (names(x, y.file) || names(y, x.file)) && [...rx].some((r) => ry.has(r) && /^[A-Z][A-Z0-9]*_/.test(r));
}

// Findings (the reviewers' and the analysis') in one file that are one defect (sameDefect: line ranges at most NEAR
// lines apart, overlapping too, and the same claim (sameClaim); or the same named resource within RES_NEAR) are one
// finding: the highest severity leads (its title and text show),
// every source stays in `sources` with its own severity, and `security` (⛨) is true when a source is about security
// (isSecurity: its effect is access, data or rights, not who found it). Being on the same line or in the same function is not enough: on PR #2 consumer.py 20
// and 23, in one function, say different things. An AI suggestion joins a finding on its own line (it is worded as a
// fix, so no word measure tells its claim: on PR #2 the same and the different ones both score 0 to 0.38). A
// suggestion without one is a note (not a finding, not counted), unless it is high, about security or availability,
// or in a file the public can reach (publicFiles: then the category word the model chose does not decide): then it is
// a finding of its own. line..end spans all sources, the anchor in the diff is the first line; criteria are
// those of all sources. The id is the source's that already has a status (so "Fix sent" and its report survive a run
// that adds a source to the line), else the leading one's; `ids` has them all.
// → {findings: [{...the leading source, id, ids, severity, security, step, sources: [{id, reviewer, severity, title,
// detail, suggestion}]}], notes: [suspect]}, findings by severity, then file and line. The facts of a finding
// (findingFacts) are the leading source's; one it does not have comes from the first source that does.
export function mergeFindings(findings, suspects = [], status = {}, publicFiles = new Set()) {
  const notes = [], at = (x) => `${x.file}:${x.line}`;
  const own = (s) => { const [title, detail] = titled(s.reason); return { id: `s${hash(s.key)}`, reviewer: "ai", file: s.path, line: s.line, end: s.line, severity: s.severity, category: s.category ?? "bug", title, detail, suggestion: "" }; };
  // In line order, so 19, 20 and 22 can become one; a finding without a line stays alone.
  const kept = [], byLine = new Map();
  for (const x of [...findings].sort((a, b) => (a.line || 0) - (b.line || 0))) {
    const near = x.line > 0 && kept.find((j) => j[0].file === x.file && j[0].line > 0 && j.some((y) => sameDefect(x, y)));
    if (near) near.push(x); else kept.push([x]);
    if (x.line > 0 && !byLine.has(at(x))) byLine.set(at(x), near || kept.at(-1));
  }
  // ponytail: a suggestion on a removed line stays a note (findings sit on new-side lines).
  const sugs = suspects.filter((s) => !s.old).map((s) => [s, own(s)]);
  const raised = new Set(sugs.filter(([s, x]) => !byLine.has(at(x)) && (s.severity === "high" || RAISE.has(s.category) || publicFiles.has(s.path))).map(([s]) => s));
  for (const [s, x] of sugs) if (raised.has(s) && !byLine.has(at(x))) { kept.push([x]); byLine.set(at(x), kept.at(-1)); }
  for (const [s, x] of sugs) { const g = byLine.get(at(x)); if (g && !g.includes(x)) g.push(x); else if (!g) notes.push(s); }
  for (const s of suspects) if (s.old) notes.push(s);
  notes.sort((a, b) => suspects.indexOf(a) - suspects.indexOf(b));
  const out = kept.map((g) => {
    const whole = (n) => (Number.isInteger(n) && n > 0 ? n : 0), lines = g.map((x) => whole(x.line)).filter(Boolean), line = lines.length ? Math.min(...lines) : 0;
    const lead = [...g].sort((a, b) => rank(a) - rank(b))[0], coded = g.find((x) => x.head && whole(x.line) === line), all = [lead, ...g].map(findingFacts);
    const has = (v) => (Array.isArray(v) ? v.length > 0 : v !== null && v !== ""), fact = (k) => (all.find((x) => has(x[k])) ?? all[0])[k];
    const held = g.filter((x) => status[x.id]).sort((a, b) => String(status[b.id].at ?? "").localeCompare(String(status[a.id].at ?? "")))[0];
    // line and end come from a model's or a reviewer's answer: whole numbers with line <= end for every caller (0: no line).
    return { ...lead, line, id: (held ?? lead).id, ids: g.map((x) => x.id), end: Math.max(line, ...lines, ...g.map((x) => whole(x.end))), step: g.find((x) => x.step)?.step ?? null,
      suggestion: lead.suggestion || g.find((x) => x.suggestion)?.suggestion || "", ...(coded ? { head: coded.head, code: coded.code } : {}),
      ...Object.fromEntries(Object.keys(all[0]).map((k) => [k, fact(k)])), criteria: [...new Set(all.flatMap((x) => x.criteria))],
      security: g.some(isSecurity), threats: [...new Set(g.flatMap((x) => x.threats ?? []))],
      sources: g.map((x) => ({ id: x.id, reviewer: x.reviewer, severity: x.severity, title: x.title, detail: x.detail ?? "", suggestion: x.suggestion ?? "" })) };
  });
  out.sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file) || a.line - b.line);
  // Across files: the later one of one cause points at the first (same_cause: its id, same_cause_at: its place).
  for (const [k, f] of out.entries()) {
    const first = out.slice(0, k).find((g) => !g.same_cause && sameCause(g, f));
    if (first) Object.assign(f, { same_cause: first.id, same_cause_at: `${first.file}:${first.line}` });
  }
  return { findings: out, notes };
}

// The reviewer runs of the findings file, each with its state: running | done | failed (an entry from before it had
// one is running while busy, failed with an error, done with a finish time), what it looked at (scope: {read,
// checked: [{area, result, note}], skipped}, or null) and its error. No entry: it never ran.
export const runsOf = (runs) => Object.fromEntries(Object.entries(runs ?? {}).map(([k, r]) => [k, { ...r,
  state: ["running", "done", "failed"].includes(r.state) ? r.state : r.busy ? "running" : r.error ? "failed" : r.at ? "done" : null, scope: r.scope ?? null, error: r.error ?? null }]));

// The one way findings are counted (tab, bar, Overview, the Findings header): unresolved is open, recheck and fix
// sent; high/medium/low and security count the unresolved ones, so the severities add up to `unresolved`.
// causes: the unresolved ones counted once per cause (a finding with same_cause whose first is unresolved too is not
// counted again); security counts causes, so the empty token at two places is ⛨ 1.
export function findingCounts(findings, statusOf) {
  const c = { total: findings.length, unresolved: 0, causes: 0, sent: 0, fixed: 0, dismissed: 0, high: 0, medium: 0, low: 0, security: 0 };
  const open = findings.filter((f) => !["fixed", "dismissed"].includes(statusOf(f)));
  for (const f of findings) {
    const s = statusOf(f);
    if (s === "fixed" || s === "dismissed") { c[s] += 1; continue; }
    c.unresolved += 1; c[f.severity] = (c[f.severity] ?? 0) + 1;
    if (s === "progress") c.sent += 1;
    if (followsOpen(f, open)) continue;
    c.causes += 1;
    if (f.security) c.security += 1;
  }
  return c;
}
// "12 unresolved: 7 high, 5 medium · 1 with a fix sent · 2 fixed · 1 dismissed"
export const countLine = (c) => (!c.total ? "No findings" : [`${c.unresolved} unresolved${c.unresolved ? `: ${["high", "medium", "low"].filter((k) => c[k]).map((k) => `${c[k]} ${k}`).join(", ")}` : ""}`,
  c.sent && `${c.sent} with a fix sent`, c.fixed && `${c.fixed} fixed`, c.dismissed && `${c.dismissed} dismissed`].filter(Boolean).join(" · "));

// One prompt asking the PR's agent to fix findings and to report each back as a JSON line in `report`.
export function fixPrompt(findings, pr, report, lang) {
  const items = findings.map((f, i) => [`${i + 1}. [${f.id}] ${f.severity} · ${f.reviewer} · \`${f.file}\`:${f.line}${f.end && f.end !== f.line ? `–${f.end}` : ""}: ${f.title}`,
    f.detail, f.suggestion ? `Suggestion:${/\n/.test(f.suggestion) ? "\n" : " "}${f.suggestion}` : null].filter(Boolean).join("\n")); // a list or a code block starts on its own line
  return [`${pr ? `PR #${pr.number} "${pr.title}"${pr.url ? ` (${pr.url})` : ""}` : "This branch"}: please fix ${findings.length === 1 ? "this review finding" : `these ${findings.length} review findings`}.`,
    ...items,
    `Report each finding back once it is handled: append one JSON line per finding to ${report}, for example\n` +
    `echo '{"id": "${findings[0]?.id ?? "<id>"}", "status": "fixed", "commit": "<sha>", "note": "briefly, what you did"}' >> ${report}\n` +
    `(status "wontfix" with the reason in note when you don't fix it).`].join("\n\n") + answerIn(lang);
}

// ---- open reviews (pr-data/open-reviews.json; review.js writes it, shared "review.open" / "review.registry" publish it)

const DAY = 86400000, KEEP_CLOSED = 14 * DAY, MAX_REVIEWS = 50;

// The registry with this review created or updated: startedAt stays, lastTouched moves, fields merge.
export function touchReview(list, entry, now) {
  const old = list.find((r) => r.url === entry.url);
  // Opened again after it was done (✕ in the panel's In progress, or expired): in progress again, unless merged since
  // (expireReviews marks that done again).
  const status = entry.status ?? (old?.status && old.status !== "done" ? old.status : "in-progress");
  const next = { ...old, ...entry, status, progress: { ...old?.progress, ...entry.progress }, startedAt: old?.startedAt ?? now, lastTouched: now };
  return [next, ...list.filter((r) => r.url !== entry.url)];
}

// Merged/closed PRs (prs.json state, updated over a day ago) count as done; done and sent ones go after 14 days
// untouched; at most MAX_REVIEWS, most recently touched first.
export function expireReviews(list, prs, now) {
  const state = new Map((prs ?? []).map((p) => [p.url, p]));
  return list.map((r) => {
    const p = state.get(r.url);
    const closed = p && (p.state === "merged" || p.state === "closed") && now - Date.parse(p.updatedAt ?? 0) > DAY;
    return closed && r.status !== "done" ? { ...r, status: "done", doneAt: now } : r;
  }).filter((r) => r.status === "in-progress" || now - (r.doneAt ?? r.lastTouched) < KEEP_CLOSED)
    .sort((a, b) => b.lastTouched - a.lastTouched).slice(0, MAX_REVIEWS);
}

// "3/9 steps · 2 comments · 1 open finding" for lists of open reviews.
export function progressLine(p = {}) {
  return [p.steps ? `${p.stepsChecked ?? 0}/${p.steps} steps` : null, p.files ? `${p.filesViewed ?? 0}/${p.files} files` : null,
    p.comments ? `${p.comments} ${p.comments === 1 ? "comment" : "comments"}` : null,
    p.replies ? `${p.replies} ${p.replies === 1 ? "reply" : "replies"}` : null, p.fixedThreads ? `${p.fixedThreads} fixed` : null,
    p.findingsOpen ? `${p.findingsOpen} open ${p.findingsOpen === 1 ? "finding" : "findings"}` : null].filter(Boolean).join(" · ");
}

// Where a review was (review.js uiState, saved as JSON) as the fields to put back, and what to scroll to.
export function resumeFields(ui) {
  if (!ui) return null;
  return { fields: { tab: ui.tab ?? "files", fileFocus: ui.fileFocus ?? null, focusHunk: ui.focusHunk ?? null, cur: ui.cur ?? 0, order: ui.order ?? "risk", fsel: ui.fsel ?? null, page: ui.page === undefined ? "overview" : ui.page },
    scroll: ui.focusHunk ?? ui.fileFocus ?? null, model: ui.model ?? null, values: ui.values };
}

// ---- the review layout's virtual list: stable item keys, and clicks on code tokens

// A stable key per list item (row by file and line, cards by their id), so a click queued before the list changed
// (a definition card inserted, context opened) still names the item that was pressed. Repeats get #n.
export function itemKeys(items) {
  const seen = new Map();
  return items.map((it, i) => {
    let k;
    if (it.t === "row") { const r = it.src[it.ri]; k = `r|${it.path}|${lineKey(r) ?? `@${r.text}`}${it.part ? `~${it.part}` : ""}`; } // part: a wrapped line's next visual line
    else if (it.t === "gap") k = `g|${it.path}|${it.r.gap}`;
    else if (it.t === "file") k = `f|${it.f.path}`;
    else if (it.t === "fold") k = `z|${it.path}`;
    else if (it.t === "path") k = `p|${it.h.id}`;
    else if (it.t === "step") k = `s|${it.i}`;
    else if (it.t === "sug" || it.t === "sugact") k = `${it.t}|${it.s.key}`;
    else if (it.t === "comment" || it.t === "cact") k = `${it.t}|${it.c.id}`;
    else if (it.t === "find" || it.t === "fact") k = `${it.t}|${it.f.id}`;
    else if (it.t === "def") k = `d|${it.d.key}`;
    else if (it.t === "compose" || it.t === "composeact") k = `x|${it.t}`;
    else if (it.t === "gh") k = `gh|${it.g.id}`;
    else if (it.obj) k = `${it.t}|${it.k}|${it.obj.id ?? i}`; // a comment card's rows (review.js cardItems)
    else k = `n|${it.text ?? i}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return n ? `${k}#${n}` : k;
  });
}

// Tabs are drawn as spaces to the next multiple of TAB, so a press x maps to a column the same way everywhere.
export const TAB = 4;
export function expandTabs(text) {
  if (!text.includes("\t")) return text;
  let out = "";
  for (const ch of text) out += ch === "\t" ? " ".repeat(TAB - (out.length % TAB)) : ch;
  return out;
}

// The UTF-16 offset in `text` at column `col` of its tab-expanded form.
export function offsetAt(text, col) {
  let c = 0;
  for (let i = 0; i < text.length; i++) {
    const w = text[i] === "\t" ? TAB - (c % TAB) : 1;
    if (col < c + w) return i;
    c += w;
  }
  return text.length;
}

// A press at x (px from the list's left) on a code row: the clickable token under it and the language-server
// position — line on the row's side (1-based; new side for added and context rows) and the UTF-16 character in the
// original text. spans are for the tab-expanded text. null when no name is under the pointer.
export function tokenAt(row, spans, x, codeLeft, charW) {
  const col = Math.floor((x - codeLeft) / charW);
  if (col < 0 || row.number === undefined) return null;
  const ref = spans.find((s) => s.ref && s.start <= col && col < s.end);
  if (!ref) return null;
  const shown = expandTabs(row.text);
  return { name: shown.slice(ref.start, ref.end), side: row.kind === "-" ? "-" : "+", line: row.kind === "-" ? row.o ?? row.number : row.n ?? row.number,
    character: offsetAt(row.text, ref.start) };
}

// ---- since your last review (open-reviews.json `reviewed`: {sha, how: "sent"|"done"|"seen", at})

// The mark after this visit: sending or Mark done always moves it; just having the review open ("seen") moves it
// only to a new head, so it never downgrades a sent/done mark of the same head.
export function markReviewed(old, head, how, now) {
  if (!head) return old ?? null;
  return how === "seen" && old?.sha === head ? old : { sha: head, how, at: now };
}

// The head to diff from: the last mark, when the PR moved since; null when there is none or it is the head.
export const sinceBase = (entry, head) => (entry?.reviewed?.sha && head && entry.reviewed.sha !== head ? entry.reviewed : null);

// ---- fix verification (verify.py) and finding statuses

// Findings sent to Fix (status fixHead) whose PR head moved since, not settled and not verified on this head yet.
export function verifyCandidates(findings, status, head, statusOf) {
  return findings.filter((f) => {
    const st = status[f.id];
    return st?.fixHead && head && st.fixHead !== head && st.verify?.head !== head && statusOf(f) !== "dismissed";
  });
}

// verify.py's verdicts into the status map: fixed → ✓, not fixed → open again with the reason, unclear → as it was,
// with the note. Each keeps {verify: {result, reason, head, at}}.
export function applyVerification(status, results, head, now) {
  const out = { ...status }, at = new Date(now).toISOString();
  for (const r of results ?? []) {
    const old = status[r.id] ?? {}, verify = { result: r.verdict, reason: r.reason ?? "", head, at };
    out[r.id] = r.verdict === "fixed" ? { ...old, s: "fixed", at, verify } : r.verdict === "not_fixed" ? { ...old, s: "open", at, verify } : { ...old, verify };
  }
  return out;
}

// ---- pictures (review.py "visual" per layer, "architecture", "blast_radius")

// Column per node: the longest path from a node nothing points to (cycles broken by visiting order), so a flow reads
// left to right (or top to bottom). Unknown edge ends are ignored.
export function levels(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id)), out = new Map(nodes.map((n) => [n.id, []])), indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges ?? []) if (ids.has(e.from) && ids.has(e.to) && e.from !== e.to) { out.get(e.from).push(e.to); indeg.set(e.to, indeg.get(e.to) + 1); }
  const level = new Map(), queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  for (const id of queue) level.set(id, 0);
  while (queue.length) {
    const id = queue.shift();
    for (const to of out.get(id)) {
      level.set(to, Math.max(level.get(to) ?? 0, level.get(id) + 1));
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }
  for (const n of nodes) if (!level.has(n.id)) level.set(n.id, 0); // in a cycle: first column
  return level;
}

// The spec-only elements of the pictures, by id: {id, label, page: "arch" | null, step: index | null}. Asks link to
// the ones they name.
export function specElements(ai) {
  const out = new Map(), add = (id, label, where) => { if (!out.has(id)) out.set(id, { id, label: label ?? id, ...where }); };
  for (const n of ai?.arch?.nodes ?? []) if (n.source === "spec") add(n.id, n.label, { page: "arch", step: null });
  for (const v of ai?.visuals ?? []) for (const n of v.nodes ?? []) if (n.source === "spec") add(n.id, n.label, { page: "arch", step: null });
  (ai?.steps ?? []).forEach((s, k) => { for (const v of s.visuals ?? []) for (const n of v.nodes ?? []) if (n.source === "spec") add(n.id, n.label, { page: null, step: k }); });
  return out;
}

// The layout of these pictures: arch.js archLayout.

// The blast radius as an architecture picture: upstream context, the changed units, downstream context (columns),
// context linked to the unit it touches (dashed edges carrying the relation).
export function blastArch(blast, findings = []) {
  const units = blast?.units ?? [], ctx = blast?.context ?? [];
  const nodes = [
    ...ctx.filter((c) => c.direction === "upstream").map((c) => ({ id: `c:${c.id}`, group: "up", label: c.file.split("/").pop(), description: c.relation, type: "context", status: "unchanged", file: c.file })),
    ...units.map((u) => ({ id: `u:${u.id}`, group: "unit", label: u.label, description: (u.files ?? []).join(", "), type: u.type ?? "", status: u.status === "new" || u.status === "added" ? "new" : u.status === "removed" ? "removed" : "changed",
      spots: u.spots ?? 0, file: u.files?.[0], findings: findings.filter((f) => (u.files ?? []).includes(f.file)) })),
    ...ctx.filter((c) => c.direction !== "upstream").map((c) => ({ id: `c:${c.id}`, group: "down", label: c.file.split("/").pop(), description: c.relation, type: "context", status: "unchanged", file: c.file })),
  ];
  const edges = ctx.filter((c) => units.some((u) => u.id === c.links_to)).map((c) => (c.direction === "upstream"
    ? { from: `c:${c.id}`, to: `u:${c.links_to}`, label: c.relation, dashed: true } : { from: `u:${c.links_to}`, to: `c:${c.id}`, label: c.relation, dashed: true }));
  return { groups: [{ id: "up", label: "Upstream", kind: "RELATED CONTEXT" }, { id: "unit", label: "Changed", kind: "" }, { id: "down", label: "Downstream", kind: "RELATED CONTEXT" }], nodes, edges,
    counts: { added: units.filter((u) => u.status === "new" || u.status === "added").length, changed: units.filter((u) => !["new", "added"].includes(u.status)).length,
      up: ctx.filter((c) => c.direction === "upstream").length, down: ctx.filter((c) => c.direction !== "upstream").length } };
}

// ---- pre-merge checks and merge blockers (no LLM: the analysis' rule checks, gh pr checks, mergeability)

export const CONVENTIONAL = /^(feat|fix|chore|docs|refactor|test|ci|build|perf|revert|style)(\([^)]+\))?!?: \S/;

// ctx: related.py's {checks: [{name, bucket}], mergeable}. Each check {name, ok: true|false|null (pending), why}.
export function preMergeChecks({ title, rules = [], ctx = null }) {
  const out = [];
  if (title) out.push({ name: "Conventional Commit title", ok: CONVENTIONAL.test(title), why: CONVENTIONAL.test(title) ? title : `"${title}" is not type(scope): subject` });
  for (const r of rules) if (r.status !== "n/a") out.push({ name: r.rule, ok: r.status === "pass", why: r.why, where: r.where, rule: true });
  for (const c of ctx?.checks ?? []) if (c.bucket !== "skipping") out.push({ name: `CI: ${c.name}`, ok: c.bucket === "pass" ? true : c.bucket === "pending" ? null : false, why: c.bucket, ci: true });
  if (ctx?.mergeable) out.push({ name: "No merge conflicts", ok: ctx.mergeable === "MERGEABLE" ? true : ctx.mergeable === "CONFLICTING" ? false : null, why: ctx.mergeable.toLowerCase() });
  return out;
}

// What stands between the PR and a merge, most severe first: conflicts, failing CI, failed rules, high/critical
// unresolved findings that this PR brings in (introduced_here not false; one that was there before is in alreadyThere)
// and security findings of any severity (at their own severity; sent(f): a fix is out for it,
// which does not resolve it), fixes not verified on this head,
// overlapping open PRs (not the one this PR is stacked on: that is its base, the merge order is given).
export function mergeBlockers({ checks = [], findings = [], unverified = 0, related = null, sent = () => false }) {
  const out = [];
  if (checks.some((c) => c.name === "No merge conflicts" && c.ok === false)) out.push({ kind: "conflict", severity: "high", title: "Code conflicts need to be resolved", why: "The base branch changed the same lines since this branch was cut: merge or rebase the base first." });
  const ci = checks.filter((c) => c.ci && c.ok === false);
  if (ci.length) out.push({ kind: "ci", severity: "high", title: `${ci.length} CI ${ci.length === 1 ? "check is" : "checks are"} failing`, why: ci.map((c) => c.name.replace(/^CI: /, "")).join(", ") });
  for (const c of checks.filter((x) => (x.rule || x.name === "Conventional Commit title") && x.ok === false)) out.push({ kind: "rule", severity: "medium", title: `Rule not met: ${c.name}`, why: c.why ?? "", where: c.where });
  for (const f of findings.filter((x) => (x.severity === "high" || x.severity === "critical" || x.security) && x.introduced_here !== false)) out.push({ kind: "finding", severity: x2(f.severity), title: f.title, why: `${f.file}:${f.line} · unresolved ${f.severity} finding${sent(f) ? " · fix sent, not verified" : ""}`, finding: f.id });
  if (unverified) out.push({ kind: "verify", severity: "medium", title: `${unverified} ${unverified === 1 ? "fix is" : "fixes are"} not verified`, why: "Sent to Fix before the last push: verify them on the new head." });
  for (const p of related?.open ?? []) if (p.overlap > 0 && !p.stacked) out.push({ kind: "overlap", severity: "low", title: `Overlaps with open PR #${p.number}`, why: `Both change ${p.overlap} ${p.overlap === 1 ? "file" : "files"} (${(p.files ?? []).slice(0, 3).join(", ")}): agree on the merge order.`, url: p.url });
  return out;
}

// ---- PR triage card (main.js list, registry consumers): no LLM, from what is cached; triage.py's why/priority beat the guess

const TYPES = { feat: "Feature", fix: "Fix", refactor: "Refactor", docs: "Docs", chore: "Chore", test: "Test", perf: "Performance", ci: "CI", build: "Build", revert: "Revert", style: "Style" };

// pr: prs.json entry; analysis: a mapReview result or null; size: {files, lines} or null; security: open security
// findings [{severity}]; related: related.py's; llm: triage.py's {priority, why} or null.
export function triageOf({ pr, analysis = null, size = null, security = [], related = null, llm = null }) {
  const type = TYPES[/^(\w+)(\(|!|:)/.exec(pr?.title ?? "")?.[1]] ?? "Change";
  const score = analysis?.effort?.score ?? (size ? (size.lines < 50 && size.files <= 3 ? 1 : size.lines < 400 ? 3 : 5) : null);
  const effort = score === null ? null : score <= 2 ? "Low effort" : score === 3 ? "Medium effort" : "High effort";
  const risk = analysis?.mergeRisk?.level ?? null, high = risk === "high" || risk === "critical";
  const sec = security.some((f) => f.severity === "high" || f.severity === "critical") || high ? "High security risk" : security.length ? "Security risk" : null;
  const overlap = (related?.open ?? []).filter((p) => p.overlap > 0 && !p.stacked).length;
  const priority = llm?.priority ?? (high || overlap ? 1 : risk === "medium" || score >= 4 ? 2 : 3);
  const why = llm?.why ?? (overlap ? `Review this early: ${overlap} other open ${overlap === 1 ? "PR touches" : "PRs touch"} the same files, so its assumptions shape theirs.`
    : high ? `Review this early: merge risk is ${risk}${analysis.mergeRisk.why ? ` (${analysis.mergeRisk.why})` : ""}.`
    : score !== null && score <= 2 && !sec ? "A quick look should do: small and low risk." : null);
  // ponytail: no "Deep review" / "Quick look" any more: from the same score as the effort, it said "Deep review" beside
  // "Low effort" whenever the merge risk was high.
  return { priority, why, type, chips: [sec, type, effort].filter(Boolean) };
}

// ---- PRs you didn't open (main.js sources "This repo", "Review requested", "Open PR…")

// "https://github.com/o/r/pull/12" (also …/files), "o/r#12" or "o/r/pull/12" → {repo, number, url}; null otherwise.
export function parsePrRef(text) {
  const m = /^\s*(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:#|\/pull\/)(\d+)(?:\/[\w/-]*)?(?:[?#].*)?\s*$/.exec(String(text ?? ""));
  return m ? { repo: m[1], number: Number(m[2]), url: `https://github.com/${m[1]}/pull/${m[2]}` } : null;
}

// A gh PR (pr list / pr view / search prs JSON) as a prs.json-like target the panel and the review layout take.
// No session: replies go to a new Claude tab. headSha is null for search results (gh pr view fills it on open).
export function ghTarget(p, { repo, context, cwd = null, source }) {
  const r = repo ?? p.repository?.nameWithOwner ?? /github\.com\/([^/]+\/[^/]+)\/pull/.exec(p.url ?? "")?.[1];
  return { url: p.url, repo: r, number: p.number, title: p.title, author: p.author?.login ?? null, state: p.isDraft ? "draft" : String(p.state ?? "open").toLowerCase(),
    head: p.headRefName ?? null, headSha: p.headRefOid ?? null, base: p.baseRefName ?? null, updatedAt: p.updatedAt ?? null, review: p.reviewDecision || null,
    add: p.additions ?? null, del: p.deletions ?? null, context, sessionContext: context, session: null, cwd, source };
}

// The source lists cache (pr-data/sources.json, {key: {at, prs}}): the newest max keys.
export function pruneSources(doc, max = 20) {
  return Object.fromEntries(Object.entries(doc ?? {}).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, max));
}

// ---- installing the review layout (startReview): mods/pr-review/review-layout.json into layouts/ on first use

// Whether a layout file is this mod's review layout: a block with the review part of pr-review.
export function isReviewLayout(text) {
  try {
    const walk = (n) => Boolean(n) && ((n.content?.mod === "pr-review" && n.content?.props?.part === "review") || (n.children ?? []).some(walk));
    return walk(JSON.parse(text));
  } catch { return false; }
}

// Which layout name to switch to and whether to write it, from the current layouts/review.json and
// layouts/pr-review.json (text, or null when missing). Never overwrites a file that is there.
export function layoutPlan(review, prReview) {
  if (review == null) return { name: "review", write: true };
  if (isReviewLayout(review)) return { name: "review", write: false };
  return { name: "pr-review", write: prReview == null };
}

// ---- the Overview page (review.js overviewPage): the task check as one list, the verdict line, the copied state

const linked = (a, f) => a.findings.some((id) => f.ids.includes(id)) || (f.criteria ?? []).includes(a.id);
// The task check and the findings as one list: `security` (the unresolved security findings), `rows` (each ask with
// the findings that break it: the ask names them, or they name the ask; `unlinked`: the analysis says no finding backs
// it), `extra` (what the task did not ask for) and `other` (unresolved findings that belong to no ask). `criteria` are
// the asks the head line counts: the acceptance criteria when the analysis marks them, else every ask but the extras.
// A finding of a cause whose first finding is still open (same_cause): it does not count again.
const followsOpen = (f, open) => Boolean(f.same_cause) && open.some((g) => g !== f && (g.id === f.same_cause || (g.ids ?? []).includes(f.same_cause)));
export function taskList(asks = [], findings = [], unlinked = [], statusOf = () => "open") {
  const open = findings.filter((f) => !["fixed", "dismissed"].includes(statusOf(f)));
  const row = (ask) => { const fs = findings.filter((f) => linked(ask, f)); return { ask, findings: fs, unlinked: !fs.length && unlinked.includes(ask.id) }; };
  const marked = asks.some((a) => a.acceptance === true), criteria = asks.filter((a) => a.state !== "extra" && (!marked || a.acceptance === true));
  return { security: open.filter((f) => f.security && !followsOpen(f, open)), rows: asks.filter((a) => a.state !== "extra").map(row), extra: asks.filter((a) => a.state === "extra").map(row),
    other: open.filter((f) => !f.security && !asks.some((a) => linked(a, f))), marked, criteria: criteria.length, met: criteria.filter((a) => a.state === "met").length };
}
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// The Overview's groups of criteria: the acceptance criteria ("head") and the rest of the description ("rest"), each
// with whether all its rows are met (then it folds to one line at the end of the page).
export function criteriaGroups(l) {
  const marked = l.rows.filter((r) => l.marked && r.ask.acceptance), rest = l.rows.filter((r) => !marked.includes(r));
  return [["head", marked], ["rest", rest]].filter(([, rows]) => rows.length).map(([key, rows]) => ({ key, rows, met: rows.every((r) => r.ask.state === "met") }));
}
const metText = (l) => `${l.met} of ${l.criteria} ${l.marked ? "acceptance criteria" : "criteria"} met`;
// "0 of 5 acceptance criteria met, 1 extra"; "" without a task.
export const taskHead = (l) => (l.rows.length + l.extra.length ? `${metText(l)}${l.extra.length ? `, ${l.extra.length} extra` : ""}` : "");
// A security finding whose way from outside rests on an assumption (path_certainty; an older finding: its certainty).
const reachAssumed = (f) => (f.path_certainty ?? f.certainty) === "assumed";
// The verdict under the PR title, counted by what decides a merge: the unresolved security findings (one per cause:
// merged findings are one), the task's
// criteria, and the blockers besides findings (failed rules or checks, fixes not verified on this head). It does not
// count the high findings: the groups below say how severe each one is. Without a task and without a security finding:
// the unresolved findings. → [{key, text, short, tone: security | ok | plain}]; `short` is the bar's excerpt
// ("⛨ 2 high · 0/5 criteria"), from the same parts so the two never disagree.
// oldRules: the security run was made under older rules of the security view (secNote); the ⛨ count then says so
// ("older rules, re-run"), in the line and in the bar, because what carries ⛨ through one of its threats may change.
export function verdictParts(l, c, { failed = 0, toVerify = 0, oldRules = false } = {}) {
  const sec = l.security, secHigh = sec.filter((f) => f.severity === "high").length, open = c.unresolved ? count(c.unresolved, "unresolved finding") : "No unresolved findings";
  const assumed = sec.filter(reachAssumed).length, old = oldRules ? " (older rules, re-run)" : ""; // words, not the noun "reach": that an attacker gets there is assumed
  const notes = [!assumed ? null : assumed === sec.length ? "assumed reachable" : `${assumed} assumed reachable`, oldRules && "older rules, re-run"].filter(Boolean), reach = notes.length ? ` (${notes.join("; ")})` : "";
  return [sec.length === 1 && { key: "security", text: `1 security cause, ${sec[0].severity}${reach}`, short: `⛨ 1 ${sec[0].severity}${old}`, tone: "security" },
    sec.length > 1 && { key: "security", text: `${sec.length} security causes, ${secHigh || "none"} high${reach}`, short: `${secHigh ? `⛨ ${secHigh} high` : `⛨ ${sec.length}`}${old}`, tone: "security" },
    l.criteria > 0 && { key: "criteria", text: metText(l), short: `${l.met}/${l.criteria} criteria`, tone: l.met === l.criteria ? "ok" : "plain" },
    !sec.length && !l.criteria && { key: "findings", text: open, short: open, tone: c.unresolved ? "plain" : "ok" },
    failed > 0 && { key: "checks", text: `${count(failed, "check")} failed`, short: `${count(failed, "check")} failed`, tone: "plain" },
    toVerify > 0 && { key: "verify", text: `${count(toVerify, "fix", "fixes")} to verify`, short: `${count(toVerify, "fix", "fixes")} to verify`, tone: "plain" }].filter(Boolean);
}

// What the PR does, as a labeled list [[label, [{text, source?, evidence?}]]]: the analysis' whatChanged {adds,
// changes, runtime} when it has one; an older analysis' paragraphs cut into sentences, a summary sentence that starts
// with "Adds" under Adds, the other ones under Changes, the behavior under At run time. Empty labels are left out.
const sentences = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[A-Z`"(])/).filter(Boolean) : []);
export function doesList(ai) {
  const w = ai?.whatChanged, item = (text) => ({ text: String(text) });
  const runtime = ai?.behaviorPoints?.length ? ai.behaviorPoints : sentences(ai?.behavior).map(item), said = sentences(ai?.summary), adds = said.filter((x) => /^(adds?|introduces?|creates?)\b/i.test(x));
  const lists = w ? [w.adds, w.changes, w.runtime].map((l) => (l ?? []).map(item)) : [adds.map(item), said.filter((x) => !adds.includes(x)).map(item), runtime];
  return [["Adds", lists[0]], ["Changes", lists[1]], ["At run time", lists[2]]].filter(([, l]) => l.length);
}

// ---- the Overview: the list before the merge, the suggested action, what nobody checked, the attack surface

// An analysis' repo rule that only restates the PR's own criteria ("PR acceptance criteria"): the criteria have their
// own list, so they are not counted a second time as rules.
export const realRules = (rules = []) => rules.filter((r) => !/acceptance|criteri/i.test(String(r.source ?? "")));

// What stands before the merge, as rows for the Overview, most urgent first: the unresolved security findings, the
// findings that break a criterion not met (most severe first), a criterion not met that no finding stands for, then the
// other blockers (pr.js mergeBlockers: high findings, conflicts, CI, rules, fixes to verify, overlapping PRs). A finding
// already there before this PR is not in it. → [{kind: security | criterion | ask | finding | conflict | ci | rule |
// verify | overlap, title, finding?, ask?, asks (the unmet criteria it breaks), where?, why?, url?}]
const RANK = { critical: 0, high: 1, medium: 2, low: 3 };
export function beforeMerge({ list, findings = [], blockers = [], statusOf = () => "open" }) {
  const unmet = list.rows.filter((r) => ["broken", "partly", "not_done"].includes(r.ask.state)), ids = new Set(), rows = [];
  const breaks = (f) => unmet.filter((r) => r.findings.some((x) => x.id === f.id)).map((r) => r.ask);
  const add = (f, kind) => { if (!f || ids.has(f.id) || f.introduced_here === false || ["fixed", "dismissed"].includes(statusOf(f))) return; ids.add(f.id); rows.push({ kind, title: f.title, finding: f, asks: breaks(f), where: `${f.file}:${f.line}` }); };
  list.security.forEach((f) => add(f, "security"));
  unmet.flatMap((r) => r.findings).sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9)).forEach((f) => add(f, "criterion"));
  for (const r of unmet) if (!r.findings.some((f) => ids.has(f.id))) rows.push({ kind: "ask", title: r.ask.short || r.ask.text, ask: r.ask, asks: [r.ask] });
  for (const b of blockers) {
    if (b.finding) add(findings.find((f) => f.id === b.finding || (f.ids ?? []).includes(b.finding)), "finding");
    else rows.push({ kind: b.kind ?? "check", title: b.title, why: b.why ?? "", where: b.where ?? null, url: b.url ?? null, asks: [] });
  }
  return rows;
}
// The action the Overview suggests from those rows: anything the author has to change asks for changes; fixes waiting
// for a check (and PRs that overlap) only delay an approval.
export function verdictAction(rows) {
  const change = rows.filter((r) => !["verify", "overlap"].includes(r.kind)).length, verify = rows.some((r) => r.kind === "verify");
  return change ? "Request changes" : verify ? "Approve after verifying the fixes" : "Approve";
}

// What nobody checked: the areas no run reports as checked (the analysis' and the reviewers' own reports; an area one
// run checked is not counted), the unresolved findings that rest on an assumption, and how far the security review
// got. → {areas, assumptions, security: "not run" | "running" | "failed" | "no findings" | "n findings", text}
export function notChecked({ ai = null, runs = {}, open = [] }) {
  const all = [...(ai?.scope?.checked ?? []), ...Object.values(runs ?? {}).flatMap((r) => r?.scope?.checked ?? [])];
  const seen = new Set(all.filter((c) => c.result !== "not_checked").map((c) => c.area));
  const areas = [...new Set(all.filter((c) => c.result === "not_checked" && !seen.has(c.area)).map((c) => String(c.area).replace(/_/g, " ")))];
  const assumptions = open.filter((f) => f.certainty === "assumed" || f.path_certainty === "assumed"), sr = runs?.security;
  const security = !sr?.state ? "not run" : sr.state === "running" ? "running" : sr.state === "failed" ? "failed" : sr.count ? count(sr.count, "finding") : "no findings";
  return { areas, assumptions, security, text: `${count(areas.length, "area")} not checked · ${count(assumptions.length, "assumption")} · security review: ${security}` };
}

// The attack surface in one line, from the analysis' access rows and what it checked about secrets: "1 way in, 1
// public, 1 opened here · 2 rights, 1 unused · secrets: finding". null when there is nothing to say.
export function surfaceLine(access = [], checked = []) {
  const entries = (access ?? []).filter((x) => x.public || /route|endpoint|api|url|http|gateway|ingress/i.test(String(x.kind ?? ""))), rights = (access ?? []).filter((x) => !entries.includes(x));
  const pub = entries.filter((x) => x.public).length, opened = entries.filter((x) => x.opened_by_pr).length, unused = rights.filter((x) => x.used === false).length;
  const sec = (checked ?? []).find((c) => c.area === "secrets");
  const parts = [entries.length > 0 && `${count(entries.length, "way in", "ways in")}${pub ? `, ${pub} public` : ""}${opened ? `, ${opened} opened here` : ""}`,
    rights.length > 0 && `${count(rights.length, "right")}${unused ? `, ${unused} unused` : ""}`, sec && `secrets: ${String(sec.result).replace(/_/g, " ")}`].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

// The checks in the groups the bar and the Overview count alike: the repo rules (the title's form and the analysis'
// rules), CI, and the merge conflicts check.
export const checkGroups = (checks = []) => ({ rules: checks.filter((c) => !c.ci && c.name !== "No merge conflicts"), ci: checks.filter((c) => c.ci), conflict: checks.filter((c) => c.name === "No merge conflicts") });

// What the AI runs on a PR cost, summed: "$0.53 (Analysis $0.22, Security review $0.31)"; "" when nothing is known.
// runs: [[label, cost]].
export function costLine(runs) {
  const paid = runs.filter(([, c]) => Number(c) > 0), usd = (c) => `$${Number(c).toFixed(2)}`;
  return paid.length ? `${usd(paid.reduce((n, [, c]) => n + Number(c), 0))} (${paid.map(([k, c]) => (paid.length > 1 ? `${k} ${usd(c)}` : k)).join(", ")})` : "";
}

// How sure a finding is and what it hangs on, instead of telling its effect as a fact: "Assumed, not checked · only
// if FRONT_DESK_TOKEN is not set and the HttpApi route has no authorizer": every precondition, they are rarely more
// than two (a sentence's capital and end go, a name's capital stays). "" for a finding from before the analysis said so.
export const CERTAINTY = { confirmed: "Confirmed by a run", derived: "Derived from the code", assumed: "Assumed, not checked" };
const clause = (p) => String(p).trim().replace(/\.$/, "").replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());
export const certaintyLine = (f) => [CERTAINTY[f.certainty], f.preconditions?.length ? `only if ${f.preconditions.map(clause).join(" and ")}` : null].filter(Boolean).join(" · ");
// What a severity follows from (the analysis' impact scale), for the tooltip of a severity chip.
export const SEVERITY_SCALE = { high: "it breaks a requirement, leaves a dead path, allows unauthorized access, exposes data or loses data",
  medium: "an edge case, degraded operation, a fragile structure or untested code", low: "maintainability, or work the task did not ask for" };
export const severityTip = (f) => `${f.severity[0].toUpperCase()}${f.severity.slice(1)} severity: ${SEVERITY_SCALE[f.severity] ?? "not rated on the scale"}.${f.impact ? ` Here: ${String(f.impact).replace(/_/g, " ")}.` : ""}`;

// "8 new components, 7 without an owner" from the analysis' component_counts; null when it has none.
export function componentLine(cc) {
  const n = cc?.new ?? 0, ch = cc?.changed ?? 0;
  if (!n && !ch) return null;
  const what = n && ch ? `${n} new and ${count(ch, "changed component")}` : count(n || ch, `${n ? "new" : "changed"} component`);
  return cc.codeowners === false ? `${what}; the repository has no CODEOWNERS file` : `${what}, ${cc.no_owner ? `${cc.no_owner} without an owner` : "each with an owner"}`;
}

// The review's state as plain text, to paste for a colleague ("Copy review state"). A security finding is in it with
// its title only: no file, no line, nothing about how to reach it.
// behavior: what the PR does at run time, first so the reader knows the PR; fixOf(f): the agent and branch of a fix sent
// ("a sub-agent, fix/2-x"); cost: costLine's text.
export function reviewState({ pr, head = "", list, counts, findings, statusOf, progress = "", behavior = "", fixOf = () => "", cost = "", oldRules = false }) {
  const word = (s) => s.replace("_", " ");
  const ask = (r) => `- ${word(r.ask.state)}: ${r.ask.text}${r.ask.acceptance ? " (acceptance criterion)" : ""}${r.ask.why ? `. ${r.ask.why}` : ""}${r.unlinked ? " No finding backs this." : ""}`;
  const one = (f) => `${secByEffect(f) ? `- ${f.severity}, security: ${f.title}` : `- ${f.severity}: ${f.title} (${f.file}:${f.line})`}${statusOf(f) === "progress" && fixOf(f) ? `. Fix: ${fixOf(f)}` : ""}`;
  const groups = [["Unresolved", ["open", "recheck"]], ["Fix sent", ["progress"]], ["Fixed", ["fixed"]], ["Dismissed", ["dismissed"]]]
    .map(([label, st]) => [label, findings.filter((f) => st.includes(statusOf(f)))]).filter(([, fs]) => fs.length);
  return [`Review state of ${pr.repo ?? ""}#${pr.number}: ${pr.title ?? ""}`, `${pr.url ?? ""}${head ? ` at ${String(head).slice(0, 7)}` : ""}`, "",
    ...(behavior ? [`What it does: ${String(behavior).replace(/\s+/g, " ").trim()}`, ""] : []),
    verdictParts(list, counts, { oldRules }).map((p) => p.text).join(" · "), "",
    ...(taskHead(list) ? [`Task check: ${taskHead(list)}`, ...[...list.rows, ...list.extra].map(ask), ""] : []),
    ...groups.flatMap(([label, fs]) => [`${label} (${fs.length}):`, ...fs.map(one), ""]),
    ...(progress ? [progress, ""] : []), ...(cost ? [`AI runs on this PR: ${cost}.`, ""] : []), ...(findings.some((f) => secByEffect(f)) ? ["Security findings about access or data are listed by title only."] : [])].join("\n").trim() + "\n";
}

// ---- Markdown texts (findings, suggestions, comments) where one plain line is shown

// A Markdown text as one plain line, for a folded card, a list row or a title: its first paragraph only, without code
// blocks, list markers, a heading's "#" or a quote's ">", and without the marks of code, bold and links. A text that
// is nothing but a code block (a GitHub suggestion) gives the block's first line. HTML tags (a bot's <a><picture>…)
// go; a text that is then empty but had an image gives the image's alt text, or "(image)".
export function plainText(text) {
  const raw = String(text ?? "").replace(/<!--[\s\S]*?-->/g, ""), src = raw.replace(HTML_TAG, " ");
  if (!src.trim() && /<img\b/i.test(raw)) return /<img\b[^>]*\balt\s*=\s*"([^"]+)"/i.exec(raw)?.[1].trim() || "(image)";
  const noCode = src.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[^\n]*|$)/gm, "");
  const para = noCode.split(/\n[ \t]*\n/).find((p) => p.trim()) ?? src.split("\n").find((l) => l.trim() && !/^[ \t]*(```|~~~)/.test(l)) ?? "";
  return para.split("\n").map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/^\s*(?:#{1,6}\s+|>\s?)/, "")).join(" ")
    .replace(/`([^`]*)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
}
// The HTML tags GitHub renders in a comment, by name: a type like `Vec<String>` or `<T>` is no tag.
const HTML_TAG = /<\/?(?:a|abbr|b|blockquote|br|code|details|div|em|h[1-6]|hr|i|img|kbd|li|ol|p|picture|pre|source|span|strong|sub|summary|sup|table|tbody|td|th|thead|tr|ul)\b[^>]*>/gi;

// ---- the Findings tab: a finding's way into the PR, how its number comes about, owners, effort (review.js findingsPane)

// A finding's five steps, in order: reported, evidence (something that ran shows it: certainty "confirmed"), fix sent
// (and not declined by the agent), verified (a check said fixed: on the fix branch or on the PR head, or an older mark
// by hand) and in the PR (that check read the PR head; one on the fix branch does not). st: its status entry (verify
// {result, reason, head, branch?}: branch set = checked on the fix branch); report: the fix agent's; facts: review.js
// fixFacts' [label, text] pairs. → [{key, label, done, next, missing, details}]: every step not reached says in one
// sentence what is missing, `next` marks the first of them after the furthest step reached (the one the tab shows);
// details are the pairs that belong to a step (agent, branch, commit and report to "Fix sent", the check to "Verified").
export const STEPS = [["reported", "Reported"], ["evidence", "Evidence"], ["sent", "Fix sent"], ["verified", "Verified"], ["in_pr", "In the PR"]];
export function findingSteps(f, st = null, { report = null, facts = [] } = {}) {
  const v = st?.verify ?? null, declined = report?.status === "wontfix", at = (x) => String(x ?? "").slice(0, 7), word = String(v?.result ?? "").replace("_", " ");
  const done = { reported: true, evidence: f.certainty === "confirmed", sent: Boolean(st?.fixHead) && !declined, verified: v?.result === "fixed" || (st?.s === "fixed" && !v),
    in_pr: v?.result === "fixed" && !v.branch };
  const p = f.proof?.state === "done" ? f.proof : null, checking = f.proof?.state === "running";
  const missing = {
    evidence: checking ? "No evidence yet: an agent is checking it now, in its own checkout of the PR head."
      : p?.result === "refuted" ? `An agent refuted it${p.reason ? `: ${p.reason.replace(/\.$/, "")}` : ""}. Dismiss it if you agree.`
      : p?.result === "not_reproduced" ? `No evidence yet: an agent could not reproduce it${p.reason ? `: ${p.reason.replace(/\.$/, "")}` : ""}.`
      : f.certainty === "derived" ? "No evidence yet: the finding is derived from the code." : f.certainty === "assumed" ? "No evidence yet: the finding rests on something that could not be checked."
      : "No evidence yet: nothing that ran shows it.",
    sent: declined ? `No fix on its way: the agent declined${report.note ? `, ${report.note}` : "."}` : "No fix sent yet: Fix hands the finding to an agent.",
    verified: !v ? "Not verified yet: Verify checks the commit the fix agent reports, on its branch or in the PR head."
      : `Not verified: the check ${v.branch ? `on ${v.branch} ` : ""}at ${at(v.head)} says ${word}${v.reason ? `, ${v.reason}` : "."}`,
    in_pr: v?.branch ? "Verified on the fix branch, not in the PR yet: Apply to PR brings it in, then Verify checks the PR head."
      : "Marked fixed by hand: no check has read the PR head.",
  };
  const own = { sent: ["Agent", "Branch", "Commit", "Report"], verified: v ? ["Check"] : [] };
  const last = STEPS.map(([k]) => done[k]).lastIndexOf(true), next = STEPS.findIndex(([k], i) => i > last && !done[k]);
  return STEPS.map(([key, label], i) => ({ key, label, done: done[key], next: i === next, missing: done[key] ? null : missing[key],
    details: key === "evidence" ? proofFacts(f.proof) : facts.filter(([l]) => own[key]?.includes(l)) }));
}

// How the Findings tab's number comes about: what each source reported (every report counts), how
// many findings that makes after merging by file and line, of those unresolved, of those on security, and of those
// confirmed by something that ran. → {by: [[reviewer, n]] (analysis first, AI suggestions last), reported, merged,
// unresolved, security, confirmed}
const SOURCE_ORDER = ["analysis", "claude", "security", "codex", "ai"];
export function funnel(findings, statusOf) {
  const by = {};
  for (const f of findings) for (const s of f.sources ?? []) by[s.reviewer] = (by[s.reviewer] ?? 0) + 1;
  const rank = (k) => (SOURCE_ORDER.includes(k) ? SOURCE_ORDER.indexOf(k) : SOURCE_ORDER.length - 1.5);
  const open = findings.filter((f) => !["fixed", "dismissed"].includes(statusOf(f))), sec = open.filter((f) => f.security);
  return { by: Object.entries(by).sort(([a], [b]) => rank(a) - rank(b)), reported: Object.values(by).reduce((n, k) => n + k, 0), merged: findings.length,
    unresolved: open.length, security: sec.length, confirmed: sec.filter((f) => f.certainty === "confirmed").length };
}
// The same as a sentence (name: a reviewer key's name): "Analysis reported 16, Security review 4 and AI suggestion 3,
// 23 in all. Merged by file and line, that is 21 findings. 18 are unresolved, 3 of them on security, 1 of those
// confirmed by a run."
export function funnelLine(x, name = (k) => k) {
  if (!x.merged) return "No findings reported.";
  const who = x.by.map(([k, n], i) => (i ? `${name(k)} ${n}` : `${name(k)} reported ${n}`));
  const list = who.length > 1 ? `${who.slice(0, -1).join(", ")} and ${who.at(-1)}, ${x.reported} in all` : who[0];
  const sec = !x.unresolved ? "" : !x.security ? ", none of them on security" : `, ${x.security} of them on security, ${x.confirmed || "none"} of those confirmed by a run`;
  return `${list}. Merged by file and line, that is ${x.merged} ${x.merged === 1 ? "finding" : "findings"}. ${x.unresolved || "None"} ${x.unresolved === 1 ? "is" : "are"} unresolved${sec}.`;
}

// Who owns the code a finding sits in: the owner of the first component at the finding's file that names one
// (the analysis' components: {at: "file:line", owner}), else null.
export const ownerOf = (f, components = []) => (components ?? []).find((c) => c?.owner && String(c.at ?? "").replace(/:\d+.*$/, "") === f.file)?.owner ?? null;

// The order "Quickest fix" of the Findings tab: by effort, the ones without one last; within one effort the order stays (severity, file, line).
export const hasEffort = (list) => list.some((f) => EFFORTS.includes(f.effort));
export const quickFirst = (list) => { const r = (f) => (EFFORTS.indexOf(f.effort) + EFFORTS.length + 1) % (EFFORTS.length + 1); return [...list].sort((a, b) => r(a) - r(b)); };

// The security view on the mapped analysis (mapReview, ai). The security run writes it to the findings file
// (`security` {head, at, picture, zones [{id, name, trust, evidence, nodes}], access, crossing [{from, to, edge}],
// threats}); an older analysis had it in its own answer (architecture.zones, nodes[].zone, edges[].crosses, access).
// Returns ai with the view in the analysis' old places, so a view reads one shape either way: arch.zones,
// arch.nodes[].zone, arch.edges[].crosses, access; and threats ([]: none), securityTrigger (the context file's
// security_trigger {run, reasons, why_not}, or null) and securityFrom {source: "security" | "analysis", head, at,
// older, why} (null: no zones and no access anywhere). older: the security run looked at another head than `head` (why
// "head") or at another analysis than this one (why "analysis"): say "from an older run". The security block wins over
// the analysis' own. Pure; called again with the same ai it starts from the analysis' own picture (ai.own).
// Where each card really stands: its drawn trust (its zone's; a card without one, the most exposed of what it runs_in:
// cards, or a frame by its own cards' zones), made more exposed by the security run's effective zones (direct: a check
// in the card's own code, a crossing without one) and passed on along calls in one process (in_process) that no gate
// checks: the consumer handler that /remind calls in-process stands where the front desk stands. Returns the cards that
// stand more exposed than drawn: [{node, drawn, effective, where (the place whose check would have to fail, from the
// direct entry; null when the drawn zone itself is passed on), via: [edge ids e<k> it was passed along]}]. Pure.
const TRUSTS = ["public", "operator", "authenticated", "internal", "data"];
export function effectiveZonesOf(arch, gates = [], direct = []) {
  const nodes = arch?.nodes ?? [], edges = arch?.edges ?? [], trustOf = new Map((arch?.zones ?? []).map((z) => [z.id, z.trust]));
  const byId = new Map(nodes.map((n) => [n.id, n])), hosts = (n) => (Array.isArray(n?.runs_in) ? n.runs_in : n?.runs_in ? [n.runs_in] : []);
  const outer = (ts) => ts.filter((t) => TRUSTS.includes(t)).sort((a, b) => TRUSTS.indexOf(a) - TRUSTS.indexOf(b))[0] ?? null;
  const drawn = (id, seen = new Set()) => {
    if (seen.has(id)) return null;
    seen.add(id);
    const n = byId.get(id);
    if (!n) return outer(nodes.filter((c) => c.group === id && c.zone && !hosts(c).length).map((c) => trustOf.get(c.zone))); // a frame
    return trustOf.get(n.zone) ?? outer(hosts(n).map((h) => drawn(h, seen)));
  };
  const eff = new Map(), more = (a, b) => !b || TRUSTS.indexOf(a) < TRUSTS.indexOf(b);
  for (const n of nodes) { const t = drawn(n.id); if (t) eff.set(n.id, { trust: t, where: null, via: [] }); }
  for (const z of direct ?? []) if (byId.has(z.node) && more(z.effective, eff.get(z.node)?.trust)) eff.set(z.node, { trust: z.effective, where: z.where ?? null, via: [] });
  const gated = (e) => (gates ?? []).some((g) => g.where?.from === e.from && g.where?.to === e.to && g.check !== "none");
  for (let round = 0, moved = true; moved && round <= nodes.length; round++) {
    moved = false;
    edges.forEach((e, k) => {
      const a = eff.get(e.from);
      if (!e.in_process || gated(e) || !a || !more(a.trust, eff.get(e.to)?.trust)) return;
      eff.set(e.to, { trust: a.trust, where: a.where, via: [...a.via, `e${k}`] });
      moved = true;
    });
  }
  return nodes.map((n) => ({ n, d: drawn(n.id), e: eff.get(n.id) })).filter(({ d, e }) => d && e && more(e.trust, d))
    .map(({ n, d, e }) => ({ node: n.id, drawn: d, effective: e.trust, where: e.where, via: e.via }));
}

export function withSecurity(ai, security = null, ctx = null, head = null) {
  if (!ai) return ai;
  const own = ai.own ?? { arch: ai.arch ?? null, access: ai.access ?? [] }, trigger = ctx?.security_trigger ?? null;
  if (!security || !["zones", "access", "threats"].some((k) => Array.isArray(security[k]))) {
    const had = Boolean(own.arch?.zones?.length || own.access?.length);
    return { ...ai, own, arch: own.arch, access: own.access, threats: [], gates: [], effectiveZones: [], bypasses: [], secData: null, securityTrigger: trigger, securityFrom: had ? { source: "analysis", head: null, at: null, older: false, why: null } : null };
  }
  // A zone that holds only the cards an operator or a pipeline acts through (its scripts) is the operator's zone: a
  // run from before that trust level called an admin workstation authenticated or public.
  const scripts = new Set((security.access ?? []).filter((x) => ["operator", "ci"].includes(x?.principal_kind) && x.node).map((x) => x.node));
  const zones = (security.zones ?? []).filter((z) => z?.id).map((z) => ((z.nodes ?? []).length && z.nodes.every((n) => scripts.has(n)) && z.trust !== "operator" ? { ...z, trust: "operator" } : z));
  const zoneOf = new Map(zones.flatMap((z) => (z.nodes ?? []).map((n) => [n, z.id])));
  // A crossing call by its ends: the security run may have looked at an older picture, where e<k> is another edge.
  const crosses = new Map((security.crossing ?? []).map((c) => [`${c.from}\u0000${c.to}`, c]));
  const arch = own.arch && { ...own.arch, zones: zones.map(({ id, name, trust, evidence }) => ({ id, name: name ?? id, trust, evidence: evidence ?? "" })),
    nodes: (own.arch.nodes ?? []).map(({ zone, ...n }) => (zoneOf.has(n.id) ? { ...n, zone: zoneOf.get(n.id) } : n)),
    // A crossing's gate (where and how the call is checked, when the run names it) goes with the call.
    edges: (own.arch.edges ?? []).map(({ crosses: _, ...e }) => { const c = crosses.get(`${e.from}\u0000${e.to}`); return c ? { ...e, crosses: true, ...(c.gate ? { gate: c.gate } : {}) } : e; }) };
  const why = security.head && head && security.head !== head ? "head" : security.picture && ai.generated && security.picture !== ai.generated ? "analysis" : null;
  // gates: the check at each crossing ({where, principal, check, at, source, holds_if, carries}); effectiveZones: cards
  // that stand in a more exposed zone than drawn ({node, drawn, effective, where}), both from the security run.
  // bypasses: calls in one process between zones of different trust ({from, to, edge}): no crossing, but each needs a threat.
  // effectiveZones: the run's direct ones passed on along unchecked in-process calls (effectiveZonesOf).
  return { ...ai, own, arch, access: security.access ?? [], threats: security.threats ?? [], gates: security.gates ?? [],
    effectiveZones: arch ? effectiveZonesOf(arch, security.gates ?? [], security.effective_zones ?? []) : security.effective_zones ?? [],
    bypasses: security.bypasses ?? [],
    // secData: the sensitive data the run names with its way ([{id, name, kind, steps}], dataflow.js); null for a run
    // from before the field (then only what its checks say goes over a crossing is known).
    secData: Array.isArray(security.data) ? security.data : null,
    securityTrigger: trigger,
    // predates: the run was made under older rules of the security view (SEC_RULES): its words may be the old prompt's.
    securityFrom: { source: "security", head: security.head ?? null, at: security.at ?? null, older: Boolean(why), why, predates: (security.rules ?? 1) < SEC_RULES } };
}

// Whether the security review starts by itself after the analysis (review.js securityNow): related.py's trigger says
// the diff gives a reason, the context is of this head, and no security run of this head exists in any state (a
// failed one counts: once per head). Only for a trusted PR (review.js trustedPr): the reviewer is an agent that reads
// the PR's code and text, and someone else's PR may carry instructions to it. Someone else's PR with a reason gets it
// offered instead: the reasons and a button, nothing runs. known: the findings file of this PR is loaded (else its
// runs are not known yet). ready: the analysis is there and done, and the head is a PR checkout. -> {start, offer,
// reasons: the trigger's texts}.
export function securityStart({ trigger = null, trusted = false, head = null, ctxHead = null, run = null, known = false, ready = false } = {}) {
  const reasons = (trigger?.reasons ?? []).map((x) => String(x?.text ?? "")).filter(Boolean);
  const due = Boolean(trigger?.run) && known && Boolean(head) && ctxHead === head && run?.head !== head && run?.state !== "running";
  return { start: due && trusted && ready, offer: due && !trusted, reasons };
}

// ---- Verify with an agent (review.js verifyAgent): an agent's check of a finding, kept in the status map as
// status[id].proof: {state: "running", job, path, branch, base, terminal, head, at} while it works, then {state: "done",
// result (threads.js PROOF_RESULTS), reason, command, output, test, head, at}. Older statuses have none.
export const PROOF_WORDS = { reproduced: "Reproduced", not_reproduced: "Not reproduced", refuted: "Refuted" };
// The findings with the agent's check on them (f.proof): reproduced makes the certainty "confirmed" (something that
// ran shows it); not reproduced and refuted leave it as it was, and refuted only suggests Dismiss.
export const withProof = (findings, status = {}) => findings.map((f) => {
  const p = status[f.id]?.proof;
  return !p ? f : { ...f, proof: p, ...(p.state === "done" && p.result === "reproduced" ? { certainty: "confirmed" } : {}) };
});
// The check as [label, text] pairs, for the "Evidence" step's details.
// A tab the mod opens is named "<repo> <context>" ("bookshelf PR #7"): the repo first, so one repo's tabs read
// together in a tab bar. repo: "owner/name" or its folder; without one, the context alone.
export const tabName = (repo, context) => [String(repo ?? "").split("/").filter(Boolean).pop(), context].filter(Boolean).join(" ");
export const proofFacts = (p) => !p ? [] : p.state === "running" ? [["Agent", `checking it on ${p.branch ?? "its branch"}${p.terminal ? ` (${p.terminal})` : ""}`]] : [
  ["Result", `${PROOF_WORDS[p.result] ?? p.result} by an agent${p.head ? ` at ${String(p.head).slice(0, 7)}` : ""}${p.reason ? `: ${p.reason}` : ""}`],
  p.command && ["Command", p.command], p.output && ["Output", p.output], p.test && ["Test", p.test]].filter(Boolean);

// The group "Already there before this PR": unresolved findings whose flaw this PR did not bring in (introduced_here
// false). They are no merge blocker (mergeBlockers leaves them out); most severe first, then file and line.
export function alreadyThere(findings = []) {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  return findings.filter((f) => f.introduced_here === false).sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || String(a.file).localeCompare(String(b.file)) || a.line - b.line)
    .map((f) => ({ severity: f.severity, title: f.title, why: `${f.file}:${f.line} · ${f.severity} finding, already there before this PR`, finding: f.id }));
}

// Background fetches from GitHub (fetch audit): when one is due again. `s` is {at, fails}: the last try and the
// failures in a row since the last success. Due `base` ms after the last try, the wait doubled per failure up to
// `max`, so a missing network is asked less and less often instead of every tick.
export const pollDue = (s, now, base, max = 30 * 60000) => !s || now - s.at >= Math.min(base * 2 ** s.fails, max);
export const pollAfter = (s, ok, now) => ({ at: now, fails: ok ? 0 : (s?.fails ?? 0) + 1 });
// Whether Herdr's window has the platform's focus (GPUI is_window_active); true where that can't be asked (tests).
export const windowActive = () => { try { return globalThis.window?.is_window_active?.() ?? true; } catch { return true; } };

// The files a way in from outside reaches (access entries with public: their own line's file and the file of the
// architecture card they open, e.g. template.yaml for the route and library/handler.py for its handler).
export function publicFiles(access = [], nodes = []) {
  const file = (at) => String(at ?? "").replace(/:\d+.*$/, "");
  return new Set((access ?? []).filter((a) => a?.public).flatMap((a) => [file(a.at), file((nodes ?? []).find((n) => n.id === a.node)?.at)]).filter(Boolean));
}

// The same in one short line, under the Findings tab's count: "31 reports from 4 sources, 27 after merging · 3 on
// security, none confirmed by a run" (the unresolved number is the count line's own).
export function funnelShort(x) {
  if (!x.merged) return "";
  const n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  return `${n(x.reported, "report")} from ${n(x.by.length, "source")}, ${x.reported > x.merged ? `${x.merged} after merging` : "none merged"}`
    + (x.security ? ` · ${x.security} on security, ${x.confirmed || "none"} confirmed by a run` : "");
}

// A blocker's severity for a finding: critical counts as high; a security finding below high keeps its own.
const x2 = (s) => (s === "critical" ? "high" : s);

// The diff's path for a path a model or a link names: the same path first, else the one path that ends in it
// ("handler.py" for "library/handler.py"); null when none or several do. One rule for every jump (review.js jumpTo,
// goDef), so the two never disagree about whether a line is in the diff.
export function diffPath(paths, path) {
  if (!path) return null;
  const all = [...paths];
  if (all.includes(path)) return path;
  const ends = all.filter((p) => p.endsWith(`/${path}`));
  return ends.length === 1 ? ends[0] : null;
}

// ---- which model a run should use
// The recommended model class for a run and why, in one sentence. kind: analysis | security | resilience | verify | ask | fix.
// data {lines: changed lines in the diff, files: changed files, rules: the security trigger's rules (related.py:
// auth, secrets, permissions, access, route, entry, dependencies, infrastructure), risk: the analysis' merge risk,
// security: the run is about a security finding (verify, fix)}. Sonnet is the rule, also for the security review (its
// checks are narrow; the owner's call); Opus for a large diff, an analysis of a security-critical one, or a check or
// fix of a security finding; never Haiku, which is too weak to reason about code. Returns {tier: "sonnet" | "opus", why}.
export const BIG_DIFF = { lines: 1500, files: 40 };
const CRITICAL = ["auth", "secrets", "permissions", "access"];
export function recommendModel(kind, data = {}) {
  const lines = Number(data.lines ?? 0), files = Number(data.files ?? 0), rules = [...new Set(data.rules ?? [])];
  const big = lines >= BIG_DIFF.lines || files >= BIG_DIFF.files, critical = rules.filter((r) => CRITICAL.includes(r));
  if (kind === "ask") return { tier: "sonnet", why: "one question about the code needs no larger model" };
  if ((kind === "verify" || kind === "fix") && data.security) return { tier: "opus", why: "it is about a security finding" };
  if (big && kind !== "fix") return { tier: "opus", why: `the diff is large (${lines} lines in ${files} ${files === 1 ? "file" : "files"})` };
  if (kind === "analysis" && critical.length) return { tier: "opus", why: `the diff touches ${critical.join(", ")}, where a missed weakness costs most` };
  if (kind === "analysis" && data.risk === "high" && rules.length) return { tier: "opus", why: "the merge risk is high and the diff touches security-relevant code" };
  if (kind === "resilience") { // data.start: resilienceStart(); never Haiku, Opus where retries, timeouts and redelivery interact
    const st = data.start ?? {};
    if (st.async && st.infra) return { tier: "opus", why: "it changes asynchronous calls and infrastructure together, where retries, timeouts and redelivery interact" };
    if (st.concurrency) return { tier: "opus", why: "it brings in concurrency, where races hide" };
    if (st.queues >= 2 && st.retries > 0) return { tier: "opus", why: "it puts two asynchronous steps with retries in a row" };
    return { tier: "sonnet", why: "it reads the calls, retries and effects of a diff of ordinary size" };
  }
  return { tier: "sonnet", why: big ? "a fix changes a few lines, however large the PR" : kind === "security" ? "its checks are narrow and the diff is of ordinary size" : `the diff is of ordinary size${rules.length ? " and touches nothing security-critical" : ""}` };
}
// One class up or down from `tier` for code, never to Haiku: {up, down} (null at the end).
export const tierSteps = (tier) => ({ up: tier === "sonnet" ? "opus" : null, down: tier === "opus" ? "sonnet" : null });

// ---- Resilience (reviewers.py kind "resilience", block `resilience` in the findings file): the model gives facts at
// their lines; the ladders, budgets, blockers and the sentence on top are computed here, the same way every time.

// What a path breaks that blocks a merge, in the order the reason is told, with the reason in words. Alone no blocker:
// no jitter, no alarm, no breaker, no trace context, high cardinality (they make a failure worse or harder to see).
export const RES_BLOCKING = [
  ["dishonest_response", "the route answers success while the work is lost"],
  ["unbounded_retry", "load grows without a limit"],
  ["no_dlq", "a message that always fails comes back until it expires"],
  ["poison_message", "a message that always fails comes back until it expires"],
  ["over_timeout", "the worst run outlasts its timeout and is delivered again"],
  ["duplicate_effect", "a visible effect happens twice"],
  ["lost_effect", "a visible effect is lost"],
  ["swallowed_retry", "an exhausted retry drops the work without a word"],
  ["shared_resource", "a failure reaches a resource shared across deployments"],
  ["no_timeout_public", "a call without a timeout waits inside a public route's request"],
  ["removed_signal", "the PR removes the signal on this path"],
];
const REDELIVERY = new Set(["load grows without a limit", "a message that always fails comes back until it expires", "the worst run outlasts its timeout and is delivered again"]);
const days = (s) => (s >= 86400 ? `${Math.round(s / 86400)} ${Math.round(s / 86400) === 1 ? "day" : "days"}` : s >= 3600 ? `${Math.round(s / 3600)} h` : `${Math.round(s)} s`);
// The calls a path goes through: the deps whose edge or place is one of its steps, or whose file a step is in (a
// model often names the path by its lines, consumer.py:21, and the call by another line of the same file).
const fileOf = (x) => String(x ?? "").replace(/:\d+$/, "");
// The calls a path really reaches (wave R2: never a call that only shares a file): the call's edge is a step, its
// node is one the path goes through, or its place is a step. path.reach: the node ids the path goes through (steps that
// are nodes, both ends of a step edge, the card of a file:line step; reachOf); without it only the steps themselves.
// The calls a path really makes: a call with an edge when the path takes that edge (path.via, else its edge steps); a
// queue's trigger without an edge when the path comes into its consumer over an edge that leaves the process
// (path.entered); another call without an edge when the path reaches its node and steps into the file of its retry
// loop (or its own); any call by its own line. A node merely reached makes no call of it: a record that raises before
// the mail is never multiplied by the mailer's retry.
const depsOf = (path, deps) => {
  const via = new Set(path.via ?? path.steps), entered = new Set(path.entered ?? []), r = path.reach ?? new Set(path.steps);
  const files = new Set(path.steps.map(fileOf));
  return (deps ?? []).filter((d) => (d.at && path.steps.includes(d.at)) || (d.edge ? via.has(d.edge)
    : d.trigger ? entered.has(d.node) : r.has(d.node) && files.has(fileOf(d.retry?.at ?? d.at))));
};
// The edges a path takes (arch: ai.arch): its edge steps and every edge whose two ends it reaches; entered: the nodes
// an edge step that leaves the process (not in_process, e.g. queue → consumer) leads into.
export function viaOf(path, arch, reach = reachOf(path, arch)) {
  const edges = arch?.edges ?? [], steps = new Set(path.steps ?? []);
  return { via: [...new Set([...[...steps].filter((s) => /^e\d+$/.test(s)), ...edges.flatMap((e, k) => (reach.has(e.from) && reach.has(e.to) ? [`e${k}`] : []))])],
    entered: edges.flatMap((e, k) => (steps.has(`e${k}`) && !e.in_process ? [e.to] : [])) };
}
// The node ids a path goes through on the map (arch: ai.arch): node steps, both ends of an edge step, and for a
// file:line step the card of that file (the last that starts at or above the line, else the file's first).
export function reachOf(path, arch) {
  const nodes = arch?.nodes ?? [], edges = arch?.edges ?? [], out = new Set();
  const same = (a, b) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
  for (const s of path.steps ?? []) {
    if (nodes.some((n) => n.id === s)) { out.add(s); continue; }
    const e = /^e(\d+)$/.exec(s);
    if (e && edges[Number(e[1])]) { out.add(edges[Number(e[1])].from); out.add(edges[Number(e[1])].to); continue; }
    const m = /^(.+?):(\d+)$/.exec(String(s));
    if (!m) continue;
    const mine = nodes.map((n) => ({ id: n.id, at: /^(.+?):(\d+)/.exec(String(n.at ?? "")) })).filter((x) => x.at && same(x.at[1], m[1]));
    const card = mine.filter((x) => Number(x.at[2]) <= Number(m[2])).sort((a, b) => Number(b.at[2]) - Number(a.at[2]))[0] ?? mine[0]
      // a card without a place (the unchanged mailer) by its file's name: library/mailer.py → mailer
      ?? nodes.find((n) => !n.at && n.id === m[1].split("/").pop().replace(/\.[^.]+$/, ""));
    if (card) out.add(card.id);
  }
  return out;
}
// Silent: nothing shows the failure (signal none); an older run says it with visible false.
const silentOf = (p) => (p.signal ? p.signal === "none" : !p.visible);

// What the map marks on the chosen path, only there: ⏱ a timeout (or "⏱ no timeout" on a sync call without one),
// ×n a retry, DLQ or "no DLQ" at a consumer, "✕ silent" at its end when nothing signals it, "1 + N" for a call in a
// loop; from the calls (deps) and, where they say nothing, from what the path breaks (failing). at: an edge id e<k>, a
// node id or a file:line; the view puts a place on its card (views.js resCardOf). One mark per kind and place.
export function marksOf(path, deps) {
  const out = [], add = (at, mark) => { if (at && !out.some((x) => x.at === at && x.mark === mark)) out.push({ at, mark }); };
  const mine = depsOf(path, deps), place = path.steps.find((x) => /:\d+$/.test(x)) ?? path.steps[0] ?? null;
  for (const d of mine) {
    const at = d.edge ?? d.node ?? d.at;
    if (d.timeout?.s > 0) add(at, `⏱ ${d.timeout.s} s`);
    else if (d.mode === "sync") add(at, "⏱ no timeout");
    if (d.retry?.attempts > 1) add(d.retry.at || at, `×${d.retry.attempts}`);
    if (d.trigger) add(at, d.trigger.dlq || d.trigger.max_receive > 0 ? "DLQ" : "no DLQ");
  }
  if (path.failing.includes("no_timeout_public") && !out.some((x) => x.mark.startsWith("⏱"))) add(place, "⏱ no timeout");
  if (["no_dlq", "poison_message"].some((k) => path.failing.includes(k)) && !out.some((x) => x.mark.endsWith("DLQ"))) add(place, "no DLQ");
  if (path.failing.includes("n_plus_one")) add(path.steps[0] ?? null, "1 + N");
  if ((silentOf(path) || path.failing.includes("silent")) && path.steps.length) add(path.steps.at(-1), "✕ silent");
  return out;
}

// How much a failure on this path multiplies: one factor per retry layer and per redelivery the path reaches, with
// its line; the product as text: "up to 30 times", or "10 × without limit until the message expires (4 days)" when a
// redelivery has no dead-letter queue or receive limit.
export function ladderOf(path, deps) {
  const factors = [], loops = new Set();
  for (const d of depsOf(path, deps)) {
    const r = d.retry, t = d.trigger, loop = String(r?.at || d.at).split(":")[0];
    // ponytail: one retry loop per file; the mailer's loop named on the handler's and the consumer's call counts once
    if (r?.attempts > 1 && !loops.has(loop) && loops.add(loop)) factors.push({ label: `${r.layer || "retry"}: ${r.attempts} attempts`, n: r.attempts, at: r.at || d.at });
    if (t && (t.batch > 1) && t.partial_batch === false) factors.push({ label: `the whole batch of ${t.batch} again`, n: t.batch, at: d.at });
    if (t && t.max_receive > 0) factors.push({ label: `redelivered up to ${t.max_receive} times, then the dead-letter queue`, n: t.max_receive, at: d.at });
    else if (t && t.dlq === false && d.mode === "async") {
      const until = t.retention_s ? ` (${days(t.retention_s)})` : "";
      factors.push({ label: `redelivered until the message expires${until}`, n: null, at: d.at, until });
    }
  }
  if (!factors.length) return null;
  const open = factors.find((f) => f.n === null), product = factors.filter((f) => f.n !== null).reduce((p, f) => p * f.n, 1);
  const text = open ? `${product > 1 ? `${product} × ` : ""}without limit until the message expires${open.until}` : `up to ${product} times`;
  return { factors, text };
}

// A batch's worst run against its function's timeout: batch × the longest one record can take (worst_record_s).
export function budgetOf(path, deps) {
  const d = depsOf(path, deps).find((x) => x.trigger?.batch > 0 && x.trigger?.worst_record_s > 0 && x.trigger?.fn_timeout_s > 0);
  if (!d) return null;
  const { batch, worst_record_s: w, fn_timeout_s: limit } = d.trigger, value = batch * w, over = value - limit;
  return { value_s: value, limit_s: limit, over_s: Math.max(0, over), at: d.at,
    text: over > 0 ? `up to ${value} s for a batch of ${batch} against a ${limit} s timeout: ${over} s over` : `up to ${value} s for a batch of ${batch}, within its ${limit} s timeout` };
}

// Whether a path blocks the merge and why, in words with the line: only a path with a finding; by what it breaks
// (RES_BLOCKING), by a ladder without a limit, by a budget over its timeout, or when it repeats or loses effects
// and nothing signals it.
// A repeated or lost effect blocks only when the effect is visible and cannot be taken back (a mail, a payment, a
// notification …): effects on the path (by node, or a line in the effect's file) of such a kind. Without any effects
// in the block (an older run) the model's word stays.
const RES_VISIBLE = /mail|sms|text message|push|notif|payment|charge|refund|invoice|order|webhook|ship/i;
const RES_EFFECT = new Set(["duplicate_effect", "lost_effect", "swallowed_retry"]);
// A path's end that names such an effect counts too: a lost publish ends in mails nobody gets.
const visibleOn = (path, effects) => !effects.length || RES_VISIBLE.test(path.end ?? "") || effects.some((e) => RES_VISIBLE.test(`${e.kind} ${e.id}`) &&
  (path.steps.includes(e.node) || (path.reach?.has(e.node) ?? false) || path.steps.some((s) => String(s).split(":")[0] === String(e.at ?? "").split(":")[0])));
// A message that always fails is bounded when a dead-letter queue or a receive limit takes it (on the path's calls,
// else on every queue consumer of the run); a run outlasting its timeout blocks only when it comes back (a consumer
// with redelivery), not in a request that just fails.
const RES_UNBOUNDED = new Set(["unbounded_retry", "no_dlq", "poison_message"]);
// What blocks by the path itself, not by the state it reads: the stronger reason wins over reads_foreign_state.
const RES_OWN = new Set(["dishonest_response", "no_timeout_public", "shared_resource", "removed_signal"]);
export function blockerOf(path, ladder, budget, effects = [], deps = []) {
  // Reading state another process holds is a finding, not a blocker: what it breaks (a poison message, a lost mail)
  // blocks in its own path. (A race and such a read exclude each other; neither is double counted.) A reason of the
  // path's own still blocks, whatever else the run names on it (RES_OWN): the route of POST /remind answers success
  // while the mail is lost, also when its consumer reads the other Lambda's store.
  if (path.result !== "finding") return null;
  const foreign = path.failing.includes("reads_foreign_state");
  // where: the path's first line, else what limits it, else the ladder's place (a path named only by cards and calls)
  const at = path.steps.find((s) => /:\d+$/.test(s)) ?? path.limited_by ?? (ladder?.factors.find((f) => f.n === null) ?? ladder?.factors[0])?.at ?? null, seen = visibleOn(path, effects);
  const mine = depsOf(path, deps), consumers = (mine.length ? mine : deps).filter((d) => d.trigger);
  const bounded = consumers.length > 0 && consumers.every((d) => d.trigger.dlq === true || d.trigger.max_receive > 0) && !(ladder?.factors.some((f) => f.n === null));
  const redelivered = Boolean(budget) || mine.some((d) => d.trigger && d.mode === "async");
  const hit = RES_BLOCKING.find(([k]) => path.failing.includes(k) && (!foreign || RES_OWN.has(k)) && (!RES_EFFECT.has(k) || seen) && (!RES_UNBOUNDED.has(k) || !bounded) && (k !== "over_timeout" || redelivered));
  if (hit) return { why: hit[1], at: hit[0] === "over_timeout" && budget ? budget.at : at };
  if (foreign) return null;
  if (ladder?.factors.some((f) => f.n === null)) return { why: "load grows without a limit", at: ladder.factors.find((f) => f.n === null).at };
  if (budget?.over_s > 0) return { why: "the worst run outlasts its timeout and is delivered again", at: budget.at };
  if (silentOf(path) && (path.kind === "effect" || path.kind === "silent") && seen) return { why: "the path repeats or loses effects and nothing signals it", at };
  return null;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Dependencies that fail or are overloaded (block.downstream, one entry per dependency the PR uses anew or differently,
// a case for each way it fails): the words for a case, and the dependency's card on the map (its own node, else the
// card its call leads to). A case decides nothing by itself: where it breaks it names a path, and the path blocks by
// the rules above.
export const RES_WHEN = { slow: "slow", overloaded: "overloaded", down: "down", bad_answer: "bad answer", recovers: "recovers" };
export const WHEN_IS = { slow: "is slow", overloaded: "is overloaded", down: "is down", bad_answer: "answers wrong", recovers: "comes back" };
const WHEN_MARK = { ...RES_WHEN, bad_answer: "wrong answer", recovers: "back again" };
export function downstreamOf(block, arch) {
  const ids = new Set((block?.paths ?? []).map((p) => p.id)), edges = arch?.edges ?? [];
  return (block?.downstream ?? []).map((d) => ({ ...d, card: d.node ?? edges[Number(/^e(\d+)$/.exec(d.edge ?? "")?.[1] ?? -1)]?.to ?? null,
    cases: (d.cases ?? []).map((c) => ({ ...c, path: ids.has(c.path) ? c.path : null })) }));
}
// What the map marks at a dependency on the chosen path: the cases that break on it ("✕ when slow, down") and the
// ones only partly handled ("~ when overloaded"); the card wraps them (views.js resMarkLines).
const downMarks = (id, downstream) => downstream.flatMap((d) => {
  const on = (h) => d.cases.filter((c) => c.path === id && c.handled === h).map((c) => WHEN_MARK[c.when] ?? c.when).join(", ");
  return d.card ? [on("no") && { at: d.card, mark: `✕ when ${on("no")}` }, on("partly") && { at: d.card, mark: `~ when ${on("partly")}` }].filter(Boolean) : [];
});
// The block of a run with its derived parts, at this.ai.resilience; null without one. head: today's head (older:
// the run looked at another one). findings: the findings file's (or merged) findings. A path whose findings were all
// there before this PR (introduced_here false: their lines stand unchanged in the base) is pre_existing and blocks
// nothing; when the base cannot tell for any of them (introduced_here null) and none is new, pre_existing is "unknown"
// and the blocker stays, marked unclear ("Blocker? old or new unclear").
export function withResilience(ai, block, head = null, findings = []) {
  if (!ai) return ai;
  if (!block || !Array.isArray(block.paths)) return { ...ai, resilience: null };
  const deps = block.deps ?? [], intro = new Map(findings.flatMap((f) => (f.ids ?? [f.id]).map((id) => [id, f.introduced_here ?? null])));
  // also_security: one of the path's findings is also a security finding (⛨, or found by the security run too).
  const sec = new Set(findings.filter((f) => f.security || (f.sources ?? []).some((x) => x.reviewer === "security")).flatMap((f) => f.ids ?? [f.id]));
  const downstream = downstreamOf(block, ai.arch);
  const paths = block.paths.map((raw) => {
    const reach = reachOf(raw, ai.arch), p = { ...raw, reach, ...viaOf(raw, ai.arch, reach) }, said = p.findings.map((id) => (intro.has(id) ? intro.get(id) : null));
    const pre = !said.length || said.includes(true) ? false : said.every((x) => x === false) ? true : "unknown";
    const ladder = ladderOf(p, deps), budget = budgetOf(p, deps), blocker = pre === true ? null : blockerOf(p, ladder, budget, block.effects ?? [], deps);
    return { ...p, reach: [...p.reach], ladder, budget, marks: [...marksOf(p, deps), ...downMarks(p.id, downstream)], pre_existing: pre, blocker: blocker && pre === "unknown" ? { ...blocker, unclear: true } : blocker,
      also_security: p.findings.some((id) => sec.has(id)) };
  });
  // Not possible today (C2 D3): the run says so (possible_today false), or the path leaves a part that delivers (a queue,
  // topic or stream) and does not work today (additions[].works_today false: nothing publishes to it). Its blocker
  // waits as wired {why, at, today}: "blocks once wired", not counted with the blockers; the path that is missing (nothing
  // publishes) still blocks.
  const edges = ai.arch?.edges ?? [], idle = new Map((block.additions ?? []).filter((a) => a.works_today === false && /queue|topic|stream|bus/i.test(`${a.kind} ${a.what}`))
    .flatMap((a) => [...reachOf({ steps: [a.at] }, ai.arch)].map((n) => [n, a])));
  for (const p of paths) {
    if (!p.blocker) continue;
    const part = p.via.map((e) => edges[Number(e.slice(1))]?.from).map((n) => idle.get(n)).find(Boolean);
    if (p.possible_today !== false && !part) continue;
    const why = p.possible_today === false && p.note ? p.note : part?.broken_by ? `not possible today: ${part.broken_by[0].toLowerCase()}${part.broken_by.slice(1).replace(/\.$/, "")}` : "not possible today";
    Object.assign(p, { wired: { ...p.blocker, today: why }, blocker: null });
  }
  // One cause blocks once: a blocking path with the reason of an earlier one and a finding or a call in common, or the
  // same action or the same place, is that path again (same_cause: its id; the first lists all in triggers): the missing
  // dead-letter queue behind p1 (a record raises) and p2 (the batch outlasts its timeout) is one blocker with two triggers.
  const spots = (p) => new Set([...p.findings, ...p.steps.filter((s) => deps.some((d) => d.edge === s || d.at === s))]);
  const act = (p) => String(p.action ?? "").trim().toLowerCase().replace(/[.\s]+$/, "");
  // the same unlimited redelivery: a poison message and a batch over its timeout both come back from one queue
  // The same for the blockers that wait until the path is wired (key "wired"), each among its own kind.
  for (const key of ["blocker", "wired"]) {
    const again = (p) => REDELIVERY.has(p[key].why) && p.ladder?.factors.find((f) => f.n === null)?.at;
    for (const [k, p] of paths.entries()) {
      const first = p[key] && paths.slice(0, k).find((q) => q[key] && !q.same_cause && ((q[key].why === p[key].why && [...spots(p)].some((x) => spots(q).has(x))) ||
        (act(p) && act(p) === act(q)) || (p[key].at && p[key].at === q[key].at) || (again(p) && again(p) === again(q))));
      if (first) { Object.assign(p, { [key]: null, same_cause: first.id }); first.triggers = [...(first.triggers ?? [first.id]), p.id]; }
    }
  }
  paths.sort((a, b) => Number(Boolean(b.blocker)) - Number(Boolean(a.blocker)) || Number(Boolean(b.wired)) - Number(Boolean(a.wired)));
  const blockers = paths.filter((p) => p.blocker), found = paths.filter((p) => p.result === "finding"), mitigated = paths.filter((p) => p.result === "mitigated");
  const na = paths.filter((p) => p.result === "not_assessed").length, checks = block.checks ?? [];
  const wired = paths.filter((p) => p.wired).length, tail = `${wired ? `; ${wired} ${wired === 1 ? "blocks" : "block"} once wired` : ""}${na ? `; ${na} not assessed` : ""}`;
  const summary = !paths.length ? "The run found no path a failure takes through this change."
    : blockers.length ? `${blockers.length} of ${plural(paths.length, "path")} ${blockers.length === 1 ? "blocks" : "block"} the merge: ${blockers[0].blocker.why}${blockers.length > 1 ? `, and ${blockers.length - 1} more` : ""}${tail}.`
      : found.length ? `${plural(found.length, "path")} with a finding, none blocks the merge${tail}.`
        : mitigated.length ? `Every assessed path is limited${mitigated[0].limited_by ? `, e.g. at ${mitigated[0].limited_by}` : ""}${tail}.` : `No path was assessed${tail}.`;
  // What nothing shows goes before the merge (unseen); what shows only without an alarm, and the queues' age, are
  // watched after it, once per resource.
  const spotsOf = (b) => (b.signal === "none" ? "unseen" : b.alarm === "none" || b.alarm === "unknown" ? "watch" : null);
  const unseen = [...new Set((block.blind_spots ?? []).filter((b) => spotsOf(b) === "unseen").map((b) => `${b.failure} (${b.at}): nothing shows it`))];
  const byPlace = new Map();
  for (const b of (block.blind_spots ?? []).filter((x) => spotsOf(x) === "watch")) byPlace.set(fileOf(b.at), `${b.failure} (${b.at}): seen as ${b.signal ?? "a signal"}, but nothing alarms on it`);
  for (const d of deps.filter((x) => x.mode === "async")) { const key = d.edge ?? d.node ?? fileOf(d.at); if (![...byPlace.keys()].includes(key)) byPlace.set(key, `the age of the oldest message at ${d.edge ?? d.node ?? d.at}`); }
  // What the code cannot tell about a dependency (a case not_checkable) is a question for after the merge, one line each.
  for (const d of downstream) {
    const open = d.cases.filter((c) => c.handled === "not_checkable"), why = [...new Set(open.map((c) => c.how.replace(/\.$/, "")).filter(Boolean))].join("; ");
    const whens = open.map((c) => WHEN_IS[c.when] ?? c.when).map((w, k, all) => (k && w.startsWith("is ") && all[0].startsWith("is ") ? w.slice(3) : w)); // "is slow or overloaded"
    if (open.length) byPlace.set(`dep:${d.dep}:${d.entry ?? ""}`, `${d.dep}${d.entry ? `, from ${d.entry},` : ""} ${whens.length > 1 ? `${whens.slice(0, -1).join(", ")} or ${whens.at(-1)}` : whens[0]} (${d.at || open[0].at || "no place"}): ${why || "the code cannot tell what happens"}`);
  }
  const watch = [...new Set(byPlace.values())];
  // The dependencies in a sentence: "2 dependencies, 10 cases: 4 not handled, 1 partly, 3 handled and 2 not checkable."; "" without any.
  const cases = downstream.flatMap((d) => d.cases), ch = (h) => cases.filter((c) => c.handled === h).length;
  const caseParts = [[ch("no"), "not handled"], [ch("partly"), "partly"], [ch("yes"), "handled"], [ch("not_checkable"), "not checkable"]].filter(([n]) => n).map(([n, w]) => `${n} ${w}`);
  const downstreamLine = downstream.length ? `${plural(downstream.length, "dependency", "dependencies")}, ${plural(cases.length, "case")}: ${caseParts.length > 1 ? `${caseParts.slice(0, -1).join(", ")} and ${caseParts.at(-1)}` : caseParts[0]}.` : "";
  // The parts the PR adds, weighed against their cost (additions): "This PR adds 4 parts: 2 justified, 1 questionable,
  // 1 solves nothing here."; "" without any.
  const adds = block.additions ?? [], by = (r) => adds.filter((a) => a.result === r).length;
  const addParts = [[by("justified"), "justified"], [by("questionable"), "questionable"], [by("unjustified"), "solves nothing here", "solve nothing here"]].filter(([n]) => n)
    .map(([n, one, many]) => `${n} ${n === 1 || !many ? one : many}`);
  const additionsLine = adds.length ? `This PR adds ${plural(adds.length, "part")}: ${addParts.length > 1 ? `${addParts.slice(0, -1).join(", ")} and ${addParts.at(-1)}` : addParts[0]}.` : "";
  // A run from before the prompt named the edges by id counted them itself, mostly from 1: its e<k> may point one call
  // off. Not safely correctable, so it is said (edgeNote) instead of guessed.
  const edgeNote = !block.edge_ids && (deps.some((d) => d.edge) || paths.some((p) => p.steps.some((s) => /^e\d+$/.test(s)))) ? "run predates edge ids: re-run" : null;
  return { ...ai, resilience: { ...block, paths, downstream, downstreamLine, blockers: blockers.map((p) => p.id), summary, watch, unseen, additionsLine, edgeNote, older: Boolean(block.head && head && block.head !== head),
    counts: { paths: paths.length, blockers: blockers.length, once_wired: wired, mitigated: mitigated.length, not_assessed: na,
      checks_clean: checks.filter((c) => c.result === "clean").length, not_checkable: checks.filter((c) => c.result === "not_checkable").length,
      additions: { justified: by("justified"), questionable: by("questionable"), unjustified: by("unjustified") } } } };
}

// Where a resilience run would start, counted from the diff without a model (files: splitPatch): queues, functions,
// public routes and retries the PR adds, with their lines; infra, async and concurrency for recommendModel.
const RES_SPOTS = {
  queue: /AWS::SQS::Queue|AWS::SNS::Topic|AWS::Kinesis::Stream|aws_sqs_queue|aws_sns_topic|createQueue\(|new\s+\w*Queue\(/,
  function: /AWS::Serverless::Function|AWS::Lambda::Function|aws_lambda_function|exports\.handler\s*=|^\s*def\s+(lambda_)?handler\(/,
  route: /Type:\s*(HttpApi|Api)\b|AWS::ApiGateway|aws_apigatewayv2_route|@\w+\.(route|get|post|put|patch|delete)\(|\brouter?\.(get|post|put|patch|delete)\(|rawPath"?\)?\s*==|\bpath\s*==\s*["']\//,
  retry: /\bretr(y|ies)\b|max_?attempts|backoff|tenacity|for\s+attempt\s+in|MaximumRetryAttempts|maxReceiveCount/i,
};
const RES_INFRA = /\.(tf|tfvars|hcl|bicep)$|(^|\/)(template|serverless|samconfig|docker-compose)[^/]*\.(ya?ml|json|toml)$|(^|\/)(k8s|helm|charts|terraform|infra|cdk)\//i;
const RES_ASYNC = /\.publish\(|send_message|sendMessage|\bsqs\b|\bsns\b|eventbridge|kafka/i;
const RES_CONC = /threading|ThreadPool|asyncio\.(gather|create_task)|Promise\.all|\bgo\s+func|\bLock\(|Semaphore/;
export function resilienceStart(files = []) {
  const spots = [];
  let infra = false, async = false, concurrency = false;
  for (const f of files) {
    if (RES_INFRA.test(f.path)) infra = true;
    for (const r of diffRows(f.lines ?? [])) {
      if (r.kind !== "+") continue;
      for (const [kind, rx] of Object.entries(RES_SPOTS)) if (rx.test(r.text)) spots.push({ file: f.path, line: r.number, kind });
      if (RES_ASYNC.test(r.text)) async = true;
      if (RES_CONC.test(r.text)) concurrency = true;
    }
  }
  const n = (k) => spots.filter((s) => s.kind === k).length, c = { queues: n("queue"), functions: n("function"), routes: n("route"), retries: n("retry") };
  const parts = [[c.queues, "queue"], [c.functions, "function"], [c.routes, "public route"], [c.retries, "retry", "retries"]].filter(([x]) => x > 0).map(([x, one, many]) => plural(x, one, many));
  const sentence = parts.length ? `This PR adds ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}.` : "This PR adds no queue, function, route or retry; the run reads the changed calls only.";
  return { ...c, spots, infra, async: async || c.queues > 0, concurrency, sentence };
}
// What a resilience run typically costs and takes, for runOffer before a first run: Sonnet measured on the demo PR #2
// (3 runs with effort high: $0.21-0.31, 89-94 s); Opus scaled by its output price and not measured (measured: false).
// Measured again with the dependencies' cases in the prompt (3 runs: $0.28, $0.28, $0.34; 92, 101, 127 s).
export const RUN_TYPICAL = { resilience: { sonnet: { usd: 0.30, s: 107, measured: true }, opus: { usd: 0.40, s: 160, measured: false } } };

// A rule that takes a right away or narrows it (an access row with effect "deny"; a security run from before that
// field wrote "deny …" as its actions): a guard at its resource, not a grant, a way in or a crossing.
export const isGuard = (x) => x?.effect === "deny" || ((x?.actions ?? []).length > 0 && x.actions.every((a) => /^\s*(deny|denies|block|blocks)\b/i.test(String(a))));

// The rules a security view is made under (reviewers.py RULES writes them into each view): 2 since guards, the
// operator's trust level and a taken-over role rated by the width of its grant. An older run stays readable; what it
// calls "not assessed" may be the older prompt's, so the page says so and offers the re-run (as edgeNote for Resilience).
export const SEC_RULES = 2;
export const secNote = (ai) => (ai?.securityFrom?.predates ? "run predates the current security rules: re-run" : null);
// A threat that only names a defect ("Not an attacker goal") is no assessment of a boundary.
export const isDefect = (t) => /not an attacker('s)? goal|no attacker|not exploitable|no abuse path|no abuse/i.test(`${t?.goal ?? ""} ${t?.note ?? ""}`);
// The reviewers' findings with the threats that stand on them (`threats`: ids), for a findings file whose security
// run did not write them yet: a named threat with result "finding" that cites the finding. The same array when
// nothing changes.
export function withThreats(findings, security) {
  const cites = new Map();
  for (const t of security?.threats ?? []) if (!t.derived && t.result === "finding" && !isDefect(t)) for (const id of t.findings ?? []) cites.set(id, [...(cites.get(id) ?? []), t.id]);
  return (findings ?? []).some((f) => !f.threats && cites.has(f.id)) ? findings.map((f) => (!f.threats && cites.has(f.id) ? { ...f, threats: cites.get(f.id) } : f)) : findings ?? [];
}
// Security by its own effect (access or data, or the older rule), apart from a threat that stands on it: a finding
// that is ⛨ only through a threat belongs to that threat's crossing, not to every way in that reaches its line.
export const secByEffect = (f) => (f?.threats?.length ? isSecurity({ ...f, threats: null }) : Boolean(f?.security ?? isSecurity(f ?? {})));
// Why a finding carries ⛨, for its tooltip: by its own effect ("Security: access or data."), because a threat stands
// on it ("Security: named by a threat (t3)."), or both. "" for a finding without ⛨.
// What follows from ⛨ (no "Fix several", the note about public comments, title only in the copied state, no place in
// the blockers draft) follows from the effect alone (secByEffect): a flood a threat stands on is fixed and discussed
// like any other finding.
export const secWhy = (f) => { const ts = f?.threats ?? [], named = ts.length ? `named by a threat (${ts.join(", ")})` : "";
  return secByEffect(f) ? `Security: access or data${named ? `; also ${named}` : ""}.` : named ? `Security: ${named}.` : ""; };

// A security run made under older rules (secNote), as the sentence of the Security page and its Markdown: what it means,
// the offer, and how many of the unresolved security causes (taskList's `security`) it touches: the ones that carry ⛨
// only through a threat this run named, not through their own effect (secByEffect). null for a current run.
export function secOldLine(ai, sec = []) {
  if (!ai?.securityFrom?.predates) return null;
  const hit = sec.filter((f) => !secByEffect(f)).length, n = sec.length;
  return `This security review is older than the current rules for guards, operators and taken-over roles, so a crossing it calls not assessed may only be left open by the old prompt. Re-run it for the current view.${
    !n ? "" : !hit ? ` None of the ${n === 1 ? "one security cause" : `${n} security causes`} hangs on a threat of this run.` : ` ${hit} of the ${n} security ${n === 1 ? "cause" : "causes"} ${hit === 1 ? "carries" : "carry"} ⛨ only through a threat this run named, so the count may change.`}`;
}

// What the cached files know of a PR, for the panel's marks (views.js riskSignal, fileRisk; acceptance, engineer 4): the
// analysis mapped, and the findings file's findings with the threats that stand on them (withThreats), as the review
// loads them. So ⛨ (isSecurity) has one source: a file's mark in the panel is the review's.
// an: the analysis file ({answer}); fd: the findings file ({findings, status, security}). Either may be null.
export const knownOf = (an, fd) => ({ analysis: an?.answer ? mapReview(an.answer, []) : null, findings: fd ? withThreats(fd.findings ?? [], fd.security) : null, status: fd?.status ?? null });
