# taiwei

`taiwei` is a proactive AI agent inspired by opencode and OpenClaw. It supports a terminal CLI and local browser chat, streamed OpenAI-compatible models, tool calls, skills, scheduled autonomous turns, MCP servers, durable memory, local RAG, and plugins.

## Install and initialize

Requires Node.js 20 or newer.

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
    "search_files": { "enabled": true, "maxResults": 50 }
  },
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

The optional `models` array is the user-curated candidate list shown by the REPL and web gateway. taiwei never fetches the provider's upstream model list. Duplicate names are removed while preserving order; when `models` is absent or empty, only the current model is shown.

`contextWindows` can override the context-window size for individual model names. `contextWindow` is the fallback for models without an entry and defaults to 256,000 tokens when omitted or invalid. When prompt usage exceeds `contextWindow * compressThreshold`, taiwei summarizes older complete turns while retaining recent history; `compressThreshold` defaults to `0.7`, and zero or invalid values use that default. Before compression, `memoryFlush` (default `true`) asks the model to preserve durable facts from the discarded history in `memory.md`; set it to `false` to skip this step. Flush-driven appends retain only the newest approximately 60 KiB of memory.

`embedModel` selects the OpenAI-compatible embedding model and defaults to the `embeddings` model group. Set it to a concrete model such as `qwen3.7-text-embedding` when needed; embeddings use the same `baseUrl` and `apiKey` as chat.

`autoLoadSkills` defaults to `true`: each new gateway chat turn and each REPL startup activates every enabled installed skill automatically. Skills named in `skillsDisabled` are skipped. Set `autoLoadSkills` to `false` to keep manual, session-level activation with `/skill load`.

## Usage

```bash
./bin/taiwei                         # interactive REPL
./bin/taiwei "summarize this repo"   # one-shot agent turn
./bin/taiwei serve                   # local web chat at http://127.0.0.1:8688
./bin/taiwei serve --port 9000       # override the configured port
./bin/taiwei cron list               # inspect durable scheduled jobs
./bin/taiwei cron run <id>           # run a job immediately
./bin/taiwei --help
./bin/taiwei --version
```

The REPL commands are:

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

Ctrl+C cancels an active LLM request or tool. Both the REPL and resident gateway start the scheduler. Agent jobs wait for an active interactive turn, while script jobs use no LLM tokens. Jobs support cron/interval schedules or a one-shot ISO `at`, timezones, timeout, retry/backoff, overlap and misfire policies, and console/webhook/no delivery. Every result survives restarts in `~/.taiwei/cron-runs.jsonl`; empty stdout with exit 0 is a silent watchdog success.

Plan and Build are built-in session profiles. Plan hides and rejects shell/file-write tools; Build retains the normal tool set. `delegate_task` starts an isolated child conversation, returns only its final result, inherits the parent’s restrictions, propagates cancellation, and defaults to three concurrent children with depth two.

### Browser tools

Playwright is loaded only when a `browser_*` tool is first used. Install its Chromium binary after `npm install`:

```bash
npx playwright install chromium
```

The tools navigate, click, fill, extract text/links, and save workspace-local PNG screenshots. A shared browser closes after `browser.idleMinutes`; set `browser.userDataDir` to preserve cookies/login state. The shipped Chinese `playwright` skill documents the recommended workflow and common failures. If Chromium is absent, tools return the same install command as an actionable error while the rest of taiwei continues normally.

### Local RAG

Put Markdown or text files under `~/.taiwei/knowledge/`, then run `/rag index` to rebuild the index. The same index also includes Markdown files in `~/.taiwei/memory/`; sources retain a `knowledge/` or `memory/` prefix. Indexing embeds chunks in batches of up to 32 and stores vectors alongside the BM25 data in `~/.taiwei/rag-index.json`. Searches fuse the top BM25 and cosine-similarity candidates with Reciprocal Rank Fusion and return the best five results. The web gateway performs this retrieval automatically before every user message and injects matching knowledge into that turn.

If query embedding fails because of a timeout, network error, or upstream response, search automatically falls back to BM25. Legacy indexes without vectors also remain readable and use BM25; run `/rag index` to add vectors.

The workspace defaults to `~/workspace` (with `~` expanded using the operating-system home directory). taiwei creates it on startup and uses it as the default working directory for bash and other filesystem tools; it is a starting directory, not a jail, so commands may still use `cd`. Run `/workspace <path>` or use the web settings panel to change it. A running turn keeps its original directory, while later turns use the saved value.

Run `/model` to list the models configured in the `models` array and mark the current one, or `/model <name>` to switch. With a configured list, switching to any other name is rejected. When the list is absent or empty, any non-empty model name is allowed. The choice is written to `~/.taiwei/config.json` and is shared immediately by the REPL, one-shot commands, scheduled turns, and the gateway.

### Local web chat

Run `./bin/taiwei serve`, then open `http://127.0.0.1:8688`. The polished browser UI streams answer tokens and tool activity live, supports dark and light themes, includes a model switcher and local file attachments in the message composer, and provides a sidebar for creating, switching, and deleting conversations. Stop cancels the current LLM request or tool through the same cooperative interrupt mechanism as the CLI.

The subtle sidebar label shows the resolved workspace. The gear button opens settings for persistent custom instructions, the workspace, lifecycle hooks, and dangerous-command policy. The custom prompt is injected as a distinct system-prompt section on every gateway, REPL, one-shot, and cron turn; edits take effect on the next turn. `GET/POST /api/settings/custom-prompt` loads and saves up to 20,000 characters, while `GET/POST /api/settings` handles the other settings. All of these routes follow the normal gateway authentication policy. The Hooks section also runs a selected event's first command against a sample payload through `POST /api/hooks/test`.

The sidebar panels manage installed skills, knowledge files, MCP servers, tools, and layered memory. Core memory remains `~/.taiwei/memory.md`; every turn receives only its newest 2,000 characters. Larger extended notes live as `~/.taiwei/memory/<name>.md`, are not injected automatically, and become searchable on demand after rebuilding the shared RAG index. `memory_read` and `memory_append` operate on small core facts; `memory_extend` writes a named extended note and `memory_list` reports both tiers. Historical conversation search remains backed by `history.db` and `session_search`.

Each conversation is stored as a JSON file under `~/.taiwei/sessions/`, so history and agent context survive browser refreshes and gateway restarts. The gateway binds to localhost by default. Set `gateway.host` and `gateway.port` in `~/.taiwei/config.json`, with `serve --port N` taking precedence over the configured port.

The composer includes a circular context-usage ring. taiwei requests OpenAI-compatible streaming usage (`stream_options.include_usage`), normalizes `prompt_tokens`, `completion_tokens`, and `total_tokens`, and emits an SSE `usage` event after each provider call. The gateway accumulates those provider-reported values in the current session file, and the browser updates the ring as usage arrives (with a small interim completion estimate while text is streaming). Hover or focus the ring to inspect the totals, window size, and percentage.

Use the paperclip button to attach up to five files to a message. Each file is uploaded only to `~/.taiwei/uploads/` with a 10 MB per-file limit and a sanitized filename. Text-like formats are included in the model message up to 8,000 characters; binary files are represented by their absolute local path so the agent can inspect them with its existing tools. `POST /api/upload` uses a raw request body with the URL-encoded filename in `X-File-Name`, avoiding a multipart dependency.

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

Open the gateway and use **管理员登录** for the local administrator account. Successful login creates a seven-day sliding session in `~/.taiwei/gateway-sessions.json`; the browser keeps both an HttpOnly cookie and a bearer token, and gateway restarts preserve active logins. Login lock state is persisted separately in `~/.taiwei/login-locks.json`: five failures for the same account and IP within a sliding ten-minute window trigger a ten-minute cooldown, ten cumulative failures permanently lock that account/IP pair, and ten failures across any accounts from one IP within a sliding ten-minute window lock the IP for ten minutes. A successful login resets the matching account/IP counters. Click the username in the top-right corner and choose **退出登录 / Logout** to invalidate the current token and return to login.

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

Execution policy, concurrency, context budgeting, retries, and auditing are configured in `~/.taiwei/config.json`. Gateway guests are denied shell, file-write, memory-management, MCP, and plugin tools by default; Plan mode is read-only. Custom `policy.rules` are first-match and can explicitly allow or deny narrower role/tool/path combinations. Guest and Plan file access is confined to `workspace.dir` with realpath/symlink checks.

Provider recovery defaults to three attempts for 429/5xx/network failures and honors `Retry-After`; set `fallbackModel` for one final model fallback. Audit events append to `~/.taiwei/audit.jsonl` with secret-shaped argument keys redacted. Administrators can inspect recent entries in Settings or through `GET /api/audit`.

## State and extensions

All durable state lives in `~/.taiwei/`:

```text
config.json       model and provider settings
cron.json         scheduled jobs
cron-runs.jsonl   append-only scheduled-run ledger
audit.jsonl       redacted append-only policy and execution audit
mcp.json          MCP server definitions
memory.md         durable agent memory
memory/           extended Markdown memory indexed with the knowledge base
rag-index.json    generated BM25 and embedding index
knowledge/        .md and .txt knowledge documents
skills/           <name>/SKILL.md skills
plugins/          <name>/plugin.js plugins
sessions/         durable web chat conversations
guests/           guest-scoped core memory and web sessions
gateway-sessions.json  durable gateway login tokens
login-locks.json   durable login failure and lock state
uploads/           local web-chat attachments
```

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

`mcp.json` is an array. Both stdio and legacy HTTP SSE transports are supported through the official MCP SDK:

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
    "transport": "sse",
    "url": "https://example.test/sse",
    "enabled": false
  }
]
```

MCP tools are exposed as `mcp_<server>_<tool>`.

### Plugins

Each `~/.taiwei/plugins/<directory>/plugin.js` may be ESM or CommonJS and exports `{ name, tools?, skills?, init? }`. Tool entries use the same shape as built-in tools: `{ name, description, parameters, execute(args, context) }`.

```js
export default {
  name: 'example',
  tools: [{
    name: 'hello',
    description: 'Return a greeting',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'hello from a plugin'
  }],
  skills: [{
    name: 'friendly',
    description: 'Use a friendly voice.',
    body: 'Be warm and direct.'
  }],
  async init({ home }) {
    // Optional startup hook.
  }
};
```

Plugin tools receive a `plugin_<plugin>_` prefix. Reloading plugins removes previously registered plugin-prefixed tools before loading the current files.

## Development

```bash
npm run build
npm test
```

The runtime dependencies are limited to `@modelcontextprotocol/sdk` and `cron-parser`.
