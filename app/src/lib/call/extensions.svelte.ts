import type { BarButton, BarButtonDef, CallDataEvent, CallPanelDef, CallPanelEntry, PanelState } from './types';

/** プラグインが通話へ足すもの（disnans.call）: データの受け取り・変更の購読・バーのボタン・画面の領域 */
export class CallExtensions {
  barButtons = $state.raw<BarButton[]>([]);
  /** 通話の画面に出す、プラグインの領域（order の順） */
  panels = $state.raw<CallPanelEntry[]>([]);
  private buttonSeq = 0;
  private panelSeq = 0;
  private panelState = new Map<number, PanelState>();
  private eventListeners = new Map<string, Set<(e: CallDataEvent) => void>>();
  private changeListeners = new Set<() => void>();

  constructor(private readonly onError: (e: unknown) => void) {}

  /** 参加者が emit したデータを購読者へ配る */
  deliver(name: string, event: CallDataEvent): void {
    const set = this.eventListeners.get(name);
    if (set) for (const cb of [...set]) this.safe(() => cb(event));
  }

  /** 変更の購読者へ知らせる */
  notifyChange(): void {
    for (const cb of [...this.changeListeners]) this.safe(cb);
  }

  /** 参加者が emit したデータを受け取る。戻り値の関数で外す */
  onEvent(name: string, cb: (e: CallDataEvent) => void): Disnans.Cleanup {
    let set = this.eventListeners.get(name);
    if (!set) this.eventListeners.set(name, (set = new Set()));
    set.add(cb);
    return () => void this.eventListeners.get(name)?.delete(cb);
  }

  onChange(cb: () => void): Disnans.Cleanup {
    this.changeListeners.add(cb);
    return () => void this.changeListeners.delete(cb);
  }

  /** 通話のバーにボタンを足す。返り値で更新・削除 */
  addBarButton(def: BarButtonDef): { update(patch: Partial<BarButtonDef>): void; remove(): void } {
    const id = ++this.buttonSeq;
    this.barButtons = [...this.barButtons, { ...def, id }];
    return {
      update: (patch) => {
        this.barButtons = this.barButtons.map((b) => (b.id === id ? { ...b, ...patch, id } : b));
      },
      remove: () => {
        this.barButtons = this.barButtons.filter((b) => b.id !== id);
      },
    };
  }

  /**
   * 通話の画面（全画面の通話タブ）に、プラグインの領域を足す。el はプラグインが中身を書く要素で、
   * 通話の画面が開いている間だけ文書に入る（閉じても中身は保たれる）。
   */
  addPanel(def: CallPanelDef): Disnans.CallPanel {
    const id = ++this.panelSeq;
    const el = document.createElement('div');
    el.className = 'call-plugin-panel';
    const state: PanelState = { mounted: false, listeners: new Set() };
    this.panelState.set(id, state);
    const entry: CallPanelEntry = { id, label: String(def.label ?? ''), order: Number(def.order ?? 0) || 0, el, visible: false };
    this.panels = [...this.panels, entry].sort((a, b) => a.order - b.order || a.id - b.id);
    const set = (patch: Partial<CallPanelEntry>) => {
      this.panels = this.panels.map((p) => (p.id === id ? { ...p, ...patch } : p));
    };
    return {
      el,
      get mounted() {
        return state.mounted;
      },
      get visible() {
        return entry.visible;
      },
      setVisible: (v) => {
        entry.visible = !!v;
        set({ visible: entry.visible });
      },
      onMount: (cb) => {
        state.listeners.add(cb);
        return () => void state.listeners.delete(cb);
      },
      remove: () => {
        this.panels = this.panels.filter((p) => p.id !== id);
        this.panelState.delete(id);
        state.listeners.clear();
        el.remove();
      },
    };
  }

  /** 通話の画面が、領域の要素を文書に入れた・外した（CallView から呼ぶ） */
  panelMounted(id: number, mounted: boolean): void {
    const state = this.panelState.get(id);
    if (!state || state.mounted === mounted) return;
    state.mounted = mounted;
    for (const cb of [...state.listeners]) this.safe(() => cb(mounted));
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.onError(e);
    }
  }
}
