import type { ExecFileException } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createQmdRunner, type QmdExecFile } from "../src/qmd.js";

function createExecStub(
  impl: (
    file: string,
    args: readonly string[],
    callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
  ) => void,
): QmdExecFile {
  return ((file, args, _options, callback) => {
    impl(file, args, callback);
    return {} as never;
  }) as QmdExecFile;
}

describe("createQmdRunner", () => {
  it("returns text and parsed json on successful json output", async () => {
    const execStub = createExecStub((_, __, callback) => {
      callback(null, '[{"file":"notes/test.md"}]', "");
    });

    const runQmd = createQmdRunner(execStub);
    const result = await runQmd({
      command: "qmd",
      args: ["query", "hello", "--json"],
      timeoutMs: 1000,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({
      type: "text",
      text: '[{"file":"notes/test.md"}]',
    });
    expect(result.details).toEqual([{ file: "notes/test.md" }]);
  });

  it("marks missing command as error with a clear message", async () => {
    const execStub = createExecStub((_, __, callback) => {
      const error = Object.assign(new Error("missing"), { code: "ENOENT" });
      callback(error, "", "");
    });

    const runQmd = createQmdRunner(execStub);
    const result = await runQmd({
      command: "qmd",
      args: ["status"],
      timeoutMs: 1000,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0] && "text" in result.content[0] && result.content[0].text).toContain(
      "qmd command not found",
    );
    expect(result.details).toMatchObject({
      command: "qmd",
      args: ["status"],
      code: "ENOENT",
    });
  });

  it("includes stdout and stderr when qmd exits with a failure", async () => {
    const execStub = createExecStub((_, __, callback) => {
      const error = Object.assign(new Error("boom"), { code: 2 });
      callback(error, "partial output", "fatal");
    });

    const runQmd = createQmdRunner(execStub);
    const result = await runQmd({
      command: "qmd",
      args: ["query", "hello"],
      timeoutMs: 1000,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0] && "text" in result.content[0] && result.content[0].text).toContain(
      "exit code 2",
    );
    expect(result.content[0] && "text" in result.content[0] && result.content[0].text).toContain(
      "partial output",
    );
    expect(result.content[0] && "text" in result.content[0] && result.content[0].text).toContain(
      "fatal",
    );
  });
});
