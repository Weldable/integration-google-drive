# @weldable/integration-google-drive

Google Drive file actions for Weldable.

Part of the [Weldable](https://github.com/weldable/weldable) integration library — see [@weldable/integration-core](https://github.com/weldable/integration-core) for the full catalog.

## Install

```bash
npm install @weldable/integration-google-drive @weldable/integration-core
```

`@weldable/integration-core` is a peer dependency and must be installed alongside this package.

## Usage

```ts
import integration from '@weldable/integration-google-drive'

// Pass to a Weldable-compatible host
console.log(integration.actions.map(a => a.id))
```

## Contributing and releasing

See [CONTRIBUTING.md](https://github.com/weldable/integration-core/blob/main/CONTRIBUTING.md) in `@weldable/integration-core` for the development workflow and release process.

## License

MIT
