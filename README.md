# taiwei

参考 [opencode](https://github.com/sst/opencode) 与 [OpenClaw](https://github.com/openclaw/openclaw) 设计的 **主动 Agent CLI** —— 一个终端里的自主 AI 助手。

支持工具调用、技能（Skill）、定时任务（Cron）、MCP、记忆（Memory）、RAG 知识库，并且**能主动发起对话/打断提醒**（proactive）。

## 特性

- 🖥️ 纯 CLI（交互式 REPL + 一次性执行 `taiwei "任务"`）
- 🔧 工具调用循环：LLM → 工具 → 结果回填 → 继续，直到完成
- 🎓 Skill 技能系统：`SKILL.md`（YAML frontmatter + Markdown），按需加载注入
- ⏰ 定时任务：cron 表达式 + 间隔触发，到点主动运行
- 🔌 MCP 支持：连接外部 MCP Server（stdio / SSE）
- 🧠 记忆：持久化记忆，跨会话保留
- 📚 RAG：本地知识库检索增强生成
- 🧩 可扩展：工具/技能/插件均可扩展
- ⚡ 主动打断：定时任务到点主动通知；Ctrl+C 优雅中断

## 快速开始

```bash
npm install
npm run build
taiwei --help
taiwei                      # 交互式模式
taiwei "帮我总结这个仓库"     # 一次性模式
```

## 配置

配置文件位于 `~/.taiwei/`：

```bash
~/.taiwei/config.json      # 模型、API、工具配置
~/.taiwei/memory.md        # 持久化记忆
~/.taiwei/skills/          # 技能目录
~/.taiwei/cron.json        # 定时任务
~/.taiwei/mcp.json         # MCP Server 配置
~/.taiwei/knowledge/       # RAG 知识库文档
```

## 技术栈

- TypeScript + Node.js（>= 20）
- 零或极少运行时依赖（优先 Node 内置 API）
