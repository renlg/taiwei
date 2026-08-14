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

## Gateway (local web chat, v1.1 — ADD THIS)

A **local web chat gateway** so the agent can be used from a browser like a chat app (Feishu-style input, but no Feishu integration yet — local web page only). Streaming output is mandatory.

```
src/gateway/
├── server.ts     # node:http server: static page + JSON/SSE routes
├── sse.ts        # SSE helper (text/event-stream, zero-dep, node:http only)
├── chat.ts       # bridge: user message -> agent loop -> stream events back
└── public/
    ├── index.html  # single chat page (inline CSS/JS or small files)
    └── app.js      # fetch + ReadableStream parsing (or EventSource), streaming render
```

Requirements:
1. **Command**: `taiwei serve [--port N]` starts the gateway. Default host `127.0.0.1`, default port `8688` (avoid conflicts: 8890/8899 are used by other services). Add `gateway: { host, port }` to `~/.taiwei/config.json`; `--port` overrides.
2. **Streaming**: POST `/api/chat` with `{ "message": "..." }` returns `text/event-stream` (SSE). Event types:
   - `event: token` / data: `{"text":"..."}` — streamed answer chunks
   - `event: tool` / data: `{"name":"bash","args":{...}}` — tool call started (optional: tool result as `event: tool_result`)
   - `event: done` / data: `{"text":"<full answer>"}`
   - `event: error` / data: `{"message":"..."}`
   Client uses `fetch` + `ReadableStream` (or EventSource). The UI must render tokens as they arrive (no waiting for completion).
3. **Reuse**: the gateway MUST reuse the existing agent loop (`src/agent/loop.ts`) and conversation/context machinery — do NOT duplicate agent logic. Add whatever hook (callback/emitter) is needed in the loop to emit incremental events (token deltas, tool calls, done). Keep the CLI behavior unchanged (default streaming unchanged, no regression).
4. **UI**: minimal clean chat page — message bubbles, input box, Enter to send, "Stop" button that aborts the current turn (reuse interrupt/AbortController), tool-call activity shown as small status lines (e.g. `🔧 bash ...`), auto-scroll. No framework, no build step for the frontend (plain HTML/CSS/JS served as static files).
5. **Session**: keep one conversation per browser tab (or a single in-memory conversation for v1.1 — simplest is fine, but document it). History should persist across refreshes if cheap (localStorage) — optional.
6. **Lifecycle**: `/api/health` returns `{"ok":true}`. Clean shutdown on SIGINT. Log each request to stdout briefly. The gateway and the REPL can coexist in one process but for v1.1 `taiwei serve` runs the gateway standalone (no REPL in same process).
7. Zero new npm dependencies — node:http, SSE by hand. If that is impossible for some reason, document why.
8. Update README (usage section: how to start and open the gateway). Add a smoke test: start server on a random port, POST a mocked chat (or health check + static page 200 + SSE headers), assert streaming works, then close. `npm test` must stay green.
9. Keep `npm run build` passing (tsc). Frontend files under `src/gateway/public/` must be copied to `dist/` (adjust tsconfig/package.json build so dist has them — e.g. a small `cp` step in the build script or resolve paths from src in dev).
10. **Gateway settings** include a persistent custom prompt that is injected as a distinct system-prompt section on every gateway, REPL, one-shot, and cron turn; changes apply from the next turn.

## Gateway Auth (v1.2 — ADD THIS)

Add password login to the web gateway (it currently binds 0.0.0.0 with no auth — anyone on the network can chat). Requirements:

1. **Config**: `~/.taiwei/config.json` gains `auth: { enabled: true, username: "admin", password: "..." }`. `enabled: true` + empty/missing password → fail startup with a clear message telling the user to set `auth.password` (or use `TAIWEI_AUTH_PASSWORD` env override). Default in `--init` template: `enabled: false` (opt-in), but document it.
2. **Login API**: `POST /api/login` `{username, password}` → 200 `{token}` (random, `crypto.randomBytes` hex) or 401. Brute-force protection: after 5 failed attempts from the same IP within 10 minutes, return 429 and log a warning (simple in-memory counter is fine). **Sessions MUST persist to disk** (`~/.taiwei/gateway-sessions.json`: `{token: {username, createdAt, expiresAt}}`) — save on login, load on startup, so **restarting the gateway does NOT log the user out** (this is an explicit user requirement). Expiry: 7 days sliding (extend expiresAt on each authenticated request; rewrite the file).
3. **Auth middleware**: all `/api/*` routes require auth EXCEPT `/api/health` and `/api/login`. Accept `Authorization: Bearer <token>` header OR a `taiwei_token` cookie (set on login, `HttpOnly`, `SameSite=Lax`, `Max-Age` 7d). Unauthorized → 401 JSON `{"error":"unauthorized"}`.
4. **Frontend**: login view (centered card: 🦞 logo, username + password inputs, submit button, error message, loading state). On page load: if `/api/sessions` returns 401 → show login view; after successful login (fetch POST /api/login, store token in localStorage + rely on cookie), load the chat UI. Logout button in the sidebar bottom (clears token/cookie, returns to login view). Keep the existing chat UI untouched otherwise.
5. **Password storage**: store `password` in config as plain text is acceptable for a local tool, but if easy use a salted hash (`crypto.scryptSync`, store `scrypt$salt$hash`) — your call, document the choice. The `TAIWEI_AUTH_PASSWORD` env override compares against the plain value.
6. **Tests**: add tests for login (wrong password 401, correct 200+token, protected route without token 401, with token 200). `npm test` must stay green (existing 7 + new).
7. Update README (auth section: enable + how to log in). Commit in logical chunks with clear English messages.

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
