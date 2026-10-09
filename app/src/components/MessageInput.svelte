<script lang="ts">
  import { tick } from 'svelte';
  import Avatar from './Avatar.svelte';
  import SuggestList from './ui/SuggestList.svelte';
  import Icon from './ui/Icon.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { bodyToDraft, draftToBody } from '../lib/mentions';
  import { applySuggestion, findSuggestion, type SuggestItem, type SuggestProvider, type Suggestion } from '../lib/suggest';
  import { mentionProvider } from '../lib/suggest/mention';
  import { emojiProvider } from '../lib/suggest/emoji';
  import { commandHint, slashProvider } from '../lib/suggest/slash';
  import { slashCommands } from '../lib/slashCommands.svelte';
  import { isAndroid } from '../lib/config';

  let {
    initial = '',
    placeholder = '',
    enterSends = true,
    maxHeight = 240,
    onsubmit,
    oncancel,
    onfiles,
    onarrowupempty,
    oninput,
    commands = false,
  }: {
    initial?: string;
    placeholder?: string;
    enterSends?: boolean;
    maxHeight?: number;
    onsubmit?: () => void;
    oncancel?: () => void;
    onfiles?: (files: File[]) => void;
    onarrowupempty?: () => void;
    oninput?: (text: string) => void;
    /** 先頭の `/` でコマンドを補完する（送る側の入力欄だけ。編集では出さない） */
    commands?: boolean;
  } = $props();

  const mentionMap = new Map<string, string>();
  // svelte-ignore state_referenced_locally
  let text = $state(bodyToDraft(initial, client.users, mentionMap));
  let ta: HTMLTextAreaElement | undefined = $state();
  let suggest = $state<(Suggestion & { index: number }) | null>(null);
  let suggestList: SuggestList<SuggestItem> | undefined = $state();

  // 補完の出どころ。先に合ったものを出す
  // svelte-ignore state_referenced_locally
  const providers: SuggestProvider[] = [
    ...(commands ? [slashProvider(() => slashCommands.list)] : []),
    mentionProvider(
      () => client.userList,
      (u) => mentionMap.set(u.display_name, u.id),
    ),
    emojiProvider(),
  ];
  /** `/コマンド ` まで打ったときに出す、引数の書き方 */
  const hint = $derived(commands && !suggest ? commandHint(text, slashCommands.list) : null);

  export function getBody(): string {
    return draftToBody(text, mentionMap).trim();
  }
  export function getText(): string {
    return text;
  }
  export function clear(): void {
    text = '';
    mentionMap.clear();
    suggest = null;
    void tick().then(resize);
  }
  export function focus(): void {
    ta?.focus();
  }

  function resize() {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, maxHeight) + 'px';
  }

  $effect(() => {
    void text;
    resize();
  });

  function updateSuggest() {
    if (!ta) return;
    const s = findSuggestion(providers, text, ta.selectionStart);
    suggest = s && { ...s, index: 0 };
  }

  /** IME で変換中（compositionstart〜compositionend）か */
  let composing = false;
  /** 候補を選ぶために、こちらから入力欄のフォーカスを外している間 */
  let picking = false;

  function pick(it: SuggestItem) {
    if (!suggest || !ta) return;
    const start = suggest.start;
    // IME が打っている途中の文字（`:sa` の `sa` など）を変換中のまま値を書き換えると、
    // IME（とくに Android の Gboard）は変換中の文字を覚えたままなので、あとで確定したときに `:sa` が戻ってくる。
    // フォーカスを一度外すと、ブラウザが変換を今の文字のまま確定させ、IME にも入力のやり直し（restartInput）が伝わる。
    // Android は compositionstart が来ないまま変換中の範囲を作ることがあるので、いつも外す
    if (composing || isAndroid()) {
      picking = true;
      ta.blur();
      composing = false;
    }
    // 確定で値やキャレットが変わることがあるので、外したあとの値から置き換える
    const value = ta.value;
    const next = applySuggestion(value, { start, end: Math.max(start, ta.selectionStart) }, it.insert);
    text = next.text;
    // フォーカスを戻す前に値を入れておく（IME が古い値を見ないように）
    ta.value = next.text;
    it.picked?.();
    suggest = null;
    oninput?.(text);
    // 同じ処理の中で戻すので、キーボードは閉じない
    ta.focus();
    ta.setSelectionRange(next.caret, next.caret);
    picking = false;
    // コマンド名のあとの引数の候補など、続けて出せるものがあれば出す
    updateSuggest();
  }

  function onkeydown(e: KeyboardEvent) {
    // IME 変換中の Enter は確定なので触らない
    if (e.isComposing || e.keyCode === 229) return;
    // 候補が出ているときは、上下・Enter・Tab・Esc を候補の操作に使う
    if (suggest && suggestList?.keydown(e)) return;
    if (e.key === 'Enter' && enterSends && !e.shiftKey) {
      e.preventDefault();
      onsubmit?.();
      return;
    }
    if (e.key === 'Escape' && oncancel) {
      e.preventDefault();
      oncancel();
      return;
    }
    if (e.key === 'ArrowUp' && text === '' && onarrowupempty) {
      e.preventDefault();
      onarrowupempty();
    }
  }

  function onpaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length && onfiles) {
      e.preventDefault();
      onfiles(files);
    }
  }
</script>

<div class="message-input">
  {#if suggest}
    <SuggestList
      bind:this={suggestList}
      bind:index={suggest.index}
      class="message-input-suggestions"
      label={suggest.label}
      items={suggest.items}
      key={(it) => it.key}
      onpick={pick}
      onclose={() => (suggest = null)}
    >
      {#snippet item(it)}
        {#if it.user}
          <Avatar user={it.user} id={it.user.id} size={22} />
        {:else if it.emoji}
          <span class="message-input-suggest-emoji">{it.emoji}</span>
        {:else if it.icon}
          <!-- コマンドのアイコン。絵文字・アバターと同じ幅にそろえる -->
          <span class="message-input-suggest-icon"><Icon icon={it.icon} size={18} /></span>
        {/if}
        <span class="suggest-list-item-title">{it.title}</span>
        {#if it.detail}
          <span class="suggest-list-item-detail">{it.detail}</span>
        {/if}
      {/snippet}
    </SuggestList>
  {:else if hint}
    <div class="message-input-hint" role="status">
      <span class="message-input-hint-name">/{hint.name}</span>
      {#if hint.args}<span class="message-input-hint-args">{hint.args}</span>{/if}
      <span class="message-input-hint-description">{hint.description}</span>
    </div>
  {/if}
  <textarea
    class="message-input-textarea"
    bind:this={ta}
    bind:value={text}
    rows="1"
    {placeholder}
    {onkeydown}
    {onpaste}
    oninput={() => {
      updateSuggest();
      oninput?.(text);
    }}
    onclick={updateSuggest}
    onkeyup={(e) => {
      // キャレットだけを動かしたときも、補完を出し直す
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateSuggest();
    }}
    oncompositionstart={() => (composing = true)}
    oncompositionend={() => (composing = false)}
    onblur={() => {
      // 候補を選ぶために外したときは、続けて出す候補を消さない
      if (!picking) setTimeout(() => (suggest = null), 150);
    }}
    enterkeyhint={enterSends ? 'send' : 'enter'}
  ></textarea>
</div>

<style>
  .message-input {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
  }
  .message-input-textarea {
    flex: 1;
    min-width: 0;
    resize: none;
    border: none;
    outline: none;
    background: transparent;
    padding: 8px 4px;
    line-height: 1.5;
    max-height: 40vh;
    scrollbar-width: thin;
  }
  .message-input-textarea::placeholder {
    color: var(--text-muted);
    opacity: 0.8;
  }
  /* 候補の見た目は .suggest-list（app.css）。ここでは入力欄の上に出す位置だけを決める。
     基準は近くの position の付いた要素（ふつうは .message-input）。使う側が .message-input を static にすると、
     その外側の枠いっぱいに広げられる。左右のはみ出しは --message-input-suggest-inset で変えられる */
  .message-input > :global(.message-input-suggestions),
  .message-input-hint {
    position: absolute;
    left: var(--message-input-suggest-inset, -8px);
    right: var(--message-input-suggest-inset, -8px);
    bottom: calc(100% + 10px);
  }
  .message-input-suggest-icon {
    display: grid;
    place-items: center;
    width: 22px;
    flex: none;
    color: var(--text-muted);
  }
  .message-input-suggest-emoji {
    width: 22px;
    font-size: 18px;
    line-height: 1;
    text-align: center;
  }
  /* コマンドの引数の書き方。候補の一覧と同じ位置に、小さく出す */
  .message-input-hint {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    font-size: 13px;
    pointer-events: none;
    z-index: 20;
  }
  .message-input-hint-name {
    font-weight: 600;
  }
  .message-input-hint-args {
    color: var(--accent);
  }
  .message-input-hint-description {
    min-width: 0;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
