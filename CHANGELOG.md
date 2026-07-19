# Changelog

## 1.8.0
- Per-agent terminal windows: pop out a live traffic stream for any agent, tethered to its block with a curved connector that glows while the agent works. Each terminal has its own composer for one-on-one conversation, sticky auto-scroll with a "↓ latest" escape hatch, drag/resize.

## 1.7.0
- Launch experience: splash screen and a welcome screen with recent projects. The app starts with zero agents by default.

## 1.6.0
- Reply grants accumulate: a new dispatch can no longer revoke an earlier agent's right to answer — fixes a lost-reply race observed in real multi-ask sessions. Busy-agent hints on the bridge's `replies` tool.

## 1.5.0
- Activity labels now tell the delivery truth: "messaging X…", "replying to the user…", "reporting to the lead…" come from actual bus delivery outcomes, never guessed from tool intent.

## 1.4.0
- Team memory: `.quorum` decisions are wired into the agents — new sessions spawn with a digest of recent decisions and open tasks, plus a `list_decisions` tool for the rest.
- A `CLAUDE.md` is scaffolded once per project and injected into every agent.

## 1.3.0
- Curved-orbit message animation with origin colors: violet comets only from the Team Lead, bright cyan for everything else. The `@everyone` toggle is gone — plain text already reaches the whole team.

## 1.2.0
- Claude Code bridge: your editor session becomes the permanent Team Lead over a local MCP endpoint (`ask` / `roster` / `replies`). The lead block glows at two levels — working, and actively driving the team.

## 1.1.0
- ESC interrupts every busy agent via the SDK's documented `interrupt()`; queued messages survive.

## 1.0.0
- First packaged release (DMG). Multi-agent canvas, peer messaging, decisions and task board, agent marketplace, mode-aware delivery policy, per-project persistence.
