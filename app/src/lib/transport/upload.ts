import type { Attachment } from '../protocol/Attachment';
import { HttpError } from './httpError';
import { defaultChannel, type ChannelLike } from './tauriChat';
import { argsHeader } from './write';
import { toBridgeError } from './tauri';
import type { BridgeContext, Invoke } from './types';
import { encodeBody, type BodyMode } from './body';

/**
 * 添付のアップロード（契約 .pi/step4-ipc-contract.md §10）。
 * 再送は自動でしない（利用者が送信を押し直したときだけ、上げ直す）。
 */
export type UploadHandle = { promise: Promise<Attachment>; abort: () => void };

export interface UploadApi {
  upload(file: File, onProgress?: (ratio: number) => void): UploadHandle;
}

/** 進捗の項目（Rust → TS の Channel。順序は Channel が保つ） */
export type UploadItem = { kind: 'progress'; loaded: number; total: number };

/**
 * 添付の Tauri 実装（契約 §10.1）。バイト列は raw body、メタは x-disnans-args ヘッダー
 * （args: server, devUser, uploadId, fileName, mime, onProgress = Channel の toJSON()）。
 * 中止は api_upload_abort({uploadId}) を送り、呼び出し側へは即 aborted を返す。
 */
export function createTauriUploadApi(
  invoke: Invoke,
  ctx: BridgeContext,
  makeChannel: () => Promise<ChannelLike<UploadItem>> = defaultChannel,
  bodyMode: BodyMode = 'raw',
): UploadApi {
  return {
    upload(file, onProgress) {
      const uploadId = crypto.randomUUID();
      let rejectAbort: (e: Error) => void = () => {};
      const aborted = new Promise<never>((_, rej) => (rejectAbort = rej));
      const run = (async () => {
        const ch = await makeChannel();
        ch.onmessage = (item) => {
          if (item.kind === 'progress' && item.total > 0 && onProgress) onProgress(Math.min(1, item.loaded / item.total));
        };
        const body = new Uint8Array(await file.arrayBuffer());
        const args = {
          server: ctx.server(),
          devUser: ctx.devUser,
          uploadId,
          fileName: file.name,
          mime: file.type || null,
          onProgress: ch.toJSON ? ch.toJSON() : '',
        };
        return await invoke<Attachment>('api_upload_file', encodeBody(body, bodyMode), { headers: argsHeader(args) });
      })().catch((e: unknown) => {
        throw toBridgeError(e);
      });
      // 中止後に run が失敗しても未処理の reject にしない
      run.catch(() => {});
      const promise = Promise.race([run, aborted]);
      const abort = () => {
        rejectAbort(new HttpError(0, 'aborted', '中止しました'));
        void invoke('api_upload_abort', { uploadId }).catch(() => {});
      };
      return { promise, abort };
    },
  };
}
