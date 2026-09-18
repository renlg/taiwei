export const CLARIFICATION_START = '<<<TAIWEI_CLARIFICATION>>>';
export const CLARIFICATION_END = '<<<END_TAIWEI_CLARIFICATION>>>';

export interface ClarificationQuestion {
  question: string;
  options: string[];
  allowCustom: boolean;
}

export interface ClarificationPayload {
  questions: ClarificationQuestion[];
}

export interface ParsedClarification {
  payload: ClarificationPayload;
  cleanedText: string;
}

function validQuestion(value: unknown): value is ClarificationQuestion {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.question === 'string' && Boolean(item.question.trim())
    && Array.isArray(item.options) && item.options.length >= 2 && item.options.length <= 5
    && item.options.every((option) => typeof option === 'string' && Boolean(option.trim()))
    && typeof item.allowCustom === 'boolean';
}

const CLARIFICATION_REPAIR_CANDIDATES = ['}', ']}', '}]', '"]}', '"}]'] as const;

function parsePayload(content: string): ClarificationPayload | undefined {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (!Array.isArray(value.questions) || value.questions.length === 0 || !value.questions.every(validQuestion)) return undefined;
    return { questions: value.questions.map((item) => ({
      question: item.question.trim(),
      options: item.options.map((option) => option.trim()),
      allowCustom: item.allowCustom,
    })) };
  } catch {
    return undefined;
  }
}

/** Detects and removes one valid clarification marker block from a completed response. */
export function parseClarification(text: string): ParsedClarification | undefined {
  const start = text.indexOf(CLARIFICATION_START);
  if (start < 0) return undefined;
  const contentStart = start + CLARIFICATION_START.length;
  const end = text.indexOf(CLARIFICATION_END, contentStart);
  if (end < 0) return undefined;
  const raw = text.slice(contentStart, end).trim();
  let payload = parsePayload(raw);
  if (!payload) {
    const repairBases = raw.endsWith('"') ? [raw, raw.slice(0, -1)] : [raw];
    for (const base of repairBases) {
      for (const candidate of CLARIFICATION_REPAIR_CANDIDATES) {
        payload = parsePayload(base + candidate);
        if (payload) break;
      }
      if (payload) break;
    }
  }
  if (!payload) return undefined;
  const cleanedText = `${text.slice(0, start)}${text.slice(end + CLARIFICATION_END.length)}`.trim();
  return { payload, cleanedText };
}

/** Holds only a possible leading marker; normal prose is released immediately. */
export class ClarificationStreamGate {
  private buffered = '';
  private passthrough = false;

  push(chunk: string): string {
    if (this.passthrough) return chunk;
    this.buffered += chunk;
    const candidate = this.buffered.trimStart();
    if (CLARIFICATION_START.startsWith(candidate) || candidate.startsWith(CLARIFICATION_START)) return '';
    this.passthrough = true;
    const released = this.buffered;
    this.buffered = '';
    return released;
  }

  finish(isClarification: boolean): string {
    if (this.passthrough || isClarification) return '';
    const released = this.buffered;
    this.buffered = '';
    return released;
  }
}
