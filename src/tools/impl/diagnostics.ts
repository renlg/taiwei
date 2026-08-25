import type { ToolSpec } from '../registry.js';
import { collectDiagnostics } from '../../lsp/diagnostics.js';

export const diagnosticsTool: ToolSpec = {
  name: 'get_diagnostics',
  description: 'Run the workspace TypeScript compiler and return current compile diagnostics. Admin coding sessions only.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_args, context) {
    if (context.role === 'guest') return { error: 'get_diagnostics is unavailable for guest sessions' };
    if (context.lsp?.enabled === false) return { error: 'LSP diagnostics are disabled in config' };
    return collectDiagnostics(context.workspaceRoot ?? context.cwd, { maxDiagnostics: context.lsp?.maxDiagnostics ?? 5, signal: context.signal });
  },
};
