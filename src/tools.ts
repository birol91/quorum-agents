import { z } from 'zod';
import type { BusMessage, RosterEntry } from './types.ts';
import type { TaskBoard } from './tasks.ts';
import { importEsm } from './esm-import.ts';

// The Agent SDK is ESM-only; load it lazily so this module works from a CJS
// main (Electron 33) as well as the ESM test/smoke runners.
const loadSdk = (): Promise<Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'createSdkMcpServer' | 'tool'>> =>
  importEsm('@anthropic-ai/claude-agent-sdk');

export const QUORUM_TOOL_NAMES = [
  'mcp__quorum__send_message',
  'mcp__quorum__list_agents',
  'mcp__quorum__record_decision',
  'mcp__quorum__list_decisions',
  'mcp__quorum__add_task',
  'mcp__quorum__claim_task',
  'mcp__quorum__complete_task',
  'mcp__quorum__list_tasks',
];

export interface QuorumToolOptions {
  /** When set, the record_decision tool is exposed (P2 decision layer). */
  recordDecision?: (d: { topic: string; decision: string; rationale: string; decidedBy: string }) => void;
  /** When set, the list_decisions tool is exposed — the team's memory. */
  decisions?: () => { topic: string; decision: string; rationale: string; decidedBy: string; at: string }[];
  /** When set, the shared task board tools are exposed (P4 task layer). */
  taskBoard?: TaskBoard;
}

/**
 * In-process quorum MCP server (P0 E4 decision): the tool handler runs inside
 * the orchestrator, so a send_message call lands directly on the bus. One
 * instance per session; `agentName` is closed over — sender identity is never
 * inferred from content (brief §3.6).
 */
export async function quorumServerFor(
  agentName: string,
  getRoster: () => RosterEntry[],
  deliver: (m: BusMessage) => void,
  opts: QuorumToolOptions = {},
) {
  const { createSdkMcpServer, tool } = await loadSdk();
  const recordDecision = opts.recordDecision;
  const taskBoard = opts.taskBoard;
  return createSdkMcpServer({
    name: 'quorum',
    version: '0.0.1',
    tools: [
      tool(
        'send_message',
        'Send a message to another agent on your team, or to "user".',
        { to: z.string().describe('Target agent name, or "user"'), content: z.string() },
        async ({ to, content }: { to: string; content: string }) => {
          deliver({ from: agentName, to, content });
          return { content: [{ type: 'text' as const, text: `Message handed to the bus for delivery to ${to}.` }] };
        },
      ),
      // Read the roster LIVE each call, so agents added after this one spawned
      // are still visible (roster is not frozen at spawn time).
      tool('list_agents', 'List the agents on your team.', {}, async () => ({
        content: [
          {
            type: 'text' as const,
            text: getRoster()
              .filter((r) => r.name !== agentName)
              .map((r) => `- ${r.name}: ${r.desc}${r.lead ? ' (lead)' : ''}`)
              .join('\n') || '(no other agents on the team yet)',
          },
        ],
      })),
      ...(recordDecision
        ? [
            tool(
              'record_decision',
              'Permanently record a final team decision. Call exactly once per decision, after all sides said KABUL.',
              {
                topic: z.string().describe('Short title of what was decided'),
                decision: z.string().describe('The decision itself, one sentence'),
                rationale: z.string().describe('Why — the arguments that settled it'),
              },
              async ({ topic, decision, rationale }: { topic: string; decision: string; rationale: string }) => {
                recordDecision({ topic, decision, rationale, decidedBy: agentName });
                return { content: [{ type: 'text' as const, text: 'Decision recorded permanently.' }] };
              },
            ),
          ]
        : []),
      ...(opts.decisions
        ? [
            tool(
              'list_decisions',
              'List the decisions this team has already made (persisted across restarts). Check here before reopening a topic.',
              {},
              async () => {
                const all = opts.decisions!();
                const text = all.length
                  ? all
                      .slice(-20)
                      .map((d) => `- [${d.at.slice(0, 10)}] ${d.topic}: ${d.decision} (by ${d.decidedBy}) — ${d.rationale}`)
                      .join('\n')
                  : 'No decisions recorded yet.';
                return { content: [{ type: 'text' as const, text }] };
              },
            ),
          ]
        : []),
      ...(taskBoard
        ? [
            tool(
              'add_task',
              'Add a task to the shared board for a teammate (or you) to claim. Use this to split work.',
              {
                title: z.string().describe('Short task title'),
                description: z.string().describe('What needs doing'),
              },
              async ({ title, description }: { title: string; description: string }) => {
                const { task, duplicate } = taskBoard.addTask({ title, description, createdBy: agentName });
                const text = duplicate
                  ? `That work already exists as ${task.id}: "${task.title}" (${task.status}). Claim it instead of adding a duplicate.`
                  : `Added ${task.id}: ${task.title}.`;
                return { content: [{ type: 'text' as const, text }] };
              },
            ),
            tool(
              'claim_task',
              'Claim an open task before you start it, so no teammate does the same work. Fails if someone already has it.',
              { id: z.string().describe('The task id to claim, e.g. "task-1"') },
              async ({ id }: { id: string }) => {
                const r = taskBoard.claimTask(id, agentName);
                const text = r.ok
                  ? `Claimed ${id}: ${r.task.title}. It is yours now.`
                  : `Could not claim ${id}: ${r.reason}.`;
                return { content: [{ type: 'text' as const, text }] };
              },
            ),
            tool(
              'complete_task',
              'Mark a task you claimed as done, recording the result. Only the claimer can complete it.',
              {
                id: z.string().describe('The task id you claimed'),
                result: z.string().describe('Short summary of what was produced'),
              },
              async ({ id, result }: { id: string; result: string }) => {
                const r = taskBoard.completeTask(id, agentName, result);
                const text = r.ok ? `Completed ${id}.` : `Could not complete ${id}: ${r.reason}.`;
                return { content: [{ type: 'text' as const, text }] };
              },
            ),
            tool('list_tasks', 'List the open and claimed tasks on the shared board.', {}, async () => {
              const active = taskBoard.list().filter((t) => t.status !== 'done');
              const text = active.length
                ? active.map((t) => `- ${t.id} [${t.status}] ${t.title}${t.claimedBy ? ` (${t.claimedBy})` : ''}`).join('\n')
                : 'No open or claimed tasks.';
              return { content: [{ type: 'text' as const, text }] };
            }),
          ]
        : []),
    ],
  });
}
