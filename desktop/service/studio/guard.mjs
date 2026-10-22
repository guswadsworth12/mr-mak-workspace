// Claude Code hook handlers for a Studio project.
//   pre     PreToolUse: block protected actions that lack an approved gate.
//   post    PostToolUse: write every meaningful action to the activity log.
//   session SessionStart: brief the agent on the board.
//   notification / subagent-stop: record moments that need Scott.
// A hook must never break a session, so every error falls through to "allow".
//
// The guard is a tripwire, not a sandbox: an agent with a shell can always
// write a script that does what a rule forbids. It stops the direct routes,
// including the ones that would switch the guard itself off, and records the rest.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const QUIET_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ToolSearch', 'BashOutput', 'KillShell', 'ExitPlanMode', 'AskUserQuestion']);
const QUIET_MCP = /__(get_|list_|read_|find_|search_|analyze_|validate_|wait_for|tilemap_get|uid_to|project_path_to|compare_|assert_|watch_|monitor_|batch_get)/;

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Studio's own code: an agent able to edit it could turn the guard off.
const STUDIO_CODE = [HERE, path.resolve(HERE, '..', '..', '..', 'scripts', 'studio')];
// Records only the owner and the Studio CLI write, and the settings that install these hooks.
const RECORDS = /^studio\/(?:(?:gates|decisions|log|\.runtime)\/|studio\.json$)|^\.claude\/settings(?:\.local)?\.json$/;
const RECORDS_IN_COMMAND = /studio\/(?:gates|decisions|log|\.runtime)\b|studio\/studio\.json|\.claude\/settings(?:\.local)?\.json|desktop\/service\/studio\/|scripts\/studio\//;
const WRITES = /(?:>|\btee\b|\bsed\b[^|;&]*\s-i|\b(?:mv|cp|rm|unlink|truncate|dd|ln|install|chmod|rsync)\b|\bperl\s+-[pi]|\b(?:node|python3?|perl|ruby|deno|bun)\s+(?:-e|-c|-p|--eval|-)\s|<<)/;
const WRITES_RECORD = new RegExp(`${WRITES.source}[^|;&]*(?:${RECORDS_IN_COMMAND.source})`);
const CD_INTO_RECORD = /\bcd\s+["']?[^|;&\s]*(?:studio\/(?:gates|decisions|log|\.runtime)|\.claude|desktop\/service\/studio|scripts\/studio)/;
// Output redirection other than 2>&1 or to /dev/null, and the writes a
// read-only-looking command can still make.
const SIDE_EFFECT = /(?<![&\d])\d?>(?!&|>?\s*\/dev\/null)|\btee\b|\s-(?:delete|exec|execdir|fprint\w*)\b|\bbranch\s+(?:\S+\s+)*-(?:[dDmMcCf]\b|-delete|-move|-copy|-force)/;
const READ_ONLY = /^(?:ls|cat|head|tail|pwd|echo|printf|grep|rg|find|wc|which|file|stat|du|tree|sort|uniq|cut|jq|diff|git\s+(?:status|log|diff|show|branch|rev-parse|remote|ls-files|blame))(?:\s|$)/;
const GIT_SEGMENT = /^(?:(?:command|env|exec|nice|nohup|time|sudo|doas)\s+|-\S+\s+|\S+=\S*\s+)*(?:\S*\/)?(?:git|gh)(?:\s|$)/;

const deny = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const short = (text, max = 160) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Split a shell command into simple commands, looking inside `bash -c "..."`
// so a wrapped command meets the same rules.
export function segmentsOf(command) {
  return String(command)
    .replace(/\b(?:ba|z|fi|da)?sh\s+-\w*c\w*\s+(['"])([\s\S]*?)\1/g, ' ; $2 ; ')
    .split(/&&|\|\||;|\||\n/)
    .map(part => part.trim().replace(/^[\s({!'"`]+|[\s)}'"`]+$/g, '').replace(/^(?:then|do|else)\s+/, ''))
    .filter(Boolean);
}

export function actorFor(board, input) {
  const bound = input.session_id ? board.sessionMap()[input.session_id] : null;
  const role = bound?.role || input.agent_type || 'claude';
  return { actor: role, task: bound?.task || null };
}

// symbolic-ref also names the branch of a repository with no commits yet,
// where rev-parse fails and the first commits would otherwise go unchecked.
function currentBranch(cwd) {
  try { return execFileSync('git', ['-C', cwd, 'symbolic-ref', '--short', '-q', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim(); }
  catch { return null; }
}
const projectPath = (board, file, cwd) => path.relative(board.project, path.resolve(cwd || board.project, file)).split(path.sep).join('/');
const insideStudioCode = file => STUDIO_CODE.some(dir => file === dir || file.startsWith(dir + path.sep));

export async function preTool(board, input) {
  const config = board.config();
  const tool = String(input.tool_name || '');
  const args = input.tool_input || {};
  const owner = config.owner || 'Scott';
  const cwd = input.cwd || board.project;
  const work = config.git?.workBranch || 'dev';

  if (tool === 'Bash') {
    const command = String(args.command || '');
    if (/\bgate\s+decide\b|\bdecideGate\b/.test(command)) return deny(`Only ${owner} decides gates. Leave the gate pending, mark your task blocked on it, and move on to other work.`);
    if (WRITES_RECORD.test(command) || (CD_INTO_RECORD.test(command) && WRITES.test(command))) return deny(`Studio's records (gates, decisions, the activity log, studio.json), its hook settings and its code are written only by the Studio CLI and by ${owner}. Use the CLI: gate open to ask for a decision, task note or log to record something.`);
    if (/\brm\s+-[a-z]*r[a-z]*\b[^|;&]*\bstudio\b/.test(command)) return deny('Deleting Studio records is not allowed for agents.');

    const protectedBranches = config.git?.protected || ['main', 'master'];
    let branch = currentBranch(cwd);
    for (const segment of segmentsOf(command)) {
      if (!GIT_SEGMENT.test(segment)) continue;
      const switched = /\bgit\s+(?:checkout|switch)\s+(?:-[bcBC]\s+)?([\w./-]+)\s*$/.exec(segment.replace(/\s+\d?>&?\S+/g, ''));
      if (switched) { branch = switched[1]; continue; }
      const onProtected = branch && protectedBranches.includes(branch);
      if (/\bgit\b.*\bpush\b/.test(segment)) {
        const target = segment.replace(/^.*?\bpush\b/, '');
        const named = protectedBranches.find(name => new RegExp(`(?:^|[\\s:+]|refs/heads/)${escape(name)}(?:\\s|$)`).test(target));
        const explicit = named || (/\s--(?:all|mirror)\b/.test(target) ? protectedBranches.join(', ') : null);
        const bare = !/\bpush\s+(?:-\S+\s+)*[^-\s]\S*\s+\S+/.test(segment); // pushes the current branch
        if (/\s(?:--force\S*|-f)(?:\s|$)|[\s:]\+\S/.test(target) && (explicit || onProtected)) return deny(`Force-pushing a protected branch is never allowed for agents.`);
        if (explicit || (onProtected && bare)) {
          const gate = await board.approvedGate({ kinds: ['merge'], branch: branch && !protectedBranches.includes(branch) ? branch : null });
          if (!gate) return deny(`Pushing to ${explicit || branch} needs an approved merge gate. Open one: studio gate open --kind merge --task <your task> --branch ${work} --title "Merge ${work} into ${explicit || branch}" --summary "<what changed and how it was tested>" — then stop and wait.`);
        }
      }
      if (onProtected && /\bgit\b.*\b(merge|rebase|cherry-pick|pull)\b/.test(segment)) {
        const source = /\b(?:merge|rebase|cherry-pick|pull)\s+(?:-[-\w=]+\s+)*(?:origin\s+)?([\w./-]+)/.exec(segment)?.[1] || null;
        const gate = await board.approvedGate({ kinds: ['merge'], branch: source });
        if (!gate) return deny(`Changing ${branch} needs an approved merge gate${source ? ` for ${source}` : ''}. Open one with studio gate open --kind merge --task <your task> --branch ${source || work} and wait for ${owner}.`);
      }
      if (/\bgh\s+pr\s+merge\b/.test(segment)) {
        const gate = await board.approvedGate({ kinds: ['merge'] });
        if (!gate) return deny(`Merging a pull request needs an approved merge gate from ${owner}.`);
      }
      if (config.git?.blockCommitsOnProtected !== false && onProtected && /\bgit\b.*\bcommit\b/.test(segment)) {
        return deny(`Do not commit on ${branch}. Work on ${work}: git switch ${work} 2>/dev/null || git switch -c ${work}`);
      }
    }
    return null;
  }

  if (EDIT_TOOLS.includes(tool)) {
    const file = args.file_path || args.notebook_path;
    if (!file) return null;
    if (insideStudioCode(path.resolve(cwd, file))) return deny(`${file} is Studio's own code. Agents do not change the guard or the board tools; note what you need with task note and ${owner} will decide.`);
    const relative = projectPath(board, file, cwd);
    if (relative.startsWith('..')) return null;
    if (RECORDS.test(relative)) return deny(`${relative} is kept by Studio for ${owner}. Agents change the board through the Studio CLI (gate open, task note, log) instead of editing it.`);
    for (const prefix of config.gatedPaths || []) {
      const rel = prefix.replace(/^\.?\//, '');
      if (relative === rel.replace(/\/$/, '') || relative.startsWith(rel.endsWith('/') ? rel : `${rel}/`)) {
        const gate = await board.approvedGate({ kinds: ['canon', 'design', 'art'], file: relative });
        if (!gate) return deny(`${relative} is canon. Draft the change somewhere else (for example studio/drafts/), then open a canon gate that covers it: studio gate open --kind canon --task <your task> --paths ${relative} --title "<change>" --summary "<what and why>". Wait for ${owner}'s approval before editing canon.`);
      }
    }
    return null;
  }

  if (tool.startsWith('mcp__')) {
    const name = tool.split('__').pop();
    if ((config.gatedMcpTools || []).includes(name)) {
      const gate = await board.approvedGate({ kinds: ['release'], tool: name });
      if (!gate) return deny(`${name} needs an approved release gate that lists it: studio gate open --kind release --task <your task> --tools ${name} --title "<what you want to do>" --summary "<what it will change and why>". Then end your turn.`);
    }
  }
  return null;
}

// Read-only commands stay out of the log, and so do Studio CLI calls, which log
// their own changes. A command chained to anything else is logged whole.
function quietCommand(command) {
  if (SIDE_EFFECT.test(command)) return false;
  return segmentsOf(command).every(part => READ_ONLY.test(part) || /studio\.mjs/.test(part));
}

function describe(board, input) {
  const tool = String(input.tool_name || '');
  const args = input.tool_input || {};
  if (QUIET_TOOLS.has(tool)) return null;
  if (tool === 'Bash') {
    const command = String(args.command || '');
    if (quietCommand(command)) return null;
    return { kind: 'tool', text: `$ ${short(command, 200)}` };
  }
  if (EDIT_TOOLS.includes(tool)) {
    const file = args.file_path || args.notebook_path || '';
    return { kind: 'tool', text: `${tool === 'Write' ? 'wrote' : 'edited'} ${projectPath(board, file, input.cwd)}` };
  }
  if (tool === 'Task' || tool === 'Agent') return { kind: 'tool', text: `delegated to ${args.subagent_type || 'subagent'}: ${short(args.description || args.prompt, 120)}` };
  if (tool.startsWith('mcp__')) {
    if (QUIET_MCP.test(tool)) return null;
    const [, server, name] = tool.split('__');
    const detail = ['scene_path', 'path', 'node_path', 'script_path', 'name', 'prompt', 'title'].map(key => args[key]).find(value => typeof value === 'string');
    return { kind: 'tool', text: `${server}.${name}${detail ? ` ${short(detail, 100)}` : ''}` };
  }
  return { kind: 'tool', text: tool };
}

export async function postTool(board, input) {
  const entry = describe(board, input);
  if (!entry) return;
  const { actor, task } = actorFor(board, input);
  await board.activity({ actor, task, ...entry });
}

export async function notification(board, input) {
  const { actor, task } = actorFor(board, input);
  const text = short(input.message || 'needs your attention', 200);
  if (/waiting for your input/i.test(text) && !task) return; // idle reminders from untracked chats are noise
  await board.activity({ actor, task, kind: 'attention', text });
}

export async function subagentStop(board, input) {
  const { actor, task } = actorFor(board, input);
  await board.activity({ actor: input.agent_type || actor, task, kind: 'agent', text: `${input.agent_type || 'subagent'} finished` });
}

export async function sessionStart(board, input, cli) {
  const brief = await board.briefing({ cli });
  const bound = input.session_id ? board.sessionMap()[input.session_id] : null;
  return bound ? `${brief}\n\nYou are the ${bound.role} on ${bound.task}.` : brief;
}
