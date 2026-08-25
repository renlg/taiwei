import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolSpec } from '../registry.js';
import { resolveInWorkspace } from '../../util/paths.js';

export const editTool: ToolSpec = {
  name: 'edit_file',
  description: `Perform exact string replacement in a file. Reads the file, finds oldString (exact, case-sensitive match), replaces it with newString, and writes back. Use for surgical edits — changing 1-5 lines without rewriting the whole file.

Rules:
- oldString must match EXACTLY (including whitespace, indentation, newlines). Copy it from the file.
- oldString must be UNIQUE in the file. If it appears multiple times, include more surrounding context to make it unique, or set replaceAll:true.
- newString can be empty string "" to delete the matched text.
- oldString and newString must NOT be identical (that's a no-op).`,
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to the file to edit' },
      oldString: { type: 'string', description: 'Exact text to find (must be unique in the file)' },
      newString: { type: 'string', description: 'Replacement text (empty string to delete)' },
      replaceAll: { type: 'boolean', description: 'If true, replace ALL occurrences of oldString (default: false — requires unique match)' },
    },
    required: ['filePath', 'oldString', 'newString'],
    additionalProperties: false,
  },
  async execute(args, context) {
    const filePath = String(args.filePath);
    const oldString = String(args.oldString);
    const newString = String(args.newString);
    const replaceAll = Boolean(args.replaceAll);

    if (oldString === newString) {
      throw new Error('edit_file: oldString and newString are identical — this would be a no-op');
    }

    if (oldString === '') {
      throw new Error('edit_file: oldString cannot be empty');
    }

    const path = context.workspaceOnly
      ? await resolveInWorkspace(filePath, context.workspaceRoot ?? context.cwd)
      : resolve(context.cwd, filePath);

    const content = await readFile(path, 'utf8');
    const count = countOccurrences(content, oldString);

    if (count === 0) {
      throw new Error(`edit_file: oldString not found in ${filePath}`);
    }

    if (count > 1 && !replaceAll) {
      throw new Error(
        `edit_file: oldString appears ${count} times in ${filePath}. ` +
        `Include more context to make it unique, or set replaceAll:true to replace all occurrences.`
      );
    }

    const updated = replaceAll
      ? content.replaceAll(oldString, newString)
      : content.replace(oldString, newString);

    await context.beforeFileWrite?.(path);
    await writeFile(path, updated, 'utf8');
    await context.afterFileWrite?.(path);

    return {
      ok: true,
      path: filePath,
      replacements: replaceAll ? count : 1,
    };
  },
};

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = text.indexOf(search, pos);
    if (idx === -1) break;
    count++;
    pos = idx + search.length;
  }
  return count;
}
