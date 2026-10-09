# lode

A live graph of how code is structured and how data flows through it, built
to make code readable: scoped views, tracing up and down the pipe, and
eventually a query layer that decides what to show. This repo is the
**core**: the deterministic indexer and graph that everything else will
consume. See `docs/` for background, requirements and design.

## Usage

```sh
npm install
npm run lode -- index path/to/tsconfig.json            # build or refresh, print a summary
npm run lode -- index path/to/tsconfig.json --json out.json
npm run lode -- node path/to/tsconfig.json 'src/main/x.ts#fn'   # one node, one hop each way
```

The graph is cached in `~/.cache/lode/<project hash>/` (override with
`--cache <dir>`); nothing is written into the indexed project.

## Layout

```
src/schema      the contract between plugins and the core (nodes, edges, channels)
src/ingest/ts   TypeScript plugin: facts from the compiler API, mapped to the schema
src/derive      core analysis: channel matching (tier 3), shared-state flows (tier 2)
src/graph       Graph (validation, traversal), lenses, GraphStore (cache)
src/cli.ts      the commands above
```

## Tests

```sh
npm test                                                        # fixtures only
LODE_GLANCE_TSCONFIG=path/to/glance/tsconfig.json npm test      # plus a real codebase
```
