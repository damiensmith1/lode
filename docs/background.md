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
