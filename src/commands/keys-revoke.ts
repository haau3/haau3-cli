// `haau3 keys revoke <id>`: revokes one of the signed-in organization's keys, for a person at a
// terminal only. A revoked key cannot be brought back and anything using it stops at once, so the
// command shows the key and asks the person to type its name. No flag skips that, and with no terminal,
// or when a coding agent runs it, it refuses and says what it would have revoked: an agent hands the
// command to its person, or points to the keys page.
//
// Everything that needs no one else comes first: the id's shape, the session, then a read of the key
// (which changes nothing). A managed key or a key revoked already is answered there. Only after the
// person confirms is the platform asked to revoke, and revoking ends the sign-in, as making a key does:
// one approval changes one key. This computer's session is ended too once the platform may have ended
// it, whatever it answered.
import { resolvePlatform } from "../environment.js";
import { environmentOf } from "../key.js";
import type { CliError, NextStep } from "../output.js";
import { isKeyId, readKey, revokeKey, type ListedKey } from "../signin/keys.js";
import { done, failed, KEYS_LIST_STEP, keysCreateStep, LOGIN_STEP, misused, nextText, type Context, type Result } from "./context.js";
import { endStoredSession } from "./session.js";
import { day, keyData, keyLines, projectKeyOf, sessionRefused, signedIn, usedHere } from "./signed-in.js";

const COMMAND = "keys revoke";

export interface KeysRevokeOptions {
  /** The key's id, as `keys list` shows it. */
  id: string | undefined;
}

/** The environment a key reaches: a key made before modes reaches production, as the API takes it. */
function environmentOfKey(key: ListedKey) {
  return environmentOf(key.mode === "both" ? "older" : key.mode);
}

function idRefusal(id: string | undefined): CliError | null {
  if (id === undefined) {
    return { code: "missing-argument", message: "haau3 keys revoke needs the id of the key to revoke. keys list shows each key's id.", next: [KEYS_LIST_STEP] };
  }
  // Never repeated: whatever was typed here could be anything, a key included.
  if (/haau3_sk_/i.test(id)) {
    return {
      code: "invalid-id",
      message: "That looks like an API key, so haau3 did not send it or repeat it. Give the key's id instead, which keys list shows. A key typed on a command line can stay in the shell's history.",
      next: [KEYS_LIST_STEP],
    };
  }
  if (!isKeyId(id)) {
    return { code: "invalid-id", message: "That is not a key's id, which reads like 3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b. keys list shows each key's id.", next: [KEYS_LIST_STEP] };
  }
  return null;
}

export async function keysRevoke(ctx: Context, options: KeysRevokeOptions): Promise<Result> {
  const platform = resolvePlatform(ctx.env);
  if (!platform.ok) return misused(COMMAND, platform.error);
  const address = platform.platformURL;
  const keysPage = `${address}/dashboard/keys`;

  const refusal = idRefusal(options.id);
  if (refusal) return misused(COMMAND, refusal);
  const id = options.id!.toLowerCase();

  const signed = await signedIn(ctx, address);
  if (!signed.ok) return failed(COMMAND, signed.error);
  const session = signed.session;
  const organization = session.organization;

  // The key, as the platform has it now. Reading changes nothing, so the session is kept.
  const read = await readKey(address, session.accessToken, id);
  if (read.kind === "error") return failed(COMMAND, read.error);
  if (read.kind === "not-found") {
    return failed(COMMAND, { code: "key-not-found", message: `${organization.name} has no key with that id.`, next: [KEYS_LIST_STEP], problem: read.problem });
  }
  if (read.kind !== "ok") return failed(COMMAND, await sessionRefused(ctx, address, session, read));
  const key = read.key;
  const environment = environmentOfKey(key);
  const inUse = usedHere(projectKeyOf(ctx), key);
  const facts = keyLines(key, inUse).map((line) => `  ${line}`).join("\n");

  if (key.managed) {
    return failed(
      COMMAND,
      { code: "managed-key", message: `That is one of the playground keys the dashboard keeps for its playgrounds, which cannot be revoked:\n${facts}`, next: [] },
      environment,
    );
  }
  if (key.revokedAt !== null) {
    const data = { status: "already-revoked", key: keyData(key, inUse), organization, signInEnded: false, next: [] };
    return done(COMMAND, data, `Already revoked on ${day(key.revokedAt)}, so nothing changed:\n${facts}\n`, environment);
  }

  // Only a person at a terminal is asked; anyone else is told what would have been revoked.
  if (!ctx.interactive || !ctx.confirm) {
    return misused(
      COMMAND,
      {
        code: "confirmation-needed",
        message: `haau3 revokes a key only for a person at a terminal, who types its name to confirm: a revoked key cannot be brought back, and anything using it stops at once. Nothing was revoked. It would revoke this key:\n${facts}\nRun the command below yourself, in a terminal and not through a coding agent, or revoke the key on the keys page at ${keysPage}.`,
        next: [{ command: `npx haau3 keys revoke ${id}`, description: "Run this yourself in a terminal: it shows the key and asks you to type its name." }],
      },
      environment,
    );
  }

  const expected = key.nameAsIs ? key.name : key.prefix.slice(-6);
  const typed = key.nameAsIs ? "the key's name" : `${expected}, the end of its prefix (its name holds characters haau3 does not print as they are)`;
  const question = [
    `This revokes a key of ${organization.name}:`,
    facts,
    "Anything using it stops working at once, and a revoked key cannot be brought back.",
    "Revoking ends this sign-in, so the next key command signs in again.",
  ].join("\n");
  const confirmed = await ctx.confirm(question, `Type ${typed} to revoke it: `, expected);
  if (!confirmed) {
    return failed(COMMAND, { code: "not-confirmed", message: "Nothing was revoked: the key's name was not typed.", next: [] }, environment);
  }

  const revoked = await revokeKey(address, session.accessToken, id);
  const endHere = () => endStoredSession(ctx, address, session);
  switch (revoked.kind) {
    case "revoked": {
      await endHere();
      const next: NextStep[] = [LOGIN_STEP];
      const lines = [`Revoked ${revoked.key.name} (${revoked.key.prefix}) in ${organization.name}.`, "Revoking ended the sign-in, so sign in again before the next key command."];
      if (inUse === "environment") {
        lines.push("This shell's HAAU3_API_KEY still holds the revoked key: unset it, and set a working key where the application reads it.");
      } else if (inUse) {
        lines.push(`${inUse} still holds the revoked key, as HAAU3_API_KEY. Put a new key in its place:`);
        next.push(keysCreateStep({ replace: true }, `Make a new key and put it in place of the revoked one in ${inUse}.`));
      }
      const data = { status: "revoked", key: keyData(revoked.key, inUse), organization, signInEnded: true, next };
      return done(COMMAND, data, `${lines.join("\n")}\n${nextText(next)}`, environment);
    }
    case "already-revoked": {
      if (revoked.signInEnded) await endHere();
      const when = revoked.revokedAt ? ` on ${day(revoked.revokedAt)}` : "";
      const ended = revoked.signInEnded ? " Asking ended the sign-in, so sign in again before the next key command." : "";
      const next = revoked.signInEnded ? [LOGIN_STEP] : [];
      const data = { status: "already-revoked", key: keyData({ ...key, revokedAt: revoked.revokedAt ?? key.revokedAt }, inUse), organization, signInEnded: revoked.signInEnded, next };
      return done(COMMAND, data, `It was revoked${when}, a moment before this request, so nothing changed.${ended}\n${nextText(next)}`, environment);
    }
    case "not-found": {
      if (revoked.signInEnded) await endHere();
      const ended = revoked.signInEnded ? " Asking ended the sign-in, so sign in again first." : "";
      const next = revoked.signInEnded ? [LOGIN_STEP, KEYS_LIST_STEP] : [KEYS_LIST_STEP];
      return failed(COMMAND, { code: "key-not-found", message: `${organization.name} no longer has that key.${ended}`, next, problem: revoked.problem }, environment);
    }
    case "managed":
      return failed(COMMAND, { code: "managed-key", message: "That is one of the playground keys the dashboard keeps, which cannot be revoked.", next: [], problem: revoked.problem }, environment);
    case "ended":
    case "no-organization":
      return failed(COMMAND, await sessionRefused(ctx, address, session, revoked), environment);
    case "unknown":
      // The platform ends the sign-in before it revokes, so it may have ended it before failing.
      await endHere();
      return failed(
        COMMAND,
        { ...revoked.error, message: `${revoked.error.message} Asking may have ended the sign-in, so it is ended here too: sign in again before trying again.`, next: [...revoked.error.next, LOGIN_STEP] },
        environment,
      );
    case "error":
      return failed(COMMAND, revoked.error, environment);
  }
}
