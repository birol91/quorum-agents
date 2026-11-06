// E3b — Agent SDK `canUseTool` callback: does it intercept all three tool
// classes (MCP tool, file Write, Bash), and does allow/deny take effect?
// Also verifies the SDK runs on subscription auth (no ANTHROPIC_API_KEY set).
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { existsSync, rmSync } from 'node:fs';
import { cleanEnv, PROJECT_DIR } from './lib.mjs';

const TESTFILE = 'p0/logs/e3b-test.txt';
const TOUCHFILE = 'p0/logs/e3b-touched.txt';
rmSync(PROJECT_DIR + TESTFILE, { force: true });
rmSync(PROJECT_DIR + TOUCHFILE, { force: true });

const permCalls = [];

const quorumtest = createSdkMcpServer({
  name: 'quorumtest',
  version: '0.0.1',
  tools: [
    tool('ping', 'Test tool; replies with pong.', { text: z.string() }, async ({ text }) => ({
      content: [{ type: 'text', text: `pong: ${text}` }],
    })),
  ],
});

const q = query({
  prompt: `Do these in order, continuing past any denial: 1) call the mcp__quorumtest__ping tool with text "hi"; 2) create the file ${TESTFILE} with content "hello" using the Write tool; 3) run \`touch ${TOUCHFILE}\` using the Bash tool. Then report the outcome of each step.`,
  options: {
    cwd: PROJECT_DIR,
    env: cleanEnv(),
    model: 'haiku',
    systemPrompt: 'You are a permission-test agent. Attempt requested operations immediately; report exact error text on denial and continue.',
    permissionMode: 'default',
    mcpServers: { quorumtest },
    canUseTool: async (toolName, input) => {
      permCalls.push(toolName);
      console.log(`canUseTool: ${toolName} ${JSON.stringify(input).slice(0, 100)}`);
      if (toolName === 'Bash') return { behavior: 'deny', message: 'Denied by Quorum permission test' };
      return { behavior: 'allow', updatedInput: input };
    },
  },
});

for await (const msg of q) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    console.log(`INIT session_id=${msg.session_id} model=${msg.model} mcp=${JSON.stringify(msg.mcp_servers)}`);
  }
  if (msg.type === 'result') {
    console.log(`RESULT subtype=${msg.subtype} usage_in=${msg.usage?.input_tokens} out=${msg.usage?.output_tokens}`);
    console.log(msg.result);
  }
}

console.log('---');
console.log(`canUseTool fired for: [${permCalls.join(', ')}]`);
console.log(`Write allowed -> file exists: ${existsSync(PROJECT_DIR + TESTFILE)} (expect true)`);
console.log(`Bash denied  -> file exists: ${existsSync(PROJECT_DIR + TOUCHFILE)} (expect false)`);
const pass =
  permCalls.some((t) => t.startsWith('mcp__quorumtest__')) &&
  permCalls.includes('Write') &&
  permCalls.includes('Bash') &&
  existsSync(PROJECT_DIR + TESTFILE) &&
  !existsSync(PROJECT_DIR + TOUCHFILE);
console.log(pass ? 'E3b PASS' : 'E3b PARTIAL/FAIL (see coverage above)');
