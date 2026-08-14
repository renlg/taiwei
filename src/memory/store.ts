import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ensureTaiweiHome, guestMemory } from '../util/paths.js';

export class MemoryStore {
  constructor(private readonly memoryPath?: string) {}

  static forGuest(guestId: string): MemoryStore { return new MemoryStore(guestMemory(guestId)); }

  private async path(): Promise<string> {
    if (!this.memoryPath) return (await ensureTaiweiHome()).memory;
    await mkdir(dirname(this.memoryPath), { recursive: true });
    return this.memoryPath;
  }

  async read(): Promise<string> {
    try { return await readFile(await this.path(), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  async tail(maxChars = 2000): Promise<string> {
    const content = await this.read();
    return content.slice(-maxChars);
  }

  async append(text: string, maxChars?: number): Promise<void> {
    const memory = await this.path();
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

  async replace(content: string): Promise<void> {
    await writeFile(await this.path(), content, 'utf8');
  }

  async clear(): Promise<void> {
    await this.replace('');
  }
}
