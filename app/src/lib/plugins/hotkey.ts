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
    else if (last) hk.key = p === 'space' ? ' ' : p === 'esc' ? 'escape' : p === 'plus' ? '+' : p;
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

/**
 * 比べるための正規化した文字列（"Mod+Shift+D" と "Shift+Ctrl+d" は、macOS 以外では同じ）。読めなければ null
 */
export function hotkeyId(text: string, mac = isMac()): string | null {
  const hk = parseHotkey(text, mac);
  if (!hk) return null;
  return [hk.ctrl && 'ctrl', hk.meta && 'meta', hk.alt && 'alt', hk.shift && 'shift', hk.key].filter(Boolean).join('+');
}

/** 表示用のキーの名前 */
const KEY_LABELS: Record<string, string> = {
  ' ': 'Space',
  escape: 'Esc',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  backspace: 'Backspace',
  delete: 'Delete',
  '+': 'Plus',
};

function keyLabel(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  if (key.length === 1) return key.toUpperCase();
  return key[0].toUpperCase() + key.slice(1);
}

/**
 * 表示用の文字列（"Ctrl+Shift+D"。macOS では "⌘⇧D"）。読めなければ元の文字列のまま
 */
export function formatHotkey(text: string, mac = isMac()): string {
  const hk = parseHotkey(text, mac);
  if (!hk) return text;
  const key = keyLabel(hk.key);
  if (mac) return [hk.ctrl && '⌃', hk.alt && '⌥', hk.shift && '⇧', hk.meta && '⌘', key].filter(Boolean).join('');
  return [hk.ctrl && 'Ctrl', hk.meta && 'Meta', hk.alt && 'Alt', hk.shift && 'Shift', key].filter(Boolean).join('+');
}

/** 修飾キーだけのときや、IME などで読めないキー */
const IGNORED_KEYS = new Set(['control', 'shift', 'alt', 'meta', 'os', 'altgraph', 'capslock', 'fn', 'fnlock', 'hyper', 'super', 'dead', 'process', 'unidentified']);

/**
 * 押したキーを "Mod+Shift+D" 形式にする（ショートカットの記録に使う）。修飾キーだけのときは null。
 * 端末をまたいで使えるように、Ctrl（macOS では Cmd）は Mod にする
 */
export function hotkeyFromEvent(e: KeyboardEvent, mac = isMac()): string | null {
  if (IGNORED_KEYS.has(e.key.toLowerCase())) return null;
  // 文字キー・数字キーは、Shift などで変わらないように物理キーから取る
  let key: string;
  const letter = /^Key([A-Z])$/.exec(e.code);
  const digit = /^Digit([0-9])$/.exec(e.code);
  if (letter) key = letter[1];
  else if (digit) key = digit[1];
  else if (e.key === ' ') key = 'Space';
  else if (e.key === '+') key = 'Plus';
  else if (e.key.length === 1) key = e.key.toUpperCase();
  else key = e.key;
  const parts: string[] = [];
  if (mac) {
    if (e.metaKey) parts.push('Mod');
    if (e.ctrlKey) parts.push('Ctrl');
  } else {
    if (e.ctrlKey) parts.push('Mod');
    if (e.metaKey) parts.push('Meta');
  }
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/** 入力欄で文字を打っている間も効かせてよいか（Ctrl・Cmd・Alt のどれかを含むか、F1〜F12） */
export function worksWhileTyping(hk: Hotkey): boolean {
  return hk.ctrl || hk.meta || hk.alt || /^f[0-9]{1,2}$/.test(hk.key);
}
