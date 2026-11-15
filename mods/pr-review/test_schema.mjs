// Run: node test_schema.mjs  ("Schema changes": the three readers for SQL, Alembic and Prisma, the tables of both
// sides, their difference, the risk rules, the cards with their rows, the layout and the Markdown section)
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { sqlStatements, readSql, readAlembic, readPrisma, schemaFiles, schemaWants, schemaModel, schemaSteps, schemaArch, schemaMarks, schemaPicture, schemaMermaid, schemaMd, schemaSummary, cardRows, colDetail, edgeText, narrower,
  seriesOf, unreadText, foldText, SCHEMA_SOURCE, SCHEMA_MAX, SCHEMA_ROWS } from "./schema.js";
import { splitPatch } from "./pr.js";
import { sidesOf } from "./infra.js";

// ---- helpers: a file of a patch as pr.js splitPatch gives it
const added = (path, text) => ({ path, status: "added", binary: false, lines: [`@@ -0,0 +1,${text.split("\n").length} @@`, ...text.split("\n").map((l) => `+${l}`)] });
const changed = (path, base, head) => ({ path, status: "modified", binary: false, head, lines: [`@@ -1,${base.split("\n").length} +1,${head.split("\n").length} @@`, ...base.split("\n").map((l) => `-${l}`), ...head.split("\n").map((l) => `+${l}`)] });
const other = (path, text) => ({ path, text });
const card = (m, name) => m.cards.find((c) => c.name === name), col = (m, t, name) => card(m, t).cols.find((c) => c.name === name), rules = (m) => m.risks.map((r) => r.rule);
const rowsText = (m, name) => cardRows(card(m, name), m.risks).map((r) => [r.sign, r.name, r.text || r.type].filter(Boolean).join(" ")); // as a row is drawn: a changed column says what changed, the others their type
const ops = (sql) => readSql(sql).ops, one = (sql) => { const o = ops(sql); assert.equal(o.length, 1, `one step: ${sql}`); return o[0]; };

// ---- SQL: statements and tokens
{
  const { sts } = sqlStatements("-- a; comment\nCREATE TABLE a (x int); /* b;\n c */ INSERT INTO a VALUES ('it''s; fine', $$ body; $$, $fn$ x; $fn$);\nSELECT \"a;b\", `c;d`\n;");
  assert.deepEqual(sts.map((s) => [s.line, s.toks[0].t]), [[2, "CREATE"], [3, "INSERT"], [4, "SELECT"]], "a semicolon in a comment, a string, a dollar quote or a quoted name ends nothing");
  assert.deepEqual(sts[2].toks.map((t) => [t.k, t.t]), [["w", "SELECT"], ["q", "a;b"], ["p", ","], ["q", "c;d"]], "quoted names are names");
  assert.equal(sqlStatements("CREATE TABLE a (\n x int\n);\n\nDROP TABLE b;").sts[1].line, 5, "lines count through a statement");
  const marked = sqlStatements("-- +goose Up\nCREATE TABLE a (x int);\n-- +goose Down\nDROP TABLE a;");
  assert.deepEqual([marked.marked, marked.down, marked.sts.length], [true, true, 1], "what follows a down mark is not read");
  assert.deepEqual([sqlStatements("-- migrate:up\nSELECT 1;").marked, sqlStatements("-- migrate:up\nSELECT 1;").down], [true, false]);
}
// ---- SQL: CREATE TABLE
{
  const t = one(`CREATE TABLE IF NOT EXISTS public.loans (
    id bigserial PRIMARY KEY,
    member_id bigint NOT NULL REFERENCES members (id) ON DELETE SET NULL,
    amount numeric ( 10 , 2 ) DEFAULT 0 NOT NULL,
    note character varying(40) DEFAULT 'none'::text,
    "Lent At" timestamp with time zone DEFAULT now(),
    tags integer[] NULL,
    code text UNIQUE CHECK (length(code) > 3),
    key varchar(20),
    delta int DEFAULT -1,
    nothing text DEFAULT NULL,
    seq int GENERATED ALWAYS AS IDENTITY,
    CONSTRAINT loans_code_note UNIQUE (code, note),
    CONSTRAINT loans_book FOREIGN KEY (book_id, copy) REFERENCES lib.books (id, copy) ON DELETE CASCADE,
    CHECK (amount >= 0)
  )`);
  assert.deepEqual([t.op, t.table, t.ifNotExists, t.vague, t.line, t.end], ["create", "loans", true, false, 1, 16], "the default schema is left out of the name");
  const c = Object.fromEntries(t.cols.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(c), ["id", "member_id", "amount", "note", "Lent At", "tags", "code", "key", "delta", "nothing", "seq"], "a column may be called key; a quoted name keeps its case");
  assert.deepEqual([c.id.type, c.id.pk, c.id.notNull, c.id.default], ["bigserial", true, true, "sequence"], "a serial has a value by itself");
  assert.deepEqual([c.member_id.notNull, c.member_id.ref], [true, { table: "members", cols: ["id"] }], "ON DELETE SET NULL is no NULL of the column");
  assert.deepEqual([c.amount.type, c.amount.default, c.amount.notNull], ["numeric(10, 2)", "0", true], "a type reads the same however it was spaced");
  assert.deepEqual([c.note.type, c.note.default], ["character varying(40)", "'none'::text"]);
  assert.deepEqual([c["Lent At"].type, c["Lent At"].default, c["Lent At"].line], ["timestamp with time zone", "now()", 6]);
  assert.deepEqual([c.tags.type, c.tags.notNull, c.code.unique, c.key.type], ["integer[]", false, true, "varchar(20)"]);
  assert.deepEqual([c.delta.default, c.nothing.default, c.seq.default], ["-1", null, "identity"], "DEFAULT NULL is no default");
  assert.deepEqual(t.uniques.map((u) => [u.cols, u.name]), [[["code", "note"], "loans_code_note"]]);
  assert.deepEqual(t.fks.map((f) => [f.cols, f.ref, f.refCols, f.line]), [[["book_id", "copy"], "lib.books", ["id", "copy"], 14]], "another schema stays in the name");
  assert.deepEqual(one("CREATE TABLE a (x int, y int, PRIMARY KEY (x, y))").pk, ["x", "y"]);
  assert.deepEqual(one("CREATE TABLE `orders` (`id` int NOT NULL AUTO_INCREMENT, `ref` varchar(8), PRIMARY KEY (`id`), UNIQUE KEY `uq_ref` (`ref`), KEY `ix_ref` (`ref`(4))) ENGINE=InnoDB").indexes.map((x) => [x.name, x.cols]), [["ix_ref", ["ref"]]], "MySQL: keys in the table's list");
  assert.equal(one("CREATE TABLE `orders` (`id` int NOT NULL AUTO_INCREMENT)").cols[0].default, "auto increment");
  for (const sql of ["CREATE TABLE b AS SELECT * FROM a", "CREATE TABLE p PARTITION OF a FOR VALUES IN (1)", "CREATE TABLE c (LIKE a INCLUDING ALL)", "CREATE TABLE d (x int, EXCLUDE USING gist (x WITH =))"]) assert.equal(one(sql).vague, true, `not read in full: ${sql}`);
  assert.deepEqual(ops("CREATE TEMPORARY TABLE t (x int); CREATE TEMP TABLE u (x int)"), [], "a temporary table is no part of the schema");
  assert.equal(one("CREATE UNLOGGED TABLE q (x int)").table, "q");
}
// ---- SQL: ALTER TABLE
{
  assert.deepEqual(ops("ALTER TABLE ONLY public.loans\n  ADD COLUMN IF NOT EXISTS renewals integer NOT NULL DEFAULT 0,\n  DROP COLUMN IF EXISTS legacy CASCADE,\n  ALTER COLUMN note TYPE varchar(80) USING left(note, 80),\n  ALTER note SET NOT NULL").map((o) => [o.op, o.table, o.line, o.col?.name ?? o.name, o.set ?? null]),
    [["addCol", "loans", 2, "renewals", null], ["dropCol", "loans", 3, "legacy", null], ["alterCol", "loans", 4, "note", { type: "varchar(80)" }], ["alterCol", "loans", 5, "note", { notNull: true }]], "several changes in one statement, each with its own line");
  const sets = (sql) => one(sql).set;
  assert.deepEqual(sets("ALTER TABLE a ALTER COLUMN x SET DATA TYPE bigint"), { type: "bigint" });
  assert.deepEqual(sets("ALTER TABLE a ALTER COLUMN x DROP NOT NULL"), { notNull: false });
  assert.deepEqual(sets("ALTER TABLE a ALTER COLUMN x SET DEFAULT now()"), { default: "now()" });
  assert.deepEqual(sets("ALTER TABLE a ALTER COLUMN x DROP DEFAULT"), { default: null });
  assert.deepEqual(one("ALTER TABLE a RENAME COLUMN x TO y"), { op: "renameCol", table: "a", line: 1, end: 1, name: "x", to: "y" });
  assert.deepEqual([one("ALTER TABLE a RENAME x TO y").op, one("ALTER TABLE IF EXISTS a RENAME TO b").op, one("ALTER TABLE a RENAME TO b").to], ["renameCol", "renameTable", "b"]);
  assert.deepEqual(ops("RENAME TABLE a TO b, c TO d").map((o) => [o.op, o.table, o.to]), [["renameTable", "a", "b"], ["renameTable", "c", "d"]], "MySQL's RENAME TABLE");
  assert.deepEqual(ops("ALTER TABLE a ADD CONSTRAINT a_b FOREIGN KEY (b_id) REFERENCES b (id), ADD UNIQUE (x, y), ADD PRIMARY KEY (id), ADD CONSTRAINT pos CHECK (x > 0)").map((o) => [o.op, o.cols, o.ref ?? null, o.name ?? null]),
    [["fk", ["b_id"], "b", "a_b"], ["unique", ["x", "y"], null, null], ["pk", ["id"], null, null]], "a CHECK is no part of the picture and no change to report");
  assert.deepEqual(ops("ALTER TABLE a DROP CONSTRAINT a_b, DROP PRIMARY KEY, DROP INDEX ix, DROP FOREIGN KEY fk1").map((o) => [o.op, o.name ?? null]), [["dropConstraint", "a_b"], ["pk", null], ["dropIndex", "ix"], ["dropConstraint", "fk1"]]);
  assert.deepEqual(ops("ALTER TABLE a MODIFY COLUMN x varchar(10) NOT NULL DEFAULT 'n', CHANGE old new bigint").map((o) => [o.op, o.name, o.to ?? o.set]),
    [["alterCol", "x", { type: "varchar(10)", notNull: true, default: "'n'" }], ["renameCol", "old", "new"], ["alterCol", "new", { type: "bigint", notNull: false, default: null }]], "MySQL's MODIFY and CHANGE give the whole column again");
  assert.deepEqual(ops("ALTER TABLE a ENABLE ROW LEVEL SECURITY, ALTER COLUMN x SET STATISTICS 100").map((o) => [o.op, o.text]), [["vague", "enable row level security"], ["vague", "alter column x set"]], "what is not understood is said, not guessed");
  assert.deepEqual(ops("ALTER TABLE a OWNER TO app; ALTER TABLE a VALIDATE CONSTRAINT c; ALTER TABLE a RENAME CONSTRAINT c TO d"), [], "no change to a table's shape");
}
// ---- SQL: indexes, drops, and what is not read
{
  assert.deepEqual(one("CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS members_email_key ON ONLY members USING btree (email, lower(name), created DESC) WHERE email IS NOT NULL"),
    { op: "index", table: "members", name: "members_email_key", cols: ["email", null, "created"], unique: true, concurrently: true, line: 1, end: 1 }, "an expression in an index is not a column");
  assert.deepEqual([one("CREATE INDEX ON loans (due)").name, one("CREATE INDEX ix ON loans (due)").concurrently, one("CREATE INDEX ix ON loans (due)").unique], [null, false, false]);
  assert.deepEqual(ops("DROP TABLE IF EXISTS a, lib.b CASCADE; DROP INDEX CONCURRENTLY IF EXISTS public.ix, iy; DROP INDEX iz ON t").map((o) => [o.op, o.table ?? null, o.name ?? null]),
    [["drop", "a", null], ["drop", "lib.b", null], ["dropIndex", null, "ix"], ["dropIndex", null, "iy"], ["dropIndex", "t", "iz"]]);
  const r = readSql("CREATE EXTENSION pgcrypto; CREATE SCHEMA lib; INSERT INTO a VALUES (1); UPDATE a SET x = 1; COMMENT ON TABLE a IS 'x';\nCREATE OR REPLACE VIEW v AS SELECT 1;\nALTER TYPE mood ADD VALUE 'ok';\nCREATE MATERIALIZED VIEW mv AS SELECT 1; DROP SEQUENCE s; CREATE FUNCTION f() RETURNS int AS $$ DROP TABLE a; $$ LANGUAGE sql;");
  assert.deepEqual([r.ops, r.skipped], [[], [{ what: "CREATE VIEW", line: 2 }, { what: "ALTER TYPE", line: 3 }, { what: "CREATE MATERIALIZED VIEW", line: 4 }, { what: "DROP SEQUENCE", line: 4 }]], "views, types and sequences are named as not read; data, extensions and a function's body are no schema change");
  assert.deepEqual(ops("--liquibase formatted sql\n--changeset dev:1\nCREATE TABLE a (id int);\n--rollback DROP TABLE a;").map((o) => [o.op, o.line]), [["create", 3]], "Liquibase's formatted SQL is SQL with comments");
}
// ---- Alembic
{
  const REV = `"""add reservations

Revision ID: b2
Revises: a1
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'b2'
down_revision: Union[str, None] = 'a1'


def upgrade() -> None:
    # op.drop_table('never')  commented out: not read
    op.create_table(
        'reservations',
        sa.Column('id', sa.BigInteger(), primary_key=True),
        sa.Column('member_id', sa.BigInteger(), sa.ForeignKey('members.id', ondelete='CASCADE'), nullable=False),
        sa.Column('note', sa.String(length=80), server_default=sa.text("'none'"), index=True),
        sa.Column('price', sa.Numeric(precision=10, scale=2), nullable=True),
        sa.Column('book_id', sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(['book_id'], ['books.id'], name='fk_res_book'),
        sa.UniqueConstraint('member_id', 'book_id', name='uq_res'),
        sa.CheckConstraint('price >= 0'),
        schema='lib',
    )
    op.add_column('loans', sa.Column('renewals', sa.Integer(), nullable=False))
    op.drop_column('loans', 'legacy_code')
    op.alter_column('loans', 'note', existing_type=sa.String(length=200), type_=sa.String(length=80), nullable=False, new_column_name='remark')
    op.alter_column('loans', 'state', server_default=None)
    op.create_index('ix_loans_due', 'loans', ['due_on'], unique=False)
    op.create_index(op.f('ix_members_email'), 'members', ['email'], unique=True, postgresql_concurrently=True)
    op.drop_index('ix_old', table_name='loans')
    op.create_foreign_key('fk_loans_member', 'loans', 'members', ['member_id'], ['id'])
    op.create_unique_constraint('uq_members_email', 'members', ['email'])
    op.drop_constraint('fk_gone', 'loans', type_='foreignkey')
    op.rename_table('shelves', 'racks')
    op.drop_table('stock')
    with op.batch_alter_table('books', schema=None) as batch_op:
        batch_op.add_column(sa.Column('pages', sa.Integer()))
        batch_op.drop_column('shelf')
        batch_op.create_index('ix_books_isbn', ['isbn'])
        batch_op.alter_column('title', nullable=False)
    op.execute("ALTER TABLE members ALTER COLUMN phone SET NOT NULL")
    op.execute(sa.text('CREATE VIEW v AS SELECT 1'))
    op.execute(build_statement())
    op.drop_table(TABLE_NAME)
    op.bulk_insert(t, [])
    op.create_check_constraint('ck', 'loans', 'x > 0')


def downgrade() -> None:
    """Nothing."""
    pass
`;
  const r = readAlembic(REV), by = (opName) => r.ops.filter((o) => o.op === opName);
  assert.deepEqual([r.rev, r.downs, r.emptyDown], ["b2", ["a1"], true], "its place in the chain, and a downgrade that does nothing");
  const t = by("create")[0];
  assert.deepEqual([t.table, t.line, t.end, t.vague], ["lib.reservations", 16, 27, false]);
  assert.deepEqual(t.cols.map((c) => [c.name, c.type, c.notNull, c.pk, c.default, c.line]), [["id", "BigInteger", true, true, null, 18], ["member_id", "BigInteger", true, false, null, 19], ["note", "String(80)", false, false, "'none'", 20], ["price", "Numeric(10, 2)", false, false, null, 21], ["book_id", "BigInteger", true, false, null, 22]]);
  assert.deepEqual([t.cols[1].ref, t.fks.map((f) => [f.cols, f.ref, f.refCols]), t.uniques.map((u) => u.cols), t.indexes.map((x) => x.cols)], [{ table: "members", cols: ["id"] }, [[["book_id"], "books", ["id"]]], [["member_id", "book_id"]], [["note"]]]);
  assert.deepEqual(by("addCol").map((o) => [o.table, o.col.name, o.col.notNull]), [["loans", "renewals", true], ["books", "pages", false]], "a batch's calls go to its table");
  assert.deepEqual(by("dropCol").map((o) => [o.table, o.name]), [["loans", "legacy_code"], ["books", "shelf"]]);
  assert.deepEqual(by("renameCol").map((o) => [o.name, o.to]), [["note", "remark"]]);
  assert.deepEqual(by("alterCol").map((o) => [o.table, o.name, o.set]), [["loans", "remark", { type: "String(80)", notNull: true }], ["loans", "state", { default: null }], ["books", "title", { notNull: true }], ["members", "phone", { notNull: true }]], "op.execute with a literal statement is read as SQL");
  assert.deepEqual(by("index").map((o) => [o.table, o.name, o.cols, o.unique, o.concurrently]), [["loans", "ix_loans_due", ["due_on"], false, false], ["members", null, ["email"], true, true], ["books", "ix_books_isbn", ["isbn"], false, false]]);
  assert.deepEqual([by("dropIndex").map((o) => [o.name, o.table]), by("fk").map((o) => [o.table, o.cols, o.ref, o.refCols]), by("unique").map((o) => [o.table, o.cols]), by("dropConstraint").map((o) => [o.table, o.name])],
    [[["ix_old", "loans"]], [["loans", ["member_id"], "members", ["id"]]], [["members", ["email"]]], [["loans", "fk_gone"]]]);
  assert.deepEqual([by("renameTable").map((o) => [o.table, o.to]), by("drop").map((o) => o.table)], [[["shelves", "racks"]], ["stock"]], "a commented call and one with a name built in code are not steps");
  assert.deepEqual(r.skipped.map((x) => x.what), ["CREATE VIEW", "op.execute with a statement that is built in code", "op.drop_table with a name that is built in code", "op.create_check_constraint"], "what is not read is named");
  assert.equal(by("alterCol")[3].line, by("alterCol")[3].end, "a statement in op.execute has the call's place");
  assert.equal(readAlembic("def upgrade():\n    op.drop_table('x')\n"), null, "a file without a revision is no Alembic revision");
  assert.equal(readAlembic("revision = 'a'\ndown_revision = None\ndef upgrade():\n    op.drop_table('x')\n\ndef downgrade():\n    op.create_table('x', sa.Column('id', sa.Integer()))\n").emptyDown, false);
  assert.deepEqual(readAlembic("revision = 'm'\ndown_revision = ('a', 'b')\ndef upgrade():\n    pass\n").downs, ["a", "b"], "a merge has two revisions before it");
}
// ---- Prisma
{
  const P = `// the library
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL") // not read
}
enum Role { MEMBER STAFF }
model Member {
  id       Int      @id @default(autoincrement())
  email    String   @unique @db.VarChar(255) @map("mail")
  name     String?
  role     Role     @default(MEMBER)
  site     String   @default("http://x") // a comment after a string with slashes
  loans    Loan[]
  tags     Tag[]
  @@map("members")
  @@index([name, role(sort: Desc)])
}
model Loan {
  memberId Int      @map("member_id")
  bookId   Int
  member   Member   @relation(fields: [memberId], references: [id], onDelete: Cascade)
  due      DateTime @db.Date
  codes    String[]
  @@id([memberId, bookId])
  @@unique([bookId, due])
}
model Tag {
  id      Int      @id
  members Member[]
}
model Odd {
  id Int @id
  this line is not a field (
}
`;
  const r = readPrisma(P), t = Object.fromEntries(r.ops.map((o) => [o.table, o]));
  assert.deepEqual([r.provider, Object.keys(t)], ["postgresql", ["members", "Loan", "Tag", "Odd"]], "@@map names the table");
  assert.deepEqual(t.members.cols.map((c) => [c.name, c.type, c.notNull, c.pk, c.unique, c.default, c.line]), [["id", "Int", true, true, false, "autoincrement()", 8], ["mail", "VarChar(255)", true, false, true, null, 9], ["name", "String", false, false, false, null, 10], ["role", "Role", true, false, false, "MEMBER", 11], ["site", "String", true, false, false, '"http://x"', 12]],
    "a relation is no column; @map names the column, @db its type");
  assert.deepEqual([t.members.indexes.map((x) => x.cols), t.members.links, t.Tag.links], [[["name", "role"]], ["Tag"], ["members"]], "lists on both sides without a key are a many-to-many");
  assert.deepEqual([t.Loan.pk, t.Loan.uniques.map((u) => u.cols), t.Loan.fks.map((f) => [f.cols, f.ref, f.refCols, f.line]), t.Loan.cols.find((c) => c.name === "codes").type, t.Loan.cols.find((c) => c.name === "due").type],
    [["member_id", "bookId"], [["bookId", "due"]], [[["member_id"], "members", ["id"], 21]], "String[]", "Date"], "a relation's key points at the mapped names");
  assert.deepEqual([t.Odd.vague, t.Odd.raw, t.members.vague, t.members.line, t.members.end], [true, "id Int @id\nthis line is not a field (", false, 7, 17], "a model with a line the reader does not understand is not read in detail");
}
// ---- which files, and what is read from the checkout
{
  const patch = [added("db/migrations/V4__a.sql", "x"), changed("prisma/schema.prisma", "a", "b"), added("alembic/versions/b2_x.py", "x"), added("app/migrations/0002_x.py", "x"), added("src/app.py", "x"), { ...added("src/Loan.java", "@Entity\nclass Loan {}"), status: "modified" },
    added("prisma/migrations/20240101_init/migration.sql", "x"), { ...added("erd.png", ""), binary: true }, { ...added("tools/rev.py", "down_revision = None"), status: "modified" }];
  assert.deepEqual(schemaFiles(patch).map((f) => f.path), ["db/migrations/V4__a.sql", "prisma/schema.prisma", "alembic/versions/b2_x.py", "app/migrations/0002_x.py", "src/Loan.java", "prisma/migrations/20240101_init/migration.sql", "tools/rev.py"]);
  assert.deepEqual([seriesOf("db/migrations/V4__a.sql"), seriesOf("prisma/migrations/20240101_init/migration.sql"), seriesOf("schema.sql")], ["db/migrations", "prisma/migrations", ""]);
  const w = schemaWants(schemaFiles(patch));
  assert.deepEqual(w.specs, ["db/migrations/*.sql", "alembic/versions/*.py", "prisma/migrations/*.sql", "tools/*.py", "prisma/schema.prisma", "tools/rev.py"], "the folders' other migrations and the changed files themselves");
  assert.deepEqual(["db/migrations/V1__a.sql", "db/migrations/old/V0.sql", "prisma/migrations/2023_x/migration.sql", "alembic/versions/a1.py", "alembic/env.py", "prisma/schema.prisma", "src/app.py", "app/migrations/0001_x.py"].filter(w.keep),
    ["db/migrations/V1__a.sql", "prisma/migrations/2023_x/migration.sql", "alembic/versions/a1.py", "prisma/schema.prisma"], "a pathspec's star also matches deeper folders: those are left out");
}
// ---- the fixture: a lending library, three migrations before the PR and three in it
const FX = new URL("../../demo/fixtures/schema/", import.meta.url), fx = (p) => readFileSync(new URL(p, FX), "utf8"), DIR = "db/migrations";
const fxPatch = schemaFiles(splitPatch(fx("pr.diff"))), fxOthers = readdirSync(new URL(`head/${DIR}/`, FX)).filter((n) => !fxPatch.some((f) => f.path === `${DIR}/${n}`)).map((n) => other(`${DIR}/${n}`, fx(`head/${DIR}/${n}`)));
const M = schemaModel(fxPatch, fxOthers);
{
  for (const f of fxPatch) assert.equal(sidesOf(f).head, fx(`head/${f.path}`).replace(/\n$/, ""), `${f.path}: the patch adds the file as it is at the head`);
  assert.deepEqual(M.cards.map((c) => [c.name, c.status]), [["book_authors", "unchanged"], ["books", "changed"], ["loans", "changed"], ["members", "changed"], ["reservations", "added"], ["shelves", "removed"]], "authors is unchanged and related to nothing that changed: not shown");
  assert.deepEqual([M.total, M.counts, M.groups, M.notes, M.unread], [5, { added: 1, changed: 3, renamed: 0, removed: 1 }, [{ id: "sql:db/migrations", label: "db/migrations", kind: "SQL" }], [], []]);
  assert.equal(schemaSummary(M), "5 tables: 1 added, 3 changed, 1 removed. 1 unchanged one is related to what changed.");
  assert.deepEqual(rowsText(M, "loans"), ["added", "+ renewals integer", "+ index loans_due_idx (due_date)", "changed", "~ note varchar(200) → varchar(80)", "renamed", "→ due_date was due_on", "removed", "− legacy_code text", "+ 5 unchanged"], "a changed table: what changed by state, the rest folded");
  assert.deepEqual(cardRows(card(M, "loans"), M.risks).filter((r) => r.kind === "col").map((r) => [r.name, r.marks.join(" "), r.at, r.risk.length]),
    [["renewals", "NN", "db/migrations/V5__loan_renewals.sql:2", 1], ["note", "", "db/migrations/V5__loan_renewals.sql:3", 1], ["due_date", "NN IX", "db/migrations/V5__loan_renewals.sql:4", 1], ["legacy_code", "", "db/migrations/V5__loan_renewals.sql:5", 1]], "every row leads to its own line of the migration");
  assert.deepEqual(rowsText(M, "members"), ["added", "+ unique index members_email_key (email)", "changed", "~ phone now not null", "+ 4 unchanged"], "a unique index is a row; the column it is on stays unchanged");
  assert.deepEqual(rowsText(M, "reservations"), ["id bigserial", "member_id bigint", "book_id bigint", "reserved_at timestamptz", "expires_on date", "index reservations_member_idx (member_id)"], "an added table lists its columns");
  assert.deepEqual(cardRows(card(M, "reservations"), M.risks).slice(0, 3).map((r) => r.marks.join(" ")), ["PK DF", "FK NN IX", "FK NN"]);
  assert.deepEqual([rowsText(M, "shelves"), rowsText(M, "books"), rowsText(M, "book_authors")], [["Dropped with its 2 columns"], ["removed", "− shelf_id bigint", "+ 3 unchanged"], ["Joins books and authors, n to m", "book_id bigint", "author_id bigint"]], "a dropped column's index is not listed again; a join table says what it joins");
  assert.deepEqual([card(M, "loans").at, card(M, "reservations").at, card(M, "shelves").at, card(M, "book_authors").at], ["db/migrations/V5__loan_renewals.sql:2", "db/migrations/V4__reservations.sql:2", "db/migrations/V6__members_and_shelves.sql:6", "db/migrations/V3__authors.sql:6"], "a card leads to the first statement of the PR about it");
  assert.deepEqual(M.edges.map((e) => edgeText(e, (id) => id.split("|")[1])), ["books (shelf_id) → shelves (id), removed", "loans (member_id) → members (id), n to 1", "loans (book_id) → books (id), n to 1", "book_authors (book_id) → books (id), n to 1", "reservations (member_id) → members (id), n to 1, added", "reservations (book_id) → books (id), n to 1, added"]);
  assert.deepEqual(M.risks.map((r) => [r.rule, r.at.replace(`${DIR}/`, "")]), [["table-dropped", "V6__members_and_shelves.sql:6"], ["column-removed", "V6__members_and_shelves.sql:5"], ["column-removed", "V5__loan_renewals.sql:5"], ["column-renamed", "V5__loan_renewals.sql:4"], ["not-null", "V6__members_and_shelves.sql:3"], ["not-null", "V5__loan_renewals.sql:2"],
    ["narrowed", "V5__loan_renewals.sql:3"], ["unique", "V6__members_and_shelves.sql:2"], ["index-blocks", "V5__loan_renewals.sql:7"], ["fk-no-index", "V4__reservations.sql:5"]], "every rule once where it holds: Flyway expects no way back, the concurrent index does not block");
  for (const r of M.risks) assert.match(r.text, / may /, `a hint, no verdict: ${r.text}`);
  // Without the checkout: only what the PR's own files say, and the page says so.
  const m0 = schemaModel(fxPatch);
  assert.deepEqual(m0.cards.map((c) => [c.name, c.status, c.partial]), [["books", "changed", true], ["loans", "changed", true], ["members", "changed", true], ["reservations", "added", false], ["shelves", "removed", true]]);
  assert.deepEqual([rowsText(m0, "loans"), rowsText(m0, "shelves"), m0.notes], [["added", "+ renewals integer", "+ index loans_due_idx (due_date)", "changed", "~ note type is now varchar(80)", "renamed", "→ due_date was due_on", "removed", "− legacy_code", "Its other columns are not read"], ["Dropped; its columns are not read"],
    ["The earlier migrations of db/migrations are not loaded yet, so a table shows only what this PR changes."]]);
  assert.deepEqual(rules(m0), ["table-dropped", "column-removed", "column-removed", "column-renamed", "not-null", "not-null", "unique", "index-blocks", "fk-no-index"], "a narrowed type needs the earlier type: not claimed without it");
}
// ---- the model: series, order, sides
{
  const V1 = other("m/V1__a.sql", "CREATE TABLE a (id int PRIMARY KEY, x varchar(10), y int);");
  // Flyway's numbers order the files (V2 before V10); an undo migration is no step.
  const m = schemaModel([added("m/V10__c.sql", "ALTER TABLE a DROP COLUMN z;"), added("m/U10__c.sql", "ALTER TABLE a ADD COLUMN z int;")], [V1, other("m/V2__b.sql", "ALTER TABLE a ADD COLUMN z int;")]);
  assert.deepEqual([card(m, "a").cols.map((c) => [c.name, c.status]), rules(m)], [[["id", "unchanged"], ["x", "unchanged"], ["y", "unchanged"], ["z", "removed"]], ["column-removed"]]);
  // A column added and dropped again in the same PR never existed; a table created and renamed in it has no old name.
  const m2 = schemaModel([added("m/V2__b.sql", "ALTER TABLE a ADD COLUMN tmp int; CREATE TABLE b (id int); ALTER TABLE b RENAME TO c;"), added("m/V3__c.sql", "ALTER TABLE a DROP COLUMN tmp; ALTER TABLE a ADD COLUMN w int;")], [V1]);
  assert.deepEqual([card(m2, "a").cols.filter((c) => c.status !== "unchanged").map((c) => [c.name, c.status]), card(m2, "c").status, card(m2, "c").was, rules(m2)], [[["w", "added"]], "added", null, []]);
  // A renamed table keeps its relations; the rename itself is the risk.
  const m3 = schemaModel([added("m/V3__r.sql", "ALTER TABLE a RENAME TO alpha;\nALTER TABLE alpha ADD COLUMN n int DEFAULT 0 NOT NULL;")], [V1, other("m/V2__b.sql", "CREATE TABLE b (id int PRIMARY KEY, a_id int REFERENCES a (id)); CREATE INDEX b_a ON b (a_id);")]);
  assert.deepEqual([m3.cards.map((c) => [c.name, c.status, c.was]), m3.edges.map((e) => [e.status, e.label]), rules(m3), rowsText(m3, "alpha")], [[["alpha", "renamed", "a"], ["b", "unchanged", null]], [["unchanged", "a_id, n to 1"]], ["table-renamed"], ["Renamed from a", "added", "+ n int", "+ 3 unchanged"]], "NOT NULL with a default is no risk");
  // An edited dump (Rails' structure.sql): both sides of the one file.
  const dump = (extra) => `CREATE TABLE public.members (\n    id bigint NOT NULL,\n    email character varying NOT NULL${extra}\n);\nALTER TABLE ONLY public.members\n    ADD CONSTRAINT members_pkey PRIMARY KEY (id);\nCREATE VIEW v AS SELECT 1;\n`;
  const m4 = schemaModel([changed("db/structure.sql", dump(""), dump(",\n    phone character varying(40)"))]);
  assert.deepEqual([card(m4, "members").status, rowsText(m4, "members"), rules(m4), m4.unread.map(unreadText)], ["changed", ["added", "+ phone character varying(40)", "+ 2 unchanged"], [], ["db/structure.sql is only partly in the picture: 1 statement is not read (CREATE VIEW)."]]);
  assert.equal(card(m4, "members").cols.find((c) => c.name === "id").flags.pk, true, "a dump's key comes in its own statement");
  // golang-migrate: the .down.sql is the way back, not a step; an .up.sql without one is named.
  const up = "CREATE TABLE t (id int PRIMARY KEY);", down = "DROP TABLE t;";
  assert.deepEqual([rules(schemaModel([added("m/0002_t.up.sql", up)])), rules(schemaModel([added("m/0002_t.up.sql", up), added("m/0002_t.down.sql", down)])), schemaModel([added("m/0002_t.up.sql", up), added("m/0002_t.down.sql", down)]).cards.map((c) => c.status)], [["no-down"], [], ["added"]]);
  assert.deepEqual([rules(schemaModel([added("m/2_t.sql", `-- +goose Up\n${up}`)])), rules(schemaModel([added("m/2_t.sql", `-- +goose Up\n${up}\n-- +goose Down\n${down}`)])), rules(schemaModel([added("m/V2__t.sql", up)]))], [["no-down"], [], []], "a file with an up mark needs a down mark; a plain file needs nothing");
  // Nothing found: no model, so no section.
  for (const files of [[], [added("src/app.py", "x = 1")], [added("db/seed.sql", "INSERT INTO a VALUES (1);")], [added("db/views.sql", "CREATE VIEW v AS SELECT 1;")], [added("app/migrations/0002_x.py", "class Migration: pass")], [changed("queries/report.sql", "SELECT 1;", "SELECT 2;")]])
    assert.equal(schemaModel(files), null, `no schema change: ${files.map((f) => f.path)}`);
  // A changed file that cannot be read is named when it surely is about the schema.
  const lost = { ...changed("db/structure.sql", "CREATE TABLE a (id int);", "CREATE TABLE a (id int, x int);"), head: undefined };
  assert.deepEqual([schemaModel([lost]).unread.map(unreadText), schemaModel([{ ...lost, head: "another text" }]).unread[0].why, schemaModel([{ ...changed("prisma/schema.prisma", "a", "b"), head: undefined }]).total], [["db/structure.sql is not in the picture: the file at the PR head is not loaded."], "the patch does not fit the file at the PR head", 0]);
  // Sources without a reader are named under a picture that shows.
  const m5 = schemaModel([added("m/V2__b.sql", "CREATE TABLE b (id int);"), added("app/migrations/0002_x.py", "x"), added("db/migrate/2024_x.rb", "x"), added("db/changelog/db.changelog-1.xml", "<x/>")]);
  assert.deepEqual(m5.unread.map(unreadText), ["app/migrations/0002_x.py is not in the picture: Django migrations are not read.", "db/migrate/2024_x.rb is not in the picture: Rails migrations in Ruby are not read.", "db/changelog/db.changelog-1.xml is not in the picture: Liquibase changelogs in XML, YAML or JSON are not read."]);
  // An index dropped by its name alone, on a table no read file names.
  assert.deepEqual(schemaModel([added("m/V2__b.sql", "CREATE TABLE b (id int); DROP INDEX ix_gone;")]).unread.map(unreadText), ["m/V2__b.sql is only partly in the picture: index ix_gone is dropped, and no file that was read says which table it is on."]);
  // What a reader does not understand is a row, not a guess.
  const m6 = schemaModel([added("m/V2__b.sql", "ALTER TABLE a ENABLE ROW LEVEL SECURITY;\nALTER TABLE a DROP CONSTRAINT a_x_check;")], [V1]);
  assert.deepEqual([card(m6, "a").status, rowsText(m6, "a")], ["changed", ["Changed, details not read: enable row level security", "Changed, details not read: drop constraint a_x_check", "+ 3 unchanged"]]);
  const m7 = schemaModel([added("m/V2__b.sql", "CREATE TABLE copy AS SELECT * FROM a;")], [V1]);
  assert.deepEqual([card(m7, "copy").status, card(m7, "copy").partial, rowsText(m7, "copy")], ["added", true, ["Not all of its columns are read"]]);
}
// ---- the risk rules, one by one
{
  const base = [other("m/V1__a.sql", "CREATE TABLE a (id bigint PRIMARY KEY, email varchar(100), n bigint, api_token text DEFAULT 'old', b_id bigint);\nCREATE TABLE b (id bigint PRIMARY KEY);")];
  const risk = (sql, older = base) => rules(schemaModel([added("m/V2__x.sql", sql)], older) ?? { risks: [] });
  assert.deepEqual(risk("ALTER TABLE a ADD COLUMN x int NOT NULL;"), ["not-null"]);
  assert.deepEqual(risk("ALTER TABLE a ADD COLUMN x int NOT NULL DEFAULT 0; ALTER TABLE a ADD COLUMN y serial NOT NULL; ALTER TABLE a ADD COLUMN z int;"), [], "a default, a sequence or NULL allowed: no risk");
  assert.deepEqual(risk("CREATE TABLE c (id int PRIMARY KEY, x int NOT NULL);"), [], "a new table has no rows");
  assert.deepEqual(risk("ALTER TABLE a ALTER COLUMN email SET NOT NULL;"), ["not-null"]);
  assert.deepEqual([risk("ALTER TABLE a ALTER COLUMN email TYPE varchar(50);"), risk("ALTER TABLE a ALTER COLUMN email TYPE varchar(200);"), risk("ALTER TABLE a ALTER COLUMN n TYPE integer;"), risk("ALTER TABLE a ALTER COLUMN n TYPE text;")], [["narrowed"], [], ["narrowed"], []], "only a type that surely holds less");
  assert.deepEqual([risk("ALTER TABLE a ADD CONSTRAINT a_email UNIQUE (email);"), risk("ALTER TABLE a ADD UNIQUE (email, n);"), risk("CREATE UNIQUE INDEX CONCURRENTLY a_email ON a (email);")], [["unique"], ["unique"], ["unique"]]);
  assert.deepEqual(risk("ALTER TABLE a ADD COLUMN code text UNIQUE; ALTER TABLE a ADD COLUMN k int; CREATE UNIQUE INDEX CONCURRENTLY a_k ON a (k);"), [], "unique over columns that are new: no existing duplicates");
  assert.deepEqual([risk("CREATE INDEX a_n ON a (n);"), risk("CREATE INDEX CONCURRENTLY a_n ON a (n);"), risk("CREATE TABLE c (id int, x int); CREATE INDEX c_x ON c (x);")], [["index-blocks"], [], []]);
  assert.deepEqual([risk("ALTER TABLE a ADD CONSTRAINT a_b FOREIGN KEY (b_id) REFERENCES b (id);"), risk("CREATE INDEX CONCURRENTLY a_b_ix ON a (b_id); ALTER TABLE a ADD CONSTRAINT a_b FOREIGN KEY (b_id) REFERENCES b (id);"), risk("CREATE TABLE c (b_id bigint PRIMARY KEY REFERENCES b (id));")], [["fk-no-index"], [], []], "a key or an index that starts with the column covers it");
  const mysql = [other("m/V1__a.sql", "CREATE TABLE a (id bigint PRIMARY KEY AUTO_INCREMENT, n bigint, b_id bigint) ENGINE=InnoDB;\nCREATE TABLE b (id bigint PRIMARY KEY);")];
  assert.deepEqual(risk("CREATE INDEX a_n ON a (n); ALTER TABLE a ADD CONSTRAINT a_b FOREIGN KEY (b_id) REFERENCES b (id);", mysql), [], "MySQL builds an index without CONCURRENTLY and indexes a foreign key itself");
  assert.deepEqual(risk("ALTER TABLE a DROP COLUMN n; ALTER TABLE a RENAME COLUMN email TO mail; DROP TABLE b; ALTER TABLE a RENAME TO alpha;"), ["table-dropped", "table-renamed", "column-removed", "column-renamed"]);
  // A default's value is not written out when the column's name looks like a secret.
  const m = schemaModel([added("m/V2__x.sql", "ALTER TABLE a ALTER COLUMN api_token SET DEFAULT 'hunter2'; ALTER TABLE a ALTER COLUMN email SET DEFAULT 'none';")], base);
  assert.deepEqual([colDetail(col(m, "a", "api_token")), colDetail(col(m, "a", "email"))], ["default changed", "default 'none' added"]);
  assert.ok(!JSON.stringify(schemaMd(m, { table: (h, rows) => rows.map((r) => r.join("|")) })).includes("hunter2"), "nor in the Markdown");
  const N = [["varchar(200)", "varchar(80)", true], ["varchar(80)", "varchar(200)", false], ["text", "varchar(80)", true], ["varchar", "varchar(80)", true], ["String", "VarChar(40)", true], ["String(120)", "String(60)", true], ["bigint", "integer", true], ["integer", "bigint", false], ["BigInteger", "SmallInteger", true],
    ["numeric(10, 2)", "numeric(8, 2)", true], ["numeric(10, 4)", "numeric(10, 2)", true], ["timestamptz", "date", true], ["timestamp with time zone", "date", true], ["double precision", "real", true], ["integer", "text", false], ["jsonb", "json", false], ["text", "text", false], [null, "text", false]];
  for (const [a, b, want] of N) assert.equal(narrower(a, b), want, `${a} → ${b}`);
}
// ---- Alembic and Prisma as series
{
  const rev = (id, down, body, dn = "    pass") => `revision = '${id}'\ndown_revision = ${down ? `'${down}'` : "None"}\n\ndef upgrade():\n${body}\n\ndef downgrade():\n${dn}\n`;
  // The revisions' chain orders the files, not their names.
  const older = [other("alembic/versions/zz_first.py", rev("a1", null, "    op.create_table('members', sa.Column('id', sa.Integer(), primary_key=True), sa.Column('email', sa.String(120)))")), other("alembic/versions/aa_second.py", rev("b2", "a1", "    op.add_column('members', sa.Column('phone', sa.String(40)))")),
    other("alembic/versions/__init__.py", ""), other("alembic/env.py", "down_revision = 1")];
  const m = schemaModel([added("alembic/versions/mm_third.py", rev("c3", "b2", "    op.alter_column('members', 'email', type_=sa.String(60), nullable=False)\n    op.drop_column('members', 'phone')\n    op.create_index('ix_members_email', 'members', ['email'], unique=True)"))], older);
  assert.deepEqual([m.groups, rowsText(m, "members"), rules(m)], [[{ id: "alembic:alembic/versions", label: "alembic/versions", kind: "Alembic" }], ["added", "+ unique index ix_members_email (email)", "changed", "~ email String(120) → String(60), now not null", "removed", "− phone String(40)", "+ 1 unchanged"],
    ["column-removed", "not-null", "narrowed", "unique", "index-blocks", "no-down"]], "an empty downgrade is named; a file that is no revision is left out");
  assert.match(m.risks.at(-1).text, /^mm_third\.py has an empty downgrade: a rollback may not undo this migration\.$/);
  assert.deepEqual(rules(schemaModel([added("alembic/versions/mm_third.py", rev("c3", "b2", "    op.add_column('members', sa.Column('n', sa.Integer()))", "    op.drop_column('members', 'n')"))], older)), []);
  // Prisma: both sides of the one file.
  const head = (extra, provider = "postgresql") => `datasource db {\n  provider = "${provider}"\n}\nmodel Member {\n  id    Int    @id\n  email String @db.VarChar(120)\n  loans Loan[]\n}\nmodel Loan {\n  id       Int    @id\n  memberId Int\n  member   Member @relation(fields: [memberId], references: [id])\n${extra}}\n`;
  const before = "datasource db {\n  provider = \"postgresql\"\n}\nmodel Member {\n  id    Int    @id\n  email String @db.VarChar(255)\n  phone String?\n}\nmodel Shelf {\n  id Int @id\n}\n";
  const p = schemaModel([changed("prisma/schema.prisma", before, head("  note String\n"))]);
  assert.deepEqual([p.groups, p.cards.map((c) => [c.name, c.status]), rowsText(p, "Member"), p.edges.map((e) => [e.label, e.status]), rules(p)],
    [[{ id: "prisma:prisma/schema.prisma", label: "prisma/schema.prisma", kind: "Prisma" }], [["Loan", "added"], ["Member", "changed"], ["Shelf", "removed"]], ["changed", "~ email VarChar(255) → VarChar(120)", "removed", "− phone String", "+ 1 unchanged"], [["memberId, n to 1, added", "new"]], ["table-dropped", "column-removed", "narrowed", "fk-no-index"]]);
  assert.deepEqual([card(p, "Member").at, card(p, "Loan").at, card(p, "Shelf").at], ["prisma/schema.prisma:6", "prisma/schema.prisma:9", "prisma/schema.prisma"], "a card leads to its model, a changed one to its first changed field");
  assert.deepEqual(rules(schemaModel([changed("prisma/schema.prisma", before.replace("postgresql", "mysql"), head("", "mysql"))])), ["table-dropped", "column-removed", "narrowed"], "the provider says whether a foreign key needs its own index");
  assert.deepEqual(rules(schemaModel([changed("prisma/schema.prisma", before, head("  @@index([memberId])\n"))])), ["table-dropped", "column-removed", "narrowed"]);
  // The SQL Prisma wrote from the schema says the same: not drawn a second time.
  const both = schemaModel([changed("prisma/schema.prisma", before, head("")), added("prisma/migrations/20240102_loans/migration.sql", "CREATE TABLE \"Loan\" (id int);")]);
  assert.deepEqual([both.groups.map((g) => g.kind), both.notes], [["Prisma"], ["prisma/migrations is not drawn: prisma/schema.prisma describes the same change."]]);
  // An implicit many-to-many is one relation; a model the reader does not understand is said to have changed.
  const tags = (extra) => `model Post {\n  id   Int   @id\n${extra}}\nmodel Tag {\n  id    Int    @id\n  posts Post[]\n}\n`;
  const mm = schemaModel([changed("schema.prisma", tags("").replace("  posts Post[]\n", ""), tags("  tags Tag[]\n"))]);
  assert.deepEqual([mm.cards.map((c) => [c.name, c.status]), mm.edges.map((e) => [edgeText(e, (id) => id.split("|")[1]), e.status])], [[["Post", "changed"], ["Tag", "changed"]], [["Post → Tag, n to m, added", "new"]]]);
  const odd = schemaModel([changed("schema.prisma", "model A {\n  id Int @id\n  odd line (\n}\n", "model A {\n  id Int @id\n  odd line ((\n}\n")]);
  assert.deepEqual([card(odd, "A").status, rowsText(odd, "A")], ["changed", ["Changed; its definition is not read in detail", "Not all of its columns are read"]]);
}
// ---- cards: long tables, big schemas, findings, the picture
{
  const wide = schemaModel([added("m/V1__w.sql", `CREATE TABLE wide (${Array.from({ length: 30 }, (_x, k) => `c${k} int`).join(", ")});`)]);
  const rows = cardRows(card(wide, "wide"), wide.risks);
  assert.deepEqual([rows.length, rows.at(-1).text, cardRows(card(wide, "wide"), wide.risks, Infinity).length], [SCHEMA_ROWS, "and 19 more", 30], "a long table ends in a count; the Markdown has every row");
  // Over SCHEMA_MAX tables: one card per area (a schema, or the name up to its first underscore).
  const big = schemaModel([added("m/V1__big.sql", [...Array.from({ length: 12 }, (_x, k) => `CREATE TABLE billing_t${k} (id int);`), ...Array.from({ length: 12 }, (_x, k) => `CREATE TABLE lib.t${k} (id int, b int REFERENCES billing_t0 (id));`), "CREATE TABLE solo (id int);"].join("\n"))]);
  const A = schemaArch(big);
  assert.deepEqual([big.cards.length > SCHEMA_MAX, A.nodes.map((n) => [n.label, n.description, n.status, n.rows.length]), A.folded, foldText(A.folded)], [true, [["billing: 12 tables", "12 added", "new", 12], ["lib: 12 tables", "12 added", "new", 12], ["solo", "V1__big.sql:25", "new", 1]], { areas: 2, cards: 24 }, "Over 20 tables: 24 tables of 2 areas are one card per area."]);
  assert.deepEqual(A.edges.map((e) => [e.from, e.to, e.label]), [["fold:sql:m|lib", "fold:sql:m|billing", ""]], "the relations between two areas are one line");
  assert.equal(schemaArch(M).folded, null);
  // A finding of the review on a line of a statement about a table stands at that table's card.
  const fs = [{ id: "f1", file: "db/migrations/V5__loan_renewals.sql", line: 3, severity: "medium", title: "Notes longer than 80 characters are cut" }, { id: "f2", file: "db/migrations/V5__loan_renewals.sql", line: 5, severity: "high", title: "The import still writes legacy_code" }, { id: "f3", file: "library/loans.py", line: 3, severity: "high", title: "Elsewhere" }];
  const marks = schemaMarks(M, fs);
  assert.deepEqual([...marks.nodes].map(([id, m]) => [id, m.n, m.severity]), [["sql:db/migrations|loans", 2, "high"]]);
  const P = schemaPicture(M, fs), loans = P.L.nodes.find((n) => n.id === "sql:db/migrations|loans"), plain = schemaPicture(M).L.nodes.find((n) => n.id === "sql:db/migrations|loans");
  assert.deepEqual([P.L.nodes.length, P.arch.nodes.find((n) => n.id === loans.id).rows.length, loans.h > plain.h], [6, 10, true], "the card is as high as its rows and its mark need");
  assert.ok(P.L.nodes.every((n) => n.h >= 8 + 17 + (n.rows?.length ?? 0) * 18), "every row has its 18 px");
  assert.deepEqual([...new Set(P.L.paths.flatMap((p) => p.edges.map((i) => P.arch.edges[i].status)))].sort(), ["new", "removed", "unchanged"], "the relations are the picture's lines");
  // One pass: the layout of a big schema stays far from the 50 ms a render may take.
  const t0 = performance.now(); for (let k = 0; k < 5; k++) schemaPicture(big); const ms = (performance.now() - t0) / 5;
  assert.ok(ms < 40, `the layout of a folded schema takes ${ms.toFixed(1)} ms`);
  const t1 = performance.now(); for (let k = 0; k < 5; k++) schemaPicture(M, fs); const ms1 = (performance.now() - t1) / 5;
  assert.ok(ms1 < 40, `the layout of the fixture takes ${ms1.toFixed(1)} ms`);
  // 200 older migrations and a PR's three: read file by file.
  const many = Array.from({ length: 200 }, (_x, k) => other(`db/migrations/V0_${k}__t.sql`, `CREATE TABLE t${k} (id bigserial PRIMARY KEY, a_id bigint REFERENCES t${Math.max(0, k - 1)} (id), name varchar(80) NOT NULL DEFAULT 'x');\nCREATE INDEX t${k}_a ON t${k} (a_id);\nALTER TABLE t${k} ADD COLUMN n int;`));
  let pauses = 0, g = schemaSteps(fxPatch, [...fxOthers, ...many]), r = g.next();
  for (; !r.done; r = g.next()) pauses++;
  assert.ok(pauses >= 206 && r.value.cards.length === M.cards.length, "the window can pause after every file read (schema-view.js does, every 12 ms)");
  console.log(`schema: layout ${ms1.toFixed(1)} ms (fixture), ${ms.toFixed(1)} ms (folded)`);
}
// ---- Copy as Markdown
{
  const table = (head, rows) => (rows.length ? [`| ${head.join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`), ""] : []);
  const md = schemaMd(M, { table, findings: [{ id: "f1", file: "db/migrations/V5__loan_renewals.sql", line: 3, severity: "medium", title: "Notes longer than 80 characters are cut" }] }), text = md.join("\n");
  assert.deepEqual(md.slice(0, 4), ["## Schema changes (5)", "", SCHEMA_SOURCE, ""], "the section says where it comes from");
  assert.match(text, /\n5 tables: 1 added, 3 changed, 1 removed\. 1 unchanged one is related to what changed\. A table's and a column's state is a comment in the diagram;/);
  // What comes from the PR (names, types, values, paths, and the sentences made of them) is a code span each.
  for (const want of ["| `loans` | changed | `note varchar(80)` | `changed: varchar(200) → varchar(80)` | may be risky | `db/migrations/V5__loan_renewals.sql:3` |", "| `loans` | changed |  | `added index loans_due_idx (due_date)` | may be risky | `db/migrations/V5__loan_renewals.sql:7` |", "| `loans` | changed |  | `+ 5 unchanged` |  |  |",
    "| `reservations` | added | `book_id bigint foreign key not null` |  | may be risky | `db/migrations/V4__reservations.sql:5` |", "| `shelves` | removed |  | `Dropped with its 2 columns` | may be risky | `db/migrations/V6__members_and_shelves.sql:6` |", "| `loans` | medium: Notes longer than 80 characters are cut |",
    "### Relations (6)", "- `reservations (book_id) → books (id), n to 1, added` (`db/migrations/V4__reservations.sql:5`)", "### May be risky for live data (10)", "From fixed rules over the changes above, not from a review.", "- `Column loans.note narrows from varchar(200) to varchar(80): existing values may not fit.` (`db/migrations/V5__loan_renewals.sql:3`)"])
    assert.ok(md.includes(want), `the Markdown has: ${want}`);
  // A name and a value written to break out of it: a table name with a line break, a fence, an image and a mention
  // stays one comment line inside the Mermaid block and one code span in the table; nothing of it is live Markdown.
  { const evil = 'CREATE TABLE "t\n```\n\n![x](https://example.invalid/p.png) @octo-org/everyone\n\n```mermaid" (id int PRIMARY KEY, "c\n```\nINJ" int DEFAULT 7);';
    const out = schemaMd(schemaModel([added("db/migrate/V1__a.sql", evil)]), { table });
    assert.deepEqual(out.filter((l) => /^ {0,3}```/.test(l)), ["```mermaid", "```"], "the only fences are the diagram's own");
    const from = out.indexOf("```mermaid"), to = out.indexOf("```");
    for (const [k, l] of out.entries()) if (/@octo-org|!\[x\]|INJ/.test(l)) assert.ok((k > from && k < to && !/[`"]/.test(l)) || /^(\| |- )`[^`]*`/.test(l), `inert: ${l}`);
    assert.ok(out.some((l) => l.startsWith("| `t ''' ![x](https://example.invalid/p.png) @octo-org/everyone '''mermaid` | added | ")), "the name is one code span, its backticks gone"); }
  // The diagram as Mermaid reads an erDiagram: tables with "type name keys comment", relations between tables it has.
  const er = schemaMermaid(M), names = new Set();
  assert.equal(er[0], "erDiagram");
  for (const l of er.slice(1)) {
    const ent = /^  ([A-Za-z_][\w-]*)( \{)?$/.exec(l), rel = /^  ([A-Za-z_][\w-]*) (?:\}o|\|o)(?:--|\.\.)(?:\|\||o\{) ([A-Za-z_][\w-]*) : "[^"]+"$/.exec(l);
    if (ent) names.add(ent[1]); else if (rel) assert.ok(names.has(rel[1]) && names.has(rel[2]), `a relation between tables of the diagram: ${l}`);
    else assert.match(l, /^  (%% .+|\}|  [A-Za-z_][\w()[\]-]* [A-Za-z_][\w()[\]-]*( (PK|FK|UK)(, (PK|FK|UK))*)?( "[^"]*")?)$/, `a line of an erDiagram: ${l}`);
  }
  assert.ok(er.includes("  %% loans: changed, 2 unchanged columns left out") && er.includes('    varchar(80) note "changed: varchar(200) → varchar(80)"') && er.includes("  shelves") && er.includes('  books }o..|| shelves : "shelf_id, removed"') && er.includes('  reservations }o--|| books : "book_id, n to 1, added"'), "state as a comment, a removed relation dashed");
  assert.deepEqual(schemaMermaid(schemaModel([added("m/V1__t.sql", 'CREATE TABLE "my table" (id int PRIMARY KEY, amount numeric(10, 2), "a b" timestamp with time zone, other_id int UNIQUE REFERENCES "my table" (id));')])),
    ["erDiagram", "  %% my table: added", "  my_table {", "    int id PK", "    numeric(10_2) amount", "    timestamp_with_time_zone a_b", "    int other_id FK, UK", "  }"], "names and types as Mermaid takes them; a table's key to itself is a mark, not a line");
  assert.deepEqual(schemaMd(null, { table }), []);
  const notes = schemaMd(schemaModel(fxPatch), { table }).join("\n");
  assert.match(notes, /\n- `The earlier migrations of db\/migrations are not loaded yet, so a table shows only what this PR changes\.`\n/);
}
console.log("schema: ok");
