import Phone from '@lucide/svelte/icons/phone';
import PhoneOff from '@lucide/svelte/icons/phone-off';
import MicOff from '@lucide/svelte/icons/mic-off';
import VolumeX from '@lucide/svelte/icons/volume-x';
import Headphones from '@lucide/svelte/icons/headphones';
import AudioLines from '@lucide/svelte/icons/audio-lines';
import Settings from '@lucide/svelte/icons/settings';
import { registerComposerAction } from '../composerActions';
import { APP_COMMAND_PREFIX, type AppCommand } from '../commands.svelte';
import { ui } from '../stores/ui.svelte';
import { call } from './instance.svelte';

/** 通話のコマンド（パレット・ホットキー・スラッシュコマンド） */
export function callCommands(): AppCommand[] {
  const id = (name: string) => `${APP_COMMAND_PREFIX}call-${name}`;
  return [
    // ナビゲーションバーに追加して使う（既定の並びには入れない）
    { id: id('open'), name: '通話を開く', icon: AudioLines, run: () => ui.openCall() },
    { id: id('join'), name: '通話に参加する', icon: Phone, slash: 'vc-join', description: '通話に参加する', run: () => call.join() },
    { id: id('leave'), name: '通話から抜ける', icon: PhoneOff, slash: 'vc-leave', description: '通話から抜ける', run: () => call.leave() },
    {
      id: id('mute'),
      name: '通話のミュートを切り替える',
      icon: MicOff,
      defaultHotkey: 'Mod+Shift+M',
      slash: 'vc-mute',
      description: 'マイクのミュートを切り替える',
      run: () => call.toggleMute(),
    },
    {
      id: id('deafen'),
      name: 'スピーカーミュートを切り替える',
      icon: VolumeX,
      slash: 'vc-deafen',
      description: '相手の声を全部消す（自分の側だけ）',
      run: () => call.toggleDeafen(),
    },
    {
      id: id('output'),
      name: '音の出力先を切り替える',
      icon: Headphones,
      slash: 'vc-output',
      description: '受話口・スピーカー・イヤホンなど、次の出力先に切り替える',
      run: () => call.cycleOutput(),
    },
    {
      id: id('settings'),
      name: '通話の設定を開く',
      icon: Settings,
      slash: 'vc-settings',
      description: '通話の設定を開く',
      run: () => ui.openSettingsSub('call'),
    },
  ];
}

/** 入力欄の「＋」メニューの項目を登録する */
export function registerCallComposerAction(): () => void {
  return registerComposerAction({ id: `${APP_COMMAND_PREFIX}call-join`, label: '通話に参加', icon: Headphones, run: () => call.join() });
}
