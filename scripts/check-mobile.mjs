import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";

const bundle = await readFile(new URL("../main.js", import.meta.url));
const source = bundle.toString("utf8");
const gzipBytes = gzipSync(bundle).byteLength;
// beta.68 includes the complete digest-verified collection-file data plane and
// engine-owned sync plans. Keep a narrow margin over its measured production
// bundle so later growth is visible.
const rawBudget = 640 * 1024;
const gzipBudget = 185 * 1024;
const forbidden = [
  /require\((["'])node:(?:fs|path|crypto|os|worker_threads|child_process)\1\)/,
  /require\((["'])(?:fs|path|crypto|os|worker_threads|child_process)\1\)/,
  /from (["'])node:(?:fs|path|crypto|os|worker_threads|child_process)\1/,
];

const violations = forbidden.filter((pattern) => pattern.test(source));
if (violations.length) {
  throw new Error("Mobile bundle contains a Node-only runtime import.");
}
if (bundle.byteLength > rawBudget) {
  throw new Error(`Mobile bundle is ${bundle.byteLength} bytes; budget is ${rawBudget}.`);
}
if (gzipBytes > gzipBudget) {
  throw new Error(`Gzipped mobile bundle is ${gzipBytes} bytes; budget is ${gzipBudget}.`);
}

console.log(JSON.stringify({
  mobile_safe: true,
  raw_bytes: bundle.byteLength,
  gzip_bytes: gzipBytes,
  raw_budget: rawBudget,
  gzip_budget: gzipBudget,
}));
