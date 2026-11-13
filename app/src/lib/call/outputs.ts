import { pickOutput } from './pure';
import type { CallHost } from './types';

/** 音の出力先の一覧・選択（Web でもネイティブでも同じ。実際の切り替えは deps.audio が行う） */
export class CallOutputs {
  private busy = false;

  constructor(private readonly h: CallHost) {}

  /** 選べる出力先を取り直す。変わっていたら画面を更新する */
  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const list = await this.h.deps.audio.listOutputs();
      if (JSON.stringify(list) !== JSON.stringify(this.h.outputs)) this.h.outputs = list;
    } catch (e) {
      console.warn('[call] 出力先の一覧を取れません', e);
    } finally {
      this.busy = false;
    }
  }

  /** 参加したとき、前に選んだ出力先に戻す（なければ本体の既定: イヤホンがあればそれ、なければスピーカー） */
  async restore(): Promise<void> {
    await this.refresh();
    const want = pickOutput(this.h.outputs, this.h.settings.output);
    if (want && !want.selected) await this.apply(want);
  }

  private async apply(o: Disnans.AudioOutput): Promise<boolean> {
    const ok = await this.h.deps.audio.setOutput(o.id).catch(() => false);
    if (ok) await this.refresh();
    return ok;
  }

  async choose(id: string): Promise<void> {
    const o = this.h.outputs.find((x) => x.id === id);
    if (!o) return;
    if (!(await this.apply(o))) {
      this.h.deps.toast('出力先を切り替えられませんでした', 'error');
      return;
    }
    this.h.deps.settings.patch({ output: { id: o.id, kind: o.kind, label: o.label } });
  }

  /** 次の出力先へ（コマンド用） */
  async cycle(): Promise<void> {
    if (!this.h.joined) {
      this.h.deps.toast('通話に参加していません', 'error');
      return;
    }
    await this.refresh();
    if (this.h.outputs.length < 2) {
      this.h.deps.toast('切り替えられる出力先がありません', 'info');
      return;
    }
    const i = this.h.outputs.findIndex((o) => o.selected);
    const next = this.h.outputs[(i + 1) % this.h.outputs.length];
    await this.choose(next.id);
    this.h.deps.toast(`出力先: ${next.label}`, 'info');
  }
}
