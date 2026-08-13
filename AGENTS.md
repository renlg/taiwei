# taiwei — Architecture Guide (for AI coding agents)

taiwei is a **proactive agent CLI** inspired by opencode (terminal AI coding agent) and OpenClaw/Hermes (proactive personal AI assistant). It runs in the terminal only (no GUI, no gateway channels needed — but the architecture should leave room to add them).

## Project Layout

```
~/workspace/taiwei/
├── package.json
├── tsconfig.json
├── bin/taiwei            # executable entry (#!/usr/bin/env node)
├── src/
│   ├── cli/
│   │   ├── repl.ts       # interactive REPL loop (readline), /commands
│   │   └── once.ts       # one-shot mode: taiwei "prompt"
│   ├── agent/
│   │   ├── loop.ts       # core agent loop: LLM -> tool calls -> feedback -> repeat
│   │   ├── context.ts    # AgentContext: conversation state, system prompt assembly
│   │   └── interrupt.ts  # cooperative interruption (Ctrl+C, /stop, proactive wake)
│   ├── llm/
│   │   ├── client.ts     # OpenAI-compatible chat completions (streaming), configurable base_url/model/api_key
│   │   └── tools.ts      # OpenAI function-calling schema helpers
│   ├── tools/
│   │   ├── registry.ts   # ToolRegistry: register/list/dispatch tools
│   │   └── impl/         # built-in tools (keep minimal):
│   │       ├── bash.ts       # run shell command
│   │       ├── read.ts       # read file
│   │       ├── write.ts      # write file
│   │       ├── search.ts     # ripgrep-like file search (use Node built-ins / child_process rg)
│   │       └── memory.ts     # memory read/append
│   ├── skills/
│   │   ├── loader.ts     # load SKILL.md (YAML frontmatter + markdown) from ~/.taiwei/skills/
│   │   └── inject.ts     # inject skill content into system prompt on demand
│   ├── cron/
│   │   ├── scheduler.ts  # schedule jobs (cron expressions + simple intervals)
│   │   └── jobs.ts       # cron.json persistence, job CRUD
│   ├── mcp/
│   │   ├── client.ts     # MCP client: stdio + SSE transports (use @modelcontextprotocol/sdk)
│   │   └── bridge.ts     # bridge MCP tools into ToolRegistry dynamically
│   ├── memory/
│   │   └── store.ts      # persistent memory (~/.taiwei/memory.md), append/retrieve
│   ├── rag/
│   │   ├── index.ts      # knowledge base indexing: chunk documents, build searchable index
│   │   ├── retrieve.ts   # retrieval (keyword/BM25 first; pluggable embedding interface)
│   │   └── prompt.ts     # inject retrieved context into system prompt / tool
│   ├── plugins/
│   │   └── loader.ts     # extension loading: external JS/TS modules register tools/skills
│   ├── config/
│   │   └── config.ts     # ~/.taiwei/config.json load/save, defaults, env overrides
│   └── util/
│       └── paths.ts      # resolve ~/.taiwei paths, ensure dirs exist
├── test/                 # minimal smoke tests (node:test)
└── AGENTS.md
```

## Core Requirements

1. **TypeScript, Node >= 20, ESM.** Prefer Node built-ins (node:fs, node:child_process, node:readline, node:http/https). Keep runtime dependencies minimal. Allowed deps: `@modelcontextprotocol/sdk` (MCP), `cron-parser` (cron expressions). Everything else should be zero-dep.

2. **Agent loop** (`agent/loop.ts`): send conversation (system prompt + messages) to an OpenAI-compatible chat completions endpoint; if the response contains tool_calls, execute them through ToolRegistry, append results as `tool` role messages, and repeat until the model stops calling tools. Support streaming output for text. Cap max turns (e.g. 50). Handle provider errors gracefully (timeout, 429, 5xx).

3. **LLM config** (`config.json`): `{ "model": "...", "baseUrl": "https://api.openai.com/v1", "apiKey": "..." }` — also read `TAIWEI_API_KEY` / `TAIWEI_BASE_URL` / `TAIWEI_MODEL` env overrides. Must support any OpenAI-compatible relay (baseUrl + model + apiKey).

4. **Interrupt / proactive** (`agent/interrupt.ts`):
   - Ctrl+C during a turn: cancel the current tool execution / LLM stream gracefully (AbortController), return control to REPL without killing the process.
   - `/stop` command in REPL does the same.
   - **Proactive wake**: a lightweight mechanism where a scheduled cron job can "interrupt" an idle REPL — print a visible notification banner (e.g. `[taiwei] ⏰ cron job "name" fired: <result summary>`) to the terminal. Implementation: REPL loop uses readline with a polling/EventEmitter bridge so cron events can print to stdout safely while the user is typing (or queue until next prompt). Do NOT over-engineer; a simple shared event emitter + safe print function is enough.

5. **Skills** (`skills/`): skills live in `~/.taiwei/skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description`) + markdown body. Commands: `/skill list`, `/skill load <name>` (injects into system prompt for subsequent turns), `/skill unload <name>`. The agent can also load skills via a tool call if we add a `load_skill` tool — optional, but keep the loader generic.

6. **Cron** (`cron/`): `~/.taiwei/cron.json` = `[{ "id", "name", "schedule": "*/5 * * * *" | "every 1h" | "30s", "prompt": "...", "enabled": true }]`. Scheduler runs jobs; each firing executes a **new agent turn** with the job prompt (self-contained), then emits the result through the interrupt/notification bridge. Commands: `/cron list`, `/cron add <name> <schedule> <prompt>`, `/cron remove <id>`, `/cron pause <id>`, `/cron resume <id>`. Note: cron jobs run inside the same process — a job firing while the user is mid-turn should wait until the turn finishes (simple queue), then notify.

7. **MCP** (`mcp/`): `~/.taiwei/mcp.json` = `[{ "name", "transport": "stdio"|"sse", "command"/"url", "args", "env", "enabled": true }]`. On startup (and `/mcp reload`), connect to each server, list its tools, and bridge them into ToolRegistry as `mcp_<server>_<tool>` names. Commands: `/mcp list`, `/mcp reload`. Use `@modelcontextprotocol/sdk` client.

8. **Memory** (`memory/`): persistent markdown file `~/.taiwei/memory.md`. The agent gets a `memory_read` + `memory_append` tool. Memory is also auto-injected into the system prompt (trimmed to last N chars, e.g. 2000) every turn. `/memory show`, `/memory clear` commands.

9. **RAG** (`rag/`): documents in `~/.taiwei/knowledge/**` (markdown/txt). `/rag index` chunks them (by paragraphs/headings, chunk size ~1000 chars with overlap) and builds an in-memory/JSON-file index. `/rag search <query>` retrieves top-k chunks and injects them as context. Default retrieval: keyword/BM25 scoring over chunks (implement a simple tokenizer + IDF scoring — no external vector DB). Leave a pluggable `Embedder` interface (embedding API optional, not required for v1). Expose a `rag_search` tool to the agent.

10. **Plugins** (`plugins/`): `~/.taiwei/plugins/` — each subdir has `plugin.js` (CommonJS or ESM) exporting `{ name, tools?: [], skills?: [], init?: async (ctx) => void }`. `plugins/loader.ts` loads them at startup; plugin-registered tools are added to ToolRegistry with a `plugin_<name>_` prefix. `/plugin list`, `/plugin reload`. This is the extension mechanism — keep the interface minimal and documented in README.

11. **CLI**:
    - `taiwei` → interactive REPL with `/` commands: `/help`, `/exit`, `/skill ...`, `/cron ...`, `/mcp ...`, `/memory ...`, `/rag ...`, `/plugin ...`, `/stop`, `/model <name>`, `/clear` (reset conversation).
    - `taiwei "prompt"` → one-shot mode, runs a full agent turn and prints the final text.
    - `taiwei --init` → create `~/.taiwei/` with default config and sample skill.
    - `--help`, `--version`.
    - ANSI colors for a clean terminal UI (use ANSI escape codes directly, no dep).

12. **System prompt**: assembled in `agent/context.ts` — base persona + active skills + memory tail + current date/time. Keep it concise.

13. **Errors/robustness**: never crash on provider errors; print friendly messages. Guard against infinite tool loops. All state (config/cron/memory) survives restarts.

## Constraints

- Do NOT add a web UI, daemon, or gateway integration — CLI only for v1.
- Do NOT use frameworks (no Express, no Fastify, no commander if avoidable — plain argv parsing is fine).
- Keep `npm install` minimal: `@modelcontextprotocol/sdk` and `cron-parser` only. If MCP SDK pulls heavy deps, vendor a tiny stdio client instead and note it.
- Tests: at least one smoke test using `node:test` (e.g. config load + tool registry dispatch + cron schedule parse).
- `npm run build` must pass (`tsc`), and `bin/taiwei` must be executable and runnable with `node`.
- Commit in logical chunks with clear messages. Do NOT run npm install in a way that fetches from blocked registries; if install fails, fall back to stub-free built-in implementations and document it.
