# Changelog

## 2.5.0 — the meeting room

Agents can now overhear traffic they are not addressed in, without it
costing them a turn. The SDK's `shouldQuery: false` puts text in an agent's
transcript without starting an assistant turn — measured at 0 input and 0
output tokens, with the content still recallable on the next real turn.

- **Agents hear each other.** Always on. Every message is also delivered to
  the agents who were not party to it. An agent can now say "data-engineer
  already claimed that task" instead of duplicating work it had no way of
  knowing about.
- **`listen` toggle** (top bar, off by default) relays what you type to the
  lead into the room. Lines are spooled to `.quorum/overheard.jsonl` first,
  so nothing is lost when the app is closed or the team is down; the toggle
  shows how many actually landed.
- **Listening is a visible state**: while the room is open, agent blocks
  carry a soft breathing cyan edge. Working still wins over listening.

## 2.4.0 — what the lead has not collected, and per-agent control

An agent answers and nothing happens in the lead's editor. That is not a
bug we can fix — MCP is client-pull, and a server cannot wake its client —
so the app says so instead of pretending otherwise.

- **"N replies uncollected"** on the Team Lead block, clearing when the lead
  finally calls `replies()`. Only bridge traffic counts: a reply to
  something typed in the app is already in front of you.
- **Per-agent `stop`** aborts one agent's turn and leaves the team running.
- **Per-agent `reset`** respawns with no history *and* drops pending mail —
  without the second half, the fresh session reads the queue and walks
  straight back into the thread you just abandoned.
- **`find`** filters a terminal's feed; the log is selectable, so output can
  be copied.
- **User input jumps the queue.** A turn still cannot be interrupted
  mid-flight, but when it ends the agent reads your correction *before* the
  teammate drafts it supersedes.

## 2.3.0 — measured defaults, and the human mark

- **Defaults are now sonnet / medium / both.** Sonnet because a silent turn
  (one that ends without `send_message`, delivering nothing) costs more than
  haiku's faster turns save. Medium because effort measured inert on haiku
  but real on sonnet. Both because a permission prompt stalls the whole team
  until a human notices it.
- **Composer traffic flies to a human mark**, not the Team Lead block —
  visible while the message is in flight, fading with it.
- Terminal labels fixed: a reply to something you typed read "to Team Lead".

## 2.2.0 — composer replies are addressed to you

With no in-app lead, composer traffic never passes through the Team Lead,
but the room labelled every user-bound message "→ Team Lead" and the canvas
drew the arrow into the lead's block. The bus now remembers which channel
asked and stamps the reply with it: composer answers read "→ you", bridge
answers still read "→ Team Lead".

## 2.1.0 — queue coalescing

`flush()` drained one message per idle event, so mail cost turns: an agent
that was working while two teammates sent drafts needed 4 turns to read them
instead of 2. The queue is now handed over as a single turn, messages kept
separate and labelled so the agent still sees who said what.

Also in this release:

- **Quorum tools load eagerly.** They were deferred behind tool search, so
  `send_message` had to be looked up before it could be called (6058/5422ms
  → 4626/3730ms). This also removed a failure mode: a turn that fumbled the
  lookup ended silent, delivering nothing.
- **Silent turns are reported.** `replies()` carries a `silent` array, so a
  lost answer no longer looks identical to an agent that was never asked.
- **Session-handover race fixed.** A superseded session no longer drains the
  queue into the process being retired.
- **Cross-consultation fires on intent, not substrings** — "danışman" and
  "birbirine bağla" no longer force a ~3x turn multiplier.

## 2.0.0 — per-agent reasoning effort

Choose each agent's effort (low → max) from the inspector.

## 1.x

See the git history and `CLAUDE-QUORUM-BRIEF.md` for the 1.0–1.9 series:
the bus and decision protocol, the external-lead architecture over MCP,
per-agent terminal windows, lead interrupt propagation, and the marketplace.
