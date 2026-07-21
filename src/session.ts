import { EventEmitter } from 'node:events';
import type { SessionState } from './types.ts';
import { importEsm } from './esm-import.ts';

// The Agent SDK is ESM-only; a CJS main (required by Electron 33) can't `import`
// it statically. Load it lazily so this module works from both CJS and ESM.
const loadQuery = (): Promise<typeof import('@anthropic-ai/claude-agent-sdk').query> =>
  importEsm<typeof import('@anthropic-ai/claude-agent-sdk')>('@anthropic-ai/claude-agent-sdk').then((m) => m.query);

// Turn an assistant stream message into a short "what is it doing right now"
// label for the live UI. Returns null if nothing worth showing.
function describeActivity(msg: { message?: { content?: unknown } }): string | null {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return null;
  let text = false;
  for (const block of content as { type: string; name?: string; input?: { to?: string } }[]) {
    if (block.type === 'tool_use') {
      const n = block.name ?? 'a tool';
      if (n === 'Task' || n === 'Agent') return 'delegating to a subagent…';
      if (n === 'Write' || n === 'Edit' || n === 'MultiEdit') return 'writing a file…';
      if (n === 'Bash') return 'running a command…';
      if (n === 'Read' || n === 'Glob' || n === 'Grep') return 'reading files…';
      if (n === 'WebSearch' || n === 'WebFetch') return 'searching the web…';
      // send_message labels come from the BUS (delivery outcome, first-hand
      // truth incl. reroutes/bounces) — the stream only shows intent, and a
      // multi-send turn or half-streamed input can mislabel the target.
      if (n.includes('send_message')) return null;
      if (n.includes('record_decision')) return 'recording a decision…';
      if (n.includes('_task')) return 'updating the task board…';
      return `using ${n.replace(/^mcp__quorum__/, '')}…`;
    }
    if (block.type === 'text') text = true;
    if (block.type === 'thinking') return 'thinking…';
  }
  return text ? 'typing a reply…' : null;
}

/** Child sessions run on subscription auth, without this process's Claude Code context. */
export function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE')) delete env[k];
  delete env.ANTHROPIC_API_KEY;
  return env;
}

export interface SdkSessionOptions {
  name: string;
  systemPrompt: string;
  model?: string;
  /** Reasoning effort (SDK default: 'high'); unsupported models downgrade silently. */
  effort?: string;
  cwd?: string;
  /** Resume a previous conversation by session id (official persistence). */
  resume?: string;
  mcpServers?: Record<string, unknown>;
  /** Pre-approved tools (bypass canUseTool — use for quorum tools only). */
  allowedTools?: string[];
  canUseTool?: (toolName: string, input: Record<string, unknown>) => Promise<unknown>;
  onEvent?: (msg: Record<string, unknown>) => void;
}

interface InputQueue {
  push(text: string): void;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

function makeInputQueue(): InputQueue {
  const buf: (Record<string, unknown> | null)[] = [];
  let notify: (() => void) | undefined;
  return {
    push(text: string) {
      buf.push({ type: 'user', message: { role: 'user', content: text } });
      notify?.();
    },
    close() {
      buf.push(null);
      notify?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (buf.length === 0) await new Promise<void>((r) => (notify = r));
        const item = buf.shift();
        if (item === null) return;
        yield item;
      }
    },
  };
}

/**
 * One live `claude` session via the Agent SDK (transport decision, P0 E3).
 * Turn lifecycle comes from the stream's own events: `result` = turn done.
 * Emits: 'init' (session id known), 'idle' (turn finished), 'offline' (process gone).
 */
export class SdkSession extends EventEmitter {
  readonly name: string;
  readonly done: Promise<void>;
  sessionId: string | null = null;
  usage = { in: 0, out: 0, turns: 0 };
  #state: SessionState = 'idle';
  #input = makeInputQueue();
  #query: { interrupt?: () => Promise<void> } | null = null;

  get state(): SessionState {
    return this.#state;
  }

  constructor(opts: SdkSessionOptions) {
    super();
    this.name = opts.name;

    this.done = (async () => {
      const query = await loadQuery();
      const q = query({
        prompt: this.#input as AsyncIterable<never>,
        options: {
          cwd: opts.cwd ?? process.cwd(),
          env: cleanEnv(),
          model: opts.model ?? 'haiku',
          effort: opts.effort,
          systemPrompt: opts.systemPrompt,
          permissionMode: 'default',
          strictMcpConfig: true,
          settingSources: [],
          resume: opts.resume,
          mcpServers: opts.mcpServers as never,
          allowedTools: opts.allowedTools,
          canUseTool: opts.canUseTool as never,
        } as never,
      });
      this.#query = q as unknown as { interrupt?: () => Promise<void> };
      try {
        for await (const raw of q) {
          const msg = raw as unknown as { type: string; subtype?: string; [k: string]: unknown };
          opts.onEvent?.(msg);
          if (msg.type === 'system' && msg.subtype === 'init') {
            this.sessionId = (msg as { session_id?: string }).session_id ?? null;
            this.emit('init');
          }
          // Surface what the agent is doing right now, for live UI feedback.
          if (msg.type === 'assistant') {
            const a = describeActivity(msg as { message?: { content?: unknown } });
            if (a) this.emit('activity', a);
          }
          if (msg.type === 'result') {
            const usage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
            this.usage.in += usage?.input_tokens ?? 0;
            this.usage.out += usage?.output_tokens ?? 0;
            this.usage.turns += 1;
            this.#state = 'idle';
            this.emit('idle');
          }
        }
      } finally {
        if (this.#state !== 'offline') {
          this.#state = 'offline';
          this.emit('offline');
        }
      }
    })();
  }

  /** Start a turn. The bus only calls this when the session is idle. */
  write(text: string): void {
    if (this.#state !== 'idle') throw new Error(`${this.name}: write while ${this.#state}`);
    this.#state = 'busy';
    this.emit('busy'); // let the UI light up the block immediately
    this.#input.push(text);
  }

  /**
   * Abort the in-flight turn via the SDK's documented interrupt() (streaming
   * input mode). The SDK emits the turn's `result` after aborting, so state
   * returns to idle through the normal event path. No-op when not busy.
   */
  async interrupt(): Promise<void> {
    if (this.#state !== 'busy') return;
    await this.#query?.interrupt?.().catch(() => {});
  }

  /** Orderly shutdown: wait for the in-flight turn, then end input (E5 lesson). */
  async close(): Promise<void> {
    while (this.#state === 'busy') {
      await new Promise<void>((resolve) => {
        const onSettle = () => {
          this.off('idle', onSettle);
          this.off('offline', onSettle);
          resolve();
        };
        this.once('idle', onSettle);
        this.once('offline', onSettle);
      });
    }
    this.#input.close();
    await this.done.catch(() => {});
  }
}
