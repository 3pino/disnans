/** OS の画像取得・小窓の失敗。本体はプラグインの例外型に依存しない。 */
export class MediaError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MediaError';
  }
}
