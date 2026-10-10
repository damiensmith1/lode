# lode

A live graph of how TypeScript and JavaScript code is structured and how data flows through it, built
to make code readable: scoped views, tracing up and down the pipe, and
eventually a query layer that decides what to show. This repo is the
**core**: the deterministic indexer and graph that everything else will
consume. See `docs/` for background, requirements and design.

## Usage

```sh
npm install
npm run lode -- index path/to/project                  # build or refresh, print a summary
npm run lode -- index path/to/tsconfig.json --json out.json
npm run lode -- node path/to/tsconfig.json 'src/main/x.ts#fn'   # one node, one hop each way
```

```sh
npm run lode -- open path/to/project     # standalone app in the browser
npm run lode -- serve path/to/project    # just the server, for another host
```

To embed lode in an editor or app (VS Code, Electron, a web page), see
[`docs/embedding.md`](docs/embedding.md). `npm run build` makes the package:
`lode` (core), `lode/server`, `lode/views` (+ self-contained bundles in
`dist/views`) and the `lode` command.

The graph is cached in `~/.cache/lode/<project hash>/` (override with
`--cache <dir>`); nothing is written into the indexed project.

A project is a directory, a `tsconfig.json` or a `jsconfig.json`. JavaScript
is always included (ESM, CommonJS, JSDoc types); vendored and minified
bundles are skipped.

## Layout

```
src/schema      the contract between plugins and the core (nodes, edges, channels)
src/ingest/ts   TypeScript + JavaScript plugin: facts from the compiler API, mapped to the schema
src/derive      core analysis: channel matching (tier 3), shared-state flows (tier 2)
src/graph       Graph (validation, traversal), lenses, GraphStore (cache)
src/query      deterministic queries views need (block, entries, search, source, git changes)
src/ask        a flow for a question: graph candidates judged by Jev (or any Judge)
src/service    those queries as methods with no transport; serveMessages for message channels
src/server     the service over JSON-RPC on a WebSocket (`/rpc`), file watching
views/         web components (<lode-entries>, <lode-flow>, <lode-changes>), connections, storage, themes, host contract
hosts/app      the standalone host (`lode open`)
hosts/minimal  a whole host in one HTML page, from the package's bundles
src/cli.ts     the commands above
```

## Tests

```sh
npm test                                                        # fixtures only
LODE_GLANCE_TSCONFIG=path/to/glance/tsconfig.json npm test      # plus a real codebase
```
