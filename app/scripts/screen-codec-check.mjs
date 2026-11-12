// 合成画面だけで減色誤差・実際の符号化サイズ・処理時間を測る。実機、画面取得、マイク、見た目の判定は行わない。
// CHROME で Chromium の実行ファイルを指定できる。数値はこの環境の合成画像に限り、実通信量を保証しない。
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { connectCdp, launchChrome, makeProfile, openPage, stopChrome } from './cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = makeProfile('disnans-screen-codec-');
const html = `<!doctype html><html><head></head><body><script type="module">
import { applyColorMode, encodeFrame } from '/src/lib/call/screen/codec.ts';
window.runBench = () => {
 const w=640,h=360, rows=[];
 const canvas=()=>{const c=document.createElement('canvas'); c.width=w; c.height=h; return c;};
 const oldMode=(d)=>{for(let i=0;i<d.length;i+=4){d[i]=Math.round((d[i]>>5)*255/7);d[i+1]=Math.round((d[i+1]>>5)*255/7);d[i+2]=Math.round((d[i+2]>>6)*255/3);}};
 const error=(a,b)=>{let e=0;for(let i=0;i<a.length;i+=4)for(let c=0;c<3;c++)e+=Math.abs(a[i+c]-b[i+c]);return e/(a.length/4*3);};
 const size=(source)=>{const encoded=encodeFrame(canvas(),source,w,h,{color:'full',quality:0.7,format:'image/jpeg'});return Math.floor(encoded.b64.length*3/4);};
 const compressed=(pixels)=>{const c=canvas(),ctx=c.getContext('2d');ctx.putImageData(new ImageData(pixels,w,h),0,0); const sizes=['image/png','image/webp'].map(m=>{const s=c.toDataURL(m,0.7);return Math.floor((s.length-s.indexOf(',')-1)*3/4);});return Math.min(...sizes);};
 for(const name of ['blue-tint','screen-ui','gradient']){
  const c=canvas(),ctx=c.getContext('2d');
  if(name==='blue-tint'){ctx.fillStyle='rgb(80,100,110)';ctx.fillRect(0,0,w,h);}
  else if(name==='screen-ui'){
   ctx.fillStyle='#18232d';ctx.fillRect(0,0,w,h);ctx.fillStyle='#243946';ctx.fillRect(0,0,155,h);
   for(let y=15;y<h;y+=30){ctx.fillStyle=['#50646e','#729caf','#a0b7c3','#d3e5ed'][Math.floor(y/30)%4];ctx.fillRect(175,y,400,18);ctx.fillStyle='#192a35';ctx.font='14px sans-serif';ctx.fillText('Synthetic text 0123456789',180,y+14);}
  }else{
   const p=ctx.createImageData(w,h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;p.data[i]=x*255/(w-1);p.data[i+1]=y*255/(h-1);p.data[i+2]=(Math.sin(x/40)*0.5+0.5)*255;p.data[i+3]=255;}ctx.putImageData(p,0,0);
  }
  const source=ctx.getImageData(0,0,w,h).data,old=source.slice(),next=source.slice();oldMode(old);
  const start=performance.now();applyColorMode(next,'c256');const ms=performance.now()-start;
  const colors=new Set();for(let i=0;i<next.length;i+=4)colors.add((next[i]<<16)|(next[i+1]<<8)|next[i+2]);
  rows.push({name,width:w,height:h,oldRgbError:error(source,old),newRgbError:error(source,next),colors:colors.size,oldBytes:compressed(old),newBytes:compressed(next),fullJpegBytes:size(c),quantizeMs:ms});
 }
 return rows;
};
</script></body></html>`;
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, plugins: [{
  name: 'screen-codec-synthetic-fixture',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.split('?')[0] !== '/__screen_codec_fixture') return next();
      try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__screen_codec_fixture', html)); }
      catch (error) { res.statusCode = 500; res.end(String(error)); }
    });
  },
}] });
let chrome, ws;
try {
  await vite.listen();
  const launched = launchChrome(profile);
  chrome = launched.child;
  // 合成画面の計測は時間がかかるので、送信の待ち時間は 30 秒
  ws = await connectCdp(await launched.endpoint, { timeoutMs: 30_000 });
  const S = await openPage(ws);
  const evaluate = async (expression) => { const r = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await S('Page.enable'); await S('Page.navigate', { url: `http://127.0.0.1:${vite.httpServer.address().port}/__screen_codec_fixture` });
  for (let i=0; i<150 && !(await evaluate('typeof window.runBench === "function"')); i++) await new Promise(r=>setTimeout(r,50));
  assert.equal(await evaluate('typeof window.runBench'), 'function');
  const rows = await evaluate('window.runBench()');
  for (const r of rows) { assert(r.colors <= 256, 'palette exceeds256'); assert(r.newBytes > 0, 'no encoded frame'); }
  const blue = rows.find(r=>r.name==='blue-tint'); assert(blue.newRgbError < blue.oldRgbError, 'blue hue regression not improved');
  console.log(JSON.stringify({ syntheticOnly: true, noMediaCapture: true, rows }, null, 2));
} finally {
  ws?.close(); stopChrome(chrome, profile); await vite.close();
}
