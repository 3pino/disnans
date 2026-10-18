import { describe, expect, it } from 'vitest';
import { HOME, NAV_LIMIT, forgetPanelIn, navBack, navBackDepth, navigate, normalizeNav, parentNav, sameNav, type NavState } from './navHistory';

const at = (patch: Partial<NavState>): NavState => normalizeNav({ ...HOME, ...patch });
const call = at({ tab: 'call' });
const callSettings = at({ tab: 'settings', settingsSub: 'call' });
const settings = at({ tab: 'settings' });
const tl = at({ panel: { kind: 'timeline', id: 1 } });
const tree = at({ panel: { kind: 'replyTree', messageId: 'm1' } });

/** from から patch の画面へ移り、[新しい履歴, 行き先] を返す */
function go(stack: NavState[], from: NavState, to: NavState, mode?: Parameters<typeof navigate>[3]): [NavState[], NavState] {
  return [navigate(stack, from, to, mode), to];
}

describe('normalizeNav / sameNav', () => {
  it('設定のタブの外では、サブページとプラグインの設定画面を持たない', () => {
    expect(normalizeNav({ ...HOME, tab: 'chat', settingsSub: 'call', pluginSettings: 'x' })).toEqual(HOME);
    expect(sameNav({ ...HOME, settingsSub: 'call' }, HOME)).toBe(true);
  });

  it('パネルは中身で比べる', () => {
    expect(sameNav(tl, at({ panel: { kind: 'timeline', id: 1 } }))).toBe(true);
    expect(sameNav(tl, at({ panel: { kind: 'timeline', id: 2 } }))).toBe(false);
    expect(sameNav(tree, at({ panel: { kind: 'replyTree', messageId: 'm2' } }))).toBe(false);
  });
});

describe('navigate', () => {
  it('開く操作は、開く前の状態を積む', () => {
    expect(navigate([], HOME, tl)).toEqual([HOME]);
  });

  it('同じ状態へは積まない', () => {
    expect(navigate([HOME], tl, tl)).toEqual([HOME]);
  });

  it('行き先が履歴にあれば、そこまで戻ったことにする（行き来しても積み上がらない）', () => {
    let s: NavState[] = [];
    let cur = HOME;
    for (let i = 0; i < 5; i++) {
      [s, cur] = go(s, cur, tl);
      [s, cur] = go(s, cur, tree);
    }
    expect(s).toEqual([HOME, tl]);
    expect(cur).toEqual(tree);
  });

  it('replace は積まない', () => {
    expect(navigate([HOME], tl, at({ panel: { kind: 'timeline', id: 2 } }), 'replace')).toEqual([HOME]);
  });

  it('閉じる操作（replace）で履歴にある状態へ移ったら、そこまで戻る', () => {
    // チャット → スレッド → 返信のツリー と開いて、ツリーを閉じてチャットへ
    expect(navigate([HOME, tl], tree, HOME, 'replace')).toEqual([]);
  });

  it('reset（タブの切り替え）は履歴を捨てる。チャット以外のタブなら、戻るとチャットのトップへ', () => {
    expect(navigate([HOME, tl, call], callSettings, settings, 'reset')).toEqual([HOME]);
    expect(navigate([HOME, tl], settings, HOME, 'reset')).toEqual([]);
  });

  it('上限を超えたら古いものから捨てる', () => {
    let s: NavState[] = [];
    let cur = HOME;
    for (let i = 0; i < NAV_LIMIT + 10; i++) [s, cur] = go(s, cur, at({ panel: { kind: 'timeline', id: i } }));
    expect(s).toHaveLength(NAV_LIMIT);
  });
});

describe('navBack', () => {
  it('通話の画面から開いた通話の設定は、戻ると通話の画面へ', () => {
    const [s, cur] = go([], call, callSettings);
    expect(navBack(s, cur)).toEqual({ stack: [], to: call });
  });

  it('チャット（通話のバー）から開いた通話の設定は、戻るとチャットへ（スレッドを開いていればそのまま）', () => {
    const [s, cur] = go([HOME], tl, callSettings);
    const r = navBack(s, cur)!;
    expect(r.to).toEqual(tl);
    expect(navBack(r.stack, r.to)).toEqual({ stack: [], to: HOME });
  });

  it('返信のツリーは、戻ると開いた元の画面へ', () => {
    // メインチャットから
    let [s, cur] = go([], HOME, tree);
    expect(navBack(s, cur)?.to).toEqual(HOME);
    // スレッドの中から
    [s, cur] = go([HOME], tl, tree);
    expect(navBack(s, cur)?.to).toEqual(tl);
  });

  it('いまと同じ状態の履歴（画面のボタンで閉じた跡）は飛ばす', () => {
    expect(navBack([HOME, tl], tl)).toEqual({ stack: [], to: HOME });
  });

  it('履歴が尽きたら、いまの状態から1段ずつ閉じる。チャットのトップなら戻る先はない', () => {
    const cur = at({ tab: 'chat', panel: { kind: 'timeline', id: 1 }, searchOpen: true });
    expect(navBack([], cur)?.to).toEqual(tl);
    expect(navBack([], tl)?.to).toEqual(HOME);
    expect(navBack([], callSettings)?.to).toEqual(settings);
    expect(navBack([], settings)?.to).toEqual(HOME);
    expect(navBack([], HOME)).toBeNull();
    expect(parentNav(HOME)).toBeNull();
  });
});

describe('navBackDepth', () => {
  it('戻れる回数を数える（履歴 + 履歴が尽きたあとの段）', () => {
    expect(navBackDepth([], HOME)).toBe(0);
    expect(navBackDepth([HOME], tl)).toBe(1);
    expect(navBackDepth([HOME, tl], tree)).toBe(2);
    // 履歴は空でも、検索とパネルを1段ずつ閉じられる
    expect(navBackDepth([], at({ panel: { kind: 'timeline', id: 1 }, searchOpen: true }))).toBe(2);
    // 閉じた跡（いまと同じ状態）は数えない
    expect(navBackDepth([HOME, HOME], HOME)).toBe(0);
  });
});

describe('forgetPanelIn', () => {
  it('消えたパネルを履歴から外し、続けて同じになったものはまとめる', () => {
    const s = forgetPanelIn([HOME, tl, tree], (p) => p.kind === 'timeline');
    expect(s).toEqual([HOME, tree]);
  });
});
