-- ユーザーごとの設定（ショートカット・Enter キーの動作など）。同じユーザーの端末どうしで共有する。
-- 中身はクライアントが決める JSON オブジェクト（サーバーは大きさと形だけを確かめる）。
CREATE TABLE user_prefs (
    user_id    TEXT PRIMARY KEY NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    prefs      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
