import {
  INPUT_CHARS,
  abridge,
  estimateTokens,
  goalFromMessages,
  historyEntries,
} from './state.js';
import type {
  FittedWindow,
  HistoryEntry,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  UserNote,
  WindowState,
} from './types.js';

export const WINDOW_CONTEXT =
  'A coding assistant conversation is being compacted to free context. It is too long to show at once, so `history` is one part of it, oldest first: the messages `window.from` to `window.to` of `window.of`, with a few neighbouring messages around them for context. `user_notes` is what the user said elsewhere in the conversation about things that must be kept or will be needed again. Tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call of this part, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file.';

export const NOTES_CONTEXT =
  '`messages` are the things a user said to a coding assistant over a long conversation, oldest first, with long ones abridged. The conversation is about to be compacted: old tool outputs will be deleted unless something says they are still needed. Each question asks whether one message tells the assistant to keep, remember or not lose something (an output, a value, a file content, a result), or says that something will be needed again later.';

const WINDOW_TEXT_HEAD = 1200;
const WINDOW_TEXT_TAIL = 400;
const NOTE_TEXT_HEAD = 400;
const NOTE_TEXT_TAIL = 200;

/** Share of `maxStateTokens` one window's own history may take, whatever `windowTokens` says. */
const WINDOW_SHARE = 0.4;
/** Context shown on each side of a window, as a share of the window. */
const MARGIN_SHARE = 0.25;
/** Share of `maxStateTokens` the user's notes may take in a window. */
const NOTES_SHARE = 0.15;

function entryTokens(entry: unknown): number {
  return estimateTokens(JSON.stringify(entry)) + 1;
}

/** The user's own messages (not tool results), abridged, as note candidates. */
export function noteCandidates(messages: readonly Message[]): UserNote[] {
  const candidates: UserNote[] = [];
  messages.forEach((message, i) => {
    if (
      message.role !== 'user' ||
      message.text.trim().length === 0 ||
      (message.toolResults ?? []).length > 0
    ) {
      return;
    }
    candidates.push({ i, text: abridge(message.text, NOTE_TEXT_HEAD, NOTE_TEXT_TAIL) });
  });
  return candidates;
}

export function noteQuestion(note: UserNote): JevQuestions {
  return {
    [`note_m${note.i}`]: {
      type: 'noul',
      instructions: `Message ${note.i} tells the assistant to keep, remember or not lose something, or says that something will be needed again later`,
    },
  };
}

/** Groups the note candidates so that each group, as a state with its questions, fits one request. */
export function batchNotes(
  candidates: readonly UserNote[],
  options: Pick<ResolvedCompactOptions, 'maxStateTokens' | 'maxRequestTokens'>,
): UserNote[][] {
  const base = estimateTokens(JSON.stringify({ context: NOTES_CONTEXT, messages: [] }));
  const batches: UserNote[][] = [];
  let current: UserNote[] = [];
  let state = base;
  let request = base;
  for (const candidate of candidates) {
    const own = entryTokens(candidate);
    const question = estimateTokens(JSON.stringify(noteQuestion(candidate)));
    if (
      current.length > 0 &&
      (state + own > options.maxStateTokens || request + own + question > options.maxRequestTokens)
    ) {
      batches.push(current);
      current = [];
      state = base;
      request = base;
    }
    current.push(candidate);
    state += own;
    request += own + question;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** The newest notes that fit `budget`, oldest first. */
function pickNotes(notes: readonly UserNote[], budget: number): UserNote[] {
  const picked: UserNote[] = [];
  let spent = 0;
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    const tokens = entryTokens(notes[index]!);
    if (spent + tokens > budget) break;
    spent += tokens;
    picked.unshift(notes[index]!);
  }
  return picked;
}

/**
 * Splits a conversation that does not fit one state into windows of about
 * `windowTokens` of history each. Every window is judged on its own state,
 * which keeps the texts around its calls readable instead of collapsing them;
 * `notes` carries what the user said elsewhere about things to keep. Windows
 * without a candidate call are not returned.
 */
export function windowStates(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  notes: readonly UserNote[],
  options: Pick<
    ResolvedCompactOptions,
    'maxStateTokens' | 'preserveRecentMessages' | 'goal' | 'windowTokens'
  >,
): FittedWindow[] {
  const total = messages.length;
  const tailStart = Math.max(1, total - options.preserveRecentMessages);
  const goal = options.goal || goalFromMessages(messages);
  const windowBudget = Math.max(
    1,
    Math.min(options.windowTokens, Math.floor(options.maxStateTokens * WINDOW_SHARE)),
  );
  const marginBudget = Math.floor(windowBudget * MARGIN_SHARE);

  const rendered = new Map<number, HistoryEntry[]>();
  const bodyAt = (inputChars: number): HistoryEntry[] => {
    let body = rendered.get(inputChars);
    if (!body) {
      body = historyEntries(messages, calls, inputChars)
        .filter((entry) => entry.i < tailStart)
        .map((entry) => ({
          ...entry,
          text: abridge(entry.text, WINDOW_TEXT_HEAD, WINDOW_TEXT_TAIL),
        }));
      rendered.set(inputChars, body);
    }
    return body;
  };

  const body = bodyAt(INPUT_CHARS[0]);
  const tokens = body.map(entryTokens);
  const candidatesAt = new Map<number, ToolCall[]>();
  for (const call of calls) {
    if (call.pinned) continue;
    const list = candidatesAt.get(call.callIndex) ?? [];
    list.push(call);
    candidatesAt.set(call.callIndex, list);
  }

  const groups: { start: number; end: number }[] = [];
  let start = 0;
  let spent = 0;
  body.forEach((_, position) => {
    const cost = tokens[position]!;
    if (position > start && spent + cost > windowBudget) {
      groups.push({ start, end: position - 1 });
      start = position;
      spent = 0;
    }
    spent += cost;
  });
  if (body.length > 0) groups.push({ start, end: body.length - 1 });

  const windows: FittedWindow[] = [];
  for (const group of groups) {
    const asked = body
      .slice(group.start, group.end + 1)
      .flatMap((entry) => candidatesAt.get(entry.i) ?? []);
    if (asked.length === 0) continue;

    let from = group.start;
    for (let margin = 0; from > 0 && margin + tokens[from - 1]! <= marginBudget; from -= 1) {
      margin += tokens[from - 1]!;
    }
    let to = group.end;
    for (
      let margin = 0;
      to < body.length - 1 && margin + tokens[to + 1]! <= marginBudget;
      to += 1
    ) {
      margin += tokens[to + 1]!;
    }
    const firstShown = body[from]!.i;
    const lastShown = body[to]!.i;
    const outside = notes.filter((note) => note.i < firstShown || note.i > lastShown);

    let fitted: FittedWindow | undefined;
    let smallest = 0;
    for (const notesShare of [NOTES_SHARE, NOTES_SHARE / 2, 0]) {
      for (const inputChars of INPUT_CHARS) {
        const state: WindowState = {
          context: WINDOW_CONTEXT,
          goal,
          window: { from: body[group.start]!.i, to: body[group.end]!.i, of: total },
          user_notes: pickNotes(outside, Math.floor(options.maxStateTokens * notesShare)),
          history: bodyAt(inputChars).slice(from, to + 1),
        };
        smallest = estimateTokens(JSON.stringify(state));
        if (smallest <= options.maxStateTokens) {
          fitted = { state, tokens: smallest, calls: asked };
          break;
        }
      }
      if (fitted) break;
    }
    if (!fitted) {
      throw new Error(
        `window ${body[group.start]!.i}-${body[group.end]!.i} too large for Jev (~${smallest} tokens, limit ${options.maxStateTokens})`,
      );
    }
    windows.push(fitted);
  }
  return windows;
}
