-- 端末ごとの設定。端末 ID はクライアントが作る（認証ではない。自分の端末だけを見られる）。
-- devices は端末の一覧（名前つき）、device_prefs はその端末の設定（JSON オブジェクト）。
CREATE TABLE devices (
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_id    TEXT NOT NULL,
    name         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id)
);

CREATE TABLE device_prefs (
    user_id    TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    prefs      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id),
    FOREIGN KEY (user_id, device_id) REFERENCES devices (user_id, device_id) ON DELETE CASCADE
);
