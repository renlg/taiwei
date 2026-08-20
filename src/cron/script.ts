import { spawn } from 'node:child_process';
import type { CronExecutionResult } from './scheduler.js';

export async function executeWatchdogScript(script: string, cwd: string, signal: AbortSignal): Promise<CronExecutionResult> {
  if (!script.trim()) throw new Error('script must be a non-empty string');
  return new Promise((resolve, reject) => {
    const child = spawn(script, { cwd, shell: true, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on('data', (value: Buffer) => stdout.push(value));
    child.stderr.on('data', (value: Buffer) => stderr.push(value));
    child.once('error', reject);
    child.once('close', (code, childSignal) => {
      const output = Buffer.concat(stdout).toString('utf8').trim();
      const errorText = Buffer.concat(stderr).toString('utf8').trim();
      if (signal.aborted) { const error = new DOMException('Script timed out', 'AbortError'); Object.assign(error, { exitCode: code ?? undefined, output }); reject(error); return; }
      if (code !== 0) { const error = new Error(errorText || `Script exited with code ${code}${childSignal ? ` (${childSignal})` : ''}`); Object.assign(error, { exitCode: code ?? undefined, output }); reject(error); return; }
      resolve({ output, exitCode: code ?? 0, silent: !output });
    });
  });
}
