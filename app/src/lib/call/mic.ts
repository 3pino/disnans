// マイクの入り口の切り替え。WebView の getUserMedia（既定）と、Rust の取り込み（Linux・opt-in）を、
// 同じ境界（onPcm: 16kHz・モノラル・PCM16 の塊）で扱う。Rust の取り込みの実体は契約（step4-ipc-contract.md）が決まるまで無い

/** マイクの経路。'rust' は Linux のみ、かつ localStorage 'disnans.rustMic' === '1' のときだけ */
export type MicBackend = 'web' | 'rust';

export function micBackendFlag(value: string | null, linux: boolean): MicBackend {
  return linux && value === '1' ? 'rust' : 'web';
}

/** 開いた Rust の取り込み。stop() で止める */
export type RustMic = { stop(): void };

/** Rust の取り込みを開く。失敗は例外（既定の経路へは戻さない。呼び出し側がエラーを出す） */
export type RustMicStarter = (onPcm: (pcm: Int16Array) => void) => Promise<RustMic>;

/** まだ Rust の取り込みが用意されていないときの既定。参加は失敗し、理由を出す */
export const rustMicUnavailable: RustMicStarter = async () => {
  throw new Error('Rust のマイクはまだ使えません（取り込みの実装が未接続）');
};
