import { boardKey, configState, isConfigured, json, redis } from './_shared';

export const config = { runtime: 'edge' };

/**
 * Says whether the leaderboard is actually wired up.
 *
 * Exists because "the board looks empty" has two very different causes — a
 * missing environment variable and a genuinely empty month — and from the
 * outside they are indistinguishable. Reports which pieces of configuration
 * are present and whether Redis answers, never any value of any of them.
 */
export default async function handler(): Promise<Response> {
  const present = configState();

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
