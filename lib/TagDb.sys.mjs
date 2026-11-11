export const SCHEMA_VERSION = 1;

const TABLES = Object.freeze({
  page: { table: "page_tags", keyColumn: "url" },
  origin: { table: "origin_tags", keyColumn: "origin" },
  term: { table: "search_tags", keyColumn: "term" },
});

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS page_tags (
    url             TEXT    NOT NULL,
    user_context_id INTEGER NOT NULL,
    space_id        TEXT    NOT NULL DEFAULT '',
    first_seen      INTEGER NOT NULL,
    last_seen       INTEGER NOT NULL,
    visit_count     INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (url, user_context_id, space_id)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS origin_tags (
    origin          TEXT    NOT NULL,
    user_context_id INTEGER NOT NULL,
    space_id        TEXT    NOT NULL DEFAULT '',
    last_seen       INTEGER NOT NULL,
    PRIMARY KEY (origin, user_context_id, space_id)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS search_tags (
    term            TEXT    NOT NULL,
    user_context_id INTEGER NOT NULL,
    space_id        TEXT    NOT NULL DEFAULT '',
    engine_id       TEXT,
    last_seen       INTEGER NOT NULL,
    use_count       INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (term, user_context_id, space_id)
  ) WITHOUT ROWID`,
];

const UPSERTS = Object.freeze({
  page: `INSERT INTO page_tags (url, user_context_id, space_id, first_seen, last_seen, visit_count)
    VALUES (:key, :ctx, :space, :first, :last, :count)
    ON CONFLICT (url, user_context_id, space_id)
    DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen), visit_count = visit_count + excluded.visit_count`,
  origin: `INSERT INTO origin_tags (origin, user_context_id, space_id, last_seen)
    VALUES (:key, :ctx, :space, :last)
    ON CONFLICT (origin, user_context_id, space_id)
    DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen)`,
  term: `INSERT INTO search_tags (term, user_context_id, space_id, engine_id, last_seen, use_count)
    VALUES (:key, :ctx, :space, :engine, :last, :count)
    ON CONFLICT (term, user_context_id, space_id)
    DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen),
      use_count = use_count + excluded.use_count,
      engine_id = COALESCE(excluded.engine_id, engine_id)`,
});

const MAX_PENDING_AFTER_FAILURE = 5000;
const DELETE_CHUNK = 200;

function upsertParams(row) {
  const base = { key: row.key, ctx: row.userContextId, space: row.spaceId, last: row.last };
  if (row.kind === "page") {
    return { ...base, first: row.first, count: row.count };
  }
  if (row.kind === "term") {
    return { ...base, engine: row.engineId ?? null, count: row.count };
  }
  return base;
}

export class TagDb {
  #conn;
  #setTimeout;
  #clearTimeout;
  #flushDelayMs;
  #flushThreshold;
  #onError;
  #pending = new Map();
  #timer = null;
  #chain = Promise.resolve();
  #closed = false;

  constructor({ conn, setTimeout, clearTimeout, flushDelayMs = 5000, flushThreshold = 100, onError = () => {} }) {
    this.#conn = conn;
    this.#setTimeout = setTimeout;
    this.#clearTimeout = clearTimeout;
    this.#flushDelayMs = flushDelayMs;
    this.#flushThreshold = flushThreshold;
    this.#onError = onError;
  }

  #run(task) {
    const result = this.#chain.then(task);
    this.#chain = result.catch(() => {});
    return result;
  }

  idle() {
    return this.#chain;
  }

  get pendingCount() {
    return this.#pending.size;
  }

  async init() {
    await this.#run(async () => {
      for (const statement of SCHEMA) {
        await this.#conn.execute(statement);
      }
      await this.#conn.execute(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', :value)`, {
        value: String(SCHEMA_VERSION),
      });
      await this.#conn.execute(`INSERT OR IGNORE INTO meta (key, value) VALUES ('installed_at', :value)`, {
        value: String(Date.now()),
      });
    });
  }

  async getMeta(key) {
    return this.#run(async () => {
      const rows = await this.#conn.execute(`SELECT value FROM meta WHERE key = :key`, { key });
      return rows.length ? rows[0].getResultByName("value") : null;
    });
  }

  async setMeta(key, value) {
    await this.#run(() =>
      this.#conn.execute(
        `INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        { key, value: String(value) }
      )
    );
  }

  async loadInto(store) {
    await this.#run(async () => {
      for (const [kind, { table, keyColumn }] of Object.entries(TABLES)) {
        const rows = await this.#conn.execute(`SELECT ${keyColumn} AS key, user_context_id, space_id FROM ${table}`);
        for (const row of rows) {
          store.add(kind, row.getResultByName("key"), row.getResultByName("user_context_id"), row.getResultByName("space_id"));
        }
      }
    });
  }

  enqueue(kind, key, userContextId, spaceId, time, { engineId = null } = {}) {
    if (this.#closed || !TABLES[kind]) {
      return;
    }
    const space = spaceId == null ? "" : String(spaceId);
    const pendingKey = `${kind}\n${userContextId}\n${space}\n${key}`;
    const existing = this.#pending.get(pendingKey);
    if (existing) {
      existing.first = Math.min(existing.first, time);
      existing.last = Math.max(existing.last, time);
      existing.count++;
      existing.engineId = engineId ?? existing.engineId;
    } else {
      this.#pending.set(pendingKey, { kind, key, userContextId, spaceId: space, first: time, last: time, count: 1, engineId });
    }
    if (this.#pending.size >= this.#flushThreshold) {
      this.flush();
    } else if (this.#timer === null) {
      this.#timer = this.#setTimeout(() => {
        this.#timer = null;
        return this.flush();
      }, this.#flushDelayMs);
    }
  }

  #cancelTimer() {
    if (this.#timer !== null) {
      this.#clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #dropPending(predicate) {
    for (const [pendingKey, row] of this.#pending) {
      if (predicate(row)) {
        this.#pending.delete(pendingKey);
      }
    }
  }

  flush() {
    this.#cancelTimer();
    return this.#run(async () => {
      if (!this.#pending.size || this.#closed) {
        return;
      }
      const batch = this.#pending;
      this.#pending = new Map();
      try {
        await this.#conn.executeTransaction(async () => {
          for (const row of batch.values()) {
            await this.#conn.executeCached(UPSERTS[row.kind], upsertParams(row));
          }
        });
      } catch (error) {
        this.#onError(error);
        if (batch.size + this.#pending.size <= MAX_PENDING_AFTER_FAILURE) {
          for (const [pendingKey, row] of this.#pending) {
            const earlier = batch.get(pendingKey);
            if (earlier) {
              earlier.first = Math.min(earlier.first, row.first);
              earlier.last = Math.max(earlier.last, row.last);
              earlier.count += row.count;
              earlier.engineId = row.engineId ?? earlier.engineId;
            } else {
              batch.set(pendingKey, row);
            }
          }
          this.#pending = batch;
        }
      }
    });
  }

  async deleteKey(kind, key) {
    const { table, keyColumn } = TABLES[kind];
    this.#dropPending((row) => row.kind === kind && row.key === key);
    await this.#run(() => this.#conn.execute(`DELETE FROM ${table} WHERE ${keyColumn} = :key`, { key }));
  }

  async deleteScope(dim, id) {
    const column = dim === "s" ? "space_id" : "user_context_id";
    this.#dropPending((row) => (dim === "s" ? row.spaceId === id : row.userContextId === id));
    await this.#run(() =>
      this.#conn.executeTransaction(async () => {
        for (const { table } of Object.values(TABLES)) {
          await this.#conn.execute(`DELETE FROM ${table} WHERE ${column} = :id`, { id });
        }
      })
    );
  }

  async clearAll() {
    this.#cancelTimer();
    this.#pending.clear();
    await this.#run(() =>
      this.#conn.executeTransaction(async () => {
        for (const { table } of Object.values(TABLES)) {
          await this.#conn.execute(`DELETE FROM ${table}`);
        }
      })
    );
  }

  async pageUrlsAfter(after, limit, seenBefore = Number.MAX_SAFE_INTEGER) {
    return this.#run(async () => {
      const rows = await this.#conn.execute(
        `SELECT url FROM page_tags WHERE url > :after GROUP BY url HAVING MAX(last_seen) < :before ORDER BY url LIMIT :limit`,
        { after, limit, before: seenBefore }
      );
      return rows.map((row) => row.getResultByName("url"));
    });
  }

  async deletePages(urls) {
    if (!urls.length) {
      return;
    }
    const doomed = new Set(urls);
    this.#dropPending((row) => row.kind === "page" && doomed.has(row.key));
    await this.#run(() =>
      this.#conn.executeTransaction(async () => {
        for (let offset = 0; offset < urls.length; offset += DELETE_CHUNK) {
          const chunk = urls.slice(offset, offset + DELETE_CHUNK);
          const placeholders = chunk.map(() => "?").join(", ");
          await this.#conn.execute(`DELETE FROM page_tags WHERE url IN (${placeholders})`, chunk);
        }
      })
    );
  }

  async #deleteReturning(kind, whereSql, params) {
    const { table, keyColumn } = TABLES[kind];
    return this.#run(() =>
      this.#conn.executeTransaction(async () => {
        const select = `SELECT ${keyColumn} AS key, user_context_id, space_id FROM ${table} ${whereSql}`;
        const rows = await this.#conn.execute(select, params);
        if (!rows.length) {
          return [];
        }
        await this.#conn.execute(
          `DELETE FROM ${table} WHERE (${keyColumn}, user_context_id, space_id) IN (
            SELECT ${keyColumn}, user_context_id, space_id FROM ${table} ${whereSql})`,
          params
        );
        return rows.map((row) => ({
          key: row.getResultByName("key"),
          userContextId: row.getResultByName("user_context_id"),
          spaceId: row.getResultByName("space_id"),
        }));
      })
    );
  }

  async expireTerms(cutoffMs) {
    return this.#deleteReturning("term", `WHERE last_seen < :cutoff`, { cutoff: cutoffMs });
  }

  async enforceBudget(kind, budget) {
    const { table, keyColumn } = TABLES[kind];
    const count = await this.#run(async () => {
      const rows = await this.#conn.execute(`SELECT COUNT(*) AS n FROM ${table}`);
      return rows[0].getResultByName("n");
    });
    const excess = count - budget;
    if (excess <= 0) {
      return [];
    }
    return this.#deleteReturning(kind, `ORDER BY last_seen ASC, ${keyColumn} ASC LIMIT :excess`, { excess });
  }

  async exportAll() {
    return this.#run(async () => {
      const dump = { schemaVersion: SCHEMA_VERSION };
      const columns = {
        pages: ["page_tags", ["url", "user_context_id", "space_id", "first_seen", "last_seen", "visit_count"]],
        origins: ["origin_tags", ["origin", "user_context_id", "space_id", "last_seen"]],
        terms: ["search_tags", ["term", "user_context_id", "space_id", "engine_id", "last_seen", "use_count"]],
      };
      for (const [name, [table, names]] of Object.entries(columns)) {
        const rows = await this.#conn.execute(`SELECT ${names.join(", ")} FROM ${table}`);
        dump[name] = rows.map((row) => Object.fromEntries(names.map((column) => [column, row.getResultByName(column)])));
      }
      return dump;
    });
  }

  async close() {
    if (this.#closed) {
      return;
    }
    await this.flush();
    this.#closed = true;
    this.#cancelTimer();
    this.#pending.clear();
    await this.#run(() => this.#conn.close());
  }
}
