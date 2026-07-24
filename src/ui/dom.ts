import { audio } from '../audio/AudioManager';

/**
 * Minimal DOM construction helpers.
 *
 * The UI is plain DOM rather than a framework: it's a handful of screens that
 * change rarely, and avoiding a virtual DOM keeps the HUD's per-frame updates
 * down to direct textContent writes with zero diffing overhead.
 */

type EventMap = {
  [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void;
};

export interface ElementOptions {
  className?: string;
  text?: string;
  html?: string;
  attrs?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
  children?: (Node | null | undefined | false)[];
  on?: EventMap;
  dataset?: Record<string, string>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.html !== undefined) node.innerHTML = options.html;

  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) node.setAttribute(key, value);
  }
  if (options.dataset) {
    for (const [key, value] of Object.entries(options.dataset)) node.dataset[key] = value;
  }
  if (options.style) Object.assign(node.style, options.style);

  if (options.children) {
    for (const child of options.children) {
      if (child) node.appendChild(child);
    }
  }
  if (options.on) {
    for (const [event, handler] of Object.entries(options.on)) {
      node.addEventListener(event, handler as EventListener);
    }
  }
  return node;
}

export interface ButtonOptions {
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  icon?: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}

/** Themed button with hover/click audio and keyboard-accessible semantics. */
export function button(options: ButtonOptions): HTMLButtonElement {
  const variant = options.variant ?? 'secondary';
  const node = el('button', {
    className: `sh-button sh-button--${variant}${options.className ? ` ${options.className}` : ''}`,
    attrs: { type: 'button' },
    children: [
      options.icon ? el('span', { className: 'sh-button__icon', text: options.icon, attrs: { 'aria-hidden': 'true' } }) : null,
      el('span', { className: 'sh-button__label', text: options.label }),
      options.hint ? el('span', { className: 'sh-button__hint', text: options.hint }) : null,
    ],
    on: {
      // pointerenter rather than mouseenter so the sound also fires for pens.
      pointerenter: () => {
        if (!node.disabled) audio.sfx.uiHover();
      },
      click: () => {
        if (node.disabled) return;
        audio.sfx.uiClick();
        options.onClick();
      },
    },
  });

  // A subtle shine follows the cursor across the button face.
  node.addEventListener('pointermove', (event) => {
    const rect = node.getBoundingClientRect();
    node.style.setProperty('--sh-mx', `${((event.clientX - rect.left) / rect.width) * 100}%`);
    node.style.setProperty('--sh-my', `${((event.clientY - rect.top) / rect.height) * 100}%`);
  });

  if (options.disabled) node.disabled = true;
  return node;
}

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** Formats the numeric readout, e.g. as a percentage. */
  format?: (value: number) => string;
  onChange: (value: number) => void;
}

export function slider(options: SliderOptions): HTMLElement {
  const format = options.format ?? ((v: number) => v.toFixed(2));
  const readout = el('span', { className: 'sh-field__value', text: format(options.value) });

  const input = el('input', {
    className: 'sh-slider',
    attrs: {
      type: 'range',
      min: String(options.min),
      max: String(options.max),
      step: String(options.step),
      value: String(options.value),
      'aria-label': options.label,
    },
  });

  const updateFill = (): void => {
    const value = Number(input.value);
    const percent = ((value - options.min) / (options.max - options.min)) * 100;
    input.style.setProperty('--sh-fill', `${percent}%`);
  };
  updateFill();

  input.addEventListener('input', () => {
    const value = Number(input.value);
    readout.textContent = format(value);
    updateFill();
    options.onChange(value);
  });
  // One click sound on release, not on every pixel of the drag.
  input.addEventListener('change', () => audio.sfx.uiClick());

  return el('div', {
    className: 'sh-field',
    children: [
      el('div', {
        className: 'sh-field__header',
        children: [el('label', { className: 'sh-field__label', text: options.label }), readout],
      }),
      input,
    ],
  });
}

export interface ToggleOptions {
  label: string;
  description?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}

export function toggle(options: ToggleOptions): HTMLElement {
  const input = el('input', {
    className: 'sh-toggle__input',
    attrs: { type: 'checkbox', 'aria-label': options.label },
  });
  input.checked = options.value;
  input.addEventListener('change', () => {
    audio.sfx.uiClick();
    options.onChange(input.checked);
  });

  return el('label', {
    className: 'sh-field sh-field--toggle',
    children: [
      el('div', {
        className: 'sh-field__header',
        children: [
          el('span', {
            className: 'sh-field__label',
            children: [
              document.createTextNode(options.label),
              options.description
                ? el('span', { className: 'sh-field__description', text: options.description })
                : null,
            ].filter(Boolean) as Node[],
          }),
          el('span', {
            className: 'sh-toggle',
            children: [input, el('span', { className: 'sh-toggle__track', children: [el('span', { className: 'sh-toggle__thumb' })] })],
          }),
        ],
      }),
    ],
    on: { pointerenter: () => audio.sfx.uiHover() },
  });
}

export interface SegmentedOptions<T extends string> {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}

/** Segmented control — used for the graphics preset picker. */
export function segmented<T extends string>(config: SegmentedOptions<T>): HTMLElement {
  const buttons: HTMLButtonElement[] = [];

  const select = (value: T): void => {
    for (const node of buttons) {
      node.classList.toggle('is-active', node.dataset.value === value);
      node.setAttribute('aria-pressed', String(node.dataset.value === value));
    }
  };

  const group = el('div', {
    className: 'sh-segmented',
    attrs: { role: 'group', 'aria-label': config.label },
    children: config.options.map((option) => {
      const node = el('button', {
        className: 'sh-segmented__option',
        text: option.label,
        attrs: { type: 'button', 'aria-pressed': String(option.value === config.value) },
        dataset: { value: option.value },
        on: {
          pointerenter: () => audio.sfx.uiHover(),
          click: () => {
            audio.sfx.uiClick();
            select(option.value);
            config.onChange(option.value);
          },
        },
      });
      buttons.push(node);
      return node;
    }),
  });

  select(config.value);

  return el('div', {
    className: 'sh-field',
    children: [
      el('div', {
        className: 'sh-field__header',
        children: [el('span', { className: 'sh-field__label', text: config.label })],
      }),
      group,
    ],
  });
}

export function clearChildren(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Formats a number with thin-space grouping, e.g. 12 480. */
export function formatCoins(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}
