// 実際の部品の矩形・DOM だけを検査する。スクリーンショット・実機・実際のメディア取得は使わない。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.CHROME ?? join(homedir(), '.cache/puppeteer/chrome-headless-shell/linux-146.0.7680.153/chrome-headless-shell-linux64/chrome-headless-shell');
const profile = mkdtempSync(join(tmpdir(), 'disnans-feedback-ui-'));
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>
<div class="shell-root"><div class="top-slot"></div><div id="fixture"></div></div>
<script type="module">
import { mount, unmount, tick } from 'svelte';
import '/src/app.css';
import Attachments from '/src/components/Attachments.svelte';
import FileLink from '/src/components/FileLink.svelte';
import ScreenSharePreview from '/src/components/ScreenSharePreview.svelte';
import SettingsView from '/src/components/SettingsView.svelte';
import { ui } from '/src/lib/stores/ui.svelte';
import { applyServerUrl } from '/src/lib/config';
// 選択・録音・音声再生などの本物の API へは到達させない。
window.__mediaCalls=[];
for(const name of ['getUserMedia','getDisplayMedia','enumerateDevices'])Object.defineProperty(navigator.mediaDevices,name,{configurable:true,value:()=>{window.__mediaCalls.push(name);return name==='enumerateDevices'?Promise.resolve([]):Promise.reject(new Error('media disabled'));}});
for(const name of ['AudioContext','webkitAudioContext'])if(window[name])window[name]=new Proxy(window[name],{construct(){window.__mediaCalls.push(name);throw new Error('audio disabled');}});
applyServerUrl(location.origin);
const c=document.createElement('canvas');c.width=320;c.height=1280;const ctx=c.getContext('2d');ctx.fillStyle='#406878';ctx.fillRect(0,0,320,1280);const png=c.toDataURL();
let apps=[];
window.renderFixture=async(kind,android=true)=>{
 for(const app of apps)await unmount(app);apps=[];document.querySelector('#fixture').innerHTML='';document.querySelector('.top-slot').innerHTML='';
 window.__DISNANS_PLATFORM__={os:android?'android':'linux',android,desktop:!android,capabilities:null};
 const target=document.querySelector('#fixture');
 if(kind==='chat'){
  apps.push(mount(Attachments,{target,props:{attachments:[{id:'fixture',file_name:'long.png',mime:'image/png',size:1,has_thumb:false,width:320,height:1280,deleted:false}],body:'',local:{fixture:png}}}));
  apps.push(mount(FileLink,{target,props:{path:'long.png',alias:null,embed:true}}));
 }else if(kind==='preview'){
  const screen={sharing:true,starting:false,source:'screen',switching:false,canSwitchCamera:false,canScreen:true,canCamera:true,localStream:null,localFrame:{mime:'image/png',data:png.split(',')[1]},
    sharers:[{peer:'p',userId:'u',source:'screen',dataUrl:png,lastSeen:0}],selectedPeer:'p',viewerOpen:false,settings:{value:{},patch(){},subscribe:()=>()=>{}},toggleScreen:async()=>{},toggleCamera:async()=>{},switchCamera:async()=>{},stop(){},openViewer(){},closeViewer(){},selectPeer(){}};
  apps.push(mount(ScreenSharePreview,{target,props:{screen,nameOf:()=> 'fixture'}}));
 }else{
  ui.settingsSub='call';apps.push(mount(SettingsView,{target}));
 }
 await tick();await new Promise(r=>setTimeout(r,250));return true;
};
</script></body></html>`;
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'feedback-ui-fixture', configureServer(server) {
  server.middlewares.use(async(req,res,next)=>{
    const path=req.url?.split('?')[0];
    if(path==='/__feedback_ui_fixture'){res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(path,html));return;}
    if(path==='/api/shared/long.png'){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="1280"><rect width="320" height="1280" fill="#406878"/></svg>');return;}
    if(path?.startsWith('/api/shared')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({path:'',entries:[{name:'long.png',path:'long.png',kind:'file',mime:'image/png',size:1,modified_ms:0,file_id:null}]}));return;}
    if(path?.startsWith('/api/')){res.statusCode=404;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:'not_found',message:'fixture'}));return;}
    next();
  });
}}] });
let chrome,ws;
try{
 await vite.listen();chrome=spawn(executable,['--no-sandbox','--disable-gpu',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe']});
 const endpoint=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Chromium startup timed out')),15000);let text='';chrome.on('error',e=>{clearTimeout(timer);reject(e);});chrome.stderr.on('data',b=>{text+=b;const m=/DevTools listening on (ws:\/\/\S+)/.exec(text);if(m){clearTimeout(timer);resolve(m[1]);}});});
 ws=new WebSocket(endpoint);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 let seq=0;const pending=new Map();ws.addEventListener('message',({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(new Error(JSON.stringify(m.error)));else p.resolve(m.result);});
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject,timer:setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method));},20000)});ws.send(JSON.stringify({id,method,params,sessionId}));});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});const S=(m,p)=>send(m,p,sessionId);
 const evaluate=async(expression)=>{const r=await S('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await S('Page.enable');await S('Emulation.setDeviceMetricsOverride',{width:390,height:700,deviceScaleFactor:1,mobile:true});await S('Page.navigate',{url:`http://127.0.0.1:${vite.httpServer.address().port}/__feedback_ui_fixture`});
 for(let i=0;i<150&&!(await evaluate('typeof window.renderFixture === "function"'));i++)await new Promise(r=>setTimeout(r,50));assert.equal(await evaluate('typeof window.renderFixture'),'function');
 for(const android of [true,false]){
  await evaluate(`window.renderFixture('chat',${android})`);
  const r=await evaluate(`['.attachment-image','.file-link-embed-image-img'].map(s=>{const e=document.querySelector(s);if(!e)return null;return{height:e.getBoundingClientRect().height,width:e.getBoundingClientRect().width,max:getComputedStyle(e).maxHeight};})`);
  for(const item of r){assert(item,'chat image missing');if(android){assert(item.height<=210.1,'Android image exceeds30%viewport');assert(Math.abs(item.width/item.height-0.25)<0.01,'Android cap distorts/crops portrait aspect');}else assert(item.height>210,'desktop cap changed');}
 }
 await evaluate('window.renderFixture("preview")');
 const cards=await evaluate(`[...document.querySelectorAll('.screen-embedded')].map(e=>{const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,width:r.width,position:getComputedStyle(e).position};})`);
 assert.equal(cards.length,2,'remote/local normal-flow cards required');assert(Math.abs(cards[0].width-cards[1].width)<1,'local preview not same width');assert(cards[1].top>=cards[0].bottom,'local preview overlaps remote');
 assert.equal(await evaluate(`document.querySelector('[aria-label$="を大きく見る"]').textContent.trim()`),'','expand button must be icon-only');
 await evaluate('window.renderFixture("settings")');
 const blank=await evaluate(`[...document.querySelectorAll('.settings-blank-bar')].map(e=>getComputedStyle(e).display)`);assert.equal(blank.length,2,'actual settings headers missing');assert(blank.every(v=>v!=='none'),'no-call headers removed');
 await evaluate(`document.querySelector('.top-slot').innerHTML='<div class="call-bar"></div>'`);
 assert.equal(await evaluate(`[...document.querySelectorAll('.settings-blank-bar')].every(e=>getComputedStyle(e).display==='none')`),true,'call leaves empty headers');
 // 設定は偽物の enumerateDevices() を読む。本物の列挙・録音・取得・AudioContext には到達しない。
 assert.deepEqual(await evaluate('window.__mediaCalls.filter(name=>name!=="enumerateDevices")'),[],'fixture attempted media capture/audio');
 console.log('feedback UI: Android-only30%image caps, desktop unchanged, local/remote card geometry, icon-only control, settings header switching passed (no appearance check/media)');
}finally{ws?.close();chrome?.kill();await vite.close();rmSync(profile,{recursive:true,force:true});}
