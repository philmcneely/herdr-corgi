// Run: node test_infra.mjs  ("Infrastructure changes": a file before the PR from its patch, the Terraform and the
// CloudFormation reader, the difference, references, what is never written out, the picture and its Markdown)
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { baseText, sidesOf, readTerraform, readCloudFormation, infraModel, infraArch, infraMarks, infraPicture, infraMd, infraSource, infraSummary, cardLines, rowText, noticeText, isIac, INFRA_MAX } from "./infra.js";
import { splitPatch } from "./pr.js";
import { mermaidFlow } from "./markdown.js";
import { archLayout, archBest } from "./arch.js";

// A changed file as the patch has it, here as one hunk without context.
const file = (path, base, head) => ({ path, status: base === null ? "added" : head === null ? "deleted" : "modified", head: head ?? undefined,
  lines: ["--- a", "+++ b", `@@ -1,${(base ?? "").split("\n").length} +1,${(head ?? "").split("\n").length} @@`, ...(base ?? "").split("\n").filter(() => base !== null).map((l) => `-${l}`), ...(head ?? "").split("\n").filter(() => head !== null).map((l) => `+${l}`)] });
const model = (changes, others = {}) => infraModel(Object.entries(changes).map(([p, [b, h]]) => file(p, b, h)), Object.entries(others).map(([path, text]) => ({ path, text })));
const card = (m, addr) => m.cards.find((c) => c.addr === addr), texts = (c) => cardLines(c).map((l) => l.text);
const table = (head, rows) => [`| ${head.join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`), ""];

test("the file before the PR is its head with the patch applied backwards", () => {
  const head = "a\nB\nc\nd\nnew\ne\n";
  assert.equal(baseText(head, ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,4 +1,3 @@", " a", "-b", "-gone", "+B", " c", "@@ -5,1 +4,2 @@ d", " d", "+new", "\\ No newline at end of file"]), "a\nb\ngone\nc\nd\ne\n");
  assert.equal(baseText("a\nc", ["@@ -2,1 +1,0 @@", "-b"]), "a\nb\nc", "a hunk that only removes sits after the line it names");
  assert.equal(baseText("a\nX\nc", ["@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"]), null, "a patch for another text is not applied");
  assert.equal(baseText("--- x\nb", ["--- a/f", "+++ b/f", "@@ -1,2 +1,2 @@", "---- x", "+--- x", " b"]), "--- x\nb".replace("--- x", "--- x"), "a removed line that looks like a header is a line");
  assert.deepEqual(sidesOf({ status: "added", lines: ["@@ -0,0 +1,2 @@", "+a", "+b"] }), { head: "a\nb", base: null });
  assert.deepEqual(sidesOf({ status: "deleted", lines: ["@@ -1,2 +0,0 @@", "-a", "-b"] }), { head: null, base: "a\nb" });
  assert.equal(sidesOf({ status: "modified", lines: ["@@ -1 +1 @@", "-a", "+b"] }), null, "a modified file needs its text at the head");
  assert.ok(isIac("a/main.tf") && isIac("prod.tfvars") && isIac("template.yaml") && isIac("stack.json") && !isIac("handler.py"));
});

test("Terraform: blocks, arguments and nested blocks, past strings, heredocs and comments", () => {
  const r = readTerraform(`# a comment with a brace {
resource "aws_lambda_function" "api" { // and one here }
  function_name = "shop-\${var.env}-api"   # trailing }
  tags = {
    Note = "a } in a string and an \\"escaped\\" quote"
    Team = var.tags["team"]
  }
  /* a block comment
     with a } */
  policy = <<-EOT
    { "Statement": [ { "Resource": "\${aws_sqs_queue.jobs.arn}" } ]
    # not a comment, and an unbalanced {
  EOT
  environment {
    variables = { URL = "\${aws_sqs_queue.jobs.url}/x" }
  }
  ingress { from_port = 1 }
  ingress { from_port = 2 }
  lifecycle { ignore_changes = [tags] }
}
variable "env" { default = "dev" }
locals {
  prefix = "shop"
  names  = [for n in var.list : upper(n)]
}
`, "main.tf");
  assert.ok(r.ok);
  const fn = r.items[0], arg = (n) => fn.args.get(n);
  assert.deepEqual([fn.addr, fn.kind, fn.type, fn.name, fn.line, fn.end, fn.ok], ["aws_lambda_function.api", "resource", "aws_lambda_function", "api", 2, 20, true]);
  assert.deepEqual([...fn.args.keys()], ["function_name", "tags", "policy", "environment", "ingress", "lifecycle"]);
  assert.equal(arg("function_name").text, '"shop-${var.env}-api"', "without its trailing comment");
  assert.equal(arg("tags").text, '{ Note = "a } in a string and an \\"escaped\\" quote" Team = var.tags["team"] }', "several lines are one, indentation aside");
  assert.match(arg("policy").text, /^<<-EOT\n {4}\{ "Statement".*\n {4}# not a comment, and an unbalanced \{\n {2}EOT$/, "a heredoc counts as written");
  assert.deepEqual([arg("ingress").block, arg("environment").block, arg("policy").block], [2, 1, undefined], "nested blocks of one head are one argument with their number");
  assert.deepEqual(r.items.slice(1).map((e) => [e.addr, e.kind, e.args.get("default")?.text ?? e.args.get("value").text]), [["var.env", "variable", '"dev"'], ["local.prefix", "local", '"shop"'], ["local.names", "local", "[for n in var.list : upper(n)]"]]);
});

test("Terraform: what the reader does not understand is said, not guessed", () => {
  assert.equal(readTerraform('resource "a_b" "c" {\n  x = "never closed\n}\n', "m.tf").ok, false, "a string that does not close: the file is not understood");
  assert.equal(readTerraform('resource "a_b" "c" {\n  x = 1\n', "m.tf").ok, false, "a block that does not close: the file is not understood");
  assert.equal(readTerraform("resource \"a_b\" \"c\" {\n  x = 1\n}\nstray words here\n", "m.tf").ok, false);
  const m = model({ "m.tf": ['resource "a_b" "c" {\n  x = 1\n}\n', 'resource "a_b" "c" {\n  x = 2\n'] });
  assert.deepEqual([m.cards.length, m.unread], [0, [{ path: "m.tf", why: "the reader does not understand a part of it" }]], "such a file is named, and nothing of it is a card");
  const n = model({ "m.tf": ['resource "a_b" "c" {\n  x = 1\n  y ? z\n}\n', 'resource "a_b" "c" {\n  x = 2\n  y ? z\n}\n'] });
  assert.deepEqual([card(n, "a_b.c").status, texts(card(n, "a_b.c"))], ["changed", ["Changed; this block is not read in detail"]], "a block with a line that is no argument: changed, without details");
  const u = infraModel([{ path: "m.tf", status: "modified", lines: ["@@ -1 +1 @@", "-a", "+b"] }]);
  assert.deepEqual([u.unread, infraSource(u)], [[{ path: "m.tf", why: "the file at the PR head is not loaded" }], "Derived from the diff; no terraform plan was run, so replacements and computed values are estimates."], "without a checkout a modified file is named as not read");
});

test("Terraform: added, changed, removed, and only a known argument makes it 'may be replaced'", () => {
  const base = `resource "aws_sqs_queue" "jobs" {
  name                       = "jobs"
  visibility_timeout_seconds = 30
}
resource "aws_lambda_function" "api" {
  function_name = "api"
  timeout       = 10 # seconds
  memory_size   = 128
}
resource "aws_s3_bucket" "old" {
  bucket = "old"
}
resource "aws_iam_role" "same" {
  name = "same"
}
resource "aws_instance" "one" {
  ami = "ami-1"
}
`, head = `resource "aws_sqs_queue" "jobs" {
  name                       = "jobs-v2"
  visibility_timeout_seconds = 30
}
resource "aws_lambda_function" "api" {
  function_name = "api"
  timeout = 30   // longer
  memory_size   = 128
  layers        = [aws_lambda_layer_version.deps.arn]
}
# a comment between
resource "aws_iam_role" "same" {
    name = "same"   # only spacing and a comment changed
}
resource "aws_instance" "one" {
  count = 2
  ami   = "ami-1"
}
resource "aws_lambda_layer_version" "deps" {
  layer_name = "deps"
}
`;
  const m = model({ "infra/main.tf": [base, head] });
  assert.deepEqual(m.cards.map((c) => [c.addr, c.status]), [["aws_sqs_queue.jobs", "replaced"], ["aws_lambda_function.api", "changed"], ["aws_instance.one", "replaced"], ["aws_lambda_layer_version.deps", "added"], ["aws_s3_bucket.old", "removed"]].sort((a, b) => m.cards.findIndex((c) => c.addr === a[0]) - m.cards.findIndex((c) => c.addr === b[0])));
  assert.equal(card(m, "aws_iam_role.same"), undefined, "spacing and comments are no change, and an unchanged resource alone is no card");
  assert.deepEqual(texts(card(m, "aws_sqs_queue.jobs")), ["A changed name usually forces a new resource", 'name: "jobs" → "jobs-v2"']);
  assert.deepEqual(texts(card(m, "aws_lambda_function.api")), ["timeout: 10 → 30", "layers: added ([aws_lambda_layer_version.deps.arn])"]);
  assert.deepEqual(texts(card(m, "aws_instance.one")), ["Its address changes with count, which usually replaces it", "count: added (2)"]);
  assert.deepEqual([card(m, "aws_lambda_function.api").file, card(m, "aws_lambda_function.api").line, cardLines(card(m, "aws_lambda_function.api"))[0].at], ["infra/main.tf", 5, "infra/main.tf:7"], "a card and each changed argument know their line at the head");
  assert.equal(card(m, "aws_s3_bucket.old").line, 10, "a removed resource has its line before the PR");
  assert.deepEqual(m.edges, [{ from: "tf:infra|aws_lambda_function.api", to: "tf:infra|aws_lambda_layer_version.deps", label: "layers", status: "unchanged" }]);
  assert.deepEqual([m.counts, m.total, m.groups], [{ added: 1, changed: 1, replaced: 2, removed: 1 }, 5, [{ id: "tf:infra", label: "infra", kind: "Terraform" }]]);
  assert.equal(infraSummary(m), "5 resources: 1 added, 1 changed, 2 may be replaced, 1 removed.");
  assert.equal(infraSource(m), "Derived from the diff; no terraform plan was run, so replacements and computed values are estimates.");
  // A changed count is no replacement, and a module's name is no resource name.
  const k = model({ "main.tf": ['resource "aws_instance" "one" {\n  count = 2\n}\nmodule "net" {\n  source = "./net"\n  name = "a"\n}\n', 'resource "aws_instance" "one" {\n  count = 3\n}\nmodule "net" {\n  source = "./net"\n  name = "b"\n}\n'] });
  assert.deepEqual(k.cards.map((c) => [c.addr, c.status, c.group]), [["aws_instance.one", "changed", "tf:"], ["module.net", "changed", "tf:"]]);
  assert.equal(k.groups[0].label, "Repository root");
});

test("a value that looks like a secret is never written out", () => {
  const key = ["sec", "ret"].join(""); // put together, so no scanner takes this test for a leak
  const m = model({ "db.tf": [`resource "aws_db_instance" "main" {\n  password = "one-${key}"\n  username = "app"\n  kms_key_id = "k1"\n  note = "old"\n  tags = { Api${key} = "x" }\n}\n`,
    `resource "aws_db_instance" "main" {\n  password = "two-${key}"\n  username = "app2"\n  kms_key_id = "k2"\n  note = "the token is abc"\n  tags = { Api${key} = "y" }\n  auth_token = "t"\n}\n`] });
  assert.deepEqual(texts(card(m, "aws_db_instance.main")), ["password: changed", 'username: "app" → "app2"', "kms_key_id: changed", "note: changed", "and 2 more"]);
  const all = card(m, "aws_db_instance.main").changes.map((c) => c.text).join(" | "), md = infraMd(m, { table, flow: mermaidFlow }).join("\n");
  assert.equal(all, 'password: changed | username: "app" → "app2" | kms_key_id: changed | note: changed | tags: changed | auth_token: added');
  for (const hidden of [`one-${key}`, `two-${key}`, "k2", "abc", '"t"']) assert.ok(!md.includes(hidden), `${hidden} is not in the text`);
});

test("references: in code and templates, not in what a string says", () => {
  const head = `resource "aws_lambda_function" "api" {
  role       = aws_iam_role.api.arn
  name_like  = "my_app.settings and aws_iam_role.fake.arn"
  url        = "https://\${aws_sqs_queue.jobs.id}/\${var.stage}"
  script     = <<EOT
    echo \${local.prefix} plain_text.here
  EOT
  for_each   = aws_s3_bucket.sites
  depends_on = [module.net, data.aws_caller_identity.me]
  rule { each_value = each.value.some_thing.id }
}
resource "aws_iam_role" "api" {}
resource "aws_iam_role" "fake" {}
resource "aws_sqs_queue" "jobs" {}
resource "aws_s3_bucket" "sites" {}
resource "plain_text" "here" {}
resource "some_thing" "id" {}
data "aws_caller_identity" "me" {}
module "net" { source = "./net" }
variable "stage" {}
locals { prefix = "p" }
`;
  const m = model({ "main.tf": [null, head] }), api = card(m, "aws_lambda_function.api");
  assert.deepEqual(api.deps, ["aws_iam_role.api", "aws_sqs_queue.jobs", "aws_s3_bucket.sites", "module.net", "data.aws_caller_identity.me"]);
  assert.deepEqual(m.edges.filter((e) => e.from === api.id).map((e) => [e.to.split("|")[1], e.label, e.status]), [["aws_iam_role.api", "role", "new"], ["aws_sqs_queue.jobs", "url", "new"], ["aws_s3_bucket.sites", "for_each", "new"], ["module.net", "depends_on", "new"], ["data.aws_caller_identity.me", "depends_on", "new"]]);
  assert.deepEqual(m.rows, [], "a new stack's own variables and locals are no rows");
});

test("a removed resource that is still referenced is marked, also from a file the PR does not touch", () => {
  const others = { "stack/alarms.tf": 'resource "aws_cloudwatch_metric_alarm" "depth" {\n  dimensions = { QueueName = aws_sqs_queue.dlq.name }\n}\nresource "aws_sns_topic" "far" {\n  name = "far"\n}\n', "other/x.tf": 'resource "aws_sns_topic" "elsewhere" {\n  name = aws_sqs_queue.dlq.name\n}\n' };
  const m = model({ "stack/queue.tf": ['resource "aws_sqs_queue" "dlq" {\n  name = "dlq"\n}\nresource "aws_sqs_queue" "jobs" {\n  redrive = aws_sqs_queue.dlq.arn\n}\n', 'resource "aws_sqs_queue" "jobs" {\n}\n'] }, others);
  const dlq = card(m, "aws_sqs_queue.dlq");
  assert.deepEqual([dlq.status, dlq.still, cardLines(dlq)], ["removed", ["aws_cloudwatch_metric_alarm.depth"], [{ text: "Still referenced by depth", bad: true, rows: 1 }]]);
  assert.deepEqual(m.cards.map((c) => [c.addr, c.status, c.file]), [["aws_cloudwatch_metric_alarm.depth", "unchanged", "stack/alarms.tf"], ["aws_sqs_queue.jobs", "changed", "stack/queue.tf"], ["aws_sqs_queue.dlq", "removed", "stack/queue.tf"]].sort((a, b) => a[2].localeCompare(b[2])), "the unchanged one shows because it refers to it; one that refers to nothing changed does not, nor another folder's");
  assert.deepEqual(m.edges.map((e) => [e.from.split("|")[1], e.to.split("|")[1]]), [["aws_cloudwatch_metric_alarm.depth", "aws_sqs_queue.dlq"]]);
  assert.equal(infraSummary(m), "2 resources: 1 changed, 1 removed. 1 unchanged one is directly connected to what changed.");
  assert.equal(infraArch(m).nodes.find((n) => n.id === dlq.id).status, "removed");
  assert.equal(infraArch(m).nodes.find((n) => n.label === "depth").source, "existing", "an unchanged card is drawn as what is already there");
  // Without the other files (no checkout) nothing refers to it, and nothing is claimed.
  assert.deepEqual(card(model({ "stack/queue.tf": ['resource "aws_sqs_queue" "dlq" {\n}\n', "\n"] }), "aws_sqs_queue.dlq").still, []);
});

test("moved and import blocks: a rename, an adoption, not a removal and an addition", () => {
  const m = model({ "main.tf": ['resource "aws_sqs_queue" "a" {\n  delay_seconds = 1\n}\nresource "aws_sns_topic" "t" {\n  x = aws_sqs_queue.a.arn\n}\n',
    'resource "aws_sqs_queue" "b" {\n  delay_seconds = 2\n}\nmoved {\n  from = aws_sqs_queue.a\n  to   = aws_sqs_queue.b\n}\nresource "aws_sns_topic" "t" {\n  x = aws_sqs_queue.a.arn\n}\nimport {\n  to = aws_s3_bucket.kept[0]\n  id = "kept"\n}\nresource "aws_s3_bucket" "kept" {\n}\nremoved {\n  from = aws_sqs_queue.gone\n}\n'] });
  assert.deepEqual(m.cards.map((c) => [c.addr, c.status]), [["aws_sqs_queue.b", "changed"], ["aws_sns_topic.t", "unchanged"], ["aws_s3_bucket.kept", "added"]]);
  assert.deepEqual(texts(card(m, "aws_sqs_queue.b")), ["Its old name is still used by t", "Renamed from a by a moved block", "delay_seconds: 1 → 2"]);
  assert.deepEqual(texts(card(m, "aws_s3_bucket.kept")), ["An import block adopts an existing resource"]);
  assert.deepEqual(m.edges.map((e) => [e.from.split("|")[1], e.to.split("|")[1]]), [["aws_sns_topic.t", "aws_sqs_queue.b"]], "who still uses the old name points at the renamed card");
  const r = model({ "main.tf": ['resource "aws_sqs_queue" "gone" {\n}\n', 'removed {\n  from = aws_sqs_queue.gone\n}\n'] });
  assert.deepEqual(texts(card(r, "aws_sqs_queue.gone")), ["A removed block names it, see its lifecycle"]);
});

test("variables, locals, outputs and tfvars are rows; a changed backend or provider is a notice", () => {
  const m = model({
    "s/vars.tf": ['variable "days" {\n  default = 14\n}\nvariable "old" {}\nlocals {\n  prefix = "a"\n}\noutput "url" {\n  value = aws_sqs_queue.q.url\n}\n', 'variable "days" {\n  default = 30\n}\nlocals {\n  prefix = "b"\n}\nvariable "fresh" {}\n'],
    "s/main.tf": ['terraform {\n  required_version = ">= 1.5"\n  backend "s3" {\n    bucket = "state"\n  }\n}\nprovider "aws" {\n  region = "eu-central-1"\n}\n', 'terraform {\n  required_version = ">= 1.7"\n  backend "s3" {\n    bucket = "state-2"\n  }\n}\nprovider "aws" {\n  region = "eu-west-1"\n}\nprovider "aws" {\n  alias  = "east"\n  region = "us-east-1"\n}\n'],
    "s/prod.tfvars": ['days = 14\n', 'days = 90\n'] },
  { "s/q.tf": 'resource "aws_sqs_queue" "q" {\n  name = "${local.prefix}-q"\n  retention = var.days\n  x = var.old\n}\n' });
  assert.deepEqual(m.rows.map(rowText), ["var.days changed · default: 14 → 30 · used by aws_sqs_queue.q", "local.prefix changed · \"a\" → \"b\" · used by aws_sqs_queue.q", "var.fresh added", "prod.tfvars: days changed · 14 → 90", "var.old removed · still used by aws_sqs_queue.q", "output.url removed"]);
  assert.deepEqual(m.notices.map(noticeText), ['terraform block of main.tf changed in s/main.tf:1: required_version: ">= 1.5" → ">= 1.7"; backend s3: changed', 'provider.aws changed in s/main.tf:7: region: "eu-central-1" → "eu-west-1"', "provider.aws.east added in s/main.tf:10"]);
  const q = card(m, "aws_sqs_queue.q");
  assert.deepEqual([q.status, cardLines(q)], ["unchanged", [{ text: "Uses local.prefix, which changed", bad: false, rows: 1 }, { text: "Uses var.days, which changed", bad: false, rows: 1 }, { text: "Uses var.old, which was removed", bad: true, rows: 1 }]], "the resource that reads a changed value shows, unchanged itself");
  assert.equal(infraSummary(m), "No resource itself changes. 1 unchanged one is directly connected to what changed.");
  assert.equal(m.total, 9);
});

const TEMPLATE = readFileSync(new URL("../../demo/fixtures/review/pr2.diff", import.meta.url), "utf8");
test("SAM: PR #2 of the demo adds a queue and two functions that refer to it", () => {
  const m = infraModel(splitPatch(TEMPLATE));
  assert.deepEqual(m.cards.map((c) => [c.addr, c.type, c.status, c.line, c.end]), [["LoanEvents", "AWS::SQS::Queue", "added", 11, 12], ["FrontDesk", "AWS::Serverless::Function", "added", 14, 26], ["ReminderConsumer", "AWS::Serverless::Function", "added", 28, 37]]);
  assert.deepEqual(m.edges.map((e) => [e.from.split("|")[1], e.to.split("|")[1], e.label, e.status]), [["FrontDesk", "LoanEvents", "Environment, Policies", "new"], ["ReminderConsumer", "LoanEvents", "Events", "new"]]);
  assert.deepEqual([m.groups, m.rows, m.notices, m.unread, m.total], [[{ id: "cfn:template.yaml", label: "template.yaml", kind: "SAM" }], [], [], [], 3]);
  assert.equal(infraSource(m), "Derived from the diff; no change set was created, so replacements and computed values are estimates.");
  const f = [{ id: "f1", file: "template.yaml", line: 12, severity: "high", title: "Queue has no dead-letter queue" }, { id: "f2", file: "template.yaml", line: 16, severity: "low", title: "x" }, { id: "f3", file: "template.yaml", line: 20, severity: "medium", title: "y" }, { id: "f4", file: "library/x.py", line: 12, severity: "high", title: "z" }];
  const marks = infraMarks(m, f).nodes;
  assert.deepEqual([...marks].map(([id, x]) => [id.split("|")[1], x.n, x.severity]), [["LoanEvents", 1, "high"], ["FrontDesk", 2, "medium"]], "a finding sits at the resource whose block holds its line");
  const P = infraPicture(m, f);
  assert.deepEqual([P.L.nodes.length, P.L.paths.length, P.L.groups.length], [3, 2, 1]);
  assert.ok(P.L.nodes.find((n) => n.label === "LoanEvents").x > P.L.nodes.find((n) => n.label === "FrontDesk").x, "what refers stands left of what it refers to");
  assert.ok(P.L.nodes.find((n) => n.label === "FrontDesk").h > P.L.nodes.find((n) => n.label === "ReminderConsumer").h, "a card with a finding has the room for its mark");
});

test("CloudFormation: changed properties, a new name or Type may replace, a removed resource still referenced", () => {
  const base = `AWSTemplateFormatVersion: "2010-09-09"
Parameters:
  Stage:
    Type: String
    Default: dev
Resources:
  # the queue
  Jobs:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: jobs
      VisibilityTimeout: 30   # seconds
  Dead:
    Type: AWS::SQS::Queue
  Worker:
    Type: AWS::Lambda::Function
    DependsOn: [Jobs, Dead]
    Properties:
      Timeout: 10
      Environment:
        Variables:
          URL: !Sub "https://\${Jobs}.example/\${AWS::Region}/\${Stage}"
          DLQ: !GetAtt Dead.Arn
      Tags:
      - Key: team
        Value: shop
  Topic:
    Type: AWS::SNS::Topic
  Alarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      Dimensions:
        - Name: QueueName
          Value:
            Fn::GetAtt:
              - Dead
              - QueueName
  Flow: { Type: AWS::SQS::Queue, Properties: { DelaySeconds: 1 } }
Outputs:
  JobsUrl:
    Value: !Ref Jobs
`;
  const head = base.replace("QueueName: jobs", "QueueName: jobs-v2").replace("      VisibilityTimeout: 30   # seconds\n", "      VisibilityTimeout: 60\n").replace("  Dead:\n    Type: AWS::SQS::Queue\n", "").replace("Timeout: 10", "Timeout: 30")
    .replace("Type: AWS::SNS::Topic", "Type: AWS::SQS::Queue").replace("DelaySeconds: 1", "DelaySeconds: 2").replace("Default: dev", "Default: prod");
  const m = model({ "stack.yml": [base, head] });
  assert.deepEqual(m.cards.map((c) => [c.addr, c.status]), [["Jobs", "replaced"], ["Worker", "changed"], ["Topic", "replaced"], ["Alarm", "unchanged"], ["Flow", "changed"], ["Dead", "removed"]].sort((a, b) => card(m, a[0]).line - card(m, b[0]).line || 0));
  assert.deepEqual(texts(card(m, "Jobs")), ["A changed QueueName usually forces a new resource", "QueueName: jobs → jobs-v2", "VisibilityTimeout: 30 → 60"]);
  assert.deepEqual(texts(card(m, "Topic")), ["A new Type replaces the resource", "Type: AWS::SNS::Topic → AWS::SQS::Queue"]);
  assert.deepEqual(texts(card(m, "Worker")), ["Uses Stage, which changed", "Timeout: 10 → 30"]);
  assert.deepEqual(card(m, "Worker").deps, ["Dead", "Jobs"]);
  assert.deepEqual(texts(card(m, "Dead")), ["Still referenced by Worker, Alarm"]);
  assert.deepEqual(texts(card(m, "Flow")), ["Changed; this block is not read in detail"], "a resource written as a flow mapping: changed, without details");
  assert.deepEqual(m.rows.map(rowText), ["Stage changed · Default: dev → prod · used by Worker"]);
  assert.deepEqual(m.edges.map((e) => `${e.from.split("|")[1]}>${e.to.split("|")[1]}:${e.label}`), ["Worker>Dead:Environment, DependsOn", "Worker>Jobs:Environment, DependsOn", "Alarm>Dead:Dimensions"]);
});

test("CloudFormation: what is no template is not read as one; a JSON template is", () => {
  assert.equal(readCloudFormation("name: ci\non:\n  push: {}\njobs:\n  build:\n    runs-on: x\n", "ci.yml"), null);
  assert.equal(readCloudFormation("Resources:\n  a:\n    kind: Deployment\n", "k.yaml"), null, "Resources alone is not enough");
  assert.equal(readCloudFormation('{"name": "pkg", "version": "1.0.0"}', "package.json"), null);
  assert.equal(model({ "ci.yml": ["on: push\n", "on: pull_request\n"], "package.json": ['{"a": 1}', '{"a": 2}'] }), null, "no infrastructure code: no section");
  const cut = (path) => infraModel([{ path, status: "modified", lines: ["@@ -20,3 +20,3 @@", "       Timeout: 10", "-      MemorySize: 128", "+      MemorySize: 256"] }]);
  assert.deepEqual([cut("deploy/template.yaml").unread, infraSource(cut("deploy/template.yaml")), cut("config/app.yaml")], [[{ path: "deploy/template.yaml", why: "the file at the PR head is not loaded" }], "Derived from the diff; no change set was created, so replacements and computed values are estimates.", null],
    "without a checkout, a changed file that is a template by its name is named as not read; any other YAML is left alone");
  const j = (timeout) => JSON.stringify({ AWSTemplateFormatVersion: "2010-09-09", Resources: { Jobs: { Type: "AWS::SQS::Queue" }, Fn: { Type: "AWS::Lambda::Function", DependsOn: "Jobs", Properties: { Timeout: timeout, Environment: { Variables: { URL: { Ref: "Jobs" }, ARN: { "Fn::GetAtt": ["Jobs", "Arn"] } } } } } } }, null, 2);
  const m = model({ "t.json": [j(10), j(30)] });
  assert.deepEqual(m.cards.map((c) => [c.addr, c.status, c.line, c.deps]), [["Jobs", "unchanged", 4, []], ["Fn", "changed", 7, ["Jobs"]]]);
  assert.deepEqual(texts(card(m, "Fn")), ["Timeout: 10 → 30"]);
  assert.equal(m.groups[0].kind, "CloudFormation");
});

const FX = new URL("../../demo/fixtures/infra/", import.meta.url), fx = (p) => readFileSync(new URL(p, FX), "utf8");
test("the Terraform fixture end to end: from the patch and the files at the head", () => {
  const patch = splitPatch(fx("pr.diff")), dir = "stacks/orders", files = patch.map((f) => ({ ...f, head: fx(`head/${f.path}`) }));
  for (const f of files) assert.equal(baseText(f.head, f.lines), fx(`base/${f.path}`), `${f.path} before the PR`);
  const others = readdirSync(new URL(`head/${dir}/`, FX)).filter((n) => !patch.some((f) => f.path === `${dir}/${n}`)).map((n) => ({ path: `${dir}/${n}`, text: fx(`head/${dir}/${n}`) }));
  const m = infraModel(files, others), st = Object.fromEntries(m.cards.map((c) => [c.addr, c.status]));
  assert.deepEqual(st, { "aws_cloudwatch_metric_alarm.dlq_depth": "unchanged", "aws_iam_role.worker": "unchanged", "data.aws_iam_policy_document.worker_queue": "unchanged", "aws_sqs_queue.orders": "changed", "aws_sqs_queue.orders_dlq": "removed",
    "aws_s3_bucket.receipts": "unchanged", "aws_s3_bucket_lifecycle_configuration.receipts": "added", "aws_s3_bucket.archive": "added", "aws_secretsmanager_secret.mailer": "unchanged", "aws_secretsmanager_secret_version.mailer": "changed",
    "aws_lambda_function.worker": "replaced", "aws_lambda_event_source_mapping.orders_queue": "changed", "aws_cloudwatch_log_group.worker": "unchanged" });
  assert.deepEqual(card(m, "aws_sqs_queue.orders_dlq").still, ["aws_cloudwatch_metric_alarm.dlq_depth", "data.aws_iam_policy_document.worker_queue"]);
  assert.deepEqual(texts(card(m, "aws_secretsmanager_secret_version.mailer")), ["secret_string: changed"]);
  assert.deepEqual(m.notices.map(noticeText), ["terraform block of main.tf changed in stacks/orders/main.tf:1: backend s3: changed"]);
  const md = infraMd(m, { table, flow: mermaidFlow, findings: [{ id: "f", file: "stacks/orders/queue.tf", line: 4, severity: "high", title: "The queue lost its dead-letter queue" }] }).join("\n");
  assert.match(md, /^## Infrastructure changes \(10\)\n\nDerived from the diff; no terraform plan was run, so replacements and computed values are estimates\.\n\n- `terraform block of main\.tf changed/);
  assert.match(md, /```mermaid\nflowchart LR\n {2}subgraph group0\["stacks\/orders \(Terraform\)"\]/);
  assert.ok(md.includes('["aws_sqs_queue orders_dlq, still referenced"]:::removed') && md.includes('["aws_lambda_function worker, may be replaced"]:::changed') && md.includes('["aws_sqs_queue orders (high: 1 finding)"]:::changed'));
  // What comes from the PR (addresses, values, paths, and the sentences made of them) is a code span each.
  assert.ok(md.includes("| `aws_sqs_queue orders_dlq` | removed; `Still referenced by dlq_depth, worker_queue` |"));
  assert.ok(md.includes("| `aws_sqs_queue orders` | changed | `visibility_timeout_seconds: 30 → 60; redrive_policy: removed` |  | `stacks/orders/queue.tf:2` | high: The queue lost its dead-letter queue |"));
  assert.ok(md.includes("### Variables, outputs and other values (2)\n\n- `var.retention_days changed · default: 14 → 30 · used by aws_cloudwatch_log_group.worker` (`stacks/orders/variables.tf:10`)"));
  // A value written as Markdown (a link, a mention, a backtick) is inert in the copied text: inside one code span.
  { const tf = (v) => `output "o" {\n  value = ${v}\n}\nresource "aws_s3_bucket" "b" {\n  bucket = ${v}\n}`, was = tf('"b"'), now = tf('"[click](https://example.invalid) @octo-org/everyone `x`"');
    const f = { path: "main.tf", status: "modified", head: now, lines: ["@@ -1,6 +1,6 @@", ...was.split("\n").map((l) => `-${l}`), ...now.split("\n").map((l) => `+${l}`)] };
    const out = infraMd(infraModel([f]), { table, flow: mermaidFlow }), hit = out.filter((l) => l.includes("@octo-org"));
    assert.ok(hit.length >= 2, "the value is in the row and in the table");
    for (const l of hit) assert.match(l, /^(- |\| )`[^`]*`/, `inert: ${l}`);
    assert.ok(out.includes("- `output.o changed · \"b\" → \"[click](https://example.invalid) @octo-org/everyone 'x'\"` (`main.tf:1`)")); }
  assert.ok(!md.includes("placeholder"), "the secret's value is in no line");
  const P = infraPicture(m);
  assert.deepEqual([P.L.nodes.length, P.L.groups.length, P.arch.folded], [13, 1, null]);
  // One layout for the render; the search for a better one runs after it, from the same arguments (stack.js laidOut).
  assert.deepEqual([P.args.length, P.args[4]], [5, { labels: true }]);
  assert.equal(JSON.stringify(P.L), JSON.stringify(archLayout(...P.args)), "the picture is archLayout's own");
  assert.ok(archBest(...P.args).hops.length <= P.L.hops.length, "and the search does not make it cross more");
  const worker = P.arch.nodes.find((n) => n.label === "worker" && n.type === "aws_lambda_function");
  assert.deepEqual([worker.status, worker.word, worker.dashed, worker.at], ["replaced", "MAY BE REPLACED", true, "stacks/orders/worker.tf:1"], "may be replaced: its own word and a dashed border, not only a colour");
});

test("over 40 cards, the resources of one type in a group are one card with their number", () => {
  const n = INFRA_MAX + 5, head = [...Array.from({ length: n }, (_x, i) => `resource "aws_iam_role_policy" "p${i}" {\n  role = aws_iam_role.r.id\n}\n`), 'resource "aws_iam_role" "r" {\n}\n'].join("");
  const m = model({ "iam.tf": ['resource "aws_iam_role" "r" {\n  path = "/"\n}\n', head] }), a = infraArch(m);
  assert.deepEqual(a.nodes.map((x) => [x.label, x.description, x.status, x.count]), [[`${n} aws_iam_role_policy`, `${n} added`, "new", n], ["r", "aws_iam_role · iam.tf:136", "changed", undefined]]);
  assert.deepEqual([a.edges.length, a.folded], [1, { types: 1, cards: n }], "their references are one line");
  assert.equal(infraMarks(m, [{ file: "iam.tf", line: 2, severity: "low", title: "t" }], a.alias).nodes.get(a.nodes[0].id).n, 1, "a finding at one of them sits at their card");
  assert.ok(infraMd(m, { table, flow: mermaidFlow }).join("\n").includes(`Over ${INFRA_MAX} cards: ${n} resources of 1 type are one card per type.`));
  assert.equal(infraArch(model({ "iam.tf": [null, head] }), 100).folded, null);
});

// A file of the PR written to break the reader: it never throws and never takes long, the file is named as not read
// (or read, where it is only big), and the other files of the PR are still in the picture.
test("a file written to break the reader costs that file, not the section", () => {
  const added = (path, text) => ({ path, status: "added", lines: ["@@ -0,0 +1,1 @@", ...text.split("\n").map((l) => `+${l}`)] });
  const good = added("infra/ok.tf", 'resource "aws_sqs_queue" "q" {\n  name = "q"\n}\n');
  const timed = (what, f, ms = 500) => { const t = performance.now(), out = f(); assert.ok(performance.now() - t < ms, `${what}: ${Math.round(performance.now() - t)} ms`); return out; };
  const unread = (what, text) => { const m = timed(what, () => infraModel([good, added("infra/x.tf", text)])); assert.deepEqual([m.cards.map((c) => c.addr), m.unread.map((u) => u.path)], [["aws_sqs_queue.q"], ["infra/x.tf"]], what); };
  unread("templates in strings, 6000 deep", `resource "a_b" "c" {\n  x = ${'"${'.repeat(6000)}\n}\n`);
  // Blocks in blocks, 3000 deep: the resource is there, its nested block is "not understood" below the limit.
  { const text = `resource "a_b" "c" {\n${"a {\n".repeat(3000)}${"}\n".repeat(3000)}}\n`, m = timed("blocks in blocks", () => infraModel([good, added("infra/x.tf", text)]));
    assert.deepEqual([m.cards.map((c) => c.addr), readTerraform(text, "x.tf").items[0].ok], [["aws_sqs_queue.q", "a_b.c"], false]); }
  unread("80 000 lines of a comment that never closes", "/* x\n".repeat(80000));
  unread("a file over the size limit", `# ${"x".repeat(2000001)}\n`);
  // Real nesting is read as before: a string in a template in a string, blocks four deep.
  const deep = readTerraform('resource "a_b" "c" {\n  x = "a-${lookup(m, "k-${var.v}", "d")}"\n  l1 {\n    l2 {\n      l3 {\n        l4 = 1\n      }\n    }\n  }\n}\n', "a.tf");
  assert.deepEqual([deep.ok, deep.items[0].ok, deep.items[0].args.get("x").text], [true, true, '"a-${lookup(m, "k-${var.v}", "d")}"']);
  // CloudFormation: one key with 200 000 lines is a value like another.
  const y = `AWSTemplateFormatVersion: "2010-09-09"\nResources:\n  A:\n    Type: AWS::SQS::Queue\n    Properties:\n      Big:\n${"        - x\n".repeat(200000)}`;
  assert.equal(timed("a YAML key with 200 000 lines", () => readCloudFormation(y, "t.yaml"), 2000).items[0].args.get("Big").text.split("\n").length, 200000);
  // A modified file of 200 000 lines: its text before the PR, without the lines as one call's arguments.
  const big = Array.from({ length: 200000 }, (_x, k) => `l${k}`);
  assert.equal(timed("baseText of 200 000 lines", () => baseText(big.join("\n"), ["@@ -199999,2 +199999,2 @@", " l199998", "-old", "+l199999"]), 2000).split("\n").at(-1), "old");
});
