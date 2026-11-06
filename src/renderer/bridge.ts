import type { QuorumBridge } from '../preload/index.ts';
import type { IpcChannel, IpcInput, IpcOutput } from '../shared/ipc.ts';

declare global {
  interface Window {
    quorum: QuorumBridge;
  }
}

const bridge = window.quorum;

export async function invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcOutput<C>> {
  const res = await bridge.invoke(channel, input);
  if (!res.ok) throw new Error(res.error.message);
  return res.data;
}

export const onEvent = bridge.onEvent;
