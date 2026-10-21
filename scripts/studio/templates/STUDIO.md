# Studio

The board for this game. Agents work it through the Studio CLI; you decide
gates in Mr. Mak (Workspace → Studio), on your phone, or in a terminal with
`studio gate decide G-#### approve|changes|reject --note "..."`.

- `tasks/` — one note per task. Status flow: backlog → ready → doing → qa → done.
- `gates/` — decisions only you can make. Agents stop and wait on these.
- `decisions/` — a record of every gate you decided and why.
- `log/` — one note per day with every agent action (written by hooks).
- `canon/` — the source of truth; changes need a canon gate.
- `digests/` — the nightly summary.
- `roles/` — each agent's brief. Edit them to change how agents work.

## Waiting on you
```dataview
TABLE kind, task, requested_by AS "from", created
FROM "gates" WHERE status = "pending" SORT created ASC
```

## In progress
```dataview
TABLE role, status, updated
FROM "tasks" WHERE status = "doing" OR status = "qa" SORT updated DESC
```

## Ready
```dataview
TABLE role, depends
FROM "tasks" WHERE status = "ready" SORT id ASC
```

## Recently done
```dataview
TABLE role, updated
FROM "tasks" WHERE status = "done" SORT updated DESC LIMIT 10
```

_The tables use the Dataview community plugin. Without it, browse the folders._
