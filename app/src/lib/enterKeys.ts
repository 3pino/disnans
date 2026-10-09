import { isMac } from './plugins/hotkey';

/** 入力欄で Enter を押したときの動作 */
export type EnterAction = 'send' | 'newline' | 'none';

/** 設定できる Enter の組み合わせ（ctrl は Ctrl か Cmd） */
export type EnterCombo = 'enter' | 'shift' | 'ctrl' | 'alt';

export type EnterKeyPrefs = Record<EnterCombo, EnterAction>;

export const ENTER_COMBOS: EnterCombo[] = ['enter', 'shift', 'ctrl', 'alt'];
/** 既定: Enter・Shift+Enter は改行、Ctrl+Enter・Alt+Enter は送信 */
/** 既定（これまでの動作に合わせる: Shift+Enter だけ改行） */
export const DEFAULT_ENTER_KEYS: Readonly<EnterKeyPrefs> = Object.freeze({
  enter: 'newline',
  shift: 'newline',
  ctrl: 'send',
  alt: 'send',
});

const ACTIONS: EnterAction[] = ['send', 'newline', 'none'];

/** 保存したもの（サーバーの設定の enterKeys）を読む。読めない項目は既定 */
export function normalizeEnterKeys(raw: unknown): EnterKeyPrefs {
  const out = { ...DEFAULT_ENTER_KEYS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of ENTER_COMBOS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'string' && (ACTIONS as string[]).includes(v)) out[k] = v as EnterAction;
  }
  return out;
}

/** 表示用の名前（"Ctrl+Enter"。macOS では "⌘+Enter"） */
export function enterComboLabel(combo: EnterCombo, mac = isMac()): string {
  switch (combo) {
    case 'enter':
      return 'Enter';
    case 'shift':
      return 'Shift+Enter';
    case 'ctrl':
      return mac ? '⌘+Enter' : 'Ctrl+Enter';
    case 'alt':
      return mac ? '⌥+Enter' : 'Alt+Enter';
  }
}

/** Enter のキー入力がどの組み合わせか。Enter でない・修飾キーを2つ以上押しているときは null */
export function enterComboOf(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>): EnterCombo | null {
  if (e.key !== 'Enter') return null;
  const mods = [e.shiftKey && 'shift', (e.ctrlKey || e.metaKey) && 'ctrl', e.altKey && 'alt'].filter(Boolean) as EnterCombo[];
  // Ctrl と Cmd を同時に押したときも2つとみなす
  if (mods.length > 1 || (e.ctrlKey && e.metaKey)) return null;
  return mods[0] ?? 'enter';
}

/** Enter のキー入力の動作。設定していない組み合わせ（Enter でないものも）は null（ブラウザーに任せる） */
export function resolveEnterAction(
  e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>,
  prefs: EnterKeyPrefs,
): EnterAction | null {
  const combo = enterComboOf(e);
  return combo ? prefs[combo] : null;
}

/** ブラウザーが自分で改行を入れる組み合わせか（Enter と Shift+Enter）。それ以外は insertNewline で入れる */
export function insertsNewlineByDefault(combo: EnterCombo): boolean {
  return combo === 'enter' || combo === 'shift';
}

/** 送信に使う組み合わせ（表示用。なければ空） */
export function sendCombos(prefs: EnterKeyPrefs): EnterCombo[] {
  return ENTER_COMBOS.filter((c) => prefs[c] === 'send');
}

/**
 * キャレットの位置に改行を入れる。元に戻す（Ctrl+Z）が効くように、使えれば execCommand で入れる。
 * どちらの方法でも input イベントが起きる
 */
export function insertNewline(ta: HTMLTextAreaElement): void {
  ta.focus();
  let ok = false;
  try {
    // 非推奨だが、textarea で元に戻す履歴に残せるのはこれだけ
    ok = typeof document.execCommand === 'function' && document.execCommand('insertText', false, '\n');
  } catch {
    ok = false;
  }
  if (ok) return;
  ta.setRangeText('\n', ta.selectionStart, ta.selectionEnd, 'end');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}
