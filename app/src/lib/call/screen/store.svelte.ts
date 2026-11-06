import { LOCAL_VIEW } from './types';
import type { ScreenFrame, ScreenSettingsPort, ScreenSettingsValue, ScreenShareDeps, ScreenSource } from './types';
import { ScreenReceiver, SCREEN_FRAME, SCREEN_QUERY, SCREEN_STATE } from './receiver.svelte';
import { ScreenSender } from './sender';
import { QUALITY_PRESETS } from './codec';
import { DIFF_THRESHOLD } from './diff';
import { KEEPALIVE_FRAME_MS } from './pacing';
import { captureFailure, isCaptureCancelled, oppositeCamera, pickVideo, stopTracks, switchableCamera } from './webCapture';

/** 本体の通話が持つ共有。参加／退出の判断を別のプラグインへ複製しない。 */
export class ScreenShareStore {
  sharing = $state(false);
  starting = $state(false);
  source = $state<ScreenSource>('screen');
  switching = $state(false);
  canSwitchCamera = $state(false);
  localStream = $state.raw<MediaStream | null>(null);
  localFrame = $state.raw<ScreenFrame | null>(null);
  viewerOpen = $state(false);
  selectedPeer = $state<string | null>(null);
  readonly settings: ScreenSettingsPort;
  private readonly receiver: ScreenReceiver;
  private readonly now: () => number;
  private sender: ScreenSender | null = null;
  private backend: 'native' | 'web' | null = null;
  private nativeRelay = false;
  private epoch = 0;
  private disposed = false;
  private peer = '';
  private wasJoined = false;
  private wasListed = false;
  private knownPeers = new Set<string>();
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeat = 0;
  private queryRetries = 0;
  private runSettings: ScreenSettingsValue;

  constructor(private deps: ScreenShareDeps) {
    this.settings = deps.settings;
    this.runSettings = { ...deps.settings.value };
    this.now = deps.now ?? Date.now;
    this.receiver = new ScreenReceiver(deps.call, this.now);
  }

  get sharers() { return this.receiver.sharers; }
  get canScreen(): boolean { return this.deps.capture.supported || typeof globalThis.navigator?.mediaDevices?.getDisplayMedia === 'function'; }
  get canCamera(): boolean { return typeof globalThis.navigator?.mediaDevices?.getUserMedia === 'function'; }

  toggleScreen(): Promise<void> { return this.toggle('screen'); }
  toggleCamera(): Promise<void> { return this.toggle('camera'); }

  private async toggle(source: ScreenSource): Promise<void> {
    if (this.disposed) return;
    if (this.starting || (this.sharing && this.source === source)) { this.stop(); return; }
    if (!this.deps.call.joined || !this.deps.call.listed) { this.deps.toast('通話に参加していません', 'error'); return; }
    if (!(source === 'screen' ? this.canScreen : this.canCamera)) { this.deps.toast(source === 'screen' ? 'この環境では画面を共有できません（見ることはできます）' : 'この環境ではカメラを共有できません', 'error'); return; }
    this.stop();
    const epoch = ++this.epoch;
    this.source = source;
    this.starting = true;
    this.runSettings = { ...this.settings.value };
    try {
      if (source === 'screen' && this.deps.capture.supported) await this.startNative(epoch);
      else await this.startWeb(epoch, source);
    } catch (error) {
      if (this.current(epoch)) {
        this.stop();
        if (!(source === 'screen' && isCaptureCancelled(error))) this.deps.toast(captureFailure(source, error), 'error');
      }
    } finally {
      if (this.current(epoch)) this.starting = false;
    }
  }

  private current(epoch: number): boolean { return !this.disposed && epoch === this.epoch && this.deps.call.joined; }

  private makeSender(epoch: number): ScreenSender {
    const value = this.runSettings;
    return new ScreenSender({
      call: this.deps.call,
      settings: { value, patch: () => {}, subscribe: () => () => {} },
      now: this.now,
      onStall: (reason) => {
        if (!this.current(epoch)) return;
        if (reason === 'send_failed' || reason === 'left_call') this.stop();
        this.deps.toast('映像を取り込めません。共有を止めて、もう一度お試しください', 'error');
      },
      onTune: (value) => {
        if (this.current(epoch) && this.backend === 'native' && !this.nativeRelay) {
          void this.deps.capture.update(value).catch(() => {});
        }
      },
    });
  }

  private async startNative(epoch: number): Promise<void> {
    const preset = QUALITY_PRESETS[this.runSettings.quality];
    this.backend = 'native'; // 許可待ちの stop も、取得番号を持つ橋へ届く
    this.nativeRelay = this.deps.capture.supportsCallRelay === true;
    await this.deps.capture.start({
      maxEdge: preset.maxEdge, quality: preset.quality, fps: this.runSettings.fps,
      format: 'jpeg', color: this.runSettings.color, diffThreshold: DIFF_THRESHOLD, keepaliveMs: KEEPALIVE_FRAME_MS,
      ...(this.nativeRelay ? { callRelay: { frameEvent: SCREEN_FRAME, stateEvent: SCREEN_STATE, queryEvent: SCREEN_QUERY, state: { source: 'screen' } } } : {}),
      onEnd: () => { if (this.current(epoch)) this.stop(); },
    }, (frame) => {
      if (!this.current(epoch)) return;
      this.localFrame = frame;
      if (this.sharing && !this.nativeRelay) this.sender?.offerNative(frame);
    });
    // 遅い完了は橋が取得番号で破棄する。ここから stop() を呼ぶと新しい取得を止めるので触らない。
    if (!this.current(epoch)) return;
    if (!this.nativeRelay) {
      this.sender = this.makeSender(epoch);
      this.sender.startNative();
    }
    this.sharing = true;
    this.starting = false;
    this.lastHeartbeat = this.now();
    this.sendState(true);
    if (this.localFrame && !this.nativeRelay) this.sender?.offerNative(this.localFrame);
  }

  private async startWeb(epoch: number, source: ScreenSource): Promise<void> {
    const stream = await pickVideo(source, this.runSettings.fps);
    if (!this.current(epoch)) { stopTracks(stream); return; }
    const sender = this.makeSender(epoch);
    try { sender.startWeb(stream); }
    catch (error) { sender.stop(); stopTracks(stream); throw error; }
    this.sender = sender;
    this.backend = 'web';
    this.nativeRelay = false;
    this.localStream = stream;
    this.sharing = true;
    this.starting = false;
    this.lastHeartbeat = this.now();
    this.trackEnd(stream, epoch);
    this.sendState(true);
    if (source === 'camera') void switchableCamera().then((ok) => { if (this.current(epoch) && this.localStream === stream) this.canSwitchCamera = ok; });
  }

  private trackEnd(stream: MediaStream, epoch: number): void {
    for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => {
      if (this.current(epoch) && this.localStream === stream) this.stop();
    });
  }

  async switchCamera(): Promise<void> {
    const old = this.localStream;
    if (!old || this.source !== 'camera' || !this.sharing || this.switching || !this.canSwitchCamera) return;
    const epoch = this.epoch;
    this.switching = true;
    let fresh: MediaStream | null = null;
    try {
      fresh = await oppositeCamera(old, this.runSettings.fps);
      if (!this.current(epoch) || this.localStream !== old) { stopTracks(fresh); return; }
      const sender = this.makeSender(epoch);
      try { sender.startWeb(fresh); } catch (error) { sender.stop(); throw error; }
      this.sender?.stop();
      this.sender = sender;
      this.localStream = fresh;
      this.trackEnd(fresh, epoch);
      stopTracks(old);
    } catch {
      stopTracks(fresh);
      if (this.current(epoch)) this.deps.toast('カメラを切り替えられませんでした。いまのカメラのまま続けます', 'error');
    } finally { if (this.current(epoch)) this.switching = false; }
  }

  stop(): void {
    const wasActive = this.sharing;
    const native = this.backend === 'native';
    ++this.epoch;
    this.starting = false;
    this.sharing = false;
    this.switching = false;
    this.canSwitchCamera = false;
    this.sender?.stop();
    this.sender = null;
    stopTracks(this.localStream);
    this.localStream = null;
    this.localFrame = null;
    // 自分の映像を全画面で見ていたなら、共有が止まった時点で閉じる（ほかの人の映像へ勝手に切り替えない）
    if (this.selectedPeer === LOCAL_VIEW) { this.closeViewer(); this.selectedPeer = null; }
    if (wasActive) this.sendState(false); // ネイティブ所有なら off もネイティブだけが送る
    this.backend = null;
    this.nativeRelay = false;
    if (native) void this.deps.capture.stop().catch(() => this.deps.toast('画面の取得を止められませんでした', 'error'));
  }

  private send(name: string, payload: unknown): void {
    if (!this.deps.call.joined || !this.deps.call.listed) return;
    try { this.deps.call.emit(name, payload); } catch { /* 退出と競合した送信は捨てる */ }
  }
  private sendState(on: boolean): void {
    if (!this.nativeRelay) this.send(SCREEN_STATE, on ? { on: true, source: this.source } : { on: false });
  }
  private query(): void { if (!this.nativeRelay) this.send(SCREEN_QUERY, {}); }
  private announce(): void {
    if (!this.sharing || this.nativeRelay) return;
    this.sendState(true);
    this.sender?.announce();
  }

  /** CallStore.refresh が、同じ通話の一時的な回復と実際の退出を区別した後に呼ぶ。 */
  onCallChange(): void {
    if (this.disposed) return;
    const call = this.deps.call;
    const changedPeer = this.wasJoined && call.joined && this.peer !== '' && call.myPeer !== '' && this.peer !== call.myPeer;
    if (!call.joined || changedPeer) {
      this.stop();
      this.receiver.clear();
      this.closeViewer();
    }
    if (!call.joined) {
      this.wasJoined = false;
      this.wasListed = false;
      this.peer = '';
      this.knownPeers.clear();
      this.stopWatch();
      return;
    }
    this.receiver.sync();
    this.fixSelection();
    if (!this.watchTimer) this.watchTimer = setInterval(() => this.watch(), 1000);
    if (call.listed && (!this.wasJoined || !this.wasListed || changedPeer)) { this.query(); this.queryRetries = 2; }
    const peers = new Set(call.participants.filter((p) => !p.self).map((p) => p.peer));
    if ([...peers].some((peer) => !this.knownPeers.has(peer))) this.announce();
    this.knownPeers = peers;
    this.wasJoined = true;
    this.wasListed = call.listed;
    if (call.myPeer) this.peer = call.myPeer;
  }

  onEvent(name: string, event: { peer: string; userId: string; payload: unknown }): void {
    if (this.disposed || !this.deps.call.joined) return;
    if (name === SCREEN_QUERY) {
      if (this.deps.call.participants.some((p) => !p.self && p.peer === event.peer && p.userId === event.userId)) this.announce();
    } else this.receiver.event(name, event);
    this.fixSelection();
  }

  private watch(): void {
    if (!this.deps.call.joined) { this.onCallChange(); return; }
    this.receiver.expire();
    this.fixSelection();
    if (this.queryRetries > 0 && this.deps.call.listed) { this.query(); --this.queryRetries; }
    if (this.sharing && !this.nativeRelay && this.now() - this.lastHeartbeat >= 3000) { this.sendState(true); this.lastHeartbeat = this.now(); }
  }
  private stopWatch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.queryRetries = 0;
  }

  /** 見られる映像か（相手の共有、または自分の共有 LOCAL_VIEW） */
  private hasView(peer: string | null): boolean {
    return peer === LOCAL_VIEW ? this.sharing : this.sharers.some((s) => s.peer === peer);
  }
  openViewer(peer?: string): void {
    if (peer && this.hasView(peer)) this.selectedPeer = peer;
    this.fixSelection();
    this.viewerOpen = this.selectedPeer !== null;
  }
  closeViewer(): void { this.viewerOpen = false; }
  selectPeer(peer: string): void { if (this.hasView(peer)) this.selectedPeer = peer; }
  private fixSelection(): void {
    if (!this.hasView(this.selectedPeer)) this.selectedPeer = this.sharers[0]?.peer ?? null;
    if (!this.selectedPeer) this.closeViewer();
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    this.stopWatch();
    this.receiver.clear();
    this.closeViewer();
  }
}
