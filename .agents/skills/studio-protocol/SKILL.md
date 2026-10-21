---
name: studio-protocol
description: Work a game project's Studio board — start, log and finish tasks, open gates for decisions only the owner makes, and leave a record the owner can follow. Use whenever a project has a studio/ folder or a chat was started by the Studio autopilot.
---

# Studio protocol

A Studio project keeps its plan and its history in `studio/` as Markdown:
tasks, gates (decisions waiting on the owner), decisions, canon and a daily
activity log. The owner follows the work through that folder, the Studio
page in Mr. Mak and phone alerts. Work so that someone reading only the board
knows what happened and why.

The CLI is `node <mr-mak>/scripts/studio/studio.mjs`; the exact path is in your
first message and in the session briefing. Pass `--as <your role>` on every
command that changes the board.

## Doing a task

1. `task start T-####` before you change anything. Read the task file, the
   role brief in `studio/roles/`, the canon it touches and recent decisions.
2. Log what matters while you work, not at the end:
   `task note T-#### "Added DashComponent to player.tscn; cooldown in export var"`.
   A note is a finding, a choice you made within scope, or a problem. Tool
   calls are logged automatically; do not narrate them.
3. Finish with `task done T-#### --summary "<what changed, which files, how you verified it>"`.
   The summary is what QA and the owner read first. With QA on, the task moves
   to QA instead of done.

## When to stop and ask (gates)

Open a gate instead of deciding when the call shapes the game rather than
implements it:

| Kind | For |
| --- | --- |
| `plan` | a set of tasks for a goal (Producer) |
| `design` | game feel, scope, rules, difficulty, controls |
| `art` | anything that sets the look: palette, style, a character's final design |
| `canon` | story, characters, world facts, anything in `studio/canon/` (list `--paths`) |
| `merge` | changing a protected branch (`--branch` you want merged) |
| `release` | exports, builds for others, deleting scenes |

`gate open --kind design --task T-#### --title "..." --summary "..." --options "A) ... B) ..." --recommend "..."`

Write the gate so it can be decided from a phone in a minute: the question,
two or three concrete options with their trade-offs, your recommendation.
Then end your turn. Do not poll or sleep; when the owner decides, the
autopilot continues your chat with the decision.

## Hard rules (enforced by hooks)

- Never decide a gate or edit `studio/gates/`, `studio/decisions/` or
  `studio/studio.json`.
- Canon edits need an approved `canon` gate covering those exact paths. Draft
  in `studio/drafts/` first.
- No commits on protected branches; work on the work branch (default `dev`).
  Pushing or merging into a protected branch needs an approved `merge` gate.
- Gated engine tools (exports, Android deploys, deleting scenes) need an
  approved `release` gate.

If a hook denies an action, read its reason, follow it, and do not look for a
way around it. Report the block in a task note if it stops the task.

## When something goes wrong

If the task is wrong, too big, or blocked by something outside your role,
`task note` the reason and `task set T-#### --status blocked --note "..."`.
The owner sees blocked tasks in the digest. Never mark work done that you did
not verify.
