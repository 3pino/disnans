# UI 部品

本体の画面で使い回す小さな部品です。**見た目の正はグローバルの CSS クラス（`src/app.css`）** で、
ここの Svelte コンポーネントはそのクラスを付けるだけの薄い包みです。
プラグイン向けの DOM 部品（`disnans.ui`。`src/lib/plugins/ui.ts`、説明は `docs/PLUGIN_UI.md`）も、同じクラスを付けた同じ DOM を作ります。
部品を足したり DOM を変えたりしたら、Svelte の部品・`ui.ts`・`app.css`・`index.d.ts`・`docs/PLUGIN_UI.md` をそろえてください。

- 位置や大きさなど、使う場所だけの調整は `class` を渡し、使う側の `<style>` で `:global(.xxx)` を使って書く
- クラス名の規約: 部品は `.part`、部品の中は `.part-child`、状態は `.part-state`（例: `.toggle-on`）

| 部品 | グローバルクラス | 使い方 |
| --- | --- | --- |
| `Icon` | `.icon` | `<Icon icon="dice-5" size={18} />`。`icon` はアイコンの名前か Svelte の部品（下を参照）。`label` で読み上げ用の名前 |
| `Button` | `.btn`（`.primary` / `.danger` / `.ghost` / `.btn-icon-only`） | `<Button variant="primary" icon={Upload} onclick={...}>配布</Button>`。`variant="ghost"` は枠も背景もなく、ホバーで背景に色が付く。`type` の既定は `button`（フォームの送信は `type="submit"`）。中身なしで `icon` だけならアイコンだけの正方形のボタンで、`label`（aria-label）が必須 |
| `IconButton` | `.icon-btn`（`.active`） | `<IconButton label="閉じる" icon={X} onclick={...} />` か、中身にアイコンを書く。枠のないアイコンだけのボタン。`label` は aria-label |
| `SegmentedButton` | `.segmented` / `.segmented-option`（`-selected`） | `<SegmentedButton label="テーマ" options={[{ value, label, icon? }]} value={...} onchange={...} />`（`bind:value` も可） |
| `NavBar` | `.nav-bar` / `.nav-bar-item`（`-selected`） / `-item-icon` / `-item-badge` / `-item-label` | `<NavBar items={[{ id, label, icon, badge? }]} selected={...} onselect={...} />`。本体の下のナビゲーション（`components/NavBar.svelte`）が使う |
| `Divider` | `.divider` | `<Divider />`。横の区切り線（`<hr>`） |
| `Toggle` | `.toggle` / `.toggle-thumb`（`.toggle-on`） | `<Toggle bind:checked label="有効" onchange={...} />`。`<button role="switch">` |
| `Slider` | `.slider` / `.slider-input` / `.slider-value` | `<Slider label="マイクの音量" min={0} max={200} step={5} value={v} format={(v) => `${v}%`} oninput={...} onchange={...} />`。範囲のスライダー。`oninput` は動かしている間、`onchange` は離したとき。`disabled` も使える |
| `TextInput` | `.input` | `<TextInput bind:value placeholder="..." />`。ほかの属性はそのまま `<input>` に渡る |
| `Section` | `.setting-section` / `.setting-section-divider` / `.setting-section-title` | `<Section title="通知">...</Section>`。区切り線（Divider。前にもセクションがあるときだけ出る） + 見出し。中身の縦の間隔は 10px |
| `SettingRow` | `.setting-row` / `-icon` / `-info` / `-name` / `-description` / `-control` | `<SettingRow name="..." description="..." icon="...">{#snippet control()}<Toggle ... />{/snippet}</SettingRow>`。`icon` は任意。`onclick` を渡すと行全体が ghost ボタンになる（`.setting-row-button`。読み上げの名前は `name`、`control` は飾りだけにする） |
| `StatusLine` | `.status-line`（`-muted` / `-ok` / `-accent` / `-warn` / `-error`） | `<StatusLine kind="ok" icon={CircleCheck}>最新です</StatusLine>`。`busy` で回るアイコン |
| `Menu` / `MenuItem` | `.menu` / `.menu-backdrop` / `.menu-item`（`.menu-item-danger`） | `<Menu class="..." onclose={...}><MenuItem icon={Paperclip} onclick={...}>添付</MenuItem></Menu>`。位置は使う側で決める。`icon` は名前でもよい |
| `SuggestList` | `.suggest-list` / `.suggest-list-item`（`-selected`） / `-item-title` / `-item-detail` | 入力欄の補完候補。下を参照 |
| `SortableList` | `.sortable-list`（中の `.sortable-list-item` / `-grip` / `-body` は部品の中で書く） | `<SortableList items={...} getId={...} getLabel={...} onmove={(id, to) => ...}>{#snippet row(item)}...{/snippet}</SortableList>`。左のつまみをドラッグ（上下キーでも動かせる）。ほかの行が空きへ滑って、入る位置が見える。並びの保存は `onmove` で親が行う。本体だけの部品で、プラグインの `disnans.ui` には出さない |
| `Modal` | `.modal-scrim` / `.modal` / `.modal-title` / `.modal-actions` | `<Modal title="..." onclose={...}>...</Modal>`。ボタンの並びは `.modal-actions` |

ほかのグローバルクラス: `.field-label`（入力欄の上の小さな見出し）、`.muted`、`.scroll`、`.badge`、`.kbd`（キーボードのキー）、`.spin`、`.sr-only`、`.top-bar`。

## アイコン

アイコンは `src/lib/icons.svelte.ts` の登録簿で名前から引きます: 本体の独自のもの（`disnans-logo`: アプリのロゴ）→
プラグインが登録したもの（`addIcon`、プラグインの `icon.svg` は `plugin:<id>`）→ Lucide（`message-circle` など）。
Lucide の一覧（`lucide` パッケージ）は、名前で初めて引いたときに別のチャンクで読み込みます。

- 本体の画面では、これまでどおり `@lucide/svelte/icons/xxx` の部品を `icon={X}` で渡すのが基本です（すぐに描け、使う分だけがバンドルに入る）
- 名前（文字列）は、プラグインが指定したアイコンや `disnans-logo` に使います
- DOM で作るときは `createIcon(name, { size, class, label })`、既存の `<svg>` を描き直すときは `fillIcon(el, name)`

## SuggestList

候補の配列と、候補1つ分の中身（snippet）を渡します。キー操作は、入力欄の `keydown` から `keydown()` を呼びます
（上下・Enter・Tab・Esc を処理したら `true`）。

```svelte
<SuggestList bind:this={list} bind:index items={users} key={(u) => u.id} label="メンション" onpick={pick} onclose={close}>
  {#snippet item(u)}
    <span class="suggest-list-item-title">{u.display_name}</span>
    <span class="suggest-list-item-detail">{u.login_name}</span>
  {/snippet}
</SuggestList>
```

```ts
function onkeydown(e: KeyboardEvent) {
  if (open && list?.keydown(e)) return;
  // ...
}
```
