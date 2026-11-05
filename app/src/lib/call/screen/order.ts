import { LOCAL_VIEW, type ScreenSource } from './types';
import type { ScreenShareView } from './view';

/** 通話の画面で並べる 1 つの映像（自分のこのデバイス・自分の別のデバイス・ほかの人） */
export type ScreenViewEntry = {
  /** 全画面の表示を開く・切り替えるときの印。自分のこのデバイスは LOCAL_VIEW、ほかは相手の peer */
  peer: string;
  /** 自分のこのデバイスのときは null */
  userId: string | null;
  source: ScreenSource;
  local: boolean;
  /** 自分のアカウントの映像か（このデバイスか、自分の別のデバイス） */
  mine: boolean;
  dataUrl: string | null;
};

/** 自分のこのデバイスの映像（静止画のフレーム）を、画像の URL にする。カメラは動画なので null */
export function localFrameUrl(screen: Pick<ScreenShareView, 'localFrame'>): string | null {
  const f = screen.localFrame;
  return f ? `data:${f.mime};base64,${f.data}` : null;
}

/**
 * 並べる順は「自分の今のデバイス > 自分の別のデバイス > ほかの人」。同じ区分の中は、届いた順のまま。
 * 自分の映像がまだ無い（共有していない）ときは、自分のこのデバイスは出さない。
 */
export function orderViews(screen: Pick<ScreenShareView, 'sharing' | 'source' | 'localFrame' | 'sharers'>, myUserId: string | null): ScreenViewEntry[] {
  const out: ScreenViewEntry[] = [];
  if (screen.sharing) out.push({ peer: LOCAL_VIEW, userId: null, source: screen.source, local: true, mine: true, dataUrl: localFrameUrl(screen) });
  const remote = screen.sharers.map((s): ScreenViewEntry => ({ peer: s.peer, userId: s.userId, source: s.source, local: false, mine: myUserId !== null && s.userId === myUserId, dataUrl: s.dataUrl }));
  return [...out, ...remote.filter((e) => e.mine), ...remote.filter((e) => !e.mine)];
}

/** 表示の名前。自分のこのデバイスは「自分の…」、自分の別のデバイスは「…（別のデバイス）」 */
export function viewLabel(entry: ScreenViewEntry, nameOf: (userId: string) => string): string {
  const kind = entry.source === 'camera' ? 'カメラ' : '画面';
  if (entry.local) return `自分の${kind}`;
  const base = `${nameOf(entry.userId ?? '')}の${kind}`;
  return entry.mine ? `${base}（別のデバイス）` : base;
}
