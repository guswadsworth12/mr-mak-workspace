import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './studio.css'

// The Studio board for a game project: gates waiting on Scott, tasks by
// status, the agents' activity feed and the autopilot switch. Shared by the
// desktop Workspace (#/studio) and the phone app.

export interface StudioTask { id: string; title: string; status: string; role: string; depends?: string[]; blocked_on?: string; plan?: string; chat?: string | null; updated?: string; path: string; chatInfo?: { id: string; name: string; activity: string; open: boolean } | null }
export interface StudioGate { id: string; title: string; kind: string; status: string; task?: string | null; requested_by?: string; created?: string; decided?: string; path: string }
export interface StudioDecision { id: string; title: string; decision: string; gate: string; created: string }
export interface StudioEvent { at: string; actor: string; task: string | null; kind: string; text: string }
export interface StudioState {
  project: string; root: string; notifications: boolean
  config: { name: string; owner: string; autopilot: { enabled: boolean; maxParallel: number; autoQa: boolean; agent: string; effort: string }; roles?: Record<string, { engine?: boolean; agent?: string | null }> }
  tasks: StudioTask[]; gates: StudioGate[]; decisions: StudioDecision[]; activity: StudioEvent[]
  counts: Record<string, number>; waiting: number
}
interface StudioList { projects: { project: string; name: string; waiting: number; counts: Record<string, number>; autopilot: { enabled: boolean } }[]; notifications: boolean; cli: string }
type Call = <T>(path: string, data?: unknown) => Promise<T>

interface Props {
  call: Call
  mobile?: boolean
  subscribe?: (refresh: () => void) => () => void
  onOpenChat?: (id: string) => void
}

const COLUMNS: { status: string; label: string }[] = [
  { status: 'ready', label: 'Ready' },
  { status: 'doing', label: 'Working' },
  { status: 'qa', label: 'QA' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'backlog', label: 'Backlog' },
  { status: 'done', label: 'Done' },
]
const ROLE_LABEL: Record<string, string> = { producer: 'Producer', 'godot-dev': 'Godot dev', 'art-pipeline': 'Art', 'lore-keeper': 'Lore', 'qa-tester': 'QA' }
const KIND_LABEL: Record<string, string> = { plan: 'Plan', design: 'Design', art: 'Art', canon: 'Canon', merge: 'Merge', release: 'Release' }

function ago(iso?: string) {
  if (!iso) return ''
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}
const remember = (key: string, value?: string) => {
  try { if (value === undefined) return localStorage.getItem(key) || ''; localStorage.setItem(key, value) } catch { /* Storage can be unavailable. */ }
  return value || ''
}

function GateCard({ gate, call, project, onDone }: { gate: StudioGate; call: Call; project: string; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open || body !== null) return
    call<{ body: string }>(`/detail?project=${encodeURIComponent(project)}&kind=gate&id=${encodeURIComponent(gate.id)}`)
      .then(detail => setBody(detail.body.replace(/## Your decision[\s\S]*$/, '').replace(/\[\[([^\]]+)\]\]/g, '$1').trim()))
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }, [open, body, call, project, gate.id])
  async function decide(decision: 'approve' | 'changes' | 'reject') {
    if (decision !== 'approve' && !note.trim()) { setError(decision === 'changes' ? 'Say what should change.' : 'Say why, so the agents learn from it.'); return }
    setBusy(decision); setError('')
    try { await call('/decide', { project, gate: gate.id, decision, note }); onDone() }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy('') }
  }
  return (
    <article className={`studio-gate${open ? ' open' : ''}`}>
      <button className="studio-gate-head" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <span className={`studio-chip kind-${gate.kind}`}>{KIND_LABEL[gate.kind] || gate.kind}</span>
        <span className="studio-gate-title">{gate.title}</span>
        <span className="studio-meta">{gate.id}{gate.task ? ` · ${gate.task}` : ''} · {gate.requested_by || 'agent'} · {ago(gate.created)}</span>
      </button>
      {open && (
        <div className="studio-gate-body">
          {body === null && !error ? <p className="studio-muted">Loading…</p> : body && <div className="studio-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown></div>}
          <textarea value={note} onChange={event => setNote(event.target.value)} placeholder="Note for the agents (needed for changes or reject)" rows={3} />
          {error && <p className="studio-error">{error}</p>}
          <div className="studio-actions">
            <button className="studio-approve" disabled={!!busy} onClick={() => void decide('approve')}>{busy === 'approve' ? 'Approving…' : 'Approve'}</button>
            <button disabled={!!busy} onClick={() => void decide('changes')}>{busy === 'changes' ? 'Sending…' : 'Ask for changes'}</button>
            <button className="studio-reject" disabled={!!busy} onClick={() => void decide('reject')}>{busy === 'reject' ? 'Rejecting…' : 'Reject'}</button>
          </div>
        </div>
      )}
    </article>
  )
}

// Where a dragged task may land. Working starts it in a chat; a task whose chat
// is still open stays out of the queue so it never gets a second agent.
function canDrop(task: StudioTask, status: string) {
  if (status === task.status) return false
  const chatOpen = !!task.chatInfo?.open
  if (status === 'doing') return !chatOpen && ['ready', 'backlog', 'blocked', 'qa'].includes(task.status)
  if (status === 'ready' || status === 'qa') return !chatOpen
  return true
}

function TaskCard({ task, mobile, onStart, onOpenChat, onDrag }: { task: StudioTask; mobile?: boolean; onStart?: (id: string) => void; onOpenChat?: (id: string) => void; onDrag?: (task: StudioTask | null) => void }) {
  const chat = task.chatInfo
  const drag = !mobile && onDrag ? {
    draggable: true,
    onDragStart: (event: DragEvent) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', task.id); onDrag(task) },
    onDragEnd: () => onDrag(null),
  } : {}
  return (
    <article className={`studio-task status-${task.status}${drag.draggable ? ' draggable' : ''}`} {...drag}>
      <div className="studio-task-top">
        <span className="studio-id">{task.id}</span>
        <span className={`studio-chip role-${task.role}`}>{ROLE_LABEL[task.role] || task.role}</span>
        {chat?.activity === 'working' && <span className="studio-pulse" title="Agent is working" />}
        {chat?.activity === 'waiting' && <span className="studio-chip attention">needs you</span>}
      </div>
      <p className="studio-task-title">{task.title}</p>
      <div className="studio-task-foot">
        <span className="studio-meta">{task.blocked_on ? `waiting on ${task.blocked_on}` : task.depends?.length ? `after ${task.depends.join(', ')}` : ago(task.updated)}</span>
        {chat?.open && onOpenChat && <button className="studio-link" onClick={() => onOpenChat(chat.id)}>Open chat</button>}
        {!mobile && onStart && ['ready', 'backlog'].includes(task.status) && <button className="studio-link" onClick={() => onStart(task.id)}>Start now</button>}
      </div>
    </article>
  )
}

const AGENT_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex' }

// Which agent each role's chats start on. A role left on Default follows the
// autopilot's agent; chats already running keep theirs.
function AgentPicker({ config, busy, onDefault, onRole, onEvery }: { config: StudioState['config']; busy: boolean; onDefault: (agent: string) => void; onRole: (role: string, agent: string | null) => void; onEvery: (agent: string) => void }) {
  const fallback = config.autopilot.agent === 'codex' ? 'codex' : 'claude'
  const other = fallback === 'codex' ? 'claude' : 'codex'
  const roles = Object.entries(config.roles ?? {})
  const moved = roles.filter(([, value]) => value.agent && value.agent !== fallback).length
  const options = Object.entries(AGENT_NAMES).map(([id, label]) => <option key={id} value={id}>{label}</option>)
  return (
    <details className="studio-agents">
      <summary>Agents <span className="studio-meta">{AGENT_NAMES[fallback]}{moved ? ` · ${moved} ${moved === 1 ? 'role' : 'roles'} on ${AGENT_NAMES[other]}` : ' for every role'}</span></summary>
      <div className="studio-agent-grid">
        <label><span>Default</span>
          <select value={fallback} disabled={busy} onChange={event => onDefault(event.target.value)}>{options}</select>
        </label>
        {roles.map(([role, value]) => (
          <label key={role}><span>{role}{role === 'qa-tester' && <small> · reviews every task</small>}</span>
            <select value={value.agent ?? ''} disabled={busy} onChange={event => onRole(role, event.target.value || null)}>
              <option value="">Default ({AGENT_NAMES[fallback]})</option>{options}
            </select>
          </label>
        ))}
      </div>
      <div className="studio-agent-foot">
        <button className="studio-link" disabled={busy} onClick={() => onEvery(other)}>Use {AGENT_NAMES[other]} for every role</button>
        <span className="studio-meta">Applies to chats started from now on. Codex chats are logged but not guarded by Studio's hooks.</span>
      </div>
    </details>
  )
}

export default function StudioBoard({ call, mobile = false, subscribe, onOpenChat }: Props) {
  const [list, setList] = useState<StudioList | null>(null)
  const [project, setProject] = useState(() => remember('mrmak.studio.project'))
  const [state, setState] = useState<StudioState | null>(null)
  const [dragging, setDragging] = useState<StudioTask | null>(null)
  const [over, setOver] = useState('')
  const [error, setError] = useState('')
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState('')
  const [showTools, setShowTools] = useState(false)
  const [showDone, setShowDone] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const next = await call<StudioList>('')
      setList(next)
      const chosen = next.projects.find(item => item.project === project)?.project || next.projects[0]?.project || ''
      if (chosen !== project) { setProject(chosen); remember('mrmak.studio.project', chosen) }
      setState(chosen ? await call<StudioState>(`/state?project=${encodeURIComponent(chosen)}`) : null)
      setError('')
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [call, project])

  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0)
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 4000)
    const stop = subscribe?.(() => void refresh())
    return () => { clearTimeout(first); clearInterval(timer); stop?.() }
  }, [refresh, subscribe])

  const pending = useMemo(() => state?.gates.filter(gate => gate.status === 'pending') ?? [], [state])
  const byStatus = useMemo(() => {
    const map = new Map<string, StudioTask[]>()
    for (const task of state?.tasks ?? []) { if (!map.has(task.status)) map.set(task.status, []); map.get(task.status)!.push(task) }
    for (const items of map.values()) items.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''))
    return map
  }, [state])
  const feed = useMemo(() => (state?.activity ?? []).filter(item => showTools || item.kind !== 'tool').slice(0, 60), [state, showTools])

  async function act<T>(fn: () => Promise<T>) {
    setBusy(true); setError('')
    try { await fn(); await refresh() }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const sendGoal = () => act(async () => { await call('/goal', { project, text: goal }); setGoal('') })
  const toggleAutopilot = () => act(() => call('/autopilot', { project, enabled: !state?.config.autopilot.enabled }))
  const start = (id: string) => void act(() => call('/start', { project, id }))
  const drop = (status: string) => {
    const task = dragging
    setDragging(null); setOver('')
    if (!task || !canDrop(task, status)) return
    if (status === 'doing') start(task.id)
    else void act(() => call('/task', { project, id: task.id, status, note: 'moved on the board' }))
  }
  const setDefaultAgent = (agent: string) => act(() => call('/autopilot', { project, agent }))
  const setRoleAgent = (role: string, agent: string | null) => act(() => call('/roles', { project, roles: { [role]: { agent } } }))
  // Every role on one agent: the default switches and roles pinned to the other agent return to it.
  const setEveryAgent = (agent: string) => act(async () => {
    await call('/autopilot', { project, agent })
    const pinned = Object.entries(state?.config.roles ?? {}).filter(([, value]) => value.agent && value.agent !== agent)
    if (pinned.length) await call('/roles', { project, roles: Object.fromEntries(pinned.map(([role]) => [role, { agent: null }])) })
  })
  const addProject = () => act(async () => { const next = await call<StudioState>('/projects', { path: adding.trim() }); setAdding(''); setProject(next.project); remember('mrmak.studio.project', next.project) })

  if (list && !list.projects.length) {
    return (
      <div className={`studio${mobile ? ' studio-mobile' : ''}`}>
        <section className="studio-empty">
          <h1>Studio</h1>
          <p>Studio runs your game through a board of tasks and decisions. Agents work in visible chats; anything that shapes the game waits for your approval.</p>
          {mobile ? <p className="studio-muted">Add a game project from Mr. Mak on your computer.</p> : (
            <form className="studio-add" onSubmit={event => { event.preventDefault(); void addProject() }}>
              <input value={adding} onChange={event => setAdding(event.target.value)} placeholder="/home/scott/Games/my-game (the folder with project.godot)" aria-label="Game project folder" />
              <button className="studio-approve" disabled={busy || !adding.trim()}>Add project</button>
            </form>
          )}
          {error && <p className="studio-error">{error}</p>}
        </section>
      </div>
    )
  }
  if (!state) return <div className={`studio${mobile ? ' studio-mobile' : ''}`}><p className="studio-muted studio-pad">{error || 'Opening Studio…'}</p></div>

  const autopilot = state.config.autopilot
  return (
    <div className={`studio${mobile ? ' studio-mobile' : ''}`}>
      <header className="studio-header">
        <div className="studio-title">
          {list && list.projects.length > 1 ? (
            <select value={project} onChange={event => { setProject(event.target.value); remember('mrmak.studio.project', event.target.value) }} aria-label="Game project">
              {list.projects.map(item => <option key={item.project} value={item.project}>{item.name}{item.waiting ? ` (${item.waiting})` : ''}</option>)}
            </select>
          ) : <h1>{state.config.name}</h1>}
          <span className="studio-meta">{state.counts.doing + state.counts.qa} working · {state.counts.ready} ready · {state.counts.done} done</span>
        </div>
        <button className={`studio-autopilot${autopilot.enabled ? ' on' : ''}`} onClick={() => void toggleAutopilot()} disabled={busy} aria-pressed={autopilot.enabled} title={autopilot.enabled ? `Starts ready tasks in visible chats, up to ${autopilot.maxParallel} at once` : 'Ready tasks wait until you start them'}>
          <span className="studio-switch" aria-hidden="true" />Autopilot {autopilot.enabled ? 'on' : 'off'}
        </button>
      </header>
      {!mobile && <AgentPicker config={state.config} busy={busy} onDefault={agent => void setDefaultAgent(agent)} onRole={(role, agent) => void setRoleAgent(role, agent)} onEvery={agent => void setEveryAgent(agent)} />}
      {!state.notifications && !mobile && <p className="studio-hint">Phone alerts are off. Set <code>STUDIO_NTFY_URL</code> in Mr. Mak's <code>.env</code> to get pinged when an agent needs you.</p>}
      {error && <p className="studio-error studio-pad">{error}</p>}

      <form className="studio-goal" onSubmit={event => { event.preventDefault(); if (goal.trim()) void sendGoal() }}>
        <textarea value={goal} onChange={event => setGoal(event.target.value)} rows={mobile ? 2 : 2} placeholder="Give the studio a goal. The Producer drafts a plan for you to approve." onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && goal.trim()) void sendGoal() }} />
        <button className="studio-approve" disabled={busy || !goal.trim()}>Plan it</button>
      </form>

      <section className="studio-section">
        <h2>Waiting on you <span className="studio-count">{pending.length}</span></h2>
        {pending.length ? pending.map(gate => <GateCard key={gate.id} gate={gate} call={call} project={project} onDone={() => void refresh()} />) : <p className="studio-muted">Nothing needs a decision. The agents are not blocked on you.</p>}
      </section>

      <section className="studio-section">
        <h2>Board</h2>
        <div className="studio-columns">
          {COLUMNS.filter(column => column.status !== 'done' || showDone || dragging).map(column => {
            const items = byStatus.get(column.status) ?? []
            if (mobile && !items.length) return null
            const target = dragging ? (canDrop(dragging, column.status) ? ' drop-ok' : ' drop-no') : ''
            const accepts = !!dragging && canDrop(dragging, column.status)
            return (
              <div
                className={`studio-column col-${column.status}${target}${over === column.status && accepts ? ' drop-over' : ''}`} key={column.status}
                onDragOver={accepts ? event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; if (over !== column.status) setOver(column.status) } : undefined}
                onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(value => value === column.status ? '' : value) }}
                onDrop={accepts ? event => { event.preventDefault(); drop(column.status) } : undefined}
              >
                <h3>{column.label} <span className="studio-count">{items.length}</span>{accepts && column.status === 'doing' && <span className="studio-meta"> · drop to start</span>}</h3>
                {items.slice(0, column.status === 'done' ? 12 : 40).map(task => <TaskCard key={task.id} task={task} mobile={mobile} onStart={start} onOpenChat={onOpenChat} onDrag={busy ? undefined : setDragging} />)}
              </div>
            )
          })}
        </div>
        <button className="studio-link" onClick={() => setShowDone(value => !value)}>{showDone ? 'Hide done' : `Show done (${state.counts.done})`}</button>
      </section>

      <div className="studio-split">
        <section className="studio-section">
          <h2>Activity <label className="studio-toggle"><input type="checkbox" checked={showTools} onChange={event => setShowTools(event.target.checked)} /> tool calls</label></h2>
          <ol className="studio-feed">
            {feed.map((item, index) => (
              <li key={`${item.at}-${index}`} className={`feed-${item.kind}`}>
                <time dateTime={item.at}>{new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                <strong>{item.actor}</strong>
                {item.task && <span className="studio-id">{item.task}</span>}
                <span>{item.text}</span>
              </li>
            ))}
            {!feed.length && <li className="studio-muted">No activity yet.</li>}
          </ol>
        </section>
        <section className="studio-section">
          <h2>Your decisions</h2>
          <ul className="studio-decisions">
            {state.decisions.map(item => <li key={item.id}><span className={`studio-chip decision-${item.decision}`}>{item.decision}</span> {item.title} <span className="studio-meta">{item.gate} · {ago(item.created)}</span></li>)}
            {!state.decisions.length && <li className="studio-muted">None yet.</li>}
          </ul>
          {!mobile && <button className="studio-link" disabled={busy} onClick={() => void act(() => call('/digest', { project }))}>Write today's digest</button>}
        </section>
      </div>
    </div>
  )
}
