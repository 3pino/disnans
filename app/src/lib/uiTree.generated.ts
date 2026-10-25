// 自動生成（crates/client-core/src/view/ui.rs の SETTINGS_PAGES・NAV_ITEMS）。手で編集しない。
// 更新: cargo test -p disnans-client-core（scripts/check-rust.sh が差分を確かめる）。説明は docs/UI_TREE.md

import type { UiNavItem, UiPage } from './uiTree';

/** 設定のページ（先頭がトップ）。値は持たない（GUI は lib/settingsBindings.svelte.ts で差し込む） */
export const SETTINGS_PAGES: readonly UiPage[] = [
  {
    "id": "top",
    "title": "設定",
    "sections": [
      {
        "id": "profile",
        "title": "プロフィール",
        "items": [
          {
            "type": "slot",
            "id": "profile",
            "show": {
              "gui": "always",
              "tui": false
            }
          }
        ],
        "show": {
          "gui": "always",
          "tui": false
        }
      },
      {
        "id": "appearance",
        "title": "外観",
        "items": [
          {
            "type": "field",
            "id": "theme",
            "label": "テーマ",
            "icon": null,
            "key": "theme",
            "control": {
              "type": "segmented",
              "options": [
                {
                  "value": "system",
                  "label": "自動",
                  "icon": "monitor"
                },
                {
                  "value": "light",
                  "label": "ライト",
                  "icon": "sun"
                },
                {
                  "value": "dark",
                  "label": "ダーク",
                  "icon": "moon"
                }
              ]
            },
            "show": {
              "gui": "always",
              "tui": true
            }
          },
          {
            "type": "slot",
            "id": "customThemes",
            "show": {
              "gui": "always",
              "tui": false
            }
          },
          {
            "type": "field",
            "id": "orientation",
            "label": "画面の向き",
            "icon": null,
            "key": "orientation",
            "control": {
              "type": "select",
              "options": [
                {
                  "value": "portrait",
                  "label": "向きを固定",
                  "icon": null
                },
                {
                  "value": "media",
                  "label": "メディアのみ自動回転",
                  "icon": null
                },
                {
                  "value": "auto",
                  "label": "自動回転",
                  "icon": null
                }
              ]
            },
            "show": {
              "gui": "android",
              "tui": false
            }
          },
          {
            "type": "field",
            "id": "hideNavigationBar",
            "label": "ナビゲーションバーを隠す",
            "icon": null,
            "key": "hideNavigationBar",
            "control": {
              "type": "toggle"
            },
            "show": {
              "gui": "android",
              "tui": false
            }
          }
        ],
        "show": {
          "gui": "always",
          "tui": true
        }
      },
      {
        "id": "operations",
        "title": "操作",
        "items": [
          {
            "type": "link",
            "id": "enterKeys",
            "label": "入力欄のキー",
            "page": "enterKeys",
            "show": {
              "gui": "always",
              "tui": true
            }
          },
          {
            "type": "link",
            "id": "hotkeys",
            "label": "ホットキー",
            "page": "hotkeys",
            "show": {
              "gui": "notAndroid",
              "tui": false
            }
          },
          {
            "type": "link",
            "id": "tuiKeys",
            "label": "キー割り当て",
            "page": "tuiKeys",
            "show": {
              "gui": "never",
              "tui": true
            }
          },
          {
            "type": "link",
            "id": "navBar",
            "label": "ナビゲーションバー",
            "page": "navBar",
            "show": {
              "gui": "always",
              "tui": false
            }
          },
          {
            "type": "link",
            "id": "composerMenu",
            "label": "＋メニュー",
            "page": "composerMenu",
            "show": {
              "gui": "always",
              "tui": false
            }
          },
          {
            "type": "link",
            "id": "call",
            "label": "通話",
            "page": "call",
            "show": {
              "gui": "always",
              "tui": false
            }
          }
        ],
        "show": {
          "gui": "always",
          "tui": true
        }
      },
      {
        "id": "notifications",
        "title": "通知",
        "items": [
          {
            "type": "slot",
            "id": "notifications",
            "show": {
              "gui": "always",
              "tui": false
            }
          }
        ],
        "show": {
          "gui": "always",
          "tui": false
        }
      },
      {
        "id": "plugins",
        "title": "プラグイン",
        "items": [
          {
            "type": "slot",
            "id": "plugins",
            "show": {
              "gui": "always",
              "tui": false
            }
          }
        ],
        "show": {
          "gui": "always",
          "tui": false
        }
      },
      {
        "id": "connection",
        "title": "接続",
        "items": [
          {
            "type": "slot",
            "id": "server",
            "show": {
              "gui": "tauriOrDev",
              "tui": true
            }
          },
          {
            "type": "link",
            "id": "devices",
            "label": "デバイス",
            "page": "devices",
            "show": {
              "gui": "tauri",
              "tui": true
            }
          }
        ],
        "show": {
          "gui": "tauriOrDev",
          "tui": true
        }
      },
      {
        "id": "app",
        "title": "アプリ",
        "items": [
          {
            "type": "slot",
            "id": "version",
            "show": {
              "gui": "always",
              "tui": true
            }
          }
        ],
        "show": {
          "gui": "always",
          "tui": true
        }
      }
    ],
    "show": {
      "gui": "always",
      "tui": true
    }
  },
  {
    "id": "enterKeys",
    "title": "入力欄のキー",
    "sections": [
      {
        "id": "enterKeys",
        "title": "入力欄のキー",
        "items": [
          {
            "type": "field",
            "id": "enterKeys.enter",
            "label": "Enter",
            "icon": null,
            "key": "enterKeys.enter",
            "control": {
              "type": "segmented",
              "options": [
                {
                  "value": "send",
                  "label": "送信",
                  "icon": null
                },
                {
                  "value": "newline",
                  "label": "改行",
                  "icon": null
                },
                {
                  "value": "none",
                  "label": "なし",
                  "icon": null
                }
              ]
            },
            "show": {
              "gui": "always",
              "tui": true
            }
          },
          {
            "type": "field",
            "id": "enterKeys.shift",
            "label": "Shift+Enter",
            "icon": null,
            "key": "enterKeys.shift",
            "control": {
              "type": "segmented",
              "options": [
                {
                  "value": "send",
                  "label": "送信",
                  "icon": null
                },
                {
                  "value": "newline",
                  "label": "改行",
                  "icon": null
                },
                {
                  "value": "none",
                  "label": "なし",
                  "icon": null
                }
              ]
            },
            "show": {
              "gui": "always",
              "tui": true
            }
          },
          {
            "type": "field",
            "id": "enterKeys.ctrl",
            "label": "Ctrl+Enter",
            "icon": null,
            "key": "enterKeys.ctrl",
            "control": {
              "type": "segmented",
              "options": [
                {
                  "value": "send",
                  "label": "送信",
                  "icon": null
                },
                {
                  "value": "newline",
                  "label": "改行",
                  "icon": null
                },
                {
                  "value": "none",
                  "label": "なし",
                  "icon": null
                }
              ]
            },
            "show": {
              "gui": "always",
              "tui": true
            }
          },
          {
            "type": "field",
            "id": "enterKeys.alt",
            "label": "Alt+Enter",
            "icon": null,
            "key": "enterKeys.alt",
            "control": {
              "type": "segmented",
              "options": [
                {
                  "value": "send",
                  "label": "送信",
                  "icon": null
                },
                {
                  "value": "newline",
                  "label": "改行",
                  "icon": null
                },
                {
                  "value": "none",
                  "label": "なし",
                  "icon": null
                }
              ]
            },
            "show": {
              "gui": "always",
              "tui": true
            }
          },
          {
            "type": "note",
            "id": "enterKeysNote",
            "text": "メッセージの編集では「送信」が保存になります。この設定はほかのデバイスとも共有されます",
            "show": {
              "gui": "always",
              "tui": true
            }
          }
        ],
        "show": {
          "gui": "always",
          "tui": true
        }
      }
    ],
    "show": {
      "gui": "always",
      "tui": true
    }
  },
  {
    "id": "hotkeys",
    "title": "ホットキー",
    "sections": [
      {
        "id": "hotkeys",
        "title": "ホットキー",
        "items": [
          {
            "type": "slot",
            "id": "hotkeys",
            "show": {
              "gui": "always",
              "tui": false
            }
          }
        ],
        "show": {
          "gui": "always",
          "tui": false
        }
      }
    ],
    "show": {
      "gui": "notAndroid",
      "tui": false
    }
  },
  {
    "id": "tuiKeys",
    "title": "キー割り当て",
    "sections": [
      {
        "id": "tuiKeys",
        "title": "キー割り当て",
        "items": [
          {
            "type": "slot",
            "id": "tuiKeys",
            "show": {
              "gui": "never",
              "tui": true
            }
          }
        ],
        "show": {
          "gui": "never",
          "tui": true
        }
      }
    ],
    "show": {
      "gui": "never",
      "tui": true
    }
  },
  {
    "id": "navBar",
    "title": "ナビゲーションバー",
    "sections": [
      {
        "id": "navBar",
        "title": "ナビゲーションバー",
        "items": [
          {
            "type": "slot",
            "id": "navBar",
            "show": {
              "gui": "always",
              "tui": false
            }
          }
        ],
        "show": {
          "gui": "always",
          "tui": false
        }
      }
    ],
    "show": {
      "gui": "always",
      "tui": false
    }
  },
  {
    "id": "composerMenu",
    "title": "＋メニュー",
    "sections": [
      {
        "id": "composerMenu",
        "title": "＋メニュー",
        "items": [
          {
            "type": "slot",
            "id": "composerMenu",
            "show": {
              "gui": "always",
              "tui": false
            }
          }
        ],
        "show": {
          "gui": "always",
          "tui": false
        }
      }
    ],
    "show": {
      "gui": "always",
      "tui": false
    }
  },
  {
    "id": "call",
    "title": "通話",
    "sections": [
      {
        "id": "call",
        "title": "通話",
        "items": [
          {
            "type": "field",
            "id": "joinMuted",
            "label": "参加したときミュートにする",
            "icon": "mic-off",
            "key": "joinMuted",
            "control": {
              "type": "toggle"
            },
            "show": {
              "gui": "always",
              "tui": false
            }
          },
          {
            "type": "field",
            "id": "micVolume",
            "label": "マイクの音量",
            "icon": "mic",
            "key": "micVolume",
            "control": {
              "type": "slider",
              "min": 0.0,
              "max": 200.0,
              "step": 5.0,
              "scale": 100.0,
              "unit": "%"
            },
            "show": {
              "gui": "always",
              "tui": false
            }
          },
          {
            "type": "field",
            "id": "outVolume",
            "label": "相手の音量",
            "icon": "volume-2",
            "key": "outVolume",
            "control": {
              "type": "slider",
              "min": 0.0,
              "max": 100.0,
              "step": 5.0,
              "scale": 100.0,
              "unit": "%"
            },
            "show": {
              "gui": "always",
              "tui": false
            }
          },
          {
            "type": "field",
            "id": "limiterStrength",
            "label": "大きい音を抑える",
            "icon": "shield-check",
            "key": "limiterStrength",
            "control": {
              "type": "segmented",
              "options": [
                {
                  "value": "none",
                  "label": "なし",
                  "icon": null
                },
                {
                  "value": "weak",
                  "label": "弱",
                  "icon": null
                },
                {
                  "value": "medium",
                  "label": "中",
                  "icon": null
                },
                {
                  "value": "strong",
                  "label": "強",
                  "icon": null
                }
              ]
            },
            "show": {
              "gui": "always",
              "tui": false
            }
          },
          {
            "type": "slot",
            "id": "callDevices",
            "show": {
              "gui": "always",
              "tui": false
            }
          }
        ],
        "show": {
          "gui": "always",
          "tui": false
        }
      }
    ],
    "show": {
      "gui": "always",
      "tui": false
    }
  },
  {
    "id": "devices",
    "title": "デバイス",
    "sections": [
      {
        "id": "devices",
        "title": "デバイス",
        "items": [
          {
            "type": "slot",
            "id": "deviceList",
            "show": {
              "gui": "tauri",
              "tui": true
            }
          }
        ],
        "show": {
          "gui": "tauri",
          "tui": true
        }
      }
    ],
    "show": {
      "gui": "tauri",
      "tui": true
    }
  }
];

/** ナビゲーションバーに出せる本体の項目 */
export const NAV_ITEMS: readonly UiNavItem[] = [
  {
    "id": "app:open-chat",
    "label": "Chat",
    "name": "チャットを開く",
    "tui": true
  },
  {
    "id": "app:open-settings",
    "label": "Settings",
    "name": "設定を開く",
    "tui": true
  },
  {
    "id": "app:call-open",
    "label": "Call",
    "name": "通話を開く",
    "tui": false
  },
  {
    "id": "app:search",
    "label": "Search",
    "name": "メッセージを検索",
    "tui": true
  },
  {
    "id": "app:open-files",
    "label": null,
    "name": "共有フォルダを開く",
    "tui": false
  }
];
