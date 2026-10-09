-- プラグインのアイコン（manifest の `icon`、Lucide のアイコン名）。`icon.svg` の有無は files で分かる。
ALTER TABLE plugins ADD COLUMN icon TEXT;
