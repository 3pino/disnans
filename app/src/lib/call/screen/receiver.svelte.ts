import { FrameAssembler, parseChunk, sniffImageMime } from './protocol';
import type { ScreenCallPort, ScreenDataEvent, ScreenSharer, ScreenSource } from './types';

export const SCREEN_FRAME = 'screen.frame';
export const SCREEN_STATE = 'screen.state';
export const SCREEN_QUERY = 'screen.query';
export const SHARER_TIMEOUT_MS = 10_000;

/** 通話の参加者だけから映像を受ける。組み立て中も送り手ごとに一枚まで。 */
export class ScreenReceiver {
  sharers = $state.raw<ScreenSharer[]>([]);
  private assemblers = new Map<string, FrameAssembler>();
  private seen = new Map<string, number>();

  constructor(private call: ScreenCallPort, private now: () => number) {}

  event(name: string, e: ScreenDataEvent): void {
    if (!this.call.joined || !this.call.participants.some((p) => !p.self && p.peer === e.peer && p.userId === e.userId)) return;
    if (name === SCREEN_STATE) {
      const payload = e.payload;
      if (!payload || typeof payload !== 'object' || !('on' in payload) || typeof payload.on !== 'boolean') return;
      if (!payload.on) { this.remove(e.peer); return; }
      const source: ScreenSource = 'source' in payload && payload.source === 'camera' ? 'camera' : 'screen';
      this.touch(e, source);
    } else if (name === SCREEN_FRAME) {
      const chunk = parseChunk(e.payload);
      if (!chunk) return;
      this.touch(e);
      let assembler = this.assemblers.get(e.peer);
      if (!assembler) this.assemblers.set(e.peer, (assembler = new FrameAssembler()));
      const b64 = assembler.push(chunk);
      if (!b64) return;
      const mime = sniffImageMime(b64);
      if (!mime) return;
      this.sharers = this.sharers.map((s) => s.peer === e.peer ? { ...s, dataUrl: `data:${mime};base64,${b64}`, lastSeen: this.now() } : s);
    }
  }

  private touch(e: ScreenDataEvent, source?: ScreenSource): void {
    const at = this.now();
    this.seen.set(e.peer, at);
    const old = this.sharers.find((s) => s.peer === e.peer);
    if (!old) this.sharers = [...this.sharers, { peer: e.peer, userId: e.userId, source: source ?? 'screen', dataUrl: null, lastSeen: at }];
    else if (source && source !== old.source) {
      this.assemblers.delete(e.peer);
      this.sharers = this.sharers.map((s) => s.peer === e.peer ? { ...s, source, dataUrl: null, lastSeen: at } : s);
    }
  }

  sync(): void {
    const peers = new Map(this.call.participants.filter((p) => !p.self).map((p) => [p.peer, p.userId]));
    for (const s of this.sharers) if (!this.call.joined || peers.get(s.peer) !== s.userId) this.remove(s.peer);
  }

  expire(): void {
    const at = this.now();
    for (const [peer, seen] of this.seen) if (at - seen > SHARER_TIMEOUT_MS) this.remove(peer);
  }

  private remove(peer: string): void {
    this.sharers = this.sharers.filter((s) => s.peer !== peer);
    this.assemblers.delete(peer);
    this.seen.delete(peer);
  }

  clear(): void {
    this.sharers = [];
    this.assemblers.clear();
    this.seen.clear();
  }
}
