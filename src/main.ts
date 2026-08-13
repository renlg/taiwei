import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TaiweiApp } from './app.js';
import { runOnce } from './cli/once.js';
import { runRepl } from './cli/repl.js';
import { initializeConfig, validateGatewayAuth } from './config/config.js';
import { AuthSessionStore } from './gateway/auth.js';
import { AgentChatBridge } from './gateway/chat.js';
import { closeGateway, createGatewayServer, listenGateway } from './gateway/server.js';
import { ensureTaiweiHome } from './util/paths.js';

const VERSION = '0.1.0';
const USAGE = `taiwei — proactive terminal AI agent

Usage:
  taiwei                     Start the interactive REPL
  taiwei "prompt"            Run one agent turn
  taiwei serve [--port N]    Start the local web chat gateway
  taiwei --init              Initialize ~/.taiwei
  taiwei --help              Show this help
  taiwei --version           Show the version`;

async function initializeHome(): Promise<void> {
  const paths = await ensureTaiweiHome();
  await initializeConfig();
  const directory = join(paths.skills, 'getting-started');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), `---\nname: getting-started\ndescription: A sample skill demonstrating taiwei skills.\n---\n\nAnswer clearly and end with one practical next step.\n`, { encoding: 'utf8', flag: 'wx' }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  console.log(`[taiwei] Initialized ${paths.home}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return; }
  if (args.includes('--version') || args.includes('-v')) { console.log(VERSION); return; }
  if (args.includes('--init')) { await initializeHome(); return; }
  const app = new TaiweiApp();
  try {
    const serve = args[0] === 'serve';
    await app.initialize({ scheduler: args.length === 0 });
    if (serve) {
      validateGatewayAuth(app.config);
      let port = app.config.gateway.port;
      if (args.length > 1) {
        if (args.length !== 3 || args[1] !== '--port') throw new Error('Usage: taiwei serve [--port N]');
        port = Number(args[2]);
        if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Gateway port must be an integer between 0 and 65535');
      }
      const authSessions = new AuthSessionStore();
      await authSessions.initialize();
      const server = createGatewayServer({
        chat: new AgentChatBridge(app),
        model: app.config.model,
        auth: app.config.auth,
        authSessions,
      });
      const boundPort = await listenGateway(server, app.config.gateway.host, port);
      console.log(`[taiwei] Gateway listening at http://${app.config.gateway.host}:${boundPort}`);
      await new Promise<void>((resolve) => {
        const shutdown = () => resolve();
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
      });
      console.log('\n[taiwei] Shutting down gateway…');
      app.interrupt.cancel();
      await closeGateway(server);
    } else if (args.length) process.exitCode = await runOnce(app, args.join(' '));
    else await runRepl(app);
  } catch (error) {
    console.error(`[taiwei] ${(error as Error).message}`); process.exitCode = 1;
  } finally { await app.close(); }
}

await main();
