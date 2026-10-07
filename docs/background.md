# Background

## The problem

Code is hard to read.

Code is stored as linear text and read top to bottom, but what it describes
is not linear. It is a web of modules, classes, functions and types, with
data moving between them. To understand it, a reader has to scan the text,
parse interfaces, follow references across files, and rebuild that web in
their head. Building a clear picture of how the pieces fit together, and how
data flows through them, is slow and error-prone.

This is getting worse:

- **AI now writes most of the code.** People increasingly have to understand
  code they did not write, after the fact, at the pace an AI produces it.
- **Unfamiliar languages make it harder still.** Reading code in a language
  you don't know means decoding the syntax before you can even start on the
  structure.

## What this project is

An exploration of ways to make code easier to read and understand. The
solution is not decided yet.

## Product direction (exploring)

Instead of reading code as text, you view it as a scoped picture of its
structure and data flow: the thing you care about in full detail, and
everything around it collapsed. Showing a whole codebase at once is not
useful.

**Scope comes from what you're looking at.** All of these pick a focus for
the view:

- a file you're viewing
- a diff you're viewing
- a symbol you select
- a question you ask ("how does a message reach the renderer?")

**Trace up and down the pipe.** From the focus, you follow what feeds it and
what it feeds. For a diff, this shows the impact of a change: what it
touches upstream and downstream.

**A query layer decides what to show.** How far a trace goes, and which
neighbours are expanded or collapsed, depends on relevance to the focus,
not a fixed depth. This is likely an LLM or a fast classification model
(e.g. Jev) making the call. Which one is still open.
