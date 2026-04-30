export function foldFullwidthAscii(input: string): string {
  let out = "";
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x3000) {
      out += " ";
    } else if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCodePoint(code - 0xfee0);
    } else {
      out += char;
    }
  }
  return out;
}

export function normalizeName(value: string): string {
  return foldFullwidthAscii(value)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/['“”]/g, '"');
}

export function dedupPreserve(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

export function dedupSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
