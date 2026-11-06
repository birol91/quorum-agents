# Changelog

## 2.6.0 — dispatch and get back to work

Two changes to how the lead drives the team, both in the bridge's tool
descriptions.

- **The lead no longer camps on `replies()`.** A long poll holds its session
  inside a tool call, so you could not talk to your own lead while the team
  worked. It is now told to poll once and come back to you; the default wait
  dropped from 45s to 10s. Nothing is lost by returning — replies queue, and
  the app shows how many are uncollected.
- **One piece of work for several agents is now one `ask` with `selected`.**
  However you phrase it — together, jointly, "both of you", "all three" —
  that makes it a group task, where the agents know who else is on it and
  coordinate before answering. Sending the same work as separate @name asks
  left each one unaware it was shared, so they duplicated each other.

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
- **An ear badge** appears on an agent while it is actually being handed
  overheard lines, and fades six seconds after the last one — evidence of a
  delivery, not a guess about whether the lead looks busy.

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
