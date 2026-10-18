-- スレッドの廃止。スレッドの返信はメインチャットに移す（ID は作成順に並ぶので、時刻順は保たれる）。
-- 返信先が空なら、スレッドの起点（元のメッセージ）への返信にして文脈を残す。
-- タイトルとタグは捨てる（移行前の DB は起動時にバックアップされる）。
-- messages.thread_id 列は外部キーがあるため SQLite では消せない。残して、常に NULL にする。

UPDATE messages SET reply_to = thread_id WHERE thread_id IS NOT NULL AND reply_to IS NULL;
UPDATE messages SET thread_id = NULL WHERE thread_id IS NOT NULL;

-- スレッドの既読の位置は要らない（メインチャットの位置はそのまま）
DROP TRIGGER IF EXISTS read_markers_thread_deleted;
DELETE FROM read_markers WHERE scope <> '';

DROP TABLE thread_tags;
DROP TABLE threads;
