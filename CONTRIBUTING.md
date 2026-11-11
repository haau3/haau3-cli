# Contributing

Issues are welcome: a bug, a confusing message, a check that should exist.

## Working on the command line

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm check:package
pnpm check:bin
```

Node 24 and pnpm 12. pnpm installs no version of anything published in the last three days.

`pnpm check:bin` packs the package as npm publishes it, installs it into a new project and runs it
there, the way `npx haau3` does. CI runs it on Linux, macOS and Windows.

`HAAU3_TEST_OS_STORE=1 pnpm test` also tests the session store against your system's own credential
store, under a service name of the tests' own that they delete again. CI sets it on every system.
Without it, the tests use a store in memory and a file in a temporary folder.

## Rules every command keeps

- **The output contract** (`src/output.ts`, the README's "Output"): one JSON document on stdout when
  output is not a terminal, readable text at one, exit codes 0, 1 and 2. A change to the document
  that removes or changes a field raises `formatVersion`'s major version; one that only adds raises
  its minor.
- **A secret is never printed, logged or put in an error**: an API key, a session's access token,
  or the device code of a sign-in waiting for approval. `src/key.ts` holds a key in `ApiKey`, and
  `src/signin/secret.ts` holds the other two the same way, each printing as hidden however it is
  printed. `test/secrets.test.ts` plants made-up ones where the command line finds them, runs every
  command, and fails if one shows anywhere; a command joins it the day it is added.
- **The refresh token is never kept or used.** A session ends when its access token does.
- **One runtime dependency**, `@napi-rs/keyring`, pinned exactly, for the system's credential store,
  and loaded only where it is used so that a computer it cannot load on falls back to the file.
  Otherwise none beyond the haau3 SDK, when a command calls the API.
- **Nothing the user typed is repeated back** unless it has the shape of a command or a flag name.

## Pull requests and releases

Pull requests are squash-merged, and a PR's title becomes its commit on `main`.
[release-please](https://github.com/googleapis/release-please) reads those titles and keeps one
release PR open with the next version and its changelog:

- `feat: ...` and `fix: ...` release a patch, 0.1.1 to 0.1.2.
- `feat!: ...` releases a minor, 0.1.1 to 0.2.0. While the command line is `0.y.z`, a minor is the
  only release that may change what a command takes or prints.
- Any other title (`docs: ...`, `chore: ...`, `test: ...`) releases nothing.

The title is the line a reader sees in `CHANGELOG.md`, so it says what changed for someone using the
command line. Like every file, commit message and PR description here, it says only what this
repository shows: CI's "Public text" check (`pnpm check:public-text`) fails on anything that refers
elsewhere, such as an issue number without its repository. Merging the release PR makes the GitHub
Release and its tag, and `release.yml` stages that version on npm with provenance. It is published
once a maintainer approves it on npm.
