import { describe, expect, it } from 'vitest';
import { composerActions, registerComposerAction } from './composerActions';

describe('composer actions', () => {
  it('registers in order, overrides by id and unregisters', () => {
    const a = { id: 'a', label: 'A', run: () => {} };
    const b = { id: 'b', label: 'B', run: () => {} };
    const a2 = { id: 'a', label: 'A2', run: () => {} };
    const offA = registerComposerAction(a);
    const offB = registerComposerAction(b);
    expect(composerActions().map((x) => x.label)).toEqual(['A', 'B']);
    const offA2 = registerComposerAction(a2);
    expect(composerActions().map((x) => x.label)).toEqual(['B', 'A2']);
    offA();
    expect(composerActions().map((x) => x.label)).toEqual(['B', 'A2']);
    offA2();
    offB();
    expect(composerActions()).toEqual([]);
  });
});
