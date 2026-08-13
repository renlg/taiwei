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
  "models": ["gpt-4.1-mini", "good", "free"],
  "contextWindow": 128000,
  "contextWindows": { "gpt-4.1-mini": 128000, "good": 200000 },
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "",
  "maxTurns": 50,
  "requestTimeoutMs": 120000,
  "gateway": {
    "host": "127.0.0.1",
    "port": 8688
  },
  "auth": {
    "enabled": false,
    "username": "admin",
    "password": ""
  }
}
```

`TAIWEI_API_KEY`, `TAIWEI_BASE_URL`, `TAIWEI_MODEL`, and `TAIWEI_AUTH_PASSWORD` override the corresponding file values. `TAIWEI_HOME` can override the state directory (useful for isolated environments).

The optional `models` array is the candidate list shown by the REPL and web gateway. Without it, taiwei requests `GET {baseUrl}/models` using the configured API key and falls back to the current model if the provider is unavailable. Model names are used as returned, including relay group names such as `good` and `free`.

`contextWindows` can override the context-window size for individual model names. `contextWindow` is the fallback for models without an entry and defaults to 128,000 tokens when omitted or invalid.

## Usage

```bash
./bin/taiwei                         # interactive REPL
./bin/taiwei "summarize this repo"   # one-shot agent turn
./bin/taiwei serve                   # local web chat at http://127.0.0.1:8688
./bin/taiwei serve --port 9000       # override the configured port
./bin/taiwei --help
./bin/taiwei --version
```

The REPL commands are:

```text
/help  /exit  /stop  /clear  /model [name]
/skill list|load|unload ...
/cron list|add|remove|pause|resume ...
/mcp list|reload
/memory show|clear
/rag index|search ...
/plugin list|reload
```

Cron arguments that contain spaces should be quoted:

```text
/cron add status "every 1h" "Review this repository and summarize its status"
```

Ctrl+C cancels an active LLM request or tool. Scheduled turns wait for an active interactive turn to finish, run in a fresh conversation, then print a notification banner in the REPL.

Run `/model` to list available models and mark the current one, or `/model <name>` to switch. The choice is written to `~/.taiwei/config.json` and is shared immediately by the REPL, one-shot commands, scheduled turns, and the gateway.

### Local web chat

Run `./bin/taiwei serve`, then open `http://127.0.0.1:8688`. The polished browser UI streams answer tokens and tool activity live, supports dark and light themes, includes a model switcher in the message composer, and provides a sidebar for creating, switching, and deleting conversations. Stop cancels the current LLM request or tool through the same cooperative interrupt mechanism as the CLI.

Each conversation is stored as a JSON file under `~/.taiwei/sessions/`, so history and agent context survive browser refreshes and gateway restarts. The gateway binds to localhost by default. Set `gateway.host` and `gateway.port` in `~/.taiwei/config.json`, with `serve --port N` taking precedence over the configured port.

The composer includes a context-usage bar. taiwei requests OpenAI-compatible streaming usage (`stream_options.include_usage`), normalizes `prompt_tokens`, `completion_tokens`, and `total_tokens`, and emits an SSE `usage` event after each provider call. The gateway accumulates those provider-reported values in the current session file, and the browser updates the meter as usage arrives (with a small interim completion estimate while text is streaming). Hover or focus the bar to inspect the totals, window size, and percentage.

Health checks are available at `GET /api/health`. Model state is exposed through `GET /api/models`, `GET /api/model`, and `POST /api/model`; these routes use the same authentication policy as the other gateway APIs. Session management is exposed locally through `GET/POST /api/sessions`, `GET/DELETE /api/sessions/:id`, and the optional `sessionId` field on `POST /api/chat`.

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

The password is stored as plain text because taiwei is a local tool; protect `~/.taiwei/config.json` with normal user-only filesystem permissions. You may leave `auth.password` empty in the file and supply `TAIWEI_AUTH_PASSWORD` when starting the gateway. If authentication is enabled and neither source provides a password, `taiwei serve` refuses to start with setup instructions.

Open the gateway and sign in through the login screen. Successful login creates a seven-day sliding session in `~/.taiwei/gateway-sessions.json`; the browser keeps both an HttpOnly cookie and a bearer token, and gateway restarts preserve active logins. Five failed attempts from one IP within ten minutes temporarily rate-limit further attempts. Click the username in the top-right corner and choose **退出登录 / Logout** to invalidate the current token and return to login.

## State and extensions

All durable state lives in `~/.taiwei/`:

```text
config.json       model and provider settings
cron.json         scheduled jobs
mcp.json          MCP server definitions
memory.md         durable agent memory
rag-index.json    generated BM25 index
knowledge/        .md and .txt knowledge documents
skills/           <name>/SKILL.md skills
plugins/          <name>/plugin.js plugins
sessions/         durable web chat conversations
gateway-sessions.json  durable gateway login tokens
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
