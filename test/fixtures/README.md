# Test Fixtures for Upload API

Static site fixtures used when testing the upload API.

## Files

| File | Use |
|------|-----|
| `dummy.html` | Single HTML file upload (POST with `file` field) |
| `dummy-site/` | Folder with `index.html` and `style.css` |
| `dummy-site.zip` | ZIP archive of `dummy-site/` for ZIP upload tests |

## Rebuilding the ZIP

If you modify files in `dummy-site/`, rebuild the ZIP:

```bash
npm run test:fixtures
```

## Integration tests

Run the full integration test suite (builds the app, starts the server, tests the upload API):

```bash
npm run test:integration
```

## Usage in tests

```ts
import { readFileSync } from 'fs'
import { join } from 'path'

const FIXTURES = join(process.cwd(), 'test', 'fixtures')

// HTML upload
const htmlBuffer = readFileSync(join(FIXTURES, 'dummy.html'))

// ZIP upload
const zipBuffer = readFileSync(join(FIXTURES, 'dummy-site.zip'))
```
