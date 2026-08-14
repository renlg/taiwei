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

  async append(text: string, maxChars?: number): Promise<void> {
    const { memory } = await ensureTaiweiHome();
    const content = await this.read();
    const prefix = content.trim() ? '\n\n' : '';
    const addition = `${prefix}${text.trim()}\n`;
    if (maxChars && content.length + addition.length > maxChars) {
      // Flush appends are capped by retaining the newest approximate 60 KiB.
      await writeFile(memory, `${content}${addition}`.slice(-maxChars), 'utf8');
      return;
    }
    await appendFile(memory, addition, 'utf8');
  }

  async clear(): Promise<void> {
    const { memory } = await ensureTaiweiHome();
    await writeFile(memory, '', 'utf8');
  }
}
