// disnans.ui.pickSharedFiles: 共有フォルダの選ぶ画面（components/SharedPicker.svelte）を開き、選んだ項目を返す。取り消しは null。
// 画面は本体に 1 つ mount して、選んだら外す（プラグインの権限は、呼ぶ側の files が決める。この口は files を要求しない）

import { mount, unmount, untrack } from 'svelte';
import SharedPicker from '../../components/SharedPicker.svelte';
import type { SharedEntry } from '../protocol/SharedEntry';

export type PickOptions = { multiple?: boolean; folderOnly?: boolean };

export function pickSharedFiles(opts: PickOptions = {}): Promise<SharedEntry[] | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.append(host);
    let done = false;
    let app: ReturnType<typeof mount> | null = null;
    const finish = (picked: SharedEntry[] | null): void => {
      if (done) return;
      done = true;
      if (app) void unmount(app);
      host.remove();
      resolve(picked);
    };
    app = untrack(() =>
      mount(SharedPicker, {
        target: host,
        props: { multiple: !!opts.multiple, folderOnly: !!opts.folderOnly, ondone: finish },
      }),
    );
  });
}
