import type { ApiError } from '../protocol/ApiError';
import type { Attachment } from '../protocol/Attachment';
import { apiUrl, authHeaders } from '../config';
import { HttpError } from './http';
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

/** HTTP の経路（従来の XHR。挙動は変えない） */
export function createHttpUploadApi(): UploadApi {
  return {
    upload(file, onProgress) {
      const xhr = new XMLHttpRequest();
      const promise = new Promise<Attachment>((resolve, reject) => {
        xhr.open('POST', apiUrl('/api/files'));
        for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText) as Attachment);
            } catch {
              reject(new HttpError(xhr.status, 'bad_response', 'サーバーの応答を読めませんでした'));
            }
          } else {
            let code = 'http_' + xhr.status;
            let message = `HTTP ${xhr.status}`;
            try {
              const e = JSON.parse(xhr.responseText) as ApiError;
              code = e.code;
              message = e.message;
            } catch {
              // そのまま
            }
            reject(new HttpError(xhr.status, code, message));
          }
        };
        xhr.onerror = () => reject(new HttpError(0, 'network', 'ネットワークエラー'));
        xhr.onabort = () => reject(new HttpError(0, 'aborted', '中止しました'));
        const fd = new FormData();
        fd.append('file', file, file.name);
        xhr.send(fd);
      });
      return { promise, abort: () => xhr.abort() };
    },
  };
}

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
