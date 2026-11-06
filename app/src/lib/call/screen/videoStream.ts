/**
 * カメラの映像（MediaStream）を <video> に入れる Svelte の action。src ではなく srcObject に入れる。
 * カメラを切り替えると新しいストリームに差し替わるので、そのとき必ず再生し直す
 * （srcObject を替えただけでは autoplay の無い video は止まったままで、映像が消える）。
 */
export function videoStream(el: HTMLVideoElement, s: MediaStream) {
  const attach = (next: MediaStream) => {
    el.srcObject = next;
    void el.play().catch(() => {});
  };
  attach(s);
  return {
    update(next: MediaStream) {
      if (el.srcObject !== next) attach(next);
    },
    destroy() {
      el.srcObject = null;
    },
  };
}
