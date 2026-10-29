// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import SharedEntryActions from './SharedEntryActions.svelte';
import type { SharedEntry } from '../lib/protocol/SharedEntry';

const original: SharedEntry = {
  name: 'report.txt', path: 'docs/report.txt', kind: 'file', size: 4,
  modified: 0, mime: 'text/plain', message_id: null, file_id: null,
};
const id = '00000000000000000000000001';
const retained: SharedEntry = {
  ...original,
  name: `${id}--report.txt`,
  path: `.trash/${id}--report.txt`,
  trash: { kind: 'item', entry: {
    id, original_path: original.path, kind: 'file', size: 4, deleted_at: 1,
    trash_path: `.trash/${id}--report.txt`,
  } },
};
let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
});

it.each([original, retained])('項目メニューは元の名前で読み上げ、プロパティだけを出す ($path)', (entry) => {
  const snapshot = structuredClone(entry);
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(SharedEntryActions, { target, props: { entry } });
  flushSync();
  const button = target.querySelector<HTMLButtonElement>('button[aria-label="report.txt の操作"]');
  expect(button).not.toBeNull();
  button!.click();
  flushSync();
  expect([...target.querySelectorAll('.shared-entry-menu-item')].map((e) => e.textContent?.trim()))
    .toEqual(['プロパティ']);
  expect(entry).toEqual(snapshot);
});
