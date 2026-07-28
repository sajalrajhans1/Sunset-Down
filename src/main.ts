import './ui/styles.css';
import { detectUnsupportedDevice, hasBypass, showUnsupportedScreen } from './game/DeviceSupport';
import type { Game as GameType } from './game/Game';

/**
 * Entry point.
 *
 * Checks the device can actually play, verifies WebGL support, boots the game,
 * and installs a last-resort error screen so a failure never leaves the player
 * looking at a black rectangle.
 *
 * The engine is pulled in with a dynamic import rather than a static one, so a
 * phone that gets turned away never downloads Three.js or any of the art. Vite
 * emits a modulepreload hint for it, so desktop start-up is unaffected.
 */

/**
 * Last-resort error screen.
 *
 * Built out of nodes with textContent rather than an interpolated HTML string.
 * The detail line carries an exception message, which is engine-originated
 * today but is exactly the sort of value that quietly grows to include a URL
 * or a server response later - and an innerHTML sink is the wrong place to
 * discover that.
 */
function showFatalError(title: string, detail: string): void {
  const root = document.getElementById('ui-root');
  if (!root) return;

  const make = (tag: string, className: string, text?: string): HTMLElement => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const heading = make('h2', 'sh-panel__title', title);
  const subtitle = make('p', 'sh-panel__subtitle', 'Sunset Hollow could not start.');
  const body = make('p', '', detail);
  body.style.lineHeight = '1.6';
  body.style.color = 'var(--sh-text-dim)';

  const header = make('div', 'sh-modal__header');
  const headerInner = make('div', '');
  headerInner.append(heading, subtitle);
  header.append(headerInner);

  const modalBody = make('div', 'sh-modal__body');
  modalBody.append(body);

  const modal = make('div', 'sh-panel sh-modal');
  modal.style.maxWidth = '520px';
  modal.append(header, modalBody);

  const overlay = make('div', 'sh-overlay');
  overlay.append(modal);

  root.replaceChildren(overlay);
}

function hasWebGL2(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!canvas.getContext('webgl2');
  } catch {
    return false;
  }
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  const uiRoot = document.getElementById('ui-root');

  if (!canvas || !uiRoot) {
    showFatalError('Missing page elements', 'The game canvas could not be found in the document.');
    return;
  }

  const unsupported = hasBypass() ? null : detectUnsupportedDevice();
  if (unsupported) {
    canvas.remove();
    showUnsupportedScreen(uiRoot, unsupported);
    return;
  }

  if (!hasWebGL2()) {
    showFatalError(
      'WebGL 2 unavailable',
      'This game needs WebGL 2. Try a recent version of Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is enabled in your browser settings.',
    );
    return;
  }

  let game: GameType;
  try {
    const { Game } = await import('./game/Game');
    game = new Game(canvas);
    await game.init(uiRoot);
  } catch (error) {
    console.error('[Sunset Hollow] Startup failed:', error);
    showFatalError(
      'Something went wrong',
      `The game failed to start. ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  // Dev-only handle for inspecting live game state from the console.
  // Stripped from production builds by the bundler's dead-code elimination.
  if (import.meta.env.DEV) {
    (window as unknown as { game: GameType }).game = game;
  }

  // Release GPU resources cleanly on navigation away.
  window.addEventListener('pagehide', () => game.dispose(), { once: true });

  // Surface unexpected runtime errors instead of failing silently.
  window.addEventListener('error', (event) => {
    console.error('[Sunset Hollow] Runtime error:', event.error ?? event.message);
  });
}

void boot();
