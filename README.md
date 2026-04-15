# @weldable/integration-google-drive

Google Drive file actions for Weldable.

Part of the [Weldable](https://weldable.ai/) integration library — see [@weldable/integration-core](https://github.com/weldable/integration-core) for the full catalog.

## Install

```bash
npm install @weldable/integration-google-drive @weldable/integration-core
```

`@weldable/integration-core` is a peer dependency and must be installed alongside this package.

## Usage

```ts
import integration from '@weldable/integration-google-drive'

// Find files
const find = integration.actions.find(a => a.id === 'google_drive.find')!

const files = await find.execute(
  { query: 'Q1 report', type: 'spreadsheet', limit: 5 },
  ctx, // ActionContext from your Weldable-compatible host
)

// Get file metadata
const getFile = integration.actions.find(a => a.id === 'google_drive.get_file')!

const file = await getFile.execute(
  { fileId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms' },
  ctx,
)

console.log(file.name, file.webViewLink)
