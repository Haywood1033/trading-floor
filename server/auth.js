// Password login for the API. The password lives only in the APP_PASSWORD environment
// variable on Vercel. The session cookie is an HMAC derived from it, so changing the
// password signs every device out.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const COOKIE = 'tf_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export const sessionToken = password => createHmac('sha256', password).update('trading-floor-session-v1').digest('hex');

function same(a, b) {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const checkPassword = (given, password) => typeof given === 'string' && given.length > 0 && same(given, password);
export const isAuthed = (req, password) => {
  const c = parseCookies(req.headers?.cookie)[COOKIE];
  return !!c && same(c, sessionToken(password));
};
export const sessionCookie = password => `${COOKIE}=${sessionToken(password)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE}`;
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
