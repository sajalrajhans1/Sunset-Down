import { button, el, segmented, slider, toggle } from './dom';
import { leaderboard } from '../systems/Leaderboard';
import { settings, type GraphicsPreset } from '../game/Settings';
import { audio } from '../audio/AudioManager';

/**
 * The settings modal. Shared by the main menu and the pause screen so there is
 * exactly one place where an option can be added.
 *
 * Every control writes straight through to the settings store, which notifies
 * the renderer, audio engine and world — so changes are audible and visible
 * immediately rather than on close.
 */
export class SettingsPanel {
  readonly root: HTMLElement;
  private onClose: (() => void) | null = null;

  constructor() {
    this.root = el('div', {
      // --top because settings is the one modal that opens *on top of another
      // modal — the pause screen. Every overlay otherwise sits at the same
      // stacking level, so whichever happens to be later in the DOM wins, and
      // the pause screen is appended after this one.
      className: 'sh-overlay sh-overlay--top sh-screen--hidden',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' },
    });
    this.build();
  }

  private build(): void {
    const current = settings.current;

    const percent = (value: number): string => `${Math.round(value * 100)}%`;

    const audioSection = el('div', {
      children: [
        el('h3', { className: 'sh-section-title', text: 'Audio' }),
        slider({
          label: 'Music volume',
          min: 0,
          max: 1,
          step: 0.01,
          value: current.musicVolume,
          format: percent,
          onChange: (value) => settings.set('musicVolume', value),
        }),
        slider({
          label: 'Sound effects volume',
          min: 0,
          max: 1,
          step: 0.01,
          value: current.sfxVolume,
          format: percent,
          onChange: (value) => settings.set('sfxVolume', value),
        }),
      ],
    });

    const controlsSection = el('div', {
      children: [
        el('h3', { className: 'sh-section-title', text: 'Controls' }),
        slider({
          label: 'Mouse sensitivity',
          min: 0.15,
          max: 3,
          step: 0.05,
          value: current.sensitivity,
          format: (value) => value.toFixed(2),
          onChange: (value) => settings.set('sensitivity', value),
        }),
        slider({
          label: 'Field of view',
          min: 60,
          max: 110,
          step: 1,
          value: current.fov,
          format: (value) => `${Math.round(value)}°`,
          onChange: (value) => settings.set('fov', value),
        }),
        toggle({
          label: 'Invert vertical look',
          value: current.invertY,
          onChange: (value) => settings.set('invertY', value),
        }),
        slider({
          label: 'Screen shake',
          min: 0,
          max: 1.5,
          step: 0.05,
          value: current.screenShake,
          format: percent,
          onChange: (value) => settings.set('screenShake', value),
        }),
      ],
    });

    const graphicsSection = el('div', {
      children: [
        el('h3', { className: 'sh-section-title', text: 'Graphics' }),
        segmented<GraphicsPreset>({
          label: 'Quality preset',
          value: current.graphics,
          options: [
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'ultra', label: 'Ultra' },
          ],
          onChange: (value) => settings.set('graphics', value),
        }),
        toggle({
          label: 'Shadows',
          description: 'Soft sun shadows. The biggest single cost.',
          value: current.shadows,
          onChange: (value) => settings.set('shadows', value),
        }),
        toggle({
          label: 'Bloom',
          description: 'Glow around lights and the setting sun.',
          value: current.bloom,
          onChange: (value) => settings.set('bloom', value),
        }),
        toggle({
          label: 'Motion blur',
          description: 'Radial smear while turning and sprinting.',
          value: current.motionBlur,
          onChange: (value) => settings.set('motionBlur', value),
        }),
        toggle({
          label: 'Fullscreen',
          value: !!document.fullscreenElement,
          onChange: (value) => {
            // Fullscreen must be requested from a user gesture; the toggle is
            // one, so this is safe. Failures are non-fatal.
            if (value) void document.documentElement.requestFullscreen?.().catch(() => undefined);
            else void document.exitFullscreen?.().catch(() => undefined);
          },
        }),
      ],
    });

    const interfaceSection = el('div', {
      children: [
        el('h3', { className: 'sh-section-title', text: 'Interface & accessibility' }),
        toggle({
          label: 'FPS counter',
          value: current.showFps,
          onChange: (value) => settings.set('showFps', value),
        }),
        toggle({
          label: 'Floating damage numbers',
          value: current.damageNumbers,
          onChange: (value) => settings.set('damageNumbers', value),
        }),
        toggle({
          label: 'Reduced motion',
          description: 'Calms camera bob, shake and menu animation.',
          value: current.reducedMotion,
          onChange: (value) => {
            settings.set('reducedMotion', value);
            document.documentElement.dataset.reducedMotion = String(value);
          },
        }),
        toggle({
          label: 'High contrast interface',
          description: 'Solid panels and brighter text.',
          value: current.highContrastUi,
          onChange: (value) => {
            settings.set('highContrastUi', value);
            document.documentElement.dataset.contrast = value ? 'high' : 'normal';
          },
        }),
      ],
    });

    const modal = el('div', {
      className: 'sh-panel sh-modal',
      children: [
        el('div', {
          className: 'sh-modal__header',
          children: [
            el('div', {
              children: [
                el('h2', { className: 'sh-panel__title', text: 'Settings' }),
                el('p', { className: 'sh-panel__subtitle', text: 'Changes apply instantly and are saved automatically.' }),
              ],
            }),
          ],
        }),
        el('div', {
          className: 'sh-modal__body',
          children: [
            audioSection,
            controlsSection,
            graphicsSection,
            interfaceSection,
            this.buildIdentitySection(),
          ],
        }),
        el('div', {
          className: 'sh-modal__footer',
          children: [
            button({
              label: 'Reset to defaults',
              variant: 'ghost',
              onClick: () => {
                settings.reset();
                this.rebuild();
              },
            }),
            button({
              label: 'Done',
              variant: 'primary',
              onClick: () => this.close(),
            }),
          ],
        }),
      ],
    });

    this.root.appendChild(modal);

    // Click-outside and Escape both dismiss.
    this.root.addEventListener('pointerdown', (event) => {
      if (event.target === this.root) this.close();
    });
  }

  /**
   * Your name on the leaderboard, and how to keep it.
   *
   * A username is held by the browser that claimed it, which is fine until the
   * player clears their site data or sits down at a different machine - at
   * which point, without this, their name is gone and owned by a browser they
   * no longer have. The code is the way back. It lives here rather than being
   * forced on them at claim time, because a "write this down" dialog after
   * every first run is friction most players would ignore anyway.
   */
  private buildIdentitySection(): HTMLElement {
    const name = leaderboard.savedName;

    const codeValue = el('code', {
      className: 'sh-identity__code',
      text: name ? 'Show code' : '—',
    });

    const revealButton = button({
      label: 'Show',
      variant: 'ghost',
      onClick: async () => {
        if (!name) return;
        codeValue.textContent = 'Checking…';
        const code = await leaderboard.recoveryCode(name);
        codeValue.textContent = code ?? 'Unavailable';
      },
    });

    const restoreName = el('input', {
      className: 'sh-submit__input',
      attrs: { type: 'text', placeholder: 'Username', autocomplete: 'off', spellcheck: 'false' },
    }) as HTMLInputElement;

    const restoreCode = el('input', {
      className: 'sh-submit__input',
      attrs: { type: 'text', placeholder: 'Code', autocomplete: 'off', spellcheck: 'false' },
    }) as HTMLInputElement;

    const restoreStatus = el('p', { className: 'sh-submit__status' });

    const restoreButton = button({
      label: 'Restore',
      onClick: async () => {
        const result = await leaderboard.recoverUsername(restoreName.value, restoreCode.value);
        if (result.ok) {
          restoreStatus.textContent = `Welcome back, ${result.name}.`;
          restoreStatus.className = 'sh-submit__status is-success';
        } else {
          restoreStatus.textContent =
            result.reason === 'wrong code'
              ? 'That code does not match.'
              : result.reason === 'no such name'
                ? 'No one has claimed that name.'
                : 'Could not restore that name.';
          restoreStatus.className = 'sh-submit__status is-error';
        }
      },
    });

    return el('div', {
      children: [
        el('h3', { className: 'sh-section-title', text: 'Leaderboard name' }),
        el('div', {
          className: 'sh-identity',
          children: [
            el('div', {
              className: 'sh-identity__row',
              children: [
                el('span', { className: 'sh-identity__label', text: 'Your name' }),
                el('strong', { className: 'sh-identity__name', text: name || 'Not set yet' }),
              ],
            }),
            el('div', {
              className: 'sh-identity__row',
              children: [
                el('span', { className: 'sh-identity__label', text: 'Recovery code' }),
                el('span', {
                  className: 'sh-identity__code-row',
                  children: [codeValue, revealButton],
                }),
              ],
            }),
            el('p', {
              className: 'sh-identity__hint',
              text: name
                ? 'Keep this somewhere safe. It moves your name to another computer, or back after clearing your browser data.'
                : 'Finish a run and put a name on the board to claim one.',
            }),
            el('div', {
              className: 'sh-identity__restore',
              children: [
                el('span', { className: 'sh-identity__label', text: 'Moving from another computer?' }),
                el('div', {
                  className: 'sh-identity__restore-row',
                  children: [restoreName, restoreCode, restoreButton],
                }),
                restoreStatus,
              ],
            }),
          ],
        }),
      ],
    });
  }

  /** Rebuilds the controls so they reflect externally-changed values. */
  private rebuild(): void {
    audio.sfx.uiBack();
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
    this.build();
    document.documentElement.dataset.reducedMotion = String(settings.current.reducedMotion);
    document.documentElement.dataset.contrast = settings.current.highContrastUi ? 'high' : 'normal';
  }

  open(onClose?: () => void): void {
    this.onClose = onClose ?? null;
    this.root.classList.remove('sh-screen--hidden');
    // Focus the first control for keyboard users.
    (this.root.querySelector('input, button') as HTMLElement | null)?.focus();
  }

  close(): void {
    audio.sfx.uiBack();
    this.root.classList.add('sh-screen--hidden');
    this.onClose?.();
    this.onClose = null;
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('sh-screen--hidden');
  }
}
