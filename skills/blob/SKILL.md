---
name: blob
description: Read bundled @upstash/blob documentation when writing or debugging Upstash Blob code, including server storage operations, browser or React uploads, signed URLs, and upload callbacks.
metadata:
  author: Upstash
  version: '1.2'
---

# Upstash Blob

Before writing `@upstash/blob` code, read the documentation bundled with the installed SDK.

1. For setup, read `node_modules/@upstash/blob/docs/overall/quickstart.mdx`. For other tasks,
   use the directory guide below and search with `rg "your query" node_modules/@upstash/blob/docs/`.
2. Read the relevant pages for API signatures, options and examples.
3. Check implementation details in `node_modules/@upstash/blob/src/`. The docs are fetched
   at packaging time from a separate repository; if an example conflicts with the installed
   types or source, follow the installed implementation.

Documentation directories:

- `overall/`: quickstart, pricing and limits
- `bucket/`: server-side storage, connecting, reading, writing, deleting and caching
- `uploads/`: browser and React uploads, handlers, constraints and abandoned uploads
- `reference/`: types, errors and signing
- `recipes/`: complete application examples

Source directories are `src/server/`, `src/browser/`, `src/react/`, and `src/shared/`.
Documentation links beginning with `/blob/` map to files under `docs/` with a `.mdx` extension.

Resolve the package from the app workspace that uses it. If the SDK is not installed, use the
project's package manager to add it when the task requires that dependency. If the installed
version has no bundled docs, consult https://upstash.com/docs/blob and check examples against
the installed types; the online documentation may describe a newer SDK.
