// localStorage / sessionStorage は使えない環境があるので必ず包む
function store(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function getItem(key: string, kind: 'local' | 'session' = 'local'): string | null {
  try {
    return store(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function setItem(key: string, value: string | null, kind: 'local' | 'session' = 'local'): void {
  try {
    const s = store(kind);
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    // 保存できなくても動作は続ける
  }
}

/** 書けなかったら例外を投げる版（容量不足で再試行する呼び出し元だけが使う）。読むのは getItem と同じく包む */
export function setItemOrThrow(key: string, value: string, kind: 'local' | 'session' = 'local'): void {
  const s = store(kind);
  if (!s) throw new Error('storage unavailable');
  s.setItem(key, value);
}
