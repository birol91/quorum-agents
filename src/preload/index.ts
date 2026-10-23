import { contextBridge, ipcRenderer } from 'electron';
import type { IpcChannel, IpcEnvelope, IpcInput, IpcOutput, QuorumEvent } from '../shared/ipc.ts';

const api = {
  invoke: <C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcEnvelope<IpcOutput<C>>> =>
    ipcRenderer.invoke(channel, input),
  onEvent: (cb: (event: QuorumEvent) => void): (() => void) => {
    const listener = (_e: unknown, evt: QuorumEvent): void => cb(evt);
    ipcRenderer.on('quorum:event', listener);
    return () => ipcRenderer.removeListener('quorum:event', listener);
  },
};

contextBridge.exposeInMainWorld('quorum', api);

export type QuorumBridge = typeof api;
