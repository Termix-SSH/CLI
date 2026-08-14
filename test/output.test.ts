import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  configureOutput,
  printList,
  printRecord,
  printResult,
  type Column,
} from "../src/core/output/index.js";

interface Row extends Record<string, unknown> {
  id: number;
  name: string;
}

const rows: Row[] = [
  { id: 1, name: "alpha" },
  { id: 2, name: "beta" },
];

const columns: Column<Row>[] = [
  { header: "id", value: (r) => r.id },
  { header: "name", value: (r) => r.name },
];

let stdout: string;
let stderr: string;

beforeEach(() => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("output mode selection", () => {
  it("renders a table on a terminal", () => {
    configureOutput({}, {} as NodeJS.ProcessEnv, true);
    printList(rows, columns);
    expect(stdout).toContain("alpha");
    expect(stdout).toContain("NAME");
  });

  it("switches to JSON when stdout is not a terminal", () => {
    configureOutput({}, {} as NodeJS.ProcessEnv, false);
    printList(rows, columns);
    expect(JSON.parse(stdout)).toEqual(rows);
  });

  it("honours --quiet even when piped", () => {
    // Regression: json is inferred from the pipe, but --quiet is explicit, so
    // it has to win. Checking json first made --quiet do nothing under a pipe,
    // which is exactly where it is used.
    configureOutput({ quiet: true }, {} as NodeJS.ProcessEnv, false);
    printList(rows, columns);
    expect(stdout).toBe("1\n2\n");
  });

  it("honours --quiet for a single record when piped", () => {
    configureOutput({ quiet: true }, {} as NodeJS.ProcessEnv, false);
    printRecord({ id: 7, name: "gamma" });
    expect(stdout).toBe("7\n");
  });

  it("honours --quiet for a mutation result when piped", () => {
    configureOutput({ quiet: true }, {} as NodeJS.ProcessEnv, false);
    printResult("Created host 9.", { id: 9 });
    expect(stdout).toBe("9\n");
  });

  it("still emits JSON for a mutation when only piped", () => {
    configureOutput({}, {} as NodeJS.ProcessEnv, false);
    printResult("Created host 9.", { id: 9 });
    expect(JSON.parse(stdout)).toEqual({ success: true, id: 9 });
  });

  it("keeps an empty result off stdout", () => {
    configureOutput({}, {} as NodeJS.ProcessEnv, true);
    printList([], columns);
    expect(stdout).toBe("");
    expect(stderr).toContain("No results");
  });
});
