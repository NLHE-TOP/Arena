/**
 * Minimal safe DOM helpers.
 *
 * Every string is assigned with `textContent`; this module never uses
 * `innerHTML`, so untrusted values (room names, wallet addresses, agent model
 * metadata, chat bodies, replay payloads) can never become markup.
 */

export type Child = Node | string | null | undefined | false;

type EventHandler = (event: Event) => void;

export interface ElementOptions {
  className?: string;
  text?: string;
  id?: string;
  title?: string;
  hidden?: boolean;
  disabled?: boolean;
  dataset?: Record<string, string>;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: Record<string, EventHandler>;
}

/** Create an element and attach options/children without ever parsing HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: Child[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className !== undefined) node.className = options.className;
  if (options.id !== undefined) node.id = options.id;
  if (options.title !== undefined) node.title = options.title;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.hidden !== undefined) node.hidden = options.hidden;
  if (options.disabled !== undefined) {
    (node as HTMLElement & { disabled?: boolean }).disabled = options.disabled;
  }
  if (options.dataset) {
    for (const [key, value] of Object.entries(options.dataset)) node.dataset[key] = value;
  }
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  if (options.on) {
    for (const [event, handler] of Object.entries(options.on)) {
      node.addEventListener(event, handler);
    }
  }
  append(node, children);
  return node;
}

/** Append children (strings become text nodes). */
export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

/** Remove every child without parsing HTML. */
export function clear(node: Element): void {
  node.replaceChildren();
}

/** Look up a required element by id (throws on a wiring mistake). */
export function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required element #${id}`);
  return node as T;
}

/** Set text safely (null/undefined become an empty string). */
export function setText(node: Element, text: string | number | null | undefined): void {
  node.textContent = text === null || text === undefined ? '' : String(text);
}

/** Show/hide an element via the `hidden` attribute. */
export function setHidden(node: HTMLElement, hidden: boolean): void {
  node.hidden = hidden;
}

type FormControl = HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Enable/disable a form control. */
export function setDisabled(node: FormControl, disabled: boolean): void {
  node.disabled = disabled;
}

/** A small status chip. */
export function chip(text: string, kind = ''): HTMLSpanElement {
  return el('span', { className: `chip${kind ? ` ${kind}` : ''}`, text });
}

/** A `<dt>/<dd>` pair appended to a description list. */
export function metaRow(list: HTMLElement, label: string, value: string | number | Node): void {
  list.appendChild(el('dt', { text: label }));
  const dd = el('dd');
  if (typeof value === 'string' || typeof value === 'number') setText(dd, value);
  else dd.appendChild(value);
  list.appendChild(dd);
}

/** A `<label class="field">` wrapping a control. */
export function field(label: string, control: HTMLElement): HTMLLabelElement {
  return el('label', { className: 'field' }, [el('span', { text: label }), control]);
}

/** An `<option>` element. */
export function option(value: string, label: string, disabled = false): HTMLOptionElement {
  const node = el('option', { text: label });
  node.value = value;
  node.disabled = disabled;
  return node;
}
