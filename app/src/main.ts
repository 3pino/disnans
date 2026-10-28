import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { installDiagLog } from './lib/diagLog';
import { isTauri } from './lib/platform';

// 起動の途中のエラーも残せるよう、画面を作る前に入れる
installDiagLog();

const target = document.getElementById('app')!;

// ブラウザーでは動かさない（チャット・通知・更新が使えず、中途半端に見えるため）。Tauri（Windows・Linux・Android）だけで動く
if (!isTauri()) {
  target.textContent = 'disnans は Tauri 版（Windows・Linux・Android）でだけ動きます。ブラウザーでは開けません。';
}

const app = isTauri() ? mount(App, { target }) : null;

export default app;
