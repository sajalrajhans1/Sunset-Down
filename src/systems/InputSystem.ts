import { settings } from '../game/Settings';
import { clamp } from '../utilities/MathUtils';

export type GameAction =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'sprint'
  | 'crouch'
  | 'reload'
  | 'interact'
  | 'inspect'
  | 'pause'
  | 'shop'
  | 'slot1'
  | 'slot2'
  | 'slot3'
  | 'slot4'
  | 'slot5';

/** Physical key → action. Multiple keys may map to the same action. */
const KEY_BINDINGS: Record<string, GameAction> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  // NOTE: Ctrl is deliberately not bound. Crouch + forward would be Ctrl+W,
  // which closes the browser tab, and Ctrl+R (crouch + reload) reloads the
  // page. Neither can be suppressed with preventDefault - they are handled by
  // the browser before the page ever sees them.
  KeyC: 'crouch',
  KeyZ: 'crouch',
  KeyR: 'reload',
  KeyE: 'interact',
  KeyF: 'inspect',
  Escape: 'pause',
  KeyB: 'shop',
  Tab: 'shop',
  Digit1: 'slot1',
  Digit2: 'slot2',
  Digit3: 'slot3',
  Digit4: 'slot4',
  Digit5: 'slot5',
};

/**
 * Keyboard, mouse and pointer-lock handling.
 *
 * Maintains both *held* state (polled by movement) and *pressed-this-frame*
 * edges (consumed by discrete actions like jump or reload), so gameplay code
 * never has to track its own key-up bookkeeping.
 */
export class InputSystem {
  private readonly held = new Set<GameAction>();
  private readonly pressed = new Set<GameAction>();
  private readonly released = new Set<GameAction>();

  /** Accumulated mouse movement since the last frame, in radians. */
  lookDeltaX = 0;
  lookDeltaY = 0;

  firePressed = false;
  fireHeld = false;
  aimHeld = false;
  /** -1 / +1 accumulated wheel notches this frame. */
  wheelDelta = 0;

  private pointerLocked = false;
  private enabled = false;
  private canvas: HTMLElement | null = null;

  private readonly listeners: Array<() => void> = [];
  private onPointerLockChange: ((locked: boolean) => void) | null = null;
  private onPauseRequested: (() => void) | null = null;

  attach(canvas: HTMLElement): void {
    this.canvas = canvas;

    const keyDown = (event: KeyboardEvent): void => {
      // Tab would move focus out of the canvas; Space would scroll the page.
      if (event.code === 'Tab' || event.code === 'Space') event.preventDefault();
      if (event.repeat) return;

      const action = KEY_BINDINGS[event.code];
      if (!action) return;

      if (action === 'pause') {
        this.onPauseRequested?.();
        return;
      }
      if (!this.enabled) return;

      this.held.add(action);
      this.pressed.add(action);
    };

    const keyUp = (event: KeyboardEvent): void => {
      const action = KEY_BINDINGS[event.code];
      if (!action) return;
      this.held.delete(action);
      this.released.add(action);
    };

    const mouseMove = (event: MouseEvent): void => {
      if (!this.pointerLocked || !this.enabled) return;
      // 0.0022 rad per pixel at sensitivity 1.0 is a comfortable baseline that
      // roughly matches a 400 DPI / 1.0 in-game-sens setup in mainstream FPS.
      const sensitivity = settings.current.sensitivity * 0.0022;
      const invert = settings.current.invertY ? -1 : 1;
      // Clamp per-event movement: some drivers emit huge spikes on alt-tab.
      this.lookDeltaX += clamp(event.movementX, -220, 220) * sensitivity;
      this.lookDeltaY += clamp(event.movementY, -220, 220) * sensitivity * invert;
    };

    const mouseDown = (event: MouseEvent): void => {
      if (!this.enabled || !this.pointerLocked) return;
      if (event.button === 0) {
        this.fireHeld = true;
        this.firePressed = true;
      } else if (event.button === 2) {
        this.aimHeld = true;
      }
    };

    const mouseUp = (event: MouseEvent): void => {
      if (event.button === 0) this.fireHeld = false;
      else if (event.button === 2) this.aimHeld = false;
    };

    const wheel = (event: WheelEvent): void => {
      if (!this.enabled || !this.pointerLocked) return;
      event.preventDefault();
      this.wheelDelta += Math.sign(event.deltaY);
    };

    const contextMenu = (event: Event): void => event.preventDefault();

    const pointerLockChange = (): void => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked) {
        // Dropping lock must not leave keys stuck down.
        this.clearHeld();
      }
      this.onPointerLockChange?.(this.pointerLocked);
    };

    const blur = (): void => this.clearHeld();

    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('mousemove', mouseMove);
    window.addEventListener('mousedown', mouseDown);
    window.addEventListener('mouseup', mouseUp);
    window.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('blur', blur);
    document.addEventListener('pointerlockchange', pointerLockChange);
    canvas.addEventListener('contextmenu', contextMenu);

    this.listeners.push(
      () => window.removeEventListener('keydown', keyDown),
      () => window.removeEventListener('keyup', keyUp),
      () => window.removeEventListener('mousemove', mouseMove),
      () => window.removeEventListener('mousedown', mouseDown),
      () => window.removeEventListener('mouseup', mouseUp),
      () => window.removeEventListener('wheel', wheel),
      () => window.removeEventListener('blur', blur),
      () => document.removeEventListener('pointerlockchange', pointerLockChange),
      () => canvas.removeEventListener('contextmenu', contextMenu),
    );
  }

  setPointerLockCallback(callback: (locked: boolean) => void): void {
    this.onPointerLockChange = callback;
  }

  setPauseCallback(callback: () => void): void {
    this.onPauseRequested = callback;
  }

  /** Enables gameplay input. Menus disable it so keys don't leak through. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clearHeld();
  }

  requestPointerLock(): void {
    if (!this.canvas || this.pointerLocked) return;
    const request = this.canvas.requestPointerLock() as unknown;
    // Chrome returns a promise and rejects if called too soon after exiting.
    if (request instanceof Promise) request.catch(() => undefined);
  }

  exitPointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  get isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  isHeld(action: GameAction): boolean {
    return this.held.has(action);
  }

  wasPressed(action: GameAction): boolean {
    return this.pressed.has(action);
  }

  wasReleased(action: GameAction): boolean {
    return this.released.has(action);
  }

  /** Movement input as a normalised vector: x = strafe, y = forward. */
  getMoveVector(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    if (this.isHeld('forward')) y += 1;
    if (this.isHeld('back')) y -= 1;
    if (this.isHeld('right')) x += 1;
    if (this.isHeld('left')) x -= 1;
    const lengthSq = x * x + y * y;
    if (lengthSq > 1) {
      const length = Math.sqrt(lengthSq);
      x /= length;
      y /= length;
    }
    return { x, y };
  }

  /** Clears per-frame edges. Must be called at the end of every update. */
  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.lookDeltaX = 0;
    this.lookDeltaY = 0;
    this.firePressed = false;
    this.wheelDelta = 0;
  }

  private clearHeld(): void {
    this.held.clear();
    this.pressed.clear();
    this.fireHeld = false;
    this.aimHeld = false;
    this.firePressed = false;
  }

  dispose(): void {
    for (const remove of this.listeners) remove();
    this.listeners.length = 0;
    this.clearHeld();
  }
}
