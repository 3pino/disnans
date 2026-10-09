import { describe, expect, it } from 'vitest';
import { findSlashCommand, parseSlashInput, registerSlashCommand, runSlashCommand, slashCommands } from './slashCommands.svelte';

describe('parseSlashInput', () => {
  it('splits commands and messages', () => {
    expect(parseSlashInput('hello')).toEqual({ kind: 'message', body: 'hello' });
    expect(parseSlashInput('/memo  hi there \n')).toEqual({ kind: 'command', name: 'memo', args: 'hi there' });
    expect(parseSlashInput('/dice')).toEqual({ kind: 'command', name: 'dice', args: '' });
    expect(parseSlashInput('/a\nb')).toEqual({ kind: 'command', name: 'a', args: 'b' });
  });

  it('// escapes a leading slash', () => {
    expect(parseSlashInput('//not a command')).toEqual({ kind: 'message', body: '/not a command' });
  });
});

describe('registry', () => {
  it('registers, overrides and unregisters', () => {
    const a = { name: 'echo-x', description: 'a', run: () => {} };
    const b = { name: 'echo-x', description: 'b', run: () => {} };
    const offA = registerSlashCommand(a);
    expect(findSlashCommand('echo-x')).toBe(a);
    const offB = registerSlashCommand(b);
    expect(findSlashCommand('echo-x')).toBe(b);
    expect(slashCommands.list.filter((c) => c.name === 'echo-x')).toHaveLength(1);
    // 上書きされたものを解除しても、いまのものは残る
    offA();
    expect(findSlashCommand('echo-x')).toBe(b);
    offB();
    expect(findSlashCommand('echo-x')).toBeUndefined();
  });

  it('rejects bad names', () => {
    expect(() => registerSlashCommand({ name: 'Bad Name', description: '', run: () => {} })).toThrow();
  });
});

describe('runSlashCommand', () => {
  it('passes args and threadId', async () => {
    let got: unknown = null;
    const off = registerSlashCommand({ name: 'got', description: '', run: (ctx) => void (got = ctx) });
    await runSlashCommand('got', 'x', 't1');
    expect(got).toEqual({ args: 'x', threadId: 't1' });
    off();
  });

  it('rejects unknown commands and failures', async () => {
    await expect(runSlashCommand('nope', '', null)).rejects.toThrow('/nope');
    const off = registerSlashCommand({
      name: 'fail',
      description: '',
      run: async () => {
        throw new Error('だめ');
      },
    });
    await expect(runSlashCommand('fail', '', null)).rejects.toThrow('/fail: だめ');
    off();
  });
});
