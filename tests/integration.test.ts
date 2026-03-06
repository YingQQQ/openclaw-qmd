import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import plugin from "../index.js";

import { describe, expect, it } from "vitest";

const QMD_BIN = "/home/yingq/openclaw-qmd/.qmd-test/node_modules/@tobilu/qmd/qmd";

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

function createIsolatedEnv() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-qmd-integration-"));
  const home = path.join(root, "home");
  const cache = path.join(root, "cache");
  const config = path.join(root, "config");
  const work = path.join(root, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(cache, { recursive: true });
  mkdirSync(config, { recursive: true });
  mkdirSync(work, { recursive: true });

  writeFileSync(path.join(work, "a.md"), "# Alpha\n\nauth design doc\n");
  writeFileSync(path.join(work, "b.md"), "# Beta\n\nconnection pool timeout redis\n");

  const env = {
    ...process.env,
    HOME: home,
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: config,
  };

  execFileSync(QMD_BIN, ["collection", "add", work, "--name", "demo"], {
    cwd: work,
    env,
    stdio: "ignore",
  });
  execFileSync(QMD_BIN, ["update"], {
    cwd: work,
    env,
    stdio: "ignore",
  });

  return { env, work };
}

describe.runIf(existsSync(QMD_BIN))("integration with local qmd", () => {
  it("executes qmd_status, qmd_get, and qmd_multi_get against a real isolated index", async () => {
    const previousEnv = { ...process.env };
    const { env, work } = createIsolatedEnv();
    Object.assign(process.env, env);

    try {
      const tools = registerTools({
        command: QMD_BIN,
        cwd: work,
        timeoutMs: 10000,
      });

      const status = await tools.get("qmd_status")!.execute("status-1", {});
      expect(status.isError).toBeUndefined();
      expect(status.content[0].text).toContain("Total:    2 files indexed");
      expect(status.content[0].text).toContain("demo (qmd://demo/)");

      const getResult = await tools.get("qmd_get")!.execute("get-1", {
        file: "qmd://demo/a.md",
      });
      expect(getResult.isError).toBeUndefined();
      expect(getResult.content[0].text).toContain("# Alpha");
      expect(getResult.content[0].text).toContain("auth design doc");

      const multiResult = await tools.get("qmd_multi_get")!.execute("multi-1", {
        pattern: "*.md",
      });
      expect(multiResult.isError).toBeUndefined();
      expect(multiResult.content[0].text).toContain('"file": "a.md"');
      expect(multiResult.content[0].text).toContain('"file": "b.md"');
    } finally {
      process.env = previousEnv;
    }
  }, 30000);
});
