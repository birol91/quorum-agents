import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { RosterEntry } from '../types.ts';

const TeamMemberSchema = z.object({
  name: z.string(),
  desc: z.string(),
  persona: z.string(),
  // Team defaults, chosen from measurement (see the brief):
  // - sonnet: haiku's silent turns (a turn that ends without send_message,
  //   delivering nothing) cost far more than sonnet's slower turns.
  // - medium: effort does nothing on haiku but does on sonnet; medium is the
  //   working setting, raise it per-agent when a task needs the depth.
  // - both: agents run unattended; a permission prompt stalls the whole team
  //   until someone notices it.
  model: z.string().default('sonnet'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  lead: z.boolean().default(false),
  permissionMode: z.enum(['read', 'write', 'both']).default('both'),
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
