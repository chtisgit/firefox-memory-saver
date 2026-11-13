// Optional Node runner for the same suite used by tests/index.html.
const results = [];
const summary = {};
globalThis.document = {
  querySelector(selector) {
    return selector === "#results" ? { append(item) { results.push(item); } } : summary;
  },
  createElement() { return {}; },
};
await import("./test.js");
for (const item of results.filter((result) => result.className === "fail")) console.error(item.textContent);
console.log(summary.textContent);
if (summary.className === "fail") process.exitCode = 1;
