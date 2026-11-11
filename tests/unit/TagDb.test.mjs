import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDb, makeStore, FakeConnection } from "./helpers.mjs";

const URL_A = "https://example.org/work-only";

test("init creates the meta, page_tags, origin_tags and search_tags tables", async () => {
  const { conn } = await makeDb();
  const tables = conn.rows("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name);
  assert.deepEqual(tables, ["meta", "origin_tags", "page_tags", "search_tags"]);
});

test("init records schema_version 1 and an installed_at timestamp in meta", async () => {
  const { db } = await makeDb();
  assert.equal(await db.getMeta("schema_version"), "1");
  assert.ok(Number(await db.getMeta("installed_at")) > 0);
});

test("init on an existing database keeps the original installed_at", async () => {
  const conn = new FakeConnection();
  const first = await makeDb({ conn });
  const installedAt = await first.db.getMeta("installed_at");
  const second = await makeDb({ conn });
  assert.equal(await second.db.getMeta("installed_at"), installedAt);
});

test("flush writes a queued page visit as one page_tags row with visit_count 1", async () => {
  const { db, conn } = await makeDb();
  db.enqueue("page", URL_A, 1, "space-a", 1000);
  await db.flush();
  assert.deepEqual(conn.rows("SELECT * FROM page_tags"), [
    { url: URL_A, user_context_id: 1, space_id: "space-a", first_seen: 1000, last_seen: 1000, visit_count: 1 },
  ]);
});

test("a repeat visit after a flush updates last_seen and increments visit_count but keeps first_seen", async () => {
  const { db, conn } = await makeDb();
  db.enqueue("page", URL_A, 1, "space-a", 1000);
  await db.flush();
  db.enqueue("page", URL_A, 1, "space-a", 2000);
  await db.flush();
  assert.deepEqual(conn.rows("SELECT first_seen, last_seen, visit_count FROM page_tags"), [
    { first_seen: 1000, last_seen: 2000, visit_count: 2 },
  ]);
});

test("three visits to the same page queued before one flush produce visit_count 3", async () => {
  const { db, conn } = await makeDb();
  db.enqueue("page", URL_A, 1, "space-a", 1000);
  db.enqueue("page", URL_A, 1, "space-a", 1500);
  db.enqueue("page", URL_A, 1, "space-a", 2000);
  await db.flush();
  assert.deepEqual(conn.rows("SELECT first_seen, last_seen, visit_count FROM page_tags"), [
    { first_seen: 1000, last_seen: 2000, visit_count: 3 },
  ]);
});

test("flush writes a queued search term with its engine id and use_count", async () => {
  const { db, conn } = await makeDb();
  db.enqueue("term", "alpha zebra", 2, "space-b", 1000, { engineId: "google" });
  await db.flush();
  assert.deepEqual(conn.rows("SELECT * FROM search_tags"), [
    { term: "alpha zebra", user_context_id: 2, space_id: "space-b", engine_id: "google", last_seen: 1000, use_count: 1 },
  ]);
});

test("flush writes a queued origin tag with its last_seen time", async () => {
  const { db, conn } = await makeDb();
  db.enqueue("origin", "example.org", 2, "", 1234);
  await db.flush();
  assert.deepEqual(conn.rows("SELECT * FROM origin_tags"), [
    { origin: "example.org", user_context_id: 2, space_id: "", last_seen: 1234 },
  ]);
});

test("enqueue schedules one flush timer of 5000 ms for the first pending row", async () => {
  const { db, timers } = await makeDb();
  db.enqueue("page", URL_A, 1, "", 1000);
  db.enqueue("page", "https://example.org/b", 1, "", 1000);
  assert.deepEqual(timers.pendingDelays(), [5000]);
});

test("the 5000 ms timer flushes the pending rows to the database", async () => {
  const { db, conn, timers } = await makeDb();
  db.enqueue("page", URL_A, 1, "", 1000);
  await timers.fireAll();
  await db.idle();
  assert.equal(conn.rows("SELECT COUNT(*) AS n FROM page_tags")[0].n, 1);
});

test("the queue flushes on its own once 100 rows are pending, without waiting for the timer", async () => {
  const { db, conn } = await makeDb();
  for (let index = 0; index < 100; index++) {
    db.enqueue("page", `https://example.org/${index}`, 1, "", 1000);
  }
  await db.idle();
  assert.equal(conn.rows("SELECT COUNT(*) AS n FROM page_tags")[0].n, 100);
  assert.equal(db.pendingCount, 0);
});

test("a flush of many rows runs inside a single transaction", async () => {
  const { db, conn } = await makeDb();
  let transactions = 0;
  const original = conn.executeTransaction.bind(conn);
  conn.executeTransaction = (callback) => {
    transactions++;
    return original(callback);
  };
  for (let index = 0; index < 50; index++) {
    db.enqueue("page", `https://example.org/${index}`, 1, "", 1000);
  }
  await db.flush();
  assert.equal(transactions, 1);
});

test("rows from a failed flush are kept pending and written by the next flush", async () => {
  const { db, conn, errors } = await makeDb();
  db.enqueue("page", URL_A, 1, "", 1000);
  const original = conn.executeTransaction.bind(conn);
  conn.executeTransaction = async () => {
    throw new Error("database is locked");
  };
  await db.flush();
  assert.equal(errors.length, 1);
  assert.equal(db.pendingCount, 1);
  conn.executeTransaction = original;
  await db.flush();
  assert.equal(conn.rows("SELECT COUNT(*) AS n FROM page_tags")[0].n, 1);
});

test("loadInto restores page, origin and term tags into the in-memory store", async () => {
  const { db } = await makeDb();
  db.enqueue("page", URL_A, 1, "space-a", 1000);
  db.enqueue("origin", "example.org", 1, "space-a", 1000);
  db.enqueue("term", "alpha zebra", 1, "space-a", 1000);
  await db.flush();
  const store = makeStore();
  await db.loadInto(store);
  assert.equal(store.has("page", URL_A, { dim: "c", id: 1 }), true);
  assert.equal(store.has("origin", "example.org", { dim: "s", id: "space-a" }), true);
  assert.equal(store.has("term", "alpha zebra", { dim: "c", id: 1 }), true);
});

test("deleteKey removes a page's persisted rows in every container", async () => {
  const { db, conn } = await makeDb();
  db.enqueue("page", URL_A, 1, "", 1000);
  db.enqueue("page", URL_A, 2, "", 1000);
  db.enqueue("page", "https://keep.example/", 1, "", 1000);
  await db.flush();
  await db.deleteKey("page", URL_A);
  assert.deepEqual(conn.rows("SELECT url FROM page_tags"), [{ url: "https://keep.example/" }]);
});

test("deleteKey discards a still-pending row for that page so a later flush does not resurrect it", async () => {
  const { db, conn } = await makeDb();
  db.enqueue("page", URL_A, 1, "", 1000);
  await db.deleteKey("page", URL_A);
  await db.flush();
  assert.equal(conn.rows("SELECT COUNT(*) AS n FROM page_tags")[0].n, 0);
});

test("deleteScope for a container removes that container's rows from all three tables", async () => {
  const { db, conn } = await makeDb();
  db.enqueue("page", URL_A, 2, "space-b", 1000);
  db.enqueue("origin", "example.org", 2, "space-b", 1000);
  db.enqueue("term", "alpha", 2, "space-b", 1000);
  db.enqueue("page", URL_A, 1, "space-a", 1000);
  await db.flush();
  db.enqueue("page", "https://pending.example/", 2, "space-b", 1000);
  await db.deleteScope("c", 2);
  await db.flush();
  assert.deepEqual(conn.rows("SELECT url, user_context_id FROM page_tags"), [{ url: URL_A, user_context_id: 1 }]);
  assert.equal(conn.rows("SELECT COUNT(*) AS n FROM origin_tags")[0].n, 0);
  assert.equal(conn.rows("SELECT COUNT(*) AS n FROM search_tags")[0].n, 0);
});

test("deleteScope for a Space removes that Space's rows and keeps other Spaces' rows", async () => {
  const { db, conn } = await makeDb();
  db.enqueue("page", URL_A, 1, "space-a", 1000);
  db.enqueue("page", URL_A, 1, "space-b", 1000);
  await db.flush();
  await db.deleteScope("s", "space-a");
  assert.deepEqual(conn.rows("SELECT space_id FROM page_tags"), [{ space_id: "space-b" }]);
});

test("clearAll empties all three tag tables and the pending queue but keeps meta", async () => {
  const { db, conn } = await makeDb();
  db.enqueue("page", URL_A, 1, "", 1000);
  db.enqueue("origin", "example.org", 1, "", 1000);
  db.enqueue("term", "alpha", 1, "", 1000);
  await db.flush();
  db.enqueue("page", "https://pending.example/", 1, "", 1000);
  await db.clearAll();
  await db.flush();
  const counts = ["page_tags", "origin_tags", "search_tags"].map((table) => conn.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n);
  assert.deepEqual(counts, [0, 0, 0]);
  assert.equal(await db.getMeta("schema_version"), "1");
});

test("enforceBudget deletes the least recently seen page rows down to the budget and returns them", async () => {
  const { db, conn } = await makeDb();
  for (let index = 0; index < 10; index++) {
    db.enqueue("page", `https://example.org/${index}`, 1, "", 1000 + index);
  }
  await db.flush();
  const removed = await db.enforceBudget("page", 7);
  assert.deepEqual(
    removed.map((row) => row.key).sort(),
    ["https://example.org/0", "https://example.org/1", "https://example.org/2"]
  );
  assert.equal(conn.rows("SELECT COUNT(*) AS n FROM page_tags")[0].n, 7);
  assert.deepEqual(removed[0], { key: removed[0].key, userContextId: 1, spaceId: "" });
});

test("enforceBudget removes nothing when the table is within budget", async () => {
  const { db } = await makeDb();
  db.enqueue("page", URL_A, 1, "", 1000);
  await db.flush();
  assert.deepEqual(await db.enforceBudget("page", 200000), []);
});

test("enforceBudget brings a 200,050-row page table down to the 200,000 row budget", async () => {
  const { db, conn } = await makeDb({ flushThreshold: Infinity });
  for (let index = 0; index < 200050; index++) {
    db.enqueue("page", `https://example.org/p/${index}`, index % 8, "", index);
  }
  await db.flush();
  const removed = await db.enforceBudget("page", 200000);
  assert.equal(removed.length, 50);
  assert.equal(conn.rows("SELECT COUNT(*) AS n FROM page_tags")[0].n, 200000);
  assert.equal(conn.rows("SELECT MIN(last_seen) AS oldest FROM page_tags")[0].oldest, 50);
});

test("expireTerms deletes search terms last seen before the cutoff and returns them", async () => {
  const { db, conn } = await makeDb();
  db.enqueue("term", "old term", 1, "space-a", 1000);
  db.enqueue("term", "new term", 1, "space-a", 9000);
  await db.flush();
  const removed = await db.expireTerms(5000);
  assert.deepEqual(removed, [{ key: "old term", userContextId: 1, spaceId: "space-a" }]);
  assert.deepEqual(conn.rows("SELECT term FROM search_tags"), [{ term: "new term" }]);
});

test("pageUrlsAfter pages through distinct URLs in order, starting after the given URL", async () => {
  const { db } = await makeDb();
  for (const name of ["a", "b", "c", "d", "e"]) {
    db.enqueue("page", `https://example.org/${name}`, 1, "", 1000);
    db.enqueue("page", `https://example.org/${name}`, 2, "", 1000);
  }
  await db.flush();
  const first = await db.pageUrlsAfter("", 2);
  const second = await db.pageUrlsAfter(first.at(-1), 2);
  assert.deepEqual(first, ["https://example.org/a", "https://example.org/b"]);
  assert.deepEqual(second, ["https://example.org/c", "https://example.org/d"]);
});

test("deletePages removes every row of each listed URL", async () => {
  const { db, conn } = await makeDb();
  db.enqueue("page", URL_A, 1, "", 1000);
  db.enqueue("page", URL_A, 2, "", 1000);
  db.enqueue("page", "https://keep.example/", 1, "", 1000);
  await db.flush();
  await db.deletePages([URL_A]);
  assert.deepEqual(conn.rows("SELECT url FROM page_tags"), [{ url: "https://keep.example/" }]);
});

test("exportAll returns every persisted row grouped by table", async () => {
  const { db } = await makeDb();
  db.enqueue("page", URL_A, 1, "space-a", 1000);
  db.enqueue("term", "alpha", 1, "space-a", 1000, { engineId: "ddg" });
  await db.flush();
  const dump = await db.exportAll();
  assert.equal(dump.schemaVersion, 1);
  assert.equal(dump.pages.length, 1);
  assert.equal(dump.pages[0].url, URL_A);
  assert.equal(dump.terms[0].engine_id, "ddg");
  assert.deepEqual(dump.origins, []);
});

test("close flushes pending rows before closing the connection", async () => {
  const conn = new FakeConnection();
  const { db } = await makeDb({ conn });
  db.enqueue("page", URL_A, 1, "", 1000);
  const before = () => conn.rows("SELECT COUNT(*) AS n FROM page_tags")[0].n;
  assert.equal(before(), 0);
  let rowsAtClose = -1;
  const originalClose = conn.close.bind(conn);
  conn.close = async () => {
    rowsAtClose = before();
    await originalClose();
  };
  await db.close();
  assert.equal(rowsAtClose, 1);
  assert.equal(conn.closed, true);
});

test("enqueue after close is ignored instead of throwing", async () => {
  const { db } = await makeDb();
  await db.close();
  db.enqueue("page", URL_A, 1, "", 1000);
  assert.equal(db.pendingCount, 0);
});
