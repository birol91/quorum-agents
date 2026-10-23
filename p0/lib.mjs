// Shared helpers for P0 experiments.
// Only documented interfaces: `claude --agent` + stream-json programmatic mode.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const P0_DIR = fileURLToPath(new URL('.', import.meta.url));
export const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));
export const LOGS_DIR = P0_DIR + 'logs/';

// Child sessions must run on subscription auth and without this session's
// Claude Code context leaking in.
export function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE') && !(k in extra)) delete env[k];
  }
  delete env.ANTHROPIC_API_KEY;
  return env;
}

export function spawnAgent(agentName, extraArgs = [], opts = {}) {
  const args = [
    '--agent', agentName,
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    // Skip user-level settings (hooks, MCP servers) — experiment isolation.
    '--setting-sources', 'project',
    ...extraArgs,
  ];
  const child = spawn('claude', args, {
    cwd: opts.cwd ?? PROJECT_DIR,
    env: cleanEnv(opts.env ?? {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const session = { name: agentName, child, events: [], listeners: new Set(), stderr: '' };
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { ev = { type: 'unparsed', raw: line }; }
    session.events.push(ev);
    for (const fn of [...session.listeners]) fn(ev);
  });
  child.stderr.on('data', (d) => { session.stderr += d; });
  return session;
}

export function send(session, text) {
  const msg = { type: 'user', message: { role: 'user', content: text } };
  session.child.stdin.write(JSON.stringify(msg) + '\n');
}

// Waits for a FUTURE event matching `predicate`. Attach before triggering.
export function waitFor(session, predicate, timeoutMs = 300_000, label = 'event') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.listeners.delete(fn);
      reject(new Error(`[${session.name}] timeout waiting for ${label}\nstderr: ${session.stderr.slice(-2000)}`));
    }, timeoutMs);
    const fn = (ev) => {
      if (!predicate(ev)) return;
      clearTimeout(timer);
      session.listeners.delete(fn);
      resolve(ev);
    };
    session.listeners.add(fn);
  });
}

export const isInit = (ev) => ev.type === 'system' && ev.subtype === 'init';
export const isResult = (ev) => ev.type === 'result';

export function saveLog(name, events) {
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(LOGS_DIR + name, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

export function usageSummary(resultEv) {
  const u = resultEv.usage ?? {};
  return `in=${u.input_tokens} out=${u.output_tokens} cache_read=${u.cache_read_input_tokens ?? 0} cost=$${resultEv.total_cost_usd ?? '?'}`;
}

// ---------------------------------------------------------------------------
// SDK transport (chosen at E3): sessions via @anthropic-ai/claude-agent-sdk,
// quorum tools as in-process MCP servers, bus = plain function calls.
// ---------------------------------------------------------------------------
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// One server instance per session; `agentName` is closed over, so the bus
// always knows the true sender — identity is never inferred from content.
export function quorumServerFor(agentName, roster, deliver) {
  return createSdkMcpServer({
    name: 'quorum',
    version: '0.0.1',
    tools: [
      tool(
        'send_message',
        'Send a message to another agent on your team, or to "user".',
        { to: z.string().describe('Target agent name, or "user"'), content: z.string() },
        async ({ to, content }) => {
          deliver({ from: agentName, to, content });
          return { content: [{ type: 'text', text: `Message handed to the bus for delivery to ${to}.` }] };
        },
      ),
      tool('list_agents', 'List the agents on your team.', {}, async () => ({
        content: [{ type: 'text', text: roster.map((r) => `- ${r.name}: ${r.desc}`).join('\n') }],
      })),
    ],
  });
}

// Async-iterable input queue: the streaming-input `prompt` for query().
export function makeInputQueue() {
  const buf = [];
  let notify;
  return {
    push(text) {
      buf.push({ type: 'user', message: { role: 'user', content: text } });
      notify?.();
    },
    close() {
      buf.push(null);
      notify?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (buf.length === 0) await new Promise((r) => (notify = r));
        const item = buf.shift();
        if (item === null) return;
        yield item;
      }
    },
  };
}

export function startTeamAgent({ name, persona, roster, deliver, model = 'haiku', onEvent }) {
  const input = makeInputQueue();
  const agent = {
    name,
    input,
    state: 'idle', // idle | busy; busy = a turn is in flight
    pending: [],
    events: [],
    sessionId: null,
    usage: { in: 0, out: 0, turns: 0 },
  };
  const systemPrompt = [
    `You are ${name}, an agent on a small team.`,
    `Team roster:`,
    ...roster.map((r) => `- ${r.name}: ${r.desc}`),
    ``,
    persona,
    ``,
    `## Team protocol`,
    `- Incoming messages are prefixed "[from <sender>]".`,
    `- To reply to ANYONE (a teammate or the user), you MUST call mcp__quorum__send_message; plain text replies are not delivered to anyone.`,
    `- Reply to teammates promptly and concisely, then stop and wait for the next message.`,
    `- Never send a message to yourself.`,
  ].join('\n');

  const q = query({
    prompt: input,
    options: {
      cwd: PROJECT_DIR,
      env: cleanEnv(),
      model,
      systemPrompt,
      permissionMode: 'default',
      strictMcpConfig: true,
      mcpServers: { quorum: quorumServerFor(name, roster, deliver) },
      allowedTools: ['mcp__quorum__send_message', 'mcp__quorum__list_agents'],
      canUseTool: async (toolName) => ({ behavior: 'deny', message: `${toolName} is not allowed in P0` }),
    },
  });

  agent.done = (async () => {
    for await (const msg of q) {
      agent.events.push(msg);
      onEvent?.(agent, msg);
      if (msg.type === 'system' && msg.subtype === 'init') agent.sessionId = msg.session_id;
      if (msg.type === 'result') {
        agent.usage.in += msg.usage?.input_tokens ?? 0;
        agent.usage.out += msg.usage?.output_tokens ?? 0;
        agent.usage.turns += 1;
        agent.state = 'idle';
        const next = agent.pending.shift();
        if (next !== undefined) {
          agent.state = 'busy';
          agent.input.push(next);
        }
      }
    }
  })();
  return agent;
}

// Deliver a user-visible message to an agent; queues while a turn is in flight.
export function deliverTo(agent, text) {
  if (agent.state === 'busy') {
    agent.pending.push(text);
    return;
  }
  agent.state = 'busy';
  agent.input.push(text);
}

export function makeBus(agents) {
  const watchers = new Set();
  const bus = {
    log: [],
    deliver(m) {
      const entry = { ...m, at: Date.now() };
      bus.log.push(entry);
      console.log(`[bus] ${m.from} -> ${m.to}: ${m.content.slice(0, 160).replace(/\n/g, ' ')}`);
      for (const w of [...watchers]) w(entry);
      if (m.to === 'user') return;
      const target = agents.get(m.to);
      if (!target) {
        console.log(`[bus] DROP: no such agent "${m.to}"`);
        return;
      }
      deliverTo(target, `[from ${m.from}]: ${m.content}`);
    },
    // Waits for a FUTURE bus message matching `pred`. Attach before triggering.
    waitFor(pred, timeoutMs = 300_000, label = 'bus message') {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          watchers.delete(fn);
          reject(new Error(`timeout waiting for ${label}`));
        }, timeoutMs);
        const fn = (entry) => {
          if (!pred(entry)) return;
          clearTimeout(timer);
          watchers.delete(fn);
          resolve(entry);
        };
        watchers.add(fn);
      });
    },
  };
  return bus;
}
