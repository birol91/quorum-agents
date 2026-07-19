import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { RosterEntry } from '../types.ts';

const TeamMemberSchema = z.object({
  name: z.string(),
  desc: z.string(),
  persona: z.string(),
  model: z.string().default('haiku'),
  lead: z.boolean().default(false),
  permissionMode: z.enum(['read', 'write', 'both']).default('write'),
});

const TeamSchema = z.object({
  project: z.string(),
  members: z.array(TeamMemberSchema),
});

export type TeamMember = z.infer<typeof TeamMemberSchema>;
export interface Team {
  project: string;
  members: TeamMember[];
}

export function loadTeam(path: string): Team {
  return TeamSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Persist the live team (composition + per-agent settings) to disk. */
export function saveTeam(path: string, team: Team): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(team, null, 2)}\n`);
}

export function rosterOf(team: Team): RosterEntry[] {
  return team.members.map((m) => ({ name: m.name, desc: m.desc, lead: m.lead }));
}
