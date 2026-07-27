import {
  BOARD_SIZE,
  BOARD_TTL,
  boardKey,
  boardLabel,
  consumeToken,
  countryOf,
  isConfigured,
  json,
  redis,
  underRateLimit,
  validateClaim,
  verifyToken,
} from './_shared';

export const config = { runtime: 'edge' };

/** One row on the board, as stored and as sent to the client. */
interface Entry {
  id: string;
  name: string;
  country: string;
  wave: number;
  kills: number;
  time: number;
  at: number;
}

/**
 * Packs a run into a single sortable number.
 *
 * Redis sorted sets rank by one value, and the board is ordered by wave first
 * with kills breaking ties. Wave tops out at 250 and kills are clamped below
 * the multiplier, so the two can never bleed into each other.
 */
const rankOf = (wave: number, kills: number): number =>
  wave * 1_000_000 + Math.min(kills, 999_999);

export default async function handler(request: Request): Promise<Response> {
  if (!isConfigured()) return json({ configured: false, entries: [], month: boardLabel() });

  try {
    if (request.method === 'GET') return await readBoard();
    if (request.method === 'POST') return await submit(request);
    return json({ error: 'method not allowed' }, 405);
  } catch (error) {
    // A leaderboard outage must never look like a broken game.
    return json({ configured: true, entries: [], month: boardLabel(), error: String(error) }, 200);
  }
}

// ---------------------------------------------------------------------------

async function readBoard(): Promise<Response> {
  const key = boardKey();
  const raw = await redis<string[]>('ZRANGE', key, 0, BOARD_SIZE - 1, 'REV');

  const entries: Entry[] = [];
  for (const member of raw ?? []) {
    try {
      entries.push(JSON.parse(member) as Entry);
    } catch {
      // A malformed member should cost one row, not the whole board.
    }
  }

  return json({ configured: true, month: boardLabel(), entries });
}

async function submit(request: Request): Promise<Response> {
  if (!(await underRateLimit(request, 'score', 10))) {
    return json({ error: 'slow down' }, 429);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }

  const token = await verifyToken((body as { token?: unknown }).token);
  if (!token.ok || !token.nonce) return json({ error: token.reason ?? 'bad token' }, 400);

  const check = validateClaim(body, token.ageSeconds ?? 0);
  if (!check.ok || !check.claim) return json({ error: check.reason ?? 'rejected' }, 400);

  // One token, one score. Burning the nonce before writing means a retry storm
  // cannot land the same run twice.
  if (!(await consumeToken(token.nonce))) {
    return json({ error: 'run already submitted' }, 409);
  }

  const { name, wave, kills, timeSurvived } = check.claim;
  const key = boardKey();
  const bestKey = `${key}:best`;
  // Case-insensitive, so one person cannot fill the board with "Sam", "SAM"…
  const nameKey = name.toLowerCase();
  const score = rankOf(wave, kills);

  // Keep only each name's best run for the month. Without this a single player
  // grinding twenty runs would push everyone else off a hundred-row board.
  const previousRaw = await redis<string | null>('HGET', bestKey, nameKey);
  if (previousRaw) {
    try {
      const previous = JSON.parse(previousRaw) as Entry;
      if (rankOf(previous.wave, previous.kills) >= score) {
        return json({ configured: true, recorded: false, reason: 'not a personal best' });
      }
      await redis('ZREM', key, previousRaw);
    } catch {
      // Unparseable history is simply replaced.
    }
  }

  const entry: Entry = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    country: countryOf(request),
    wave,
    kills,
    time: Math.round(timeSurvived),
    at: Date.now(),
  };
  const member = JSON.stringify(entry);

  await redis('ZADD', key, score, member);
  await redis('HSET', bestKey, nameKey, member);
  // Trim to the top N, then refresh both keys' lifetimes together.
  await redis('ZREMRANGEBYRANK', key, 0, -(BOARD_SIZE + 1));
  await redis('EXPIRE', key, BOARD_TTL);
  await redis('EXPIRE', bestKey, BOARD_TTL);

  const rank = await redis<number | null>('ZREVRANK', key, member);

  return json({
    configured: true,
    recorded: true,
    rank: typeof rank === 'number' ? rank + 1 : null,
    entry,
  });
}
