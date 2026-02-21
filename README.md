# mdbase-obsidian

Obsidian plugin MVP for mdbase schema workflows:

- Initialize `mdbase.yaml` and `_types/`
- Create basic type definition files
- Validate current note and whole collection
- Create note from type
- Show issues in a dedicated view

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
