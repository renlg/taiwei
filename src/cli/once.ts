import type { TaiweiApp } from '../app.js';

export async function runOnce(app: TaiweiApp, prompt: string): Promise<number> {
  try {
    await app.run(prompt, { stream: true, retainConversation: false });
    process.stdout.write('\n');
    return 0;
  } catch (error) {
    if ((error as Error).name === 'AbortError') console.error('\n[taiwei] Turn cancelled.');
    else console.error(`\n[taiwei] ${(error as Error).message}`);
    return 1;
  }
}
