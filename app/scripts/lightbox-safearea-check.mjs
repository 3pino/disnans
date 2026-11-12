// 共通の拡大表示枠を Chromium で測る。画像・マイク・実機・スクリーンショットは使わない。
// 実際の LightboxView（写真）と ScreenShareViewer（共有）を Chromium に載せ、CDP の setSafeAreaInsetsOverride で env() を合成して矩形だけを検査する。
// Android 実機や OS の没入・PiP は再現しない。
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { connectCdp, launchChrome, makeProfile, openPage, stopChrome } from './cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = makeProfile('disnans-viewer-frame-');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>body{margin:0}</style></head><body><div id="fixture"></div>
<script type="module">
import {mount,unmount,tick} from 'svelte';
import '/src/app.css';
import LightboxView from '/src/components/LightboxView.svelte';
import ScreenShareViewer from '/src/components/ScreenShareViewer.svelte';
const PNG = ${JSON.stringify(PNG)};
const items = ['a','b','c'].map((n) => ({ src: PNG + '#' + n, alt: n + '.png', downloadUrl: PNG }));
let app;
// 実際の Lightbox の部品（写真の拡大表示 / 共有の拡大表示）を、実際のコンポーネントで描く
const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 300;
const bigCtx = canvas.getContext('2d'); bigCtx.fillStyle = '#406878'; bigCtx.fillRect(0, 0, 400, 300);
const BIG = canvas.toDataURL();
window.__closed = 0;
window.renderFixture = async (kind) => {
  if (app) await unmount(app);
  document.getElementById('fixture').innerHTML = '';
  window.__closed = 0;
  // Android: 映像の上を押すと没入（バーを隠す）、外を押すと閉じる。OS の没入は呼ばれない（Tauri ではない）
  window.__DISNANS_PLATFORM__ = kind === 'android' ? { os: 'android', android: true, desktop: false, capabilities: null } : undefined;
  if (kind === 'photo') {
    app = mount(LightboxView, { target: document.getElementById('fixture'), props: { item: items[1], gallery: () => items, onchange() {}, onclose() {} } });
  } else {
    const dataUrl = kind === 'android' ? BIG : PNG;
    const screen = { sharing: false, starting: false, source: 'screen', switching: false, canSwitchCamera: false, canScreen: true, canCamera: true, localStream: null, localFrame: null,
      sharers: [{ peer: 'p1', userId: 'u1', source: 'screen', dataUrl, lastSeen: 0 }, { peer: 'p2', userId: 'u2', source: 'screen', dataUrl, lastSeen: 0 }],
      viewerOpen: true, selectedPeer: 'p1', settings: { value: {}, patch() {}, subscribe: () => () => {} },
      toggleScreen: async () => {}, toggleCamera: async () => {}, switchCamera: async () => {}, stop() {}, openViewer() {}, closeViewer() { window.__closed++; }, selectPeer() {} };
    app = mount(ScreenShareViewer, { target: document.getElementById('fixture'), props: { screen, nameOf: (id) => id, pip: { supported: true, active: false, enter: async () => true, onChange: () => () => {} } } });
  }
  await tick(); await new Promise((r) => setTimeout(r, 50)); return true;
};
</script></body></html>`;
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, plugins: [{
  name: 'viewer-frame-geometry-fixture',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.split('?')[0] !== '/__viewer_frame_fixture') return next();
      try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__viewer_frame_fixture', html)); }
      catch (error) { res.statusCode = 500; res.end(String(error)); }
    });
  },
}] });
let chrome;
let ws;
try {
  await vite.listen();
  const url = `http://127.0.0.1:${vite.httpServer.address().port}/__viewer_frame_fixture`;
  const launched = launchChrome(profile);
  chrome = launched.child;
  ws = await connectCdp(await launched.endpoint);
  const S = await openPage(ws);
  const evaluate = async (expression) => {
    const result = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error('Fixture evaluation failed: ' + JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await S('Page.enable');
  await S('Page.navigate', { url });
  for (let i = 0; i < 100 && !(await evaluate('typeof window.renderFixture === "function"')); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await evaluate('typeof window.renderFixture'), 'function');
  const scenarios = [
    { name: 'portrait-notch', width: 390, height: 844, top: 44, left: 0, right: 0, bottom: 34 },
    { name: 'landscape-notch', width: 844, height: 390, top: 0, left: 44, right: 18, bottom: 21 },
    { name: 'immersive-zero', width: 390, height: 844, top: 0, left: 0, right: 0, bottom: 0 },
  ];
  let cases = 0;
  for (const scenario of scenarios) {
    const { width, height, top, left, right, bottom } = scenario;
    await S('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await S('Emulation.setSafeAreaInsetsOverride', { insets: { top, left, right, bottom } });
    for (const kind of ['photo', 'screen']) {
      await evaluate(`window.renderFixture(${JSON.stringify(kind)})`);
      const m = await evaluate(`(() => {
        const rect = (el) => {const r=el.getBoundingClientRect(); return {top:r.top,left:r.left,right:r.right,bottom:r.bottom,w:r.width,h:r.height};};
        const root = document.querySelector('.lightbox');
        const controls = [...document.querySelectorAll('.lightbox-toolbar button, .lightbox-toolbar a, .lightbox-toolbar [role=radio]')].map(rect);
        const nav = [...document.querySelectorAll('.lightbox-nav')].map(rect);
        return { root: !!root, usesImageViewer: !!document.querySelector('.lightbox-slide-current .image-viewer'), controls, nav, toolbar: rect(document.querySelector('.lightbox-toolbar')) };
      })()`);
      const label = `${scenario.name}/${kind}`;
      assert(m.root && m.usesImageViewer, `${label}: not rendered through the real Lightbox + ImageViewer`);
      assert(m.controls.length >= 2, `${label}: toolbar controls missing`);
      assert(m.toolbar.top >= top, `${label}: toolbar overlaps top inset`);
      for (const c of m.controls) {
        assert(c.top >= top && c.bottom <= height - bottom, `${label}: control overlaps top/bottom inset`);
        assert(c.left >= left && c.right <= width - right, `${label}: control overlaps side inset`);
      }
      for (const n of m.nav) assert(n.left >= left && n.right <= width - right, `${label}: nav overlaps side inset`);
      if (kind === 'photo') assert(m.nav.length === 2, `${label}: photo gallery nav missing`);
      else assert(m.nav.length === 0, `${label}: live view must not show gallery nav`);
      cases++;
    }
  }
  // Android のタップ: 実際の解像度で、映像の上と外を判定する（拡大を際だけにしない）
  await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await S('Emulation.setSafeAreaInsetsOverride', { insets: { top: 44, left: 0, right: 0, bottom: 34 } });
  await S('Emulation.setTouchEmulationEnabled', { enabled: true });
  await evaluate('window.renderFixture("android")');
  const box = await evaluate(`(() => { const r = document.querySelector('.lightbox-slide-current .image-viewer-image').getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; })()`);
  assert(box.r - box.l > 100 && box.b - box.t > 100, 'android: image not laid out');
  const tap = async (x, y) => {
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await new Promise((r) => setTimeout(r, 450));
  };
  const cx = (box.l + box.r) / 2, cy = (box.t + box.b) / 2;
  const toolbar = () => evaluate(`!!document.querySelector('.lightbox-toolbar')`);
  assert.equal(await toolbar(), true, 'android: toolbar missing at start');
  assert.equal(await evaluate('[...document.querySelectorAll("button")].some(b => b.getAttribute("aria-label") === "全画面")'), false, 'android: fullscreen button must not exist');
  await tap(cx, cy);
  assert.equal(await toolbar(), false, 'android: tap on image must hide the toolbar');
  assert.equal(await evaluate('window.__closed'), 0, 'android: tap on image must not close');
  await tap(cx, cy);
  assert.equal(await toolbar(), true, 'android: second tap on image must show the toolbar');
  assert.equal(await evaluate('window.__closed'), 0, 'android: second tap must not close');
  await tap(box.l / 2, cy);
  assert.equal(await evaluate('window.__closed'), 1, 'android: tap outside the image must close');
  console.log(`lightbox safe-area: ${cases} geometry cases + android tap hit-test (real Lightbox photo + real screen viewer, no screenshots/media)`);
} finally {
  ws?.close();
  stopChrome(chrome, profile);
  await vite.close();
}
