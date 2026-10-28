-- 共有フォルダのゴミ箱（data/trash/<ID>/）。項目ごとに 1 行。
-- state: pending（実体を動かす前後の途中）→ ready。restoring / purging は戻す・消す途中。broken は
-- 実体と行がどう合わないか決められないもの（消さず、操作を拒否する）。
-- kind: dir / file（共有フォルダの項目）、attachment（添付。file_id と payload に files 行の全部）。
CREATE TABLE shared_trash (
    id            TEXT PRIMARY KEY NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('dir', 'file', 'attachment')),
    state         TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'restoring', 'purging', 'broken')),
    original_path TEXT NOT NULL,
    size          INTEGER NOT NULL DEFAULT 0,
    deleted_at    INTEGER NOT NULL,
    file_id       TEXT,
    payload       TEXT
);

CREATE INDEX shared_trash_state ON shared_trash (state);
