import { describe, it, expect } from "vitest";
import { wrapCommand, parseExecOutput } from "../src/commands/exec.js";

describe("wrapCommand", () => {
  it("runs the command in a subshell and appends the exit marker", () => {
    const wrapped = wrapCommand("echo hello");
    expect(wrapped).toContain("(\necho hello\n)");
    expect(wrapped).toContain("__TERMIX_EXIT=%d");
  });

  it("contains an explicit exit inside the subshell", () => {
    // `exit 3` must terminate only the subshell, not skip the marker.
    const wrapped = wrapCommand("exit 3");
    expect(wrapped.indexOf("exit 3")).toBeLessThan(
      wrapped.indexOf("__TERMIX_EXIT"),
    );
  });
});

describe("parseExecOutput", () => {
  it("extracts the exit code and strips the marker", () => {
    expect(parseExecOutput("hello\n\n__TERMIX_EXIT=0\n")).toEqual({
      output: "hello\n",
      exitCode: 0,
    });
  });

  it("preserves non-zero exit codes", () => {
    expect(parseExecOutput("boom\n\n__TERMIX_EXIT=3\n")).toEqual({
      output: "boom\n",
      exitCode: 3,
    });
  });

  it("handles empty command output", () => {
    expect(parseExecOutput("\n__TERMIX_EXIT=0\n")).toEqual({
      output: "",
      exitCode: 0,
    });
  });

  it("returns null exit code when the marker is missing (server timeout)", () => {
    expect(parseExecOutput("partial output")).toEqual({
      output: "partial output",
      exitCode: null,
    });
  });

  it("only strips the marker at the very end of the output", () => {
    const raw = "__TERMIX_EXIT=9 in the middle\n\n__TERMIX_EXIT=1\n";
    expect(parseExecOutput(raw)).toEqual({
      output: "__TERMIX_EXIT=9 in the middle\n",
      exitCode: 1,
    });
  });
});
