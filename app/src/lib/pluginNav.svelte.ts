// プラグインがナビバーに足した項目（ui.navItem）。本体の項目（チャット・設定など）と違い、利用者の並べ替えの一覧には入らず、
// 登録されていれば自動で出る（コマンドではないので、パレットには出ない）。選んだら、view を開くか onOpen を呼ぶ。
// id は本体の中で一意（先頭に `ui-nav:` を付けて、本体の項目と分ける）。

export type PluginNavEntry = {
  /** 外すときの印（Svelte の状態は値を包むので、参照ではなくこの印で探す） */
  token: number;
  /** ナビの項目の ID（`ui-nav:<利用者の id>`） */
  id: string;
  label: string;
  icon: string;
  badge: number | string | null;
  /** 開く view の種類（あれば、選んだときに開く） */
  view: string | null;
  onOpen: (() => void) | null;
};

let seq = 0;

class PluginNav {
  entries = $state<PluginNavEntry[]>([]);

  find(id: string): PluginNavEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** 項目を足す（同じ ID があれば足さず null）。戻り値の関数でこの項目だけを外す */
  add(entry: Omit<PluginNavEntry, 'token'>): (() => void) | null {
    if (this.find(entry.id)) return null;
    const token = ++seq;
    this.entries = [...this.entries, { ...entry, token }];
    return () => this.remove(token);
  }

  /** 印の項目を外す。同じ ID でも、ほかの印のものには触らない */
  remove(token: number): void {
    this.entries = this.entries.filter((e) => e.token !== token);
  }

  setBadge(id: string, badge: number | string | null): void {
    this.entries = this.entries.map((e) => (e.id === id ? { ...e, badge } : e));
  }

  /** パネルに開いている view に対応する項目（選ばれている表示に使う） */
  forView(plugin: string | null, view: string): PluginNavEntry | undefined {
    void plugin;
    return this.entries.find((e) => e.view === view);
  }
}

export const pluginNav = new PluginNav();
