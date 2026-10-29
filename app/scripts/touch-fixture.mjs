// touch-check 用の fixture。Tauri の IPC 境界（window.__TAURI_INTERNALS__ と __DISNANS_PLATFORM__）だけを、
// ページの読み込み前に差し込む（CDP の Page.addScriptToEvaluateOnNewDocument）。本体のコードには test mode の分岐を入れない。
// 実サーバーへつながる経路は無い。共有フォルダの一覧だけは、本体どおり fetch で仮のサーバー（touch-check.mjs が立てる）へ向かう。

/**
 * 意図して無視する IPC（コマンド名 → 理由）。ここに無い未対応のコマンドは touch-check が失敗扱いにする。
 * 本体が起動時などに新しい IPC を呼ぶようになったら、handlers に戻り値を足すか、理由を付けてここへ足す。
 */
export const IGNORED_IPC = {};

/** ページへ差し込むスクリプト。未対応のコマンドは window.__ipcUnknown に溜めて null を返す */
/**
 * platform: 'linux'（デスクトップ。既定）か 'android'。同じ実機の状態だけを作る（linux で desktop:false のような、ありえない状態は作らない）。
 * 'android' の IPC は、確認で呼ばれるものを具体的な戻り値で足す（未知の IPC は無視しない）。
 */
export function fixtureScript({ server, ignored = Object.keys(IGNORED_IPC), platform = 'linux' }) {
  const me = { id: 'u1', name: 'touch-check', login_name: 'touch-check', avatar_url: null };
  return `(() => {
  const IGNORED = ${JSON.stringify(ignored)};
  const SERVER = ${JSON.stringify(server)};
  const ME = ${JSON.stringify(me)};
  const PLATFORM = ${JSON.stringify(platform)};
  window.__DISNANS_PLATFORM__ = PLATFORM === 'android' ? {
    os: 'android', desktop: false, android: true,
    capabilities: { sharedStorage: true, rustApi: true, rustChat: 'default', bodyMode: 'base64', notifyBackend: 'android', updater: 'android', nativeAudioOutput: true, backgroundService: true, nativeScreen: 'android', devFolder: false },
  } : {
    os: 'linux', desktop: true, android: false,
    capabilities: { sharedStorage: true, rustApi: true, rustChat: 'default', bodyMode: 'raw', notifyBackend: 'desktop', updater: 'desktop', nativeAudioOutput: false, backgroundService: false, nativeScreen: null, devFolder: false },
  };
  window.__ipcUnknown = [];
  const store = { server: SERVER };
  const PREFS = () => (PLATFORM === 'android' ? { raw: {}, view: { navBarItems: ['app:open-chat', 'app:open-files', 'app:open-settings'] } } : { raw: {}, view: {} });
  const handlers = {
    api_me: () => ME,
    api_users: () => [ME],
    // Android は、ナビバーから共有フォルダを開く（ホットキーのコマンドパレットは Android では使えない）
    api_prefs: () => PREFS(),
    api_messages: () => [],
    api_search_messages: () => [],
    api_read_markers: () => [],
    api_plugins: () => [],
    api_session: () => null,
    client_device_id: () => 'touch-check-device',
    api_device_register: () => null,
    api_device_prefs_read: () => ({ prefs: {}, updatedAt: null, saved: false }),
    api_device_prefs_write: () => ({ prefs: {}, updatedAt: null, saved: false }),
    api_devices_list: () => [],
    // イベント: 購読 ID を返すだけ（このテストはイベントを流さない）
    'plugin:event|listen': () => 0,
    'plugin:event|unlisten': () => null,
    'plugin:event|emit': () => null,
    'plugin:event|emit_to': () => null,
    // クリップボードは空（貼り付けの可否の確認で読まれる）
    'plugin:clipboard-manager|read_text': () => '',
    'plugin:clipboard-manager|read_image': () => { throw 'no image'; },
    'plugin:resources|close': () => null,
    // Android の起動時に呼ばれるもの（戻り値は、何も起きていない状態）
    'plugin:system-bars|set_navigation_bar_hidden': () => null,
    'plugin:system-bars|set_style': () => null,
    'plugin:notifier|diag_log': () => null,
    'plugin:notifier|register_listener': () => null,
    'plugin:notifier|take_shared': () => null,
    'plugin:notifier|take_launch_target': () => null,
    'plugin:notifier|set_orientation': () => null,
    'plugin:notifier|clipboard_peek': () => ({ text: false, image: false }), // Android のクリップボードは空
    'plugin:notifier|clipboard_text': () => null,
    api_set_prefs: () => PREFS(),
    // 接続の成功を、チャットの Channel へ流す（本体の接続の流れをそのまま通す）
    // 本物のサーバーは files.changed を流す。仮のサーバーが溜めた変更を、チャットの Channel の event として流す
    chat_start: ({ args }) => {
      const ch = args.onItem;
      setTimeout(() => ch.onmessage({ kind: 'connected', generation: 1, me: ME, users: [ME] }), 30);
      let since = 0;
      setInterval(async () => {
        try {
          const r = await (await fetch(SERVER + '/__test/events?since=' + since)).json();
          since = r.next;
          for (const path of r.paths) ch.onmessage({ kind: 'event', generation: 1, event: { type: 'files.changed', path } });
        } catch { /* 仮のサーバーが止まったら何もしない */ }
      }, 100);
      return null;
    },
    'plugin:app|version': () => '999.0.0', // 新しい版の通知（トースト）を出さない
    'plugin:updater|check': () => null,
    // 共有の設定: 接続先だけ持ち、下書きは無い
    client_storage_read: ({ key }) => (JSON.stringify(key).toLowerCase().includes('draft') ? { state: 'missing' } : { state: 'value', value: SERVER }),
    client_storage_write: () => ({ state: 'missing' }),
    client_storage_import: ({ args }) => (JSON.stringify(args.key).toLowerCase().includes('draft') ? { state: 'missing' } : { state: 'value', value: SERVER }),
  };
  let cbSeq = 0;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    plugins: {},
    transformCallback: (cb) => { const id = ++cbSeq; window['_' + id] = cb; return id; },
    unregisterCallback: (id) => { delete window['_' + id]; },
    convertFileSrc: (p) => p,
    invoke: async (cmd, args) => {
      (window.__ipcLog ||= []).push(cmd);
      if (cmd in handlers) return handlers[cmd](args);
      if (!IGNORED.includes(cmd)) window.__ipcUnknown.push(cmd);
      return null;
    },
  };
})();`;
}
