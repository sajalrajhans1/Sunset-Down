import {
  bodyTooLarge,
  isConfigured,
  json,
  redis,
  safeEqual,
  sanitiseName,
  underRateLimit,
  USERNAMES_KEY,
  type UsernameRecord,
} from './_shared';

export const config = { runtime: 'edge' };

/**
 * Username ownership.
 *
 * A name belongs to whoever claimed it, and nobody else can post under it.
 * That is the whole point: without it, two players called "Sam" are forever
 * fighting over one row.
 *
 * Ownership is anchored to the anonymous id the player's browser generated,
 * because there are no accounts here and there is no appetite for adding
 * them - an email box and a password field would cost more players than the
 * problem is worth. The gap that leaves is a player who clears their storage
 * or moves to another machine, which is what the recovery code is for: a short
 * string that re-points a name at whichever browser presents it.
 *
 * Names are deliberately *not* monthly. Scores reset on the first; a name you
 * chose does not, because losing it to a stranger every month would be worse
 * than the collisions this replaces.
 */

const CLIENT_RE = /^[a-f0-9]{32}$/;

const normaliseCode = (value: unknown): string =>
  typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';

/**
 * Everything here is POST, including the availability check.
 *
 * That check is a read and would naturally be a GET, but it needs the caller's
 * player id to answer "is this name *yours*" - and that id is in effect a
 * bearer credential: whoever holds it owns the name. Query strings end up in
 * access logs, browser history and Referer headers, which is the wrong place
 * for a credential to accumulate, so it travels in the body instead.
 */
export default async function handler(request: Request): Promise<Response> {
  if (!isConfigured()) return json({ configured: false });
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  try {
    return await act(request);
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
}

// ---------------------------------------------------------------------------

async function act(request: Request): Promise<Response> {
  if (bodyTooLarge(request)) return json({ error: 'payload too large' }, 413);
  if (!(await underRateLimit(request, 'username', 20))) {
    return json({ error: 'slow down' }, 429);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'bad json' }, 400);
  }

  const client = typeof body.client === 'string' ? body.client : '';
  const name = sanitiseName(body.name);
  if (!name) return json({ error: 'name required' }, 400);

  // 'check' is the only action that works without identifying yourself; it
  // simply cannot report a name as yours.
  if (body.action !== 'check' && !CLIENT_RE.test(client)) {
    return json({ error: 'bad client' }, 400);
  }

  const raw = await redis<string | null>('HGET', USERNAMES_KEY, name.toLowerCase());
  let record: UsernameRecord | null = null;
  if (raw) {
    try {
      record = JSON.parse(raw) as UsernameRecord;
    } catch {
      record = null;
    }
  }

  if (body.action === 'check') {
    if (!record) return json({ valid: true, available: true, mine: false, name });
    const mine = CLIENT_RE.test(client) && safeEqual(record.owner, client);
    return json({ valid: true, available: mine, mine, name });
  }

  if (body.action === 'code') {
    // Only the owner may read their own code.
    if (!record || !safeEqual(record.owner, client)) return json({ error: 'not your name' }, 403);
    return json({ code: record.code, name: record.display ?? name });
  }

  if (body.action === 'recover') {
    if (!record) return json({ error: 'no such name' }, 404);

    const supplied = normaliseCode(body.code);
    const expected = normaliseCode(record.code);
    if (!supplied || !safeEqual(supplied, expected)) return json({ error: 'wrong code' }, 403);

    // Re-point the name at this browser. The code stays the same, so the
    // player can move again later without having to write down a new one.
    const updated: UsernameRecord = { ...record, owner: client, display: record.display ?? name };
    await redis('HSET', USERNAMES_KEY, name.toLowerCase(), JSON.stringify(updated));
    return json({ recovered: true, name: updated.display });
  }

  return json({ error: 'unknown action' }, 400);
}
