# UI 部品

本体の画面で使い回す小さな部品です。**見た目の正はグローバルの CSS クラス（`src/app.css`）** で、
ここの Svelte コンポーネントはそのクラスを付けるだけの薄い包みです。
プラグイン向けの DOM 部品（`packages/plugin-sdk` の `Ui`）も、同じクラスを付けた要素を作れば同じ見た目になります。

- 位置や大きさなど、使う場所だけの調整は `class` を渡し、使う側の `<style>` で `:global(.xxx)` を使って書く
- クラス名の規約: 部品は `.part`、部品の中は `.part-child`、状態は `.part-state`（例: `.toggle-on`）

| 部品 | グローバルクラス | 使い方 |
| --- | --- | --- |
| `Button` | `.btn`（`.primary` / `.danger`） | `<Button variant="primary" onclick={...}>保存</Button>`。`type` の既定は `button`（フォームの送信は `type="submit"`） |
| `IconButton` | `.icon-btn`（`.active`） | `<IconButton label="閉じる" onclick={...}><X size={18} /></IconButton>`。`label` は aria-label |
| `Toggle` | `.toggle` / `.toggle-thumb`（`.toggle-on`） | `<Toggle bind:checked label="有効" onchange={...} />`。`<button role="switch">` |
| `TextInput` | `.input` | `<TextInput bind:value placeholder="..." />`。ほかの属性はそのまま `<input>` に渡る |
| `Section` | `.setting-section` / `.setting-section-title` | `<Section title="通知">...</Section>`。見出し + 区切り線。中身の縦の間隔は 10px |
| `SettingRow` | `.setting-row` / `-info` / `-name` / `-description` / `-control` | `<SettingRow name="..." description="...">{#snippet control()}<Toggle ... />{/snippet}</SettingRow>` |
| `StatusLine` | `.status-line`（`-muted` / `-ok` / `-accent` / `-warn` / `-error`） | `<StatusLine kind="ok" icon={CircleCheck}>最新です</StatusLine>`。`busy` で回るアイコン |
| `Menu` / `MenuItem` | `.menu` / `.menu-backdrop` / `.menu-item`（`.menu-item-danger`） | `<Menu class="..." onclose={...}><MenuItem icon={Paperclip} onclick={...}>添付</MenuItem></Menu>`。位置は使う側で決める |
| `SuggestList` | `.suggest-list` / `.suggest-list-item`（`-selected`） / `-item-title` / `-item-detail` | 入力欄の補完候補。下を参照 |
| `Modal` | `.modal-scrim` / `.modal` / `.modal-title` / `.modal-actions` | `<Modal title="..." onclose={...}>...</Modal>`。ボタンの並びは `.modal-actions` |

ほかのグローバルクラス: `.field-label`（入力欄の上の小さな見出し）、`.muted`、`.scroll`、`.badge`、`.spin`、`.sr-only`、`.top-bar`。

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
