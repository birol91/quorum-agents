import type { PermissionMode, PermissionRequest } from '../shared/ipc.ts';

interface Pending {
  request: PermissionRequest;
  resolve: (behavior: 'allow' | 'deny') => void;
}

// Tools that modify the world. Under 'read' they are denied outright; under
// 'write' they prompt the user; under 'both' everything is auto-allowed.
const WRITE_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Bridges a session's canUseTool callback (which must return a promise) to the
 * UI: each non-quorum tool call becomes a permission card the user resolves.
 * State lives in mechanism, never in the model.
 */
export class PermissionBroker {
  private seq = 0;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly onRequest: (r: PermissionRequest) => void,
    private readonly onResolved: (id: string) => void,
  ) {}

  /**
   * Returns a canUseTool implementation for the named agent. `mode()` is read
   * live on each call so a mid-session change (via updateAgent) takes effect.
   */
  callbackFor(agent: string, mode: () => PermissionMode) {
    return (toolName: string, input: Record<string, unknown>): Promise<{ behavior: 'allow' | 'deny'; message?: string; updatedInput?: Record<string, unknown> }> => {
      const isWrite = WRITE_TOOLS.has(toolName);
      const m = mode();
      if (m === 'both' || (m === 'read' && !isWrite)) {
        return Promise.resolve({ behavior: 'allow', updatedInput: input });
      }
      if (m === 'read' && isWrite) {
        return Promise.resolve({ behavior: 'deny', message: `${agent} is read-only; ${toolName} not allowed.` });
      }
      // mode 'write': prompt the user.
      const id = `perm-${++this.seq}`;
      const request: PermissionRequest = { id, agent, toolName, input };
      return new Promise((resolve) => {
        this.pending.set(id, {
          request,
          resolve: (behavior) => {
            this.pending.delete(id);
            this.onResolved(id);
            resolve(
              behavior === 'allow'
                ? { behavior: 'allow', updatedInput: input }
                : { behavior: 'deny', message: 'Denied by user' },
            );
          },
        });
        this.onRequest(request);
      });
    };
  }

  resolve(id: string, behavior: 'allow' | 'deny'): void {
    this.pending.get(id)?.resolve(behavior);
  }

  /** Deny everything still open — used on shutdown so no turn hangs forever. */
  denyAll(): void {
    for (const p of [...this.pending.values()]) p.resolve('deny');
  }
}
