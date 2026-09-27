# Test Fixtures for Upload API

Static site fixtures used when testing the upload API.

## Files

| File | Use |
|------|-----|
| `dummy.html` | Single HTML file upload (POST with `file` field) |
| `dummy-site/` | Folder with `index.html` and `style.css` |
| `dummy-site.zip` | ZIP archive of `dummy-site/` for ZIP upload tests |
| `replacement-site.zip` | Replacement ZIP with `index.html` and `new-style.css` (no `style.css`) |
| `nested-entry-site.zip` | ZIP whose only entry point is `pages/home.html` |
| `escape-site.zip` | Malicious ZIP with a `../../escape.txt` entry (rejected) |
| `no-html.zip` | ZIP with no HTML entry point (rejected) |

## Rebuilding the fixtures

If you modify files in `dummy-site/`, rebuild the ZIPs:

```bash
npm run test:fixtures
node scripts/build-escape-fixture.mjs   # malicious path-escaping ZIP
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
