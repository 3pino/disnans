import { pluginScreenCaptureApi as capture, validateCallRelay as validate } from '../media/nativeScreen';
import { MediaError } from '../media/errors';
import { PluginError } from './errors';

// 公開 SDK の互換口。本体の通話は media/nativeScreen を直接使う。
export { pipApi, decodeSnapshotBytes, toCaptureError, toSnapshotError } from '../media/nativeScreen';

function pluginError(error: unknown): never {
  if (error instanceof MediaError) throw new PluginError(error.code, error.message);
  throw error;
}

export function validateCallRelay(value: unknown): Disnans.ScreenCallRelay {
  try { return validate(value); } catch (error) { return pluginError(error); }
}

export const screenCaptureApi: Disnans.ScreenCapture = {
  get supported() { return capture.supported; },
  get supportsCallRelay() { return capture.supportsCallRelay; },
  start: (options, onFrame) => capture.start(options, onFrame).catch(pluginError),
  update: (patch) => capture.update(patch).catch(pluginError),
  stop: () => capture.stop().catch(pluginError),
  snapshot: () => capture.snapshot().catch(pluginError),
};
