-- メッセージ本文の全文検索（FTS5）。trigram トークナイザーなので、日本語の部分一致も引ける。
-- 索引は本文と ID だけ持つ。投稿・編集・削除のトリガーで同期する（削除はカスケードでも発火する）。
CREATE VIRTUAL TABLE messages_fts USING fts5(
    body,
    id UNINDEXED,
    tokenize = 'trigram'
);

-- 既存のメッセージを索引する
INSERT INTO messages_fts (body, id) SELECT body, id FROM messages;

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
BEGIN
    INSERT INTO messages_fts (body, id) VALUES (new.body, new.id);
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE OF body ON messages
BEGIN
    DELETE FROM messages_fts WHERE id = old.id;
    INSERT INTO messages_fts (body, id) VALUES (new.body, new.id);
END;

-- ID は UNINDEXED なので、削除は全件を見て探す（メッセージの削除は少ないので許容する）
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages
BEGIN
    DELETE FROM messages_fts WHERE id = old.id;
END;
