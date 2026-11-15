// Run: node test_ghmd.mjs  (GitHub comment bodies as the review shows them: views.js ghMd, and their height mdHeight)
// node test_ghmd.mjs --write <file>: the bodies below as GitHub comments ({id, path, line, side, user, body, at}) for
// a test home. Every name, rule, id and link in them is made up; only their structure follows a scanner bot's
// comments as GitHub sends them (a badge picture, <details>, <br> lines, fences, HTML comments).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

const HB = "  "; // two spaces at a line's end: a hard break (an editor strips them from the source, so they are spelt out)
const badge = (sev) => `<a><picture><source media="(prefers-color-scheme: dark)" srcset="https://assets.example.com/tags/${sev}_dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://assets.example.com/tags/${sev}_light.svg"><img align="top" valign="top" alt="${sev[0].toUpperCase() + sev.slice(1)}" title="${sev[0].toUpperCase() + sev.slice(1)}" src="https://assets.example.com/tags/${sev}_light.svg"></picture></a>`;

// A bot's finding with Expected/Found blocks inside <details>, a <br> right after <summary>, lines ending in two
// spaces, a fence closed right before the next paragraph, a quote, two links, HTML comments at the end.
export const BOT_FOUND = `${badge("medium")}&ensp;IaC Finding

**\`Queue should name a dead-letter target\`**<br>on resource \`aws_sqs_queue[jobs]\`

<details>
<summary>More Details</summary>
<br>
This rule checks whether a queue sends failed messages somewhere.${HB}
This rule fails if \`RedrivePolicy\` is \`null\`.${HB}
A message that fails again and again stays in the queue until it expires, and nobody sees it fail.${HB}
It is recommended to name a dead-letter queue.
<br>
<br>

**Expected**

\`\`\`
Attribute 'redrive_policy' should be set
\`\`\`
**Found**

\`\`\`
Attribute 'redrive_policy' is undefined
\`\`\`
**Security Frameworks**: fw-7, fw-12, 86fa8f0c-a7d9-496c-823c-88d845cc16bb

<br>

> Rule ID: 2ad17513-02ed-4cca-a6db-f170be124870
<br>

To ignore this finding as an exception, reply to this conversation with \`#scan_ignore reason\`


If you'd like to ignore this finding in all future scans, add an exception in the .scan file ([learn more](https://docs.example.com/exceptions#file)) or create an Ignore Rule ([learn more](https://docs.example.com/exceptions#rules)).
</details>
<br>

To get more details on how to fix this with AI, reply to this conversation with \`#scan fix\`


<!-- Scan-b975351a-4adf-4104-8a54-b083a550c56d-Annotation -->

<!-- Rule-IaC-8fd147bc-d4c7-4edd-a40a-348230d274a3 -->`;

// The same bot with a matched rule in quotes, an emoji summary in <strong>, and a suggestion block after </details>.
export const BOT_SUGGEST = `${badge("high")}&ensp;IaC Finding

Matched configuration rule "**Function URL should not allow calls without auth**"  [**Fn-002**].


<details>
<summary><strong>📝 Description</strong></summary>
<br>

This rule checks whether a function is reachable through its URL without auth. The rule fails if the URL's auth type is 'NONE'.
<br>

> Rule ID: bd902d3c-a73f-45b0-ae98-18ab8d39ca62

<br>

To ignore this finding as an exception, reply to this conversation with \`#scan_ignore reason\`

</details>


\`\`\`suggestion
  authorization_type = "AWS_IAM"
\`\`\`

<!-- Scan-b975351a-4adf-4104-8a54-b083a550c56d-Remediation -->`;

// What else GitHub renders in a comment: an HTML table, a Markdown table, a heading in a quote, nested lists, a link
// with a title, sub and sup, kbd, pre, an image with and without alt, an unknown tag.
export const KITCHEN = `<h3>Summary <sub>(made up)</sub></h3>
<p>Two <b>bold</b> and <i>slanted</i> words, H<sub>2</sub>O and x<sup>2</sup>, press <kbd>Ctrl</kbd>+<kbd>C</kbd>.</p>

<table>
<tr><th>Check</th><th>Result</th></tr>
<tr><td>lint</td><td>✅ passed</td></tr>
<tr><td>tests</td><td>❌ 2 failed</td></tr>
</table>

| File | Lines |
| --- | ---: |
| \`a.py\` | 12 |
| \`b.py\` | 3 |

> ## A heading in a quote
> and its text

- one
  - one.a
  - one.b
- two

See [the guide](https://docs.example.com/guide "The guide's title").<br/>Next line after a br.

<pre>raw pre
  keeps its spaces</pre>

<img src="https://assets.example.com/chart.png" alt="Coverage chart"> <img src="https://assets.example.com/x.png">

<custom-thing data-x="1">text in an unknown tag</custom-thing>`;

export const FIXTURE = [
  { id: 9001, path: "library/handler.py", line: 3, side: "RIGHT", user: "scanner[bot]", user_type: "Bot", body: BOT_FOUND, at: "2026-11-13T09:00:00Z" },
  { id: 9002, path: "library/handler.py", line: 8, side: "RIGHT", user: "scanner[bot]", user_type: "Bot", body: BOT_SUGGEST, at: "2026-11-13T09:00:00Z" },
  { id: 9003, path: "library/handler.py", line: 11, side: "RIGHT", user: "octo-reviewer", user_type: "User", body: KITCHEN, at: "2026-11-13T10:00:00Z" },
];
const w = process.argv.indexOf("--write");
if (w > 0) { writeFileSync(process.argv[w + 1], JSON.stringify(FIXTURE, null, 1)); process.exit(0); }
const { ghMd, mdHeight } = await import("./views.js");
const { mdBlocks, MD, wrapCount } = await import("./views.js");

// ---- ghMd: what GitHub renders, as Markdown
const found = ghMd(BOT_FOUND), open = ghMd(BOT_FOUND, true);
assert.ok(!/<|&ensp;|-->|Scan-|Rule-IaC/.test(found), "no tag, entity or HTML comment is left");
assert.ok(found.startsWith("`Medium` IaC Finding"), "the badge picture is its alt text as a chip");
assert.match(found, /\*\*`Queue should name a dead-letter target`\*\* {2}\non resource/, "an inline <br> is a hard break");
assert.match(found, /\*\*▸ More Details\*\*/, "<details> folds to its summary, as on GitHub");
assert.ok(!found.includes("Expected") && found.includes("#scan fix"), "folded: its content is gone, what follows it stays");
assert.match(open, /\*\*▾ More Details\*\*/);
assert.match(open, /somewhere\. {2}\nThis rule fails/, "hard breaks inside stay");
assert.match(open, /\*\*Expected\*\*\n\n```\nAttribute 'redrive_policy' should be set\n```\n\*\*Found\*\*/, "fences stay as they are");
assert.match(open, /\[learn more\]\(https:\/\/docs\.example\.com\/exceptions#file\)/);
assert.ok(!/\n{3,}/.test(open), "at most one blank line between blocks");
const sug = ghMd(BOT_SUGGEST, true);
assert.match(sug, /\*\*▾ 📝 Description\*\*/, "a summary's own tags go");
assert.match(sug, /```suggestion\n {2}authorization_type = "AWS_IAM"\n```/);
const k = ghMd(KITCHEN);
assert.match(k, /^### Summary \(made up\)/, "an HTML heading");
assert.match(k, /Two \*\*bold\*\* and \*slanted\* words, H2O and x2, press `Ctrl`\+`C`\./, "inline tags; sub and sup keep their text");
assert.match(k, /\| Check \| Result \|\n\| --- \| --- \|\n\| lint \| ✅ passed \|\n\| tests \| ❌ 2 failed \|/, "an HTML table is a Markdown table");
assert.match(k, /\[the guide\]\(https:\/\/docs\.example\.com\/guide\)\.  \nNext line/, "a link's title goes; <br/> breaks the line");
assert.match(k, /```\nraw pre\n {2}keeps its spaces\n```/, "<pre> is a fence and keeps its spaces");
assert.match(k, /\[🖼 Coverage chart\]\(https:\/\/assets\.example\.com\/chart\.png\) \[🖼 image\]/, "an image is a link to it");
assert.match(k, /\ntext in an unknown tag$/, "an unknown element goes, its text stays");
assert.equal(ghMd("Use `<br>` and `Vec<T>` here"), "Use `<br>` and `Vec<T>` here", "code and a type are no tags");
assert.equal(ghMd("```html\n<details><summary>x</summary></details>\n```"), "```html\n<details><summary>x</summary></details>\n```", "nothing inside a fence changes");
assert.equal(ghMd("a &lt;b&gt; &amp; &#x41;&#66;"), "a <b> & AB");
assert.equal(ghMd("<details><summary>Outer</summary>\n<details><summary>Inner</summary>x</details>\n</details>", true), "**▾ Outer**\n\n**▾ Inner**\n\nx");
assert.equal(ghMd("ok <!-- unclosed"), "ok");
assert.equal(ghMd(null), "");

// ---- mdBlocks: fences out of the Markdown
assert.deepEqual(mdBlocks("a\n\n```py\nx = 1\n```\nb"), [{ text: "a" }, { code: ["x = 1"], lang: "py" }, { text: "b" }]);
assert.deepEqual(mdBlocks("```\nopen to the end"), [{ code: ["open to the end"], lang: "" }]);
assert.deepEqual(mdBlocks(""), []);
assert.deepEqual(mdBlocks(open).filter((b) => b.code).map((b) => b.code[0]), ["Attribute 'redrive_policy' should be set", "Attribute 'redrive_policy' is undefined"]);

// ---- mdHeight: as TextView lays it out (measured at 13.5 px)
assert.equal(mdHeight("one\ntwo\nthree", 900), 21, "soft breaks join one paragraph, as TextView joins them");
assert.equal(mdHeight("one  \ntwo  \nthree", 900), 3 * 21, "hard breaks keep their lines");
assert.equal(mdHeight("See [the guide](https://docs.example.com/" + "x".repeat(300) + ").", 600), 21, "a link counts its text, not its address");
assert.equal(mdHeight("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |", 600), 3 * (21 + MD.ROW_PAD), "a table: a row per line, the --- line takes no room");
assert.equal(mdHeight("> Rule ID: x", 600), 21, "a quote: its text");
assert.ok(mdHeight("> ## Head\n> text", 600) > mdHeight("> text", 600), "a heading in a quote counts as a heading");
assert.ok(mdHeight("# A", 600) > mdHeight("### A", 600), "a smaller heading takes less room");
// The bot's folded comment was over 40 lines high with its raw HTML counted; as Markdown it is a few.
assert.ok(mdHeight(BOT_FOUND, 900) > 2 * mdHeight(found, 900));
console.log("ghmd ok");
