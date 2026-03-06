import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import plugin from "../index.js";

import { afterEach, describe, expect, it } from "vitest";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<any>;
};

function registerTools(pluginConfig: Record<string, unknown>) {
  const tools = new Map<string, RegisteredTool>();
  (plugin as any).register({
    pluginConfig,
    logger: console,
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  });
  return tools;
}

function createEchoCommand() {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-qmd-script-"));
  const scriptPath = path.join(dir, "fake-qmd");
  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));",
    ].join("\n"),
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function createTempDir(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  // No-op: temp files live under /tmp and are fine to expire naturally.
});

describe("plugin tool mapping", () => {
  it("maps qmd_status to the expected cli invocation", async () => {
    const command = createEchoCommand();
    const defaultCwd = createTempDir("openclaw-qmd-cwd-");
    const tools = registerTools({
      command,
      cwd: defaultCwd,
      indexName: "unit",
      timeoutMs: 1000,
    });

    const result = await tools.get("qmd_status")!.execute("call-1", {});
    expect(result.details).toEqual({
      argv: ["--index", "unit", "status"],
      cwd: defaultCwd,
    });
  });

  it("maps qmd_query structured searches and flags correctly", async () => {
    const command = createEchoCommand();
    const defaultCwd = createTempDir("openclaw-qmd-cwd-");
    const overrideCwd = createTempDir("openclaw-qmd-cwd-");
    const tools = registerTools({
      command,
      cwd: defaultCwd,
      indexName: "unit",
      timeoutMs: 1000,
    });

    const result = await tools.get("qmd_query")!.execute("call-2", {
      searches: [
        { type: "lex", query: "auth -redis" },
        { type: "vec", query: "how auth works" },
      ],
      collections: ["notes", "docs"],
      limit: 7,
      minScore: 0.2,
      full: true,
      lineNumbers: true,
      cwd: overrideCwd,
    });

    expect(result.details).toEqual({
      argv: [
        "--index",
        "unit",
        "query",
        "lex: auth -redis\nvec: how auth works",
        "--json",
        "-n",
        "7",
        "--min-score",
        "0.2",
        "--full",
        "--line-numbers",
        "--collection",
        "notes",
        "--collection",
        "docs",
      ],
      cwd: overrideCwd,
    });
  });

  it("returns a validation error when qmd_query has no query input", async () => {
    const command = createEchoCommand();
    const tools = registerTools({
      command,
      timeoutMs: 1000,
    });

    const result = await tools.get("qmd_query")!.execute("call-3", {});

    expect(result.isError).toBe(true);
    expect(result.details).toEqual({ reason: "missing_query" });
  });

  it("maps qmd_get and qmd_multi_get to qmd cli arguments", async () => {
    const command = createEchoCommand();
    const getCwd = createTempDir("openclaw-qmd-cwd-");
    const multiCwd = createTempDir("openclaw-qmd-cwd-");
    const tools = registerTools({
      command,
      timeoutMs: 1000,
    });

    const getResult = await tools.get("qmd_get")!.execute("call-4", {
      file: "qmd://notes/a.md",
      fromLine: 5,
      maxLines: 10,
      lineNumbers: true,
      cwd: getCwd,
    });

    expect(getResult.details).toEqual({
      argv: ["get", "qmd://notes/a.md", "--from", "5", "-l", "10", "--line-numbers"],
      cwd: getCwd,
    });

    const multiResult = await tools.get("qmd_multi_get")!.execute("call-5", {
      pattern: "*.md",
      maxLines: 20,
      maxBytes: 4096,
      lineNumbers: true,
      cwd: multiCwd,
    });

    expect(multiResult.details).toEqual({
      argv: ["multi-get", "*.md", "--json", "-l", "20", "--max-bytes", "4096", "--line-numbers"],
      cwd: multiCwd,
    });
  });
});
