import { dedupPreserve, dedupSorted, normalizeName } from "./name-utils.js";
import type { RewriteRule } from "../domain/models.js";

const PAREN_MAP = new Map<string, number>([
  ["(", 1],
  [")", -1],
  ["[", 1],
  ["]", -1],
  ["【", 1],
  ["】", -1],
  ["〔", 1],
  ["〕", -1],
]);

const NORMAL_SPLIT_SEPARATORS = [
  "ft.",
  "Ft.",
  "feat.",
  "Feat.",
  " + ",
  " ＋ ",
  " x ",
  "×",
  " & ",
  " ＆ ",
  " / ",
  " ／ ",
  " vs. ",
  " vs ",
  "，",
  "、",
  "；",
  ",",
  " | ",
];
const AGGRESSIVE_SYMBOL_SEPARATORS = ["&", "＆", "/", "／", "+", "＋"];

const HIGH_CONFIDENCE_REGEX = [/^\s*vo\.\s*(.+?)\s*$/i];
const LOW_CONFIDENCE_REGEX = [
  /^\s*.+?\s*[\(（]\s*cv\s*[:：]\s*(.+?)\s*[\)）]\s*$/i,
  /^\s*(.+?)\s*[\(（\[【〔]\s*.+?\s*[\)）\]】〕]\s*$/,
];

interface ScoredRule {
  rule: RewriteRule;
  confident: boolean;
}

export interface NameAggregation {
  names: string[];
  splitRules: RewriteRule[];
}

export function knownCircleNames(
  artists: string[],
  albumArtists: string[],
): Set<string> {
  return new Set(
    [...artists, ...albumArtists].map((v) => v.trim()).filter((v) => v.length > 0),
  );
}

export function countNameOccurrences(values: Iterable<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) {
    const key = value.trim();
    if (!key) {
      continue;
    }
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export function dedupRewriteRules(rules: RewriteRule[]): RewriteRule[] {
  const out: RewriteRule[] = [];
  for (const input of rules) {
    const rule: RewriteRule = {
      from: dedupPreserve(input.from),
      to: dedupPreserve(input.to),
    };
    if (rule.from.length === 0 || rule.to.length === 0) {
      continue;
    }
    const existing = out.find((item) => sameNameSet(item.to, rule.to));
    if (existing) {
      existing.from = dedupPreserve([...existing.from, ...rule.from]);
      continue;
    }
    if (out.some((item) => eq(item.from, rule.from) && eq(item.to, rule.to))) {
      continue;
    }
    out.push(rule);
  }
  return out;
}

export function aggregateNamesForTrack(values: string[]): NameAggregation {
  if (values.length === 1) {
    const split = dedupPreserve(splitCandidates(values[0]).filter((v) => v.length > 0));
    const source = values[0].trim();
    const splitRules =
      source && !eq(split, [source]) ? [{ from: [source], to: split }] : [];
    return { names: split, splitRules };
  }
  return {
    names: dedupPreserve(values.map((v) => v.trim()).filter((v) => v.length > 0)),
    splitRules: [],
  };
}

export function generateSplitStageOutput(
  rawNames: string[],
  normalSplitRules: RewriteRule[],
  knownNames: Set<string>,
): [RewriteRule[], string[]] {
  const splitRules = stage1GenerateSplitRules(rawNames, normalSplitRules, knownNames);
  const splitRewrittenNames = rewriteNameValues(rawNames, splitRules);
  return [splitRules, splitRewrittenNames];
}

export function generateCompiledNameRules(
  rawNames: string[],
  splitRules: RewriteRule[],
  splitRewrittenNames: string[],
  splitNameCounts: Record<string, number>,
  maxIter: number,
): RewriteRule[] {
  const normalizeRules = stage2GenerateNormalizeRules(
    splitRewrittenNames,
    splitNameCounts,
  );
  return stage3CompileOnePassRules(normalizeRules, splitRules, rawNames, maxIter);
}

export function splitCandidates(value: string): string[] {
  let chunks = [value];
  for (const separator of NORMAL_SPLIT_SEPARATORS) {
    const next: string[] = [];
    for (const chunk of chunks) {
      next.push(...splitOutsideParensMany(chunk, [separator]));
    }
    chunks = next;
  }
  return chunks.map((v) => v.trim()).filter((v) => v.length > 0);
}

export function rewriteNames(input: string[], rules: RewriteRule[]): string[] {
  if (input.length === 0) {
    return input;
  }
  const out: string[] = [];
  for (const name of input) {
    const match = rules.find((rule) => rule.from.includes(name));
    if (match) {
      out.push(...match.to);
    } else {
      out.push(name);
    }
  }
  return dedupPreserve(out);
}

function rewriteNameValues(values: string[], rules: RewriteRule[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    out.push(...rewriteNames([value], rules));
  }
  return dedupSorted(out);
}

function stage1GenerateSplitRules(
  rawNames: string[],
  normalSplitRules: RewriteRule[],
  knownNames: Set<string>,
): RewriteRule[] {
  const aggressiveRules = buildAggressiveSplitRules(rawNames, knownNames);
  const merged = dedupRewriteRules([...normalSplitRules, ...aggressiveRules]);
  return orderSplitRulesByConfidence(scoreSplitRuleConfidence(merged, knownNames));
}

function stage2GenerateNormalizeRules(
  splitRewrittenNames: string[],
  splitNameCounts: Record<string, number>,
): RewriteRule[] {
  const low = buildRegexCaptureRules(splitRewrittenNames, LOW_CONFIDENCE_REGEX);
  const high = buildRegexCaptureRules(splitRewrittenNames, HIGH_CONFIDENCE_REGEX);
  const simple = buildSimpleNormalizeRules(splitRewrittenNames, splitNameCounts);
  return dedupRewriteRules([...low, ...high, ...simple]);
}

function stage3CompileOnePassRules(
  normalizeRules: RewriteRule[],
  splitRules: RewriteRule[],
  rawNames: string[],
  maxIter: number,
): RewriteRule[] {
  const merged = dedupRewriteRules([...normalizeRules, ...splitRules]);
  const compiled = saturateGeneratedRules(merged, maxIter);
  return retainGeneratedRulesWithReachableMatches(compiled, rawNames, maxIter);
}

function saturateGeneratedRules(rules: RewriteRule[], maxIter: number): RewriteRule[] {
  let out = dedupRewriteRules(rules);
  for (let i = 0; i < maxIter; i += 1) {
    const snapshot = out.map(cloneRule);
    let changed = false;
    out = out.map((rule) => {
      let current = [...rule.to];
      const seen = new Set<string>([JSON.stringify(current)]);
      for (let j = 0; j < maxIter; j += 1) {
        const next = rewriteTokensAndSplit(current, snapshot);
        const hash = JSON.stringify(next);
        if (eq(next, current) || seen.has(hash)) {
          break;
        }
        seen.add(hash);
        current = next;
      }
      if (!eq(current, rule.to)) {
        changed = true;
      }
      return { ...rule, to: current };
    });
    out = dedupRewriteRules(out);
    if (!changed) {
      break;
    }
  }
  return out;
}

function rewriteTokensAndSplit(input: string[], rules: RewriteRule[]): string[] {
  const out: string[] = [];
  for (const name of input) {
    for (const token of splitCandidates(name)) {
      const match = rules.find((rule) => rule.from.includes(token));
      if (match) {
        out.push(...match.to);
      } else {
        out.push(token);
      }
    }
  }
  return dedupPreserve(out);
}

function scoreSplitRuleConfidence(
  rules: RewriteRule[],
  knownNames: Set<string>,
): ScoredRule[] {
  const knownNorm = new Set([...knownNames].map((v) => normalizeName(v)));
  return rules.map((rule) => {
    const fromNorm = new Set(rule.from.map((v) => normalizeName(v)));
    const confident = rule.to.some((to) => {
      const toNorm = normalizeName(to);
      return knownNorm.has(toNorm) && !fromNorm.has(toNorm);
    });
    return { rule, confident };
  });
}

function orderSplitRulesByConfidence(rules: ScoredRule[]): RewriteRule[] {
  return [...rules]
    .sort((a, b) => Number(a.confident) - Number(b.confident))
    .map((item) => item.rule);
}

function buildAggressiveSplitRules(values: string[], known: Set<string>): RewriteRule[] {
  const out: RewriteRule[] = [];
  const knownNorm = new Set([...known].map((value) => normalizeName(value)));
  for (const current of values.map((v) => v.trim()).filter((v) => v.length > 0)) {
    const worklist = [current];
    const finalParts: string[] = [];
    while (worklist.length > 0) {
      const name = worklist.pop() as string;
      let done = false;
      for (const sep of AGGRESSIVE_SYMBOL_SEPARATORS) {
        if (done) {
          break;
        }
        let offset = 0;
        while (true) {
          const split = splitOnceOutsideParens(name, sep, offset);
          if (!split) {
            break;
          }
          const [left, right, nextOffset] = split;
          const leftSeen = knownNorm.has(normalizeName(left));
          const rightSeen = knownNorm.has(normalizeName(right));
          if (leftSeen || rightSeen) {
            done = true;
            for (const part of [left, right]) {
              const partSeen = knownNorm.has(normalizeName(part));
              if (!partSeen && containsAggressiveSeparator(part)) {
                worklist.push(part);
              } else {
                finalParts.push(part);
              }
            }
            break;
          }
          offset = nextOffset;
        }
      }
      if (!done) {
        finalParts.push(name);
      }
    }
    const parts = dedupPreserve(finalParts);
    if (parts.length > 1) {
      out.push({ from: [current], to: parts });
    }
  }
  return out;
}

function splitOnceOutsideParens(
  input: string,
  sep: string,
  offset: number,
): [string, string, number] | undefined {
  let depth = 0;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const delta = PAREN_MAP.get(char);
    if (delta !== undefined) {
      depth = Math.max(0, depth + delta);
      continue;
    }
    if (i >= offset && depth === 0 && input.slice(i).startsWith(sep)) {
      const left = input.slice(0, i).trim();
      const right = input.slice(i + sep.length).trim();
      if (left && right) {
        return [left, right, i + sep.length];
      }
    }
  }
  return undefined;
}

function splitOutsideParensMany(input: string, separators: string[]): string[] {
  const out: string[] = [];
  let depth = 0;
  let buffer = "";
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const delta = PAREN_MAP.get(char);
    if (delta !== undefined) {
      depth = Math.max(0, depth + delta);
      buffer += char;
      continue;
    }
    let matched: string | undefined;
    if (depth === 0) {
      matched = separators.find((sep) => input.slice(i).startsWith(sep));
    }
    if (matched) {
      const part = buffer.trim();
      if (part) {
        out.push(part);
      }
      buffer = "";
      i += matched.length - 1;
      continue;
    }
    buffer += char;
  }
  const tail = buffer.trim();
  if (tail) {
    out.push(tail);
  }
  return out.length === 0 ? [input.trim()] : out;
}

function containsAggressiveSeparator(value: string): boolean {
  return AGGRESSIVE_SYMBOL_SEPARATORS.some((separator) =>
    value.includes(separator),
  );
}

function buildSimpleNormalizeRules(
  values: string[],
  counts: Record<string, number>,
): RewriteRule[] {
  const byNorm = new Map<string, Set<string>>();
  for (const value of values) {
    const norm = normalizeName(value);
    if (!byNorm.has(norm)) {
      byNorm.set(norm, new Set<string>());
    }
    byNorm.get(norm)?.add(value.trim());
  }
  const out: RewriteRule[] = [];
  for (const variantsSet of byNorm.values()) {
    if (variantsSet.size <= 1) {
      continue;
    }
    const variants = [...variantsSet].sort();
    const target = variants
      .slice()
      .sort((a, b) => {
        const ac = counts[a] ?? 0;
        const bc = counts[b] ?? 0;
        return bc - ac || a.localeCompare(b);
      })[0];
    const from = variants.filter((value) => value !== target);
    if (from.length > 0) {
      out.push({ from, to: [target] });
    }
  }
  return out;
}

function buildRegexCaptureRules(values: string[], regexes: RegExp[]): RewriteRule[] {
  const out: RewriteRule[] = [];
  for (const value of values) {
    const source = value.trim();
    if (!source) {
      continue;
    }
    for (const regex of regexes) {
      const match = regex.exec(source);
      if (!match) {
        continue;
      }
      const target = (match[1] ?? "").trim();
      if (target && target !== source) {
        out.push({ from: [source], to: [target] });
      }
      break;
    }
  }
  return out;
}

function retainGeneratedRulesWithReachableMatches(
  rules: RewriteRule[],
  values: string[],
  maxIter: number,
): RewriteRule[] {
  const reachable = new Set(values.map((v) => v.trim()).filter((v) => v.length > 0));
  let frontier = [...reachable];
  for (let i = 0; i < maxIter; i += 1) {
    const nextFrontier: string[] = [];
    for (const name of frontier) {
      const rewritten = rewriteTokensAndSplit([name], rules);
      for (const token of rewritten) {
        if (!reachable.has(token)) {
          reachable.add(token);
          nextFrontier.push(token);
        }
      }
    }
    if (nextFrontier.length === 0) {
      break;
    }
    frontier = nextFrontier;
  }
  return dedupRewriteRules(
    rules.filter((rule) => rule.from.some((from) => reachable.has(from))),
  );
}

function sameNameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sa = [...a].sort();
  const sb = [...b].sort();
  return eq(sa, sb);
}

function cloneRule(rule: RewriteRule): RewriteRule {
  return { from: [...rule.from], to: [...rule.to] };
}

function eq(a: string[], b: string[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
