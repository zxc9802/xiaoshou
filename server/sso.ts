import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { RequestActor } from './domain.js';

const PRODUCT = 'xiaoshou';
const COOKIE_NAME = 'qycm_xiaoshou_sso';
const SESSION_MAX_AGE_SECONDS = 5 * 60;
const MAIN_APP_URL_FALLBACK = 'https://www.qycm.top';
const PUBLIC_APP_URL_FALLBACK = 'https://xiaoshou.qycm.top';

export type MainAppUser = {
  id: string;
  account: string;
  nickname: string;
  role: string;
};

export type SsoSession = {
  token: string;
  user: MainAppUser;
  expiresAt: number;
};

type ExchangeResponse = {
  success?: boolean;
  data?: {
    token?: unknown;
    redirectPath?: unknown;
    user?: unknown;
  };
};

function requiredValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function sessionKey(): Buffer {
  return createHash('sha256').update(requiredValue('APP_SESSION_SECRET')).digest();
}

function isMainAppUser(value: unknown): value is MainAppUser {
  if (!value || typeof value !== 'object') return false;
  const user = value as Record<string, unknown>;
  return ['id', 'account', 'nickname', 'role'].every((key) => typeof user[key] === 'string');
}

function isSession(value: unknown): value is SsoSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Record<string, unknown>;
  return typeof session.token === 'string'
    && isMainAppUser(session.user)
    && typeof session.expiresAt === 'number'
    && Number.isFinite(session.expiresAt)
    && session.expiresAt > Date.now();
}

export function getMainAppUrl(): string {
  return (process.env.MAIN_APP_URL?.trim() || MAIN_APP_URL_FALLBACK).replace(/\/+$/, '');
}

export function getPublicAppUrl(): string {
  return (process.env.PUBLIC_APP_URL?.trim() || PUBLIC_APP_URL_FALLBACK).replace(/\/+$/, '');
}

export function getMainAppSsoLaunchUrl(): string {
  const url = new URL('/home2', getMainAppUrl());
  url.searchParams.set('externalSso', PRODUCT);
  return url.toString();
}

export function getSsoSessionCookieName(): string {
  return COOKIE_NAME;
}

export function safeRedirectPath(value: unknown): string {
  if (typeof value !== 'string') return '/';
  const redirectPath = value.trim();
  if (!redirectPath || !redirectPath.startsWith('/') || redirectPath.startsWith('//')) return '/';
  return redirectPath;
}

export function createSsoSessionCookie(session: SsoSession) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sessionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
  const value = `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
  return { name: COOKIE_NAME, value };
}

export function readSsoSessionCookie(value: string | undefined): SsoSession | null {
  if (!value) return null;
  const [version, ivValue, tagValue, encryptedValue, extra] = value.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue || extra) return null;

  try {
    const decipher = createDecipheriv('aes-256-gcm', sessionKey(), Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const session = JSON.parse(decrypted);
    return isSession(session) ? session : null;
  } catch {
    return null;
  }
}

export function readSsoSessionFromRequest(request: FastifyRequest): SsoSession | null {
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!cookie) return null;
  try {
    return readSsoSessionCookie(decodeURIComponent(cookie.slice(`${COOKIE_NAME}=`.length)));
  } catch {
    return null;
  }
}

export function serializeSsoSessionCookie(value: string, maxAge = SESSION_MAX_AGE_SECONDS): string {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSsoSessionCookie(): string {
  return serializeSsoSessionCookie('', 0);
}

export async function exchangeMainAppSsoTicket(ticket: string): Promise<{
  redirectPath: string;
  session: SsoSession;
}> {
  const response = await fetch(
    process.env.MAIN_APP_SSO_EXCHANGE_URL?.trim()
      || `${getMainAppUrl()}/api/external-sso/${PRODUCT}/exchange`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-qycm-sso-client-secret': requiredValue('MAIN_APP_SSO_CLIENT_SECRET'),
      },
      body: JSON.stringify({ ticket }),
    },
  );
  const payload = await response.json().catch(() => ({})) as ExchangeResponse;
  const token = payload.data?.token;
  const user = payload.data?.user;
  if (!response.ok || !payload.success || typeof token !== 'string' || !isMainAppUser(user)) {
    throw new Error('Main-site SSO exchange was rejected.');
  }

  return {
    redirectPath: safeRedirectPath(payload.data?.redirectPath),
    session: { token, user, expiresAt: Date.now() + (SESSION_MAX_AGE_SECONDS * 1000) },
  };
}

export async function validateMainAppSession(session: SsoSession): Promise<boolean> {
  try {
    const response = await fetch(`${getMainAppUrl()}/api/sso/session`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function requestActor(session: SsoSession): RequestActor {
  return {
    organizationId: 'default-org',
    userId: session.user.id,
    role: session.user.role,
  };
}
