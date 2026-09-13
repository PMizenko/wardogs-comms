import { SignJWT, jwtVerify } from 'jose';
import type { UserIdentity } from '@wardogs/shared';
import { config } from '../config.js';

const secret = new TextEncoder().encode(config.jwtSecret);
const ISSUER = 'wardogs-voip';

/**
 * Session token minted after Discord sign-in. The desktop app stores it and
 * presents it when opening the control socket; it is never sent to LiveKit.
 */
export async function signSession(user: UserIdentity): Promise<string> {
  return new SignJWT({ name: user.name, avatarUrl: user.avatarUrl })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(secret);
}

export async function verifySession(token: string): Promise<UserIdentity | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
    if (!payload.sub) return null;
    return {
      id: payload.sub,
      name: typeof payload.name === 'string' ? payload.name : 'Unknown',
      avatarUrl: typeof payload.avatarUrl === 'string' ? payload.avatarUrl : null,
    };
  } catch {
    return null;
  }
}
