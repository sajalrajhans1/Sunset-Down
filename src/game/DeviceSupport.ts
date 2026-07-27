/**
 * Device gating.
 *
 * Sunset Hollow is built around pointer lock, WASD and a mouse. There is no
 * touch control scheme, so a phone or tablet cannot play it at all — better to
 * say so plainly than to let someone load a megabyte of engine and then find
 * they cannot move.
 *
 * The detection is deliberately conservative in one direction: a touchscreen
 * laptop must never be mistaken for a tablet. Locking out someone who *can*
 * play is a worse failure than letting a determined phone user through, so the
 * pointer heuristic only fires when the device has no fine pointer at all.
 */

export type UnsupportedKind = 'phone' | 'tablet' | 'touch';

/**
 * Returns the kind of unsupported device, or null when the game should run.
 *
 * Deliberately reads the *screen* rather than the window: a desktop user with a
 * narrow browser window is still a desktop user.
 */
export function detectUnsupportedDevice(): UnsupportedKind | null {
  const ua = navigator.userAgent;

  // iPadOS 13+ identifies itself as macOS. Multiple touch points on a "Mac"
  // is the standard way to tell an iPad from a real one.
  const nav = navigator as Navigator & { platform?: string };
  if (nav.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return 'tablet';

  if (/iPhone|iPod/.test(ua)) return 'phone';
  // Android puts "Mobile" in the token for phones and omits it for tablets.
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'phone' : 'tablet';
  if (/iPad|Tablet|PlayBook|Silk|Kindle/.test(ua)) return 'tablet';

  // Catch-all for devices the user-agent doesn't name. A device whose only
  // pointer is coarse has no mouse or trackpad — a touchscreen laptop still
  // reports a fine pointer here and correctly passes.
  const coarseOnly =
    matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  if (coarseOnly) return 'touch';

  return null;
}

const COPY: Record<UnsupportedKind, { device: string; line: string }> = {
  phone: {
    device: 'phones',
    line: 'Sunset Hollow is a mouse-and-keyboard game — aiming, sprinting and leaning on a touchscreen just does not work yet.',
  },
  tablet: {
    device: 'tablets',
    line: 'Sunset Hollow is a mouse-and-keyboard game — aiming, sprinting and leaning on a touchscreen just does not work yet.',
  },
  touch: {
    device: 'touch-only devices',
    line: 'Sunset Hollow needs a mouse to aim and a keyboard to move, and this device does not appear to have either.',
  },
};

/**
 * Renders the "come back on a computer" screen.
 *
 * Self-contained styling: this path must stay light, because the whole point is
 * that a blocked device never downloads the engine.
 */
export function showUnsupportedScreen(root: HTMLElement, kind: UnsupportedKind): void {
  const copy = COPY[kind];

  root.innerHTML = `
    <div class="sh-unsupported">
      <div class="sh-unsupported__card">
        <div class="sh-unsupported__glyph" aria-hidden="true">🧟</div>
        <h1 class="sh-unsupported__title">Not on ${copy.device} yet</h1>
        <p class="sh-unsupported__body">${copy.line}</p>
        <p class="sh-unsupported__body sh-unsupported__body--muted">
          Open this page on a laptop or desktop and the village will be waiting.
        </p>
        <div class="sh-unsupported__mark">Sunset Hollow</div>
        <button type="button" class="sh-unsupported__anyway">I'm on a computer — let me in</button>
      </div>
    </div>`;

  // Safety valve. If the heuristic ever misjudges an unusual laptop, the player
  // is one tap from playing anyway rather than permanently locked out.
  const anyway = root.querySelector<HTMLButtonElement>('.sh-unsupported__anyway');
  anyway?.addEventListener('click', () => {
    try {
      sessionStorage.setItem(BYPASS_KEY, '1');
    } catch {
      // Private browsing can refuse storage; the reload below still works.
    }
    location.reload();
  });
}

const BYPASS_KEY = 'sh-force-desktop';

/** True once the player has explicitly overridden the device check. */
export function hasBypass(): boolean {
  try {
    return sessionStorage.getItem(BYPASS_KEY) === '1';
  } catch {
    return false;
  }
}
