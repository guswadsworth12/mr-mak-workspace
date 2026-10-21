// Studio inside the desktop service: watches each attached game project's
// board, runs the autopilot that hands ready tasks to visible agent chats,
// follows those chats, and sends phone alerts.
//
// Agents never run hidden: every worker is a normal titled chat in Chats,
// grouped under "Studio · <game>", that Scott can open, read and steer.
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Board, localDay, ROLES } from './board.mjs';
import { initStudio, STUDIO_CLI } from './setup.mjs';
import { Notifier } from './notify.mjs';

const TICK_MS = 5000;
const ascii = text => String(text || '').normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, "'").replace(/\s+/g, ' ').trim();
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export class StudioManager extends EventEmitter {
  constructor({ repo, sessions, settings, saveSettings, env = {}, mobileOrigin = () => '' }) {
    super();
    this.repo = repo;
    this.sessions = sessions;
    this.settings = settings;
    this.saveSettings = saveSettings;
    this.mobileOrigin = mobileOrigin;
    this.notifier = new Notifier(env);
    this.boards = new Map();
    this.seen = new Map(); // project → { activityAt, done:Set }
    this.chatSignals = new Map(); // chat id → last signal key
    this.busy = false;
    this.timer = null;
  }

  async init() {
    for (const project of this.settings().studioProjects || []) {
      const board = Board.open(project);
      if (board && board.project === path.resolve(project)) this.track(board);
    }
    this.onSession = session => { this.watchChat(session).catch(error => this.emit('error', error)); };
    this.sessions.on('session', this.onSession);
    this.timer = setInterval(() => this.tick().catch(error => this.emit('error', error)), TICK_MS);
    return this;
  }
  close() { clearInterval(this.timer); this.sessions.off('session', this.onSession); }

  track(board) {
    this.boards.set(board.project, board);
    if (!this.seen.has(board.project)) this.seen.set(board.project, { activityAt: new Date().toISOString(), done: null });
  }
  board(project) {
    const board = this.boards.get(path.resolve(String(project || '')));
    if (!board) fail('That project is not in Studio. Add it first.', 404);
    return board;
  }
  changed(project) { this.emit('changed', { project }); }

  // ---------------------------------------------------------------- API

  async list() {
    const projects = [];
    for (const board of this.boards.values()) {
      if (!existsSync(board.root)) continue;
      const state = await board.state();
      projects.push({ project: board.project, name: state.config.name, waiting: state.waiting, counts: state.counts, autopilot: state.config.autopilot });
    }
    return { projects, notifications: this.notifier.configured, cli: STUDIO_CLI };
  }
  async state(project) {
    const board = this.board(project);
    const state = await board.state();
    const chats = new Map(this.sessions.list().map(item => [item.id, item]));
    state.tasks = state.tasks.map(task => ({ ...task, chatInfo: task.chat && chats.has(task.chat) ? { id: task.chat, name: chats.get(task.chat).name, activity: chats.get(task.chat).activity, open: chats.get(task.chat).open } : null }));
    return { ...state, notifications: this.notifier.configured };
  }
  async detail(project, kind, id) { return this.board(project).detail(kind, id); }

  async addProject(folder, { create = true, name } = {}) {
    const project = path.resolve(String(folder || ''));
    if (!path.isAbsolute(String(folder || '')) || !existsSync(project)) fail('Choose an existing project folder.');
    let board = Board.open(project);
    if (!board || board.project !== project) {
      if (!create) fail('This folder has no studio/ yet.');
      board = (await initStudio(project, { name })).board;
    }
    const list = new Set(this.settings().studioProjects || []);
    list.add(project);
    this.settings().studioProjects = [...list];
    await this.saveSettings();
    this.track(board);
    this.changed(project);
    return this.state(project);
  }
  async removeProject(project) {
    const resolved = path.resolve(String(project || ''));
    this.boards.delete(resolved); this.seen.delete(resolved);
    this.settings().studioProjects = (this.settings().studioProjects || []).filter(item => path.resolve(item) !== resolved);
    await this.saveSettings();
    return this.list();
  }

  async decide(project, gate, decision, note = '') {
    const board = this.board(project);
    const result = await board.decideGate(gate, decision, String(note || '').slice(0, 4000));
    this.changed(board.project);
    setTimeout(() => this.tick().catch(() => {}), 300);
    return result;
  }
  async setAutopilot(project, patch) {
    const board = this.board(project);
    const allowed = {};
    if (typeof patch.enabled === 'boolean') allowed.enabled = patch.enabled;
    if (Number.isInteger(patch.maxParallel) && patch.maxParallel >= 1 && patch.maxParallel <= 6) allowed.maxParallel = patch.maxParallel;
    if (typeof patch.autoQa === 'boolean') allowed.autoQa = patch.autoQa;
    if (['claude', 'codex'].includes(patch.agent)) allowed.agent = patch.agent;
    if (['medium', 'high', 'xhigh'].includes(patch.effort)) allowed.effort = patch.effort;
    await board.saveConfig({ autopilot: allowed });
    await board.activity({ actor: 'scott', kind: 'setup', text: `autopilot ${JSON.stringify(allowed)}` });
    this.changed(board.project);
    if (allowed.enabled) setTimeout(() => this.tick().catch(() => {}), 300);
    return this.state(project);
  }
  async createTask(project, data) {
    const board = this.board(project);
    const task = await board.createTask({ title: data.title, role: data.role, status: data.status === 'backlog' ? 'backlog' : 'ready', goal: data.goal || '', acceptance: data.acceptance || '', depends: Array.isArray(data.depends) ? data.depends : [], by: 'scott' });
    this.changed(board.project);
    return task;
  }
  async setTask(project, id, data) {
    const board = this.board(project);
    const patch = {};
    if (data.status) patch.status = data.status;
    if (data.role) patch.role = data.role;
    const task = await board.updateTask(id, patch, { by: 'scott', note: data.note || '' });
    this.changed(board.project);
    return task;
  }
  // A goal becomes a Producer task that starts right away: planning is cheap
  // and it ends at a plan gate, so nothing is built before Scott approves.
  async goal(project, text) {
    const board = this.board(project);
    const goal = String(text || '').trim();
    if (!goal) fail('Describe the goal.');
    const title = goal.split(/[.\n]/)[0].slice(0, 90);
    const task = await board.createTask({ title: `Plan: ${title}`, role: 'producer', status: 'ready', goal, acceptance: 'A plan gate with 3-8 tasks drafted in backlog', by: 'scott' });
    const chat = await this.dispatch(board, task);
    this.changed(board.project);
    return { task, chat };
  }
  async start(project, id) {
    const board = this.board(project);
    const task = await board.task(id);
    if (!['ready', 'qa', 'backlog', 'blocked'].includes(task.status)) fail(`${task.id} is ${task.status}.`);
    if (task.status === 'backlog' || task.status === 'blocked') await board.updateTask(task.id, { status: 'ready' }, { by: 'scott', note: 'started by Scott' });
    return this.dispatch(board, await board.task(task.id));
  }
  async digest(project) {
    const board = this.board(project);
    const result = await board.digest({ since: board.config().lastDigest || null });
    await this.notify(board, { title: `${board.config().name}: daily digest`, message: digestLine(result.summary), priority: 2, tags: ['memo'] });
    return result;
  }

  // ---------------------------------------------------------------- workers

  rolePrompt(board, task, role) {
    const config = board.config();
    const cli = `node \`${STUDIO_CLI}\``;
    const qa = role === 'qa-tester' && task.role !== 'qa-tester';
    const steps = role === 'producer'
      ? 'Turn the goal in the task file into a plan: draft tasks in backlog under one plan gate, then end your turn.'
      : qa
        ? `Check the finished work against its acceptance list and report with: ${cli} task qa ${task.id} pass or fail --as qa-tester --summary ...`
        : `Run: ${cli} task start ${task.id} --as ${role}. Log progress with task note. Finish with task done ${task.id} --as ${role} --summary ... (what changed and how you verified it).`;
    return ascii([
      `You are the ${role} on the Studio board for ${config.name}. Your task is ${task.id}: ${task.title}.`,
      `Read, in order: studio/roles/${role}.md, the task file ${task.path}, and the studio-protocol skill at ${path.join(this.repo, '.claude', 'skills', 'studio-protocol', 'SKILL.md')}.`,
      `The Studio CLI is ${cli} and every board change takes --as ${role}.`,
      steps,
      `If you need a decision from ${config.owner} (design, art direction, canon, merging to main, exports), open a gate and end your turn; do not wait in a loop.`,
      `Mr. Mak skills are in ${path.join(this.repo, '.claude', 'skills')}.`,
    ].join(' ')).slice(0, 3900);
  }

  async dispatch(board, task) {
    const config = board.config();
    const role = task.status === 'qa' ? 'qa-tester' : task.role;
    if (!ROLES.includes(role)) fail(`Unknown role ${role}.`);
    // A task that paused on a gate keeps its chat: continue there with the decision.
    if (task.chat) {
      const existing = this.sessions.list().find(item => item.id === task.chat && item.open);
      if (existing) {
        const decision = (await board.gates()).filter(item => item.task === task.id && item.status !== 'pending').pop();
        const text = decision ? `${decision.id} was ${decision.status} by ${config.owner}. Read its decision in ${decision.path}, then continue ${task.id}.` : `Continue ${task.id}. Re-read the task file for any new notes.`;
        if (!existing.status || existing.status === 'stopped') await this.sessions.resume(existing.id);
        this.sessions.input(existing.id, text, { coordinator: true, submit: true });
        await board.updateTask(task.id, { status: 'doing' }, { by: 'autopilot', note: `resumed in chat ${existing.name}` });
        return existing;
      }
    }
    const prefix = task.status === 'qa' ? 'QA ' : '';
    const name = ascii(`${task.id} ${prefix}${task.title}`).slice(0, 80);
    const group = `Studio · ${ascii(config.name).slice(0, 48) || 'Game'}`;
    const agent = config.autopilot.agent === 'codex' ? 'codex' : 'claude';
    const session = await this.sessions.create({
      agent, cwd: board.project, name, group, effort: config.autopilot.effort || 'high',
      bypass: this.settings().defaultBypass === true,
      initialPrompt: this.rolePrompt(board, task, role), readDir: this.repo,
    });
    if (session.nativeId) await board.bindSession(session.nativeId, { task: task.id, role, chat: session.id });
    await board.updateTask(task.id, { status: task.status === 'qa' ? 'qa' : 'doing', chat: session.id }, { by: 'autopilot', note: `${role} started in chat "${name}"` });
    this.chatSignals.set(session.id, `start:${session.completionVersion || 0}`);
    this.changed(board.project);
    return session;
  }

  // Follow a worker chat: tell Scott when it is waiting on him or stopped
  // without updating the board; tidy the tab when its task has moved on.
  async watchChat(session) {
    for (const board of this.boards.values()) {
      const tasks = await board.tasks().catch(() => []);
      const task = tasks.find(item => item.chat === session.id);
      if (!task) continue;
      const key = `${session.activity}:${session.completionVersion}`;
      if (this.chatSignals.get(session.id) === key) return;
      const previous = this.chatSignals.get(session.id);
      this.chatSignals.set(session.id, key);
      if (session.activity === 'waiting') {
        await board.activity({ actor: 'autopilot', task: task.id, kind: 'attention', text: `${task.id} chat "${session.name}" is waiting for you (permission or question)` });
      } else if (session.activity === 'idle' && previous && !previous.startsWith('start') && ['doing', 'qa'].includes(task.status) && session.completionVersion > Number(previous.split(':')[1] || 0)) {
        await board.activity({ actor: 'autopilot', task: task.id, kind: 'attention', text: `${task.id} worker ended its turn without finishing — it may be asking you something in "${session.name}"` });
      }
      this.changed(board.project);
      return;
    }
  }

  // ---------------------------------------------------------------- loop

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const board of this.boards.values()) {
        if (!existsSync(board.root)) continue;
        await this.alerts(board);
        await this.tidy(board);
        if (board.config().autopilot.enabled) await this.autopilot(board);
        await this.scheduledDigest(board);
      }
    } finally { this.busy = false; }
  }

  async autopilot(board) {
    const config = board.config();
    const open = new Map(this.sessions.list().filter(item => item.open).map(item => [item.id, item]));
    const tasks = await board.tasks();
    const running = tasks.filter(task => ['doing', 'qa'].includes(task.status) && task.chat && open.has(task.chat));
    let slots = Math.max(0, (config.autopilot.maxParallel || 2) - running.length);
    if (!slots) return;
    const engineBusy = () => running.some(task => config.roles?.[task.status === 'qa' ? 'qa-tester' : task.role]?.engine);
    const done = new Set(tasks.filter(task => task.status === 'done').map(task => task.id));
    const candidates = [
      ...tasks.filter(task => task.status === 'qa' && !(task.chat && open.has(task.chat))),
      ...tasks.filter(task => task.status === 'ready' && (task.depends || []).every(dep => done.has(dep))),
    ];
    for (const task of candidates) {
      if (!slots) break;
      const role = task.status === 'qa' ? 'qa-tester' : task.role;
      // One agent drives the Godot editor at a time.
      if (config.roles?.[role]?.engine && engineBusy()) continue;
      try {
        await this.dispatch(board, task);
        running.push(task); slots--;
      } catch (error) {
        await board.updateTask(task.id, { status: 'blocked' }, { by: 'autopilot', note: `could not start a chat: ${error.message}` });
      }
    }
  }

  // Close a worker tab once its task has moved on and the agent is idle.
  // The conversation stays in History.
  async tidy(board) {
    const open = new Map(this.sessions.list().filter(item => item.open).map(item => [item.id, item]));
    const map = board.sessionMap();
    for (const [nativeId, bound] of Object.entries(map)) {
      const chat = open.get(bound.chat);
      if (!chat) { await board.bindSession(nativeId, null); continue; }
      const task = await board.task(bound.task).catch(() => null);
      const finished = !task || ['done', 'cancelled'].includes(task.status) || (task.status === 'qa' && bound.role !== 'qa-tester') || (task.status === 'ready' && task.chat !== bound.chat);
      if (finished && chat.activity === 'idle') {
        await this.sessions.remove(chat.id).catch(() => {});
        await board.bindSession(nativeId, null);
        await board.activity({ actor: 'autopilot', task: bound.task, kind: 'agent', text: `closed chat "${chat.name}" (kept in History)` });
      }
    }
    // A worker chat closed by hand leaves its task visible as blocked, not lost.
    for (const task of await board.tasks()) {
      if (['doing', 'qa'].includes(task.status) && task.chat && !open.has(task.chat)) {
        if (task.status === 'qa') await board.updateTask(task.id, { chat: null }, { by: 'autopilot', note: 'QA chat closed before reporting; QA will start again' });
        else await board.updateTask(task.id, { status: 'blocked', chat: null }, { by: 'autopilot', note: 'worker chat was closed before the task finished — set it to ready to retry' });
      }
    }
  }

  async alerts(board) {
    const seen = this.seen.get(board.project);
    const config = board.config();
    for (const gate of await board.gates()) {
      if (gate.status !== 'pending' || gate.notified) continue;
      await this.notify(board, { title: `${config.name}: ${gate.kind} decision needed`, message: `${gate.id} ${gate.title}${gate.task ? ` (${gate.task})` : ''}`, priority: 4, tags: ['raised_hand'] });
      gate.notified = true;
      await board.write(gate);
      this.changed(board.project);
    }
    const events = (await board.activitySince(seen.activityAt)).filter(item => item.at > seen.activityAt);
    if (!events.length) return;
    seen.activityAt = events[events.length - 1].at;
    for (const event of events) {
      if (event.kind === 'attention') await this.notify(board, { title: `${config.name}: an agent needs you`, message: event.text, priority: 4, tags: ['warning'] });
      else if (event.kind === 'status' && / → done(\s|$)/.test(event.text)) await this.notify(board, { title: `${config.name}: finished`, message: event.text, priority: 2, tags: ['white_check_mark'] });
      else if (event.kind === 'status' && / → blocked/.test(event.text) && !/waiting on G-/.test(event.text)) await this.notify(board, { title: `${config.name}: task blocked`, message: event.text, priority: 3, tags: ['construction'] });
    }
    this.changed(board.project);
  }

  async scheduledDigest(board) {
    const config = board.config();
    const hour = Number.isInteger(config.digestHour) ? config.digestHour : 21;
    const today = localDay();
    if (new Date().getHours() < hour || String(config.lastDigest || '').length && localDay(new Date(config.lastDigest)) === today) return;
    await this.digest(board.project);
  }

  async notify(board, message) {
    const origin = this.mobileOrigin();
    const result = await this.notifier.send({ ...message, click: origin ? `${origin}/mobile/#studio` : null });
    if (!result.sent && this.notifier.configured) await board.activity({ actor: 'studio', kind: 'note', text: `phone alert failed: ${result.reason || result.status}` }).catch(() => {});
    return result;
  }
}

function digestLine(summary) {
  return `${summary.waiting} waiting on you · ${summary.finished} finished · ${summary.doing} in progress · ${summary.ready} ready${summary.blocked ? ` · ${summary.blocked} blocked` : ''}`;
}
