import { noulAnswer, type JevAnswer, type JevQuestions } from './jev.js';

export const DELEGATE_CONTEXT =
  'A coding assistant is in the middle of a turn. `user_prompt` is what the user asked, `assistant_messages` is what the assistant has said so far in this turn, oldest first, and `recent_tool_calls` are the tools it ran most recently, oldest first. `tool_calls_so_far` and `edits_so_far` count its own work in this turn.';

export const DELEGATE_QUESTIONS: JevQuestions = {
  plan: {
    type: 'noul',
    instructions: 'The assistant has settled on a concrete plan for the rest of the work',
  },
  execution: {
    type: 'noul',
    instructions:
      'What remains is mostly carrying out that plan: editing several files or running several commands',
  },
  needs_user: {
    type: 'noul',
    instructions: 'What remains needs decisions or answers from the user before it can be done',
  },
  almost_done: {
    type: 'noul',
    instructions: 'The work is nearly finished: only a small step or the final report remains',
  },
  investigating: {
    type: 'noul',
    instructions:
      'The assistant is still investigating or debugging and does not yet know what to change',
  },
};

const MESSAGES_SHOWN = 5;
const MESSAGE_TAIL_CHARS = 700;
const CALLS_SHOWN = 12;
const PROMPT_CHARS = 1500;

export interface DelegateVerdict {
  plan: number;
  execution: number;
  needsUser: number;
  almostDone: number;
  investigating: number;
  /** A settled plan whose execution is what remains, with nothing blocking a hand-over. */
  delegable: boolean;
}

/** Reads the five answers; throws on a malformed response. */
export function delegateVerdict(answers: Record<string, JevAnswer>): DelegateVerdict {
  const plan = noulAnswer(answers, 'plan');
  const execution = noulAnswer(answers, 'execution');
  const needsUser = noulAnswer(answers, 'needs_user');
  const almostDone = noulAnswer(answers, 'almost_done');
  const investigating = noulAnswer(answers, 'investigating');
  return {
    plan,
    execution,
    needsUser,
    almostDone,
    investigating,
    delegable:
      plan >= 0.5 && execution >= 0.5 && needsUser < 0.5 && almostDone < 0.5 && investigating < 0.5,
  };
}

function lastPathParts(value: unknown): string {
  return String(value ?? '')
    .split('/')
    .slice(-2)
    .join('/');
}

/** One tool call as a short line: what ran, not its whole input. */
export function callLine(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash') {
    const what = String(input['description'] || input['command'] || '');
    return `Bash: ${what.replace(/\s+/g, ' ').slice(0, 90)}`;
  }
  if (tool === 'Edit' || tool === 'Write' || tool === 'Read' || tool === 'NotebookEdit') {
    return `${tool}: ${lastPathParts(input['file_path'] ?? input['notebook_path'])}`;
  }
  if (tool === 'Grep' || tool === 'Glob') return `${tool}: ${String(input['pattern'] ?? '').slice(0, 60)}`;
  return tool.replace(/^mcp__/, 'mcp:').slice(0, 60);
}

export function isEditTool(tool: string): boolean {
  return tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit';
}

/**
 * The counts of own tool calls at which a turn is checked: `first`, then at
 * growing distances (12, 25, 40, 60, then every 2 × first for `first` = 12).
 */
export function isCheckpoint(count: number, first: number): boolean {
  if (first <= 0 || count < first) return false;
  const early = [1, 25 / 12, 40 / 12, 5].map((factor) => Math.round(first * factor));
  if (early.includes(count)) return true;
  const last = early[early.length - 1]!;
  return count > last && (count - last) % (2 * first) === 0;
}

export interface TurnProgress {
  prompt: string;
  /** What the assistant said so far in this turn, oldest first. */
  assistantMessages: readonly string[];
  /** `callLine` of every own call of the turn, oldest first. */
  calls: readonly string[];
  edits: number;
}

export function delegateState(progress: TurnProgress): Record<string, unknown> {
  return {
    context: DELEGATE_CONTEXT,
    user_prompt: progress.prompt.slice(0, PROMPT_CHARS),
    assistant_messages: progress.assistantMessages
      .filter((text) => text.trim().length > 0)
      .slice(-MESSAGES_SHOWN)
      .map((text) => text.slice(-MESSAGE_TAIL_CHARS)),
    recent_tool_calls: progress.calls.slice(-CALLS_SHOWN),
    tool_calls_so_far: progress.calls.length,
    edits_so_far: progress.edits,
  };
}

/** What the model reads after the tool result at a checkpoint that calls for a hand-over. */
export function delegateNudge(progress: TurnProgress, model: string): string {
  return [
    `[jev-delegate] You have run ${progress.calls.length} tool calls yourself in this turn (${progress.edits} edits), and what remains looks like carrying out a plan you have already settled.`,
    `Hand the remaining work to a subagent now: write a self-contained brief (goal, the files and decisions so far, constraints, how to verify, what to report back) and call the Agent tool with subagent_type "jev-delegate:worker" (or another fitting type) and model "${model}". Split independent parts across several agents in one message.`,
    'Keep for yourself only what needs the user or this conversation. When the agent reports back, check its work before you report. If you decide not to delegate, say why in one short sentence and continue.',
  ].join(' ');
}
