// Setup: which programs pr-review uses, what each enables, how to install it. Pure (setup-view.js runs the checks).
// A mod can't install programs: Setup only shows the command, and "Install in terminal" pre-types it for you.

// need: required (the panel can't work without it), optional (one feature), lsp (go-to-definition, hover and the
// Architecture page's Impact picture for a language; impact: false where Impact does not use it: Terraform is
// "Infrastructure changes", read without a server).
// also: more programs the same item needs. auth: how to log in, when the check says logged out. os: the one system
// the program is for (bwrap; macOS has sandbox-exec built in). A minimum version and what happens below it stand in
// `what`. ponytail: Setup does not compare versions; the feature that needs one says so when it starts (review.js
// pushLock, the Codex run's own error). Add a version check here when people run into it.
export const TOOLS = [
  { id: "git", need: "required", what: "Diffs, checkouts and review worktrees. From 2.46 on, fix and verify agents cannot push even where a remote has a push URL of its own; with an older git they do not start in such a clone.",
    mac: "brew install git", linux: "sudo apt install git" },
  { id: "gh", need: "required", what: "PR lists, diffs, CI checks and clones (GitHub CLI)", mac: "brew install gh", linux: "sudo apt install gh", auth: "gh auth login" },
  { id: "claude", need: "required", what: "The AI analysis, reviewers, triage and fix verification (Claude Code CLI)",
    mac: "npm install -g @anthropic-ai/claude-code", linux: "npm install -g @anthropic-ai/claude-code", auth: "claude auth login" },
  { id: "python3", need: "required", what: "The helper scripts (analysis, clones, language-server bridge)", mac: "brew install python", linux: "sudo apt install python3" },
  { id: "codex", need: "optional", what: "Codex review (a second reviewer). It runs with a permission profile that reads only the PR checkout (checked with Codex 0.164); a Codex without permission profiles fails the run instead of reading more.",
    mac: "npm install -g @openai/codex", linux: "npm install -g @openai/codex" },
  { id: "bwrap", need: "optional", os: "linux", what: "The sandbox for probes on Linux (bubblewrap). Without it every probe asks first and its script runs with no sandbox: it can read and change your files and reach the network.",
    mac: null, linux: "sudo apt install bubblewrap" },
  { id: "acli", need: "optional", what: "The Jira ticket a PR names, in the task check (Atlassian CLI)",
    mac: "brew tap atlassian/homebrew-acli && brew install acli", linux: null },
  // Editors for "Open in <Editor>" (editor.js): one is enough. apps: the macOS applications that count as installed
  // without the command line tool (the links open through the app, not through the tool).
  { id: "code", need: "optional", apps: ["Visual Studio Code"], what: "Open in VS Code: a file of a PR's checkout at its line, a definition, a card's place in the code, the checkout itself.",
    mac: "brew install --cask visual-studio-code", linux: "sudo snap install code --classic" },
  { id: "idea", need: "optional", apps: ["IntelliJ IDEA", "IntelliJ IDEA Ultimate", "IntelliJ IDEA CE", "IntelliJ IDEA Community Edition"], what: "Open in IntelliJ IDEA: the default for Java, Kotlin and Gradle files and for Maven and Gradle projects.",
    mac: "brew install --cask intellij-idea-ce", linux: "sudo snap install intellij-idea-community --classic" },
  { id: "typescript-language-server", also: ["tsc"], need: "lsp", lang: "TypeScript and JavaScript",
    mac: "npm install -g typescript-language-server typescript", linux: "npm install -g typescript-language-server typescript" },
  { id: "pyright-langserver", need: "lsp", lang: "Python", mac: "npm install -g pyright", linux: "npm install -g pyright" },
  { id: "gopls", need: "lsp", lang: "Go", mac: "brew install gopls", linux: "go install golang.org/x/tools/gopls@latest" },
  { id: "rust-analyzer", need: "lsp", lang: "Rust", mac: "rustup component add rust-analyzer", linux: "rustup component add rust-analyzer" },
  { id: "jdtls", need: "lsp", lang: "Java", mac: "brew install jdtls", linux: null },
  { id: "terraform-ls", need: "lsp", lang: "Terraform", impact: false, mac: "brew install hashicorp/tap/terraform-ls", linux: null },
  { id: "clangd", need: "lsp", lang: "C and C++", mac: "xcode-select --install", linux: "sudo apt install clangd" },
];

// Every program name to look up on PATH.
export const programs = () => [...new Set(TOOLS.flatMap((t) => [t.id, ...(t.also ?? [])]))];

// The shell script that prints `name=path` per program (empty: missing) and `auth:gh=0|1`, `auth:claude=0|1`.
// extra: folders language servers often live in, the same ones lsp_bridge.py adds to PATH.
export function checkScript(names = programs()) {
  return [
    'PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.cargo/bin:$HOME/go/bin:$HOME/.local/bin"',
    `for c in ${names.join(" ")}; do printf '%s=%s\\n' "$c" "$(command -v "$c" 2>/dev/null)"; done`,
    // An editor's macOS app counts as that editor: a later line for the same name wins in parseCheck.
    ...TOOLS.filter((t) => t.apps && names.includes(t.id)).map((t) => `for a in ${t.apps.map((a) => `"${a}"`).join(" ")}; do for d in /Applications "$HOME/Applications"; do [ -d "$d/$a.app" ] && printf '%s=%s\\n' ${t.id} "$d/$a.app"; done; done`),
    'if command -v gh >/dev/null 2>&1; then gh auth status >/dev/null 2>&1 && echo auth:gh=1 || echo auth:gh=0; fi',
    'if command -v claude >/dev/null 2>&1; then claude auth status 2>/dev/null | grep -q \'"loggedIn": *true\' && echo auth:claude=1 || echo auth:claude=0; fi',
  ].join("\n");
}

// The script's output as {found: {name: path|null}, auth: {gh: bool, claude: bool}}.
export function parseCheck(text) {
  const found = {}, auth = {};
  for (const line of String(text ?? "").split("\n")) {
    const m = /^(auth:)?([\w.-]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[1]) auth[m[2]] = m[3] === "1";
    else found[m[2]] = m[3] || null;
  }
  return { found, auth };
}

// One row per tool: status ok | missing (required) | optional-missing | logged-out, what it enables, the install
// command for this OS ("darwin" or "linux"; null when there is no simple one).
export function report({ found = {}, auth = {} } = {}, os = "darwin") {
  return TOOLS.filter((t) => !t.os || t.os === os).map((t) => {
    const have = [t.id, ...(t.also ?? [])].every((n) => Boolean(found[n]));
    const loggedOut = have && t.auth && auth[t.id] === false;
    const status = !have ? (t.need === "required" ? "missing" : "optional-missing") : loggedOut ? "logged-out" : "ok";
    const what = t.need === "lsp" ? `${t.impact === false ? "Go to definition" : "Go to definition and Impact"} in ${t.lang} ${t.impact === false && !t.also ? "needs" : "need"} ${[t.id, ...(t.also ?? [])].join(" + ")}` : t.what;
    const install = status === "logged-out" ? t.auth : status === "ok" ? null : (os === "linux" ? t.linux : t.mac) ?? null;
    return { id: t.id, need: t.need, status, what, install, path: found[t.id] ?? null };
  });
}

// The bridge's "<program> is not installed" (lsp_bridge.py) with how to get it: the language it is for and this OS's
// install command from the list above, or where the list is. Any other message comes back as it is.
export function installHint(message, os = "darwin") {
  const name = /^(\S+) is not installed$/.exec(String(message ?? ""))?.[1], t = name && TOOLS.find((x) => x.id === name || (x.also ?? []).includes(name));
  if (!t) return message;
  const cmd = os === "linux" ? t.linux : t.mac;
  return `${name} is not installed${t.lang ? ` (the language server for ${t.lang})` : ""}. ${cmd ? `Install it with \`${cmd}\`; the panel's Setup (PRs ▾ → Setup) offers the same command.` : "The panel's Setup (PRs ▾ → Setup) lists it; there is no one-line install for this system."}`;
}

// Required tools missing or logged out: what the PR panel's banner names.
export const blockers = (rows) => rows.filter((r) => r.need === "required" && r.status !== "ok");

// Whether a program was found (e.g. codex): false until a check ran.
export const found = (check, name) => Boolean(check?.found?.[name]);

// The terminal command that shows `cmd` pre-typed at a prompt, run only when the person presses Enter: zsh's vared,
// else bash's read -e -i. Never runs anything by itself.
export function pretypeArgv(cmd) {
  const script = 'if command -v zsh >/dev/null 2>&1; then exec zsh -c \'c=$1; vared -p "$ " c && eval "$c"\' zsh "$1"; '
    + 'else exec bash -c \'read -e -i "$1" -p "$ " c && eval "$c"\' bash "$1"; fi';
  return ["sh", "-c", script, "sh", cmd];
}
