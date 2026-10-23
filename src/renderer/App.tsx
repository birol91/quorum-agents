import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, onEvent } from './bridge.ts';
import { apply, clearTerminal, getState, hydrate, setLayout, useStore } from './store.ts';
import type { AgentView, CatalogAgent, EffortLevel, LayoutMap, ModelName, PermissionMode } from '../shared/ipc.ts';
import { MODELS, EFFORTS, userChannelName } from '../shared/ipc.ts';
import type { BusMessage } from '../types.ts';

export /**
 * Team-wide listening. It belongs on the top bar, not on the Team Lead block:
 * the lead is the SOURCE being relayed, the AGENTS are the ones who listen.
 */
function ListenToggle(): JSX.Element {
  const listening = useStore((s) => s.listening);
  const heard = useStore((s) => s.heard);
  return (
    <button
      className={`listen-btn ${listening ? 'on' : ''}`}
      style={{ marginLeft: 'auto' }}
      title={
        listening
          ? `The team is hearing what you type to the lead — ${heard} relayed so far, costing them no turn. Click to stop.`
          : 'Agents already hear each other. Turn this on so they also hear what you type to the lead.'
      }
      onClick={() => invoke('quorum:setListening', { on: !listening }).catch(() => {})}
    >
      {listening ? `◉ listening · ${heard}` : '◎ listen'}
    </button>
  );
}

export function App(): JSX.Element {
  // A selected thread = the unordered pair of participants of a clicked message.
  const [thread, setThread] = useState<[string, string] | null>(null);
  // Meeting-room height (px), resizable via the drag handle above it.
  const [roomHeight, setRoomHeight] = useState(150);
  // The agent whose inspector (model + permissions) is open, if any.
  const [inspect, setInspect] = useState<string | null>(null);
  // Broadcast mode: when on, the next message goes to the whole team (@everyone).
  // Canvas multi-selection: when non-empty, messages route to exactly these agents.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Marketplace panel open?
  const [marketOpen, setMarketOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  // Open per-agent terminal windows (name -> frame). A new window spawns
  // just below ITS agent's block (short tether, never covering the row);
  // small cascade offset keeps multiple windows from stacking exactly.
  const [terms, setTerms] = useState<Record<string, { x: number; y: number; w: number; h: number }>>({});
  const openTerminal = (name: string): void =>
    setTerms((t) => {
      if (t[name]) return t;
      const n = Object.keys(t).length;
      const r = document.querySelector(`.block[data-name="${CSS.escape(name)}"]`)?.getBoundingClientRect();
      const x = Math.max(8, Math.min((r ? r.x + 24 : 120) + n * 30, window.innerWidth - 540));
      const y = Math.min((r ? r.y + r.height + 18 : 90) + n * 24, window.innerHeight - 360);
      return { ...t, [name]: { x, y, w: 520, h: 320 } };
    });

  useEffect(() => {
    const off = onEvent(apply);
    invoke('quorum:snapshot', undefined).then(hydrate).catch(() => {});
    return off;
  }, []);

  // ESC: close whatever is on top; with nothing open, interrupt every busy
  // agent (the SDK aborts the in-flight turn — the panic button for hangs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (marketOpen) return setMarketOpen(false);
      if (aboutOpen) return setAboutOpen(false);
      if (inspect) return setInspect(null);
      invoke('quorum:interrupt', undefined).catch(() => {});
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [marketOpen, aboutOpen, inspect]);

  const selectedList = [...selected];

  return (
    <div className="app" style={{ gridTemplateRows: `44px 1fr 6px ${roomHeight}px` }}>
      <header className="header">
        <span className="logo">◇ QUORUM</span>
        <ProjectBadge />
        <span className="tag">run your agents as a team</span>
        <ListenToggle />
        <button className="market-btn" onClick={() => setMarketOpen(true)}>
          ⊞ Marketplace
        </button>
        <button
          className="layout-btn"
          onClick={() => {
            setLayout({});
            invoke('quorum:clearLayout', undefined).catch(() => {});
          }}
          title="Reset block positions to the default row"
        >
          ⤢ Clear layout
        </button>
        {thread && (
          <button className="thread-clear" onClick={() => setThread(null)}>
            thread: {thread[0]} ↔ {thread[1]} ✕
          </button>
        )}
        <button className="about-btn" onClick={() => setAboutOpen(true)} title="About Quorum">
          ⓘ
        </button>
      </header>
      <Canvas thread={thread} onInspect={setInspect} selected={selected} onSelect={setSelected} onTerminal={openTerminal} />
      {Object.entries(terms).map(([name, frame]) => (
        <AgentTerminal
          key={name}
          name={name}
          frame={frame}
          onFrame={(f) => setTerms((t) => ({ ...t, [name]: f }))}
          onClose={() => setTerms((t) => { const n = { ...t }; delete n[name]; return n; })}
        />
      ))}
      <RoomResizer height={roomHeight} onResize={setRoomHeight} />
      <MeetingRoom
        thread={thread}
        onSelectThread={setThread}
        selected={selectedList}
        onClearSelection={() => setSelected(new Set())}
      />
      {inspect && <AgentInspector name={inspect} onClose={() => setInspect(null)} />}
      {marketOpen && <Marketplace onClose={() => setMarketOpen(false)} />}
      {aboutOpen && <About onClose={() => setAboutOpen(false)} />}
      <Welcome />
      <Splash />
    </div>
  );
}

function About({ onClose }: { onClose: () => void }): JSX.Element {
  const [version, setVersion] = useState('');
  useEffect(() => {
    invoke('app:health', undefined).then((r) => setVersion(r.version)).catch(() => {});
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="about" onClick={(e) => e.stopPropagation()}>
        <div className="mk-head">
          <h2>◇ Quorum</h2>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="about-tagline">run your agents as a team</div>
        {version && <div className="about-version">version {version}</div>}
        <p>
          Every agent is a full, persistent Claude Code session. They message each other,
          split work on a shared board, debate with a propose/object/accept protocol,
          and answer you by the mode you choose — one lead voice, one specialist,
          or the whole team.
        </p>
        <p>
          Built only on documented interfaces: the official Claude Code CLI and Agent SDK,
          MCP tools, <code>--resume</code>. No terminal automation, no API costs —
          it runs entirely on your Claude subscription.
        </p>
        <p className="about-legal">
          Quorum is an independent open-source project, not affiliated with or endorsed by
          Anthropic. &ldquo;Claude&rdquo; is a trademark of Anthropic, PBC.
        </p>
      </div>
    </div>
  );
}

const LOGO_URL = new URL('./logo.png', import.meta.url).href;

// Floating per-agent console (the agent-board AgentWindow, quorum-flavored):
// draggable header, resizable corner, mono feed of received messages, live
// activity lines and sent messages — all first-hand bus/stream events.
const EMPTY_FEED: import('./store.ts').TermEntry[] = [];

function AgentTerminal({
  name,
  frame,
  onFrame,
  onClose,
}: {
  name: string;
  frame: { x: number; y: number; w: number; h: number };
  onFrame: (f: { x: number; y: number; w: number; h: number }) => void;
  onClose: () => void;
}): JSX.Element {
  // Stable fallback: useSyncExternalStore needs identity-stable snapshots —
  // a fresh [] on every call re-renders forever and crashes the renderer.
  const allFeed = useStore((s) => s.terminals[name] ?? EMPTY_FEED);
  // null = the find bar is closed; '' = open but not filtering yet.
  const [find, setFind] = useState<string | null>(null);
  const feed = useMemo(() => {
    const q = find?.trim().toLowerCase();
    if (!q) return allFeed;
    return allFeed.filter((e) => e.text.toLowerCase().includes(q) || e.label.toLowerCase().includes(q));
  }, [allFeed, find]);
  const agent = useStore((s) => s.agents.find((a) => a.name === name));
  // Subscribe to layout so a dragged block re-measures the tether.
  useStore((s) => s.layout);
  const logRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: 'move' | 'resize'; x: number; y: number; f: typeof frame } | null>(null);
  const [msg, setMsg] = useState('');
  // Sticky-bottom: follow new entries only while the user IS at the bottom.
  // Scrolled up to read history? Stay put — a "↓ latest" button jumps back.
  const stick = useRef(true);
  const [pinned, setPinned] = useState(true);

  // Depend on feed identity, not length: the feed is capped at TERM_CAP, so a
  // busy agent's push+shift keeps length constant and a length dep goes dead.
  useEffect(() => {
    if (stick.current) logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [feed]);

  const onLogScroll = (): void => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    stick.current = atBottom;
    setPinned(atBottom);
  };
  const jumpToLatest = (): void => {
    stick.current = true;
    setPinned(true);
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  };

  const send = (): void => {
    const t = msg.trim();
    if (!t) return;
    // A terminal talks to ITS agent only — direct single-target route.
    invoke('quorum:sendUserInput', { text: `@${name} ${t}` }).catch(() => {});
    setMsg('');
  };

  useEffect(() => {
    const move = (e: MouseEvent): void => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      onFrame(
        d.mode === 'move'
          ? { ...d.f, x: Math.max(0, d.f.x + dx), y: Math.max(0, d.f.y + dy) }
          : { ...d.f, w: Math.max(320, d.f.w + dx), h: Math.max(200, d.f.h + dy) },
      );
    };
    const up = (): void => { drag.current = null; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [onFrame]);

  const hhmmss = (t: number): string => new Date(t).toLocaleTimeString('en-GB');
  const busy = agent?.state === 'busy';

  // Dashed tether: a smooth S-curve from the facing block edge (top/bottom/
  // left/right — wherever the window sits) into the window's top-left. The
  // block end eases out along the edge normal; the window end eases in
  // vertically (node-editor style).
  const anchor = { x: frame.x + 24, y: frame.y };
  const edge = blockEdgeToward(name, anchor);
  const path = edge
    ? (() => {
        const { pt, nx, ny } = edge;
        const k = Math.max(24, Math.min(90, Math.hypot(anchor.x - pt.x, anchor.y - pt.y) / 2.5));
        const c1 = { x: pt.x + nx * k, y: pt.y + ny * k };
        const c2 = { x: anchor.x, y: anchor.y + (anchor.y >= pt.y ? -k : k) };
        return `M ${pt.x} ${pt.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${anchor.x} ${anchor.y}`;
      })()
    : null;
  return (
   <>
    {path && (
      <svg className="aterm-link" style={{ zIndex: 39 }}>
        <path className={busy ? 'busy' : ''} d={path} />
      </svg>
    )}
    <div className={`aterm ${busy ? 'busy' : ''}`} style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}>
      <header onMouseDown={(e) => { e.preventDefault(); drag.current = { mode: 'move', x: e.clientX, y: e.clientY, f: frame }; }}>
        <span className={`dot ${agent?.state ?? 'offline'}`} />
        <span className="tname">{name}</span>
        <span className="tlive">live</span>
        {busy && (
          <button
            className="tstop"
            title={`Stop ${name}'s current turn. The rest of the team keeps working.`}
            onClick={() => invoke('quorum:interruptAgent', { name }).catch(() => {})}
          >
            stop
          </button>
        )}
        <button
          title={`Restart ${name} with no memory of this conversation, and drop its pending mail. Use when it keeps returning to an abandoned thread.`}
          onClick={() => {
            if (!confirm(`Reset ${name}? It forgets this conversation and starts fresh.`)) return;
            clearTerminal(name);
            invoke('quorum:resetAgent', { name }).catch(() => {});
          }}
        >
          reset
        </button>
        <button
          className={find === null ? '' : 'on'}
          title="Search this terminal"
          onClick={() => setFind(find === null ? '' : null)}
        >
          find
        </button>
        <button onClick={() => clearTerminal(name)}>clear</button>
        <button onClick={onClose}>✕</button>
      </header>
      {find !== null && (
        <div className="tfind">
          <input
            autoFocus
            value={find}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setFind(null)}
            placeholder="Filter lines…"
          />
          <span className="tfind-n">
            {find.trim() ? `${feed.length} match${feed.length === 1 ? '' : 'es'}` : ''}
          </span>
        </div>
      )}
      <div className="tlog" ref={logRef} onScroll={onLogScroll}>
        {feed.length === 0 && <div className="tempty">Waiting for {name} to do something…</div>}
        {feed.map((e, i) =>
          e.kind === 'act' ? (
            <div className="tline" key={i}>
              <span className="tts">{hhmmss(e.at)}</span>
              <span className="tact">· {e.label}</span>
            </div>
          ) : (
            <div className={`tmsg ${e.kind}`} key={i}>
              <div className="thead">
                <span className="tts">{hhmmss(e.at)}</span>
                <span className="tdir">{e.kind === 'in' ? '←' : '→'} {e.label}</span>
              </div>
              <div className="tbody">{displayContent(e.text)}</div>
            </div>
          ),
        )}
      </div>
      {!pinned && (
        <button className="tjump" onClick={jumpToLatest}>
          ↓ latest
        </button>
      )}
      <div className="tcompose">
        <input
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder={`Message ${name} directly…`}
        />
        <button onClick={send}>Send</button>
      </div>
      <div
        className="tresize"
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); drag.current = { mode: 'resize', x: e.clientX, y: e.clientY, f: frame }; }}
      />
    </div>
   </>
  );
}

// 1.8s brand splash on a fresh window. Click-through (pointer-events: none)
// so scripts and impatient users are never blocked; skipped on in-window
// reloads (project switches) via sessionStorage.
function Splash(): JSX.Element | null {
  const [gone, setGone] = useState(() => sessionStorage.getItem('quorum-splash') === '1');
  const [fading, setFading] = useState(false);
  useEffect(() => {
    if (gone) return;
    sessionStorage.setItem('quorum-splash', '1');
    const fade = setTimeout(() => setFading(true), 1500);
    const kill = setTimeout(() => setGone(true), 2000);
    return () => {
      clearTimeout(fade);
      clearTimeout(kill);
    };
  }, [gone]);
  if (gone) return null;
  return (
    <div className={`splash ${fading ? 'fading' : ''}`}>
      <div className="splash-row">
        <img src={LOGO_URL} alt="" />
        <span className="splash-word">QUORUM</span>
      </div>
      <div className="splash-tag">run your agents as a team</div>
    </div>
  );
}

// Welcome screen (scratch mode only): pick a project — recents or the picker.
function Welcome(): JSX.Element | null {
  const project = useStore((s) => s.project);
  const [recents, setRecents] = useState<{ dir: string; name: string }[]>([]);
  const scratch = project?.name === 'no project';
  useEffect(() => {
    if (scratch) invoke('quorum:recentProjects', undefined).then((r) => setRecents(r.projects)).catch(() => {});
  }, [scratch]);
  if (!scratch) return null;
  return (
    <div className="welcome">
      <div className="splash-row">
        <img src={LOGO_URL} alt="" />
        <span className="splash-word">QUORUM</span>
      </div>
      <div className="splash-tag">run your agents as a team</div>
      <button className="welcome-open" onClick={() => invoke('quorum:openProject', undefined).catch(() => {})}>
        Open project…
      </button>
      {recents.length > 0 && (
        <div className="welcome-recents">
          <h3>Recent projects</h3>
          {recents.map((p) => (
            <button key={p.dir} className="welcome-recent" onClick={() => invoke('quorum:openProjectPath', { dir: p.dir }).catch(() => {})}>
              <span className="name">{p.name}</span>
              <span className="path">{p.dir}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// The open project: click to switch folders (native picker; main reloads us).
function ProjectBadge(): JSX.Element {
  const project = useStore((s) => s.project);
  return (
    <button
      className="project-btn"
      onClick={() => invoke('quorum:openProject', undefined).catch(() => {})}
      title={project ? `${project.dir} — click to open another project` : 'Open a project folder'}
    >
      ▸ {project ? project.name : 'Open project…'}
    </button>
  );
}

// Drag handle between the canvas and the meeting room.
function RoomResizer({ height, onResize }: { height: number; onResize: (h: number) => void }): JSX.Element {
  const drag = useRef<{ startY: number; startH: number } | null>(null);
  const onDown = (e: React.MouseEvent): void => {
    drag.current = { startY: e.clientY, startH: height };
    e.preventDefault();
  };
  useEffect(() => {
    const move = (e: MouseEvent): void => {
      const d = drag.current;
      if (!d) return;
      // Dragging up grows the room; clamp to a sane range.
      onResize(Math.max(120, Math.min(640, d.startH + (d.startY - e.clientY))));
    };
    const up = (): void => {
      drag.current = null;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [onResize]);
  return <div className="room-resizer" onMouseDown={onDown} />;
}

function AgentInspector({ name, onClose }: { name: string; onClose: () => void }): JSX.Element {
  const agents = useStore((s) => s.agents);
  const agent = agents.find((a) => a.name === name);
  if (!agent) return <></>;

  const setModel = (model: ModelName): void => {
    invoke('quorum:updateAgent', { name, model }).catch(() => {});
  };
  const setMode = (permissionMode: PermissionMode): void => {
    invoke('quorum:updateAgent', { name, permissionMode }).catch(() => {});
  };
  const setEffort = (effort: EffortLevel): void => {
    invoke('quorum:updateAgent', { name, effort }).catch(() => {});
  };
  const remove = (): void => {
    if (!window.confirm(`Remove ${name} from the team? Its session ends and it leaves the canvas.`)) return;
    invoke('quorum:removeAgent', { name }).catch(() => {});
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="inspector" onClick={(e) => e.stopPropagation()}>
        <div className="inspector-head">
          <span className="name">{agent.name}{agent.lead && <span className="lead-badge" style={{ marginLeft: 8 }}>lead</span>}</span>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="inspector-desc">{agent.desc}</div>

        <div className="field">
          <label>Model</label>
          <div className="seg">
            {MODELS.map((m) => (
              <button key={m} className={agent.model === m ? 'on' : ''} onClick={() => setModel(m)}>
                {m}
              </button>
            ))}
          </div>
          <div className="hint">Changing the model restarts this session (history preserved via --resume).</div>
        </div>

        <div className="field">
          <label>Effort</label>
          <div className="seg">
            {EFFORTS.map((e) => (
              <button key={e} className={agent.effort === e ? 'on' : ''} onClick={() => setEffort(e)}>
                {e}
              </button>
            ))}
          </div>
          <div className="hint">
            Reasoning depth (SDK default: high). xhigh/max need recent models — others silently fall back. Changing it restarts the session.
          </div>
        </div>

        <div className="field">
          <label>Permissions</label>
          <div className="seg">
            {(['read', 'write', 'both'] as PermissionMode[]).map((m) => (
              <button key={m} className={agent.permissionMode === m ? 'on' : ''} onClick={() => setMode(m)}>
                {m === 'read' ? 'read only' : m === 'write' ? 'ask to write' : 'both (auto)'}
              </button>
            ))}
          </div>
          <div className="hint">
            read = write tools denied · write = prompt on each write · both = auto-allow everything
          </div>
        </div>

        <div className="inspector-danger">
          <button className="remove-btn" onClick={remove}>Remove agent from team</button>
        </div>
      </div>
    </div>
  );
}

const pairKey = (a: string, b: string): string => [a, b].sort().join('|');
const inThread = (m: BusMessage, thread: [string, string] | null): boolean =>
  !thread || pairKey(m.from, m.to) === pairKey(thread[0], thread[1]);

// The bus wraps some messages in coordination envelopes ([LEAD BRIEF], [TEAM
// TASK]). Agents need those, but the user shouldn't see the boilerplate — show
// just the real content in the meeting room.
function displayContent(text: string): string {
  const brief = text.indexOf('USER TASK:');
  if (text.startsWith('[LEAD BRIEF]') && brief !== -1) return text.slice(brief + 'USER TASK:'.length).trim();
  const teamTask = text.match(/^\[TEAM TASK[^\]]*\]\s*([\s\S]*)$/);
  if (teamTask) return teamTask[1]!.trim();
  return text;
}

// Compact token count: 3305 → "3.3k", 850 → "850".
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// Elapsed ms → "0:23" / "1:05".
function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Point where the segment from a block's center toward `tx,ty` crosses that
// block's rectangle edge — so a line/dot enters/exits at a stable edge point,
// not a fixed inset that drifts as blocks move.
function edgePoint(cx: number, cy: number, tx: number, ty: number, hw: number, hh: number): { x: number; y: number } {
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  // scale to the nearest of the vertical/horizontal edges
  const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

// Same idea for a round node (the human mark): the point on its rim facing
// `tx,ty`, so an arc starts/ends at the edge rather than the centre.
function edgeOfCircle(c: { x: number; y: number }, tx: number, ty: number, r: number): { x: number; y: number } {
  const dx = tx - c.x, dy = ty - c.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: c.x + (dx / len) * r, y: c.y + (dy / len) * r };
}

// Fallback layout when an agent has no saved position: a horizontal row.
function defaultPos(agents: AgentView[]): LayoutMap {
  const out: LayoutMap = {};
  agents.forEach((a, i) => {
    out[a.name] = { x: 80 + i * 320, y: 140 };
  });
  // The external Team Lead (the user's Claude Code session, via the bridge)
  // sits above the row; 'user' is its reserved layout key.
  out.user = { x: 80, y: 16 };
  return out;
}

const BLOCK_W = 200;
const BLOCK_H = 96;

/**
 * Where the tether leaves the block: the edge point FACING `to` (same
 * geometry as the canvas mesh), plus that edge's outward normal so the
 * curve eases out perpendicular to whichever edge it exits — top, bottom,
 * left or right, depending on where the window sits. Uses the block's REAL
 * on-screen rect (blocks grow with description/activity lines; the layout
 * constant BLOCK_H is only the nominal height and made bottom exits look
 * like they left from the block's middle).
 */
function blockEdgeToward(
  name: string,
  to: { x: number; y: number },
): { pt: { x: number; y: number }; nx: number; ny: number } | null {
  const el = document.querySelector(`.block[data-name="${CSS.escape(name)}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const hw = r.width / 2 + 4, hh = r.height / 2 + 4;
  const pt = edgePoint(cx, cy, to.x, to.y, hw, hh);
  const onSide = Math.abs(pt.x - cx) >= hw - 0.5;
  return { pt, nx: onSide ? Math.sign(pt.x - cx) : 0, ny: onSide ? 0 : Math.sign(pt.y - cy) };
}

function Canvas({
  thread,
  onInspect,
  selected,
  onSelect,
  onTerminal,
}: {
  thread: [string, string] | null;
  onInspect: (name: string) => void;
  selected: Set<string>;
  onSelect: (s: Set<string>) => void;
  onTerminal: (name: string) => void;
}): JSX.Element {
  const agents = useStore((s) => s.agents);
  const messages = useStore((s) => s.messages);
  const permissions = useStore((s) => s.permissions);
  const layout = useStore((s) => s.layout);
  const activity = useStore((s) => s.activity);
  const leadLevel = useStore((s) => s.leadLevel);
  const pendingReplies = useStore((s) => s.pendingReplies);
  const overheardAt = useStore((s) => s.overheardAt);

  // Listening is a STATE, like the lead's own glow — but it is only true
  // while there is something to hear. The toggle stays on between
  // conversations, so gating on it alone left the team glowing at an idle
  // lead; it follows leadLevel for the same reason the lead's own violet
  // does, and goes out with it.
  const listening = useStore((s) => s.listening);
  const roomLive = listening && leadLevel !== 'off';

  // 1s clock so busy-duration counters tick while any agent is busy.
  const anyBusy = agents.some((a) => a.state === 'busy');
  const [clock, setClock] = useState(0);
  useEffect(() => {
    if (!anyBusy) return;
    const id = setInterval(() => setClock((c) => c + 1), 1000);
    return () => clearInterval(id);
  }, [anyBusy]);
  void clock; // referenced to force re-render each second

  // Effective position = saved layout, else default row.
  const defaults = useMemo(() => defaultPos(agents), [agents]);
  const pos = useMemo((): LayoutMap => {
    const out: LayoutMap = { ...defaults };
    for (const [name, p] of Object.entries(layout)) out[name] = p;
    return out;
  }, [defaults, layout]);

  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ name: string; dx: number; dy: number; moved: boolean } | null>(null);
  const lasso = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [lassoRect, setLassoRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const onBlockDown = useCallback(
    (e: React.MouseEvent, name: string) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const p = pos[name] ?? { x: 0, y: 0 };
      drag.current = { name, dx: e.clientX - rect.left - p.x, dy: e.clientY - rect.top - p.y, moved: false };
      e.preventDefault();
    },
    [pos],
  );

  // Keep the latest positions available inside the window-level handlers.
  const posRef = useRef(pos);
  posRef.current = pos;

  useEffect(() => {
    const move = (e: MouseEvent): void => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      // Lasso: grow the rectangle and live-select blocks whose center is inside.
      const l = lasso.current;
      if (l) {
        l.x1 = e.clientX - rect.left;
        l.y1 = e.clientY - rect.top;
        const minX = Math.min(l.x0, l.x1), maxX = Math.max(l.x0, l.x1);
        const minY = Math.min(l.y0, l.y1), maxY = Math.max(l.y0, l.y1);
        setLassoRect({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
        const hit = new Set<string>();
        for (const [name, p] of Object.entries(posRef.current)) {
          if (name === 'user') continue; // the Team Lead is not selectable — only agents
          const cx = p.x + BLOCK_W / 2, cy = p.y + BLOCK_H / 2;
          if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) hit.add(name);
        }
        onSelect(hit);
        return;
      }

      const d = drag.current;
      if (!d) return;
      d.moved = true;
      const x = Math.max(0, e.clientX - rect.left - d.dx);
      const y = Math.max(0, e.clientY - rect.top - d.dy);
      setLayout({ ...getState().layout, [d.name]: { x, y } });
    };
    const up = (): void => {
      if (lasso.current) {
        lasso.current = null;
        setLassoRect(null);
        return;
      }
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      // A real drag persists the layout. A plain click no longer toggles
      // selection (removed by request — selection is lasso-only now).
      if (d.moved) invoke('quorum:saveLayout', { layout: getState().layout }).catch(() => {});
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [onSelect]);

  // A message arrow lives for ARROW_TTL after the message arrives, then fades.
  // Without this, arrows were permanent and looked like constant live traffic.
  const ARROW_TTL = 4000;
  const [nowTick, setNowTick] = useState(0);
  // User-channel traffic animates too: 'user' has a block (the Team Lead).
  const recent = messages.filter(
    (m) => pos[m.from] && pos[m.to] && m.at && nowTick - m.at < ARROW_TTL,
  );
  useEffect(() => {
    if (recent.length === 0) return; // no active arrows → no animation loop
    let raf = 0;
    const tick = (): void => {
      setNowTick(Date.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [recent.length]);
  // Also refresh the clock when a new message lands, so a fresh arrow appears.
  useEffect(() => setNowTick(Date.now()), [messages.length]);

  const arrows = recent.map((m, i) => {
    const age = Math.max(0, nowTick - (m.at ?? 0));
    const life = 1 - age / ARROW_TTL; // 1 = fresh, 0 = expired
    return { m, key: `${m.at}-${i}`, dim: !inThread(m, thread), life };
  });
  // Half-extents used for stable block-edge entry/exit points (+small margin).
  const HW = BLOCK_W / 2 + 4;
  const HH = BLOCK_H / 2 + 4;
  // Composer traffic is YOU, not the Team Lead: it never crosses the bridge,
  // so it must not fly to the lead's block. It flies to a human mark that
  // appears just below the lead block (the user channel's corner of the
  // canvas) for as long as the message is in flight, then fades with it.
  const HUMAN_R = 16;
  const humanAt = (p: { x: number; y: number }): { x: number; y: number } => ({
    x: p.x + BLOCK_W / 2,
    y: p.y + BLOCK_H + 56,
  });
  // Pairs with live traffic → their mesh line glows.
  const activePairs = new Set(recent.map((m) => pairKey(m.from, m.to)));

  return (
    <div
      className="canvas"
      ref={canvasRef}
      onMouseDown={(e) => {
        // Left-button drag on empty canvas starts a lasso selection.
        const onEmpty = e.target === canvasRef.current || (e.target as HTMLElement).tagName === 'svg';
        if (e.button !== 0 || !onEmpty) return;
        const rect = canvasRef.current!.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        lasso.current = { x0: x, y0: y, x1: x, y1: y };
        setLassoRect({ x, y, w: 0, h: 0 });
        onSelect(new Set());
      }}
    >
      <svg className="canvas-svg">
        <defs>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* Static full-mesh connections. A pair with a live message glows bright.
            The Team Lead ('user') is part of the mesh — it is wired to every agent. */}
        {(() => {
          const nodes = ['user', ...agents.map((a) => a.name)];
          return nodes.flatMap((a, i) =>
            nodes.slice(i + 1).map((b) => {
              const pa = pos[a], pb = pos[b];
              if (!pa || !pb) return null;
              const active = activePairs.has(pairKey(a, b));
              const acx = pa.x + BLOCK_W / 2, acy = pa.y + BLOCK_H / 2;
              const bcx = pb.x + BLOCK_W / 2, bcy = pb.y + BLOCK_H / 2;
              const e1 = edgePoint(acx, acy, bcx, bcy, HW, HH);
              const e2 = edgePoint(bcx, bcy, acx, acy, HW, HH);
              // Active glow follows the traffic's color story: Team Lead
              // links burn violet, agent-to-agent links burn bright cyan.
              const leadLink = a === 'user' || b === 'user';
              return (
                <line
                  key={`link-${a}-${b}`}
                  x1={e1.x} y1={e1.y} x2={e2.x} y2={e2.y}
                  stroke={active ? (leadLink ? 'var(--violet)' : 'var(--cyan)') : leadLink ? 'var(--violet-dim)' : 'var(--panel-border)'}
                  strokeWidth={active ? 1.5 : 1}
                  opacity={active ? 0.55 : 0.4}
                />
              );
            }),
          );
        })()}

        {/* A message = a comet gliding along a curved orbit from the sender's
            edge to the recipient's edge (animation-lab pick #8). The arc bows
            to the LEFT of the travel direction, so A↔B two-way traffic flies
            on opposite arcs and never overlaps. Eased motion + fading tail. */}
        {arrows.map(({ m, key, dim, life }) => {
          const a = pos[m.from]!;
          const b = pos[m.to]!;
          const acx = a.x + BLOCK_W / 2, acy = a.y + BLOCK_H / 2;
          const bcx = b.x + BLOCK_W / 2, bcy = b.y + BLOCK_H / 2;
          // The user end of composer traffic is the human mark, not the lead
          // block — so the message visibly flows to (or from) YOU.
          const you = m.via === 'composer';
          const youFrom = you && m.from === 'user';
          const youTo = you && m.to === 'user';
          const hp = youFrom ? humanAt(a) : youTo ? humanAt(b) : null;
          const s = youFrom
            ? edgeOfCircle(hp!, bcx, bcy, HUMAN_R + 4)
            : edgePoint(acx, acy, youTo ? hp!.x : bcx, youTo ? hp!.y : bcy, HW, HH);
          const e = youTo
            ? edgeOfCircle(hp!, acx, acy, HUMAN_R + 4)
            : edgePoint(bcx, bcy, youFrom ? hp!.x : acx, youFrom ? hp!.y : acy, HW, HH);
          const dx = e.x - s.x, dy = e.y - s.y;
          const len = Math.hypot(dx, dy) || 1;
          const bow = Math.min(40, len * 0.25); // gentle on short hops
          const cpx = (s.x + e.x) / 2 - (dy / len) * bow;
          const cpy = (s.y + e.y) / 2 + (dx / len) * bow;
          const bez = (t: number): { x: number; y: number } => {
            const u = 1 - t;
            return {
              x: u * u * s.x + 2 * u * t * cpx + t * t * e.x,
              y: u * u * s.y + 2 * u * t * cpy + t * t * e.y,
            };
          };
          const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);
          const progress = Math.min(1, 1 - life); // 0 at sender → 1 at recipient
          const op = (dim ? 0.25 : 1) * Math.max(0.35, life);
          const head = bez(easeInOut(progress));
          // Color tells the story at a glance: violet = the Team Lead is
          // dispatching; bright cyan = everything else (agent↔agent, and
          // agents reporting back to the lead).
          const col = m.from === 'user' ? 'var(--violet)' : 'var(--cyan)';
          return (
            <g key={key} opacity={op}>
              {/* fading tail behind the head */}
              {[3, 2, 1].map((i) => {
                const p = bez(easeInOut(Math.max(0, progress - i * 0.05)));
                return (
                  <circle
                    key={i}
                    cx={p.x} cy={p.y}
                    r={4.5 - i}
                    fill={col}
                    opacity={1 - i * 0.25}
                  />
                );
              })}
              <g filter="url(#glow)">
                <circle cx={head.x} cy={head.y} r={5} fill={col} />
                <circle cx={head.x} cy={head.y} r={2.2} fill="#fff" opacity={0.9} />
              </g>
              {hp && (
                <g className="human-mark" transform={`translate(${hp.x} ${hp.y})`}>
                  <circle r={HUMAN_R} fill="var(--bg)" stroke={col} strokeWidth={1.2} opacity={0.9} />
                  <circle cx={0} cy={-4.5} r={4.3} fill={col} />
                  <path d="M -7.8 8.5 a 7.8 8.2 0 0 1 15.6 0 z" fill={col} />
                </g>
              )}
            </g>
          );
        })}
      </svg>

      {lassoRect && (
        <div
          className="lasso"
          style={{ left: lassoRect.x, top: lassoRect.y, width: lassoRect.w, height: lassoRect.h }}
        />
      )}

      {(() => {
        // The external Team Lead block: your Claude Code session, wired in
        // over the bridge. Draggable; not selectable (it is not an agent).
        const p = pos.user ?? { x: 80, y: 16 };
        const dim = thread ? !thread.includes('user') : false;
        return (
          <div
            className={`block lead-ext ${leadLevel !== 'off' ? leadLevel : ''}`}
            style={{ left: p.x, top: p.y, opacity: dim ? 0.4 : 1, cursor: 'grab' }}
            onMouseDown={(e) => onBlockDown(e, 'user')}
            title="Your Claude Code session, connected over the bridge (MCP). Drag to move."
          >
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <span className="name">Team Lead</span>
              <span className="lead-badge">Main Claude Code</span>
            </div>
            <div className="desc">Your main Claude Code session — talks over the bridge; splits work across the team</div>
            {leadLevel !== 'off' && (
              <div className="activity">
                <span className="spinner" />
                {leadLevel === 'driving' ? 'driving the team…' : 'working…'}
              </div>
            )}
            {pendingReplies > 0 && (
              <div
                className="pending-replies"
                title="Replies the Team Lead has not collected yet. MCP is client-pull — the app cannot wake your Claude Code session, so ask it to check."
              >
                {pendingReplies} repl{pendingReplies === 1 ? 'y' : 'ies'} uncollected
              </div>
            )}
          </div>
        );
      })()}

      {agents.map((a) => {
        const p = pos[a.name] ?? { x: 0, y: 0 };
        const dim = thread ? !thread.includes(a.name) : false;
        const isSelected = selected.has(a.name);
        return (
          <div
            key={a.name}
            data-name={a.name}
            className={`block ${a.state} ${a.lead ? 'lead' : ''} ${isSelected ? 'selected' : ''} ${
              a.state !== 'busy' && roomLive ? 'listening' : ''
            }`}
            style={{ left: p.x, top: p.y, opacity: dim ? 0.4 : 1, cursor: 'grab' }}
            onMouseDown={(e) => onBlockDown(e, a.name)}
            onDoubleClick={() => onInspect(a.name)}
            title="Double-click for model & permissions · drag to move · lasso to select"
          >
            {a.state !== 'busy' && roomLive && (
              <span className="ear" title="Hearing the lead's conversation — this costs it no turn">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                  strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  {/* ear */}
                  <path d="M10.5 21c-1.1 0-1.6-.8-1.6-1.8 0-2.2 2.6-2.8 2.6-5.1 0-1-.8-1.8-1.8-1.8s-1.8.8-1.8 1.9" />
                  <path d="M7.2 9.3a4.6 4.6 0 0 1 9.2.2c0 3.9-2.6 4.6-2.6 7.4 0 1.5-.6 2.4-1.6 2.9" />
                  {/* sound coming in */}
                  <path d="M4.6 5.2 2.4 3.6M3.3 10H1M4.6 14.6 2.4 16.2" />
                </svg>
              </span>
            )}
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <span className="name">{a.name}</span>
              {a.lead && <span className="lead-badge">lead</span>}
              <button
                className="term-btn"
                title={`Open ${a.name}'s terminal — everything it receives, does and sends`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onTerminal(a.name);
                }}
              >
                {'>_'}
              </button>
            </div>
            <div className="desc">{a.desc}</div>
            <div className="foot">
              <span className={`dot ${a.state}`} />
              <span>{a.state}</span>
              <span className="model-tag">{a.model}</span>
              <span
                className={`usage ${a.state === 'busy' ? 'busy' : ''}`}
                style={{ marginLeft: 'auto' }}
                title={`${a.usage.turns} turns · ${a.usage.out} output tokens · ${a.usage.in} input tokens (cumulative this session)`}
              >
                {a.usage.turns} {a.usage.turns === 1 ? 'turn' : 'turns'} · {fmtTokens(a.usage.out)} tok
              </span>
            </div>
            {a.state === 'busy' && activity[a.name] && (
              <div className="activity">
                <span className="spinner" />
                {activity[a.name]!.text}
                <span className="elapsed">{fmtElapsed(Date.now() - activity[a.name]!.since)}</span>
              </div>
            )}
          </div>
        );
      })}

      {permissions.length > 0 && (
        <div className="perms">
          {permissions.map((p) => (
            <div className="perm" key={p.id}>
              <div className="title">{p.agent} requests permission</div>
              <div className="tool">{p.toolName}</div>
              <div className="detail">{JSON.stringify(p.input)}</div>
              <div className="actions">
                <button className="allow" onClick={() => invoke('quorum:resolvePermission', { id: p.id, behavior: 'allow' })}>Allow</button>
                <button className="deny" onClick={() => invoke('quorum:resolvePermission', { id: p.id, behavior: 'deny' })}>Deny</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MeetingRoom({
  thread,
  onSelectThread,
  selected,
  onClearSelection,
}: {
  thread: [string, string] | null;
  onSelectThread: (t: [string, string] | null) => void;
  selected: string[];
  onClearSelection: () => void;
}): JSX.Element {
  const messages = useStore((s) => s.messages);
  const agents = useStore((s) => s.agents);
  const activity = useStore((s) => s.activity);
  const busy = agents.filter((a) => a.state === 'busy');
  const [text, setText] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages.length, busy.length]);

  const [routeHint, setRouteHint] = useState<string | null>(null);
  const send = (): void => {
    const t = text.trim();
    if (!t) return;
    setRouteHint(null);
    invoke('quorum:sendUserInput', { text: t, selected })
      .then((r) => {
        if (r.routed === 0) {
          setRouteHint('Not delivered — no agents on the team yet. Add some from the Marketplace.');
        }
      })
      .catch(() => {});
    setText('');
  };

  // Where the next message goes, for the composer hint. Plain text goes to
  // the AGENTS (whole team) — the Team Lead is reached from Claude Code.
  const target =
    selected.length === 1
      ? selected[0]!
      : selected.length > 1
        ? `${selected.length} selected agents`
        : 'the agents (whole team)';

  return (
    <div className="room">
      {selected.length > 0 && (
        <div className="selection-bar">
          Talking to <b>{selected.join(', ')}</b>
          {selected.length > 1 && ' (they will coordinate)'}
          <button onClick={onClearSelection}>clear selection ✕</button>
        </div>
      )}
      <div className="log" ref={logRef}>
        {messages.length === 0 && <div className="empty">No traffic yet. Send a message to the team below.</div>}
        {messages.map((m: BusMessage, i) => {
          const isAgentPair = m.from !== 'user' && m.to !== 'user';
          const dim = !inThread(m, thread);
          // The 'user' channel wears its real face: bridge traffic is the
          // Team Lead (your Claude Code session); composer input is you.
          const fromName = m.from === 'user' ? userChannelName(m.via) : m.from;
          const toName = m.to === 'user' ? userChannelName(m.via) : m.to;
          return (
            <div
              className={`msg ${m.to === 'user' ? 'to-user' : ''} ${m.from === 'user' ? 'from-user' : ''} ${isAgentPair ? 'clickable' : ''}`}
              key={i}
              style={{ opacity: dim ? 0.35 : 1 }}
              onClick={() => isAgentPair && onSelectThread([m.from, m.to])}
            >
              <span className="from">{fromName}</span>
              <span className="arrow">→</span>
              <span className="to">{toName}</span>
              <span className="body">{displayContent(m.content)}</span>
            </div>
          );
        })}
        {busy.map((a) => (
          <div className="msg working" key={`busy-${a.name}`}>
            <span className="spinner" />
            <span className="from">{a.name}</span>
            <span className="working-text">{activity[a.name]?.text ?? 'working…'}</span>
          </div>
        ))}
      </div>
      {routeHint && <div className="route-hint">{routeHint}</div>}
      <div className="composer">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder={`Message ${target}…  @agent for one, @everyone for all`}
        />
        <button onClick={send}>Send</button>
      </div>
    </div>
  );
}

function Marketplace({ onClose }: { onClose: () => void }): JSX.Element {
  const [all, setAll] = useState<CatalogAgent[]>([]);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'all' | 'wshobson' | 'automotive' | 'finance'>('all');
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const agents = useStore((s) => s.agents); // stable array reference from the store
  const onTeam = useMemo(() => new Set(agents.map((a) => a.name)), [agents]);

  useEffect(() => {
    invoke('marketplace:list', undefined).then((r) => setAll(r.agents)).catch(() => {});
  }, []);

  // Search matches across all columns (name, description, category, source, model).
  const q = query.trim().toLowerCase();
  const searched = q
    ? all.filter((a) =>
        [a.name, a.description, a.category, a.source, a.model ?? ''].some((f) => f.toLowerCase().includes(q)),
      )
    : all;

  const bySource = (s: string): CatalogAgent[] => searched.filter((a) => a.source === s);
  const otherSources = (a: CatalogAgent): boolean =>
    a.source !== 'wshobson' && a.source !== 'automotive' && a.source !== 'finance';

  // Counts per tab (respect the current search) for the tab labels.
  const counts = {
    all: searched.length,
    wshobson: bySource('wshobson').length,
    automotive: bySource('automotive').length,
    finance: bySource('finance').length,
  };

  // Which sections to render, driven by the active tab.
  const showW = tab === 'all' || tab === 'wshobson';
  const showA = tab === 'all' || tab === 'automotive';
  const showF = tab === 'all' || tab === 'finance';
  const wshobson = showW ? bySource('wshobson') : [];
  const automotive = showA ? bySource('automotive') : [];
  const finance = showF ? bySource('finance') : [];
  const other = tab === 'all' ? searched.filter(otherSources) : [];

  const add = (a: CatalogAgent): void => {
    setAdding((s) => new Set(s).add(a.file));
    invoke('quorum:addAgent', { file: a.file })
      .catch(() => {})
      .finally(() => setAdding((s) => {
        const n = new Set(s);
        n.delete(a.file);
        return n;
      }));
  };

  const Section = ({ title, rows }: { title: string; rows: CatalogAgent[] }): JSX.Element => (
    <div className="mk-section">
      <h3>{title} <span className="mk-count">{rows.length}</span></h3>
      <div className="mk-grid">
        {rows.map((a) => {
          const already = onTeam.has(a.name);
          return (
            <div className="mk-card" key={a.file}>
              <div className="mk-card-head">
                <span className="mk-name">{a.name}</span>
                <span className="mk-cat">{a.category}</span>
              </div>
              <div className="mk-desc">{a.description}</div>
              <div className="mk-foot">
                <span className="mk-len">{a.promptLen.toLocaleString()} chars{a.model ? ` · ${a.model}` : ''}</span>
                <button
                  className="mk-add"
                  disabled={already || adding.has(a.file)}
                  onClick={() => add(a)}
                >
                  {already ? 'on team' : adding.has(a.file) ? 'adding…' : '+ add to team'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="marketplace" onClick={(e) => e.stopPropagation()}>
        <div className="mk-head">
          <h2>⊞ Agent Marketplace <span className="mk-count">{all.length}</span></h2>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <input
          className="mk-search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search all fields — e.g. safety, rust, kubernetes, ISO 26262…"
        />
        <div className="mk-tabs">
          <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>All <span className="mk-count">{counts.all}</span></button>
          <button className={tab === 'wshobson' ? 'on' : ''} onClick={() => setTab('wshobson')}>wshobson <span className="mk-count">{counts.wshobson}</span></button>
          <button className={tab === 'automotive' ? 'on' : ''} onClick={() => setTab('automotive')}>automotive <span className="mk-count">{counts.automotive}</span></button>
          <button className={tab === 'finance' ? 'on' : ''} onClick={() => setTab('finance')}>finance <span className="mk-count">{counts.finance}</span></button>
        </div>
        <div className="mk-body">
          {wshobson.length + automotive.length + finance.length + other.length === 0 && (
            <div className="empty">No agents match “{query}”.</div>
          )}
          {wshobson.length > 0 && <Section title="wshobson" rows={wshobson} />}
          {automotive.length > 0 && <Section title="automotive" rows={automotive} />}
          {finance.length > 0 && <Section title="finance (anthropics/financial-services)" rows={finance} />}
          {other.length > 0 && <Section title="other" rows={other} />}
        </div>
      </div>
    </div>
  );
}
