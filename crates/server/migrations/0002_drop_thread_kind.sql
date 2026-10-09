-- スレッドの種類（近況）をやめる。kind を使うインデックスを先に消してから列を消す。

DROP INDEX IF EXISTS threads_kind;

ALTER TABLE threads DROP COLUMN kind;
