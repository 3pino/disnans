import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { installDiagLog } from './lib/diagLog';

// 起動の途中のエラーも残せるよう、画面を作る前に入れる
installDiagLog();

const app = mount(App, { target: document.getElementById('app')! });

export default app;
