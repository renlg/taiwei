# taiwei

`taiwei` is a proactive AI agent inspired by opencode and OpenClaw. It supports a terminal CLI and local browser chat, streamed OpenAI-compatible models, tool calls, skills, scheduled autonomous turns, MCP servers, durable memory, local RAG, and plugins.

## Install and initialize

Requires Node.js 22 or newer (the tenant and history stores use `node:sqlite`).

```bash
npm install
npm run build
./bin/taiwei --init
```

Edit `~/.taiwei/config.json`, or set environment variables:

```json
{
  "model": "gpt-4.1-mini",
  "embedModel": "embeddings",
  "models": ["good", "free", "deepseek-v4-flash"],
  "contextWindow": 256000,
  "contextWindows": { "gpt-4.1-mini": 256000, "good": 200000 },
  "compressThreshold": 0.7,
  "memoryFlush": true,
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "",
  "defaultProvider": "default",
  "providers": [],
  "maxTurns": 50,
  "requestTimeoutMs": 120000,
  "fallbackModel": "",
  "tokenEstimateCharsPerToken": 4,
  "budget": { "systemMax": 20000, "historyMax": 180000, "toolsMax": 30000, "outputReserve": 16000 },
  "retry": { "maxAttempts": 3, "baseDelayMs": 1000, "maxDelayMs": 30000 },
  "runtime": { "maxConcurrentTurns": 4 },
  "policy": { "rules": [] },
  "customPrompt": "",
  "hookTimeoutSeconds": 10,
  "hooks": {
    "beforeMessage": [],
    "beforeLLM": [],
    "afterLLM": [],
    "beforeTool": [],
    "afterTool": []
  },
  "autoLoadSkills": true,
  "skillsDisabled": [],
  "delegation": { "maxConcurrent": 3, "maxDepth": 2 },
  "browser": { "headless": true, "userDataDir": "", "idleMinutes": 10 },
  "tools": {
    "rag_search": { "enabled": true, "limit": 5 },
    "bash": { "enabled": true, "defaultCwd": "" },
    "search_files": { "enabled": true, "maxResults": 50 },
    "web_search": { "enabled": true, "provider": "tavily", "apiKey": "" },
    "delegate_task": { "enabled": true, "allowedAgents": "research" }
  },
  "plugins": {},
  "gateway": {
    "host": "127.0.0.1",
    "port": 8688
  },
  "auth": {
    "enabled": false,
    "username": "admin",
    "password": ""
  },
  "oauth": {
    "enabled": false,
    "providerBaseUrl": "",
    "clientId": "taiwei",
    "clientSecret": "taiwei-secret-2026",
    "redirectUri": ""
  },
  "gitea": {
    "baseUrl": "",
    "adminToken": ""
  },
  "share": {
    "enabled": false,
    "token": "",
    "createdAt": ""
  },
  "workspace": {
    "dir": "~/workspace"
  },
  "security": {
    "enabled": true,
    "patterns": [],
    "timeoutSeconds": 60,
    "remember": "off",
    "approvedPatterns": []
  }
}
```

`TAIWEI_API_KEY`, `TAIWEI_BASE_URL`, `TAIWEI_MODEL`, and `TAIWEI_AUTH_PASSWORD` override the corresponding file values. `OAUTH_TAIWEI_SECRET` overrides `oauth.clientSecret`, and `OAUTH_TAIWEI_REDIRECT` overrides `oauth.redirectUri`. `TAIWEI_HOME` can override the state directory (useful for isolated environments).

`providers` is the provider/model capability catalog. An empty array preserves the legacy behavior by synthesizing a `default` OpenAI-compatible provider from `baseUrl`, `apiKey`, `model`, and `models`. The historical `apiBaseUrl` spelling is also accepted as a legacy alias. Explicit providers use `{id,name,type,baseUrl,apiKey?,defaultModel?,models?}`; types are `openai-compatible` and `anthropic` (`responses` is reserved but not implemented). Each model declares `capabilities: {tools,vision,reasoning,streaming,contextWindow}` and optional per-million-token costs. Models without tool support receive no tool definitions.

The optional legacy `models` array remains the user-curated candidate list for the default provider. taiwei never fetches an upstream model list.

`contextWindows` can override the context-window size for individual model names. `contextWindow` is the fallback for models without an entry and defaults to 256,000 tokens when omitted or invalid. When prompt usage exceeds `contextWindow * compressThreshold`, taiwei summarizes older complete turns while retaining recent history; `compressThreshold` defaults to `0.7`, and zero or invalid values use that default. Before compression, `memoryFlush` (default `true`) asks the model to preserve durable facts from the discarded history in `memory.md`; set it to `false` to skip this step. Flush-driven appends retain only the newest approximately 60 KiB of memory.

`embedModel` selects the OpenAI-compatible embedding model and defaults to the `embeddings` model group. Set it to a concrete model such as `qwen3.7-text-embedding` when needed; embeddings use the same `baseUrl` and `apiKey` as chat.

`autoLoadSkills` defaults to `true`: each new gateway chat turn and each REPL startup activates every enabled installed skill automatically. Skills named in `skillsDisabled` are skipped. Set `autoLoadSkills` to `false` to keep manual, session-level activation with `/skill load`.

## Usage

```bash
./bin/taiwei                         # zero-dependency ANSI TUI on a TTY
./bin/taiwei --repl                  # legacy readline REPL
./bin/taiwei "summarize this repo"   # one-shot agent turn
./bin/taiwei serve                   # local web chat at http://127.0.0.1:8688
./bin/taiwei serve --port 9000       # override the configured port
./bin/taiwei cron list               # inspect durable scheduled jobs
./bin/taiwei cron run <id>           # run a job immediately
./bin/taiwei --help
./bin/taiwei --version
```

The TUI starts with a recent-session picker and supports streamed messages/tool activity, input history, command completion, resize handling, `/resume <id>`, `/export <path>`, `/agent <plan|build|research>`, and session-local `/model <provider>/<model>`. Ctrl+C cancels an active turn or clears the draft, Ctrl+D exits, and Ctrl+L clears the pane. Non-TTY input automatically uses the readline REPL. The REPL commands are:

```text
/help  /exit  /stop  /clear  /model [name]  /agent list|use|reset
/workspace <path>
/skill list|load|unload ...
/cron list|add|remove|pause|resume|run|history ...
/mcp list|reload
/memory show|clear
/rag index|search ...
/plugin list|reload
```

Cron arguments that contain spaces should be quoted:

```text
/cron add status "every 1h" "Review this repository and summarize its status"
```

Ctrl+C cancels an active LLM request or tool. Both the REPL and resident gateway start the scheduler. Agent jobs wait for an active interactive turn. Jobs support cron/interval schedules or a one-shot ISO `at`, timezones, timeout, retry/backoff, overlap and misfire policies, and console/webhook/no delivery. Jobs and run results survive restarts in `~/.taiwei/state.db`.

### Background task tools

The agent can start long-running commands (deploys, batch jobs, data syncs) as detached background processes and block-wait for them within the same turn — similar to Hermes `process wait/poll`.

- **`task_start(command, cwd?, timeout_ms?)`** — spawn a detached background process. stdout and stderr are written to per-task log files under `~/.taiwei/tasks/<id>/`. Returns `{ id, pid, cwd, startedAt }`. The optional `timeout_ms` is a safety net that kills the process after the given wall-clock duration.
- **`task_wait(id, timeout_seconds?)`** — block until the task exits or the wait timeout expires (default 3600 s). Returns complete `stdout`, `stderr`, `exitCode`, `exitSignal`, `duration`, and `status` (`completed` or `timed_out`). A timed-out wait does **not** kill the task; use `task_kill` afterwards.
- **`task_poll(id)`** — non-blocking status check: returns `running`/`completed`/`timed_out`/`killed`, partial stdout/stderr, exit code, and uptime.
- **`task_kill(id)`** — SIGTERM with a 3-second grace period, then SIGKILL. No-op for tasks that have already finished.

Multiple tasks run concurrently. The task registry (`~/.taiwei/tasks/registry.json`) persists across turns and restarts; finished tasks retain their full logs. All `task_*` tools are admin-only; guests are denied the entire family, and plan mode blocks `task_start` and `task_kill`.

Plan, Build, and Research are built-in session profiles. Plan hides and rejects shell, file-write, browser, and MCP tools; Build retains the normal tool set; Research allows only `search_files`, `read_file`, and `web_search` (read-only investigation). `delegate_task` starts an isolated child conversation, returns only its final result, inherits the parent’s restrictions, propagates cancellation, and defaults to three concurrent children with depth two. Delegation defaults to the `research` agent (least-privilege read-only); administrators may enable `plan` or `build` via the `delegate_task` tool setting `allowedAgents`.

### Browser tools

Playwright is loaded only when a `browser_*` tool is first used. Install its Chromium binary after `npm install`:

```bash
npx playwright install chromium
```

The tools navigate, click, fill, extract text/links, and save workspace-local PNG screenshots. A shared browser closes after `browser.idleMinutes`; set `browser.userDataDir` to preserve cookies/login state. The shipped Chinese `playwright` skill documents the recommended workflow and common failures. If Chromium is absent, tools return the same install command as an actionable error while the rest of taiwei continues normally.

### Local RAG

Put Markdown or text files under `~/.taiwei/knowledge/`, then run `/rag index` to rebuild the index. The same index also includes Markdown files in `~/.taiwei/memory/`; sources retain a `knowledge/` or `memory/` prefix. Indexing embeds chunks in batches of up to 32 and stores vectors alongside the BM25 data in `~/.taiwei/rag-index.json`. Searches fuse the top BM25 and cosine-similarity candidates with Reciprocal Rank Fusion and return the best five results. The web gateway performs this retrieval automatically before every user message and injects matching knowledge into that turn.

If query embedding fails because of a timeout, network error, or upstream response, search automatically falls back to BM25. Legacy indexes without vectors also remain readable and use BM25; run `/rag index` to add vectors.

### Web search

The `web_search` tool queries the public web through a configurable third-party provider. Supported providers are `tavily` (default) and `serper`. Configure the API key in the tool settings panel or set the `TAIWEI_WEB_SEARCH_API_KEY` environment variable. Without a key the tool returns a configuration error instead of making a network request. The tool is available to all agent profiles; the `research` profile includes it in its allow list by default.

The workspace defaults to `~/workspace` (with `~` expanded using the operating-system home directory). taiwei creates it on startup and uses it as the default working directory for bash and other filesystem tools; it is a starting directory, not a jail, so commands may still use `cd`. Run `/workspace <path>` or use the web settings panel to change it. A running turn keeps its original directory, while later turns use the saved value.

Run `/model` in the TUI to list providers and models, or `/model <provider>/<model>` to switch only the current terminal session. The browser model switcher is also session-local. The legacy REPL `/model <name>` command still updates the global default for backward compatibility.

### Local web chat

Run `./bin/taiwei serve`, then open `http://127.0.0.1:8688`. The polished browser UI streams answer tokens and tool activity live, supports dark and light themes, includes a model switcher and local file attachments in the message composer, and provides a sidebar for creating, switching, and deleting conversations. Stop cancels the current LLM request or tool through the same cooperative interrupt mechanism as the CLI.

The subtle sidebar label shows the resolved workspace. The gear button opens settings for persistent custom instructions, the workspace, lifecycle hooks, and dangerous-command policy. The custom prompt is injected as a distinct system-prompt section on every gateway, REPL, one-shot, and cron turn; edits take effect on the next turn. `GET/POST /api/settings/custom-prompt` loads and saves up to 20,000 characters, while `GET/POST /api/settings` handles the other settings. All of these routes follow the normal gateway authentication policy. The Hooks section also runs a selected event's first command against a sample payload through `POST /api/hooks/test`.

The sidebar panels manage installed skills, knowledge files, MCP servers, tools, and layered memory. Core memory remains `~/.taiwei/memory.md`; every turn receives only its newest 2,000 characters. Larger extended notes live as `~/.taiwei/memory/<name>.md`, are not injected automatically, and become searchable on demand after rebuilding the shared RAG index. `memory_read` and `memory_append` operate on small core facts; `memory_extend` writes a named extended note and `memory_list` reports both tiers. Historical conversation search remains backed by `history.db` and `session_search`.

### Deployment management

The **部署管理** panel reads deployment records from the `deployments` table in the existing `~/.taiwei/history.db`. Administrators can manage every owner; guests can list, register, reconcile, and clean only the owner hash derived from their tenant OS identity. A deployer records a successful deployment with an authenticated `POST /api/deployments` request:

```json
{
  "name": "myapp",
  "ownerHash": "8c6976e5",
  "path": "/taiwei/8c6976e5/myapp/",
  "port": 8801,
  "dir": "/root/workspace/current-session-project",
  "url": "https://example.com/taiwei/8c6976e5/myapp/",
  "status": "running"
}
```

`dir` should be the current gateway session's workspace directory—the same directory where the agent writes the project. The API accepts an exact registered workspace folder; older deployers may continue using `~/.taiwei/projects/<ownerHash>/<name>` as a fallback.

`GET /api/deployments` lists records and accepts an optional `ownerHash` filter. `GET /api/deployments/doctor` performs a read-only comparison of the database's desired state with the observed listening port, nginx location, and project directory. `DELETE /api/deployments/:name?ownerHash=...` performs the cleanup described below; the owner hash is required to disambiguate duplicate project names.

The panel's **清理** action stops the process listening on the recorded port, recursively deletes the recorded project directory after verifying that it is either an exact registered workspace or inside the legacy `~/.taiwei/projects/` root, and invokes `~/.taiwei/skills/taiwei-编程部署/scripts/nginx_deploy.py <ownerHash> <name> --remove`. Each step reports its own result and the deployment row is retained with status `cleaned` for audit history. The same operation can be run directly with [`scripts/cleanup_deployment.sh`](scripts/cleanup_deployment.sh):

```bash
bash scripts/cleanup_deployment.sh 8c6976e5 myapp 8801 /root/workspace/current-session-project
```

For a session-workspace deployment, run that command from the project directory or set `TAIWEI_SESSION_WORKSPACE` to its absolute path. Legacy project-root deployments continue to work without that variable.

Each conversation is stored in `~/.taiwei/state.db`; guest rows carry an isolated owner scope, so history and agent context survive browser refreshes and gateway restarts without sharing guest data. The gateway binds to localhost by default. Set `gateway.host` and `gateway.port` in `~/.taiwei/config.json`, with `serve --port N` taking precedence over the configured port.

The composer includes a circular context-usage ring. taiwei requests OpenAI-compatible streaming usage (`stream_options.include_usage`), normalizes `prompt_tokens`, `completion_tokens`, and `total_tokens`, and emits an SSE `usage` event after each provider call. The gateway accumulates those provider-reported values in the current session file, and the browser updates the ring as usage arrives (with a small interim completion estimate while text is streaming). Hover or focus the ring to inspect the totals, window size, and percentage.

Use the paperclip button to attach up to five files to a message. Files have a 10 MB per-file limit and a sanitized display filename. By default they are stored under `~/.taiwei/uploads/`; when `oss.enabled` is true they are uploaded directly to public-read Aliyun OSS with a built-in V1 signature implementation. Remote image attachments are passed to the model as Markdown images, while local text-like formats are included up to 8,000 characters and other files are represented by their path. `POST /api/upload` uses a raw request body with the URL-encoded filename in `X-File-Name`, avoiding a multipart dependency.

Aliyun OSS upload configuration (no SDK or additional dependency is required):

```json
{
  "oss": {
    "enabled": true,
    "accessKeyId": "<ALIYUN_ACCESS_KEY_ID>",
    "accessKeySecret": "<ALIYUN_ACCESS_KEY_SECRET>",
    "bucket": "renlg",
    "endpoint": "oss-cn-hangzhou.aliyuncs.com",
    "prefix": "taiwei"
  }
}
```

The bucket must allow public reads for the returned object URL to be accessible. Keep `accessKeySecret` private. If `oss.enabled` is false or the `oss` section is absent, uploads continue to use local disk.

Health checks are available at `GET /api/health`. Model state is exposed through `GET /api/models`, `GET /api/model`, and `POST /api/model`; these routes use the same authentication policy as the other gateway APIs. Session management is exposed locally through `GET/POST /api/sessions`, `GET/DELETE /api/sessions/:id`, and the optional `sessionId` field on `POST /api/chat`.

#### Dangerous-command confirmation

Command confirmation is enabled by default. The built-in regex classes cover access to sensitive taiwei configuration files (`config.json`, `gateway-sessions.json`, and `login-locks.json`), recursive forced removal of root/home/system paths (including `sudo rm`), `mkfs`, device-writing `dd`, `fdisk`/`format`, system shutdown/reboot/halt/poweroff, recursive permission/ownership changes, fork bombs, forced Git pushes, and `curl`/`wget` output piped into a shell. Other taiwei state such as `memory.md`, chat sessions, and uploads is not covered by the sensitive-config rule. Strings in `security.patterns` are additional case-insensitive regular expressions; they append to the built-ins rather than replacing them. Invalid custom regexes are rejected by the settings API.

When bash matches a rule, the chat stream pauses and emits:

```text
event: confirm
data: {"id":"...","command":"...","reason":"...","pattern":"...","level":"danger|warn","workspace":"/resolved/path","timeoutSeconds":60}
```

The browser renders each prompt as an interactive card inside the chat stream, so multiple pending confirmations can remain visible together. It answers through authenticated `POST /api/confirm` with `{"id":"...","approve":true|false,"remember":"off|session|permanent"}`. A missing answer is rejected after `security.timeoutSeconds`, and the card updates in place to show allowed, rejected, or timed-out state. Rejection returns `用户拒绝了该命令的执行` to the model so it can choose a safer approach. Interactive CLI turns prompt with `y/N`; one-shot and unattended cron turns auto-reject because no confirmer is available. Set `security.enabled` to `false` to bypass confirmation.

#### Lifecycle hooks

Hooks are zero-dependency shell extension points configured as one command per array entry. Commands run with `process.env.SHELL || /bin/sh` using `-lc`, from the configured workspace (so relative paths resolve there and the shell expands `~`). For example:

```json
{
  "hookTimeoutSeconds": 10,
  "hooks": {
    "beforeMessage": ["./hooks/check-message.sh"],
    "beforeLLM": ["node ./hooks/add-context.js"],
    "afterLLM": [],
    "beforeTool": [],
    "afterTool": []
  }
}
```

Every hook receives one JSON object on stdin with `event`, Unix-millisecond `timestamp`, resolved `workspace`, optional `sessionId`, and event-specific fields. Valid JSON object stdout is interpreted as a response. `beforeMessage` and `beforeTool` may return `{"block":true,"reason":"..."}`; `beforeLLM` may return `{"extraContext":"..."}`, applied only to that provider call. Other stdout is logged and ignored. Hooks time out after `hookTimeoutSeconds` (10 seconds by default); timeout, spawn errors, non-zero exits, invalid stdout, and stderr are isolated and logged without crashing the turn. The same runner powers gateway, REPL, and one-shot turns.

Remembered approvals are keyed by the exact regex rule that matched, never by the raw command. `session` lasts for the taiwei process; `permanent` records that matched rule in `security.approvedPatterns`. The settings reset action clears custom and remembered rules and restores enabled/60 seconds/off. Because approvals apply to a rule class, keep custom expressions narrowly scoped.

#### Gateway authentication

Authentication is opt-in. It is strongly recommended whenever the gateway binds to `0.0.0.0` or another network-accessible address. Enable it in `~/.taiwei/config.json`:

```json
{
  "gateway": { "host": "0.0.0.0", "port": 8688 },
  "auth": {
    "enabled": true,
    "username": "admin",
    "password": "choose-a-strong-password"
  }
}
```

On config load/save, taiwei replaces a non-empty plaintext password with a salted scrypt value in the form `scrypt$<saltHex>$<hashHex>`. Existing plaintext configurations migrate automatically at startup or after their first successful login; login accepts both formats during migration. You may leave `auth.password` empty in the file and supply the plaintext `TAIWEI_AUTH_PASSWORD` only in the environment when starting the gateway. If authentication is enabled and neither source provides a password, `taiwei serve` refuses to start with setup instructions.

Open the gateway and use **管理员登录** for the local administrator account. Successful login creates a seven-day sliding session in `~/.taiwei/state.db`; the browser keeps both an HttpOnly cookie and a bearer token, and gateway restarts preserve active logins. Login lock state is stored in the same database: five failures for the same account and IP within a sliding ten-minute window trigger a ten-minute cooldown, ten cumulative failures permanently lock that account/IP pair, and ten failures across any accounts from one IP within a sliding ten-minute window lock the IP for ten minutes. A successful login resets the matching account/IP counters. Click the username in the top-right corner and choose **退出登录 / Logout** to invalidate the current token and return to login.

#### Sharing and ordinary users

Ordinary users authenticate through ai-connect OAuth2; taiwei no longer stores or manages local guest username/password accounts. Configure the identity provider in `~/.taiwei/config.json`:

```json
{
  "oauth": {
    "enabled": true,
    "providerBaseUrl": "http://101.37.19.62",
    "clientId": "taiwei",
    "clientSecret": "taiwei-secret-2026",
    "redirectUri": ""
  }
}
```

When `redirectUri` is empty, taiwei computes `http://<request-host>/api/oauth/callback`; set it explicitly, or use `OAUTH_TAIWEI_REDIRECT`, when taiwei is reached through a proxy, HTTPS, or a different public hostname. `OAUTH_TAIWEI_SECRET` is the recommended way to provide a non-default client secret. In the login screen choose **普通用户登录 → 通过 ai-connect 登录**. The browser registers a ten-minute OAuth state, redirects to ai-connect, and returns to taiwei, which exchanges the authorization code, reads the ai-connect username, and creates a durable seven-day sliding guest session.

On the first successful OAuth callback, taiwei also reserves a sequential tenant account (`guest1`, `guest2`, …), creates the matching OS user, and provisions a Gitea user, API token, and organization. Configure the production Gitea API root and an administrator token with `gitea.baseUrl` (for example `http://127.0.0.1:3000/api/v1`) and `gitea.adminToken`. When Gitea is unconfigured or a provisioning step fails, login still succeeds and the failure appears under **设置 → 用户账号** for an administrator; incomplete steps are retried on the next login. Passwords are persisted only as salted scrypt hashes. Deleting an account from that panel locks the OS login and preserves its home directory and repositories.

To exercise the complete flow against the real relay at `http://101.37.19.62` from the same machine as the browser:

```bash
# config.json: oauth.enabled=true and oauth.providerBaseUrl="http://101.37.19.62"
OAUTH_TAIWEI_SECRET='taiwei-secret-2026' \
OAUTH_TAIWEI_REDIRECT='http://127.0.0.1:8688/api/oauth/callback' \
./bin/taiwei serve
```

Open `http://127.0.0.1:8688`, select **普通用户登录**, click **通过 ai-connect 登录**, sign in on ai-connect, and confirm that the browser returns directly to the chat page under the ai-connect username. If another device opens taiwei, replace `127.0.0.1` with the taiwei host that device can reach and ensure ai-connect accepts that exact callback URI.

Administrators can still open **设置 → 分享** to rotate a share link. A share link carries a random 32-hex-character credential in `?share=...`; OAuth users and share-link visitors both receive the guest role. Guest sessions may use chat and their own history only; all settings, model, skill, knowledge, MCP, tool, memory, and share APIs return `403 forbidden`.

Each OAuth user stores core memory under a sanitized `~/.taiwei/guests/guest-<ai-connect-username>/memory.md`; a share credential uses `~/.taiwei/guests/guest-<token-prefix>/memory.md`. These files are isolated from the administrator and other guests. Guests can retrieve the administrator-managed knowledge and extended-memory RAG index but cannot modify it. Disabling sharing immediately invalidates the current share credential. The administrator password remains stored as a salted scrypt hash when persisted.

## Policy, recovery, and audit

Execution policy, concurrency, context budgeting, retries, and auditing are configured in `~/.taiwei/config.json`. Gateway guests use a default-deny tool policy: built-in reads and file writes are allowed only inside their own workspace, while delegation, shell, memory-management, MCP, plugin, and unrecognized tools are denied. Plan mode is read-only. Custom `policy.rules` are first-match and can explicitly allow or deny narrower role/tool/path combinations. Guest history-tool queries are scoped to the caller identity, and Guest/Plan file access is confined to the active workspace with realpath/symlink checks.

Provider recovery defaults to three attempts for 429/5xx/network failures and honors `Retry-After`; set `fallbackModel` for one final model fallback. Audit events append to `~/.taiwei/audit.jsonl` with secret-shaped argument keys redacted. Administrators can inspect recent entries in Settings or through `GET /api/audit`.

## State and extensions

All durable state lives in `~/.taiwei/`:

```text
config.json       model and provider settings
state.db          authoritative sessions, cron jobs/runs, login sessions and login locks
history.db        rebuildable conversation search index (separate from authoritative state)
audit.jsonl       redacted append-only policy and execution audit
mcp.json          MCP server definitions
memory.md         durable agent memory
memory/           extended Markdown memory indexed with the knowledge base
rag-index.json    generated BM25 and embedding index
knowledge/        .md and .txt knowledge documents
skills/           <name>/SKILL.md skills
plugins/          <name>/plugin.js plugins
guests/           guest-scoped core memory and workspace files
uploads/           local web-chat attachments
tasks/             background task registry and per-task logs
```

On the first SQLite-backed startup, legacy `sessions/*.json`, guest session JSON, `cron.json`, `cron-runs.jsonl`, `gateway-sessions.json`, and `login-locks.json` are imported and renamed with a `.bak-<timestamp>` suffix. They are retained for recovery but are no longer written. On Node versions without `node:sqlite`, taiwei keeps using the legacy JSON formats as a compatibility fallback.

### Skills

A skill uses simple YAML frontmatter followed by Markdown:

```markdown
---
name: reviewer
description: Review code carefully.
---

Check correctness, security, and maintainability.
```

Disabled skills remain visible in the gateway manager but are omitted from CLI skill listings and cannot be loaded until re-enabled. The gateway endpoints are `GET /api/skills`, `GET /api/skills/:name`, and `POST /api/skills/:name` with `{"enabled":true|false}`. Tool management uses `GET /api/tools`, `POST /api/tools/:name`, and `POST /api/tools/reload`.

### MCP

`mcp.json` is an array. Stdio, legacy HTTP SSE, and modern Streamable HTTP transports are supported through the official MCP SDK. Streamable HTTP sends JSON-RPC POST requests accepting JSON or SSE, supports custom headers, and uses reconnect backoff. MCP tool-list change notifications refresh registered schemas.

```json
[
  {
    "name": "files",
    "transport": "stdio",
    "command": "node",
    "args": ["/path/to/server.js"],
    "env": {},
    "enabled": true
  },
  {
    "name": "remote",
    "transport": "streamable-http",
    "url": "https://example.test/mcp",
    "headers": { "Authorization": "Bearer ..." },
    "enabled": false
  }
]
```

MCP tools are exposed as `mcp_<server>_<tool>`.

### Plugins

Plugin API v1 uses `~/.taiwei/plugins/<directory>/manifest.json` (or a `package.json` `taiwei` field):

```json
{"name":"example","version":"1.0.0","apiVersion":1,"description":"Example","author":"You","capabilities":["tools"],"main":"index.js","skills":[]}
```

The main ESM/CommonJS module receives `{log, registerTool, registerSkill, config, policyCheck}` in `init(api)` and may export `dispose()`. Per-plugin settings live at `plugins.<name>.{enabled,config}` and can be changed with `GET /api/plugins` and `POST /api/plugins/:name`. Pending tool work is awaited before disposal; thrown handlers mark the plugin crashed and subsequent calls return an error. Legacy `plugin.js` exports remain supported.

```js
export default {
  init(api) {
    api.registerTool({
    name: 'hello',
    description: 'Return a greeting',
    parameters: { type: 'object', properties: {} }
    }, async () => 'hello from a plugin');
  }
};
```

Plugin tools receive a `plugin_<plugin>_` prefix. The current implementation uses guarded main-process execution rather than worker threads; crash containment handles thrown/rejected handlers but cannot isolate a native process crash or infinite synchronous loop.

## Development

```bash
npm run build
npm test
```

The runtime dependencies are limited to `@modelcontextprotocol/sdk` and `cron-parser`.
