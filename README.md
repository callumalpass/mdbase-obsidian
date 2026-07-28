# mdbase for Obsidian

The Obsidian gateway to mdbase v0.3 collections and mdbase Connect.

The plugin is deliberately type-first. Its main workspace provides:

- a searchable type workbench with guided and YAML editing;
- local collection initialization;
- read-only support for mdbase v0.2.x and reviewed migration to v0.3.x;
- hosted collection enrollment, sync preview, mirroring, progress, and conflict handling;
- collection validation with bounded issue rendering for large vaults.

It works through Obsidian's Vault, HTTP, IndexedDB, and SecretStorage APIs. The
production bundle has no Node filesystem dependency and is checked against a
mobile bundle budget.

## Collection roles

### Local collection

`Initialize this vault` creates a canonical v0.3 `mdbase.yaml` and `_types/`
directory. The vault is authoritative and remains an ordinary collection of
files.

### Hosted mirror

`Connect a hosted collection` enrolls the vault through mdbase Connect. The
portable directory-mirror engine syncs hosted resources and records into the
vault. A mirror role marker is stored below `.mdbase/`; credentials are stored
only in Obsidian SecretStorage.

The plugin refuses to enroll a directory that contains local collection
authority metadata. Sync is explicit, preflighted, protected by an in-process
lease, and conservative around conflicts.

## Type workbench

Open **mdbase: Open workspace** and choose **Types**.

- Design mode edits identity, membership, placement, and recursive field
  schemas—including nested objects, lists, lists of objects, enums, and links.
- YAML mode exposes the canonical type definition.
- Unknown v0.3 schema and extension data is preserved by guided edits.
- Dirty changes and validation failures are shown before save.
- v0.2 definitions are browsable but read-only until migration.

On mobile, the type list and editor use separate navigation states with
touch-sized actions instead of a compressed desktop split view.

## Migrating v0.2 to v0.3

The migration review shows the source and target versions, every planned write,
warnings, lossy diagnostics, record-equivalence results, and the recovery
location.

Migration:

- verifies that source files have not changed since analysis;
- requires explicit consent for any lossy conversion;
- writes backups and a recovery manifest below `.mdbase/migrations/`;
- writes configuration and type definitions sequentially and rolls back on
  failure;
- verifies the result;
- never rewrites records.

Existing v0.3 collections are not offered migration.

## Application interoperability

The plugin also hosts local application interoperability for companion plugins:

```ts
const host = app.plugins.getPlugin("mdbase-obsidian");
const client = host?.api.interop.connect(yourPlugin);
```

Enable **Allow local application interoperability** in mdbase settings first.
The grant is deliberately off by default and is independent of contract
compatibility: matching schemas do not authorize an application.

The bridge verifies each caller from Obsidian's active plugin registry. Event
sources publish CloudEvents 1.0 envelopes to every compatible subscriber.
Actions resolve to exactly one compatible provider; zero providers and
ambiguous providers fail explicitly. Every delivered event and action outcome
records the exact contract version and digest plus application and
implementation identity.

The bridge is cooperative, same-process transport for Obsidian plugins. It does
not claim to be a durable runtime: workflows, scheduling, retries, recovery,
and runtime-policy admission belong to a Runtime 0.2 host such as Connect. It
does not claim durable delivery or cross-device execution.

## Development

```bash
npm install
npm test
npm run build
```

Additional gates:

```bash
npm run check:mobile
npm run profile:testvault
npm run build:test
```

`build:test` copies the built plugin to the configured test vaults.
`profile:testvault` scans `/home/calluma/testvault/test` without writing it and
enforces checked-in schema, migration-analysis, validation, and issue-render
budgets.

The Connect SDK packages are vendored as exact consumer tarballs. Their source
revision and integrity hashes are recorded in
`vendor/mdbase-connect-sdk.json`; regenerate them with the Connect repository's
`package:consumer` script rather than editing the archives.

## Compatibility

- Authoring target: mdbase v0.3.x
- Read and migration input: mdbase v0.2.x
- Obsidian minimum version: 1.11.4
- Desktop and mobile supported

The plugin is not a general record editor, query dashboard, or Connect server
administration client.
