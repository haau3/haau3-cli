// The platform's answer to "who is this session": the member, the organization picked when the
// session was approved, the plan, this month's use and when the platform stops taking the session.
// The shape is checked by hand, field by field, so the command line needs no dependency to read it,
// and a value it does not expect (a new plan, say) is carried rather than refused.
import type { CliError, Problem } from "../output.js";
import { CLI_API_PATH, platformUnavailable } from "./discovery.js";
import { call, dateOf, displayText, isRecord, problemOf, text } from "./http.js";
import type { AccessToken } from "./secret.js";

export interface Whoami {
  member: { id: string; email: string | null };
  organization: { id: string; name: string; slug: string | null };
  /** As the platform names it, such as `org:admin`. */
  role: string;
  plan: { tier: string; name: string };
  usage: { count: number; allowance: number | null; headline: string } | null;
  session: { expiresAt: string };
}

export type WhoamiResult =
  /**
   * `platformNow` is the answer's Date header, so the session's end can be read on this computer's
   * clock. `answer` is the answer's status and request id, for an error built from it later.
   */
  | { kind: "ok"; whoami: Whoami; platformNow: number | undefined; answer: Problem }
  /** The session is over: the platform no longer takes the token. */
  | { kind: "ended"; problem: Problem }
  /** The member is not in the organization the session was approved for, or picked none. */
  | { kind: "no-organization"; code: "not-a-member" | "no-organization"; problem: Problem }
  | { kind: "error"; error: CliError };

export async function readWhoami(platformURL: string, token: AccessToken, timeoutMs?: number): Promise<WhoamiResult> {
  const host = new URL(platformURL).host;
  const answer = await call(`${platformURL}${CLI_API_PATH}/whoami`, { bearer: token, timeoutMs });
  if (!answer.answered) {
    return { kind: "error", error: { code: "platform-unreachable", message: `${host} did not answer. Check the connection and try again.`, next: [{ command: "npx haau3 whoami", description: "Ask again." }] } };
  }
  if (answer.status === 200) {
    const whoami = parseWhoami(answer.body);
    // A success's problem is its status and request id only: its body is never read as one.
    if (whoami) return { kind: "ok", whoami, platformNow: dateOf(answer.headers), answer: problemOf(answer) };
    return {
      kind: "error",
      error: { code: "unexpected-answer", message: `${host} answered with a description of the session haau3 cannot read.`, next: [{ command: "npx haau3@latest --version", description: "Check for a newer haau3." }], problem: problemOf(answer) },
    };
  }
  const problem = problemOf(answer);
  if (answer.status === 401) return { kind: "ended", problem };
  if (answer.status === 403 && (problem.code === "not-a-member" || problem.code === "no-organization")) {
    return { kind: "no-organization", code: problem.code, problem };
  }
  if (answer.status >= 500) return { kind: "error", error: platformUnavailable(host, answer) };
  return { kind: "error", error: { code: "unexpected-answer", message: `${host} refused to describe the session (HTTP ${answer.status}).`, next: [], problem } };
}

export function parseWhoami(body: unknown): Whoami | undefined {
  if (!isRecord(body)) return undefined;
  const { member, organization, plan, usage, session } = body;
  if (!isRecord(member) || !isRecord(organization) || !isRecord(plan) || !isRecord(session)) return undefined;
  // Ids and times must be clean; names someone chose are shown with anything unsafe replaced.
  const memberId = text(member.id, 200);
  const email = member.email === null ? null : displayText(member.email, 320);
  const orgId = text(organization.id, 200);
  const orgName = displayText(organization.name, 200);
  const slug = organization.slug === null ? null : displayText(organization.slug, 200);
  const role = displayText(body.role, 100);
  const tier = text(plan.tier, 50);
  const planName = displayText(plan.name, 100);
  const expiresAt = text(session.expiresAt, 40);
  if (!memberId || email === undefined || !orgId || !orgName || slug === undefined || !role || !tier || !planName) return undefined;
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) return undefined;

  let readUsage: Whoami["usage"] = null;
  if (usage !== null) {
    if (!isRecord(usage)) return undefined;
    const { count, allowance } = usage;
    const headline = displayText(usage.headline, 200);
    if (!Number.isSafeInteger(count) || (count as number) < 0 || !headline) return undefined;
    if (allowance !== null && (!Number.isSafeInteger(allowance) || (allowance as number) <= 0)) return undefined;
    readUsage = { count: count as number, allowance: allowance as number | null, headline };
  }
  return {
    member: { id: memberId, email },
    organization: { id: orgId, name: orgName, slug },
    role,
    plan: { tier, name: planName },
    usage: readUsage,
    session: { expiresAt },
  };
}
