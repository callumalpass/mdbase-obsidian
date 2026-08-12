export interface DiffLine {
  kind: "same" | "local" | "remote";
  value: string;
}

const MAX_SOURCE_LINES = 200;
const MAX_OUTPUT_LINES = 300;

/** A bounded line diff for conflict review; synchronization decisions remain engine-owned. */
export function boundedLineDiff(local: string, remote: string): { lines: DiffLine[]; truncated: boolean } {
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");
  const sourceTruncated = localLines.length > MAX_SOURCE_LINES || remoteLines.length > MAX_SOURCE_LINES;
  const left = localLines.slice(0, MAX_SOURCE_LINES);
  const right = remoteLines.slice(0, MAX_SOURCE_LINES);
  const table = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      table[leftIndex][rightIndex] = left[leftIndex] === right[rightIndex]
        ? table[leftIndex + 1][rightIndex + 1] + 1
        : Math.max(table[leftIndex + 1][rightIndex], table[leftIndex][rightIndex + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    if (lines.length >= MAX_OUTPUT_LINES) break;
    if (leftIndex < left.length && rightIndex < right.length && left[leftIndex] === right[rightIndex]) {
      lines.push({ kind: "same", value: left[leftIndex] });
      leftIndex += 1;
      rightIndex += 1;
    } else if (rightIndex >= right.length || (leftIndex < left.length && table[leftIndex + 1][rightIndex] >= table[leftIndex][rightIndex + 1])) {
      lines.push({ kind: "local", value: left[leftIndex] });
      leftIndex += 1;
    } else {
      lines.push({ kind: "remote", value: right[rightIndex] });
      rightIndex += 1;
    }
  }
  return {
    lines,
    truncated: sourceTruncated || leftIndex < left.length || rightIndex < right.length,
  };
}
