# haau3

The command line for the [haau3 platform API](https://docs.haau3.com), for developers and their
coding agents.

```sh
npx haau3 --version
npx haau3 --help
```

Node 22 or newer.

This version prints its version and its help, and sets the output every command keeps.

## Output

At a terminal, haau3 prints readable text. When its output goes anywhere else, such as a pipe, a
file or a coding agent, a command prints one JSON document on stdout, errors included, and never a
prompt, a spinner or colour. It also prints JSON when a coding agent runs it, from the variables
Codex, Claude Code, Cursor and other agents set, since some give a command a terminal
of its own.

- `--json` asks for the JSON document at a terminal too.
- `HAAU3_OUTPUT=json` or `HAAU3_OUTPUT=text` chooses either one, whatever the terminal.
- `--help` and `--version` print text unless JSON is asked for in one of those two ways.

The document:

```json
{
  "formatVersion": "1.1",
  "cli": "haau3",
  "cliVersion": "0.1.0",
  "command": null,
  "ok": false,
  "environment": null,
  "data": null,
  "error": {
    "code": "unknown-command",
    "message": "haau3 has no command named nope.",
    "next": [{ "command": "npx haau3 --help", "description": "See what haau3 can do." }]
  }
}
```

- `formatVersion` is the version of this shape. A new minor version only adds fields, so ignore a
  field you don't know. A new major version changes or removes one, so refuse a major version you
  don't know.
- Every field is always present. Exactly one of `data` and `error` is `null`.
- `environment` is `production` or `sandbox` when the document is about an API key or a call to the
  API, and `null` otherwise.
- `error.code` is what to branch on, and `error.next` lists commands to run next. When the API's
  answer is the failure, `error.problem` carries the API's own
  [problem](https://docs.haau3.com/errors): its `type`, `title`, `status`, `code` when it has one
  (since 1.1), and `requestId`.

Exit codes: `0`, it worked; `1`, it ran and something failed; `2`, it was used wrongly.

## The SDKs

The calls themselves are made with an SDK:
[`@haau3/sdk`](https://www.npmjs.com/package/@haau3/sdk) for TypeScript,
[`haau3`](https://pypi.org/project/haau3/) for Python, and
[`github.com/haau3/haau3-go`](https://pkg.go.dev/github.com/haau3/haau3-go) for Go.

## Security

Report a vulnerability by email, as [SECURITY.md](SECURITY.md) says, not in a public issue.

## License

MIT
