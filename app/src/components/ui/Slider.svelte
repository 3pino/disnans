<script lang="ts">
  // 範囲のスライダー（ネイティブの input[type=range]）。値は min〜max の数（例: 音量は 0〜200 の％）。
  // 見た目はグローバルの .slider（app.css）。右に今の値を format で出す。
  // oninput は動かしている間、onchange は離したときに呼ぶ（保存は離したときにする、など）
  let {
    value = $bindable(0),
    min = 0,
    max = 100,
    step = 1,
    label,
    format = (v: number) => String(v),
    disabled = false,
    class: className = '',
    oninput,
    onchange,
  }: {
    value?: number;
    min?: number;
    max?: number;
    step?: number;
    /** 読み上げ用の名前（aria-label）。見える名前は SettingRow などで横に出す */
    label: string;
    /** 右に出す値の書き方（既定は数のまま）。例: (v) => `${v}%` */
    format?: (v: number) => string;
    disabled?: boolean;
    class?: string;
    oninput?: (value: number) => void;
    onchange?: (value: number) => void;
  } = $props();

  function onInput(e: Event & { currentTarget: HTMLInputElement }) {
    value = Number(e.currentTarget.value);
    oninput?.(value);
  }

  function onChange(e: Event & { currentTarget: HTMLInputElement }) {
    onchange?.(Number(e.currentTarget.value));
  }
</script>

<div class="slider {className}">
  <input
    type="range"
    class="slider-input"
    {min}
    {max}
    {step}
    {value}
    {disabled}
    aria-label={label}
    aria-valuetext={format(value)}
    oninput={onInput}
    onchange={onChange}
  />
  <span class="slider-value">{format(value)}</span>
</div>
