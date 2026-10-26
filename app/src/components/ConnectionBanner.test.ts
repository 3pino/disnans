// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ConnectionBanner from './ConnectionBanner.svelte';
import { client } from '../lib/stores/client.svelte';
import { CONNECTION_HINT } from '../lib/connection';

// 接続バナー: 一瞬の切れは出さない → 少し続くと「接続しています」→ 長く続くと原因と接続設定（時間は切れた時点から）
let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  client.status = 'open';
  client.ready = false;
  client.chatDown = false;
  client.linkReason = null;
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(ConnectionBanner, { target });
  flushSync();
});
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
  client.status = 'open';
  vi.useRealTimers();
});

const banner = () => target!.querySelector<HTMLElement>('.connection-banner');
const text = () => target!.querySelector('.connection-banner-text')?.textContent ?? '';
async function at(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  flushSync();
}

describe('接続バナーの段階', () => {
  it('つながっている間は出さない', async () => {
    await at(60_000);
    expect(banner()).toBeNull();
  });

  it('一瞬の切れ（1.5 秒より前に戻る）は出さない', async () => {
    client.status = 'closed';
    flushSync();
    await at(1_000);
    client.status = 'open';
    flushSync();
    await at(5_000);
    expect(banner()).toBeNull();
  });

  it('少し続くと「接続しています」を出す（まだ原因と接続設定は出さない）', async () => {
    client.status = 'connecting';
    flushSync();
    await at(1_500);
    expect(banner()).not.toBeNull();
    expect(text()).toBe('サーバーに接続しています…');
    expect(target!.querySelector('.connection-banner-reason')).toBeNull();
    expect([...target!.querySelectorAll('button')].some((b) => b.textContent?.includes('接続設定'))).toBe(false);
  });

  it('15 秒つながらなければ、案内と原因と接続設定を出す', async () => {
    client.status = 'closed';
    client.linkReason = '応答がありません（15 秒）';
    flushSync();
    await at(14_900);
    expect(text()).not.toBe(CONNECTION_HINT);
    await at(200);
    expect(text()).toBe(CONNECTION_HINT);
    expect(target!.querySelector('.connection-banner-reason')?.textContent).toContain('応答がありません（15 秒）');
    expect([...target!.querySelectorAll('button')].some((b) => b.textContent?.includes('接続設定'))).toBe(true);
  });

  it('再接続を繰り返しても、切れた時点から数える（段階はリセットしない）', async () => {
    client.status = 'closed';
    flushSync();
    await at(5_000);
    client.status = 'connecting';
    flushSync();
    await at(5_000);
    client.status = 'closed';
    flushSync();
    await at(5_100);
    expect(text()).toBe(CONNECTION_HINT);
  });

  it('つながると、バナーを消す', async () => {
    client.status = 'closed';
    flushSync();
    await at(20_000);
    expect(text()).toBe(CONNECTION_HINT);
    client.status = 'open';
    flushSync();
    expect(banner()).toBeNull();
  });

  it('チャットだけ切れている（Rust 経路）は、すぐ「チャットに接続できません」と原因を出す', async () => {
    client.status = 'closed';
    client.chatDown = true;
    client.linkReason = 'ネットワークエラー';
    flushSync();
    await at(1_600);
    expect(text()).toBe('チャットに接続できません。30秒ごとに再試行しています');
    expect(target!.querySelector('.connection-banner-reason')?.textContent).toContain('ネットワークエラー');
  });
});
