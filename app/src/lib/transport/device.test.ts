import { describe, expect, it, vi } from 'vitest';
import { createDeviceApi } from './device';
import { HttpError } from './http';

const ctx = { server: () => 'https://disnans.example', devUser: 'alice' };

describe('createDeviceApi（一覧・削除の口）', () => {
  it('一覧は api_devices_list を Base の形で呼ぶ（設定は読まない）', async () => {
    const invoke = vi.fn(async () => [{ device_id: 'd1', name: '自宅', created_at: 1, last_seen_at: 2, has_prefs: true }]);
    const api = createDeviceApi(invoke as never, ctx);
    const list = await api.list();
    expect(list).toEqual([{ device_id: 'd1', name: '自宅', created_at: 1, last_seen_at: 2, has_prefs: true }]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('api_devices_list', { args: { server: 'https://disnans.example', devUser: 'alice' } });
  });

  it('一覧の応答が無い（null）ときは空の一覧', async () => {
    const api = createDeviceApi((async () => null) as never, ctx);
    expect(await api.list()).toEqual([]);
  });

  it('削除は api_device_delete を id つきで呼ぶ。成功は何も返さない', async () => {
    const invoke = vi.fn(async () => null);
    const api = createDeviceApi(invoke as never, ctx);
    await expect(api.remove('d1')).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('api_device_delete', {
      args: { server: 'https://disnans.example', devUser: 'alice', id: 'd1' },
    });
  });

  it('削除の失敗は HttpError（状態のコードつき）にそろえる', async () => {
    const invoke = vi.fn(async () => {
      throw { status: 404, code: 'not_found', message: 'デバイスがありません' };
    });
    const api = createDeviceApi(invoke as never, ctx);
    const err = await api.remove('d1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
  });
});
