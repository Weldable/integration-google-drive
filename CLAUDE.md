# @weldable/integration-google-drive

Google Drive file actions for the Weldable integration ecosystem.

## Layout

```
src/
  index.ts   — defines the integration via defineIntegration() from @weldable/integration-core
```

Actions call the Google Drive REST API using `createRestHandler`.

## Dev workflow

```bash
npm install
npm run build   # tsc → dist/
npm run dev     # watch mode
```

`dist/` is gitignored and built by CI before publishing — do not commit it.

## Releasing

Bump `version` in `package.json`, commit to `main`, push. `publish.yml` handles the rest (build, publish to npm, tag, GitHub release).

Use the `/commit` skill — it handles the version bump, build check, and push.

## Contributing

See [CONTRIBUTING.md in integration-core](https://github.com/weldable/integration-core/blob/main/CONTRIBUTING.md) for the full workflow, peer dependency policy, and how to create a new integration.
