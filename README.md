# taiwei

`taiwei` is a proactive, terminal-only AI agent inspired by opencode and OpenClaw. It supports streamed OpenAI-compatible models, tool calls, skills, scheduled autonomous turns, MCP servers, durable memory, local RAG, and plugins—without a web UI or daemon.

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
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "",
  "maxTurns": 50,
  "requestTimeoutMs": 120000
}
```

`TAIWEI_API_KEY`, `TAIWEI_BASE_URL`, and `TAIWEI_MODEL` override the file. `TAIWEI_HOME` can override the state directory (useful for isolated environments).

## Usage

```bash
./bin/taiwei                         # interactive REPL
./bin/taiwei "summarize this repo"   # one-shot agent turn
./bin/taiwei --help
./bin/taiwei --version
```

The REPL commands are:

```text
/help  /exit  /stop  /clear  /model <name>
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
