// `haau3 keys create`: the platform makes a new API key for the signed-in organization, and the
// command line writes it to the project's env file as HAAU3_API_KEY. The key is never shown: not here,
// not in JSON, not in an error. What is printed is its prefix, its name, its id and the file.
//
// Everything that needs no one else is checked first: the file, what it holds, that the edit reads
// back right and that git ignores it. Only then is the platform asked, because a haau3 key is kept
// only as a hash and cannot be read back: a key made and then not written is a key nobody holds.
//
// Making a key ends the sign-in. The platform ends the approval before it makes the key, so a
// sign-in someone else approved can never make more than the keys of that one moment. Once the key is
// made, this computer's session is ended too, written or not: revoked from here as well, in case the
// platform was one that did not, then deleted.
import { basename, dirname, join, resolve } from "node:path";
import { chooseFile, inspectFile, planFor, shownPath, standIn, writeKey, type Target } from "../envfile.js";
import { resolvePlatform } from "../environment.js";
import { gitAnswer, type GitAnswer } from "../git.js";
import { environmentOf, KEY_FILES, KEY_VARIABLE } from "../key.js";
import type { CliError, NextStep } from "../output.js";
import { createKey, type KeyMode, type MadeKey } from "../signin/keys.js";
import { arg, COMPLETE_STEP, doctorStep, done, failed, fileFlag, LOGIN_STEP, misused, nextText, when, type Context, type Result } from "./context.js";
import { organizationError } from "./login.js";
import { endStoredSession, loadRecord } from "./session.js";

const COMMAND = "keys create";

/** The platform's limit on a key's name, counted as it counts: in UTF-16 code units. */
export const NAME_MAX = 100;

const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const KEY_MARKER = /haau3_sk_/i;

export interface KeysCreateOptions {
  test: boolean;
  replace: boolean;
  name: string | undefined;
  /** The env file to write, as given with --file. */
  file: string | undefined;
}

/** `text` cut to at most `max` UTF-16 code units, never through a character. */
function cut(text: string, max: number): string {
  let out = "";
  for (const char of text) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out;
}

function localDay(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The name a key gets when none is given: it says the command line made it, for which project and on
 * which day, so keys made from several projects can be told apart on the keys page. The folder's name
 * loses any character a terminal could act on, and is left out if it holds a key's marker.
 */
export function defaultName(cwd: string, now: number): string {
  const day = localDay(now);
  const folder = Array.from(basename(resolve(cwd)))
    .filter((c) => !UNSAFE.test(c))
    .join("")
    .trim();
  if (!folder || KEY_MARKER.test(folder)) return `haau3 CLI, ${day}`;
  const room = NAME_MAX - `haau3 CLI: , ${day}`.length;
  return `haau3 CLI: ${cut(folder, room)}, ${day}`;
}

type NameCheck = { ok: true; name: string } | { ok: false; error: CliError };

/** A name given with --name. Refused without being repeated when it could be anything but a name. */
export function checkName(value: string): NameCheck {
  const name = value.trim();
  const refuse = (message: string): NameCheck => ({ ok: false, error: { code: "invalid-name", message, next: [] } });
  if (KEY_MARKER.test(value)) return refuse("--name looks like it holds an API key, so haau3 will not send it. Give the key a name instead.");
  if (!name) return refuse("--name needs a name.");
  if (name.length > NAME_MAX) return refuse(`--name may be at most ${NAME_MAX} characters.`);
  if (UNSAFE.test(name)) return refuse("--name may not hold control characters or characters that do not show.");
  return { ok: true, name };
}

export { arg } from "./context.js";

/** The same command again, with the flags it was run with and any added: never the name. */
function rerun(options: KeysCreateOptions, target: { shown: string } | null, add: { replace?: boolean } = {}): string {
  const parts = ["npx haau3 keys create"];
  if (options.test) parts.push("--test");
  if (options.file !== undefined && target) parts.push(fileFlag(target.shown));
  if (options.replace || add.replace) parts.push("--replace");
  return parts.join(" ");
}

function again(options: KeysCreateOptions, target: { shown: string } | null): NextStep {
  const named = options.name !== undefined ? " Give the same --name again." : "";
  return { command: rerun(options, target), description: `Make the key and write it.${named}` };
}

/**
 * A line for a .gitignore that matches this file's name: git's pattern characters escaped, a leading
 * `!` or `#` escaped, and a trailing space escaped, since git drops one that is not.
 */
export function gitignoreLine(name: string): string {
  return name
    .replace(/[\\*?[]/g, (c) => `\\${c}`)
    .replace(/^([!#])/, "\\$1")
    .replace(/ +$/, (spaces) => spaces.replaceAll(" ", "\\ "));
}

function gitRefusal(git: GitAnswer, target: Target, ctx: Context, options: KeysCreateOptions): CliError | null {
  if (git.kind === "no-repository" || git.kind === "ignored") return null;
  if (git.kind === "git-unavailable") {
    return {
      code: "git-unavailable",
      message: `${target.shown} is in a git repository and git could not be found on PATH, so haau3 cannot check that git ignores it. Install git, or run this where git is on PATH.`,
      next: [],
    };
  }
  if (git.kind === "git-failed") {
    return {
      code: "git-failed",
      message: `git could not say whether it ignores ${target.shown}, so haau3 will not write a key there. Run git status in that folder to see why.`,
      next: [],
    };
  }
  const gitignore = shownPath(join(dirname(target.path), ".gitignore"), ctx.cwd);
  const line = gitignoreLine(basename(target.path));
  const next = [again(options, target)];
  if (git.tracked) {
    return {
      code: "env-file-tracked",
      message: `git tracks ${target.shown}, so a key written there would be committed. Stop tracking it with git rm --cached ${arg(target.shown)}, add this line to ${gitignore}, then run this again:\n  ${line}`,
      next,
      gitignore: { file: gitignore, line },
    };
  }
  return {
    code: "env-file-not-ignored",
    message: `git does not ignore ${target.shown}, so a key written there could be committed. Add this line to ${gitignore}, then run this again:\n  ${line}`,
    next,
    gitignore: { file: gitignore, line },
  };
}

function madeText(made: MadeKey | null): string {
  if (!made) return "";
  const facts = [made.name ? `named ${made.name}` : null, made.prefix ? `starting ${made.prefix}` : null, made.id ? `id ${made.id}` : null].filter(Boolean);
  return facts.length ? ` The key: ${facts.join(", ")}.` : "";
}

export async function keysCreate(ctx: Context, options: KeysCreateOptions): Promise<Result> {
  const mode: KeyMode = options.test ? "test" : "live";
  const environment = environmentOf(mode);
  const fail = (error: CliError) => failed(COMMAND, error, environment);
  const misuse = (error: CliError) => misused(COMMAND, error, environment);

  const platform = resolvePlatform(ctx.env);
  if (!platform.ok) return misuse(platform.error);
  const address = platform.platformURL;
  const keysPage = `${address}/dashboard/keys`;

  let name: string;
  if (options.name === undefined) {
    name = defaultName(ctx.cwd, ctx.now());
  } else {
    const checked = checkName(options.name);
    if (!checked.ok) return misuse(checked.error);
    name = checked.name;
  }

  // The file, and everything about it that needs no one else.
  const chosen = chooseFile({ cwd: ctx.cwd, file: options.file, env: ctx.env });
  if (!chosen.ok) return chosen.usage ? misuse(chosen.error) : fail(chosen.error);
  const inspected = inspectFile(chosen.chosen);
  if (!inspected.ok) return fail(inspected.error);
  const target = inspected.target;
  if (target.existing && !options.replace) {
    const which = target.existing.prefix ? ` (a key starting ${target.existing.prefix})` : "";
    return fail({
      code: "key-exists",
      message: `${target.shown} already holds ${KEY_VARIABLE}${which}. haau3 replaces it only when asked, and never revokes it.`,
      next: [{ command: rerun(options, target, { replace: true }), description: "Make a new key and put it in place of that one. The old key keeps working until you revoke it on the keys page." }],
    });
  }
  if (!planFor(target, standIn(mode))) {
    const why = target.utf8
      ? `without changing how the rest of it reads, so it changed nothing. Make ${KEY_VARIABLE}'s line a plain NAME=value line with ordinary line endings`
      : `in place, since it is not UTF-8 text and rewriting it could change other bytes, so it changed nothing. Remove ${KEY_VARIABLE}'s line from it`;
    return fail({
      code: "cannot-edit",
      message: `haau3 could not set ${KEY_VARIABLE} in ${target.shown} ${why}, or name another file with --file.`,
      next: [],
    });
  }
  const git = await gitAnswer(target.path, ctx.env, ctx.cwd);
  const refusal = gitRefusal(git, target, ctx, options);
  if (refusal) return fail(refusal);

  // The session.
  const { record, keyringUnreachable } = await loadRecord(ctx, address);
  const session = record.session;
  if (!session) {
    if (record.pending && record.pending.expiresAt > ctx.now()) {
      return fail({ code: "not-signed-in", message: "Not signed in yet: a sign-in is waiting for approval.", next: [COMPLETE_STEP] });
    }
    const unseen = keyringUnreachable ? " The system's credential store could not be reached, so a session kept there could not be checked." : "";
    return fail({ code: "not-signed-in", message: `Not signed in.${unseen} Sign in, then run this again.`, next: [LOGIN_STEP] });
  }
  const endHere = () => endStoredSession(ctx, address, session);
  if (session.expiresAt <= ctx.now()) {
    await endHere();
    return fail({ code: "session-ended", message: `The session ended at ${when(session.expiresAt, ctx.now())}. Sign in again, then run this again.`, next: [LOGIN_STEP] });
  }

  // The key.
  const created = await createKey(address, session.accessToken, { name, mode });
  if (created.kind === "ended") {
    await endHere();
    return fail({ code: "session-ended", message: "The session has ended. Sign in again, then run this again.", next: [LOGIN_STEP], problem: created.problem });
  }
  if (created.kind === "no-organization") {
    await endHere();
    return fail(organizationError(created.code, created.problem, session.organization.name));
  }
  if (created.kind === "error") return fail(created.error);
  if (created.kind === "unknown") {
    // A success the command line cannot use still made a key, and so ended the sign-in.
    if (!created.signInEnded) return fail({ ...created.error, message: `${created.error.message}${madeText(created.made)}` });
    await endHere();
    return fail({
      ...created.error,
      message: `${created.error.message}${madeText(created.made)} Making a key ended the sign-in, so sign in again before trying again.`,
      next: [LOGIN_STEP, ...created.error.next],
    });
  }
  const key = created.key;

  // The write, then the end of the sign-in, whichever way the write went.
  const written = writeKey(target, key.secret, options.replace);
  await endHere();
  if (!written.ok) {
    return fail({
      code: "write-failed",
      message: `The key was made, but ${target.shown} could not be written: ${written.reason}. The key is in no file. Revoke it on the keys page at ${keysPage}: ${key.name}, starting ${key.prefix}, id ${key.id}. Making a key ended the sign-in, so sign in again before trying again.`,
      next: [LOGIN_STEP, again(options, target)],
    });
  }

  const warnings: { code: string; message: string }[] = [];
  if (ctx.env[KEY_VARIABLE]?.trim()) {
    warnings.push({
      code: "shell-key",
      message: `${KEY_VARIABLE} is also set in this shell's environment. Applications read that before an env file, so they keep using it until it is unset.`,
    });
  }
  if (target.reason === "named" && !(KEY_FILES as readonly string[]).includes(basename(target.path))) {
    warnings.push({
      code: "env-file-not-default",
      message: `Applications and haau3 read .env.local and .env by default. Load ${target.shown} yourself, such as with node --env-file=${arg(target.shown)}.`,
    });
  }
  if (git.kind === "no-repository") {
    warnings.push({
      code: "no-git-repository",
      message: `This folder is not in a git repository, so nothing was checked against a .gitignore. If you make one, add ${gitignoreLine(basename(target.path))} to its .gitignore first.`,
    });
  }

  const replaced = target.existing && options.replace ? { prefix: target.existing.prefix } : null;
  // doctor reads the file a key went to: the defaults, or the one named with --file.
  const next = [doctorStep(options.file !== undefined ? target.shown : undefined)];
  const data = {
    status: "created",
    key: { id: key.id, name: key.name, prefix: key.prefix, mode: key.mode },
    organization: session.organization,
    envFile: { path: target.shown, created: written.created, gitRepository: git.kind !== "no-repository" },
    replaced,
    warnings,
    next,
  };

  const kind = mode === "live" ? "a live key" : "a test key";
  const where = written.created
    ? `a new file, ${target.shown}${process.platform === "win32" ? "" : ", readable only by you"}`
    : target.shown;
  const lines = [
    `Made ${kind} in ${session.organization.name} and wrote it to ${where}, as ${KEY_VARIABLE}.`,
    `  Name:   ${key.name}`,
    `  Prefix: ${key.prefix}`,
    `  Id:     ${key.id}`,
    mode === "live" ? "It reaches every production service." : "A test key reaches the Sandbox only.",
    "Making a key ends the sign-in, so sign in again before making another.",
  ];
  if (replaced) {
    const old = replaced.prefix ? `The key it replaced, starting ${replaced.prefix},` : "The key it replaced";
    lines.push(`${old} still works: revoke it on the keys page at ${keysPage}.`);
  }
  for (const warning of warnings) lines.push(warning.message);
  return done(COMMAND, data, `${lines.join("\n")}\n${nextText(next)}`, environment);
}
