import { fakeScreen } from './screenFake';
import type { ScreenShareView } from '../lib/call/screen/view';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** 値を変えると表示が変わる画面共有の偽物（外から閉じられた・共有者が消えた、の再現に使う） */
export function reactiveScreen(over: Partial<ScreenShareView> = {}): Mutable<ReturnType<typeof fakeScreen>> {
  const s = $state(fakeScreen(over));
  return s;
}
