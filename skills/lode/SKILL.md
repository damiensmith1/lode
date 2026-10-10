---
name: lode
description: >
  Get precise context about a codebase from lode's code graph instead of
  reading whole files: a symbol with what it calls and what calls it, the
  code that matters for a question, or what the current changes touch. Use
  when the lode MCP tools (lode_read, lode_context, lode_impact, …) are
  available and you need to understand, change or review code.
---

# Using lode for context

lode knows the project as a graph: declarations, what calls what, what
flows where (including across processes, e.g. Electron IPC), and what git
says changed. Its tools return just the code that matters, already
connected, sized to a token budget. Reach for them before opening files.

## Which tool

| You want | Use |
| --- | --- |
| A symbol's id from its name | `lode_search { query }` |
| To understand one function, class or type | `lode_read { symbol }`: its full code, the signatures of what it calls and what calls it, and the lines that connect them |
| The code behind a question ("how are tabs created") | `lode_context { question }` |
| Everything around some symbols you already know | `lode_context { symbols: [...], hops, direction }` |
| What your (or someone's) uncommitted changes touch | `lode_impact {}` (or `{ base: "main" }` for a branch) |
| A list of what changed | `lode_changes {}` |
| Where an unfamiliar codebase starts | `lode_entries {}` |

## How to read what comes back

- `## Code` is full code, with line numbers; `⋯ N lines` marks folded
  code you can get with `lode_read` on the inner symbol.
- `## Nearby` gives signatures and the exact line that connects each to
  the code above. `## Also related` lists names only: read them if needed.
- "How they connect" lists edges: `a calls b (line 12)`, `a sends to b`
  (IPC), `a shares state with b`.
- In `lode_impact`, `+` lines were added and `-` lines removed.

## Tips

- Start narrow (`lode_read`, `hops: 1`) and widen (`hops: 2`,
  `direction: "up"` for callers) only if you need to.
- Set `budget` to what you can afford; lode gives less detail before it
  leaves things out, and says how much it dropped.
- Results are deterministic by default. `rank: "judge"` (if the server has
  a TypeSafe key) lets lode's model choose what's relevant to a question,
  or what's actually at risk from a change.
- After editing, `lode_impact` shows what your change touches: check the
  dependents it lists before you finish.
