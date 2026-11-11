import { test } from "node:test";
import assert from "node:assert/strict";
import { pageKey, originKeys, normalizeTerm } from "../../lib/UrlKey.sys.mjs";

test("pageKey keeps the exact URL spec, including fragment and tracking parameters", () => {
  const url = "https://example.org/a?utm_source=x#frag";
  assert.equal(pageKey(url), url);
});

test("originKeys returns the scheme+host and the bare host for a plain https URL", () => {
  assert.deepEqual(originKeys("https://example.org/path?q=1"), ["https://example.org", "example.org"]);
});

test("originKeys keeps www in the scheme+host key and strips it from the bare host key", () => {
  assert.deepEqual(originKeys("https://www.example.org/"), ["https://www.example.org", "example.org"]);
});

test("originKeys keeps a non-default port in the scheme+host key only", () => {
  assert.deepEqual(originKeys("http://localhost:8080/x"), ["http://localhost:8080", "localhost"]);
});

test("originKeys returns no keys for a URL without a host", () => {
  assert.deepEqual(originKeys("about:config"), []);
});

test("originKeys returns no keys for text that is not a URL", () => {
  assert.deepEqual(originKeys("not a url"), []);
});

test("normalizeTerm trims, collapses inner whitespace and lower-cases", () => {
  assert.equal(normalizeTerm("  Alpha   ZEBRA\t"), "alpha zebra");
});

test("normalizeTerm returns an empty string for a non-string value", () => {
  assert.equal(normalizeTerm(undefined), "");
});
