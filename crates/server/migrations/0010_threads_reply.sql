-- 返信先のメッセージ。返信先が消えても ID は残す（外部キーなし。クライアントは「削除されたメッセージ」と表示する）。
ALTER TABLE messages ADD COLUMN reply_to TEXT;

-- スレッドを立てた人（タイトルとアーカイブを変えられる人）、タイトル、アーカイブ。
ALTER TABLE threads ADD COLUMN created_by TEXT REFERENCES users (id);
ALTER TABLE threads ADD COLUMN title TEXT;
ALTER TABLE threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

UPDATE threads SET created_by = (SELECT author_id FROM messages WHERE messages.id = threads.id);

-- スレッドのタグ。position は表示の順。
CREATE TABLE thread_tags (
    thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    label     TEXT NOT NULL,
    icon      TEXT,
    PRIMARY KEY (thread_id, position)
);

CREATE INDEX thread_tags_label ON thread_tags (label, icon);
