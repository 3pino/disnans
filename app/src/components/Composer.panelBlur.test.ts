// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import Composer from './Composer.svelte';
import { attachPanel } from '../lib/stores/attachPanel.svelte';

vi.mock('../lib/api', () => ({ uploadFile: vi.fn(), }));

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
  attachPanel.hide();
});

describe('添付パネルを開くと、本文の入力欄はフォーカスを持たない', () => {
  it('開いたとき textarea から blur され、本文は残る', async () => {
    target = document.createElement('div');
    document.body.append(target);
    instance = mount(Composer, { target, props: { placeholder: '' } });
    flushSync();
    await tick();
    const ta = target.querySelector('textarea');
    expect(ta).not.toBeNull();
    ta!.value = '下書き';
    ta!.focus();
    expect(document.activeElement).toBe(ta);
    attachPanel.show();
    flushSync();
    await tick();
    expect(document.activeElement).not.toBe(ta);
    expect(target.querySelector('textarea')!.value).toBe('下書き');
  });
});
