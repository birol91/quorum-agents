// E4 — send_message/list_agents as in-process SDK MCP tools (chosen transport
// after E3): the tool handler runs inside the orchestrator process, so a
// send_message call lands directly on the bus — no Unix socket bridge needed.
// PASS: agent lists the roster, calls send_message, handler receives it.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { cleanEnv, PROJECT_DIR, quorumServerFor } from './lib.mjs';

export const ROSTER = [
  { name: 'ai-engineer', desc: 'ML/AI systems engineer' },
  { name: 'data-engineer', desc: 'Data infrastructure engineer' },
];

const received = [];

const q = query({
  prompt: 'Call list_agents to see your team. Then use send_message to send exactly "hello from E4" to "user". Then reply with exactly: DONE',
  options: {
    cwd: PROJECT_DIR,
    env: cleanEnv(),
    model: 'haiku',
    systemPrompt: 'You are ai-engineer on a small team. Use the quorum tools when asked. Be terse.',
    permissionMode: 'default',
    strictMcpConfig: true,
    mcpServers: {
      quorum: quorumServerFor('ai-engineer', () => ROSTER, (m) => {
        received.push(m);
        console.log(`BUS RECEIVED: ${JSON.stringify(m)}`);
      }),
    },
    allowedTools: ['mcp__quorum__send_message', 'mcp__quorum__list_agents'],
    canUseTool: async (toolName) => ({ behavior: 'deny', message: `${toolName} not allowed in E4` }),
  },
});

for await (const msg of q) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    console.log(`INIT session_id=${msg.session_id} mcp=${JSON.stringify(msg.mcp_servers)}`);
  }
  if (msg.type === 'assistant') {
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'tool_use') console.log(`TOOL_USE ${block.name} ${JSON.stringify(block.input).slice(0, 120)}`);
    }
  }
  if (msg.type === 'result') console.log(`RESULT subtype=${msg.subtype} text=${msg.result}`);
}

const pass = received.length === 1 && received[0].to === 'user' && received[0].from === 'ai-engineer';
console.log(pass ? 'E4 PASS' : 'E4 FAIL');
