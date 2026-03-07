/**
 * Integration test: exercises the full plugin lifecycle (async register → tool execution)
 * using an in-process SQLite database. No external qmd CLI required.
 */

import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import plugin from "../index.js";
import {
  openDatabase,
  ensureSchema,
  insertContent,
  insertDocument,
  hashContent,
} from "../src/qmd-lite.js";

import { describe, expect, it } from "vitest";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<any>;
};

function createTempDir() {
  return mkdtempSync(path.join(tmpdir(), "integration-test-"));
}

async function createTestDb(dir: string) {
  const dbPath = path.join(dir, "test.sqlite");
  const db = await openDatabase(dbPath);
  ensureSchema(db);
  return { dbPath, db };
}

function insertTestDoc(
  db: Awaited<ReturnType<typeof openDatabase>>,
  collection: string,
  docPath: string,
  title: string,
  body: string,
) {
  const hash = hashContent(body);
  const now = new Date().toISOString();
  insertContent(db, hash, body, now);
  insertDocument(db, collection, docPath, title, hash, now, now);
}

async function registerPluginAsync(pluginConfig: Record<string, unknown>) {
  const tools = new Map<string, RegisteredTool>();
  const hooks = new Map<string, Function>();

  let resolveReady: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));

  (plugin as any).register({
    pluginConfig,
    logger: console,
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
      if (tools.has("qmd_status")) {
        resolveReady!();
      }
    },
    on(event: string, handler: Function) {
      hooks.set(event, handler);
    },
  });

  await Promise.race([
    ready,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("Tool registration timed out")), 5000),
    ),
  ]);

  return { tools, hooks };
}

describe("integration: full plugin lifecycle", () => {
  it("registers all qmd tools via async register", async () => {
    const dir = createTempDir();
    const { dbPath, db } = await createTestDb(dir);
    insertTestDoc(db, "demo", "a.md", "Alpha", "auth design doc");
    insertTestDoc(db, "demo", "b.md", "Beta", "connection pool timeout redis");

    const { tools } = await registerPluginAsync({ dbPath });

    expect(tools.has("qmd_status")).toBe(true);
    expect(tools.has("qmd_query")).toBe(true);
    expect(tools.has("qmd_get")).toBe(true);
    expect(tools.has("qmd_multi_get")).toBe(true);
  });

  it("qmd_status returns JSON with collection and document info", async () => {
    const dir = createTempDir();
    const { dbPath, db } = await createTestDb(dir);
    insertTestDoc(db, "demo", "a.md", "Alpha", "auth design doc");
    insertTestDoc(db, "demo", "b.md", "Beta", "connection pool timeout redis");

    const { tools } = await registerPluginAsync({ dbPath });

    const status = await tools.get("qmd_status")!.execute("status-1", {});
    expect(status.isError).toBeUndefined();

    // Output is JSON, not CLI text
    const parsed = JSON.parse(status.content[0].text);
    expect(parsed.totalDocuments).toBe(2);
    // collections comes from YAML config, not DB; with dbPath-only config it's empty
    expect(parsed).toHaveProperty("collections");
  });

  it("qmd_query searches documents and returns snippet results", async () => {
    const dir = createTempDir();
    const { dbPath, db } = await createTestDb(dir);
    insertTestDoc(db, "demo", "a.md", "Alpha", "auth design doc JWT tokens");
    insertTestDoc(db, "demo", "b.md", "Beta", "connection pool timeout redis");

    const { tools } = await registerPluginAsync({ dbPath });

    const result = await tools.get("qmd_query")!.execute("query-1", {
      query: "auth JWT",
      limit: 5,
    });

    expect(result.isError).toBeUndefined();
    expect(result.details.length).toBeGreaterThan(0);
    expect(result.details[0].snippet).toContain("auth");
  });

  it("qmd_get reads document content with header", async () => {
    const dir = createTempDir();
    const { dbPath, db } = await createTestDb(dir);
    insertTestDoc(db, "demo", "a.md", "Alpha", "# Alpha\n\nauth design doc");

    const { tools } = await registerPluginAsync({ dbPath });

    const result = await tools.get("qmd_get")!.execute("get-1", {
      file: "qmd://demo/a.md",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("# Alpha");
    expect(result.content[0].text).toContain("auth design doc");
    expect(result.content[0].text).toContain("demo/a.md");
  });

  it("qmd_multi_get reads multiple documents by glob pattern", async () => {
    const dir = createTempDir();
    const { dbPath, db } = await createTestDb(dir);
    insertTestDoc(db, "demo", "a.md", "Alpha", "auth design doc");
    insertTestDoc(db, "demo", "b.md", "Beta", "connection pool timeout redis");

    const { tools } = await registerPluginAsync({ dbPath });

    const result = await tools.get("qmd_multi_get")!.execute("multi-1", {
      pattern: "*.md",
    });

    expect(result.isError).toBeUndefined();
    // details.files contains filepath info
    const filepaths = result.details.files.map((f: any) => f.displayPath ?? f.filepath);
    const hasA = filepaths.some((p: string) => p.includes("a.md"));
    const hasB = filepaths.some((p: string) => p.includes("b.md"));
    expect(hasA).toBe(true);
    expect(hasB).toBe(true);
  });

  it("memory tools register when memoryDir is configured", async () => {
    const dir = createTempDir();
    const { dbPath, db } = await createTestDb(dir);
    insertTestDoc(db, "demo", "a.md", "Alpha", "auth design doc");

    const memoryDir = path.join(dir, "memories");
    mkdirSync(memoryDir, { recursive: true });

    const { tools } = await registerPluginAsync({ dbPath, memoryDir });

    expect(tools.has("qmd_status")).toBe(true);
    expect(tools.has("memory_search")).toBe(true);
    expect(tools.has("memory_get")).toBe(true);
    expect(tools.has("memory_write")).toBe(true);
    expect(tools.has("memory_forget")).toBe(true);
  });

  it("memory_write + memory_search round-trip works", async () => {
    const dir = createTempDir();
    const { dbPath, db } = await createTestDb(dir);
    insertTestDoc(db, "demo", "a.md", "Alpha", "placeholder");

    const memoryDir = path.join(dir, "memories");
    mkdirSync(memoryDir, { recursive: true });

    const { tools } = await registerPluginAsync({ dbPath, memoryDir });

    // Write a memory
    const writeResult = await tools.get("memory_write")!.execute("w-1", {
      content: "User prefers dark mode and monospace fonts",
      category: "preference",
      tags: ["ui", "editor"],
      title: "ui-prefs",
    });
    expect(writeResult.content[0].text).toContain("Memory stored:");

    // Search for it — minScore=0 because BM25 scores are very low with single short docs
    const searchResult = await tools.get("memory_search")!.execute("s-1", {
      query: "dark mode",
      limit: 5,
      minScore: 0,
    });
    expect(searchResult.details.length).toBeGreaterThan(0);
    expect(searchResult.details[0].content).toContain("dark mode");
  });
});
