export const TUI_COMMANDS = ['/help', '/exit', '/stop', '/clear', '/resume', '/export', '/agent', '/model'];

export type ParsedInput = { kind: 'empty' } | { kind: 'message'; text: string } | { kind: 'command'; command: string; args: string[] };

export function parseInput(value: string): ParsedInput {
  const text = value.trim();
  if (!text) return { kind: 'empty' };
  if (!text.startsWith('/')) return { kind: 'message', text };
  const tokens: string[] = []; let current = ''; let quote = ''; let escaped = false;
  for (const character of text) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (quote) { if (character === quote) quote = ''; else current += character; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (/\s/.test(character)) { if (current) { tokens.push(current); current = ''; } }
    else current += character;
  }
  if (quote) throw new Error('Unclosed quote');
  if (current) tokens.push(current);
  return { kind: 'command', command: tokens[0]!.toLowerCase(), args: tokens.slice(1) };
}

export function completeCommand(draft: string): string {
  if (!draft.startsWith('/') || draft.includes(' ')) return draft;
  const matches = TUI_COMMANDS.filter((command) => command.startsWith(draft));
  return matches.length === 1 ? `${matches[0]} ` : draft;
}

export function visibleWidth(value: string): number { return Array.from(value.replace(/\x1b\[[0-9;]*m/g, '')).length; }

export function renderLine(value: string, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const characters = Array.from(value.replace(/[\r\n]/g, ' '));
  if (characters.length <= safeWidth) return characters.join('').padEnd(safeWidth);
  if (safeWidth === 1) return '…';
  return `${characters.slice(0, safeWidth - 1).join('')}…`;
}
