import type { CallStore } from './store.svelte';

// プラグイン向けの通話 API（disnans.call。API v8）。型は packages/plugin-sdk/index.d.ts の Disnans.Call

type ToUser = (id: string) => Disnans.User;

export function createCallApi(call: CallStore, toUser: ToUser): Disnans.Call {
  return {
    get joined() {
      return call.joined;
    },
    get participants() {
      return call.participants.map((p) => ({
        peer: p.peer,
        user: toUser(p.userId),
        self: p.self,
        muted: p.muted,
        deafened: p.deafened,
        connected: p.connected,
        speaking: p.speaking,
        device: p.device,
      }));
    },
    join: () => call.join(),
    leave: () => call.leave(),
    emit: (name, payload) => call.emit(name, payload),
    onEvent: (name, cb) => call.onEvent(name, (e) => cb({ peer: e.peer, user: toUser(e.userId), payload: e.payload })),
    onChange: (cb) => call.onChange(cb),
    addButton: (opts) => call.addBarButton(opts),
  };
}
