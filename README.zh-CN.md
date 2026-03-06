# openclaw-qmd

`openclaw-qmd` 是一个很薄的 OpenClaw 插件，用来把本地 `qmd` CLI 暴露成可选的 agent 工具。

它不替代 `qmd`，只是对真实的 `qmd` 命令做一层适配，让 OpenClaw 可以查询你已经索引好的笔记和文档。

## 插件提供的能力

这个插件会注册 4 个可选工具：

- `qmd_status`
- `qmd_query`
- `qmd_get`
- `qmd_multi_get`

所有工具底层都是直接调用本地 `qmd` 可执行文件。  
如果机器上没有安装 `qmd`，工具会返回明确错误，不会静默失败。

## 前置要求

- Node.js `>= 22`
- OpenClaw `2026.3.2` 或兼容版本
- 本地已经可以运行的 `qmd`

这个仓库只包含插件本身，不包含 `qmd`。  
也就是说，你仍然需要单独安装和配置 `qmd`。

## 安装依赖

```bash
npm install
```

## 开发检查

```bash
npm run check
npm test
```

## 插件配置

下面是一个 OpenClaw 插件配置示例：

```json
{
  "plugins": {
    "qmd": {
      "command": "qmd",
      "cwd": "/home/yingq/notes",
      "indexName": "index",
      "timeoutMs": 30000
    }
  }
}
```

配置项说明：

- `command`：`qmd` 可执行文件路径
- `cwd`：默认工作目录
- `indexName`：可选，对应传给 `qmd` 的 `--index <name>`
- `timeoutMs`：命令超时时间，单位毫秒

如果 `qmd` 不在 `PATH` 里，应该写绝对路径，例如：

```json
{
  "plugins": {
    "qmd": {
      "command": "/home/yingq/.local/bin/qmd"
    }
  }
}
```

## 工具白名单

这些工具都被注册为 optional tool，所以必须在 agent 配置里显式允许：

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": [
            "qmd",
            "qmd_status",
            "qmd_query",
            "qmd_get",
            "qmd_multi_get"
          ]
        }
      }
    ]
  }
}
```

## 工具行为说明

### `qmd_status`

底层执行：

```bash
qmd status
```

用来检查：

- `qmd` 是否可用
- 当前索引是否正常
- collection 和 embedding 状态

### `qmd_query`

底层执行：

```bash
qmd query "<query>" --json
```

支持两种调用方式：

1. 直接传普通查询字符串
2. 传结构化 `searches` 数组，插件会自动转换成 qmd 的多行 query-document 格式

普通查询示例：

```json
{
  "query": "how does auth work",
  "limit": 5
}
```

结构化查询示例：

```json
{
  "searches": [
    { "type": "lex", "query": "\"connection pool\" timeout -redis" },
    { "type": "vec", "query": "why do database connections time out under load" }
  ],
  "collections": ["notes"],
  "limit": 8,
  "minScore": 0.2
}
```

### `qmd_get`

底层执行：

```bash
qmd get <file>
```

支持：

- 相对路径
- `qmd://` 路径
- `qmd` 支持的 docid
- `fromLine`
- `maxLines`
- `lineNumbers`

示例：

```json
{
  "file": "qmd://notes/auth/design.md",
  "fromLine": 20,
  "maxLines": 80
}
```

### `qmd_multi_get`

底层执行：

```bash
qmd multi-get "<pattern>" --json
```

适合批量读取多个文件，支持 glob 或逗号分隔文件列表。

示例：

```json
{
  "pattern": "journals/2026-03*.md",
  "maxLines": 40,
  "maxBytes": 12000
}
```

## 推荐的 qmd 初始化流程

在这个插件有实际价值之前，建议先把 `qmd` 本身初始化好：

```bash
qmd collection add /home/yingq/notes --name notes
qmd update
qmd embed
qmd status
```

做完这一步后，OpenClaw 才能通过这个插件查询到真正的索引内容。

## 项目结构

- `index.ts`：插件入口和工具注册
- `src/qmd.ts`：本地 `qmd` 进程执行与错误处理
- `tests/qmd.test.ts`：命令执行层的单元测试

## 说明

- 这个插件故意保持很薄，只是复用真实 `qmd` CLI，不再重新设计一套协议。
- 当 `qmd` 返回 JSON 时，工具结果会同时返回文本摘要和结构化 `details`。
- 这个项目不会自动安装 `qmd`。
