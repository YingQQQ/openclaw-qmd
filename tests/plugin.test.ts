import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import {
  openDatabase,
  ensureSchema,
  insertContent,
  insertDocument,
  hashContent,
} from "../src/qmd-lite.js";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<any>;
};

function createTempDir() {
  return mkdtempSync(path.join(tmpdir(), "plugin-test-"));
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

async function registerToolsAsync(pluginConfig: Record<string, unknown>) {
  const tools = new Map<string, RegisteredTool>();
  const hooks = new Map<string, Function>();

  // register() triggers async initialization; we need to wait for it
  let resolveReady: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));

  const originalThen = Promise.prototype.then;

  (plugin as any).register({
    pluginConfig,
    logger: console,
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
      // Once qmd tools are registered, signal ready
      if (tools.has("qmd_status")) {
        resolveReady!();
      }
    },
    on(event: string, handler: Function) {
      hooks.set(event, handler);
    },
  });

  // Wait for async tool registration (with timeout)
  await Promise.race([
    ready,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("Tool registration timed out")), 5000),
    ),
  ]);

  return { tools, hooks };
}

describe("plugin tool registration", () => {
  it("registers qmd tools when database exists", async () => {
    const dir = createTempDir();
    const { dbPath, db } = await createTestDb(dir);
    insertTestDoc(db, "notes", "test.md", "Test", "test content");

    const { tools } = await registerToolsAsync({ dbPath });

    expect(tools.has("qmd_status")).toBe(true);
    expect(tools.has("qmd_query")).toBe(true);
    expect(tools.has("qmd_get")).toBe(true);
    expect(tools.has("qmd_multi_get")).toBe(true);
  });

  it("qmd_query returns results from database", async () => {
    const dir = createTempDir();
    const { dbPath, db } = await createTestDb(dir);
    insertTestDoc(db, "notes", "auth.md", "Auth", "JWT with refresh token rotation");

    const { tools } = await registerToolsAsync({ dbPath });
    const result = await tools.get("qmd_query")!.execute("call-1", {
      query: "JWT auth",
      limit: 5,
    });

    expect(result.isError).toBeUndefined();
    expect(result.details.length).toBeGreaterThan(0);
    expect(result.details[0].snippet).toContain("JWT");
  });

  it("qmd_query returns error when no query provided", async () => {
    const dir = createTempDir();
    const { dbPath } = await createTestDb(dir);

    const { tools } = await registerToolsAsync({ dbPath });
    const result = await tools.get("qmd_query")!.execute("call-2", {});

    expect(result.isError).toBe(true);
    expect(result.details).toEqual({ reason: "missing_query" });
  });

  it("qmd_get reads document content", async () => {
    const dir = createTempDir();
    const { dbPath, db } = await createTestDb(dir);
    insertTestDoc(db, "notes", "auth.md", "Auth Design", "line1\nline2\nline3");

    const { tools } = await registerToolsAsync({ dbPath });
    const result = await tools.get("qmd_get")!.execute("call-3", {
      file: "qmd://notes/auth.md",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("line1");
    expect(result.content[0].text).toContain("notes/auth.md");
  });

  it("qmd_get supports line range and line numbers", async () => {
    const dir = createTempDir();
    const { dbPath, db } = await createTestDb(dir);
    insertTestDoc(db, "notes", "code.md", "Code", "a\nb\nc\nd\ne");

    const { tools } = await registerToolsAsync({ dbPath });
    const result = await tools.get("qmd_get")!.execute("call-4", {
      file: "qmd://notes/code.md",
      fromLine: 2,
      maxLines: 2,
      lineNumbers: true,
    });

    expect(result.content[0].text).toContain("2: b");
    expect(result.content[0].text).toContain("3: c");
    expect(result.content[0].text).not.toContain("4: d");
  });
});
