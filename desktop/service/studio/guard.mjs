// Claude Code hook handlers for a Studio project.
//   pre     PreToolUse: block protected actions that lack an approved gate.
//   post    PostToolUse: write every meaningful action to the activity log.
//   session SessionStart: brief the agent on the board.
//   notification / subagent-stop: record moments that need Scott.
// A hook must never break a session, so every error falls through to "allow".
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const QUIET_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ToolSearch', 'BashOutput', 'KillShell', 'ExitPlanMode', 'AskUserQuestion']);
const QUIET_MCP = /__(get_|list_|read_|find_|search_|analyze_|validate_|wait_for|tilemap_get|uid_to|project_path_to|compare_|assert_|watch_|monitor_|batch_get)/;

const deny = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const short = (text, max = 160) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function actorFor(board, input) {
  const bound = input.session_id ? board.sessionMap()[input.session_id] : null;
  const role = bound?.role || input.agent_type || 'claude';
  return { actor: role, task: bound?.task || null };
}

function currentBranch(cwd) {
  try { return execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim(); }
  catch { return null; }
}
const projectPath = (board, file, cwd) => path.relative(board.project, path.resolve(cwd || board.project, file)).split(path.sep).join('/');

export async function preTool(board, input) {
  const config = board.config();
  const tool = String(input.tool_name || '');
  const args = input.tool_input || {};
  const owner = config.owner || 'Scott';
  const cwd = input.cwd || board.project;

  if (tool === 'Bash') {
    const command = String(args.command || '');
    if (/\bgate\s+decide\b/.test(command)) return deny(`Only ${owner} decides gates. Leave the gate pending, mark your task blocked on it, and move on to other work.`);
    if (/(>>?|\btee\b|\bsed\s+-i|\bmv\b|\bcp\b|\brm\b|\bperl\s+-[pi])[^|;&]*studio\/(gates|decisions)\//.test(command)) return deny('Gate and decision records are written only by the Studio CLI and by the owner. Use `studio gate open` to ask for a decision.');
    if (/\brm\s+-[a-z]*r[a-z]*\b[^|;&]*\bstudio\b/.test(command)) return deny('Deleting Studio records is not allowed for agents.');

    const protectedBranches = config.git?.protected || ['main', 'master'];
    const segments = command.split(/&&|\|\||;|\n/).map(part => part.trim()).filter(Boolean);
    let branch = currentBranch(cwd);
    for (const segment of segments) {
      if (!/^\s*(?:\S+=\S+\s+)*(git|gh)\b/.test(segment)) continue;
      const switched = /\bgit\s+(?:checkout|switch)\s+(?:-[bcBC]\s+)?([\w./-]+)\s*$/.exec(segment);
      if (switched) { branch = switched[1]; continue; }
      const onProtected = branch && protectedBranches.includes(branch);
      if (/\bgit\b.*\bpush\b/.test(segment)) {
        const explicit = protectedBranches.find(name => new RegExp(`(^|[\\s:+])${name}(\\s|$)`).test(segment.replace(/\bgit\b.*\bpush\b/, '')));
        if (/\s(--force|-f|--force-with-lease)\b/.test(segment) && (explicit || onProtected)) return deny(`Force-pushing a protected branch is never allowed for agents.`);
        if (explicit || (onProtected && !/\bpush\s+\S+\s+\S+/.test(segment))) {
          const gate = await board.approvedGate({ kinds: ['merge', 'release'], branch: branch && !protectedBranches.includes(branch) ? branch : null });
          if (!gate) return deny(`Pushing to ${explicit || branch} needs an approved merge gate. Open one: studio gate open --kind merge --branch ${config.git?.workBranch || 'dev'} --title "Merge ${config.git?.workBranch || 'dev'} into ${explicit || branch}" --summary "<what changed and how it was tested>" — then stop and wait.`);
        }
      }
      if (onProtected && /\bgit\b.*\b(merge|rebase|cherry-pick|pull)\b/.test(segment)) {
        const source = /\b(?:merge|rebase|cherry-pick|pull)\s+(?:-[-\w=]+\s+)*(?:origin\s+)?([\w./-]+)/.exec(segment)?.[1] || null;
        const gate = await board.approvedGate({ kinds: ['merge'], branch: source });
        if (!gate) return deny(`Changing ${branch} needs an approved merge gate${source ? ` for ${source}` : ''}. Open one with studio gate open --kind merge --branch ${source || config.git?.workBranch || 'dev'} and wait for ${owner}.`);
      }
      if (/\bgh\s+pr\s+merge\b/.test(segment)) {
        const gate = await board.approvedGate({ kinds: ['merge'] });
        if (!gate) return deny(`Merging a pull request needs an approved merge gate from ${owner}.`);
      }
      if (config.git?.blockCommitsOnProtected !== false && onProtected && /\bgit\b.*\bcommit\b/.test(segment)) {
        return deny(`Do not commit on ${branch}. Work on ${config.git?.workBranch || 'dev'}: git switch ${config.git?.workBranch || 'dev'} 2>/dev/null || git switch -c ${config.git?.workBranch || 'dev'}`);
      }
    }
    return null;
  }

  if (EDIT_TOOLS.includes(tool)) {
    const file = args.file_path || args.notebook_path;
    if (!file) return null;
    const relative = projectPath(board, file, cwd);
    if (relative.startsWith('..')) return null;
    if (/^studio\/(gates|decisions)\//.test(relative) || relative === 'studio/studio.json') return deny(`${relative} is ${owner}'s record. Agents use the Studio CLI (gate open, task note) instead of editing it.`);
    for (const prefix of config.gatedPaths || []) {
      const rel = prefix.replace(/^\.?\//, '');
      if (relative === rel.replace(/\/$/, '') || relative.startsWith(rel.endsWith('/') ? rel : `${rel}/`)) {
        const gate = await board.approvedGate({ kinds: ['canon', 'design', 'art'], file: relative });
        if (!gate) return deny(`${relative} is canon. Draft the change somewhere else (for example studio/drafts/), then open a canon gate that covers it: studio gate open --kind canon --paths ${relative} --title "<change>" --summary "<what and why>". Wait for ${owner}'s approval before editing canon.`);
      }
    }
    return null;
  }

  if (tool.startsWith('mcp__')) {
    const name = tool.split('__').pop();
    if ((config.gatedMcpTools || []).includes(name)) {
      const gate = await board.approvedGate({ kinds: ['release'] });
      if (!gate) return deny(`${name} needs an approved release gate from ${owner}: studio gate open --kind release --title "<what you want to export or delete>" --summary "<why>".`);
    }
  }
  return null;
}

function describe(board, input) {
  const tool = String(input.tool_name || '');
  const args = input.tool_input || {};
  if (QUIET_TOOLS.has(tool)) return null;
  if (tool === 'Bash') {
    const command = String(args.command || '');
    if (/studio\.mjs/.test(command)) return null; // The CLI logs its own changes.
    if (/^\s*(ls|cat|head|tail|pwd|echo|grep|rg|find|wc|which|git\s+(status|log|diff|show|branch))\b/.test(command)) return null;
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
