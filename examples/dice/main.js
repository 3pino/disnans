// @ts-check
/// <reference path="../../packages/plugin-sdk/index.d.ts" />

/*
 * ダイス: disnans プラグインの最初の実例。
 *
 * 1. `/dice 2d6` と打つと、セッションを作り（チャットにカードが流れる）、パネルを開く
 * 2. 振れるのは `/dice` を打った人だけ、1回だけ。[振る] を押すと結果が全員に同期し、カードが書き換わる
 * 3. ほかの人はカードをタップすると、パネルで結果を見られる
 */

const { Plugin } = disnans;

/** state の形が変わったら上げる（古いセッションを開いたときの見分けに使う） */
const SCHEMA = 1;

const MIN_COUNT = 1;
const MAX_COUNT = 20;
const MIN_SIDES = 2;
const MAX_SIDES = 1000;

/**
 * セッションの state。
 * @typedef {object} DiceState
 * @property {number} schema   state のスキーマのバージョン
 * @property {string} spec     "2d6" のような表記
 * @property {number} count    サイコロの個数
 * @property {number} sides    面の数
 * @property {string} roller   振れる人（`/dice` を打った人）のユーザー ID
 * @property {number[] | null} result  出た目。振る前は null
 */

/** @typedef {Disnans.Session<DiceState>} DiceSession */

/** 補完に出す候補 */
const PRESETS = [
  { value: '1d6', description: 'サイコロ1個' },
  { value: '2d6', description: 'サイコロ2個' },
  { value: '3d6', description: 'サイコロ3個' },
  { value: '1d4', description: '4面' },
  { value: '1d8', description: '8面' },
  { value: '1d10', description: '10面' },
  { value: '1d12', description: '12面' },
  { value: '1d20', description: '20面' },
  { value: '1d100', description: '100面' },
];

export default class DicePlugin extends Plugin {
  onload() {
    this.addSlashCommand({
      name: 'dice',
      description: 'サイコロを振る',
      args: '[個数]d[面数]',
      suggestArgs: (input) => {
        const q = input.trim().toLowerCase();
        return PRESETS.filter((p) => p.value.startsWith(q));
      },
      run: (ctx) => this.prepare(ctx.args, ctx.threadId),
    });

    // type をプラグイン ID と同じ 'dice' にすると、カードをタップしたときにこの view で開く
    this.registerView('dice', (/** @type {DiceSession} */ session) => new DiceView(this, session));
  }

  onunload() {
    // add* / register* で登録したものは自動で片付くので、ここでやることはない
  }

  /**
   * `/dice` が送信されたとき。セッションを作り、パネルを開く。
   * @param {string} args
   * @param {string | null} threadId
   */
  async prepare(args, threadId) {
    const parsed = parseSpec(args);
    if ('error' in parsed) {
      disnans.ui.toast(parsed.error, 'error');
      return;
    }
    const { count, sides } = parsed;
    const spec = `${count}d${sides}`;
    const me = this.app.me;

    /** @type {DiceState} */
    const state = { schema: SCHEMA, spec, count, sides, roller: me.id, result: null };
    const session = await this.sessions.create({
      state,
      card: { title: 'ダイス', text: `${this.app.nameOf(me.id)} がサイコロ（${spec}）を用意しました` },
      threadId,
    });
    this.openView('dice', session);
  }
}

/**
 * パネルに出す画面。
 * @implements {Disnans.View}
 */
class DiceView {
  /**
   * @param {DicePlugin} plugin
   * @param {DiceSession} session
   */
  constructor(plugin, session) {
    this.plugin = plugin;
    this.session = session;
    this.title = 'ダイス';
    /** @type {HTMLElement | null} */
    this.el = null;
    /** 振っている最中（保存を待っている間）は true */
    this.rolling = false;
    /** @type {Disnans.Cleanup | null} */
    this.unsubscribe = null;
  }

  /** @param {HTMLElement} containerEl */
  onOpen(containerEl) {
    this.el = containerEl;
    // 他の人（や自分）が振ったら描き直す
    this.unsubscribe = this.session.onChange(() => this.render());
    this.render();
  }

  onClose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.el = null;
  }

  render() {
    const el = this.el;
    if (!el) return;
    const { app } = this.plugin;
    const state = this.session.state;

    const root = h('div', 'dice-view');

    if (state.schema !== SCHEMA) {
      root.append(h('p', 'dice-status muted', 'このセッションは新しい版のダイスで作られたため、表示できません。'));
      el.replaceChildren(root);
      return;
    }

    const rollerName = app.nameOf(state.roller);
    root.append(h('div', 'dice-spec', state.spec));

    // サイコロの目。振る前は「?」
    const faces = h('div', 'dice-faces');
    for (let i = 0; i < state.count; i++) {
      const value = state.result ? state.result[i] : null;
      const face = h('div', value === null ? 'dice-face dice-face-pending' : 'dice-face', value === null ? '?' : String(value));
      if (value !== null && state.sides > 1) {
        if (value === state.sides) face.classList.add('dice-face-max');
        if (value === 1) face.classList.add('dice-face-min');
      }
      faces.append(face);
    }
    root.append(faces);

    if (state.result) {
      if (state.count > 1) {
        root.append(h('div', 'dice-total', `合計 ${sum(state.result)}`));
      }
      root.append(h('p', 'dice-status muted', `${rollerName} が振りました`));
    } else if (state.roller === app.me.id) {
      const button = disnans.ui.button({
        text: this.rolling ? '振っています…' : '振る',
        variant: 'primary',
        disabled: this.rolling,
        onClick: () => this.roll(),
      });
      button.classList.add('dice-roll');
      root.append(button);
    } else {
      root.append(h('p', 'dice-status muted', `${rollerName} が振るのを待っています`));
    }

    el.replaceChildren(root);
  }

  /** [振る] を押したとき */
  async roll() {
    if (this.rolling) return;
    this.rolling = true;
    this.render();
    try {
      // ぶつかったら最新の state で考え直す（ダイスでは、ほぼ起きない）
      for (let attempt = 0; attempt < 3; attempt++) {
        const state = this.session.state;
        if (state.result || state.roller !== this.plugin.app.me.id) return; // もう振られている
        const result = rollDice(state.count, state.sides);
        try {
          await this.session.update(
            { ...state, result },
            { card: { title: 'ダイス', text: resultText(this.plugin.app.nameOf(state.roller), state.spec, result) } },
          );
          return;
        } catch (e) {
          // VersionConflictError のとき、session.state はすでに最新になっている
          if (!(e instanceof disnans.VersionConflictError)) throw e;
        }
      }
      disnans.ui.toast('ほかの更新とぶつかったため、振れませんでした', 'error');
    } catch (e) {
      console.error('[dice]', e);
      disnans.ui.toast('サイコロを振れませんでした', 'error');
    } finally {
      this.rolling = false;
      this.render();
    }
  }
}

// ---- 下回り ----

/**
 * "2d6" / "d20" / "" を読む。
 * @param {string} args
 * @returns {{ count: number, sides: number } | { error: string }}
 */
function parseSpec(args) {
  const text = args.trim().toLowerCase();
  if (text === '') return { count: 1, sides: 6 };
  const m = /^(\d*)d(\d+)$/.exec(text);
  if (!m) return { error: `「${args}」は読めません。/dice 2d6 のように「個数d面数」で書いてください` };
  const count = m[1] === '' ? 1 : Number(m[1]);
  const sides = Number(m[2]);
  if (count < MIN_COUNT || count > MAX_COUNT) {
    return { error: `サイコロの個数は ${MIN_COUNT}〜${MAX_COUNT} にしてください` };
  }
  if (sides < MIN_SIDES || sides > MAX_SIDES) {
    return { error: `面の数は ${MIN_SIDES}〜${MAX_SIDES} にしてください` };
  }
  return { count, sides };
}

/**
 * 1〜sides の目を count 個、偏りなく出す。
 * @param {number} count
 * @param {number} sides
 * @returns {number[]}
 */
function rollDice(count, sides) {
  const out = [];
  const buf = new Uint32Array(1);
  // 2^32 を sides で割り切れる範囲だけを使う（剰余の偏りをなくす）
  const limit = Math.floor(0x1_0000_0000 / sides) * sides;
  while (out.length < count) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) out.push((buf[0] % sides) + 1);
  }
  return out;
}

/** @param {number[]} xs */
function sum(xs) {
  return xs.reduce((a, b) => a + b, 0);
}

/**
 * カードの文言。「🎲 A: 2d6 → 3 + 5 = 8」
 * @param {string} name
 * @param {string} spec
 * @param {number[]} result
 */
function resultText(name, spec, result) {
  const detail = result.length === 1 ? String(result[0]) : `${result.join(' + ')} = ${sum(result)}`;
  return `🎲 ${name}: ${spec} → ${detail}`;
}

/**
 * 要素を作る小さな関数。
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
