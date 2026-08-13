import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { ensureTaiweiHome } from '../util/paths.js';

export class MemoryStore {
  async read(): Promise<string> {
    const { memory } = await ensureTaiweiHome();
    return readFile(memory, 'utf8');
  }

  async tail(maxChars = 2000): Promise<string> {
    const content = await this.read();
    return content.slice(-maxChars);
  }

  async append(text: string): Promise<void> {
    const { memory } = await ensureTaiweiHome();
    const prefix = (await this.read()).trim() ? '\n\n' : '';
    await appendFile(memory, `${prefix}${text.trim()}\n`, 'utf8');
  }

  async clear(): Promise<void> {
    const { memory } = await ensureTaiweiHome();
    await writeFile(memory, '', 'utf8');
  }
}
