<script lang="ts">
  // 見た目はグローバルの .toggle（app.css）。プラグイン向けの ui.toggle も同じ DOM を作る
  let {
    checked = $bindable(false),
    label,
    disabled = false,
    class: className = '',
    onchange,
  }: {
    checked?: boolean;
    /** 読み上げ用の名前。見える名前は SettingRow などで横に出す */
    label?: string;
    disabled?: boolean;
    class?: string;
    onchange?: (checked: boolean) => void;
  } = $props();

  function toggle() {
    checked = !checked;
    onchange?.(checked);
  }
</script>

<button
  type="button"
  class="toggle {className}"
  class:toggle-on={checked}
  role="switch"
  aria-checked={checked}
  aria-label={label}
  {disabled}
  onclick={toggle}
>
  <span class="toggle-thumb"></span>
</button>
