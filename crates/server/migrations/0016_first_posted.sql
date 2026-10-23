-- 初めて本文に紐付けられた時刻（`attachments/` の作成日時になる）。本文のリンクを外しても残す。
-- 既存の行は起動時の backfill（src/links.rs の plan_backfill）で入る。その前の行は NULL。
ALTER TABLE files ADD COLUMN first_posted_at INTEGER;
