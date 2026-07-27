import { isConfigured, issueToken, json, underRateLimit } from './_shared';

export const config = { runtime: 'edge' };

/**
 * Opens a run and hands back a token stamped with the server's clock.
 *
 * Called when the player presses Play. The token is what lets the score
 * endpoint later work out how long the run actually took, rather than taking
 * the client's word for it.
 */
export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  if (!isConfigured()) {
    // Not an error: a deployment without a database still serves the game, it
    // just keeps the board local to each player.
    return json({ configured: false });
  }

  if (!(await underRateLimit(request, 'run', 30))) {
    return json({ error: 'slow down' }, 429);
  }

  return json({ configured: true, token: await issueToken() });
}
