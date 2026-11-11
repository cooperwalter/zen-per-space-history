import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDb, makeFilter, makeStore, makeContext, makeHistoryResult, PROVIDER } from "./helpers.mjs";

const ROWS = 200000;
const CONTAINERS = 8;

function makeUrl(index) {
  return `https://site-${index % 5000}.example.com/section/${index}/page-${(index * 2654435761) % 1000003}?ref=${index % 97}`;
}

test("shouldDrop p99 stays under 0.05 ms with 200,000 tagged pages across 8 containers", () => {
  const { filter, store } = makeFilter();
  for (let index = 0; index < ROWS; index++) {
    store.add("page", makeUrl(index), index % CONTAINERS, `space-${index % CONTAINERS}`);
  }
  const samples = 100000;
  const durations = new Float64Array(samples);
  for (let sample = 0; sample < samples; sample++) {
    const index = (sample * 7919) % (ROWS + 20000);
    const context = makeContext({ userContextId: sample % CONTAINERS });
    const result = makeHistoryResult(makeUrl(index));
    const started = process.hrtime.bigint();
    filter.shouldDrop(context, PROVIDER, result);
    durations[sample] = Number(process.hrtime.bigint() - started) / 1e6;
  }
  durations.sort();
  const p99 = durations[Math.floor(samples * 0.99)];
  assert.ok(p99 < 0.05, `p99 was ${p99} ms`);
});

test("loading a 200,000-row database into the in-memory index takes under 500 ms", async () => {
  const { db } = await makeDb({ flushThreshold: Infinity });
  for (let index = 0; index < ROWS; index++) {
    db.enqueue("page", makeUrl(index), index % CONTAINERS, `space-${index % CONTAINERS}`, index);
  }
  await db.flush();
  const store = makeStore();
  const started = performance.now();
  await db.loadInto(store);
  const elapsed = performance.now() - started;
  assert.equal(store.rowCount("page"), ROWS);
  assert.ok(elapsed < 500, `load took ${elapsed.toFixed(0)} ms`);
});
