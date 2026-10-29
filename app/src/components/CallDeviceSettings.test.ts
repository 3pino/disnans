// @vitest-environment jsdom
// 設定の「通話」のデバイスの行。Android のネイティブ所有の通話は、Web の入力の一覧を使わず、保存した値も消さない
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const { fakeCall, listInputs, settingsPatch, settingsValue } = vi.hoisted(() => ({
  fakeCall: {
    nativeOwned: false,
    outputs: [{ id: 'speaker', label: 'スピーカー', kind: 'speaker', selected: true }],
    refreshOutputs: vi.fn(async () => {}),
    chooseOutput: vi.fn(async () => {}),
  },
  listInputs: vi.fn(async () => [{ id: 'web-1', label: 'Web の入力', selected: false }]),
  settingsPatch: vi.fn(),
  settingsValue: { inputId: 'web-dev-saved', output: null, micVolume: 1, outVolume: 1, joinMuted: false, limiter: true, limitDb: -3 },
}));

vi.mock('../lib/call/instance.svelte', () => ({ call: fakeCall }));
vi.mock('../lib/plugins/audio', () => ({ audio: { listInputs } }));
vi.mock('../lib/call/settings.svelte', () => ({
  callSettings: {
    get value() {
      return settingsValue;
    },
    patch: settingsPatch,
  },
}));

import CallDeviceSettings from './CallDeviceSettings.svelte';

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;

function render(): HTMLElement {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(CallDeviceSettings, { target });
  flushSync();
  return target;
}

afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
  fakeCall.nativeOwned = false;
  listInputs.mockClear();
  settingsPatch.mockClear();
  fakeCall.chooseOutput.mockClear();
});

describe('設定の通話のデバイスの行', () => {
  it('Android のネイティブ所有の通話: Web の入力の一覧は読まず、「Android の通話用マイク」と出す。保存した入力は消さない', async () => {
    fakeCall.nativeOwned = true;
    const el = render();
    await Promise.resolve();
    expect(listInputs).not.toHaveBeenCalled();
    expect(el.querySelector('select[aria-label="マイク"]')).toBeNull();
    expect(el.textContent).toContain('Android の通話用マイク');
    expect(settingsPatch).not.toHaveBeenCalled();
    expect(settingsValue.inputId).toBe('web-dev-saved');
  });

  it('ネイティブ所有の通話でも、出力先の選択は残る（選ぶと、いつもどおり切り替える）', () => {
    fakeCall.nativeOwned = true;
    const el = render();
    const out = el.querySelector<HTMLSelectElement>('select[aria-label="音の出力先"]');
    expect(out).not.toBeNull();
    out!.value = 'speaker';
    out!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(fakeCall.chooseOutput).toHaveBeenCalledWith('speaker');
  });

  it('それ以外（Web・Windows・Linux）は、これまでどおり入力の一覧を読み、選べる', async () => {
    fakeCall.nativeOwned = false;
    const el = render();
    await vi.waitFor(() => expect(el.querySelector('select[aria-label="マイク"]')).not.toBeNull());
    expect(listInputs).toHaveBeenCalledTimes(1);
    expect(el.textContent).not.toContain('Android の通話用マイク');
  });
});
