# Project: Example team

Short description of what this project does. (Fill me in.)

## Orchestrator — Quorum

This project runs a **Quorum** agent team. The lead is the user's main
**Claude Code** session (the editor chat); the Quorum desktop app builds the
team and visualizes the traffic.

- "The agents" / "the team" always means the QUORUM team, never Claude Code
  subagents. Subagents stay each agent's internal implementation detail.
- The lead drives the team over the local bridge (MCP,
  `http://127.0.0.1:8484/mcp`): `roster()` shows the team, `ask(text,
  selected?)` dispatches (`@name` one agent, `@everyone` all, selected
  group), `replies(wait_seconds)` collects the answers — then the lead
  synthesizes for the user.
- In the Quorum app the composer talks to agents only; plain text goes to the
  whole team as a group task. ESC interrupts busy agents.
- Team state (composition, decisions, task board, layout) persists in
  `.quorum/` — add it to .gitignore if you don't want it in the repo.

## Stack
- Language:
- Framework:
- Package manager:

## Conventions
- File layout:
- Tests:
- Commits:

## Domain
Brief context: who uses this, what business problem it solves.

## Things to avoid
- ...

---

# Behavioral guidelines

Guidelines to reduce common LLM coding mistakes — they apply to the lead and
to every Quorum agent working in this project.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial
tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes,
simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan and verify each step.

Strong success criteria let you loop independently. Weak criteria ("make it
work") require constant clarification.

## 5. Delegation policy

**The team does multi-part work; subagents stay internal.**

- Lead: if a task spans specialties or parallelizable parts, dispatch it to
  the Quorum team over the bridge instead of doing everything yourself.
- Agents: contribute from your own specialty; coordinate on the shared board;
  in group tasks reply to the user exactly once.
- Anyone may use Claude Code subagents internally for search/research, but
  they are never presented as "the team".
- Return focused results (a file path, a diff summary, a short report), not
  full file bodies.
