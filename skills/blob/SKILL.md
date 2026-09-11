---
name: blob
description: Read bundled @upstash/blob documentation when writing or debugging Upstash Blob code, including server storage operations, browser or React uploads, signed URLs, and upload callbacks.
metadata:
  author: Upstash
  version: '1.1'
---

# Upstash Blob

Before writing `@upstash/blob` code, read the documentation bundled with the installed SDK.

1. Read `node_modules/@upstash/blob/docs/README.md` for the page index and source revision.
2. Find the pages relevant to the task with `rg "your query" node_modules/@upstash/blob/docs/`.
3. Read those pages for API signatures, options and examples before implementing the change.

The skill provides directions; the bundled pages are the API reference. Prefer their examples
and the installed package's types over remembered API names.

The index groups pages by topic:

- `overall/`: quickstart, pricing and limits
- `bucket/`: server-side storage, connecting, reading, writing, deleting and caching
- `uploads/`: browser and React uploads, handlers, constraints and abandoned uploads
- `reference/`: errors and signing
- `recipes/`: complete application examples

Resolve the package from the app workspace that uses it. If the SDK is not installed, use the
project's package manager to add it when the task requires that dependency. If the installed
version has no bundled docs, consult https://upstash.com/docs/blob and check examples against
the installed types; the online documentation may describe a newer SDK.
