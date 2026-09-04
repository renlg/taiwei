// Deterministic text-edit primitives shared by edit_file and apply_patch.
//
// Matching proceeds from strict to tolerant and never calls a model:
//   1. exact       — byte-for-byte substring match
//   2. fuzzy       — whole-line match that tolerates leading-indentation drift
//                    and trailing whitespace, re-indenting the replacement to
//                    the file's actual indentation.
// Every strategy reports how many spans it found so callers can enforce
// uniqueness (or replaceAll) and produce actionable errors.

export type MatchMode = 'exact' | 'fuzzy';

export interface Span {
  start: number;
  end: number;
}

export interface FindResult {
  spans: Span[];
  mode: MatchMode;
}

export interface ReplaceOptions {
  replaceAll?: boolean;
  fuzzy?: boolean;
}

export interface ReplaceResult {
  updated: string;
  replacements: number;
  mode: MatchMode;
}

export class EditNotFoundError extends Error {
  constructor(readonly oldString: string) {
    super('oldString not found');
    this.name = 'EditNotFoundError';
  }
}

export class EditAmbiguousError extends Error {
  constructor(readonly count: number, readonly mode: MatchMode) {
    super(`oldString appears ${count} times`);
    this.name = 'EditAmbiguousError';
  }
}

function allExactSpans(content: string, needle: string): Span[] {
  const spans: Span[] = [];
  let pos = 0;
  for (;;) {
    const index = content.indexOf(needle, pos);
    if (index === -1) break;
    spans.push({ start: index, end: index + needle.length });
    pos = index + needle.length;
  }
  return spans;
}

function lineStartOffsets(content: string): number[] {
  const offsets = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') offsets.push(index + 1);
  }
  return offsets;
}

function leadingWhitespace(line: string): string {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0] : '';
}

/** Whole-line spans whose trimmed text equals the needle's trimmed lines. */
function fuzzyLineSpans(content: string, needle: string): Span[] {
  const contentLines = content.split('\n');
  const needleLines = needle.split('\n');
  const count = needleLines.length;
  if (count === 0) return [];
  const starts = lineStartOffsets(content);
  const spans: Span[] = [];
  for (let index = 0; index + count <= contentLines.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < count; offset += 1) {
      if ((contentLines[index + offset] ?? '').trim() !== (needleLines[offset] ?? '').trim()) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const lastLine = index + count - 1;
    const start = starts[index]!;
    const end = starts[lastLine]! + (contentLines[lastLine] ?? '').length;
    spans.push({ start, end });
    // Skip past this match so overlapping candidates are not double counted.
    index = lastLine;
  }
  return spans;
}

/**
 * Detect the indent step of a multi-line block: the minimum leading-whitespace
 * width among lines after the first (relative to the first line).
 * Returns 0 when all lines share the first line's indent or there is only one line.
 */
function indentStep(text: string): number {
  const lines = text.split('\n');
  const firstIndent = leadingWhitespace(lines[0] ?? '').length;
  let minStep = Infinity;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;
    const indent = leadingWhitespace(line).length;
    const relative = Math.abs(indent - firstIndent);
    if (relative > 0 && relative < minStep) minStep = relative;
  }
  return minStep === Infinity ? 0 : minStep;
}

/**
 * Re-indent `newText` so its first line sits at `targetIndent` spaces and its
 * internal relative indentation is scaled from `needleStep` to `contentStep`.
 * When both steps are equal (or zero) the relative offsets are preserved as-is.
 */
function reindent(text: string, targetIndent: number, needleStep: number, contentStep: number): string {
  const lines = text.split('\n');
  const firstIndent = leadingWhitespace(lines[0] ?? '').length;
  const ratio = needleStep > 0 && contentStep > 0 ? contentStep / needleStep : 1;
  return lines
    .map((line) => {
      if (line.trim() === '') return line;
      const lineIndent = leadingWhitespace(line).length;
      const relative = lineIndent - firstIndent;
      const scaledRelative = Math.round(relative * ratio);
      const effective = Math.max(0, targetIndent + scaledRelative);
      return ' '.repeat(effective) + line.slice(lineIndent);
    })
    .join('\n');
}

export function findSpans(content: string, needle: string, options: { fuzzy?: boolean } = {}): FindResult {
  const exact = allExactSpans(content, needle);
  if (exact.length) return { spans: exact, mode: 'exact' };
  if (!options.fuzzy) return { spans: [], mode: 'exact' };
  return { spans: fuzzyLineSpans(content, needle), mode: 'fuzzy' };
}

/**
 * Replace `oldString` with `newString` in `content`.
 * Throws EditNotFoundError when nothing matches and EditAmbiguousError when a
 * single replacement was requested but several spans matched.
 */
export function replaceOccurrence(
  content: string,
  oldString: string,
  newString: string,
  options: ReplaceOptions = {},
): ReplaceResult {
  const { spans, mode } = findSpans(content, oldString, { fuzzy: options.fuzzy });
  if (spans.length === 0) throw new EditNotFoundError(oldString);
  if (spans.length > 1 && !options.replaceAll) throw new EditAmbiguousError(spans.length, mode);

  const contentLines = mode === 'fuzzy' ? content.split('\n') : undefined;
  let updated = content;
  // Apply from the last span backwards so earlier offsets stay valid.
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index]!;
    let replacement = newString;
    if (mode === 'fuzzy' && contentLines) {
      const startLine = lineIndexForOffset(contentLines, span.start);
      const contentIndent = leadingWhitespace(contentLines[startLine] ?? '').length;
      const needleStep = indentStep(oldString);
      const matchLineCount = oldString.split('\n').length;
      const contentStep = indentStep(contentLines.slice(startLine, startLine + matchLineCount).join('\n'));
      replacement = reindent(newString, contentIndent, needleStep, contentStep);
    }
    updated = updated.slice(0, span.start) + replacement + updated.slice(span.end);
  }
  return { updated, replacements: spans.length, mode };
}

function lineIndexForOffset(lines: string[], offset: number): number {
  let cursor = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const lineLength = (lines[index] ?? '').length;
    if (offset <= cursor + lineLength) return index;
    cursor += lineLength + 1; // +1 for the '\n'
  }
  return lines.length - 1;
}
