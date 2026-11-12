import { errorText } from '../errors';

/** サーバー（または Rust 経路）の失敗。status は HTTP の状態（届かなかったときは 0） */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(errorText(code, message));
  }
}
