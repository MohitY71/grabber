import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { GrabberApi } from '../shared/api.ts';

const on = <A extends unknown[]>(ch: string) => (cb: (...a: A) => void): (() => void) => {
  const f = (_e: IpcRendererEvent, ...a: unknown[]): void => cb(...(a as A));
  ipcRenderer.on(ch, f);
  return () => { ipcRenderer.off(ch, f); };
};
const call = <T>(ch: string, ...a: unknown[]): Promise<T> => ipcRenderer.invoke(ch, ...a) as Promise<T>;

const api: GrabberApi = {
  platform: process.platform,
  list: () => call('dl:list'),
  add: (url, opts) => call('dl:add', url, opts),
  pause: (id) => call('dl:pause', id),
  resume: (id) => call('dl:resume', id),
  cancel: (id) => call('dl:cancel', id),
  pauseAll: () => call('dl:pauseAll'),
  resumeAll: () => call('dl:resumeAll'),
  remove: (id, deleteFiles) => call('dl:remove', id, deleteFiles),
  resolveConflict: (id, choice) => call('dl:resolve', id, choice),
  setPriority: (id, p) => call('dl:priority', id, p),
  schedule: (id, at) => call('dl:schedule', id, at),
  verify: (id, checksum) => call('dl:verify', id, checksum),
  reveal: (id) => call('dl:reveal', id),
  open: (id) => call('dl:open', id),
  readClipboard: () => call('clipboard:read'),
  getSettings: () => call('settings:get'),
  setSettings: (p) => call('settings:set', p),
  pickDir: () => call('settings:pickDir'),
  appInfo: () => call('app:info'),
  engineStatus: () => call('engine:status'),
  updateEngine: () => call('engine:update'),
  openExternal: (url) => call('app:openExternal', url),
  copyText: (t) => call('app:copy', t),
  scanFrames: (id) => call('browser:scan', id),
  hlsQualities: (url, referer) => call('hls:qualities', url, referer),
  adblockStatus: () => call('adblock:status'),
  adblockUpdate: () => call('adblock:update'),
  adblockToggleSite: (host) => call('adblock:toggleSite', host),
  apiInfo: () => call('api:info'),
  revealExtension: () => call('api:revealExtension'),
  onUpdate: on('dl:update'),
  onRemoved: on('dl:removed'),
  onSniff: on('sniff:hit'),
  onCmd: on('browser:cmd'),
  onAdblockCount: on('adblock:count'),
  onAdblockStatus: on('adblock:status'),
};
contextBridge.exposeInMainWorld('grabber', api);
