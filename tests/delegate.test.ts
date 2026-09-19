import { describe, expect, it } from 'vitest';
import {
  DelegateTracker,
  assistantMessagesOfTurn,
  delegateCheck,
  resolveHookConfig,
  type HookFetch,
} from '../hooks/fast-jev.js';
import {
  DELEGATE_QUESTIONS,
  callLine,
  delegateNudge,
  delegateState,
  delegateVerdict,
  isCheckpoint,
} from '../src/index.js';

const noul = (values: Record<string, number>) =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { type: 'noul' as const, noul: value }]));

const handOver = { plan: 0.8, execution: 0.7, needs_user: 0.2, almost_done: 0.1, investigating: 0.3 };

describe('delegate verdict', () => {
  it('calls for a hand-over only with a settled plan, execution ahead and nothing blocking', () => {
    expect(delegateVerdict(noul(handOver)).delegable).toBe(true);
    for (const blocker of [
      { plan: 0.4 },
      { execution: 0.4 },
      { needs_user: 0.6 },
      { almost_done: 0.6 },
      { investigating: 0.6 },
    ]) {
      expect(delegateVerdict(noul({ ...handOver, ...blocker })).delegable).toBe(false);
    }
    expect(() => delegateVerdict(noul({ plan: 0.9 }))).toThrow(/Invalid Jev answer/);
  });

  it('asks the five questions', () => {
    expect(Object.keys(DELEGATE_QUESTIONS).sort()).toEqual(
      ['almost_done', 'execution', 'investigating', 'needs_user', 'plan'],
    );
  });
});

describe('checkpoints', () => {
  it('starts at the first count and spreads out', () => {
    const hits = Array.from({ length: 120 }, (_, n) => n).filter((n) => isCheckpoint(n, 12));
    expect(hits).toEqual([12, 25, 40, 60, 84, 108]);
    expect(isCheckpoint(12, 0)).toBe(false);
    expect(Array.from({ length: 30 }, (_, n) => n).filter((n) => isCheckpoint(n, 5))).toEqual([5, 10, 17, 25]);
  });
});

describe('call lines and state', () => {
  it('shows what ran, not the whole input', () => {
    expect(callLine('Bash', { command: 'npm   test\n--run', description: '' })).toBe('Bash: npm test --run');
    expect(callLine('Bash', { command: 'x', description: 'Run the tests' })).toBe('Bash: Run the tests');
    expect(callLine('Edit', { file_path: '/repo/src/state.ts', old_string: 'a'.repeat(900) })).toBe('Edit: src/state.ts');
    expect(callLine('Grep', { pattern: 'fitState' })).toBe('Grep: fitState');
    expect(callLine('mcp__slack__send', {})).toBe('mcp:slack__send');
  });

  it('keeps the newest messages and calls and counts the whole turn', () => {
    const state = delegateState({
      prompt: 'p'.repeat(3000),
      assistantMessages: ['', ...Array.from({ length: 7 }, (_, n) => `message ${n} ${'x'.repeat(1000)}`)],
      calls: Array.from({ length: 20 }, (_, n) => `Read: file${n}.ts`),
      edits: 3,
    });
    expect((state['user_prompt'] as string).length).toBe(1500);
    expect(state['assistant_messages']).toHaveLength(5);
    expect((state['assistant_messages'] as string[]).every((text) => text.length <= 700)).toBe(true);
    expect(state['recent_tool_calls']).toHaveLength(12);
    expect((state['recent_tool_calls'] as string[])[11]).toBe('Read: file19.ts');
    expect(state['tool_calls_so_far']).toBe(20);
    expect(state['edits_so_far']).toBe(3);
  });

  it('names the counts and the model in the nudge', () => {
    const text = delegateNudge({ prompt: '', assistantMessages: [], calls: ['a', 'b'], edits: 1 }, 'opus');
    expect(text).toContain('2 tool calls');
    expect(text).toContain('model "opus"');
  });
});

describe('tracker', () => {
  it('counts the main loop, resets per turn and stops once the turn delegated', () => {
    const tracker = new DelegateTracker(3);
    tracker.turnStart('do it');
    expect(tracker.record('Read', { file_path: 'a.ts' })).toBe(false);
    expect(tracker.record('Edit', { file_path: 'a.ts' })).toBe(false);
    expect(tracker.record('Bash', { command: 'npm test' })).toBe(true);
    expect(tracker.progress(['plan'])).toEqual({
      prompt: 'do it',
      assistantMessages: ['plan'],
      calls: ['Read: a.ts', 'Edit: a.ts', 'Bash: npm test'],
      edits: 1,
    });

    tracker.turnStart('next');
    expect(tracker.record('Agent', { prompt: 'brief' })).toBe(false);
    tracker.record('Read', {});
    tracker.record('Read', {});
    expect(tracker.record('Read', {})).toBe(false);
    expect(tracker.progress([]).calls).toHaveLength(3);
  });

  it('takes the assistant messages after the last typed user message', () => {
    const messages = [
      { role: 'user' as const, text: 'first', toolUses: [] },
      { role: 'assistant' as const, text: 'old', toolUses: [] },
      { role: 'user' as const, text: 'second', toolUses: [] },
      { role: 'assistant' as const, text: 'plan', toolUses: [] },
      { role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: 't', text: 'out', isError: false }] },
      { role: 'assistant' as const, text: '', toolUses: [] },
      { role: 'assistant' as const, text: 'next step', toolUses: [] },
    ];
    expect(assistantMessagesOfTurn(messages)).toEqual(['plan', 'next step']);
  });
});

describe('delegate check', () => {
  const progress = { prompt: 'refactor', assistantMessages: ['plan is set'], calls: ['Read: a.ts'], edits: 0 };
  const fetchWith = (values: Record<string, number>, bodies: string[] = []): HookFetch =>
    async (_url, init) => {
      bodies.push(init?.body ?? '');
      return { status: 200, ok: true, text: JSON.stringify({ answers: noul(values) }) };
    };

  it('sends the turn so far and returns the nudge when Jev calls for a hand-over', async () => {
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ delegateAfterCalls: 12, delegateModel: 'sonnet' }), apiKey: 'k' };
    const { verdict, nudge } = await delegateCheck(progress, config, fetchWith(handOver, bodies));
    expect(verdict.delegable).toBe(true);
    expect(nudge).toContain('model "sonnet"');
    const body = JSON.parse(bodies[0]!) as { state: Record<string, unknown>; questions: Record<string, unknown> };
    expect(body.state['user_prompt']).toBe('refactor');
    expect(Object.keys(body.questions)).toHaveLength(5);
  });

  it('returns no nudge otherwise and refuses to run without a key', async () => {
    const config = { ...resolveHookConfig({ delegateAfterCalls: 12 }), apiKey: 'k' };
    const { nudge } = await delegateCheck(progress, config, fetchWith({ ...handOver, almost_done: 0.9 }));
    expect(nudge).toBeUndefined();
    await expect(delegateCheck(progress, resolveHookConfig({}), fetchWith(handOver))).rejects.toThrow(/TYPESAFE_API_KEY/);
  });

  it('is off by default', () => {
    expect(resolveHookConfig({}).delegateAfterCalls).toBe(0);
    expect(resolveHookConfig({}).delegateModel).toBe('opus');
  });
});
