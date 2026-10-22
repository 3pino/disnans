-- 添付の別名（attachments/ での名前）。既存の行の値は変えない。
-- file_name を別名として使う。alias_key（小文字化したキー）は起動時の別名の割り当て
-- （src/attachment_names.rs の backfill）で入る。その前の行は NULL。
ALTER TABLE files ADD COLUMN alias_key TEXT;
-- 投稿せずに attachments/ の中に直接作ったもの（投稿されるまで消えない）。
ALTER TABLE files ADD COLUMN library INTEGER NOT NULL DEFAULT 0;
-- attachments/ から消した時刻。本体は消してあり、メッセージには「削除された」と残る。
ALTER TABLE files ADD COLUMN deleted_at INTEGER;
-- 生きている添付の中で、別名は大文字小文字を区別せず一意。
CREATE UNIQUE INDEX files_live_alias ON files (alias_key) WHERE deleted_at IS NULL;
