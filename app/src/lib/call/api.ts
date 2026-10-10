import type { CallStore } from './store.svelte';

// プラグイン向けの通話 API（disnans.call。API v7）。型は packages/plugin-sdk/index.d.ts の Disnans.Call

type ToUser = (id: string) => Disnans.User;

export function createCallApi(call: CallStore, toUser: ToUser): Disnans.Call {
  return {
    get joined() {
      return call.joined;
    },
    get canVideo() {
      return call.canVideo;
    },
    get participants() {
      return call.participants.map((p) => ({
        peer: p.peer,
        user: toUser(p.userId),
        self: p.self,
        muted: p.muted,
        deafened: p.deafened,
        canVideo: p.canVideo,
        connected: p.connected,
        speaking: p.speaking,
        device: p.device,
      }));
    },
    get remoteTracks() {
      return call.remoteTracks.map((t) => ({ peer: t.peer, user: toUser(t.userId), track: t.track, stream: t.stream }));
    },
    join: () => call.join(),
    leave: () => call.leave(),
    addTrack: (track, stream) => call.addTrack(track, stream),
    removeTrack: (track) => call.removeTrack(track),
    onChange: (cb) => call.onChange(cb),
    onTrack: (cb) => call.onTrack((t) => cb({ peer: t.peer, user: toUser(t.userId), track: t.track, stream: t.stream })),
    onTrackEnd: (cb) => call.onTrackEnd((t) => cb({ peer: t.peer, user: toUser(t.userId), track: t.track, stream: t.stream })),
    addButton: (opts) => call.addBarButton(opts),
  };
}
