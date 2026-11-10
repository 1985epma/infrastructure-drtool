// Pequenos construtores de campos de formulário.
import { h } from './dom.js';

let seq = 0;

export function field(label, input, hint) {
  const id = `f${++seq}`;
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
}

export const textInput = (value = '', props = {}) => h('input', { type: 'text', value, autocomplete: 'off', spellcheck: 'false', ...props });
export const numInput = (value, { min, max, step } = {}) => h('input', { type: 'number', value: value ?? '', min, max, step });
export const textArea = (value = '', props = {}) => h('textarea', { value, ...props });

export function selectInput(options, value) {
  return h('select', { value }, ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}

export function checkField(label, checked, hint) {
  const id = `f${++seq}`;
  const input = h('input', { type: 'checkbox', id, checked: Boolean(checked) });
  return { input, el: h('div', { class: 'field check' }, input, h('label', { for: id }, label), hint ? h('span', { class: 'hint' }, hint) : null) };
}

/** Texto de erro de validação vindo da API. */
export function apiErrorText(err) {
  return err.details?.length ? `${err.message}:\n• ${err.details.join('\n• ')}` : err.message;
}
