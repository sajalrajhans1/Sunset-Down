import { boardKey, configState, isConfigured, json, redis, underRateLimit } from './_shared';

export const config = { runtime: 'edge' };

/**
 * Says whether the leaderboard is actually wired up.
 *
 * Exists because "the board looks empty" has two very different causes — a
 * missing environment variable and a genuinely empty month — and from the
 * outside they are indistinguishable. Reports which pieces of configuration
 * are present and whether Redis answers, never any value of any of them.
 */
export default async function handler(request: Request): Promise<Response> {
  const present = configState();

  // This endpoint queries Redis, and the database it queries has a request
  // quota. Left open it is a free way for anyone to spend that quota, so it
  // gets the same treatment as everything else that talks to storage.
  if (isConfigured() && !(await underRateLimit(request, 'health', 12))) {
    return json({ error: 'slow down' }, 429);
  }

  if (!isConfigured()) {
    return json({
      ok: false,
      configured: false,
      present,
      hint: 'Set the missing variables in Vercel, then redeploy.',
    });
  }

  try {
    const key = boardKey();
    const size = await redis<number>('ZCARD', key);
    return json({ ok: true, configured: true, present, board: key, entries: size ?? 0 });
  } catch (error) {
    return json({
      ok: false,
      configured: true,
      present,
      error: String(error),
      hint: 'Credentials are set but Redis refused the connection.',
    });
  }
}
