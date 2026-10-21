// Create a studio/ folder in a game project and install the Claude Code hooks.
// Shared by the CLI (`studio init`) and the desktop service (Studio → Add project).
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board, DEFAULT_CONFIG, OWNER_ACTOR } from './board.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const STUDIO_CLI = path.join(REPO, 'scripts', 'studio', 'studio.mjs');
const TEMPLATES = path.join(REPO, 'scripts', 'studio', 'templates');

const ours = entry => (entry.hooks || []).some(hook => String(hook.command || '').includes('studio.mjs') && String(hook.command).includes(' hook '));

// Hooks go in .claude/settings.local.json: it holds this computer's absolute
// path to the CLI, and Claude Code keeps that file out of Git by default.
export async function installHooks(project, cli = STUDIO_CLI) {
  const file = path.join(project, '.claude', 'settings.local.json');
  const settings = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'));
  settings.hooks ||= {};
  const add = (event, matcher, name) => {
    settings.hooks[event] = (settings.hooks[event] || []).filter(entry => !ours(entry));
    settings.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: `node "${cli}" hook ${name}`, timeout: 15 }] });
  };
  add('PreToolUse', 'Bash|Write|Edit|MultiEdit|NotebookEdit|mcp__.*', 'pre');
  add('PostToolUse', 'Bash|Write|Edit|MultiEdit|NotebookEdit|Task|Agent|mcp__.*', 'post');
  add('SessionStart', null, 'session');
  add('Notification', null, 'notification');
  add('SubagentStop', null, 'subagent-stop');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

function godotName(project) {
  try { return /^config\/name\s*=\s*"([^"]+)"/m.exec(readFileSync(path.join(project, 'project.godot'), 'utf8'))?.[1] || null; }
  catch { return null; }
}

export async function initStudio(projectDir, { name } = {}) {
  const project = path.resolve(projectDir);
  if (!existsSync(project)) throw Object.assign(new Error(`${project} does not exist.`), { status: 404 });
  const root = path.join(project, 'studio');
  const created = !existsSync(path.join(root, 'studio.json'));
  for (const dir of ['tasks', 'gates', 'decisions', 'log', 'canon', 'drafts', 'roles', 'digests', '.runtime']) await mkdir(path.join(root, dir), { recursive: true });
  if (created) await writeFile(path.join(root, 'studio.json'), JSON.stringify({ ...DEFAULT_CONFIG, name: name || godotName(project) || path.basename(project) }, null, 2) + '\n');
  const copyMissing = async (from, to) => { if (!existsSync(to)) await copyFile(from, to); };
  for (const role of await readdir(path.join(TEMPLATES, 'roles'))) await copyMissing(path.join(TEMPLATES, 'roles', role), path.join(root, 'roles', role));
  await copyMissing(path.join(TEMPLATES, 'STUDIO.md'), path.join(root, 'STUDIO.md'));
  await copyMissing(path.join(TEMPLATES, 'canon-README.md'), path.join(root, 'canon', 'README.md'));
  // Godot skips a folder that contains .gdignore, so notes never enter the import.
  await writeFile(path.join(root, '.gdignore'), '');
  await writeFile(path.join(root, '.gitignore'), '.runtime/\nlog/activity.jsonl\n.obsidian/workspace*.json\n');
  const hooks = await installHooks(project);
  const board = new Board(root);
  if (created) await board.activity({ actor: OWNER_ACTOR, kind: 'setup', text: `studio created for ${board.config().name}` });
  return { root, project, hooks, created, board };
}
