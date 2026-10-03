# Contributing

Small repository, small rules.

## Setup

```bash
npm ci
npm run lint        # secret / private-identifier scan
npm run typecheck   # tsc --noEmit in every package
npm test            # vitest, in memory, no network
```

CI runs the same three commands on Node 20 and 22.

## Conventions

- **TypeScript strict**, ESM, `.js` extensions on relative imports (NodeNext). No `any` without a comment saying why.
- **Tests never need a database, a network or an API key.** New behaviour comes with a test against the in-memory adapters. LLM-backed classes must compile but are not executed in CI.
- **Tenant first.** Any new store or service method takes the tenant / project id explicitly and never queries across tenants.
- **No schema change without a numbered migration** under `packages/*/sql/`. Stores do not create or alter tables at runtime.
- **No secrets, ever**, including in tests, fixtures and examples. `npm run lint` must stay clean; extend its pattern list, do not shorten it. Synthetic data only: invented suppliers, invented ids, invented names.
- **Short comments on the why**, not the what. If a rule exists because something went wrong in production, say so in one line.
- Commits in English, imperative, conventional prefix (`feat`, `fix`, `docs`, `chore`, `test`), scoped to the package when it applies: `feat(review-queue): ...`.

## Adding things

- A new extractor or classifier: implement the interface, ship it in its own module if it pulls a dependency, export it from `index.ts` only if it is dependency-free.
- A new store: implement the interface, add the SQL migration, mirror the in-memory behaviour, and say in the class comment whether unit tests cover it.
- A new channel adapter: map the platform payload to `InboundMessage` in a pure function (see `adapters/telegram.ts`) and keep the polling or webhook loop in the application, not in the package.
