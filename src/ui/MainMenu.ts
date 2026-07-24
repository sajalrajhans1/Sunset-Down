import { button, el } from './dom';
import { SettingsPanel } from './SettingsPanel';
import { audio } from '../audio/AudioManager';
import { settings } from '../game/Settings';
import type { PersistentRecords } from '../systems/EconomySystem';
import { randRange } from '../utilities/MathUtils';

// Bundled and content-hashed by Vite, so the URL is correct under any base path.
import menuBackground from '../assets/menu-background.webp';

export interface MainMenuCallbacks {
  onPlay: () => void;
  onQuit: () => void;
}

/**
 * Main menu.
 *
 * The cinematic backdrop is the one authored image in the whole project; every
 * other element on this screen — light shafts, floating motes, the animated
 * gradient logo — is CSS, layered on top to give the still image parallax and
 * life without a video file.
 */
export class MainMenu {
  readonly root: HTMLElement;
  readonly settingsPanel = new SettingsPanel();

  private readonly recordsRow: HTMLElement;
  private readonly creditsOverlay: HTMLElement;
  private moteContainer: HTMLElement;

  constructor(private readonly callbacks: MainMenuCallbacks) {
    this.recordsRow = el('div', { className: 'sh-menu__records' });
    this.moteContainer = el('div', { className: 'sh-menu__particles', attrs: { 'aria-hidden': 'true' } });
    this.creditsOverlay = this.buildCredits();

    this.root = el('div', {
      className: 'sh-screen sh-menu',
      children: [
        el('div', {
          className: 'sh-menu__backdrop',
          style: { backgroundImage: `url(${menuBackground})` },
          attrs: { 'aria-hidden': 'true' },
        }),
        el('div', { className: 'sh-menu__rays', attrs: { 'aria-hidden': 'true' } }),
        this.moteContainer,
        el('div', { className: 'sh-menu__vignette', attrs: { 'aria-hidden': 'true' } }),
        this.buildContent(),
        el('div', { className: 'sh-menu__footer', text: 'Built with Three.js · WebGL · Web Audio' }),
        this.creditsOverlay,
        this.settingsPanel.root,
      ],
    });

    this.spawnMotes(26);
  }

  private buildContent(): HTMLElement {
    return el('div', {
      className: 'sh-menu__content',
      children: [
        el('div', {
          className: 'sh-logo',
          children: [
            el('span', { className: 'sh-logo__eyebrow', text: 'Wave Survival' }),
            el('h1', {
              className: 'sh-logo__title',
              children: [el('span', { text: 'Sunset' }), el('span', { text: 'Hollow' })],
            }),
            el('p', {
              className: 'sh-logo__tagline',
              text: 'The fair came to town. So did something else. Hold the square until sundown — and try to keep the bunting intact.',
            }),
          ],
        }),

        el('div', {
          className: 'sh-menu__actions',
          children: [
            button({
              label: 'Play',
              variant: 'primary',
              icon: '▶',
              onClick: () => this.callbacks.onPlay(),
            }),
            button({
              label: 'Settings',
              icon: '⚙️',
              onClick: () => this.settingsPanel.open(),
            }),
            button({
              label: 'Credits',
              icon: '📜',
              onClick: () => this.openCredits(),
            }),
            button({
              label: 'Exit',
              icon: '🚪',
              onClick: () => this.callbacks.onQuit(),
            }),
          ],
        }),

        this.recordsRow,
      ],
    });
  }

  /** Drifting embers layered over the backdrop. */
  private spawnMotes(count: number): void {
    if (settings.current.reducedMotion) return;
    for (let i = 0; i < count; i++) {
      const size = randRange(2, 7);
      const mote = el('span', {
        className: 'sh-mote',
        style: {
          left: `${randRange(0, 100)}%`,
          width: `${size}px`,
          height: `${size}px`,
          animationDuration: `${randRange(11, 26)}s`,
          animationDelay: `${randRange(-24, 0)}s`,
          opacity: String(randRange(0.35, 0.95)),
        },
      });
      mote.style.setProperty('--sh-drift', `${randRange(-140, 140)}px`);
      this.moteContainer.appendChild(mote);
    }
  }

  private buildCredits(): HTMLElement {
    const overlay = el('div', {
      className: 'sh-overlay sh-screen--hidden',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Credits' },
      children: [
        el('div', {
          className: 'sh-panel sh-modal',
          children: [
            el('div', {
              className: 'sh-modal__header',
              children: [
                el('div', {
                  children: [
                    el('h2', { className: 'sh-panel__title', text: 'Credits' }),
                    el('p', { className: 'sh-panel__subtitle', text: 'How this was put together.' }),
                  ],
                }),
              ],
            }),
            el('div', {
              className: 'sh-modal__body sh-credits',
              children: [
                el('h3', { className: 'sh-section-title', text: 'Controls' }),
                el('dl', {
                  className: 'sh-keylist',
                  children: [
                    el('dt', { children: [kbd('W'), kbd('A'), kbd('S'), kbd('D')] }),
                    el('dd', { text: 'Move' }),
                    el('dt', { children: [kbd('Shift')] }),
                    el('dd', { text: 'Sprint' }),
                    el('dt', { children: [kbd('Space')] }),
                    el('dd', { text: 'Jump' }),
                    el('dt', { children: [kbd('Ctrl')] }),
                    el('dd', { text: 'Crouch' }),
                    el('dt', { children: [kbd('LMB')] }),
                    el('dd', { text: 'Fire' }),
                    el('dt', { children: [kbd('RMB')] }),
                    el('dd', { text: 'Aim down sights' }),
                    el('dt', { children: [kbd('R')] }),
                    el('dd', { text: 'Reload' }),
                    el('dt', { children: [kbd('1'), kbd('–'), kbd('5')] }),
                    el('dd', { text: 'Switch weapon (or scroll wheel)' }),
                    el('dt', { children: [kbd('B')] }),
                    el('dd', { text: 'Open the shop' }),
                    el('dt', { children: [kbd('F')] }),
                    el('dd', { text: 'Inspect weapon' }),
                    el('dt', { children: [kbd('Esc')] }),
                    el('dd', { text: 'Pause' }),
                  ],
                }),

                el('h3', { className: 'sh-section-title', text: 'Technology' }),
                el('p', {
                  html:
                    'Rendering with <strong>Three.js</strong> and WebGL 2. Written in <strong>TypeScript</strong>, bundled by <strong>Vite</strong>. ' +
                    'Runs entirely in the browser — no server, no install, no downloads after first load.',
                }),

                el('h3', { className: 'sh-section-title', text: 'Art' }),
                el('p', {
                  html:
                    'Every texture, material, weapon, zombie and building in the 3D world is <strong>generated procedurally at runtime</strong> ' +
                    'from canvas drawing and primitive geometry. The menu backdrop is the single authored image in the project.',
                }),

                el('h3', { className: 'sh-section-title', text: 'Audio' }),
                el('p', {
                  html:
                    'There are no audio files. Gunshots, footsteps, zombie voices, UI clicks and the adaptive soundtrack are all ' +
                    '<strong>synthesised live with the Web Audio API</strong> — which is why the music reharmonises as waves get more dangerous.',
                }),

                el('h3', { className: 'sh-section-title', text: 'Performance notes' }),
                el('p', {
                  html:
                    'Static geometry is batched per material and map district, zombies and particles are pooled, navigation uses a single shared ' +
                    'flow field, and shadow casting is budgeted to the nearest few zombies. Use the graphics preset in Settings to trade fidelity for framerate.',
                }),
              ],
            }),
            el('div', {
              className: 'sh-modal__footer',
              children: [button({ label: 'Back', variant: 'primary', onClick: () => this.closeCredits() })],
            }),
          ],
        }),
      ],
    });

    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) this.closeCredits();
    });

    return overlay;
  }

  private openCredits(): void {
    this.creditsOverlay.classList.remove('sh-screen--hidden');
  }

  private closeCredits(): void {
    audio.sfx.uiBack();
    this.creditsOverlay.classList.add('sh-screen--hidden');
  }

  /** Refreshes the personal-best row shown under the buttons. */
  setRecords(records: PersistentRecords): void {
    while (this.recordsRow.firstChild) this.recordsRow.removeChild(this.recordsRow.firstChild);
    if (records.runsPlayed === 0) return;

    const entries: [string, string][] = [
      [String(records.bestWave), 'Best wave'],
      [records.bestKills.toLocaleString('en-US'), 'Most kills'],
      [records.runsPlayed.toLocaleString('en-US'), 'Runs played'],
    ];

    for (const [value, label] of entries) {
      this.recordsRow.appendChild(
        el('div', {
          className: 'sh-record',
          children: [
            el('span', { className: 'sh-record__value', text: value }),
            el('span', { className: 'sh-record__label', text: label }),
          ],
        }),
      );
    }
  }

  /** True if any modal on this screen is currently open. */
  get hasOpenModal(): boolean {
    return this.settingsPanel.isOpen || !this.creditsOverlay.classList.contains('sh-screen--hidden');
  }

  closeModals(): void {
    if (this.settingsPanel.isOpen) this.settingsPanel.close();
    else if (!this.creditsOverlay.classList.contains('sh-screen--hidden')) this.closeCredits();
  }

  show(): void {
    this.root.classList.remove('sh-screen--hidden');
  }

  hide(): void {
    this.root.classList.add('sh-screen--hidden');
  }
}

function kbd(label: string): HTMLElement {
  return el('span', { className: 'sh-key', text: label });
}
