#!/usr/bin/env node
// Studio CLI. Agents and Scott use it to work the board; Claude Code hooks call
// `studio hook <event>`. Run `node scripts/studio/studio.mjs help`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board, GATE_KINDS, OWNER_ACTOR, ROLES, STATUSES } from '../../desktop/service/studio/board.mjs';
import { initStudio, installHooks } from '../../desktop/service/studio/setup.mjs';
import { blocked, notification, postTool, preTool, sessionStart, subagentStop } from '../../desktop/service/studio/guard.mjs';

const CLI = fileURLToPath(import.meta.url);

const HELP = `Studio CLI — the board lives in <project>/studio/

  init [project-dir] [--name "Game"]      create studio/ and install the Claude Code hooks
  install-hooks [project-dir]             (re)write the hooks into .claude/settings.local.json
  status [--json]                         what's waiting, running, ready

  task new --title T --role R [--status backlog|ready] [--goal G] [--accept "a; b"] [--depends T-1,T-2] [--plan G-3]
  task list [--status S] [--role R]
  task show T-7
  task start T-7                          ready → doing
  task note T-7 "what you did or found"
  task done T-7 --summary "result + how it was verified"
  task qa T-7 pass|fail --summary "evidence"
  task set T-7 [--status S] [--role R] [--note N]

  gate open --kind ${GATE_KINDS.join('|')} --title T [--task T-7] --summary S
            [--options "A) ... B) ..."] [--recommend R] [--paths a,b] [--tools t1,t2] [--branch dev]
            merge, release and canon gates need --task; release gates need --tools
  gate list [--pending]
  gate show G-3
  gate decide G-3 approve|changes|reject [--note N]     (owner only)

  log "text" [--task T-7]                 add a line to today's activity log
  digest [--since ISO] [--print]          write studio/digests/<today>.md

Every command that changes the board accepts --as <role> to name the actor.
Roles: ${ROLES.join(', ')}. Statuses: ${STATUSES.join(', ')}.`;

function parse(argv) {
  const positional = [], flags = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split(/=(.*)/s);
      if (inline !== undefined) flags[key] = inline;
      else if (index + 1 < argv.length && !argv[index + 1].startsWith('--')) flags[key] = argv[++index];
      else flags[key] = true;
    } else positional.push(arg);
  }
  return { positional, flags };
}
const list = value => typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : [];
const out = value => process.stdout.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);
const die = message => { process.stderr.write(`studio: ${message}\n`); process.exit(1); };
function board(start = process.cwd()) {
  const found = Board.open(start);
  if (!found) die('No studio/ folder found here or above. Run `studio init` in your game project.');
  return found;
}
const actor = flags => String(flags.as || process.env.STUDIO_ACTOR || 'agent');
const row = task => `${task.id}  ${task.status.padEnd(9)} ${String(task.role).padEnd(13)} ${task.title}${task.blocked_on ? `  (waiting on ${task.blocked_on})` : ''}${task.depends?.length ? `  after ${task.depends.join(',')}` : ''}`;

// ------------------------------------------------------------------ hooks

async function runHook(event) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* No input. */ }
  const studio = Board.open(input.cwd || process.cwd());
  if (!studio) return;
  try {
    if (event === 'pre') {
      const result = await preTool(studio, input);
      if (!result) return;
      out(result);
      await blocked(studio, input, result).catch(() => {}); // The denial stands even if logging fails.
      return;
    }
    if (event === 'post') return await postTool(studio, input);
    if (event === 'session') return out(await sessionStart(studio, input, CLI));
    if (event === 'notification') return await notification(studio, input);
    if (event === 'subagent-stop') return await subagentStop(studio, input);
  } catch (error) {
    // A broken hook must not stop the agent. Leave a trace for Scott instead.
    process.stderr.write(`studio hook ${event}: ${error.message}\n`);
  }
}

// ------------------------------------------------------------------ main

async function main() {
  const [command, sub, ...rest] = process.argv.slice(2);
  if (command === 'hook') return runHook(sub);
  const { positional, flags } = parse(process.argv.slice(['task', 'gate'].includes(command) ? 4 : 3));
  switch (command) {
    case undefined: case 'help': case '--help': case '-h': return out(HELP);
    case 'init': { const result = await initStudio(positional[0] || process.cwd(), { name: flags.name }); return out(`${result.created ? 'Created' : 'Updated'} ${result.root}\nHooks: ${result.hooks}\nOpen ${path.join(result.root, 'STUDIO.md')} in Obsidian, or add the project in Mr. Mak → Studio.`); }
    case 'install-hooks': return out(`Hooks written to ${await installHooks(path.resolve(positional[0] || process.cwd()))}`);
    case 'status': {
      const state = await board().state();
      if (flags.json) return out(state);
      return out(await board().briefing({ cli: CLI }));
    }
    case 'log': { const text = positional.join(' ') || flags.text; if (!text) die('log needs text'); await board().activity({ actor: actor(flags), task: flags.task || null, kind: 'note', text }); return out('logged'); }
    case 'digest': { const result = await board().digest({ since: flags.since || board().config().lastDigest || null }); return out(flags.print ? result.text : `Wrote ${result.file}`); }
    case 'decisions': { const items = await board().list('decisions'); return out(items.map(item => `${item.id}  ${item.decision.padEnd(9)} ${item.title}`).join('\n') || 'No decisions yet.'); }
    case 'task': return task(sub, positional, flags);
    case 'gate': return gate(sub, positional, flags);
    default: die(`Unknown command "${command}". Run: studio help`);
  }
}

async function task(sub, positional, flags) {
  const studio = board();
  const id = positional[0];
  switch (sub) {
    case 'new': {
      const item = await studio.createTask({ title: flags.title || positional.join(' '), role: flags.role || 'godot-dev', status: flags.status || 'backlog', goal: flags.goal || '', acceptance: flags.accept || '', depends: list(flags.depends), plan: flags.plan || null, notes: flags.notes || '', by: actor(flags) });
      return out(`${item.id} created: ${item.path}`);
    }
    case 'list': case undefined: {
      const items = (await studio.tasks()).filter(item => (!flags.status || item.status === flags.status) && (!flags.role || item.role === flags.role));
      return out(items.map(row).join('\n') || 'No tasks.');
    }
    case 'show': { const item = await studio.task(id); return out(`${item.path}\n\n${readFileSync(item.file, 'utf8')}`); }
    case 'start': return out(row(await studio.updateTask(id, { status: 'doing' }, { by: actor(flags), note: flags.note || 'started' })));
    case 'note': { const text = positional.slice(1).join(' ') || flags.text; if (!text) die('note needs text'); return out(row(await studio.noteTask(id, text, actor(flags)))); }
    case 'done': { if (!flags.summary) die('done needs --summary "what changed and how you verified it"'); return out(row(await studio.finishTask(id, flags.summary, actor(flags)))); }
    case 'qa': { const verdict = positional[1]; if (!['pass', 'fail'].includes(verdict)) die('qa needs pass or fail'); return out(row(await studio.qaResult(id, verdict === 'pass', flags.summary || '', actor(flags) === 'agent' ? 'qa-tester' : actor(flags)))); }
    case 'set': {
      const patch = {};
      if (flags.status) patch.status = flags.status;
      if (flags.role) patch.role = flags.role;
      if (flags.title) patch.title = flags.title;
      if (flags.depends) patch.depends = list(flags.depends);
      return out(row(await studio.updateTask(id, patch, { by: actor(flags), note: flags.note || '' })));
    }
    default: die(`Unknown task command "${sub}".`);
  }
}

async function gate(sub, positional, flags) {
  const studio = board();
  switch (sub) {
    case 'open': {
      const item = await studio.openGate({ kind: flags.kind, task: flags.task || null, title: flags.title || '', summary: flags.summary || '', options: flags.options || '', recommendation: flags.recommend || '', paths: list(flags.paths), tools: list(flags.tools), branch: flags.branch || null, by: actor(flags) });
      return out(`${item.id} opened and waiting on ${studio.config().owner}: ${item.path}\nDo not wait in a loop. Continue other work or end your turn; the task resumes when the gate is decided.`);
    }
    case 'list': case undefined: {
      const items = (await studio.gates()).filter(item => !flags.pending || item.status === 'pending');
      return out(items.map(item => `${item.id}  ${item.status.padEnd(9)} ${item.kind.padEnd(8)} ${item.title}${item.task ? `  (${item.task})` : ''}`).join('\n') || 'No gates.');
    }
    case 'show': { const item = await studio.gate(positional[0]); return out(`${item.path}\n\n${readFileSync(item.file, 'utf8')}`); }
    case 'decide': {
      const result = await studio.decideGate(positional[0], positional[1], flags.note || '', OWNER_ACTOR);
      return out(`${result.gate.id} ${result.gate.status}. Recorded as ${result.decision.id}.`);
    }
    default: die(`Unknown gate command "${sub}".`);
  }
}

main().catch(error => die(error.message));
