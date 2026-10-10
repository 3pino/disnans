// リレー用に、マイクの音を取り出す（AudioWorklet が使えなければ ScriptProcessor）。ブラウザーの API に依存するので純粋ではない

export type Capture = { stop(): void };

/**
 * src の音を、AudioContext の周波数のまま onChunk に渡し続ける。stop() で止める
 */
export function startCapture(ctx: AudioContext, src: AudioNode, onChunk: (chunk: Float32Array) => void): Capture {
  let stopped = false;
  const handle: Capture = {
    stop() {
      stopped = true;
    },
  };
  // 音を出さずに動かし続けるための出口
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sink.connect(ctx.destination);
  const useScriptProcessor = () => {
    if (stopped) return;
    try {
      const node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (ev) => onChunk(new Float32Array(ev.inputBuffer.getChannelData(0)));
      src.connect(node);
      node.connect(sink);
      handle.stop = () => {
        stopped = true;
        node.onaudioprocess = null;
        node.disconnect();
        sink.disconnect();
      };
    } catch (err) {
      console.error('[call] マイクの音を取り出せません。リレーで送れません', err);
    }
  };
  try {
    if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') throw new Error('AudioWorklet なし');
    const code =
      "class C extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('call-capture',C)";
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    ctx.audioWorklet
      .addModule(url)
      .then(() => {
        if (stopped) return;
        const node = new AudioWorkletNode(ctx, 'call-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        node.port.onmessage = (ev) => onChunk(ev.data);
        src.connect(node);
        node.connect(sink);
        handle.stop = () => {
          stopped = true;
          node.port.onmessage = null;
          node.disconnect();
          sink.disconnect();
        };
      })
      .catch((err) => {
        console.warn('[call] AudioWorklet を使えません。ScriptProcessor で代わりにします', err);
        useScriptProcessor();
      })
      .finally(() => URL.revokeObjectURL(url));
  } catch {
    useScriptProcessor();
  }
  return handle;
}
