# Contributing

Issues and pull requests are welcome.

## Set up

```bash
npm install
npm run typecheck
npm test
```

Node 22.5 or later (the tests use `node:sqlite`). To run the Worker locally, see "Run the API yourself" in the [README](README.md).

## Rules the code keeps

- Prices live in one place, [`src/catalog.ts`](src/catalog.ts). Routes, the catalog, the demo page and the analyst all read from it.
- A request that fails is never charged. Any new paid route must answer 4xx or 5xx on failure so the payment is cancelled.
- Every number in the docs must be reproducible from the API or the chain.
- No secrets in the repo: keys live in `keys/` and `.dev.vars`, both gitignored.

## Pull requests

Keep each pull request to one change, add or update tests for it, and make sure `npm run typecheck` and `npm test` pass. CI runs both on every push.
