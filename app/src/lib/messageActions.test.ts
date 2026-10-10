// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from './protocol/Message';
import { registerMessageAction, resolveMessageActions, type MessageAction, type MessageActionContext } from './messageActions.svelte';

const ctx: MessageActionContext = { message: { id: 'm1', body: 'hi' } as Message, inThread: false, place: null };
const offs: (() => void)[] = [];
function add(a: Partial<MessageAction> & { id: string }) {
  offs.push(registerMessageAction({ label: a.id, placement: 'both', run: () => {}, ...a }));
}
const ids = (where: 'menu' | 'toolbar') => resolveMessageActions(ctx, where).map((a) => a.id);

afterEach(() => {
  while (offs.length) offs.pop()!();
});

describe('message actions', () => {
  it('並び順（order、同じなら登録順）と placement で振り分ける', () => {
    add({ id: 'late', order: 9000 });
    add({ id: 'p1' });
    add({ id: 'p2' });
    add({ id: 'first', order: 100, placement: 'toolbar' });
    add({ id: 'menu-only', order: 200, placement: 'menu' });
    expect(ids('toolbar')).toEqual(['first', 'p1', 'p2', 'late']);
    expect(ids('menu')).toEqual(['menu-only', 'p1', 'p2', 'late']);
  });

  it('when で外し、label は関数でもよく、例外の項目は出さない', () => {
    add({ id: 'no', when: () => false });
    add({ id: 'bad', when: () => { throw new Error('x'); } });
    add({ id: 'dyn', label: (c) => `id:${c.message.id}` });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = resolveMessageActions(ctx, 'menu');
    expect(r.map((a) => [a.id, a.label])).toEqual([['dyn', 'id:m1']]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('同じ id は後勝ちで、解除すると消える', () => {
    add({ id: 'a', label: 'A' });
    const off = registerMessageAction({ id: 'a', label: 'A2', placement: 'both', run: () => {} });
    expect(resolveMessageActions(ctx, 'menu').map((a) => a.label)).toEqual(['A2']);
    off();
    expect(ids('menu')).toEqual([]);
  });

  it('run には押した場所と openPicker を渡す', () => {
    const run = vi.fn();
    add({ id: 'r', run });
    const anchor = new DOMRect(1, 2, 3, 4);
    const open = vi.fn();
    resolveMessageActions(ctx, 'menu')[0].run(anchor, open);
    expect(run).toHaveBeenCalledWith({ ...ctx, anchor, openPicker: open });
  });
});
