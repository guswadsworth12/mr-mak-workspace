# Studio: an agent team you can see

Studio runs a game project through a board of tasks and decisions. Agents do
the work in normal, visible Claude Code chats, and anything that shapes the
game (scope, look, story, merging to main, exports) waits for your approval.
Everything they do is written to plain Markdown in the project's `studio/`
folder, which you can open in Obsidian.

## How it fits together

| Piece | What it does |
| --- | --- |
| `studio/` in your game project | The board: `tasks/`, `gates/`, `decisions/`, `canon/`, `log/`, `digests/`, `roles/`. Godot ignores it (`.gdignore`). |
| Studio CLI (`scripts/studio/studio.mjs`) | How agents and you change the board. `node scripts/studio/studio.mjs help`. |
| Claude Code hooks (`.claude/settings.local.json` in the project) | Log every edit, command and MCP call to `studio/log/`, block protected actions without an approved gate, and brief each new session on the board. |
| Studio page (the Studio button in the Chats header, Workspace menu → Studio, phone → Studio icon) | Gates to decide, the board, the live activity feed, your decisions, and the autopilot switch. |
| Autopilot | Starts ready tasks in titled chats grouped under "Studio · <game>", one Godot-editor task at a time, hands finished work to a QA chat, continues a paused chat after you decide its gate, and closes idle finished chats (they stay in History). |
| Phone alerts (ntfy) | A push when a gate opens, an agent waits on you, or something finishes or blocks. Tapping it opens the Studio view on the phone app. |
| Daily digest | `studio/digests/<date>.md` each evening: waiting on you, finished, decided, in progress, blocked, up next. |

## Set up a game

1. In Mr. Mak, press the **Studio** button in the Chats header (or open the
   Workspace menu → **Studio**), paste the folder that contains
   `project.godot`, and choose **Add project**. Or run
   `node scripts/studio/studio.mjs init /path/to/game` once.
2. Fill in `studio/canon/` with what is already decided (pillars, art
   direction, characters). Agents read it and cannot change it without a
   canon gate.
3. Optional: edit `studio/roles/*.md` to change how each agent works, and
   `studio/studio.json` for limits (parallel chats, QA, protected branches,
   gated paths and MCP tools, digest hour).
4. Optional phone alerts: pick a hard-to-guess topic and add it to Mr. Mak's
   `.env`, then restart Mr. Mak:

   ```
   STUDIO_NTFY_URL=https://ntfy.sh/scott-studio-<random>
   # STUDIO_NTFY_TOKEN=tk_...   (for a protected or self-hosted server)
   ```

   Subscribe to the same topic in the ntfy app. A self-hosted ntfy on your
   own server works the same way.

## Day to day

- **Give a goal** in the Studio page ("Add a dash with a cooldown and a
  trail"). The Producer drafts tasks and opens a *plan* gate.
- **Approve the plan** (desktop or phone). Its tasks become ready.
- **Turn on Autopilot** to let ready tasks start on their own, or press
  **Start now** on a task. Each worker is a chat you can open, watch and type
  into at any time.
- **Decide gates** as they come in. "Ask for changes" and "Reject" need a note,
  which the agent reads when its chat continues.
- **Read the digest** at night, or the activity feed any time.

## What the guard enforces

| Action | Needs |
| --- | --- |
| Deciding a gate, editing `gates/`, `decisions/`, `studio.json` | You only |
| Editing the activity log (`log/`), `studio/.runtime/`, the project's `.claude/settings*.json` (where the hooks live) or Studio's own code | Not allowed for agents |
| Editing files under `studio/canon/` (or other `gatedPaths`) | An approved canon/design/art gate listing those paths |
| Committing on `main`/`master` | Not allowed; agents use the work branch (`dev`) |
| Pushing to, merging into or rebasing a protected branch, `gh pr merge` | An approved merge gate (for that branch) |
| `export_project`, `deploy_to_android`, `delete_scene`, `execute_editor_script` MCP tools | An approved release gate that lists that tool (`--tools`) |

Merge, release and canon gates must name a task, and an approval lasts only
while that task is open: it ends when the task is done or cancelled.
`execute_editor_script` is gated because it runs any GDScript in the editor
and could export, delete or rewrite files; remove it from `gatedMcpTools` in
`studio.json` if the asking gets in the way.

The guard is a tripwire, not a sandbox. It stops the direct routes (including
`bash -c`, full paths to `git`, refspecs like `dev:main`, and `node -e`
writes to records), but an agent determined to get around it could write a
script that does. Every command it runs is still in the log. The hooks only apply to Claude
Code sessions started in that project; Codex workers are logged by the
autopilot but not guarded, so Studio uses Claude by default.

## CLI reference

```
studio status
studio task new --title "..." --role godot-dev --status ready --goal "..." --accept "a; b"
studio task list [--status ready]
studio task start|note|done|qa|set ...
studio gate open --kind design --task T-0007 --title "..." --summary "..." --options "..." --recommend "..."
studio gate open --kind release --task T-0009 --tools export_project --title "Export the demo" --summary "..."
studio gate list --pending
studio gate decide G-0003 approve|changes|reject --note "..."
studio digest --print
```
