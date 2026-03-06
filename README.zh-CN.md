# openclaw-qmd

基于 [qmd](https://github.com/tobi/qmd) 的 SQLite FTS5 索引实现的 OpenClaw memory 插件。

提供两项能力：

1. **知识库查询** -- 直接从 qmd 的 SQLite 数据库查询已索引的笔记和文档（无需 CLI）
2. **记忆后端** -- 使用 BM25 全文检索存储、召回和自动捕获对话记忆

## 架构

```
openclaw-qmd
├── qmd-reader    从 qmd 已有的 SQLite 索引读取 (~/.cache/qmd/index.sqlite)
├── qmd-lite      从 qmd 源码提取的最小 SQLite FTS5 层
├── memory-store  记忆存储（双写：SQLite + Markdown 文件）
├── memory-hooks  自动召回 (before_prompt_build) + 自动捕获 (agent_end)
└── memory-format YAML frontmatter 记忆文件工具
```

所有操作均为进程内 SQLite 查询（通过 `better-sqlite3`）。零 CLI 依赖，零网络调用。

## 前置要求

- Node.js >= 22
- OpenClaw >= 2026.3.2

可选：已安装并索引内容的 `qmd`（用于知识库功能）。

## 安装

```bash
npm install
```

## 开发

```bash
npm run check   # TypeScript 类型检查
npm test        # 运行所有测试 (vitest)
```

## 插件配置

```json
{
  "plugins": {
    "qmd": {
      "memoryDir": "~/.openclaw/memory/qmd",
      "autoCapture": true,
      "autoRecallLimit": 5,
      "autoRecallMinScore": 0.3
    }
  }
}
```

### 配置项说明

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `memoryDir` | string | -- | 记忆 Markdown 文件目录。设置后启用记忆功能。 |
| `autoCapture` | boolean | `true` | 自动从用户消息中捕获重要信息。 |
| `autoRecallLimit` | number | `5` | 每次提示最多召回的记忆条数。 |
| `autoRecallMinScore` | number | `0.3` | 召回的最低 BM25 相关度分数。 |
| `indexName` | string | `"index"` | qmd 索引名称。 |
| `dbPath` | string | 自动 | 覆盖 qmd SQLite 数据库路径。 |
| `configDir` | string | 自动 | 覆盖 qmd YAML 配置目录路径。 |

## 注册的工具

### 知识库工具（读取 qmd 索引）

| 工具 | 说明 |
|------|------|
| `qmd_status` | 显示索引状态：collections、文档数量、embedding 状态 |
| `qmd_query` | BM25 全文搜索已索引文档 |
| `qmd_get` | 通过路径、`qmd://` URI 或 docid 读取文档 |
| `qmd_multi_get` | 通过 glob 模式或逗号分隔列表批量读取 |

这些工具直接读取 qmd 的 SQLite 数据库。当数据库存在时自动注册。

### 记忆工具（需要配置 `memoryDir`）

| 工具 | 说明 |
|------|------|
| `memory_search` | 通过 BM25 搜索已存储的记忆 |
| `memory_get` | 通过 id 读取特定记忆条目 |
| `memory_write` | 写入新的记忆条目 |

### 生命周期 hooks

| Hook | 事件 | 行为 |
|------|------|------|
| 自动召回 | `before_prompt_build` | 根据用户提示搜索记忆，将相关记忆以 `<recalled-memories>` 形式注入上下文 |
| 自动捕获 | `agent_end` | 从用户消息中提取重要信息（偏好、决策、实体），去重后存储 |

## 记忆文件格式

每条记忆存储为带有 YAML frontmatter 的 Markdown 文件：

```markdown
---
id: "2026-03-06T09-15-00_auth-flow-decision"
category: "decision"
tags: ["auth", "architecture"]
created: "2026-03-06T09:15:00Z"
---

Auth flow uses JWT with refresh token rotation.
```

## 安全机制

- **Prompt 注入检测**：自动捕获会拒绝包含注入模式的消息
- **HTML 转义**：召回的记忆内容在注入上下文前会进行转义
- **不可信数据警告**：召回的记忆包裹在明确的"视为不可信"提示中
- **仅捕获用户消息**：只处理 `role: "user"` 的消息（防止模型自我污染）

## 项目结构

```
index.ts                   插件入口、工具注册、配置
openclaw.plugin.json       插件 manifest (kind: "memory")
src/
  qmd-lite.ts              SQLite FTS5 引擎（打开、建表、搜索、写入）
  qmd-reader.ts            qmd 索引数据库直接读取器
  memory-store.ts          记忆存储（SQLite + Markdown 双写）
  memory-hooks.ts          自动召回和自动捕获 hooks
  memory-format.ts         记忆文件格式工具
tests/
  qmd-reader.test.ts       16 个测试
  memory-store.test.ts      7 个测试
  memory-hooks.test.ts     20 个测试
  memory-format.test.ts    11 个测试
  plugin.test.ts            5 个测试
```

## 工具白名单

所有工具注册为 optional，需要在 agent 配置中显式允许：

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": [
            "qmd_status", "qmd_query", "qmd_get", "qmd_multi_get",
            "memory_search", "memory_get", "memory_write"
          ]
        }
      }
    ]
  }
}
```
