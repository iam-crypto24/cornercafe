export function hasControlCharacters(value, { allowFormattingWhitespace = false } = {}) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === 0x7f) return true;
    if (code < 0x20 && !(allowFormattingWhitespace && [0x09, 0x0a, 0x0d].includes(code))) return true;
  }
  return false;
}
