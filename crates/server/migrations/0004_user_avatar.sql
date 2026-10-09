-- ユーザーが自分で設定したアバター。ファイルは `<data_dir>/avatars/<avatar_file>.webp`。
-- 設定されていれば Tailscale のプロフィール画像より優先する。
-- avatar_url はこれまでどおり Tailscale のプロフィール画像の URL を持ち続ける（元に戻すときに使う）。
ALTER TABLE users ADD COLUMN avatar_file TEXT;
