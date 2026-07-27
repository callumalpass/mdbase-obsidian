# Vendored mdbase Connect SDK

The tarballs in this directory are exact consumer artifacts generated from
`mdbase-dev/mdbase-connect` by:

```sh
pnpm package:consumer -- --destination /home/calluma/projects/mdbase-obsidian/vendor
```

`mdbase-connect-sdk.json` records the source revision, sizes, and integrity
digests. The plugin consumes the portable mirror and enrollment entry points;
it must not import `@mdbase/connect-sync/node`.

