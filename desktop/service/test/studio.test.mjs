import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board, formatDoc, parseDoc } from '../studio/board.mjs';
import { preTool, postTool, segmentsOf } from '../studio/guard.mjs';
import { initStudio } from '../studio/setup.mjs';
import { StudioManager } from '../studio/manager.mjs';
import { Sessions } from '../sessions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function project(name = 'studio-') {
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const folder = await mkdtemp(path.join(root, '.cache', name));
  await writeFile(path.join(folder, 'project.godot'), '[application]\nconfig/name="Ember Test"\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: folder });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: folder });
  const { board } = await initStudio(folder);
  return { folder, board };
}

test('frontmatter round-trips values Obsidian and agents produce', () => {
  const data = { id: 'T-0001', title: 'Fix: "dash" #1, [beta]', status: 'ready', depends: ['T-0002', 'T-0003'], chat: null, notified: false, created: '2026-10-21T10:00:00Z' };
  const parsed = parseDoc(formatDoc(data, '# Body\n'));
  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.body, '\n# Body\n');
});

test('a plan gate releases its tasks and every decision is recorded', async () => {
  const { board } = await project();
  assert.equal(board.config().name, 'Ember Test');
  const plan = await board.createTask({ title: 'Plan dash', role: 'producer', status: 'doing' });
  const gate = await board.openGate({ kind: 'plan', task: plan.id, title: 'Plan: dash', by: 'producer' });
  const a = await board.createTask({ title: 'Dash ability', role: 'godot-dev', plan: gate.id });
  const b = await board.createTask({ title: 'Name the move', role: 'lore-keeper', plan: gate.id, depends: [a.id] });
  assert.equal((await board.task(plan.id)).status, 'blocked');
  assert.deepEqual((await board.readyTasks()).map(task => task.id), []);

  await board.decideGate(gate.id, 'approve', 'Ship it');
  assert.equal((await board.task(plan.id)).status, 'done');
  assert.equal((await board.task(a.id)).status, 'ready');
  assert.equal((await board.task(b.id)).status, 'ready');
  assert.deepEqual((await board.readyTasks()).map(task => task.id), [a.id], 'a dependency holds the second task');
  await assert.rejects(board.decideGate(gate.id, 'reject'), /already approved/);

  await board.updateTask(a.id, { status: 'doing' }, { by: 'godot-dev' });
  assert.equal((await board.finishTask(a.id, 'added dash.gd', 'godot-dev')).status, 'qa');
  assert.equal((await board.qaResult(a.id, false, 'cooldown missing')).status, 'ready');
  await board.updateTask(a.id, { status: 'doing' }, { by: 'godot-dev' });
  await board.finishTask(a.id, 'cooldown added', 'godot-dev');
  assert.equal((await board.qaResult(a.id, true, 'ok')).status, 'done');

  const decisions = await board.list('decisions');
  assert.equal(decisions.length, 1);
  assert.match(await readFile(decisions[0].file, 'utf8'), /Ship it/);
  const digest = await board.digest({ write: false });
  assert.match(digest.text, /Dash ability/);
  assert.equal(digest.summary.finished, 2);
});

test('the guard blocks protected actions until Scott approves the matching gate', async () => {
  const { folder, board } = await project();
  const bash = command => preTool(board, { cwd: folder, tool_name: 'Bash', tool_input: { command } });
  const denied = result => result?.hookSpecificOutput?.permissionDecision === 'deny';

  assert.ok(denied(await bash('node scripts/studio/studio.mjs gate decide G-0001 approve')));
  assert.ok(denied(await bash('echo "status: approved" > studio/gates/G-0001-x.md')));
  assert.ok(denied(await bash('git commit -am wip')), 'no commits on main');
  assert.ok(denied(await bash('git push origin main')));
  assert.ok(denied(await bash('git push --force origin main')));
  assert.equal(await bash('git push origin dev'), null);
  assert.equal(await bash('git switch -c dev && git commit -am wip'), null, 'the work branch is free');
  assert.ok(denied(await bash('git checkout main && git merge dev')));

  const edit = file => preTool(board, { cwd: folder, tool_name: 'Edit', tool_input: { file_path: path.join(folder, file), new_string: 'x' } });
  assert.ok(denied(await edit('studio/canon/world.md')));
  assert.ok(denied(await edit('studio/gates/G-0001-x.md')));
  assert.ok(denied(await edit('studio/studio.json')));
  assert.equal(await edit('scenes/player.gd'), null);
  assert.ok(denied(await preTool(board, { cwd: folder, tool_name: 'mcp__godot-mcp-pro__export_project', tool_input: {} })));

  const work = await board.createTask({ title: 'World pass', role: 'lore-keeper', status: 'doing' });
  const canon = await board.openGate({ kind: 'canon', task: work.id, title: 'World rules', paths: ['studio/canon/world.md'] });
  const merge = await board.openGate({ kind: 'merge', task: work.id, title: 'Merge dev', branch: 'dev' });
  await board.decideGate(canon.id, 'approve');
  await board.decideGate(merge.id, 'approve');
  assert.equal(await edit('studio/canon/world.md'), null);
  assert.ok(denied(await edit('studio/canon/characters.md')), 'approval covers only the listed paths');
  assert.equal(await bash('git checkout main && git merge dev'), null);
  assert.ok(denied(await bash('git checkout main && git merge experiment')));

  await postTool(board, { cwd: folder, tool_name: 'Write', tool_input: { file_path: path.join(folder, 'scenes/dash.gd') } });
  await postTool(board, { cwd: folder, tool_name: 'Read', tool_input: { file_path: path.join(folder, 'scenes/dash.gd') } });
  const tools = (await board.recentActivity()).filter(item => item.kind === 'tool');
  assert.deepEqual(tools.map(item => item.text), ['wrote scenes/dash.gd']);
});

test('the guard protects its own records, settings and code, and its git rules see through wrappers', async () => {
  const { folder, board } = await project('studio-guard-');
  const bash = command => preTool(board, { cwd: folder, tool_name: 'Bash', tool_input: { command } });
  const edit = file => preTool(board, { cwd: folder, tool_name: 'Write', tool_input: { file_path: path.isAbsolute(file) ? file : path.join(folder, file), content: 'x' } });
  const denied = result => result?.hookSpecificOutput?.permissionDecision === 'deny';

  // Records, hook settings and Studio's own code.
  for (const file of ['studio/log/2026-10-22.md', 'studio/log/activity.jsonl', 'studio/.runtime/sessions.json', '.claude/settings.local.json', '.claude/settings.json',
    path.join(root, 'desktop/service/studio/guard.mjs'), path.join(root, 'scripts/studio/studio.mjs')]) assert.ok(denied(await edit(file)), file);
  assert.equal(await edit('studio/tasks/T-0001-x.md'), null, 'task notes stay editable');
  assert.equal(await edit('studio/drafts/world.md'), null);
  assert.equal(await edit(path.join(root, 'docs/notes.md')), null, 'other files outside the project are not the guard\'s business');
  for (const command of ['echo "{}" > .claude/settings.local.json', 'sed -i s/pre/x/ .claude/settings.local.json', `cp /tmp/x ${root}/desktop/service/studio/guard.mjs`,
    'printf x >> studio/log/activity.jsonl', 'node -e "require(\'fs\').writeFileSync(\'studio/gates/G-0001-x.md\', \'\')"', 'cd studio/gates && echo approved > G-0001-x.md',
    'node -e "import(\'./board.mjs\').then(m => m.decideGate)"']) assert.ok(denied(await bash(command)), command);
  assert.equal(await bash(`node "${root}/scripts/studio/studio.mjs" task note T-0001 "moved the > check" 2>&1`), null, 'the CLI itself is fine');
  assert.equal(await bash('cat studio/log/activity.jsonl | tail -5'), null, 'reading records is fine');

  // Git rules apply through wrappers, full paths and refspecs.
  for (const command of ['bash -c "git checkout main && git merge dev"', '/usr/bin/git commit -am wip', 'env GIT_TRACE=0 git commit -am wip', '(git commit -am wip)',
    'git switch -c dev && git push origin dev:refs/heads/main', 'git switch -c dev && git push origin dev:main', 'git switch -c dev && git push --all origin',
    'git switch -c dev && git push origin +dev:main']) assert.ok(denied(await bash(command)), command);
  const fresh = await mkdtemp(path.join(root, '.cache', 'studio-unborn-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fresh });
  assert.ok(denied(await preTool(board, { cwd: fresh, tool_name: 'Bash', tool_input: { command: 'git commit -am first' } })), 'a repository without commits is still on main');
  assert.deepEqual(segmentsOf('sh -c \'git add . && git commit -m x\' || true'), ['git add .', 'git commit -m x', 'true']);
});

test('a gate allows only what it names, and only while its task is open', async () => {
  const { folder, board } = await project('studio-gates-');
  const denied = result => result?.hookSpecificOutput?.permissionDecision === 'deny';
  const mcp = name => preTool(board, { cwd: folder, tool_name: `mcp__godot-mcp-pro__${name}`, tool_input: {} });
  const bash = command => preTool(board, { cwd: folder, tool_name: 'Bash', tool_input: { command } });

  await assert.rejects(board.openGate({ kind: 'merge', title: 'Merge dev', branch: 'dev' }), /must name its task/);
  await assert.rejects(board.openGate({ kind: 'canon', title: 'World', paths: ['studio/canon/world.md'] }), /must name its task/);
  const task = await board.createTask({ title: 'Ship demo', role: 'godot-dev', status: 'doing' });
  await assert.rejects(board.openGate({ kind: 'release', task: task.id, title: 'Export' }), /--tools/);

  assert.ok(denied(await mcp('execute_editor_script')), 'arbitrary editor scripts are gated by default');
  const release = await board.openGate({ kind: 'release', task: task.id, title: 'Export demo', tools: ['export_project'] });
  assert.deepEqual((await board.gate(release.id)).tools, ['export_project']);
  await board.decideGate(release.id, 'approve');
  assert.equal(await mcp('export_project'), null);
  assert.ok(denied(await mcp('delete_scene')), 'an export approval does not allow deleting scenes');
  assert.ok(denied(await bash('git push origin main')), 'a release gate is not a merge gate');

  await board.updateTask(task.id, { status: 'cancelled' });
  assert.ok(denied(await mcp('export_project')), 'the approval ends with its task');
});

test('the activity log records writes hidden in read-only-looking or chained commands', async () => {
  const { folder, board } = await project('studio-log-');
  const run = command => postTool(board, { cwd: folder, tool_name: 'Bash', tool_input: { command } });
  for (const command of ['ls -la', 'git status && git log -3', 'cat a.gd 2>/dev/null | head', 'node /x/scripts/studio/studio.mjs task note T-0001 hi', 'grep -rn dash scenes 2>&1']) await run(command);
  for (const command of ['echo "extends Node" > scenes/player.gd', 'find . -name "*.import" -delete', 'git branch -D old', 'git commit -am wip && node /x/scripts/studio/studio.mjs task note T-0001 committed', 'cat a | tee b']) await run(command);
  const logged = (await board.recentActivity()).filter(item => item.kind === 'tool').map(item => item.text).reverse();
  assert.deepEqual(logged, ['$ echo "extends Node" > scenes/player.gd', '$ find . -name "*.import" -delete', '$ git branch -D old', '$ git commit -am wip && node /x/scripts/studio/studio.mjs task note T-0001 committed', '$ cat a | tee b']);
});

test('Godot MCP Pro reads and QA input stay out of the log; project changes are recorded', async () => {
  const { folder, board } = await project('studio-mcp-');
  const quiet = ['get_scene_tree', 'list_scripts', 'read_script', 'validate_script', 'detect_circular_dependencies', 'tilemap_get_cell', 'capture_frames',
    'open_scene', 'set_editor_camera', 'clear_output', 'simulate_action', 'simulate_mouse_move', 'click_button_by_text', 'move_to', 'navigate_to', 'wait_for_node'];
  const logged = ['add_node', 'update_property', 'save_scene', 'edit_script', 'tilemap_set_cell', 'move_node', 'set_project_setting', 'play_scene', 'stop_scene',
    'run_test_scenario', 'execute_game_script', 'start_recording'];
  for (const name of [...quiet, ...logged]) await postTool(board, { cwd: folder, session_id: 's', tool_name: `mcp__godot-mcp-pro__${name}`, tool_input: { scene_path: 'res://scenes/arena/arena.tscn' } });
  const texts = (await board.recentActivity(200)).filter(item => item.kind === 'tool').map(item => item.text.split(' ')[0]).reverse();
  assert.deepEqual(texts, logged.map(name => `godot-mcp-pro.${name}`));
});

test('hooks read real Claude Code payloads: bound sessions, subagents and blocked attempts', async () => {
  const { folder, board } = await project('studio-payload-');
  const sessionId = 'a0612196-7fa5-4069-a1d8-fb182c634098';
  await board.bindSession(sessionId, { task: 'T-0001', role: 'godot-dev', chat: 'chat-1' });
  // Field shapes captured from Claude Code 2.x hook input (PreToolUse/PostToolUse/SubagentStop).
  const base = { session_id: sessionId, transcript_path: '/tmp/t.jsonl', cwd: folder, permission_mode: 'acceptEdits', effort: { level: 'medium' }, prompt_id: 'p-1' };
  const hook = (event, payload) => execFileSync('node', [path.join(root, 'scripts/studio/studio.mjs'), 'hook', event], { input: JSON.stringify(payload), encoding: 'utf8' });

  hook('post', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(folder, 'notes/main.md'), content: 'main' }, tool_response: { type: 'create' }, tool_use_id: 'toolu_1' });
  hook('post', { ...base, hook_event_name: 'PostToolUse', agent_id: 'a1dad69ad93b695f2', agent_type: 'general-purpose', tool_name: 'Write', tool_input: { file_path: path.join(folder, 'notes/sub.md'), content: 'sub' }, tool_use_id: 'toolu_2' });
  hook('subagent-stop', { ...base, hook_event_name: 'SubagentStop', agent_id: 'a1dad69ad93b695f2', agent_type: 'general-purpose', stop_hook_active: false });
  const output = JSON.parse(hook('pre', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: "git commit --allow-empty -m 'hook test'" }, tool_use_id: 'toolu_3' }));
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');

  const events = (await board.recentActivity()).reverse().filter(item => item.kind !== 'setup');
  assert.deepEqual(events.map(item => [item.actor, item.task, item.kind]), [
    ['godot-dev', 'T-0001', 'tool'], ['godot-dev/general-purpose', 'T-0001', 'tool'], ['godot-dev/general-purpose', 'T-0001', 'agent'], ['godot-dev', 'T-0001', 'blocked']]);
  assert.equal(events[3].text, "$ git commit --allow-empty -m 'hook test' — Do not commit on main.");
});

test('the autopilot runs tasks in visible chats, one engine task at a time', async () => {
  const { folder, board } = await project('studio-auto-');
  const bin = path.join(folder, '.bin');
  await mkdir(bin);
  const argsFile = path.join(folder, '.bin', 'args.txt');
  await writeFile(path.join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${argsFile}"\nexec cat\n`);
  await chmod(path.join(bin, 'claude'), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  const settings = { studioProjects: [] };
  const sessions = await new Sessions(folder, path.join(folder, '.mrmak')).init();
  const studio = await new StudioManager({ repo: root, sessions, settings: () => settings, saveSettings: async () => {} }).init();
  try {
    await studio.addProject(folder);
    assert.deepEqual(settings.studioProjects, [folder]);

    const { task, chat } = await studio.goal(folder, 'Add a dash ability. It should feel snappy.');
    assert.equal(task.role, 'producer');
    assert.equal(chat.group, 'Studio · Ember Test');
    assert.match(chat.name, /^T-0001 Plan: Add a dash ability/);
    assert.equal((await board.task(task.id)).status, 'doing');
    assert.equal(board.sessionMap()[chat.nativeId].task, task.id);
    await sleep(300);
    const launched = await readFile(argsFile, 'utf8');
    assert.match(launched, /You are the producer on the Studio board for Ember Test\. Your task is T-0001/);
    assert.match(launched, /--add-dir/);

    // Two engine tasks and one lore task become ready.
    const one = await board.createTask({ title: 'Dash ability', role: 'godot-dev', status: 'ready' });
    const two = await board.createTask({ title: 'Dash particles', role: 'godot-dev', status: 'ready' });
    const lore = await board.createTask({ title: 'Name the move', role: 'lore-keeper', status: 'ready' });
    await studio.setAutopilot(folder, { enabled: true, maxParallel: 3 });
    await studio.tick();
    const status = async id => (await board.task(id)).status;
    assert.equal(await status(one.id), 'doing');
    assert.equal(await status(two.id), 'ready', 'the Godot editor has one driver');
    assert.equal(await status(lore.id), 'doing');

    // A worker that finishes hands off to QA; its idle chat is closed and kept in History.
    const workerChat = (await board.task(one.id)).chat;
    await board.finishTask(one.id, 'dash added', 'godot-dev');
    await studio.tick();
    assert.equal(sessions.list().find(item => item.id === workerChat).open, false);
    const qaTask = await board.task(one.id);
    assert.equal(qaTask.status, 'qa');
    assert.ok(qaTask.chat && qaTask.chat !== workerChat, 'a QA chat took over');

    // A gate pauses the lore task; the decision continues in the same chat.
    const loreChat = (await board.task(lore.id)).chat;
    const gate = await board.openGate({ kind: 'canon', task: lore.id, title: 'Name: Ember Step', paths: ['studio/canon/moves.md'], by: 'lore-keeper' });
    assert.equal(await status(lore.id), 'blocked');
    await studio.decide(folder, gate.id, 'approve', 'Love it');
    await studio.tick();
    const resumed = await board.task(lore.id);
    assert.equal(resumed.status, 'doing');
    assert.equal(resumed.chat, loreChat);

    const state = await studio.state(folder);
    assert.ok(state.activity.some(item => item.kind === 'decision'));
    assert.ok(state.tasks.find(item => item.id === lore.id).chatInfo?.open);
  } finally {
    studio.close(); await sessions.close(); process.env.PATH = previous;
  }
});
