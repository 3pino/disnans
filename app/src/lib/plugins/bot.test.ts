// @vitest-environment jsdom
// examples/bot をそのまま読み込んで、postMessage が期待どおりに呼ばれるか確かめる
import { describe, expect, it, vi } from 'vitest';
import { PluginBase, PluginRuntime } from './runtime';
import { createUi } from './ui';
import { API_VERSION, type HostCommand, type HostServices, type HostSlashCommand, type PluginClass } from './types';
import { VersionConflictError } from './sessions';

const toast = vi.fn();
(globalThis as unknown as { disnans: Partial<Disnans.Host> }).disnans = {
  apiVersion: API_VERSION,
  Plugin: PluginBase,
  ui: createUi({ toast: (...a) => toast(...a), confirm: async () => true }),
  VersionConflictError,
};

async function setup() {
  const slash = new Map<string, HostSlashCommand>();
  const postMessage = vi.fn(async () => {});
  const services = {
    app: { me: { id: 'u1' }, users: [], user: () => undefined, nameOf: () => '', isMobile: false, theme: 'light' },
    api: { postMessage },
    registerSlashCommand: () => () => {},
    registerComposerAction: () => () => {},
    registerCommand: (c: HostCommand) => {
      if (c.slash) {
        slash.set(c.slash, {
          name: c.slash,
          description: c.description || c.name,
          args: c.args,
          run: ({ args, threadId }) => c.run({ args, threadId, via: 'slash' }),
        } as HostSlashCommand);
      }
      return () => {};
    },
    toast: vi.fn(),
    storage: { get: () => null, set: () => {} },
    pluginIcon: () => 'bot',
    registerIcon: () => () => {},
    changed: () => {},
  } as unknown as HostServices;
  const r = new PluginRuntime({ id: 'bot', name: 'ボット', version: '0.1.0', description: '', author: '', minApiVersion: 6 }, services);
  const mod = (await import('../../../../examples/bot/main.js')) as { default: PluginClass };
  await r.start(mod.default);
  return { slash, postMessage };
}

describe('examples/bot', () => {
  it('/bot は本文をそのまま、いまのスレッドに投稿する', async () => {
    const { slash, postMessage } = await setup();
    await slash.get('bot')!.run({ args: 'こんにちは', threadId: 't1' });
    expect(postMessage).toHaveBeenCalledWith('bot', { thread_id: 't1', body: 'こんにちは', name: null, notify: false });
    await slash.get('bot')!.run({ args: 'main', threadId: null });
    expect(postMessage).toHaveBeenLastCalledWith('bot', { thread_id: null, body: 'main', name: null, notify: false });
  });

  it('/bot-as は最初の語を名前にして投稿する', async () => {
    const { slash, postMessage } = await setup();
    await slash.get('bot-as')!.run({ args: 'Alice  hello world', threadId: null });
    expect(postMessage).toHaveBeenCalledWith('bot', { thread_id: null, body: 'hello world', name: 'Alice', notify: false });
  });

  it('本文が空・名前だけなら投稿せずトーストを出す', async () => {
    const { slash, postMessage } = await setup();
    await slash.get('bot')!.run({ args: '', threadId: null });
    await slash.get('bot-as')!.run({ args: 'Alice', threadId: null });
    expect(postMessage).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it('/bot-notify は notify: true で投稿する', async () => {
    const { slash, postMessage } = await setup();
    await slash.get('bot-notify')!.run({ args: 'こんにちは', threadId: 't1' });
    expect(postMessage).toHaveBeenCalledWith('bot', { thread_id: 't1', body: 'こんにちは', name: null, notify: true });
  });

  it('/bot-notify は最初の数字の秒数だけ待ってから投稿する', async () => {
    const { slash, postMessage } = await setup();
    vi.useFakeTimers();
    try {
      const done = slash.get('bot-notify')!.run({ args: '3 hi', threadId: null });
      expect(toast).toHaveBeenCalledWith('3 秒後に投稿します', 'info');
      await vi.advanceTimersByTimeAsync(2999);
      expect(postMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(postMessage).toHaveBeenCalledWith('bot', { thread_id: null, body: 'hi', name: null, notify: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('/bot-notify の秒数は 60 秒までにする', async () => {
    const { slash, postMessage } = await setup();
    vi.useFakeTimers();
    try {
      const done = slash.get('bot-notify')!.run({ args: '999 hi', threadId: null });
      expect(toast).toHaveBeenCalledWith('60 秒後に投稿します', 'info');
      await vi.advanceTimersByTimeAsync(60_000);
      await done;
      expect(postMessage).toHaveBeenCalledWith('bot', { thread_id: null, body: 'hi', name: null, notify: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('/bot-notify は本文が空なら（秒数だけなら）待たずに投稿せずトーストを出す', async () => {
    const { slash, postMessage } = await setup();
    await slash.get('bot-notify')!.run({ args: '5', threadId: null });
    expect(toast).toHaveBeenCalledWith('本文を入力してください', 'error');
    expect(postMessage).not.toHaveBeenCalled();
  });
});
