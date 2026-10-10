-- プラグインがボットとして投稿したメッセージ。author_id は投稿を実行した人。
ALTER TABLE messages ADD COLUMN bot_plugin TEXT;
ALTER TABLE messages ADD COLUMN bot_name TEXT;
