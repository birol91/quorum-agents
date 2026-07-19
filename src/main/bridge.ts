// The Claude Code bridge: a localhost MCP server that lets an EXTERNAL Claude
// Code session act as the team's lead. The user converses in their editor
// (rich markdown), Quorum stays what it is — transport + visualization — and
// the canvas shows the agent-to-agent traffic live. MCP is a sanctioned
// integration point (brief §3.6); the server binds to 127.0.0.1 only.
//
// Tools (stateless Streamable HTTP, one server per request):
//   quorum.ask(text, selected?)  — same routing as the meeting-room composer
//                                  (@name / @everyone / selected group / lead)
//   quorum.roster()              — agents with live state
//   quorum.replies(wait_seconds) — long-poll: drain user-bound replies
import { createServer, type Server as HttpServer } from 'node:http';
import type { BusMessage } from '../types.ts';
import type { AgentView } from '../shared/ipc.ts';

export type LeadLevel = 'off' | 'working' | 'driving';

export interface BridgeDeps {
  ask: (text: string, selected: string[]) => number;
  roster: () => AgentView[];
  /** The open project dir — only lead sessions working inside it count. */
  projectDir: () => string;
  /** Fired on transitions of the lead's activity level. */
  onActivity?: (level: LeadLevel) => void;
  trace?: (line: string) => void;
}

const MAX_WAIT_S = 240;
// Bright glow lingers briefly after the last bridge call, so the lead doesn't
// flicker in the natural gap between ask() and the next replies().
const DRIVING_LINGER_MS = 15_000;
// A session's "I'm working" claim (hook telemetry) expires unless refreshed —
// bounds stale glow when a Stop hook is missed (crash / hard interrupt).
const CLAIM_TTL_MS = 120_000;

export class QuorumBridge {
  private readonly inbox: BusMessage[] = [];
  private readonly waiters: (() => void)[] = [];
  private http: HttpServer | null = null;
  // Two independent signals, merged into one level (driving wins):
  // - driving: a bridge tool call in flight (first-party — our own endpoint)
  // - working: live session claims from Claude Code hooks (SECONDARY telemetry
  //   per brief §3.6 — purely cosmetic, nothing depends on it)
  private inFlight = 0;
  private lingerUntil = 0;
  private readonly claims = new Map<string, number>(); // session_id -> expiry
  private level: LeadLevel = 'off';
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: BridgeDeps) {}

  private computeLevel(): LeadLevel {
    if (this.inFlight > 0 || Date.now() < this.lingerUntil) return 'driving';
    for (const [id, exp] of this.claims) if (exp <= Date.now()) this.claims.delete(id);
    return this.claims.size > 0 ? 'working' : 'off';
  }

  private refreshLevel(): void {
    const next = this.computeLevel();
    if (next !== this.level) {
      this.level = next;
      this.deps.onActivity?.(next);
    }
    // Keep a lazy sweep alive while anything could still expire.
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    if (next !== 'off') this.sweepTimer = setTimeout(() => this.refreshLevel(), 5_000);
  }

  private beginActivity(): void {
    this.inFlight++;
    this.refreshLevel();
  }

  private endActivity(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight === 0) this.lingerUntil = Date.now() + DRIVING_LINGER_MS;
    this.refreshLevel();
  }

  /**
   * Hook telemetry from Claude Code sessions (UserPromptSubmit / PostToolUse
   * refresh a claim; Stop drops it). Only sessions whose cwd is inside the
   * open project count — the block means THIS project's lead.
   */
  private leadPing(payload: { hook_event_name?: string; session_id?: string; cwd?: string }): void {
    const { hook_event_name: event, session_id: id, cwd } = payload;
    if (!id || !cwd) return;
    const root = this.deps.projectDir();
    if (!root || !(cwd === root || cwd.startsWith(`${root}/`))) return;
    if (event === 'Stop') this.claims.delete(id);
    else this.claims.set(id, Date.now() + CLAIM_TTL_MS);
    this.refreshLevel();
  }

  /** Called by main for every message actually delivered to the user. */
  pushReply(m: BusMessage): void {
    this.inbox.push(m);
    for (const w of this.waiters.splice(0)) w();
  }

  private async drain(waitMs: number): Promise<BusMessage[]> {
    if (this.inbox.length === 0 && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.inbox.splice(0);
  }

  private tools() {
    return [
      {
        name: 'ask',
        description:
          'Send a task/question into the Quorum team. Routing follows the meeting-room rules: ' +
          '"@name …" → that agent (single target), "@everyone …" → coordinated group task to all, ' +
          'selected=[a,b] → group task to exactly those agents, plain text → the in-app lead if one is set. ' +
          'Returns how many agents it was routed to. Use replies() to collect the answers.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The message; may start with @name or @everyone' },
            selected: { type: 'array', items: { type: 'string' }, description: 'Group-task recipients (no mention)' },
          },
          required: ['text'],
        },
      },
      {
        name: 'roster',
        description: 'The current team: name, description, lead flag, live state (idle/busy/offline), model.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'replies',
        description:
          `Collect replies addressed to the user. The response also lists agents still busy, so an empty ` +
          `result means "still working" when busy is non-empty. Long-polls up to wait_seconds (default 45 — keep it under ` +
          `your MCP request timeout; max ${MAX_WAIT_S}) until at least one reply arrives, then returns and ` +
          'clears everything collected so far. Call repeatedly until you have the replies you expect ' +
          '(group tasks: one per participant).',
        inputSchema: {
          type: 'object',
          properties: {
            wait_seconds: { type: 'number', description: `How long to wait if empty (0-${MAX_WAIT_S})` },
          },
        },
      },
    ];
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    // Tool calls (not listTools handshakes) mean the lead is actively driving.
    this.beginActivity();
    try {
      return await this.dispatchTool(name, args);
    } finally {
      this.endActivity();
    }
  }

  private async dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (name === 'roster') {
      const agents = this.deps.roster().map((a) => ({
        name: a.name,
        desc: a.desc,
        lead: a.lead,
        state: a.state,
        model: a.model,
      }));
      return JSON.stringify({ agents }, null, 2);
    }
    if (name === 'ask') {
      const text = String(args.text ?? '').trim();
      if (!text) return 'ERROR: text is required';
      const selected = Array.isArray(args.selected) ? args.selected.map(String) : [];
      const routed = this.deps.ask(text, selected);
      return routed > 0
        ? `Routed to ${routed} agent(s). Collect answers with replies().`
        : 'Routed to 0 agents — unknown @mention/selection, or the team is empty (no lead fallback).';
    }
    if (name === 'replies') {
      const wait = Math.max(0, Math.min(Number(args.wait_seconds ?? 45), MAX_WAIT_S));
      const msgs = await this.drain(wait * 1000);
      // `busy` disambiguates an empty result: agents still working vs done.
      const busy = this.deps.roster().filter((a) => a.state === 'busy').map((a) => a.name);
      return JSON.stringify(
        { replies: msgs.map((m) => ({ from: m.from, content: m.content, at: m.at })), busy },
        null,
        2,
      );
    }
    return `ERROR: unknown tool ${name}`;
  }

  /** Start the localhost HTTP endpoint. Never throws — a busy port logs and disables the bridge. */
  listen(port: number): void {
    // Lazy-require the MCP SDK (CJS build) — one stateless server per request.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
    /* eslint-enable @typescript-eslint/no-require-imports */

    this.http = createServer((req, res) => {
      if (req.method !== 'POST' || (req.url !== '/mcp' && req.url !== '/lead-activity')) {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
            if (req.url === '/lead-activity') {
              this.leadPing(body as { hook_event_name?: string; session_id?: string; cwd?: string });
              res.writeHead(204).end();
              return;
            }
            const server = new Server(
              { name: 'quorum', version: '1.0.0' },
              { capabilities: { tools: {} } },
            );
            server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.tools() }));
            server.setRequestHandler(CallToolRequestSchema, async (r: { params: { name: string; arguments?: Record<string, unknown> } }) => ({
              content: [{ type: 'text', text: await this.callTool(r.params.name, r.params.arguments ?? {}) }],
            }));
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            res.on('close', () => {
              void transport.close();
              void server.close();
            });
            await server.connect(transport);
            await transport.handleRequest(req, res, body);
          } catch (err) {
            this.deps.trace?.(`[bridge] request failed: ${err instanceof Error ? err.message : String(err)}`);
            if (!res.headersSent) res.writeHead(500).end();
          }
        })();
      });
    });
    this.http.on('error', (err) => {
      this.deps.trace?.(`[bridge] disabled: ${err.message}`);
      this.http = null;
    });
    this.http.listen(port, '127.0.0.1', () => {
      this.deps.trace?.(`[bridge] MCP listening on http://127.0.0.1:${port}/mcp`);
    });
  }

  close(): void {
    this.http?.close();
    this.http = null;
  }
}
