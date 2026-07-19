# mdbase-obsidian

Obsidian plugin for mdbase schema workflows:

- Initialize `mdbase.yaml` and `_types/`
- Create basic type definition files
- Validate current note and whole collection
- Create note from type
- Show issues in a dedicated view
- Expose the selected Obsidian mdbase runtime host for independent providers
  and workflow executors

New collections initialize as `0.3.0`; existing v0.2 collections keep
the legacy adapter. The Vault-backed v0.3 adapter loads canonical
`mdbase.type` wrappers, validates raw frontmatter with JSON Schema 2020-12,
asserts the required date/time formats, and applies collection display, read
default, uniqueness, link, and path metadata. The type editor writes inline
`schema.value` wrappers without discarding lifecycle/runtime/migration or
extension sections. Types using `schema.ref` validate normally but are
read-only in the form; edit their referenced JSON Schema file directly.

The runtime host is available to companion plugins through
`app.plugins.getPlugin("mdbase-obsidian")?.api.runtime`. It is generic and
default-deny; TaskNotes is an optional provider rather than the host owner.
For v0.3 collections, the adapter validates and loads the `runtime.policy`
Markdown record selected by `mdbase.yaml`, refreshes it after vault edits, and
keeps the existing provider registrations. Invalid, missing, disabled, or
out-of-vault policies fail closed. `api.getRuntimeStatus()` exposes the selected
policy ID, path, and adapter diagnostics.

## Build

```bash
npm install
npm run build
```

## Build and copy to test vault

```bash
npm run build:test
```

`build:test` uses `copy-files.mjs` with the same override strategy as TaskNotes.
