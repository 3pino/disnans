// 実際の部品の矩形・DOM だけを検査する。スクリーンショット・実機・実際のメディア取得は使わない。
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { connectCdp, launchChrome, makeProfile, openPage, stopChrome } from './cdp.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = makeProfile('disnans-feedback-ui-');
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>
<style>html,body{height:100%;margin:0}.shell-root{height:100%;display:flex;flex-direction:column}#fixture{flex:1;min-height:0}</style>
<div class="shell-root"><div class="top-slot"></div><div id="fixture"></div></div>
<script type="module">
import { mount, unmount, tick } from 'svelte';
import '/src/app.css';
import Attachments from '/src/components/Attachments.svelte';
import Markdown from '/src/components/Markdown.svelte';
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
 }else if(kind==='embedRow'){
  // 本文の画像の埋め込み（実際の Markdown）。1 段落目は 4 枚が続く横一列、2・3・4 段落目は横一列にならない形
  const E=(path)=>({type:'fileLink',path,alias:null,embed:true});const T=(t)=>({type:'text',text:t});
  apps.push(mount(Markdown,{target,props:{body:'',markdown:[
   {type:'paragraph',lines:[[E('e1.png'),T(' '),E('e2.png'),T(' '),E('e3.png'),T(' '),E('e4.png')]]},
   {type:'paragraph',lines:[[E('e1.png'),T('と'),E('e3.png')]]},
   {type:'paragraph',lines:[[E('e3.png')]]},
   {type:'paragraph',lines:[[E('e1.png'),T(' '),{type:'fileLink',path:'doc.pdf',alias:null,embed:true},T(' '),E('e2.png')]]},
  ]}}));
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
    const em=/^\/api\/shared\/(e[1-4]\.png)$/.exec(path??'');if(em){const [w,h]={'e1.png':[320,1280],'e2.png':[1600,400],'e3.png':[400,400],'e4.png':[400,300]}[em[1]];res.setHeader('Content-Type','image/svg+xml');res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#406878"/></svg>`);return;}
    if(path?.startsWith('/api/shared')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({path:'',entries:[{name:'long.png',path:'long.png',kind:'file',mime:'image/png',size:1,modified_ms:0,file_id:null},...['e1.png','e2.png','e3.png','e4.png','doc.pdf'].map(name=>({name,path:name,kind:'file',mime:name.endsWith('.pdf')?'application/pdf':'image/png',size:1,modified_ms:0,file_id:null}))]}));return;}
    if(path?.startsWith('/api/')){res.statusCode=404;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:'not_found',message:'fixture'}));return;}
    next();
  });
}}] });
let chrome,ws;
try{
 await vite.listen();const launched=launchChrome(profile);chrome=launched.child;
 ws=await connectCdp(await launched.endpoint,{timeoutMs:20_000});
 ws.onMessage((m)=>{if(process.env.FEEDBACK_UI_DEBUG&&(m.method==='Log.entryAdded'||m.method==='Runtime.exceptionThrown'))console.error(JSON.stringify(m.params).slice(0,600));});
 const S=await openPage(ws);
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
 // 本文の画像の埋め込み: 続く画像は 1 つの横一列（高さはテーマの行の高さ、列は段落の幅に収まり、はみ出しは列の中で横に動く）。文字・カードをはさむと横一列にならない。1 枚は今までどおり
 await evaluate(`window.renderFixture('embedRow',false)`);
 for(let i=0;i<60&&!(await evaluate(`[...document.querySelectorAll('.file-link-embed-image-img')].every(i=>i.complete&&i.naturalWidth>0)`));i++)await new Promise(r=>setTimeout(r,50));
 const embedGeo=`(()=>{const rows=[...document.querySelectorAll('.embed-row')];const r=rows[0];if(!r)return{rows:0};const cs=getComputedStyle(r);const items=[...r.children].map(e=>e.getBoundingClientRect());const p=r.parentElement.getBoundingClientRect(),rb=r.getBoundingClientRect();return{rows:rows.length,count:items.length,tops:items.map(b=>b.top),itemH:items.map(b=>b.height),imgH:[...r.querySelectorAll('img')].map(i=>i.getBoundingClientRect().height),rowH:rb.height,clientH:r.clientHeight,rowW:rb.width,pW:p.width,clientW:r.clientWidth,scrollW:r.scrollWidth,ox:cs.overflowX,oy:cs.overflowY,ob:cs.overscrollBehaviorX,ta:cs.touchAction,pageW:document.documentElement.scrollWidth,vw:innerWidth};})()`;
 const er=await evaluate(embedGeo);
 assert.equal(er.rows,1,'exactly one row (the four-image paragraph) '+JSON.stringify(er));
 assert.equal(er.count,4,'all four images in the row');
 assert(er.tops.every(t=>Math.abs(t-er.tops[0])<0.5),'row items must be on one line');
 assert(er.imgH.every(h=>Math.abs(h-200)<1),'row height must follow --chat-image-row-height (200px) '+JSON.stringify(er.imgH));
 assert(er.clientH<=202.5,'row is more than one line high (its own height, without the scrollbar; 200 image + 1px border each side) '+JSON.stringify(er));
 assert(er.rowW<=er.pW+0.5,'row wider than its container');
 assert(Math.abs(er.rowW-er.pW)<1,'row must fill its container width');
 assert(er.scrollW>er.clientW+100,'row must overflow inside itself '+JSON.stringify(er));
 assert.equal(er.ox,'auto');assert.equal(er.oy,'hidden');assert.equal(er.ob,'contain');assert(/pan-x/.test(er.ta),'row must allow horizontal panning');
 assert(er.pageW<=er.vw,'page must not widen horizontally');
 await evaluate(`document.querySelector('.embed-row').scrollLeft=200`);
 assert((await evaluate(`document.querySelector('.embed-row').scrollLeft`))>100,'row must scroll horizontally');
 // 文字をはさむ段落・1 枚の段落・カードをはさむ段落は横一列にならない（段落の中に並ぶ）
 const plain=await evaluate(`(()=>{const ps=[...document.querySelectorAll('.markdown-body p')];const withText=ps.find(p=>p.textContent.includes('と'));const lone=[...document.querySelectorAll('.file-link-embed-image-img')].find(i=>i.closest('p')&&i.closest('p').querySelectorAll('.file-link-embed-image').length===1&&!i.closest('.embed-row'));const card=document.querySelector('.file-link-card');return{rowsOutsideFirst:document.querySelectorAll('.embed-row').length,textImages:withText?withText.querySelectorAll('.file-link-embed-image').length:-1,textRows:withText?withText.querySelectorAll('.embed-row').length:-1,loneH:lone?lone.getBoundingClientRect().height:-1,cards:document.querySelectorAll('.file-link-card').length,cardRows:card?card.closest('.embed-row')?1:0:-1};})()`);
 assert.equal(plain.rowsOutsideFirst,1,'only the first paragraph has a row');assert.equal(plain.textImages,2,'text between images: both images stay in the text paragraph');assert.equal(plain.textRows,0,'text between images breaks the row');assert(plain.loneH>0&&Math.abs(plain.loneH-210)<1,'lone embed keeps the old height (min(320px, 30vh) at 700px)');assert.equal(plain.cards,1,'card kept as a card');assert.equal(plain.cardRows,0,'card is not in a row');
 // テーマの変数（行の高さ）で、横一列の高さが変わる
 await evaluate(`document.documentElement.style.setProperty('--chat-image-row-height','120px')`);
 assert(Math.abs((await evaluate(`[...document.querySelectorAll('.embed-row img')].map(i=>i.getBoundingClientRect().height)`))[0]-120)<1,'theme variable --chat-image-row-height ignored in a row');
 await evaluate(`document.documentElement.style.removeProperty('--chat-image-row-height')`);
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
 // この Chromium は常に hover:none を返す（hover の emulation は効かない）ので、タッチ（hover:none）は実際の計算で、マウス（hover:hover）は CSS の規則の置き場所で見る
 await S('CSS.forcePseudoState',{nodeId:rowNode,forcedPseudoClasses:[]});const baseBg=await rowBg();
 await S('CSS.forcePseudoState',{nodeId:rowNode,forcedPseudoClasses:['hover']});const hoveredBg=await rowBg();
 await S('CSS.forcePseudoState',{nodeId:rowNode,forcedPseudoClasses:[]});
 assert.equal(await evaluate('matchMedia("(hover: none)").matches'),true,'fixture must be a touch (hover:none) device');
 assert.equal(hoveredBg,baseBg,`touch: forced :hover must not tint the pressable row (base ${baseBg}, hovered ${hoveredBg})`);
 const rules=await evaluate(`(()=>{const out=[];const walk=(list,media)=>{for(const r of list){if(r.cssRules&&r.type===CSSRule.MEDIA_RULE)walk(r.cssRules,r.conditionText);else if(r.selectorText&&r.selectorText.includes('.setting-row-button:hover'))out.push({sel:r.selectorText,media,bg:r.style.background});}};for(const s of document.styleSheets){try{walk(s.cssRules,'')}catch{}}return out;})()`);
 const base=rules.filter((r)=>r.media===''),touch=rules.filter((r)=>/hover:\s*none/.test(r.media));
 assert(base.some((r)=>/--hover/.test(r.bg)),'mouse: the base :hover rule must still tint the row ('+JSON.stringify(rules)+')');
 assert(touch.length===1&&/transparent/.test(touch[0].bg),'the transparent override must exist only inside (hover: none) ('+JSON.stringify(rules)+')');
 assert(!base.some((r)=>/transparent/.test(r.bg)),'the transparent override must not apply outside (hover: none)');
 const blank=await evaluate(`[...document.querySelectorAll('.settings-blank-bar')].map(e=>getComputedStyle(e).display)`);assert.equal(blank.length,2,'actual settings headers missing');assert(blank.every(v=>v!=='none'),'no-call headers removed');
 await evaluate(`document.querySelector('.top-slot').innerHTML='<div class="call-bar"></div>'`);
 assert.equal(await evaluate(`[...document.querySelectorAll('.settings-blank-bar')].every(e=>getComputedStyle(e).display==='none')`),true,'call leaves empty headers');
 // 設定は偽物の enumerateDevices() を読む。本物の列挙・録音・取得・AudioContext には到達しない。
 assert.deepEqual(await evaluate('window.__mediaCalls.filter(name=>name!=="enumerateDevices")'),[],'fixture attempted media capture/audio');
 console.log('feedback UI: all-device 30% image caps (+theme variable, sizes), call view lower-half square streams in order, call-name unselectable, settings header switching passed (no appearance check/media)');
}finally{ws?.close();stopChrome(chrome,profile);await vite.close();}
