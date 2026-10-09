// @ts-check
/// <reference path="../../packages/plugin-sdk/index.d.ts" />

/*
 * ダイス: disnans プラグインの実例。ホスト API をひととおり使っているので、作り方の見本として読める。
 *
 * できること:
 * 1. `/dice 2d6` と打つと、セッションを作り（チャットにカードが流れる）、パネルを開く
 *    （「＋」メニューの「サイコロ（2d6）」、ショートカット Ctrl+Shift+D、コマンドパレットからも用意できる）
 * 2. 振れるのは用意した人だけ、1回だけ。[振る] を押すと、見ている人の画面でもサイコロが揺れ、
 *    結果が全員に同期して、カードが書き換わる
 * 3. ほかの人はカードをタップすると、パネルで結果を見られる
 *
 * 使っている API（→ docs/PLUGINS.md）:
 * - onload / onunload ............................. DicePlugin
 * - loadData / saveData / addSettingTab ............ 「設定」の節（ui.setting / toggle / segmented / button / divider / confirm）
 * - addIcon ........................................ DIE_ICON（独自のアイコン）
 * - addCommand（icon・hotkey・slash・args・suggestArgs）... `/dice` と Ctrl+Shift+D（macOS では Cmd+Shift+D）
 * - addCommand（パレットだけ）........................ 「20面のサイコロを用意する」
 * - addComposerAction（Lucide のアイコン）........... 「＋」メニューの「サイコロ（2d6）」
 *   （addSlashCommand は addCommand の slash に置き換わったので使っていない。古いプラグインのために残っている）
 * - registerView / openView ........................ DiceView
 * - registerCardRenderer ........................... カードの見た目
 * - registerInterval / registerDomEvent ............ 演出のタイマー、裏に回ったときの後始末
 * - sessions.create / session.update（楽観ロック）/ onChange ... prepare / DiceView.roll
 * - session.emit / session.on ...................... 「振っています…」をほかの人に見せる
 * - View.title / View.icon / panel.setTitle / setIcon ... パネルの上部
 * - ui.navbar / ui.button（アイコン付き）/ ui.icon / ui.toast / ui.confirm ... DiceView
 */

const { Plugin, ui } = disnans;

// ---- 定数と型 ----

/** state の形が変わったら上げる（古いセッションを開いたときの見分けに使う） */
const SCHEMA = 1;

const MIN_COUNT = 1;
const MAX_COUNT = 20;
const MIN_SIDES = 2;
const MAX_SIDES = 1000;

/** 振っている演出の長さ（ミリ秒） */
const SHAKE_MS = 700;
/** 演出のコマ送りの間隔（ミリ秒） */
const TICK_MS = 80;
/** ほかの人の「振っています…」を受け取ってから、結果が来ないまま待つ長さの上限（ミリ秒） */
const SHAKE_TIMEOUT_MS = 5000;

/** 一時的なイベントの名前（session.emit / session.on） */
const EVENT_SHAKE = 'shake';

/** 独自のアイコンの名前。ほかのプラグインとぶつからないように、プラグイン ID を前に付ける */
const DIE_ICON = 'dice-cube';

/**
 * 立方体のサイコロ（24x24）。<svg> の中身だけを渡すと、既定は
 * fill="none" stroke="currentColor" stroke-width="2"（Lucide と同じ）になる。目は塗りつぶす
 */
const DIE_SVG = [
  '<path d="M12 2 21 7v10l-9 5-9-5V7z"/>',
  '<path d="m3 7 9 5 9-5M12 12v10"/>',
  '<g fill="currentColor" stroke="none">',
  '<circle cx="12" cy="7" r="1.3"/>',
  '<circle cx="5.9" cy="11.6" r="1.1"/><circle cx="9.1" cy="17.4" r="1.1"/>',
  '<circle cx="14.4" cy="13.4" r="1.1"/><circle cx="16.5" cy="14.5" r="1.1"/><circle cx="18.6" cy="15.6" r="1.1"/>',
  '</g>',
].join('');

/**
 * セッションの state（全員で共有する。サーバーに保存される）。
 * @typedef {object} DiceState
 * @property {number} schema   state のスキーマのバージョン
 * @property {string} spec     "2d6" のような表記
 * @property {number} count    サイコロの個数
 * @property {number} sides    面の数
 * @property {string} roller   振れる人（用意した人）のユーザー ID
 * @property {number[] | null} result  出た目。振る前は null
 */

/** @typedef {Disnans.Session<DiceState>} DiceSession */

/**
 * 設定（その端末にだけ保存する。loadData / saveData）。
 * @typedef {object} DiceSettings
 * @property {string} defaultSpec        `/dice` だけで送ったとき・ショートカットのサイコロ
 * @property {boolean} confirmBeforeRoll [振る] を押したときに確認する
 * @property {boolean} animate           出目の演出（揺れる・ぱっと出る）
 */

/** @type {Readonly<DiceSettings>} */
const DEFAULT_SETTINGS = Object.freeze({
  defaultSpec: '1d6',
  confirmBeforeRoll: false,
  animate: true,
});

/** 設定の「既定のサイコロ」に出す選択肢 */
const DEFAULT_SPEC_OPTIONS = ['1d6', '2d6', '3d6', '1d20', '1d100'];

/** `/dice` の補完に出す候補 */
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

// ---- プラグイン本体 ----

export default class DicePlugin extends Plugin {
  /** @type {DiceSettings} */
  settings = { ...DEFAULT_SETTINGS };
  /**
   * 開いている view（演出のタイマーから使う）
   * @type {Set<DiceView>}
   */
  openViews = new Set();

  // onload は async にしてよい。設定を読み終えてから登録する
  async onload() {
    this.settings = await this.loadSettings();

    // 独自のアイコン。以後、アイコン名を受け取るところならどこでも 'dice-cube' と書ける
    this.addIcon(DIE_ICON, DIE_SVG);

    // コマンド。コマンドパレット（Ctrl+P）と設定のショートカットの一覧に出る。
    // hotkey は既定のショートカット（デスクトップ。Mod は Ctrl、macOS では Cmd。利用者が設定で変えられる）、
    // slash を付けると入力欄の `/dice` にもなる。icon を省くとプラグインのアイコン（icon.svg）になる
    this.addCommand({
      id: 'roll',
      name: 'サイコロを用意する',
      icon: DIE_ICON,
      hotkey: 'Mod+Shift+D',
      slash: 'dice',
      description: 'サイコロを振る',
      args: '[個数]d[面数]',
      suggestArgs: (input) => {
        const q = input.trim().toLowerCase();
        return PRESETS.filter((p) => p.value.startsWith(q));
      },
      // ctx.args は `/dice 2d6` の「2d6」（ショートカット・パレットからは空 → 設定の既定のサイコロ）。
      // ctx.threadId は入力したスレッドか、ショートカット・パレットなら開いているスレッド
      run: (ctx) => this.prepare(ctx.args, ctx.threadId),
    });

    // ショートカットもスラッシュコマンドもないコマンドは、パレットから使う（利用者は設定でショートカットを付けられる）
    this.addCommand({
      id: 'roll-d20',
      name: '20面のサイコロを用意する',
      icon: 'dice-5',
      run: (ctx) => this.prepare('1d20', ctx.threadId),
    });

    // 入力欄の「＋」メニュー。アイコンは Lucide の名前で指定する
    this.addComposerAction({
      id: 'roll-2d6',
      label: 'サイコロ（2d6）',
      icon: 'dices',
      run: (ctx) => this.prepare('2d6', ctx.threadId),
    });

    // type をプラグイン ID と同じ 'dice' にすると、カードをタップしたときにこの view で開く
    this.registerView('dice', (/** @type {DiceSession} */ session) => new DiceView(this, session));

    // カードの見た目。プラグインがない・オフの人には標準のカード（title と text）が出るので、text だけで内容がわかるようにしておく
    this.registerCardRenderer((el, card) => renderCard(el, card));

    // 設定画面の「ダイス」の欄
    this.addSettingTab({
      display: (containerEl) => this.displaySettings(containerEl),
    });

    // 演出のコマ送り。タイマーはプラグインに1つだけ置き、registerInterval で登録して外すときに本体に止めてもらう
    this.registerInterval(window.setInterval(() => this.tick(), TICK_MS));

    // アプリが裏に回るとタイマーが間引かれ、演出が止まって見えるので、そこで演出を終える。
    // registerDomEvent で登録すると、外すときに本体が removeEventListener してくれる
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.hidden) for (const view of this.openViews) view.stopShaking();
    });
  }

  onunload() {
    // add* / register* で登録したものは自動で片付くので、ここでやることはない
  }

  /** 演出のタイマーから呼ばれる */
  tick() {
    for (const view of this.openViews) view.tick();
  }

  /**
   * サイコロを用意する（`/dice`・「＋」メニュー・ショートカットから）。セッションを作り、パネルを開く。
   * @param {string} args "2d6" など。空なら設定の既定のサイコロ
   * @param {string | null} threadId
   */
  async prepare(args, threadId) {
    const parsed = parseSpec(args.trim() === '' ? this.settings.defaultSpec : args);
    if ('error' in parsed) {
      ui.toast(parsed.error, 'error');
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

  // ---- 設定 ----

  /**
   * 保存した設定を読む。古い版で保存したものや壊れたものが混ざっていても、使える値だけを拾う。
   * @returns {Promise<DiceSettings>}
   */
  async loadSettings() {
    /** @type {Partial<Record<keyof DiceSettings, unknown>> | null} */
    const saved = await this.loadData();
    const s = { ...DEFAULT_SETTINGS };
    if (saved && typeof saved === 'object') {
      if (typeof saved.defaultSpec === 'string' && !('error' in parseSpec(saved.defaultSpec))) s.defaultSpec = saved.defaultSpec;
      if (typeof saved.confirmBeforeRoll === 'boolean') s.confirmBeforeRoll = saved.confirmBeforeRoll;
      if (typeof saved.animate === 'boolean') s.animate = saved.animate;
    }
    return s;
  }

  /**
   * 設定を1つ変えて保存する。
   * @template {keyof DiceSettings} K
   * @param {K} key
   * @param {DiceSettings[K]} value
   */
  async setSetting(key, value) {
    this.settings[key] = value;
    await this.saveData(this.settings);
  }

  /**
   * 設定タブを描く。表示のたびに空の containerEl で呼ばれる。
   * @param {HTMLElement} containerEl
   */
  displaySettings(containerEl) {
    const s = this.settings;

    // 横に並んだ選択肢（ui.segmented）
    ui.setting(containerEl, {
      name: '既定のサイコロ',
      description: '/dice だけで送ったときと、ショートカット（Ctrl+Shift+D）で用意するサイコロ',
      icon: DIE_ICON,
      control: ui.segmented({
        label: '既定のサイコロ',
        value: DEFAULT_SPEC_OPTIONS.includes(s.defaultSpec) ? s.defaultSpec : DEFAULT_SETTINGS.defaultSpec,
        options: DEFAULT_SPEC_OPTIONS.map((spec) => ({ value: spec, label: spec })),
        onChange: (value) => void this.setSetting('defaultSpec', value),
      }),
    });

    // トグル（ui.toggle）。見える名前は ui.setting の name、label は読み上げ用
    ui.setting(containerEl, {
      name: '振る前に確認する',
      description: '[振る] を押したときに、確認のダイアログを出す',
      icon: 'circle-help',
      control: ui.toggle({
        label: '振る前に確認する',
        value: s.confirmBeforeRoll,
        onChange: (value) => void this.setSetting('confirmBeforeRoll', value),
      }),
    });

    ui.setting(containerEl, {
      name: '出目の演出',
      description: 'サイコロが揺れてから目が出る。オフにすると、すぐに目が出る（ほかの人が振ったときも）',
      icon: 'sparkles',
      control: ui.toggle({
        label: '出目の演出',
        value: s.animate,
        onChange: (value) => void this.setSetting('animate', value),
      }),
    });

    containerEl.append(ui.divider());

    // 危ない操作は danger のボタンにして、ui.confirm で確かめる
    ui.setting(containerEl, {
      name: '設定を初期値に戻す',
      description: 'この端末のダイスの設定を、すべて最初の状態に戻す',
      icon: 'rotate-ccw',
      control: ui.button({
        text: '初期値に戻す',
        variant: 'danger',
        onClick: () => void this.resetSettings(containerEl),
      }),
    });
  }

  /**
   * 設定を初期値に戻す（確認してから）。
   * @param {HTMLElement} containerEl 描き直す設定タブ
   */
  async resetSettings(containerEl) {
    const ok = await ui.confirm({
      title: '設定を初期値に戻しますか？',
      body: '既定のサイコロ・振る前の確認・出目の演出が、最初の状態に戻ります。',
      okLabel: '初期値に戻す',
      danger: true,
    });
    if (!ok) return;
    this.settings = { ...DEFAULT_SETTINGS };
    await this.saveData(this.settings);
    // 部品は自分の値を覚えているので、描き直して見た目を合わせる
    containerEl.replaceChildren();
    this.displaySettings(containerEl);
    ui.toast('設定を初期値に戻しました');
  }
}

// ---- パネルに出す画面（view） ----

/**
 * セッション1つ分の画面。タブのバー（ui.navbar）で「結果」と「使い方」を切り替える。
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
    // パネルの上部の既定の題名とアイコン（あとから panel.setTitle / setIcon で変える）
    this.title = 'ダイス';
    this.icon = DIE_ICON;

    /**
     * 中身を描く場所（タブのバーの上）
     * @type {HTMLElement | null}
     */
    this.bodyEl = null;
    /** @type {Disnans.ViewPanel | null} */
    this.panel = null;
    /** @type {'result' | 'help'} */
    this.tab = 'result';
    /** 振っている最中（confirm から保存が終わるまで）は true。振る人の画面だけで使う */
    this.rolling = false;
    /** 揺れている演出をいつまで続けるか（Date.now() の値。0 なら揺れていない） */
    this.shakeUntil = 0;
    /**
     * 揺らしている人のユーザー ID
     * @type {string | null}
     */
    this.shaker = null;
    /**
     * 揺れている間の目の要素（tick で数字だけ書き換える）
     * @type {HTMLElement[]}
     */
    this.faceEls = [];
    /** 次の描画で、目を「ぱっと出す」演出をするか */
    this.reveal = false;
    /** @type {Disnans.Cleanup[]} */
    this.cleanups = [];
  }

  /**
   * @param {HTMLElement} containerEl
   * @param {Disnans.ViewPanel} panel
   */
  onOpen(containerEl, panel) {
    this.panel = panel;
    this.plugin.openViews.add(this);

    // 他の人（や自分）が更新したら描き直す。振る前 → 結果に変わったときは「ぱっと出す」
    let hadResult = this.session.state.result !== null;
    this.cleanups.push(
      this.session.onChange(() => {
        const hasResult = this.session.state.result !== null;
        if (hasResult && !hadResult) {
          this.reveal = this.plugin.settings.animate;
          this.shakeUntil = 0;
        }
        hadResult = hasResult;
        this.render();
      }),
    );

    // ほかの人の「振っています…」（保存しない一時的なイベント。自分の emit は自分には届かない）
    this.cleanups.push(
      this.session.on(EVENT_SHAKE, (_payload, from) => {
        const state = this.session.state;
        if (state.result || from.id !== state.roller) return; // 振る人以外・振ったあとのものは無視する
        this.startShaking(from.id, SHAKE_TIMEOUT_MS);
      }),
    );

    // 中身とタブのバー。バーは一度だけ作り、中身だけを描き直す
    const root = h('div', 'dice-view');
    this.bodyEl = h('div', 'dice-view-body');
    const nav = ui.navbar({
      label: 'ダイスのタブ',
      selected: this.tab,
      items: [
        { id: 'result', label: '結果', icon: DIE_ICON },
        { id: 'help', label: '使い方', icon: 'book-open' },
      ],
      onSelect: (id) => {
        this.tab = id === 'help' ? 'help' : 'result';
        this.render();
      },
    });
    root.append(this.bodyEl, nav);
    containerEl.replaceChildren(root);
    this.render();
  }

  onClose() {
    // onChange / on の購読は、閉じるときに自分で外す
    for (const off of this.cleanups) off();
    this.cleanups = [];
    this.plugin.openViews.delete(this);
    this.bodyEl = null;
    this.panel = null;
  }

  // ---- 描画 ----

  render() {
    const el = this.bodyEl;
    if (!el) return;
    this.faceEls = [];
    const state = this.session.state;

    if (state.schema !== SCHEMA) {
      this.panel?.setTitle(null);
      el.replaceChildren(h('p', 'dice-status muted', 'このセッションは新しい版のダイスで作られたため、表示できません。'));
      return;
    }

    this.updateHeader();
    el.replaceChildren(this.tab === 'help' ? this.renderHelp() : this.renderResult());
    this.reveal = false;
  }

  /** パネルの上部: 題名にサイコロの表記、振ったあとはアイコンを出目に合わせる */
  updateHeader() {
    const state = this.session.state;
    this.panel?.setTitle(`ダイス（${state.spec}）`);
    // 6面1個なら Lucide の dice-1〜dice-6、それ以外は dices。振る前は null で既定（this.icon）に戻す
    if (!state.result) this.panel?.setIcon(null);
    else if (state.count === 1 && state.sides === 6) this.panel?.setIcon(`dice-${state.result[0]}`);
    else this.panel?.setIcon('dices');
  }

  /** 「結果」タブ */
  renderResult() {
    const { app } = this.plugin;
    const state = this.session.state;
    const root = h('div', 'dice-result');
    const rollerName = app.nameOf(state.roller);
    const shaking = this.isShaking();
    const animate = this.plugin.settings.animate;

    root.append(h('div', 'dice-spec', state.spec));

    // サイコロの目。振る前は「?」、揺れている間はでたらめな数字
    const faces = h('div', 'dice-faces');
    for (let i = 0; i < state.count; i++) {
      const value = state.result ? state.result[i] : null;
      const face = h('div', 'dice-face');
      if (value !== null) {
        face.textContent = String(value);
        if (state.sides > 1 && value === state.sides) face.classList.add('dice-face-max');
        if (state.sides > 1 && value === 1) face.classList.add('dice-face-min');
        if (this.reveal) face.classList.add('dice-face-reveal');
      } else if (shaking && animate) {
        face.textContent = String(randomFace(state.sides));
        face.classList.add('dice-face-shaking');
        this.faceEls.push(face);
      } else {
        face.textContent = '?';
        face.classList.add('dice-face-pending');
      }
      faces.append(face);
    }
    root.append(faces);

    if (state.result) {
      if (state.count > 1) root.append(h('div', 'dice-total', `合計 ${sum(state.result)}`));
      root.append(h('p', 'dice-status muted', `${rollerName} が振りました`));
    } else if (state.roller === app.me.id) {
      // アイコン付きのボタン
      const button = ui.button({
        text: this.rolling ? '振っています…' : '振る',
        icon: 'dices',
        variant: 'primary',
        disabled: this.rolling,
        onClick: () => void this.roll(),
      });
      button.classList.add('dice-roll');
      root.append(button);
    } else if (shaking) {
      root.append(h('p', 'dice-status', `${app.nameOf(this.shaker ?? state.roller)} が振っています…`));
    } else {
      root.append(h('p', 'dice-status muted', `${rollerName} が振るのを待っています`));
    }
    return root;
  }

  /** 「使い方」タブ */
  renderHelp() {
    const root = h('div', 'dice-help');
    /** @type {[Disnans.IconName, string][]} */
    const items = [
      [DIE_ICON, '/dice 2d6 のように「個数d面数」で送ると、サイコロを用意します。数字を省くと設定の既定のサイコロ'],
      ['dices', '入力欄の「＋」メニューの「サイコロ（2d6）」でも用意できます'],
      ['hand', '振れるのは用意した人だけ、1回だけ。結果はみんなに同期します'],
      ['settings', '設定 → プラグイン → ダイス で、既定のサイコロや演出を変えられます'],
    ];
    // ショートカットはデスクトップだけ
    if (!this.plugin.app.isMobile) {
      items.splice(
        2,
        0,
        ['keyboard', 'Ctrl+Shift+D（macOS では Cmd+Shift+D）で、既定のサイコロを用意します。キーは 設定 → ショートカット で変えられます'],
        ['command', 'コマンドパレット（Ctrl+P）の「20面のサイコロを用意する」も使えます'],
      );
    }

    const list = h('ul', 'dice-help-list');
    for (const [icon, text] of items) {
      const li = h('li', 'dice-help-item');
      li.append(ui.icon(icon, { size: 18, class: 'dice-help-icon' }), h('span', undefined, text));
      list.append(li);
    }
    root.append(list, ui.divider(), h('p', 'dice-help-note muted', `ダイス ${this.plugin.manifest.version}`));
    return root;
  }

  // ---- 演出 ----

  /** @returns {boolean} */
  isShaking() {
    return this.shakeUntil > Date.now();
  }

  /**
   * 揺れている演出を始める。
   * @param {string} userId 揺らしている人
   * @param {number} ms 長さ
   */
  startShaking(userId, ms) {
    this.shaker = userId;
    this.shakeUntil = Date.now() + ms;
    this.render();
  }

  stopShaking() {
    if (this.shakeUntil === 0) return;
    this.shakeUntil = 0;
    this.render();
  }

  /** 演出のタイマーから呼ばれる。揺れている間は目の数字だけを書き換える */
  tick() {
    if (this.shakeUntil === 0) return;
    if (!this.isShaking()) {
      this.stopShaking(); // 時間切れ（結果が来なかった）
      return;
    }
    const { sides } = this.session.state;
    for (const face of this.faceEls) face.textContent = String(randomFace(sides));
  }

  // ---- 振る ----

  /** [振る] を押したとき */
  async roll() {
    if (this.rolling) return;
    const { settings, app } = this.plugin;

    // 設定でオンにしていれば、確認のダイアログを出す
    if (settings.confirmBeforeRoll) {
      const ok = await ui.confirm({
        title: `${this.session.state.spec} を振りますか？`,
        body: '振れるのは1回だけです。結果はみんなに見えます。',
        okLabel: '振る',
      });
      if (!ok) return;
    }

    this.rolling = true;
    // ほかの人の画面でも揺らす（保存しない一時的なイベント。自分には届かないので、自分の画面は自分で揺らす）
    this.session.emit(EVENT_SHAKE);
    if (settings.animate) this.startShaking(app.me.id, SHAKE_TIMEOUT_MS); // 結果が出たら onChange で止まる
    else this.render();
    try {
      if (settings.animate) await sleep(SHAKE_MS);
      await this.saveResult();
    } catch (e) {
      console.error('[dice]', e);
      ui.toast('サイコロを振れませんでした', 'error');
    } finally {
      this.rolling = false;
      this.shakeUntil = 0;
      // 振れたときは onChange で描き直し済み（もう一度描くと「ぱっと出す」演出が消える）
      if (!this.session.state.result) this.render();
    }
  }

  /** 目を決めて保存する。ほかの更新とぶつかったら、最新の state で考え直す（楽観ロック） */
  async saveResult() {
    const { app } = this.plugin;
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = this.session.state;
      if (state.result || state.roller !== app.me.id) return; // もう振られている
      const result = rollDice(state.count, state.sides);
      try {
        await this.session.update(
          { ...state, result },
          { card: { title: 'ダイス', text: resultText(app.nameOf(state.roller), state.spec, result) } },
        );
        return; // 成功すると onChange が呼ばれ、描き直される
      } catch (e) {
        // VersionConflictError のとき、session.state はすでに最新になっている。ループの頭で考え直す
        if (!(e instanceof disnans.VersionConflictError)) throw e;
      }
    }
    ui.toast('ほかの更新とぶつかったため、振れませんでした', 'error');
  }
}

// ---- カード ----

/**
 * チャットに流れるカードを描く（registerCardRenderer）。描けるのは title と text だけ。
 * el は本体のカードの枠の中で、呼ばれるたびに空になっている。
 * @param {HTMLElement} el
 * @param {Disnans.CardData} card
 */
function renderCard(el, card) {
  const head = h('div', 'dice-card-head');
  head.append(ui.icon(DIE_ICON, { size: 14 }), h('span', 'dice-card-title', card.title));
  // 結果のカード（「🎲 A: 2d6 → …」）は大きめに出す
  const done = card.text.startsWith('🎲');
  el.replaceChildren(head, h('div', done ? 'dice-card-text dice-card-done' : 'dice-card-text', card.text));
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
 * 1〜sides の目を count 個、偏りなく出す。結果を左右するので crypto.getRandomValues を使う。
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

/**
 * 演出用のでたらめな目（結果には使わない）。
 * @param {number} sides
 */
function randomFace(sides) {
  return Math.floor(Math.random() * sides) + 1;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
