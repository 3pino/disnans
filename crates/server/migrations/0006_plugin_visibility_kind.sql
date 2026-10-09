-- 自分だけのプラグインと、テーマ（SPEC 3.3, 9.6, 9.10）。

-- `plugin`（main.js で動くプラグイン）か `theme`（theme.css だけのテーマ）。
ALTER TABLE plugins ADD COLUMN kind TEXT NOT NULL DEFAULT 'plugin';
-- `public`（みんなに配布）か `private`（自分だけ）。
ALTER TABLE plugins ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
-- 自分だけのものの持ち主。みんなに配布したものは NULL。
ALTER TABLE plugins ADD COLUMN owner TEXT REFERENCES users (id);
