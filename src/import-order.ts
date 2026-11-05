import { object, type SpineDocument } from './document.js';
import { constraintList } from './constraint-data.js';

// Object.keys reorders integer-looking JSON member names. Preserve the editor's
// actual serialized order so names such as "2" and "10" also bind correctly.
export function animationOrderFromJson(text: string): string[] {
  const root = object(JSON.parse(text), 'Spine JSON');
  if (root.animations === undefined) return [];
  object(root.animations, 'animations');
  let offset = 0;
  const whitespace = () => { while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++; };
  const string = (): string => {
    whitespace(); const start = offset;
    if (text[offset++] !== '"') throw new Error('Expected a JSON member name.');
    while (offset < text.length) {
      const character = text[offset++]!;
      if (character === '\\') offset++;
      else if (character === '"') return JSON.parse(text.slice(start, offset)) as string;
    }
    throw new Error('Unterminated JSON string.');
  };
  const skipValue = () => {
    whitespace();
    if (text[offset] === '"') { string(); return; }
    if (text[offset] === '{' || text[offset] === '[') {
      const stack = [text[offset++] === '{' ? '}' : ']'];
      while (stack.length && offset < text.length) {
        const character = text[offset]!;
        if (character === '"') { string(); continue; }
        offset++;
        if (character === '{' || character === '[') stack.push(character === '{' ? '}' : ']');
        else if (character === '}' || character === ']') { if (stack.pop() !== character) throw new Error('Mismatched JSON structure.'); }
        if (stack.length > 512) throw new Error('JSON nesting exceeds the import-order limit.');
      }
      if (stack.length) throw new Error('Incomplete JSON structure.');
    } else while (offset < text.length && !/[,}\]\s]/.test(text[offset]!)) offset++;
  };
  const members = () => {
    whitespace(); if (text[offset++] !== '{') throw new Error('Expected a JSON object.');
    const result: { name: string; start: number }[] = [];
    whitespace();
    while (offset < text.length && text[offset] !== '}') {
      const name = string(); whitespace(); if (text[offset++] !== ':') throw new Error('Expected a JSON colon.');
      whitespace(); result.push({ name, start: offset }); skipValue(); whitespace();
      if (text[offset] === ',') { offset++; whitespace(); } else break;
    }
    if (text[offset++] !== '}') throw new Error('Expected a JSON object end.');
    return result;
  };
  const fields = members().filter(field => field.name === 'animations');
  if (fields.length !== 1) throw new Error('Ambiguous animations member in CLI JSON.');
  offset = fields[0]!.start;
  const names = members().map(member => member.name);
  if (new Set(names).size !== names.length) throw new Error('Duplicate animation names in CLI JSON.');
  return names;
}

export function serializeImportJson(data: SpineDocument, order?: string[]): string {
  if (!order) return JSON.stringify(data);
  const animations = data.animations ?? {}, names = Object.keys(animations);
  if (order.length !== names.length || new Set(order).size !== names.length || names.some(name => !order.includes(name))) throw new Error('CLI animation identities changed while preparing import.');
  const { animations: _animations, ...rest } = data, body = JSON.stringify(rest).slice(1, -1);
  return '{' + body + ',"animations":{' + order.map(name => `${JSON.stringify(name)}:${JSON.stringify(animations[name])}`).join(',') + '}}';
}

export function verifySliderBindings(expected: SpineDocument, actual: SpineDocument) {
  const sliders = constraintList(expected).filter(item => item.type === 'slider');
  for (const slider of sliders) {
    const found = constraintList(actual).find(item => item.type === 'slider' && item.name === slider.name);
    if (!found || found.animation !== slider.animation) throw new Error(`Slider binding verification failed: ${String(slider.name)} expected ${String(slider.animation)}, received ${String(found?.animation)}. No project was published.`);
  }
  return { checked: sliders.length, passed: true };
}
