/** "Mod+Shift+D" を読んだもの */
export type Hotkey = {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  /** 小文字にしたキー（"d", "enter", "f5" など） */
  key: string;
};

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
}

/**
 * "Mod+Shift+D" 形式を読む。Mod は Ctrl（macOS では Cmd）。読めなければ null。
 */
export function parseHotkey(text: string, mac = isMac()): Hotkey | null {
  const parts = text
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) return null;
  const hk: Hotkey = { ctrl: false, meta: false, shift: false, alt: false, key: '' };
  for (const [i, raw] of parts.entries()) {
    const p = raw.toLowerCase();
    const last = i === parts.length - 1;
    if (p === 'mod') {
      if (mac) hk.meta = true;
      else hk.ctrl = true;
    } else if (p === 'ctrl' || p === 'control') hk.ctrl = true;
    else if (p === 'cmd' || p === 'meta') hk.meta = true;
    else if (p === 'shift') hk.shift = true;
    else if (p === 'alt' || p === 'option') hk.alt = true;
    else if (last) hk.key = p === 'space' ? ' ' : p === 'esc' ? 'escape' : p;
    else return null;
  }
  return hk.key ? hk : null;
}

/** KeyboardEvent が hotkey に合うか */
export function matchHotkey(hk: Hotkey, e: KeyboardEvent): boolean {
  if (e.ctrlKey !== hk.ctrl || e.metaKey !== hk.meta || e.shiftKey !== hk.shift || e.altKey !== hk.alt) return false;
  const key = e.key.toLowerCase();
  if (key === hk.key) return true;
  // Shift や Alt で文字が変わる（"D" → "d" は上で吸収。"1" → "!" など）ときは、物理キーでも見る
  const code = e.code.toLowerCase();
  if (hk.key.length === 1) {
    if (/[a-z]/.test(hk.key)) return code === 'key' + hk.key;
    if (/[0-9]/.test(hk.key)) return code === 'digit' + hk.key;
  }
  return false;
}
