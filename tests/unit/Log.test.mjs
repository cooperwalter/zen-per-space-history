import { test } from "node:test";
import assert from "node:assert/strict";
import { createLog } from "../../lib/Log.sys.mjs";

function makeSink() {
  const calls = [];
  const record = (level) => (...args) => calls.push([level, ...args]);
  return { calls, log: record("log"), info: record("info"), warn: record("warn"), error: record("error") };
}

test("debug writes nothing while the debug pref is off", () => {
  const sink = makeSink();
  createLog({ isDebug: () => false, sink }).debug("dropped", 3);
  assert.deepEqual(sink.calls, []);
});

test("debug writes a [PerSpaceHistory]-prefixed line while the debug pref is on", () => {
  const sink = makeSink();
  createLog({ isDebug: () => true, sink }).debug("dropped", 3);
  assert.deepEqual(sink.calls, [["log", "[PerSpaceHistory]", "dropped", 3]]);
});

test("error always writes, even with the debug pref off", () => {
  const sink = makeSink();
  createLog({ isDebug: () => false, sink }).error("boom");
  assert.deepEqual(sink.calls, [["error", "[PerSpaceHistory]", "boom"]]);
});

test("errorOnce logs the same error message only once per tag", () => {
  const sink = makeSink();
  const log = createLog({ isDebug: () => false, sink });
  assert.equal(log.errorOnce("filter", new Error("bad result")), true);
  assert.equal(log.errorOnce("filter", new Error("bad result")), false);
  assert.equal(sink.calls.length, 1);
});

test("errorOnce logs again for a different error message under the same tag", () => {
  const sink = makeSink();
  const log = createLog({ isDebug: () => false, sink });
  log.errorOnce("filter", new Error("bad result"));
  log.errorOnce("filter", new Error("other failure"));
  assert.equal(sink.calls.length, 2);
});
