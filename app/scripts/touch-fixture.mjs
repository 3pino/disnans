// touch-check 用の fixture。Tauri の IPC 境界（window.__TAURI_INTERNALS__ と __DISNANS_PLATFORM__）だけを、
// ページの読み込み前に差し込む（CDP の Page.addScriptToEvaluateOnNewDocument）。本体のコードには test mode の分岐を入れない。
// 実サーバーへつながる経路は無い。共有フォルダの一覧だけは、本体どおり fetch で仮のサーバー（touch-check.mjs が立てる）へ向かう。

/**
 * 意図して無視する IPC（コマンド名 → 理由）。ここに無い未対応のコマンドは touch-check が失敗扱いにする。
 * 本体が起動時などに新しい IPC を呼ぶようになったら、handlers に戻り値を足すか、理由を付けてここへ足す。
 */
export const IGNORED_IPC = {};

/** ページへ差し込むスクリプト。未対応のコマンドは window.__ipcUnknown に溜めて null を返す */
export function fixtureScript({ server, ignored = Object.keys(IGNORED_IPC) }) {
  const me = { id: 'u1', name: 'touch-check', login_name: 'touch-check', avatar_url: null };
  return `(() => {
  const IGNORED = ${JSON.stringify(ignored)};
  const SERVER = ${JSON.stringify(server)};
  const ME = ${JSON.stringify(me)};
  window.__DISNANS_PLATFORM__ = {
    os: 'linux', desktop: true, android: false,
    capabilities: { sharedStorage: true, rustApi: true, rustChat: 'default', bodyMode: 'raw', notifyBackend: 'desktop', updater: 'desktop', nativeAudioOutput: false, backgroundService: false, nativeScreen: null, devFolder: false },
  };
  window.__ipcUnknown = [];
  const store = { server: SERVER };
  const handlers = {
    api_me: () => ME,
    api_users: () => [ME],
    api_prefs: () => ({}),
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
    chat_start: () => null,
    'plugin:app|version': () => '0.0.0',
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
      if (cmd in handlers) return handlers[cmd](args);
      if (!IGNORED.includes(cmd)) window.__ipcUnknown.push(cmd);
      return null;
    },
  };
})();`;
}
