import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const rows = Array.from({ length: 5_000 }, (_, id) => ({ id }));
const selectedIds = Array.from({ length: 2_000 }, (_, index) => index * 2);
const selectedIdSet = new Set(selectedIds);

function filterWithArray() {
  return rows.filter((row) => selectedIds.includes(row.id));
}

function filterWithSet() {
  return rows.filter((row) => selectedIdSet.has(row.id));
}

assert.deepEqual(filterWithArray(), filterWithSet());

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(fn) {
  const samples = [];
  for (let run = 0; run < 7; run += 1) {
    const start = performance.now();
    const result = fn();
    checksum += result.length;
    samples.push(performance.now() - start);
  }
  return median(samples);
}

let checksum = 0;

for (let warmup = 0; warmup < 3; warmup += 1) {
  filterWithArray();
  filterWithSet();
}

console.log(
  JSON.stringify(
    {
      node: process.version,
      rows: rows.length,
      selectedIds: selectedIds.length,
      warmupRuns: 3,
      measuredRuns: 7,
      medianMs: {
        arrayIncludes: Number(measure(filterWithArray).toFixed(3)),
        reusedSet: Number(measure(filterWithSet).toFixed(3)),
      },
      measuredResultCount: checksum,
      note: "Synthetic in-memory workload; not an API or database benchmark.",
    },
    null,
    2,
  ),
);
