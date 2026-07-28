import {
  BOARD_SIZE,
  BOARD_TTL,
  bodyTooLarge,
  boardKey,
  makeRecoveryCode,
  USERNAMES_KEY,
  type UsernameRecord,
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
  if (bodyTooLarge(request)) return json({ error: 'payload too large' }, 413);

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
  const playerKey = `${key}:player`;
  const score = rankOf(wave, kills);
  const nameKey = name.toLowerCase();

  /**
   * One name, one row. One player, one row.
   *
   * Both halves matter and neither alone is enough. Keying on the name alone
   * lets a player who renames leave a ghost entry behind; keying on the
   * browser alone lets the same person hold two rows under the same name,
   * which is what happened when this endpoint changed its mind about which of
   * the two was the identity.
   *
   * So rather than trusting bookkeeping to have been correct, the board itself
   * is the source of truth: read it, drop anything that is this player or this
   * name, then insert. That makes the invariant self-healing - rows left over
   * from an older scheme are cleaned up the first time their owner plays
   * again, with no migration to run.
   *
   * The consequence, deliberately: two different people who both call
   * themselves "Sam" share one row, and the better run holds it. That is what
   * one-name-one-entry means, and the loser is told to pick another name.
   */
  const rawClient = (body as { client?: unknown }).client;
  const clientId =
    typeof rawClient === 'string' && /^[a-f0-9]{32}$/.test(rawClient) ? rawClient : null;

  /**
   * A name belongs to whoever claimed it first.
   *
   * This is what makes the board's names mean something: nobody else can post
   * under yours, so a stranger can no longer take your row by out-scoring you,
   * and you can no longer be shown twice. Claiming happens here rather than in
   * a separate reservation step, so a name can only be taken by someone who
   * has actually finished a run - which also means it cannot be squatted from
   * a script without playing the game first.
   */
  if (clientId) {
    const ownerRaw = await redis<string | null>('HGET', USERNAMES_KEY, nameKey);
    let owner: UsernameRecord | null = null;
    if (ownerRaw) {
      try {
        owner = JSON.parse(ownerRaw) as UsernameRecord;
      } catch {
        // A corrupt record should not permanently burn the name.
        owner = null;
      }
    }

    if (owner && owner.owner !== clientId) {
      return json({ configured: true, recorded: false, reason: 'name taken' });
    }

    if (!owner) {
      const record: UsernameRecord = {
        owner: clientId,
        code: makeRecoveryCode(),
        display: name,
        at: Date.now(),
      };
      await redis('HSET', USERNAMES_KEY, nameKey, JSON.stringify(record));
    }
  }

  // The name this player last held, so a rename does not orphan their old row.
  const previousName = clientId
    ? await redis<string | null>('HGET', playerKey, clientId)
    : null;

  const board = (await redis<string[]>('ZRANGE', key, 0, BOARD_SIZE - 1, 'REV')) ?? [];

  let bestExisting: { member: string; score: number } | null = null;
  const stale: string[] = [];

  for (const member of board) {
    let parsed: Entry;
    try {
      parsed = JSON.parse(member) as Entry;
    } catch {
      continue;
    }
    const owned = parsed.name.toLowerCase();
    if (owned !== nameKey && owned !== previousName) continue;

    stale.push(member);
    const existing = rankOf(parsed.wave, parsed.kills);
    // Only a row under the *same* name blocks a weaker submission. A row under
    // the player's old name is being retired regardless.
    if (owned === nameKey && (!bestExisting || existing > bestExisting.score)) {
      bestExisting = { member, score: existing };
    }
  }

  if (bestExisting && bestExisting.score >= score) {
    // The run does not beat what this name already holds, so the existing row
    // stays. Any *other* rows under it are still collapsed away: a board that
    // is showing one person twice should be tidied up the next time they play,
    // whether or not that particular run happened to be their best.
    for (const member of stale) {
      if (member !== bestExisting.member) await redis('ZREM', key, member);
    }
    if (clientId) await redis('HSET', playerKey, clientId, nameKey);
    return json({ configured: true, recorded: false, reason: 'not a personal best' });
  }

  for (const member of stale) await redis('ZREM', key, member);

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
  if (clientId) await redis('HSET', playerKey, clientId, nameKey);
  // Trim to the top N, then refresh both keys' lifetimes together.
  await redis('ZREMRANGEBYRANK', key, 0, -(BOARD_SIZE + 1));
  await redis('EXPIRE', key, BOARD_TTL);
  await redis('EXPIRE', playerKey, BOARD_TTL);

  const rank = await redis<number | null>('ZREVRANK', key, member);

  return json({
    configured: true,
    recorded: true,
    rank: typeof rank === 'number' ? rank + 1 : null,
    entry,
  });
}
