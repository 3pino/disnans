-- 既読の位置（ユーザーごと・場所ごと）。同じユーザーの端末どうしで共有する。
-- scope はメインチャットなら ''、スレッドならスレッド（起点のメッセージ）の ID。
-- last_read_id 以下の ID のメッセージを既読とみなす（ULID は作成順に並ぶ）。
-- 行がない場所は、アカウントを作った時刻より前のメッセージを既読とみなす。
CREATE TABLE read_markers (
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    scope        TEXT NOT NULL,
    last_read_id TEXT NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, scope)
);

-- スレッドの起点を消したら、そのスレッドの既読の位置も消す。
CREATE TRIGGER read_markers_thread_deleted
AFTER DELETE ON messages
WHEN OLD.thread_id IS NULL
BEGIN
    DELETE FROM read_markers WHERE scope = OLD.id;
END;

-- 導入した時点のメッセージは、全員について既読にしておく（いきなり大量の未読が出ないように）。
INSERT INTO read_markers (user_id, scope, last_read_id, updated_at)
SELECT u.id, '', m.max_id, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM users u, (SELECT MAX(id) AS max_id FROM messages WHERE thread_id IS NULL) m
WHERE m.max_id IS NOT NULL;

INSERT INTO read_markers (user_id, scope, last_read_id, updated_at)
SELECT u.id, m.thread_id, MAX(m.id), CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM users u, messages m
WHERE m.thread_id IS NOT NULL
GROUP BY u.id, m.thread_id;
