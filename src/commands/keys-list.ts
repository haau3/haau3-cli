// `haau3 keys list`: the signed-in organization's keys, as the keys page lists them. Each key's name,
// the part of it the keys page shows, its mode, when it was made and how, when it was last used, and
// its id, which `keys revoke` takes; never a key. Revoked keys only with --all, as the keys page hides
// them. The key this project uses is marked, told by that same visible part. Listing changes nothing,
// so the session is kept.
import { resolvePlatform } from "../environment.js";
import type { NextStep } from "../output.js";
import { listKeys } from "../signin/keys.js";
import { done, failed, KEYS_CREATE_STEP, misused, nextText, type Context, type Result } from "./context.js";
import { keyData, keyLines, projectKeyOf, sessionRefused, signedIn, usedHere } from "./signed-in.js";

const COMMAND = "keys list";

export interface KeysListOptions {
  /** Revoked keys too. */
  all: boolean;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export async function keysList(ctx: Context, options: KeysListOptions): Promise<Result> {
  const platform = resolvePlatform(ctx.env);
  if (!platform.ok) return misused(COMMAND, platform.error);
  const address = platform.platformURL;
  const keysPage = `${address}/dashboard/keys`;

  const signed = await signedIn(ctx, address);
  if (!signed.ok) return failed(COMMAND, signed.error);
  const session = signed.session;

  const answer = await listKeys(address, session.accessToken, options.all);
  if (answer.kind === "error") return failed(COMMAND, answer.error);
  if (answer.kind !== "ok") return failed(COMMAND, await sessionRefused(ctx, address, session, answer));
  const { keys, hasMore, revokedOmitted } = answer.list;

  const project = projectKeyOf(ctx);
  const listed = project !== null && keys.some((key) => key.prefix === project.prefix);

  const next: NextStep[] = [];
  if (!options.all && revokedOmitted > 0) {
    next.push({ command: "npx haau3 keys list --all", description: `List the ${plural(revokedOmitted, "revoked key", "revoked keys")} too.` });
  }
  if (keys.length === 0) next.push(KEYS_CREATE_STEP);

  const data = {
    organization: session.organization,
    keys: keys.map((key) => keyData(key, usedHere(project, key))),
    hasMore,
    revokedOmitted,
    projectKey: project ? { source: project.source, prefix: project.prefix, listed } : null,
    next,
  };

  const org = session.organization.name;
  const lines: string[] = [];
  if (keys.length === 0) {
    lines.push(options.all ? `${org} has no keys.` : `${org} has no active keys.`);
  } else {
    const revoked = keys.filter((key) => key.revokedAt !== null).length;
    const counted = options.all
      ? `${plural(keys.length, "key", "keys")}, ${revoked} revoked`
      : plural(keys.length, "active key", "active keys");
    lines.push(`${org}: ${counted}${hasMore ? ", the newest shown" : ""}.`);
    for (const key of keys) lines.push("", ...keyLines(key, usedHere(project, key)));
  }
  lines.push("");
  if (hasMore) lines.push(`More keys than these: see them all on the keys page at ${keysPage}.`);
  if (!options.all && revokedOmitted > 0) lines.push(`${plural(revokedOmitted, "revoked key is", "revoked keys are")} not shown.`);
  if (project && !listed) {
    const where = project.source === "environment" ? "this shell's HAAU3_API_KEY" : project.source;
    const among = options.all ? (hasMore ? "the keys listed" : "this organization's keys") : "this organization's active keys";
    const maybe = options.all ? "It may be another organization's." : "It may have been revoked (keys list --all shows revoked keys), or be another organization's.";
    lines.push(`This project's key (${where}, starting ${project.prefix}) is not among ${among}. ${maybe}`);
  }
  if (keys.some((key) => !key.managed && key.revokedAt === null)) lines.push("To revoke one, run npx haau3 keys revoke <id> yourself, in a terminal.");
  return done(COMMAND, data, `${lines.join("\n").trimEnd()}\n${nextText(next)}`);
}
