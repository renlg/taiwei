import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolSpec } from '../registry.js';
import { resolveInWorkspace } from '../../util/paths.js';
import { EditAmbiguousError, EditNotFoundError, replaceOccurrence } from './text-edit.js';

interface PatchEdit {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

function asEdit(value: unknown, index: number): PatchEdit {
  if (!value || typeof value !== 'object') throw new Error(`apply_patch: edits[${index}] must be an object`);
  const raw = value as Record<string, unknown>;
  if (typeof raw.oldString !== 'string' || raw.oldString === '') throw new Error(`apply_patch: edits[${index}].oldString must be a non-empty string`);
  if (typeof raw.newString !== 'string') throw new Error(`apply_patch: edits[${index}].newString must be a string`);
  if (raw.oldString === raw.newString) throw new Error(`apply_patch: edits[${index}] is a no-op (oldString === newString)`);
  return { oldString: raw.oldString, newString: raw.newString, replaceAll: Boolean(raw.replaceAll) };
}

export const applyPatchTool: ToolSpec = {
  name: 'apply_patch',
  description: `Apply several search/replace edits to ONE file atomically. Every edit is validated against the progressively-updated content and the file is written only if ALL edits succeed — otherwise nothing changes and you get the index of the edit that failed.

Use this instead of repeated edit_file calls when a change touches multiple places in the same file (refactors, signature updates, coordinated edits). Edits are applied in order.

Rules:
- Each edit needs oldString (exact text copied from the file) and newString.
- oldString must be unique unless replaceAll:true. A whitespace-tolerant fallback rescues minor indentation drift, same as edit_file.
- Edits see the result of previous edits, so later oldString values must match the already-patched content.`,
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to the file to patch' },
      edits: {
        type: 'array',
        description: 'Ordered list of edits applied atomically.',
        items: {
          type: 'object',
          properties: {
            oldString: { type: 'string', description: 'Exact text to find (must be unique unless replaceAll)' },
            newString: { type: 'string', description: 'Replacement text (empty string to delete)' },
            replaceAll: { type: 'boolean', description: 'Replace all occurrences of oldString (default false)' },
          },
          required: ['oldString', 'newString'],
          additionalProperties: false,
        },
      },
    },
    required: ['filePath', 'edits'],
    additionalProperties: false,
  },
  async execute(args, context) {
    const filePath = String(args.filePath);
    if (!Array.isArray(args.edits) || args.edits.length === 0) throw new Error('apply_patch: edits must be a non-empty array');
    const edits = args.edits.map(asEdit);

    const path = context.workspaceOnly
      ? await resolveInWorkspace(filePath, context.workspaceRoot ?? context.cwd)
      : resolve(context.cwd, filePath);

    const original = await readFile(path, 'utf8');
    let updated = original;
    const applied: Array<{ index: number; replacements: number; match: string }> = [];
    for (let index = 0; index < edits.length; index += 1) {
      const edit = edits[index]!;
      try {
        const result = replaceOccurrence(updated, edit.oldString, edit.newString, { replaceAll: edit.replaceAll, fuzzy: true });
        updated = result.updated;
        applied.push({ index, replacements: result.replacements, match: result.mode });
      } catch (error) {
        // All-or-nothing: report the failing edit and leave the file untouched.
        if (error instanceof EditNotFoundError) {
          throw new Error(`apply_patch: edits[${index}] oldString not found in ${filePath}. The file was NOT modified. Read the current content and copy oldString exactly (earlier edits in this call may have already changed it).`);
        }
        if (error instanceof EditAmbiguousError) {
          throw new Error(`apply_patch: edits[${index}] oldString appears ${error.count} times in ${filePath}. The file was NOT modified. Add more surrounding context or set replaceAll:true.`);
        }
        throw error;
      }
    }

    await context.beforeFileWrite?.(path);
    await writeFile(path, updated, 'utf8');
    await context.afterFileWrite?.(path);

    return { ok: true, path: filePath, edits: applied.length, applied, changed: updated !== original };
  },
};
