import { devUser, getServerUrl } from '../config';
import { createDeviceApi, type DeviceApi, type DeviceInfo } from '../transport/device';
import { tauriInvoke } from '../transport/tauri';
import { HttpError } from '../transport/http';
import { deviceSettings } from './deviceSettings.svelte';

// 「デバイス設定」の一覧（自分のデバイス・名前の変更・削除）。
// 安全の決まり:
// - 一覧の読み込みは設定を書かない（登録も読み直しもしない。一覧だけ）。
// - このデバイス自身は削除できない（消すと、このデバイスの設定の読み書きが 404 になり、以後の保存が失敗し続けるため）。
// - 削除は1件ずつ、確認のあと。送信の失敗は自動で再送しない。失敗したら一覧は変えず、エラーを出す。
// - 一覧にないデバイスの名前は変えない（PUT は無ければ作るので、消えたデバイスを作り直してしまう）。
// - 他のデバイスで消えていた（404）ときは、消えたものとして一覧から外す。
// - 同時に1つの操作だけ。読み込み中は名前変更・削除を受けない（遅い読み込みの結果で一覧が戻らないように）。
// - 接続先（サーバー・開発ユーザー）が変わったら、古い一覧の ID は使わない（一覧を消し、読み直すまで操作しない）。

export type DeviceListDeps = {
  /** Tauri のときだけ（ブラウザ版は一覧を持たない） */
  api: DeviceApi;
  /** このデバイス自身の名前を変える（ローカルの名前も一緒に直す必要があるので、deviceSettings に任せる） */
  renameSelf: (name: string) => Promise<void>;
  /** 接続先の識別（サーバーの URL と開発ユーザー）。値は呼ぶたびに読む（動的に変わりうる） */
  scope: () => string;
};

export class DeviceList {
  /** 一覧（サーバーの順。新しい順） */
  items = $state.raw<DeviceInfo[]>([]);
  /** このデバイスの ID（読み込みのときに取る。取れるまでは null） */
  selfId = $state<string | null>(null);
  loading = $state(false);
  /** 直近の操作の失敗（画面に出す。成功・次の操作で消す） */
  error = $state<string | null>(null);
  /** 名前変更・削除の対象のデバイス ID（操作中のあいだ、他の操作は受けない） */
  busy = $state<string | null>(null);

  /** 一覧を読んだときの接続先（null は一覧なし） */
  private listedScope: string | null = null;
  private loadSeq = 0;

  constructor(private deps: DeviceListDeps) {}

  isSelf(id: string): boolean {
    return this.selfId !== null && id === this.selfId;
  }

  /** 一覧と ID を消す（接続先が変わったとき） */
  private clear(): void {
    this.items = [];
    this.selfId = null;
    this.listedScope = null;
  }

  /** 名前変更・削除の前の確認。理由があれば文言を返す（null なら送ってよい） */
  private refusal(): string | null {
    if (this.loading) return '一覧を読み込み中です。読み込みが終わってから操作してください';
    if (this.busy !== null) return 'ほかの操作が終わってから、もう一度操作してください';
    if (this.listedScope === null) return '一覧を読み直してから操作してください';
    if (this.listedScope !== this.deps.scope()) {
      this.clear();
      return '接続先が変わりました。一覧を読み直してから操作してください';
    }
    return null;
  }

  /** 一覧を読む（設定は読まず、書かない）。古い読み込みの結果は捨てる。接続先が変わっていたら、結果を入れる前に古い一覧を消す */
  async load(): Promise<void> {
    const api = this.deps.api;
    if (this.busy !== null) return;
    const seq = ++this.loadSeq;
    const scope = this.deps.scope();
    if (this.listedScope !== null && this.listedScope !== scope) this.clear();
    this.loading = true;
    try {
      const [self, list] = await Promise.all([api.id(), api.list()]);
      // 読んでいるあいだに接続先や読み込みが変わったら、この結果は使わない
      if (seq !== this.loadSeq || scope !== this.deps.scope()) return;
      this.selfId = self;
      this.items = list;
      this.listedScope = scope;
      this.error = null;
    } catch (e) {
      if (seq !== this.loadSeq) return;
      this.error = `デバイスの一覧を読めませんでした: ${errorText(e)}`;
    } finally {
      if (seq === this.loadSeq) this.loading = false;
    }
  }

  /** 名前を変える（空欄は受けない）。このデバイスは既存の名前変更（ローカルも直す）、ほかは名前だけ送る */
  async rename(id: string, name: string): Promise<boolean> {
    const api = this.deps.api;
    const trimmed = name.trim();
    if (trimmed === '') {
      this.error = 'デバイスの名前を入れてください';
      return false;
    }
    const why = this.refusal();
    if (why) {
      this.error = why;
      return false;
    }
    if (!this.isSelf(id) && !this.items.some((d) => d.device_id === id)) {
      this.error = 'このデバイスは一覧にありません（一覧を読み直してください）';
      return false;
    }
    this.busy = id;
    this.error = null;
    let failure: string | null = null;
    try {
      if (this.isSelf(id)) await this.deps.renameSelf(trimmed);
      else await api.register(id, trimmed);
    } catch (e) {
      failure = `名前を変えられませんでした: ${errorText(e)}`;
    }
    this.busy = null;
    // 読み直しのあとに置く（読み直しは成功時にエラーを消すため）
    await this.load();
    if (failure !== null) this.error = failure;
    return failure === null;
  }

  /** デバイスとその設定を消す。このデバイス自身は消さない（拒否する）。確認は呼び出し側で済ませておく */
  async remove(id: string): Promise<boolean> {
    const api = this.deps.api;
    const why = this.refusal();
    if (why) {
      this.error = why;
      return false;
    }
    if (this.isSelf(id)) {
      this.error = 'このデバイスは削除できません';
      return false;
    }
    if (!this.items.some((d) => d.device_id === id)) {
      this.error = 'このデバイスは一覧にありません（一覧を読み直してください）';
      return false;
    }
    this.busy = id;
    this.error = null;
    try {
      await api.remove(id);
      this.items = this.items.filter((d) => d.device_id !== id);
      return true;
    } catch (e) {
      // 他のデバイスで先に消えていた: 目的は果たしているので、一覧から外すだけ
      if (e instanceof HttpError && e.status === 404) {
        this.items = this.items.filter((d) => d.device_id !== id);
        return true;
      }
      this.error = `デバイスを削除できませんでした: ${errorText(e)}`;
      return false;
    } finally {
      this.busy = null;
    }
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function realDeps(): DeviceListDeps {
  return {
    api: createDeviceApi(tauriInvoke, { server: () => getServerUrl(), devUser }),
    renameSelf: (name) => deviceSettings.renameDevice(name),
    scope: () => `${getServerUrl()}\u0000${devUser ?? ''}`,
  };
}

export const deviceList = new DeviceList(realDeps());
