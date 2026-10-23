// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { DeviceList, type DeviceListDeps } from './deviceList.svelte';
import { HttpError } from '../transport/http';
import type { DeviceApi, DeviceInfo } from '../transport/device';

const SELF = 'self-1';
const OTHER = 'other-1';
const THIRD = 'third-1';

function device(id: string, name = id): DeviceInfo {
  return { device_id: id, name, created_at: 1, last_seen_at: 2, has_prefs: true };
}

/** 呼ばれた操作を記録する口。失敗・保留は fail / hold で指定する */
function fakeApi(init: DeviceInfo[] = [device(SELF, '自宅'), device(OTHER, '書斎'), device(THIRD, '旧PC')]) {
  const calls: string[] = [];
  let list = [...init];
  const api = {
    id: vi.fn(async () => {
      calls.push('id');
      return SELF;
    }),
    list: vi.fn(async () => {
      calls.push('list');
      return [...list];
    }),
    register: vi.fn(async (id: string, name: string) => {
      calls.push(`register ${id} ${name}`);
    }),
    remove: vi.fn(async (id: string) => {
      calls.push(`remove ${id}`);
      list = list.filter((d) => d.device_id !== id);
    }),
    read: vi.fn(async () => {
      calls.push('read');
      return { prefs: {}, updatedAt: null, saved: false };
    }),
    write: vi.fn(async () => {
      calls.push('write');
      return { prefs: {}, updatedAt: null, saved: true };
    }),
  };
  return { api: api as unknown as DeviceApi, raw: api, calls };
}

function make(over: Partial<DeviceListDeps> & { api?: DeviceApi | null } = {}) {
  const f = over.api === undefined ? fakeApi() : { api: over.api, raw: null, calls: [] as string[] };
  const renameSelf = over.renameSelf ?? vi.fn(async () => {});
  const scope = { value: 'https://a.example\u0000alice' };
  const list = new DeviceList({ api: f.api, renameSelf, scope: over.scope ?? (() => scope.value) });
  return { list, renameSelf, scope, ...f };
}

/** 読み込み（list）を、外から解放するまで止める */
function holdList(raw: { list: { mockImplementationOnce: (fn: () => Promise<DeviceInfo[]>) => unknown } }, value: DeviceInfo[]) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  raw.list.mockImplementationOnce(async () => {
    await gate;
    return value;
  });
  return () => release();
}

describe('DeviceList（一覧・名前変更・削除）', () => {
  it('読み込みは一覧と自分の ID を取るだけ。設定は読まず・書かず・登録もしない', async () => {
    const { list, calls, raw } = make();
    await list.load();
    expect(list.items.map((d) => d.device_id)).toEqual([SELF, OTHER, THIRD]);
    expect(list.selfId).toBe(SELF);
    expect(list.isSelf(SELF)).toBe(true);
    expect(list.isSelf(OTHER)).toBe(false);
    expect(list.loading).toBe(false);
    expect(calls.sort()).toEqual(['id', 'list']);
    expect(raw!.read).not.toHaveBeenCalled();
    expect(raw!.write).not.toHaveBeenCalled();
    expect(raw!.register).not.toHaveBeenCalled();
  });

  it('読み込みに失敗したら、前の一覧は残して、エラーを出す', async () => {
    const { list, raw } = make();
    await list.load();
    raw!.list.mockRejectedValueOnce(new Error('通信できません'));
    await list.load();
    expect(list.items).toHaveLength(3);
    expect(list.error).toContain('通信できません');
  });

  it('古い読み込みの結果は捨てる（後から始まった読み込みが勝つ）', async () => {
    const { list, raw } = make();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    raw!.list.mockImplementationOnce(async () => {
      await gate;
      return [device('stale')];
    });
    const first = list.load();
    raw!.list.mockImplementationOnce(async () => [device(OTHER)]);
    const second = list.load();
    await second;
    release();
    await first;
    expect(list.items.map((d) => d.device_id)).toEqual([OTHER]);
  });

  it('ブラウザー版（API なし）は何もしない', async () => {
    const { list } = make({ api: null });
    expect(list.available).toBe(false);
    await list.load();
    expect(list.items).toEqual([]);
    expect(await list.remove(OTHER)).toBe(false);
    expect(await list.rename(OTHER, '名前')).toBe(false);
  });

  describe('削除', () => {
    it('このデバイス自身は削除できない（API は呼ばない）', async () => {
      const { list, calls } = make();
      await list.load();
      calls.length = 0;
      expect(await list.remove(SELF)).toBe(false);
      expect(list.error).toContain('削除できません');
      expect(calls).toEqual([]);
      expect(list.items).toHaveLength(3);
    });

    it('ほかのデバイスは消えて、一覧から外れる（ほかは変えない）', async () => {
      const { list, calls } = make();
      await list.load();
      calls.length = 0;
      expect(await list.remove(OTHER)).toBe(true);
      expect(calls).toEqual(['remove ' + OTHER]);
      expect(list.items.map((d) => d.device_id)).toEqual([SELF, THIRD]);
      expect(list.error).toBeNull();
      expect(list.busy).toBeNull();
    });

    it('失敗したら一覧は変えず、エラーを出す（再送はしない）', async () => {
      const { list, raw } = make();
      await list.load();
      raw!.remove.mockRejectedValueOnce(new HttpError(500, 'internal', 'サーバーでエラー'));
      expect(await list.remove(OTHER)).toBe(false);
      expect(raw!.remove).toHaveBeenCalledTimes(1);
      expect(list.items).toHaveLength(3);
      expect(list.error).toContain('削除できませんでした');
      expect(list.busy).toBeNull();
    });

    it('他のデバイスで先に消えていた（404）なら、消えたものとして一覧から外す（エラーにはしない）', async () => {
      const { list, raw } = make();
      await list.load();
      raw!.remove.mockRejectedValueOnce(new HttpError(404, 'not_found', 'デバイスがありません'));
      expect(await list.remove(OTHER)).toBe(true);
      expect(list.items.map((d) => d.device_id)).toEqual([SELF, THIRD]);
      expect(list.error).toBeNull();
    });

    it('一覧にない ID は呼ばない（古い画面からの操作）', async () => {
      const { list, raw } = make();
      await list.load();
      expect(await list.remove('ghost')).toBe(false);
      expect(raw!.remove).not.toHaveBeenCalled();
    });

    it('操作の途中は、ほかの操作を受けない', async () => {
      const { list, raw } = make();
      await list.load();
      let release: () => void = () => {};
      raw!.remove.mockImplementationOnce(
        () => new Promise<void>((r) => (release = r)),
      );
      const pending = list.remove(OTHER);
      expect(list.busy).toBe(OTHER);
      expect(await list.remove(THIRD)).toBe(false);
      expect(await list.rename(THIRD, '新しい')).toBe(false);
      expect(raw!.remove).toHaveBeenCalledTimes(1);
      release();
      expect(await pending).toBe(true);
      expect(list.busy).toBeNull();
    });
  });

  describe('名前の変更', () => {
    it('ほかのデバイスは名前だけ送る（前後の空白は除く）', async () => {
      const { list, raw, renameSelf } = make();
      await list.load();
      expect(await list.rename(OTHER, '  仕事のPC  ')).toBe(true);
      expect(raw!.register).toHaveBeenCalledWith(OTHER, '仕事のPC');
      expect(renameSelf).not.toHaveBeenCalled();
      expect(list.busy).toBeNull();
    });

    it('このデバイスは既存の名前変更（ローカルの名前も直す）に任せる。直接は送らない', async () => {
      const { list, raw, renameSelf } = make();
      await list.load();
      expect(await list.rename(SELF, '書斎のPC')).toBe(true);
      expect(renameSelf).toHaveBeenCalledWith('書斎のPC');
      expect(raw!.register).not.toHaveBeenCalled();
    });

    it('空欄は送らず、エラーを出す', async () => {
      const { list, raw } = make();
      await list.load();
      expect(await list.rename(OTHER, '   ')).toBe(false);
      expect(raw!.register).not.toHaveBeenCalled();
      expect(list.error).toContain('名前を入れてください');
    });

    it('一覧にないデバイスは名前を変えない（PUT で作り直してしまうのを防ぐ）', async () => {
      const { list, raw } = make();
      await list.load();
      expect(await list.rename('ghost', '名前')).toBe(false);
      expect(raw!.register).not.toHaveBeenCalled();
    });

    it('失敗したらエラーを出し、一覧は読み直して現在の名前に戻す', async () => {
      const { list, raw } = make();
      await list.load();
      raw!.register.mockRejectedValueOnce(new Error('保存できません'));
      expect(await list.rename(OTHER, '新名')).toBe(false);
      expect(list.error).toContain('保存できません');
      expect(raw!.list).toHaveBeenCalledTimes(2);
      expect(list.busy).toBeNull();
    });

    it('成功したら一覧を読み直す（サーバーの値に合わせる）', async () => {
      const { list, raw } = make();
      await list.load();
      raw!.list.mockClear();
      await list.rename(OTHER, '新名');
      expect(raw!.list).toHaveBeenCalledTimes(1);
      expect(raw!.write).not.toHaveBeenCalled();
    });
  });
});

describe('DeviceList（読み込みの競合と接続先の切替）', () => {
  it('読み込み中の名前変更・削除は受けない（API を呼ばず）、遅い読み込みの結果で一覧が戻る', async () => {
    const { list, raw } = make();
    await list.load();
    const release = holdList(raw!, [device(SELF, '自宅'), device(THIRD, '旧PC')]);
    const pending = list.load();
    expect(list.loading).toBe(true);
    expect(await list.remove(OTHER)).toBe(false);
    expect(list.error).toContain('読み込み中');
    expect(await list.rename(OTHER, '新名')).toBe(false);
    expect(raw!.remove).not.toHaveBeenCalled();
    expect(raw!.register).not.toHaveBeenCalled();
    release();
    await pending;
    // 読み込みの結果がそのまま入る（操作で先に消した・変えた値を、遅い読み込みで戻さない）
    expect(list.items.map((d) => d.device_id)).toEqual([SELF, THIRD]);
    expect(list.loading).toBe(false);
  });

  it('読み込みが終わるまで削除を受けず、読み込みの結果で消したものが戻らない', async () => {
    const { list, raw } = make();
    await list.load();
    const release = holdList(raw!, [device(SELF, '自宅'), device(OTHER, '書斎'), device(THIRD, '旧PC')]);
    const pending = list.load();
    // 読み込みの途中は削除を受けない。読み込みが終わってから削除する
    expect(await list.remove(OTHER)).toBe(false);
    release();
    await pending;
    expect(await list.remove(OTHER)).toBe(true);
    await list.load();
    expect(list.items.map((d) => d.device_id)).toEqual([SELF, THIRD]);
  });

  it('操作の途中は読み込みも始めない（API を呼ばない）', async () => {
    const { list, raw } = make();
    await list.load();
    let release: () => void = () => {};
    raw!.remove.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const pending = list.remove(OTHER);
    raw!.list.mockClear();
    await list.load();
    expect(raw!.list).not.toHaveBeenCalled();
    release();
    await pending;
  });

  it('接続先が変わったあとの削除は送らず、古い一覧を消す', async () => {
    const { list, raw, scope } = make();
    await list.load();
    scope.value = 'https://b.example\u0000alice';
    expect(await list.remove(OTHER)).toBe(false);
    expect(raw!.remove).not.toHaveBeenCalled();
    expect(list.items).toEqual([]);
    expect(list.selfId).toBeNull();
    expect(list.error).toContain('接続先が変わりました');
    // 消したあとは、読み直すまで操作できない
    expect(await list.remove(THIRD)).toBe(false);
    expect(raw!.remove).not.toHaveBeenCalled();
  });

  it('接続先が変わったあとの名前変更も、古い ID を新しいサーバーへ送らない', async () => {
    const { list, raw, renameSelf, scope } = make();
    await list.load();
    scope.value = 'https://b.example\u0000bob';
    expect(await list.rename(OTHER, '新名')).toBe(false);
    expect(await list.rename(SELF, '新名')).toBe(false);
    expect(raw!.register).not.toHaveBeenCalled();
    expect(renameSelf).not.toHaveBeenCalled();
    expect(list.items).toEqual([]);
  });

  it('読み込み中に接続先が変わったら、その読み込みの結果は捨てる', async () => {
    const { list, raw, scope } = make();
    const release = holdList(raw!, [device(OTHER, '書斎')]);
    const pending = list.load();
    scope.value = 'https://b.example\u0000alice';
    release();
    await pending;
    expect(list.items).toEqual([]);
    expect(list.selfId).toBeNull();
    expect(await list.remove(OTHER)).toBe(false);
    expect(raw!.remove).not.toHaveBeenCalled();
  });

  it('接続先が変わったあとに読み直すと、新しいサーバーの一覧に置き換わる', async () => {
    const { list, raw, scope } = make();
    await list.load();
    scope.value = 'https://b.example\u0000alice';
    raw!.list.mockImplementationOnce(async () => [device('new-1', '新しい')]);
    await list.load();
    expect(list.items.map((d) => d.device_id)).toEqual(['new-1']);
    expect(list.error).toBeNull();
    expect(await list.remove('new-1')).toBe(true);
  });

  it('一度も読んでいないときの操作は、読み直しを促す', async () => {
    const { list, raw } = make();
    expect(await list.remove(OTHER)).toBe(false);
    expect(list.error).toContain('読み直して');
    expect(raw!.remove).not.toHaveBeenCalled();
  });
});
