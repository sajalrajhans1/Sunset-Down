import './ui/styles.css';
import { Game } from './game/Game';

/**
 * Entry point.
 *
 * Verifies WebGL support, boots the game, and installs a last-resort error
 * screen so a failure never leaves the player looking at a black rectangle.
 */

function showFatalError(title: string, detail: string): void {
  const root = document.getElementById('ui-root');
  if (!root) return;
  root.innerHTML = `
    <div class="sh-overlay">
      <div class="sh-panel sh-modal" style="max-width:520px">
        <div class="sh-modal__header">
          <div>
            <h2 class="sh-panel__title">${title}</h2>
            <p class="sh-panel__subtitle">Sunset Hollow could not start.</p>
          </div>
        </div>
        <div class="sh-modal__body">
          <p style="line-height:1.6;color:var(--sh-text-dim)">${detail}</p>
        </div>
      </div>
    </div>`;
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

  if (!hasWebGL2()) {
    showFatalError(
      'WebGL 2 unavailable',
      'This game needs WebGL 2. Try a recent version of Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is enabled in your browser settings.',
    );
    return;
  }

  const game = new Game(canvas);

  try {
    await game.init(uiRoot);
  } catch (error) {
    console.error('[Sunset Hollow] Startup failed:', error);
    showFatalError(
      'Something went wrong',
      `The game failed to start. ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  // Release GPU resources cleanly on navigation away.
  window.addEventListener('pagehide', () => game.dispose(), { once: true });

  // Surface unexpected runtime errors instead of failing silently.
  window.addEventListener('error', (event) => {
    console.error('[Sunset Hollow] Runtime error:', event.error ?? event.message);
  });
}

void boot();
