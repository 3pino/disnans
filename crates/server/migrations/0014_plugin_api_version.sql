-- プラグインを作った本体の版（manifest の apiVersion）。古いもの・なしは NULL。
ALTER TABLE plugins ADD COLUMN api_version INTEGER;
