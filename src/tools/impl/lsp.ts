import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolSpec, ToolContext } from '../registry.js';
import { resolveInWorkspace } from '../../util/paths.js';
import { LspManager, LspServerNotFoundError, type LspPosition, type LspSymbolResult } from '../../lsp/client.js';

const POSITION_PROPERTIES = {
  filePath: { type: 'string', description: 'Path to the source file (relative to the workspace or absolute).' },
  line: { type: 'number', description: '1-based line of the symbol. Provide with character, or use symbol instead.' },
  character: { type: 'number', description: '1-based column of the symbol (default 1). Used with line.' },
  symbol: { type: 'string', description: 'Symbol name to locate in the file. Used when line/character are omitted.' },
} as const;

async function resolvePath(context: ToolContext, filePath: string): Promise<string> {
  return context.workspaceOnly
    ? resolveInWorkspace(filePath, context.workspaceRoot ?? context.cwd)
    : resolve(context.cwd, filePath);
}

function lspDisabled(context: ToolContext): string | undefined {
  if (context.role === 'guest') return 'Semantic navigation is unavailable for guest sessions';
  if (context.lsp?.enabled === false) return 'LSP is disabled in config (lsp.enabled=false)';
  return undefined;
}

/** Resolve a 1-based position from explicit line/character or by locating `symbol` in the file. */
async function resolvePosition(
  manager: LspManager,
  workspace: string,
  filePath: string,
  text: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ position?: LspPosition; error?: string; candidates?: LspSymbolResult[] }> {
  const line = typeof args.line === 'number' ? args.line : undefined;
  const character = typeof args.character === 'number' ? args.character : 1;
  if (line !== undefined) {
    if (!Number.isFinite(line) || line < 1) return { error: 'line must be a positive 1-based number' };
    if (!Number.isFinite(character) || character < 1) return { error: 'character must be a positive 1-based number' };
    return { position: { line: Math.floor(line), character: Math.floor(character) } };
  }
  const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : '';
  if (!symbol) return { error: 'Provide either line (+optional character) or symbol to locate the target.' };
  const symbols = await manager.documentSymbols(workspace, filePath, text, signal);
  const matches = symbols.filter((item) => item.name === symbol);
  if (matches.length === 0) {
    const near = symbols.filter((item) => item.name.toLowerCase().includes(symbol.toLowerCase())).slice(0, 20);
    return { error: `Symbol "${symbol}" not found in ${filePath}.${near.length ? ` Did you mean: ${near.map((item) => `${item.name} (${item.kind}, line ${item.line})`).join(', ')}` : ''}`, candidates: near };
  }
  if (matches.length > 1) {
    return { error: `Symbol "${symbol}" matches ${matches.length} declarations. Pass line/character to disambiguate: ${matches.map((item) => `line ${item.line}`).join(', ')}.`, candidates: matches };
  }
  const only = matches[0]!;
  return { position: { line: only.line, character: only.character } };
}

async function guard<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try { return await fn(); }
  catch (error) {
    if (error instanceof LspServerNotFoundError) return { error: error.message };
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function createLspTools(manager: LspManager): ToolSpec[] {
  return [
    {
      name: 'go_to_definition',
      description: 'Find where a symbol is defined using the workspace language server (LSP). Provide filePath plus either line/character (1-based) or a symbol name. Returns definition locations with relative paths and 1-based positions. Admin coding sessions only.',
      parameters: { type: 'object', properties: { ...POSITION_PROPERTIES }, required: ['filePath'], additionalProperties: false },
      async execute(args, context) {
        const disabled = lspDisabled(context);
        if (disabled) return { error: disabled };
        return guard(async () => {
          const workspace = context.workspaceRoot ?? context.cwd;
          const filePath = String(args.filePath);
          const path = await resolvePath(context, filePath);
          const text = await readFile(path, 'utf8');
          const resolved = await resolvePosition(manager, workspace, path, text, args, context.signal);
          if (resolved.error) return { error: resolved.error, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) };
          const locations = await manager.definition(workspace, path, text, resolved.position!, context.signal);
          return { file: filePath, symbol: args.symbol ?? undefined, position: resolved.position, locations, count: locations.length };
        });
      },
    },
    {
      name: 'find_references',
      description: 'Find all references to a symbol across the workspace using the language server (LSP). Provide filePath plus either line/character (1-based) or a symbol name. Returns reference locations (including the declaration) with relative paths and 1-based positions. Admin coding sessions only.',
      parameters: { type: 'object', properties: { ...POSITION_PROPERTIES }, required: ['filePath'], additionalProperties: false },
      async execute(args, context) {
        const disabled = lspDisabled(context);
        if (disabled) return { error: disabled };
        return guard(async () => {
          const workspace = context.workspaceRoot ?? context.cwd;
          const filePath = String(args.filePath);
          const path = await resolvePath(context, filePath);
          const text = await readFile(path, 'utf8');
          const resolved = await resolvePosition(manager, workspace, path, text, args, context.signal);
          if (resolved.error) return { error: resolved.error, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) };
          const locations = await manager.references(workspace, path, text, resolved.position!, context.signal);
          return { file: filePath, symbol: args.symbol ?? undefined, position: resolved.position, references: locations, count: locations.length };
        });
      },
    },
    {
      name: 'document_symbols',
      description: 'List the symbols (classes, functions, methods, variables, etc.) declared in a file using the language server (LSP), with kinds and 1-based ranges. Useful to outline an unfamiliar file before editing. Admin coding sessions only.',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string', description: 'Path to the source file (relative to the workspace or absolute).' } },
        required: ['filePath'],
        additionalProperties: false,
      },
      async execute(args, context) {
        const disabled = lspDisabled(context);
        if (disabled) return { error: disabled };
        return guard(async () => {
          const workspace = context.workspaceRoot ?? context.cwd;
          const filePath = String(args.filePath);
          const path = await resolvePath(context, filePath);
          const text = await readFile(path, 'utf8');
          const symbols = await manager.documentSymbols(workspace, path, text, context.signal);
          return { file: filePath, symbols, count: symbols.length };
        });
      },
    },
  ];
}
