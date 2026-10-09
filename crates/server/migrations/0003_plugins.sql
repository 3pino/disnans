-- プラグインと、プラグインのセッション（SPEC 9章）。

-- 配布されたプラグイン。ファイルの本体は `<data_dir>/plugins/<id>/` に置く。
CREATE TABLE plugins (
    id              TEXT PRIMARY KEY NOT NULL,
    name            TEXT NOT NULL,
    version         TEXT NOT NULL,
    description     TEXT NOT NULL,
    author          TEXT NOT NULL,
    min_api_version INTEGER NOT NULL,
    -- 配布されているファイル名の JSON 配列。
    files           TEXT NOT NULL,
    -- ファイルの中身の SHA-256（16進）。
    hash            TEXT NOT NULL,
    updated_by      TEXT NOT NULL REFERENCES users (id),
    updated_at      INTEGER NOT NULL
);

-- セッション（ゲームの1局など）。カードのメッセージを消すとセッションも消える。
-- プラグインを削除してもセッションは残す（同じ ID で配布し直せば、また開ける）ので、plugin は外部キーにしない。
CREATE TABLE plugin_sessions (
    id         TEXT PRIMARY KEY NOT NULL,
    plugin     TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE REFERENCES messages (id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES users (id),
    -- プラグインが自由に決める JSON。
    state      TEXT NOT NULL,
    version    INTEGER NOT NULL,
    card_title TEXT NOT NULL,
    card_text  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
