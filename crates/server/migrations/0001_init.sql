-- 初期スキーマ。ID はすべて ULID 文字列、時刻は Unix ミリ秒。

CREATE TABLE users (
    id           TEXT PRIMARY KEY NOT NULL,
    -- Tailscale のログイン名。アカウントの識別に使う。
    login_name   TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    avatar_url   TEXT,
    created_at   INTEGER NOT NULL
);

CREATE TABLE messages (
    id         TEXT PRIMARY KEY NOT NULL,
    author_id  TEXT NOT NULL REFERENCES users (id),
    -- スレッド内の返信なら起点のメッセージの ID。起点を消すと返信も消える。
    thread_id  TEXT REFERENCES messages (id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    edited_at  INTEGER
);

-- ページングは (thread_id, id) の順で引く。
CREATE INDEX messages_thread_id ON messages (thread_id, id);

-- スレッド。ID は起点のメッセージの ID と同じ。
CREATE TABLE threads (
    id         TEXT PRIMARY KEY NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX threads_kind ON threads (kind);

CREATE TABLE reactions (
    message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users (id),
    emoji      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, emoji, user_id)
);

-- アップロードされたファイル。投稿されるまで message_id は NULL。
CREATE TABLE files (
    id          TEXT PRIMARY KEY NOT NULL,
    uploader_id TEXT NOT NULL REFERENCES users (id),
    message_id  TEXT REFERENCES messages (id) ON DELETE CASCADE,
    -- メッセージ内での並び順。
    position    INTEGER NOT NULL DEFAULT 0,
    file_name   TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    width       INTEGER,
    height      INTEGER,
    has_thumb   INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);

CREATE INDEX files_message_id ON files (message_id, position);
