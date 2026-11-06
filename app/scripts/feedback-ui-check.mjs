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
<style>html,body{height:100%;margin:0}.shell-root{height:100%;display:flex;flex-direction:column}#fixture{flex:1;min-height:0}</style>
<div class="shell-root"><div class="top-slot"></div><div id="fixture"></div></div>
<script type="module">
import { mount, unmount, tick } from 'svelte';
import '/src/app.css';
import Attachments from '/src/components/Attachments.svelte';
import FileLink from '/src/components/FileLink.svelte';
import CallView from '/src/components/CallView.svelte';
import { fixtureState } from '/scripts/feedback-call-fixture.svelte.ts';
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
 }else if(kind==='chatSizes'){
  const mk=(id,w,h)=>({id,file_name:id+'.png',mime:'image/png',size:1,has_thumb:false,width:w,height:h,deleted:false});
  const local=Object.fromEntries(['wide','small','unknown','a','b'].map(id=>[id,png]));
  for(const group of [[mk('wide',1600,400)],[mk('small',40,20)],[{...mk('unknown',0,0),width:null,height:null}],[mk('a',300,300),mk('b',600,300)]])apps.push(mount(Attachments,{target,props:{attachments:group,body:'',local}}));
 }else if(kind==='call'){
  // 本物の CallView。通話の状態だけが偽物（lib/call/instance.svelte を差し替えている）
  const person=(peer,userId,self)=>({peer,userId,self,connected:true,muted:false,speaking:false,localMuted:false,device:null});
  const people=[person('me','user-me',true),person('o1','user-o1',false),person('o2','user-o2',false)];
  const mk=(over)=>({sharing:false,starting:false,source:'screen',switching:false,canSwitchCamera:true,canScreen:true,canCamera:true,localStream:null,localFrame:null,sharers:[],viewerOpen:false,selectedPeer:null,settings:{value:{},patch(){},subscribe:()=>()=>{}},toggleScreen:async()=>{},toggleCamera:async()=>{},switchCamera:async()=>{},stop(){},openViewer(peer){window.__opened=peer;},closeViewer(){},selectPeer(){},...over});
  const sharer=(peer,userId)=>({peer,userId,source:'screen',dataUrl:png,lastSeen:0});
  fixtureState.people=people;
  fixtureState.screen=mk(android==='none'?{}:android==='all'?{sharing:true,localFrame:{mime:'image/png',data:png.split(',')[1]},sharers:[sharer('o1','user-o1'),sharer('me2','user-me'),sharer('o3','user-o2')]}:{sharers:[sharer('o1','user-o1')]});
  apps.push(mount(CallView,{target}));
 }else{
  ui.settingsSub='call';apps.push(mount(SettingsView,{target}));
 }
 await tick();await new Promise(r=>setTimeout(r,250));return true;
};
</script></body></html>`;
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'feedback-ui-fixture', enforce: 'pre', resolveId(source) { return /\/call\/instance\.svelte$/.test(source) ? join(root, 'scripts/feedback-call-fixture.svelte.ts') : null; }, configureServer(server) {
  server.middlewares.use(async(req,res,next)=>{
    // 通話の状態だけ、この確認用の偉物に差し替える（下の resolveId）
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
 let seq=0;const pending=new Map();ws.addEventListener('message',({data})=>{const m=JSON.parse(data);if(process.env.FEEDBACK_UI_DEBUG&&(m.method==='Log.entryAdded'||m.method==='Runtime.exceptionThrown'))console.error(JSON.stringify(m.params).slice(0,600));const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(new Error(JSON.stringify(m.error)));else p.resolve(m.result);});
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject,timer:setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method));},20000)});ws.send(JSON.stringify({id,method,params,sessionId}));});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});const S=(m,p)=>send(m,p,sessionId);
 const evaluate=async(expression)=>{const r=await S('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await S('Page.enable');await S('Log.enable');await S('Runtime.enable');await S('Emulation.setDeviceMetricsOverride',{width:390,height:700,deviceScaleFactor:1,mobile:true});await S('Page.navigate',{url:`http://127.0.0.1:${vite.httpServer.address().port}/__feedback_ui_fixture`});
 for(let i=0;i<150&&!(await evaluate('typeof window.renderFixture === "function"'));i++)await new Promise(r=>setTimeout(r,50));assert.equal(await evaluate('typeof window.renderFixture'),'function');
 for(const android of [true,false]){
  await evaluate(`window.renderFixture('chat',${android})`);
  const r=await evaluate(`['.attachment-image','.file-link-embed-image-img'].map(s=>{const e=document.querySelector(s);if(!e)return null;return{height:e.getBoundingClientRect().height,width:e.getBoundingClientRect().width};})`);
  // 全デバイス共通: 高さは 30vh（700px の画面で 210px）まで。縦横の比（320:1280）は保つ
  for(const item of r){assert(item,'chat image missing');assert(item.height<=210.1,(android?'Android':'desktop')+' image exceeds 30% viewport');assert(Math.abs(item.width/item.height-0.25)<0.01,'cap distorts/crops portrait aspect');}
 }
 // テーマの変数で、数字を変えられる
 await evaluate(`document.documentElement.style.setProperty('--chat-image-max-height','20vh')`);
 await evaluate(`window.renderFixture('chat',false)`);
 for(const h of await evaluate(`['.attachment-image','.file-link-embed-image-img'].map(s=>document.querySelector(s).getBoundingClientRect().height)`))assert(h<=140.1&&h>130,'theme variable --chat-image-max-height ignored');
 await evaluate(`document.documentElement.style.removeProperty('--chat-image-max-height')`);
 // 1 枚の横長・複数・寸法不明の大きさ（幅の最大と比はそのまま）
 await evaluate(`window.renderFixture('chatSizes',false)`);
 const sizes=await evaluate(`[...document.querySelectorAll('.attachment-image')].map(e=>{const r=e.getBoundingClientRect();return{w:r.width,h:r.height};})`);
 assert(sizes.length>=4,'size fixture incomplete');
 const [wide,small,unknown,rowA,rowB]=sizes;
 assert(wide.w<=320.1&&Math.abs(wide.w/wide.h-4)<0.02,'single wide image breaks long-edge cap/ratio');
 assert(Math.abs(small.w-40)<1&&Math.abs(small.h-20)<1,'small image is upscaled');
 assert(Math.abs(unknown.w-unknown.h)<1&&unknown.h<=210.1,'unknown image is not a bounded square');
 assert(rowA&&rowB&&Math.abs(rowA.h-rowB.h)<0.5&&rowA.h<=200.1,'multi-image row height not shared');
 // 通話画面: 映像が無いときは今までどおり。あるときは下半分に正方形で横に並べ、自分の今のデバイス > 自分の別のデバイス > ほかの人
 await evaluate('window.renderFixture("call","none")');
 assert.equal(await evaluate(`document.querySelectorAll('.call-view-streams').length`),0,'streams area must not exist without shares');
 assert.equal(await evaluate(`document.querySelectorAll('.call-name').length`),3);
 assert.equal(await evaluate(`[...document.querySelectorAll('.call-name')].every(e=>getComputedStyle(e).userSelect==='none'||getComputedStyle(e).webkitUserSelect==='none')`),true,'call-name must not be selectable');
 await evaluate('window.renderFixture("call","one")');
 const geo=await evaluate(`(()=>{const q=s=>document.querySelector(s).getBoundingClientRect();const b=q('.call-view-body'),s=q('.call-view-streams'),p=q('.call-view-people');return{body:b.height,streams:s.height,people:p.height,top:s.top-b.top,tiles:[...document.querySelectorAll('.screen-stage')].map(e=>{const r=e.getBoundingClientRect();return{w:r.width,h:r.height,peer:e.dataset.peer};}),overflowY:getComputedStyle(document.querySelector('.call-view-people')).overflowY,controlsCamera:!!document.querySelector('.call-view-controls [aria-label="カメラを切り替え"]')};})()`);
 assert(Math.abs(geo.streams-geo.body/2)<1.5,'streams area is not the lower half ('+JSON.stringify(geo)+')');
 assert(Math.abs(geo.people-geo.body/2)<1.5,'people area is not the upper half');
 assert.equal(geo.tiles.length,1);assert(Math.abs(geo.tiles[0].w-geo.tiles[0].h)<1.5,'stage is not square');assert(geo.tiles[0].h<=geo.streams+0.5,'stage taller than lower half');
 assert.equal(geo.overflowY,'auto');assert.equal(geo.controlsCamera,false);
 await evaluate('window.renderFixture("call","all")');
 const tiles=await evaluate(`[...document.querySelectorAll('.screen-stage')].map(e=>{const r=e.getBoundingClientRect();return{peer:e.dataset.peer,label:e.getAttribute('aria-label'),w:r.width,h:r.height,left:r.left,top:r.top};})`);
 assert.deepEqual(tiles.map(t=>t.peer),['@local','me2','o1','o3'],'order must be local > my other devices > others');
 assert(tiles.every(t=>Math.abs(t.w-t.h)<1.5&&Math.abs(t.top-tiles[0].top)<1),'stages must be equal squares in one row');
 assert(tiles.every((t,i)=>i===0||t.left>=tiles[i-1].left+tiles[i-1].w-0.5),'stages overlap horizontally');
 assert.equal(await evaluate(`(()=>{const e=document.querySelector('.call-streams-strip');return getComputedStyle(e).overflowX+'/'+getComputedStyle(e).overflowY;})()`),'auto/hidden','strip must scroll horizontally only');
 // 映像の列は、画面の幅に収まり、列の中で横にスクロールできる（画面ごと横に広がらない。縦のなぞりは奪わず、横は列が受ける）。
 // 指のなぞりそのものは、この Chromium の合成ジェスチャーでは普通のスクロール枠でも動かないので、スクロールできる条件を測る
 const strip=await evaluate(`(()=>{const e=document.querySelector('.call-streams-strip'),c=getComputedStyle(e);return{sw:e.scrollWidth,cw:e.clientWidth,ox:c.overflowX,oy:c.overflowY,ta:c.touchAction,page:document.documentElement.scrollWidth,vw:innerWidth};})()`);
 assert(strip.sw>strip.cw+100,'streams strip must overflow inside itself ('+JSON.stringify(strip)+')');assert.equal(strip.ox,'auto');assert(strip.page<=strip.vw,'page must not widen horizontally ('+JSON.stringify(strip)+')');assert(/pan-x/.test(strip.ta),'strip must allow horizontal panning');
 await evaluate(`(()=>{const e=document.querySelector('.call-streams-strip');e.scrollLeft=200;})()`);assert((await evaluate(`document.querySelector('.call-streams-strip').scrollLeft`))>100,'strip must be scrollable');
 await evaluate(`document.querySelector('.screen-stage[data-peer="o3"]').click()`);
 assert.equal(await evaluate('window.__opened'),'o3','tapping a stage opens that stream full screen');
 // 設定の押せる行: タッチのデバイス（hover: none）では、押したあと :hover が残っても明るい色にしない。マウス（hover: hover）では従来どおり色をつける
 await evaluate('window.renderFixture("settings")');
 await S('DOM.enable');await S('CSS.enable');
 const doc=await S('DOM.getDocument',{depth:-1});
 const rowNode=(await S('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'button.setting-row-button'})).nodeId;assert(rowNode,'no pressable settings row');
 const rowBg=async()=>evaluate(`getComputedStyle(document.querySelector('button.setting-row-button')).backgroundColor`);
 for(const [hover,expectTint] of [['none',false],['hover',true]]){
  await S('Emulation.setEmulatedMedia',{features:[{name:'hover',value:hover}]});
  await S('CSS.forcePseudoState',{nodeId:rowNode,forcedPseudoClasses:[]});const base=await rowBg();
  await S('CSS.forcePseudoState',{nodeId:rowNode,forcedPseudoClasses:['hover']});const hovered=await rowBg();
  await S('CSS.forcePseudoState',{nodeId:rowNode,forcedPseudoClasses:[]});
  assert.equal(hovered!==base,expectTint,`pressable row hover tint with hover:${hover} (base ${base}, hovered ${hovered})`);
 }
 await S('Emulation.setEmulatedMedia',{features:[]});
 const blank=await evaluate(`[...document.querySelectorAll('.settings-blank-bar')].map(e=>getComputedStyle(e).display)`);assert.equal(blank.length,2,'actual settings headers missing');assert(blank.every(v=>v!=='none'),'no-call headers removed');
 await evaluate(`document.querySelector('.top-slot').innerHTML='<div class="call-bar"></div>'`);
 assert.equal(await evaluate(`[...document.querySelectorAll('.settings-blank-bar')].every(e=>getComputedStyle(e).display==='none')`),true,'call leaves empty headers');
 // 設定は偽物の enumerateDevices() を読む。本物の列挙・録音・取得・AudioContext には到達しない。
 assert.deepEqual(await evaluate('window.__mediaCalls.filter(name=>name!=="enumerateDevices")'),[],'fixture attempted media capture/audio');
 console.log('feedback UI: all-device 30% image caps (+theme variable, sizes), call view lower-half square streams in order, call-name unselectable, settings header switching passed (no appearance check/media)');
}finally{ws?.close();chrome?.kill();await vite.close();rmSync(profile,{recursive:true,force:true});}
