// What the session store keeps for one platform address: the session, once a person has approved
// one, and the sign-in waiting for approval, between `haau3 login` and `haau3 login --complete`.
// Never a refresh token: the command line does not keep one (see src/signin/device.ts).
import type { SignInService } from "../signin/discovery.js";
import type { PendingSignIn } from "../signin/device.js";
import { isRecord, text } from "../signin/http.js";
import { AccessToken, DeviceCode } from "../signin/secret.js";

export interface Session {
  accessToken: AccessToken;
  /** When the platform stops taking the token, in milliseconds since the epoch. */
  expiresAt: number;
  issuer: string;
  clientId: string;
  revocationEndpoint: string;
  member: { id: string; email: string | null };
  organization: { id: string; name: string; slug: string | null };
}

export interface SessionRecord {
  session?: Session;
  pending?: PendingSignIn;
}

/** The record as JSON, the secrets written out: for the store's eyes only. */
export interface StoredRecord {
  session?: {
    accessToken: string;
    expiresAt: string;
    issuer: string;
    clientId: string;
    revocationEndpoint: string;
    member: { id: string; email: string | null };
    organization: { id: string; name: string; slug: string | null };
  };
  pending?: {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresAt: string;
    interval: number;
    service: Omit<SignInService, "platformURL">;
  };
}

export function isEmpty(record: SessionRecord): boolean {
  return !record.session && !record.pending;
}

export function toStored(record: SessionRecord): StoredRecord {
  const stored: StoredRecord = {};
  const { session, pending } = record;
  if (session) {
    stored.session = {
      accessToken: session.accessToken.reveal(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      issuer: session.issuer,
      clientId: session.clientId,
      revocationEndpoint: session.revocationEndpoint,
      member: session.member,
      organization: session.organization,
    };
  }
  if (pending) {
    // The platform's address is the record's key, so the service is kept without it.
    const { issuer, clientId, scope, deviceEndpoint, tokenEndpoint, revocationEndpoint } = pending.service;
    const service = { issuer, clientId, scope, deviceEndpoint, tokenEndpoint, revocationEndpoint };
    stored.pending = {
      deviceCode: pending.deviceCode.reveal(),
      userCode: pending.userCode,
      verificationUri: pending.verificationUri,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      interval: pending.interval,
      service,
    };
  }
  return stored;
}

/** The record from what a store held, keeping each part only when it is whole. */
export function fromStored(value: unknown, platformURL: string): SessionRecord {
  const record: SessionRecord = {};
  if (!isRecord(value)) return record;
  const session = readSession(value.session);
  if (session) record.session = session;
  const pending = readPending(value.pending, platformURL);
  if (pending) record.pending = pending;
  return record;
}

function readSession(value: unknown): Session | undefined {
  if (!isRecord(value) || !isRecord(value.member) || !isRecord(value.organization)) return undefined;
  const accessToken = text(value.accessToken, 4096);
  const expiresAt = time(value.expiresAt);
  const issuer = text(value.issuer, 500);
  const clientId = text(value.clientId, 200);
  const revocationEndpoint = text(value.revocationEndpoint, 500);
  const memberId = text(value.member.id, 200);
  const email = value.member.email === null ? null : text(value.member.email, 320);
  const orgId = text(value.organization.id, 200);
  const orgName = text(value.organization.name, 200);
  const slug = value.organization.slug === null ? null : text(value.organization.slug, 200);
  if (!accessToken || expiresAt === undefined || !issuer || !clientId || !revocationEndpoint) return undefined;
  if (!memberId || email === undefined || !orgId || !orgName || slug === undefined) return undefined;
  return {
    accessToken: new AccessToken(accessToken),
    expiresAt,
    issuer,
    clientId,
    revocationEndpoint,
    member: { id: memberId, email },
    organization: { id: orgId, name: orgName, slug },
  };
}

function readPending(value: unknown, platformURL: string): PendingSignIn | undefined {
  if (!isRecord(value) || !isRecord(value.service)) return undefined;
  const deviceCode = text(value.deviceCode, 2000);
  const userCode = text(value.userCode, 40);
  const verificationUri = text(value.verificationUri, 500);
  const expiresAt = time(value.expiresAt);
  const interval = value.interval;
  const s = value.service;
  const service = {
    platformURL,
    issuer: text(s.issuer, 500),
    clientId: text(s.clientId, 200),
    scope: typeof s.scope === "string" && s.scope.length <= 1000 ? s.scope : undefined,
    deviceEndpoint: text(s.deviceEndpoint, 500),
    tokenEndpoint: text(s.tokenEndpoint, 500),
    revocationEndpoint: text(s.revocationEndpoint, 500),
  };
  if (!deviceCode || !userCode || !verificationUri || expiresAt === undefined) return undefined;
  if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 1 || interval > 600) return undefined;
  if (!service.issuer || !service.clientId || service.scope === undefined || !service.deviceEndpoint || !service.tokenEndpoint || !service.revocationEndpoint) return undefined;
  return {
    deviceCode: new DeviceCode(deviceCode),
    userCode,
    verificationUri,
    expiresAt,
    interval,
    service: service as SignInService,
  };
}

function time(value: unknown): number | undefined {
  const raw = text(value, 40);
  if (!raw) return undefined;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : at;
}
