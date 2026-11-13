# haau3

The command line for the [haau3 platform API](https://docs.haau3.com), for developers and their
coding agents. It checks that a project is ready to call the API, makes one call to each service,
and puts an API key in the project's env file without ever showing it.

```sh
npx haau3 --help
```

Node 22 or newer. The full guide is at [docs.haau3.com/cli](https://docs.haau3.com/cli).

## From nothing to a first call

Try the API first in the Sandbox, the API's test environment at `https://sandbox.haau3.com`, which
answers each operation's documented example with no key and no account:

```sh
npx haau3 doctor
npx haau3 test
```

Then make a live key from your project's folder. `login` prints a page and a short code, and a
person approves in any browser and picks an organization:

```sh
npx haau3 login
npx haau3 keys create
```

`keys create` writes the key to the project's env file as `HAAU3_API_KEY`. Load that file when your
program starts, such as with `node --env-file=.env`; Next.js loads it itself. A test key
is optional: `npx haau3 keys create --test` makes one, which reaches the Sandbox only.

## Commands

### init

```sh
npx haau3 init
```

Sets the project in this folder up to use haau3, and writes no application code:

- It installs haau3's SDK with the project's own package manager (npm, pnpm, Yarn, Bun, uv, Poetry,
  Pipenv or Go), which records it in the manifest. In a pip project it installs nothing and names
  the line to add, since pip records nothing.
- It adds the haau3 skill, read from docs.haau3.com, and the docs' MCP server,
  `https://docs.haau3.com/mcp`, for each coding agent the project uses, in the project's own files:
  Claude Code, Cursor, Codex, VS Code or Gemini CLI.
- It checks that git ignores the env file the key goes in, and names the line to add when it does
  not.

It ends with the next steps, including how your program loads the env file. Run again, it changes
nothing, and the `changed` list in its JSON output is empty.

```sh
npx haau3 init --agent claude-code
npx haau3 init --no-agent
```

- `--agent <agent>` sets up that coding agent: `claude-code`, `cursor`, `codex`, `vscode` or
  `gemini-cli`, given once for each. By default it sets up the agents the project's files show, and
  the agent running it.
- `--no-agent` sets up no coding agent: only the SDK and the env file.
- `--language <language>` names the project to set up, `node`, `python` or `go`, when the folder
  holds more than one.
- `--package-manager <name>` names the package manager when the project's files name more than one.
- `--file <file>` checks that env file in place of `.env.local` and `.env`.

With no terminal it asks nothing: a choice it cannot make from the project's files is a refusal that
names the flag. It never edits a manifest by hand, a `.gitignore`, or an MCP entry that is already
there for another server.

### doctor

```sh
npx haau3 doctor
```

Checks whether this project is ready to call the API: Node, the SDK, the key and where it was found,
a key set under another name, git ignoring the key's file, the settings the SDK will use, the API
answering, a call that proves the key works (a read that counts toward no plan), and the sign-in.
Each check passes, warns, fails or is skipped, with the commands that fix it. It exits `1` when a
check fails. `--file <file>` reads that env file in place of `.env.local` and `.env`.

### test

```sh
npx haau3 test
npx haau3 test terminology
npx haau3 test terminology --all
```

Makes one call to each service, each built from the API's published spec: the operation's own
example request, and nothing you type. `test <service>` calls one service, and `--all` every
operation of it. `--all` alone runs every operation of every service, with a key only. With no key it
calls the Sandbox with no key, where one call to each of the nine services uses 9 of the 30 requests
an hour each address gets. It says what kind of answer came back, the request id and the time, and
never prints an answer. A call answered does not say a service is licensed, under an agreement or
ready for production.

The services are `scheduling`, `fhir-base`, `terminology`, `provider-directory`, `questionnaires`,
`medical-benefits`, `pharmacy-benefits`, `medlist` and `structured-sig`.

### login

```sh
npx haau3 login
```

Signs in with the device authorization grant (RFC 8628): it prints a page and a short code, and a
person approves in any browser and picks an organization. At a terminal it waits for the approval.
With no terminal, as when a coding agent runs it, it prints the page and the code and exits, and
`login --complete` waits for the approval:

```sh
npx haau3 login
npx haau3 login --complete
```

`login --complete` waits at most 100 seconds, and can be run again while it says
`approval-pending`. A session lasts at most an hour. It is kept in the system's credential store, or
in a file only you can read (`HAAU3_SESSION_STORE=file`).

### whoami

```sh
npx haau3 whoami
```

Who is signed in, the organization, its plan and this month's use, and when the session ends.

### logout

```sh
npx haau3 logout
```

Ends the sign-in and the approval behind it.

### keys create

```sh
npx haau3 keys create
npx haau3 keys create --test
```

Makes an API key for the signed-in organization and writes it to the project's env file as
`HAAU3_API_KEY`. It prints the key's prefix, name and id, never the key. The key is live unless
`--test` asks for a test key, and the keys page on [platform.haau3.com](https://platform.haau3.com)
lists it, marked as made from the command line. **Making a key ends the sign-in**, so each key takes
its own approval.

- `--name <name>` names the key. By default the name says haau3 made it, for which folder and on
  which day.
- `--file <file>` writes to that env file. By default it writes to the file that already holds the
  key. Otherwise, for Next.js, it writes to `.env.local` if there is one, else `.env`, else a new
  `.env.local`. For any other project it writes to `.env`, Vite included, since Vite does not load
  env files into `process.env`.
- `--replace` replaces a key the file already holds. The old key is not revoked.

In a git repository it writes only to a file git ignores. Otherwise it refuses and names the line to
add to the `.gitignore`.

### keys list

```sh
npx haau3 keys list
npx haau3 keys list --all
```

Lists the signed-in organization's keys, newest first, as the keys page lists them. For each key it
shows the name, the prefix, the mode, when the key was made and how, when it was last used, and the
id. It never shows a key. Revoked keys are left out unless `--all` asks for them. It marks the key
this project uses, found where the application finds it. When that key is not among the listed
keys, it says so: the key may be revoked, or another organization's. Listing changes nothing, so the
session stays.

### keys revoke

```sh
npx haau3 keys revoke <id>
```

Revokes one of the organization's keys, by the id `keys list` shows. A revoked key cannot be
brought back, and anything using it stops at once. So `keys revoke` shows the key, says whether this
project uses it, and asks you to type its name exactly as shown. A name that cannot be typed as it is
shown asks for the end of the key's prefix instead. Anything typed before the question appears is
ignored, and after two minutes with no answer it gives up. No flag skips the question.

**It asks a person at a terminal, and refuses when it can tell no person is there**: no terminal,
JSON output, the `CI` variable, or a coding agent's variables. Then it revokes nothing and exits 2
with `confirmation-needed`. It names the key it would have revoked, gives the command for the person
to run in their own terminal, and points to the keys page.

A program that pretends to be a person at a terminal can still answer the question. What bounds any
caller is the platform: **revoking ends the sign-in**, as making a key does, and one sign-in changes
one key. A playground key the dashboard keeps cannot be revoked. A key revoked already exits 0 and
changes nothing. To rotate a key, run `keys create --replace`, sign in again, then revoke the old
key.

### Switching organization

A sign-in acts for the one organization picked on the approval page. To act for another, sign out,
then sign in and pick it there:

```sh
npx haau3 logout
npx haau3 login
```

`whoami` says which organization the session acts for.

## What it never does

- It never shows a key. No flag prints one, and none is in its output or its errors.
- It never prints an answer's body.
- It sends only the spec's own example requests, never a payload you give it.
- It never edits a `.gitignore`.
- It never writes application code, and never edits a manifest by hand: the project's own package
  manager records the SDK.
- It sends a key only to `api.haau3.com`, `sandbox.haau3.com` or this computer. It reads the skill
  from `docs.haau3.com`, and sends it no key and no session.
- A session can do only what its member can do on the dashboard.
- It never revokes a key without asking at a terminal for the key's name, and never asks where it can
  tell no person is there.

## For coding agents

When a coding agent runs it, every command prints one JSON document, never a prompt. Run
`npx haau3 doctor --json` first, branch on `ok`, and run the commands in `next`. To make a key, run
`login`, give the person the page and the code it prints, then run `login --complete` and
`keys create`. The key goes into the env file, never through the chat. `npx haau3 init` adds the
haau3 skill and the docs' MCP server for the project's coding agents. An agent can list keys with
`keys list`, but `keys revoke` refuses it. Its error names the key and the command for the person
to run in their own terminal, with nothing in `next`, since running it again is refused again.

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

<!-- x-release-please-start-version -->
```json
{
  "formatVersion": "1.3",
  "cli": "haau3",
  "cliVersion": "0.1.11",
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
<!-- x-release-please-end -->

- `formatVersion` is the version of this shape. A new minor version only adds fields, so ignore a
  field you don't know. A new major version changes or removes one, so refuse a major version you
  don't know.
- Every field is always present. Branch on `ok`. On success `error` is `null`. On failure `data` is
  `null`, except for `doctor`, `test` and `init`, whose report is in `data` either way (since 1.3).
- `environment` is `production` or `sandbox` when the document is about an API key or a call to the
  API, and `null` otherwise.
- `error.code` is what to branch on, and `error.next` lists commands to run next. On success,
  `data.next` does. When an answer from the API or the platform is the failure, `error.problem`
  carries its own [problem](https://docs.haau3.com/errors): its `type`, `title`, `status`, `code`
  when it has one (since 1.1), and `requestId`. An answer that is not a problem, such as a success
  haau3 cannot use, gives only its `status` and `requestId`, with `type` `about:blank` and `title`
  `HTTP <status>`.
- When a file has to be added to a `.gitignore` before haau3 will write to it, `error.gitignore`
  names the `.gitignore` (`file`) and the line to add to it (`line`), since 1.2. haau3 never edits a
  `.gitignore` itself.

Exit codes: `0`, it worked; `1`, it ran and something failed; `2`, it was used wrongly.

## Environment

| Variable | What it does |
|---|---|
| `HAAU3_API_KEY` | The API key: from the environment, else the project's env files, as its loader reads them (`.env.local`, then `.env` for Next.js; `.env` otherwise). |
| `HAAU3_ENVIRONMENT` | `production` or `sandbox`: the environment to call. With `sandbox`, no key is needed. |
| `HAAU3_BASE_URL` | Call the API at another address, such as a stand-in, for development. |
| `HAAU3_OUTPUT` | `json` or `text`: the output to print, whatever the terminal. |
| `HAAU3_PLATFORM_URL` | Sign in at another address than `https://platform.haau3.com`, for development. |
| `HAAU3_DOCS_URL` | Read the haau3 skill and name the docs' MCP server at another address than `https://docs.haau3.com`, for development. |
| `HAAU3_SESSION_STORE` | `file`: keep the session in a file only you can read, not the system's credential store. |
| `HAAU3_CONFIG_DIR` | The folder for that file. By default `~/.config/haau3`, or `%APPDATA%\haau3` on Windows. |

## The SDKs

The calls themselves are made with an SDK:
[`@haau3/sdk`](https://www.npmjs.com/package/@haau3/sdk) for TypeScript,
[`haau3`](https://pypi.org/project/haau3/) for Python, and
[`github.com/haau3/haau3-go`](https://pkg.go.dev/github.com/haau3/haau3-go) for Go.

## Security

Report a vulnerability by email, as [SECURITY.md](SECURITY.md) says, not in a public issue.

## License

MIT
