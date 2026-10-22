---
name: godot-studio-dev
description: Implement and verify Godot 4 gameplay, scenes and scripts through the Godot MCP tools inside a Studio project, with a short verify loop and evidence for QA. Use for any Godot coding or scene task, especially ones started by the Studio autopilot.
---

# Godot development in Studio

Check the editor first. With the Godot MCP connected, `get_project_info` and
`get_scene_tree` show what is open; without it, work from files and say so in
your task note. Only one agent drives the editor at a time; the autopilot
schedules engine tasks one by one, so do not start a second editor instance.

## Make the change

- Read before writing: the scene tree, the scripts you will touch and their
  signal connections (`find_signal_connections`, `find_script_references`).
- Prefer small, typed GDScript (`var speed: float = 4.0`), exported tuning
  values, and signals over reaching across the tree with long node paths.
- Edit scenes through the MCP tools (`add_node`, `update_property`,
  `connect_signal`, `save_scene`) so the editor and the files agree. When you
  edit `.tscn`/`.gd` files directly, reload the project afterwards.
- Keep new input actions in the project's Input Map (`set_input_action`), not
  hard-coded keys.
- `export_project`, `deploy_to_android`, `delete_scene` and
  `execute_editor_script` are blocked without an approved release gate that
  lists the tool (`studio.json` → `gatedMcpTools`). Use the dedicated tools
  instead of an editor script; if only a script will do, open the gate and end
  your turn.

## Verify before you call it done

1. `validate_script` on every script you changed.
2. `play_scene` on the scene that exercises the change, then
   `get_output_log` and `get_editor_errors`. Zero new errors or warnings.
3. Exercise the behavior: `simulate_action` / `simulate_sequence`, then
   `get_game_node_properties` or `assert_node_state` for the values that
   prove it, and `get_game_screenshot` when the change is visible.
4. `stop_scene`.

Save evidence to `studio/drafts/qa/<task>/` (screenshots, the property values
you checked) and name it in your `task done --summary`. Feel and taste are the
owner's call: describe what you saw and leave the judgment to them.

## Git

Commit on the work branch with the task ID: `[T-0007] Dash with cooldown`.
Do not commit `.godot/`, export builds or `studio/.runtime/`.

Related skills: `game-ui-workflow`, `game-vfx-workflow`, `game-level-design`,
`game-animation-integration`, `game-audio-workflow`, `gameplay-visual-review`.
