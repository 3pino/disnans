import { orientationLock, nativeOrientation, type OrientationMode } from '../orientation';
import { deviceSettings } from './deviceSettings.svelte';
import { setScreenOrientation } from '../systemBars';
import { ui } from './ui.svelte';

/**
 * Android の画面の向き。設定（端末ごと）と、全画面のメディアを見ているかで、ネイティブの向きの固定を決めて渡す。
 * 全画面の検知: 写真の全画面（ui.lightbox）と、プラグインの没入モード（ui.setImmersive が成功したとき）。
 */
class Orientation {
  /** 画面の向きの設定（この端末だけ。deviceSettings の値） */
  get mode(): OrientationMode {
    return deviceSettings.orientation;
  }
  /** プラグインが没入モード（全画面の画面共有など）にしているか */
  immersive = $state(false);
  private started = false;

  /** 全画面のメディアを見ているか */
  readonly mediaFullscreen = $derived(this.immersive || ui.lightbox !== null);
  readonly lock = $derived(orientationLock(this.mode, this.mediaFullscreen));

  set(mode: OrientationMode): void {
    deviceSettings.set('orientation', mode);
    this.push();
  }

  setImmersive(on: boolean): void {
    this.immersive = on;
  }

  /** ネイティブへ、いまの向きを渡す（Android 以外では何もしない）。保存は Kotlin 側が行い、次の起動で読み込みの前に使う */
  private push(): void {
    setScreenOrientation(nativeOrientation(this.lock)).catch((e) => console.warn('画面の向きを切り替えられませんでした', e));
  }

  /** 起動のあとに1回呼ぶ。読み込み後にも同じ値を渡し直し、以後は向きが変わるたびに渡す */
  start(): void {
    if (this.started) return;
    this.started = true;
    $effect.root(() => {
      $effect(() => {
        void this.lock;
        this.push();
      });
    });
  }
}

export const orientation = new Orientation();
