import { TagStore } from "../lib/TagStore.sys.mjs";
import { makeDb, makeFilter, makeContext, makeHistoryResult, PROVIDER } from "./unit/helpers.mjs";

const ROWS = 200000;
const CONTAINERS = 8;

function makeUrl(index) {
  return `https://site-${index % 5000}.example.com/section/${index}/page-${(index * 2654435761) % 1000003}?ref=${index % 97}`;
}

function heapMb() {
  globalThis.gc?.();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

if (!globalThis.gc) {
  console.log("Run with --expose-gc (npm run bench) for a stable memory figure.");
}

const before = heapMb();
const store = new TagStore();
for (let index = 0; index < ROWS; index++) {
  const url = makeUrl(index);
  store.add("page", url, index % CONTAINERS, `space-${index % CONTAINERS}`);
}
const afterPages = heapMb();
console.log(`in-memory index, ${ROWS} page rows: ${(afterPages - before).toFixed(1)} MB heap`);

const { filter } = makeFilter({ store });
const samples = 200000;
const durations = new Float64Array(samples);
for (let sample = 0; sample < samples; sample++) {
  const context = makeContext({ userContextId: sample % CONTAINERS });
  const result = makeHistoryResult(makeUrl((sample * 7919) % (ROWS + 20000)));
  const started = process.hrtime.bigint();
  filter.shouldDrop(context, PROVIDER, result);
  durations[sample] = Number(process.hrtime.bigint() - started) / 1e6;
}
durations.sort();
console.log(
  `shouldDrop: p50 ${durations[samples >> 1].toFixed(5)} ms, p99 ${durations[Math.floor(samples * 0.99)].toFixed(5)} ms, max ${durations[samples - 1].toFixed(5)} ms`
);

const { db } = await makeDb({ flushThreshold: Infinity });
for (let index = 0; index < ROWS; index++) {
  db.enqueue("page", makeUrl(index), index % CONTAINERS, `space-${index % CONTAINERS}`, index);
}
await db.flush();
const loaded = new TagStore();
const started = performance.now();
await db.loadInto(loaded);
console.log(`load ${loaded.rowCount("page")} rows from SQLite (node:sqlite): ${(performance.now() - started).toFixed(0)} ms`);
