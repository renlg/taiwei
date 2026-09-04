import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolSpec } from '../registry.js';
import { resolveInWorkspace } from '../../util/paths.js';
import { EditAmbiguousError, EditNotFoundError, replaceOccurrence } from './text-edit.js';

async function resolveEditPath(filePath: string, context: { workspaceOnly?: boolean; workspaceRoot?: string; cwd: string }): Promise<string> {
  return context.workspaceOnly
    ? resolveInWorkspace(filePath, context.workspaceRoot ?? context.cwd)
    : resolve(context.cwd, filePath);
}

export const editTool: ToolSpec = {
  name: 'edit_file',
  description: `Perform exact string replacement in a file. Reads the file, finds oldString, replaces it with newString, and writes back. Use for surgical edits — changing 1-5 lines without rewriting the whole file.

Rules:
- oldString should match EXACTLY (including whitespace, indentation, newlines). Copy it from the file.
- If an exact match fails, taiwei retries a whitespace-tolerant match that ignores leading-indentation drift and trailing spaces, then re-indents newString to the file. Prefer exact text; the fallback only rescues minor indentation differences.
- oldString must be UNIQUE in the file. If it appears multiple times, include more surrounding context to make it unique, or set replaceAll:true.
- newString can be empty string "" to delete the matched text.
- oldString and newString must NOT be identical (that's a no-op).
- For several coordinated edits in one file, prefer apply_patch (atomic, all-or-nothing).`,
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

    const path = await resolveEditPath(filePath, context);
    const content = await readFile(path, 'utf8');

    let result;
    try {
      result = replaceOccurrence(content, oldString, newString, { replaceAll, fuzzy: true });
    } catch (error) {
      if (error instanceof EditNotFoundError) throw new Error(`edit_file: oldString not found in ${filePath}`);
      if (error instanceof EditAmbiguousError) {
        throw new Error(
          `edit_file: oldString appears ${error.count} times in ${filePath}. ` +
          `Include more context to make it unique, or set replaceAll:true to replace all occurrences.`,
        );
      }
      throw error;
    }

    await context.beforeFileWrite?.(path);
    await writeFile(path, result.updated, 'utf8');
    await context.afterFileWrite?.(path);

    return { ok: true, path: filePath, replacements: result.replacements, match: result.mode };
  },
};
