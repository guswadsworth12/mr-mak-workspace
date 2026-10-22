// Studio board: tasks, gates, decisions and an activity log kept as plain
// Markdown inside a game project's `studio/` folder. Obsidian can open the
// folder as a vault; the CLI, the hooks and the desktop service all read and
// write the same files, so there is one record of what happened.
//
// This module has no dependencies outside Node so the CLI and the Claude Code
// hooks can import it without the service's node_modules.
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile, open } from 'node:fs/promises';
import path from 'node:path';

export const STATUSES = ['backlog', 'ready', 'doing', 'qa', 'review', 'blocked', 'done', 'cancelled'];
export const GATE_KINDS = ['plan', 'design', 'art', 'canon', 'merge', 'release'];
export const DECISIONS = { approve: 'approved', changes: 'changes', reject: 'rejected' };
export const ROLES = ['producer', 'godot-dev', 'art-pipeline', 'lore-keeper', 'qa-tester'];
export const OWNER_ACTOR = 'scott';

export const DEFAULT_CONFIG = {
  name: 'My Game',
  owner: 'Scott',
  autopilot: { enabled: false, agent: 'claude', effort: 'high', maxParallel: 2, autoQa: true },
  roles: {
    producer: { engine: false },
    'godot-dev': { engine: true },
    'art-pipeline': { engine: false },
    'lore-keeper': { engine: false },
    'qa-tester': { engine: true },
  },
  git: { protected: ['main', 'master'], workBranch: 'dev', blockCommitsOnProtected: true },
  gatedPaths: ['studio/canon/'],
  // execute_editor_script runs arbitrary GDScript in the editor, so it can do
  // anything the other gated tools do.
  gatedMcpTools: ['export_project', 'deploy_to_android', 'delete_scene', 'execute_editor_script'],
  digestHour: 21,
};

// ---------------------------------------------------------------- frontmatter

const KEY_ORDER = ['id', 'title', 'status', 'kind', 'role', 'task', 'goal', 'plan', 'depends', 'blocked_on', 'paths', 'tools', 'branch', 'chat', 'requested_by', 'decided_by', 'decision', 'gate', 'notified', 'closed', 'created', 'updated', 'decided'];

function unquote(value) {
  if (/^".*"$/.test(value)) { try { return JSON.parse(value); } catch { return value.slice(1, -1); } }
  if (/^'.*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}
function parseValue(raw) {
  const value = raw.trim();
  if (value === '' || value === '~' || value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(item => unquote(item.trim())).filter(Boolean);
  }
  return unquote(value);
}
function formatScalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value).replace(/[\r\n]+/g, ' ');
  return /^$|^\s|\s$|[:#[\]{},"'&*!|>%@`]|^(true|false|null|~|-)/.test(text) || /^\d/.test(text) && !/^\d{4}-\d\d-\d\d/.test(text) ? JSON.stringify(text) : text;
}
function formatValue(value) {
  return Array.isArray(value) ? `[${value.map(formatScalar).join(', ')}]` : formatScalar(value);
}
export function parseDoc(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { data: {}, body: text };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (pair) data[pair[1]] = parseValue(pair[2]);
  }
  return { data, body: text.slice(match[0].length) };
}
export function formatDoc(data, body = '') {
  const keys = [...KEY_ORDER.filter(key => key in data), ...Object.keys(data).filter(key => !KEY_ORDER.includes(key)).sort()];
  const lines = keys.filter(key => data[key] !== undefined).map(key => `${key}: ${formatValue(data[key])}`);
  return `---\n${lines.join('\n')}\n---\n${body.startsWith('\n') ? body : `\n${body}`}`;
}

// ---------------------------------------------------------------- helpers

export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
export const localDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const clock = (date = new Date()) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
export const slug = text => String(text || 'item').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 48).replace(/-+$/, '') || 'item';
const oneLine = (text, max = 240) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export const normalizeId = (prefix, value) => {
  const match = new RegExp(`^${prefix}-?(\\d{1,6})$`, 'i').exec(String(value || '').trim());
  if (!match) fail(`Use an ID like ${prefix}-0007.`);
  return `${prefix}-${match[1].padStart(4, '0')}`;
};

// Walk up from a folder to the nearest `studio/studio.json`.
export function findStudio(start = process.cwd()) {
  if (process.env.STUDIO_DIR && existsSync(path.join(process.env.STUDIO_DIR, 'studio.json'))) return path.resolve(process.env.STUDIO_DIR);
  let current = path.resolve(start);
  for (let depth = 0; depth < 16; depth++) {
    if (path.basename(current) === 'studio' && existsSync(path.join(current, 'studio.json'))) return current;
    if (existsSync(path.join(current, 'studio', 'studio.json'))) return path.join(current, 'studio');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function merge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) out[key] = value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key]) ? merge(base[key], value) : value;
  return out;
}

// ---------------------------------------------------------------- board

export class Board {
  constructor(root) {
    this.root = path.resolve(root);
    this.project = path.dirname(this.root);
    this.dirs = Object.fromEntries(['tasks', 'gates', 'decisions', 'log', 'canon', 'roles', 'digests', '.runtime'].map(name => [name, path.join(this.root, name)]));
  }
  static open(start) {
    const root = findStudio(start);
    return root ? new Board(root) : null;
  }

  config() {
    try { return merge(DEFAULT_CONFIG, JSON.parse(readFileSync(path.join(this.root, 'studio.json'), 'utf8'))); }
    catch { return DEFAULT_CONFIG; }
  }
  async saveConfig(patch) {
    const file = path.join(this.root, 'studio.json');
    const current = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'));
    const next = merge(current, patch);
    await atomicWrite(file, JSON.stringify(next, null, 2) + '\n');
    return merge(DEFAULT_CONFIG, next);
  }
  relative(file) { return path.relative(this.project, file).split(path.sep).join('/'); }

  // A directory lock keeps ID allocation and read-modify-write safe when
  // several agents call the CLI at once.
  async locked(fn) {
    const lock = path.join(this.dirs['.runtime'], 'lock');
    await mkdir(this.dirs['.runtime'], { recursive: true });
    for (let attempt = 0; ; attempt++) {
      try { await mkdir(lock); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const info = await stat(lock).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 30000) { await rm(lock, { recursive: true, force: true }); continue; }
        if (attempt > 200) fail('The studio board is busy. Try again.', 503);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try { return await fn(); } finally { await rm(lock, { recursive: true, force: true }); }
  }

  async files(kind) {
    const entries = await readdir(this.dirs[kind]).catch(() => []);
    return entries.filter(name => /^[A-Z]-\d{4}.*\.md$/.test(name)).sort().map(name => path.join(this.dirs[kind], name));
  }
  async nextId(kind, prefix) {
    const numbers = (await this.files(kind)).map(file => Number(/^[A-Z]-(\d{4})/.exec(path.basename(file))[1]));
    return `${prefix}-${String(Math.max(0, ...numbers) + 1).padStart(4, '0')}`;
  }
  async read(file) {
    const text = await readFile(file, 'utf8');
    const { data, body } = parseDoc(text);
    return { ...data, id: data.id || path.basename(file).slice(0, 6), file, path: this.relative(file), body };
  }
  async find(kind, prefix, id) {
    id = normalizeId(prefix, id);
    const file = (await this.files(kind)).find(item => path.basename(item).startsWith(id));
    if (!file) fail(`${id} does not exist.`, 404);
    return this.read(file);
  }
  async write(item) {
    const { file, path: _relative, body, ...data } = item;
    await atomicWrite(file, formatDoc(data, body));
  }
  async list(kind) {
    const items = [];
    for (const file of await this.files(kind)) { try { items.push(await this.read(file)); } catch { /* A half-written file is skipped until it is complete. */ } }
    return items;
  }

  // ------------------------------------------------------------ activity

  async activity({ actor = 'studio', task = null, kind = 'note', text }) {
    const at = new Date();
    const entry = { at: at.toISOString(), actor: oneLine(actor, 40) || 'studio', task: task || null, kind, text: oneLine(text, 400) };
    await mkdir(this.dirs.log, { recursive: true });
    const daily = path.join(this.dirs.log, `${localDay(at)}.md`);
    if (!existsSync(daily)) await writeFile(daily, `# Activity ${localDay(at)}\n\n`);
    const label = entry.task ? ` · [[${entry.task}]]` : '';
    await appendFile(daily, `- ${clock(at)} · **${entry.actor}**${label} · ${kind} · ${entry.text.replace(/\n/g, ' ')}\n`);
    await appendFile(path.join(this.dirs.log, 'activity.jsonl'), JSON.stringify(entry) + '\n');
    return entry;
  }
  async recentActivity(limit = 80) {
    const file = path.join(this.dirs.log, 'activity.jsonl');
    let handle;
    try {
      handle = await open(file, 'r');
      const { size } = await handle.stat();
      const length = Math.min(size, 256 * 1024);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').split('\n').filter(Boolean);
      if (length < size) lines.shift();
      return lines.slice(-limit).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).reverse();
    } catch { return []; }
    finally { await handle?.close(); }
  }
  async activitySince(since) {
    const file = path.join(this.dirs.log, 'activity.jsonl');
    const text = await readFile(file, 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(item => item && item.at >= since);
  }

  // ------------------------------------------------------------ tasks

  async createTask({ title, role = 'godot-dev', status = 'backlog', goal = '', acceptance = [], depends = [], plan = null, by = 'producer', notes = '' }) {
    title = oneLine(title, 120);
    if (!title) fail('A task needs a title.');
    if (!ROLES.includes(role)) fail(`Role must be one of: ${ROLES.join(', ')}.`);
    if (!STATUSES.includes(status)) fail(`Status must be one of: ${STATUSES.join(', ')}.`);
    const task = await this.locked(async () => {
      const id = await this.nextId('tasks', 'T');
      const created = now();
      const criteria = (Array.isArray(acceptance) ? acceptance : String(acceptance).split(/\n|;/)).map(item => oneLine(item)).filter(Boolean);
      const body = [
        `# ${title}`, '',
        '## Goal', goal.trim() || '_Describe the outcome._', '',
        '## Acceptance', ...(criteria.length ? criteria.map(item => `- [ ] ${item}`) : ['- [ ] _Add checks the result must pass._']), '',
        '## Notes', notes.trim(), '',
        '## Log', `- ${localDay()} ${clock()} · ${by} · created`, '',
      ].join('\n');
      const item = { id, title, status, role, plan: plan ? normalizeId('G', plan) : undefined, depends: depends.map(dep => normalizeId('T', dep)), chat: null, created, updated: created, file: path.join(this.dirs.tasks, `${id}-${slug(title)}.md`), body };
      await mkdir(this.dirs.tasks, { recursive: true });
      await this.write(item);
      return item;
    });
    await this.activity({ actor: by, task: task.id, kind: 'task', text: `created ${task.id} "${title}" for ${role} (${status})` });
    return this.find('tasks', 'T', task.id);
  }
  async task(id) { return this.find('tasks', 'T', id); }
  async tasks() { return this.list('tasks'); }

  async updateTask(id, patch = {}, { by = 'studio', note = '' } = {}) {
    const before = await this.task(id);
    if (patch.status && !STATUSES.includes(patch.status)) fail(`Status must be one of: ${STATUSES.join(', ')}.`);
    if (patch.role && !ROLES.includes(patch.role)) fail(`Role must be one of: ${ROLES.join(', ')}.`);
    const result = await this.locked(async () => {
      const task = await this.task(id);
      Object.assign(task, patch, { updated: now() });
      if (patch.status && patch.status !== 'blocked') task.blocked_on = undefined;
      const line = [patch.status && patch.status !== before.status ? `${before.status} → ${patch.status}` : '', oneLine(note, 600)].filter(Boolean).join(' — ');
      if (line) task.body = appendLog(task.body, `- ${localDay()} ${clock()} · ${by} · ${line}`);
      await this.write(task);
      return task;
    });
    if (patch.status && patch.status !== before.status) await this.activity({ actor: by, task: result.id, kind: 'status', text: `${result.id} ${before.status} → ${patch.status}${note ? ` — ${oneLine(note, 200)}` : ''}` });
    else if (note) await this.activity({ actor: by, task: result.id, kind: 'note', text: note });
    return result;
  }
  async noteTask(id, text, by = 'studio') { return this.updateTask(id, {}, { by, note: text }); }

  // A worker reports the result. With QA on, the task waits for the tester;
  // a QA task itself, or QA off, finishes it.
  async finishTask(id, summary, by) {
    const task = await this.task(id);
    const autoQa = this.config().autopilot.autoQa !== false;
    const status = autoQa && task.role !== 'qa-tester' && task.status !== 'qa' ? 'qa' : 'done';
    const result = await this.updateTask(id, { status, chat: status === 'qa' ? null : task.chat }, { by, note: `finished: ${summary}` });
    if (status === 'done') await this.closeGates(id);
    return result;
  }
  async qaResult(id, passed, summary, by = 'qa-tester') {
    const task = await this.task(id);
    if (task.status !== 'qa') fail(`${task.id} is ${task.status}, not waiting for QA.`);
    const result = await this.updateTask(id, { status: passed ? 'done' : 'ready', chat: null }, { by, note: `${passed ? 'QA passed' : 'QA failed, back to ready'}: ${summary}` });
    if (passed) await this.closeGates(id);
    return result;
  }
  async closeGates(taskId) {
    for (const gate of await this.gates()) {
      if (gate.task === taskId && gate.status === 'approved' && !gate.closed) { gate.closed = true; await this.write(gate); }
    }
  }

  // Ready tasks whose dependencies are done, oldest first.
  async readyTasks() {
    const tasks = await this.tasks();
    const done = new Set(tasks.filter(task => task.status === 'done').map(task => task.id));
    return tasks.filter(task => task.status === 'ready' && (task.depends || []).every(dep => done.has(dep)));
  }

  // ------------------------------------------------------------ gates

  async openGate({ kind, task = null, title, summary = '', options = '', recommendation = '', paths = [], tools = [], branch = null, by = 'agent' }) {
    if (!GATE_KINDS.includes(kind)) fail(`Gate kind must be one of: ${GATE_KINDS.join(', ')}.`);
    title = oneLine(title, 120);
    if (!title) fail('A gate needs a title.');
    // A permission gate lasts only while its task is open, so it must name one.
    if (!task && (['merge', 'release', 'canon'].includes(kind) || paths.length)) fail(`A ${kind} gate must name its task (--task T-####); the approval ends when that task does.`);
    if (kind === 'release' && !tools.length) fail('A release gate must list the engine tools it allows (--tools export_project,...).');
    if (task) task = (await this.task(task)).id;
    const gate = await this.locked(async () => {
      const id = await this.nextId('gates', 'G');
      const created = now();
      const body = [
        `# ${title}`, '',
        `**Requested by:** ${by}${task ? ` for [[${task}]]` : ''}`, '',
        '## What needs your decision', summary.trim() || '_No summary given._', '',
        ...(options.trim() ? ['## Options', options.trim(), ''] : []),
        ...(recommendation.trim() ? ['## Recommendation', recommendation.trim(), ''] : []),
        ...(paths.length ? ['## Covers', ...paths.map(item => `- \`${item}\``), ''] : []),
        ...(tools.length ? ['## Allows tools', ...tools.map(item => `- \`${item}\``), ''] : []),
        ...(branch ? ['## Branch', `\`${branch}\``, ''] : []),
        '## Your decision', '_Decide in Mr. Mak (Studio), on your phone, or run `studio gate decide` yourself. Agents cannot decide gates._', '',
      ].join('\n');
      const item = { id, title, kind, status: 'pending', task, paths: paths.length ? paths : undefined, tools: tools.length ? tools : undefined, branch: branch || undefined, requested_by: by, notified: false, created, updated: created, file: path.join(this.dirs.gates, `${id}-${slug(title)}.md`), body };
      await mkdir(this.dirs.gates, { recursive: true });
      await this.write(item);
      return item;
    });
    await this.activity({ actor: by, task, kind: 'gate', text: `opened ${gate.id} (${kind}) "${title}" — waiting on ${this.config().owner}` });
    if (task) {
      const current = await this.task(task);
      if (!['done', 'cancelled'].includes(current.status)) await this.updateTask(task, { status: 'blocked', blocked_on: gate.id }, { by, note: `waiting on ${gate.id}` });
    }
    return this.find('gates', 'G', gate.id);
  }
  async gate(id) { return this.find('gates', 'G', id); }
  async gates() { return this.list('gates'); }

  // Only the owner decides. The guard hook stops agents from calling this.
  async decideGate(id, decision, note = '', by = OWNER_ACTOR) {
    const status = DECISIONS[decision];
    if (!status) fail('Decide with approve, changes or reject.');
    const gate = await this.gate(id);
    if (gate.status !== 'pending') fail(`${gate.id} was already ${gate.status}.`, 409);
    const decided = now();
    Object.assign(gate, { status, decided, decided_by: by, updated: decided });
    gate.body = gate.body.replace(/## Your decision[\s\S]*$/, `## Your decision\n**${status.toUpperCase()}** by ${by} on ${localDay()} ${clock()}${note.trim() ? `\n\n${note.trim()}` : ''}\n`);
    await this.write(gate);
    const record = await this.locked(async () => {
      const did = await this.nextId('decisions', 'D');
      const body = [`# ${gate.title}`, '', `**${status.toUpperCase()}** — ${gate.kind} gate [[${gate.id}]]${gate.task ? ` for [[${gate.task}]]` : ''}`, '', note.trim() ? `## Why\n${note.trim()}\n` : '', ''].join('\n');
      const item = { id: did, title: gate.title, gate: gate.id, task: gate.task || undefined, kind: gate.kind, decision: status, decided_by: by, created: decided, file: path.join(this.dirs.decisions, `${did}-${slug(gate.title)}.md`), body };
      await mkdir(this.dirs.decisions, { recursive: true });
      await this.write(item);
      return item;
    });
    await this.activity({ actor: by, task: gate.task, kind: 'decision', text: `${status} ${gate.id} "${gate.title}"${note ? ` — ${oneLine(note, 200)}` : ''} (${record.id})` });

    // A plan gate releases every task drafted under it.
    if (gate.kind === 'plan') {
      for (const task of await this.tasks()) {
        if (task.plan !== gate.id || task.status !== 'backlog') continue;
        if (status === 'approved') await this.updateTask(task.id, { status: 'ready' }, { by, note: `plan ${gate.id} approved` });
      }
    }
    if (gate.task) {
      const task = await this.task(gate.task).catch(() => null);
      if (task && task.status === 'blocked' && task.blocked_on === gate.id) {
        const next = status === 'approved' ? (task.role === 'producer' && gate.kind === 'plan' ? 'done' : 'ready') : status === 'changes' ? 'ready' : 'backlog';
        await this.updateTask(task.id, { status: next }, { by, note: status === 'approved' ? `${gate.id} approved${note ? `: ${note}` : ''}` : status === 'changes' ? `changes requested on ${gate.id}: ${note || 'see gate'}` : `${gate.id} rejected${note ? `: ${note}` : ''}` });
      }
    }
    return { gate: await this.gate(gate.id), decision: record };
  }

  // Used by the guard: an approved, still-open gate of one of these kinds
  // that covers a path, tool or branch. An approval lasts only while its task
  // is open: a gate without a task, or whose task is done or cancelled, allows
  // nothing.
  async approvedGate({ kinds, file = null, tool = null, branch = null }) {
    const tasks = new Map((await this.tasks()).map(task => [task.id, task]));
    const live = gate => gate.task && tasks.has(gate.task) && !['done', 'cancelled'].includes(tasks.get(gate.task).status);
    const gates = (await this.gates()).filter(gate => gate.status === 'approved' && !gate.closed && kinds.includes(gate.kind) && live(gate));
    return gates.find(gate => {
      if (tool) return (gate.tools || []).includes(tool);
      if (file) return (gate.paths || []).some(prefix => { const rel = prefix.replace(/^\.?\//, ''); return file === rel || file.startsWith(rel.endsWith('/') ? rel : `${rel}/`) || file === rel.replace(/\/$/, ''); });
      if (branch) return !gate.branch || gate.branch === branch;
      return true;
    }) || null;
  }

  // ------------------------------------------------------------ sessions

  runtimeFile() { return path.join(this.dirs['.runtime'], 'sessions.json'); }
  sessionMap() { try { return JSON.parse(readFileSync(this.runtimeFile(), 'utf8')); } catch { return {}; } }
  async bindSession(nativeId, value) {
    await this.locked(async () => {
      const map = this.sessionMap();
      if (value) map[nativeId] = value; else delete map[nativeId];
      await mkdir(this.dirs['.runtime'], { recursive: true });
      await atomicWrite(this.runtimeFile(), JSON.stringify(map, null, 2));
    });
  }

  // ------------------------------------------------------------ views

  async state() {
    const [tasks, gates, decisions, activity] = await Promise.all([this.tasks(), this.gates(), this.list('decisions'), this.recentActivity(80)]);
    const strip = ({ body, file, ...item }) => item;
    return {
      root: this.root, project: this.project, config: this.config(),
      tasks: tasks.map(strip), gates: gates.map(strip).reverse(), decisions: decisions.slice(-15).reverse().map(strip), activity,
      counts: Object.fromEntries(STATUSES.map(status => [status, tasks.filter(task => task.status === status).length])),
      waiting: gates.filter(gate => gate.status === 'pending').length,
    };
  }
  async detail(kind, id) {
    const item = kind === 'gate' ? await this.gate(id) : kind === 'task' ? await this.task(id) : await this.find('decisions', 'D', id);
    const { file, ...rest } = item;
    return rest;
  }

  async digest({ since = null, write = true } = {}) {
    const end = new Date();
    since ||= new Date(end.getTime() - 24 * 3600 * 1000).toISOString();
    const [tasks, gates, decisions, events] = await Promise.all([this.tasks(), this.gates(), this.list('decisions'), this.activitySince(since)]);
    const changed = status => events.filter(item => item.kind === 'status' && item.text.endsWith(`→ ${status}`) || item.kind === 'status' && item.text.includes(`→ ${status} `));
    const finished = [...new Set(changed('done').map(item => item.task))].map(id => tasks.find(task => task.id === id)).filter(Boolean);
    const waiting = gates.filter(gate => gate.status === 'pending');
    const decided = decisions.filter(item => item.created >= since);
    const blocked = tasks.filter(task => task.status === 'blocked' && !waiting.some(gate => gate.id === task.blocked_on));
    const doing = tasks.filter(task => ['doing', 'qa'].includes(task.status));
    const ready = tasks.filter(task => task.status === 'ready');
    const actors = {};
    for (const event of events) if (event.kind === 'tool') actors[event.actor] = (actors[event.actor] || 0) + 1;
    const lines = [
      `# Studio digest — ${localDay(end)}`, '',
      `_Since ${since.replace('T', ' ').replace(/\.\d+Z|Z/, ' UTC')}_`, '',
      `## Waiting on you (${waiting.length})`, ...(waiting.length ? waiting.map(gate => `- [[${gate.id}]] **${gate.kind}** — ${gate.title}${gate.task ? ` (for [[${gate.task}]])` : ''}`) : ['- Nothing. The agents are not blocked on you.']), '',
      `## Finished (${finished.length})`, ...(finished.length ? finished.map(task => `- [[${task.id}]] ${task.title} — ${task.role}`) : ['- Nothing finished in this window.']), '',
      `## Decisions you made (${decided.length})`, ...(decided.length ? decided.map(item => `- [[${item.id}]] ${item.decision} — ${item.title}`) : ['- None.']), '',
      `## In progress (${doing.length})`, ...(doing.length ? doing.map(task => `- [[${task.id}]] ${task.title} — ${task.role}, ${task.status}`) : ['- Nothing running.']), '',
      ...(blocked.length ? [`## Blocked without a gate (${blocked.length})`, ...blocked.map(task => `- [[${task.id}]] ${task.title}`), ''] : []),
      `## Up next (${ready.length} ready)`, ...ready.slice(0, 8).map(task => `- [[${task.id}]] ${task.title} — ${task.role}`), '',
      '## Agent activity', ...(Object.keys(actors).length ? Object.entries(actors).sort((a, b) => b[1] - a[1]).map(([actor, count]) => `- ${actor}: ${count} actions`) : ['- No logged tool activity.']), '',
    ];
    const text = lines.join('\n');
    let file = null;
    if (write) {
      await mkdir(this.dirs.digests, { recursive: true });
      file = path.join(this.dirs.digests, `${localDay(end)}.md`);
      await writeFile(file, text);
      await this.saveConfig({ lastDigest: end.toISOString() });
    }
    return { text, file, summary: { waiting: waiting.length, finished: finished.length, decided: decided.length, doing: doing.length, ready: ready.length, blocked: blocked.length } };
  }

  // Short text for an agent starting a session in this project.
  async briefing({ cli }) {
    const state = await this.state();
    const list = (items, fn) => items.length ? items.map(fn).join('\n') : '  (none)';
    const waiting = state.gates.filter(gate => gate.status === 'pending');
    const doing = state.tasks.filter(task => ['doing', 'qa'].includes(task.status));
    const ready = state.tasks.filter(task => task.status === 'ready');
    return [
      `# Studio: ${state.config.name}`,
      `This project is run through the Studio board at ${state.root}. Read the studio-protocol skill before changing the board.`,
      `Studio CLI: node "${cli}" <command>  (help: node "${cli}" help)`,
      '', `Waiting on ${state.config.owner} (${waiting.length}):`, list(waiting, gate => `  - ${gate.id} [${gate.kind}] ${gate.title}${gate.task ? ` (task ${gate.task})` : ''}`),
      `In progress (${doing.length}):`, list(doing, task => `  - ${task.id} [${task.role}, ${task.status}] ${task.title}`),
      `Ready (${ready.length}):`, list(ready.slice(0, 10), task => `  - ${task.id} [${task.role}] ${task.title}`),
      '', 'Rules: log meaningful steps with `task note`; never decide gates; open a gate and stop instead of guessing on design, art direction, canon, merges to protected branches or exports.',
    ].join('\n');
  }
}

function appendLog(body, line) {
  if (/## Log\s*\n/.test(body)) return body.replace(/\s*$/, '') + `\n${line}\n`;
  return `${body.replace(/\s*$/, '')}\n\n## Log\n${line}\n`;
}

async function atomicWrite(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temp, text);
  await rename(temp, file);
}
