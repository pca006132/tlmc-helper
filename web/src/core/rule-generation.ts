import {
  dedupPreserve,
  dedupSorted,
  normalizeNameCjk,
  normalizeNameLight,
} from "./name-utils.js";
import type { RewriteRule } from "../domain/models.js";

const PAREN_MAP = new Map<string, number>([
  ["(", 1],
  [")", -1],
  ["（", 1],
  ["）", -1],
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

const HIGH_CONFIDENCE_REGEX = [/^\s*(?:vo\.?|vocal:?|vocals:?)\s*(.+?)\s*$/i];
const LOW_CONFIDENCE_REGEX_RULES: CaptureRegexRule[] = [
  {
    regex:
      /^\s*(?<role>arr\.?|arrange|arranger|lyr\.?|lyrics?|compose|composer|comp\.?|music|guitar|gt\.?|bass|ba\.?|drums|dr\.?|piano|pf\.?|keyboard|key\.?|mix|mastering|illustration|illust|design)\s*[:：.]?\s*(?<name>.+?)\s*$/i,
    groups: ["name", "role"],
  },
  {
    regex:
      /^\s*(?<role>.+?)\s*[\(（]\s*cv\s*[:：]\s*(?<cv>.+?)\s*[\)）]\s*$/i,
    groups: ["cv", "role"],
  },
  {
    regex:
      /^\s*(?<name>.+?)\s*[\(（\[【〔]\s*(?<affiliation>.+?)\s*[\)）\]】〕]\s*$/,
    groups: ["name", "affiliation"],
  },
];

export class RewriteCycleError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RewriteCycleError";
  }
}

interface ScoredRule {
  rule: RewriteRule;
  confident: boolean;
}

interface CaptureRegexRule {
  regex: RegExp;
  groups: string[];
}

export interface NormalizeContext {
  preload(values: Iterable<string>): void;
  normalize(value: string): string;
}

export interface NameAggregation {
  names: string[];
  splitRules: RewriteRule[];
}

export function knownNamesFromValues(values: string[]): Set<string> {
  return new Set(
    values.map((v) => v.trim()).filter((v) => v.length > 0),
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
  normalize: NormalizeContext = createNormalizeContext(),
): [RewriteRule[], string[]] {
  normalize.preload([...rawNames, ...knownNames]);
  const splitRules = stage1GenerateSplitRules(
    rawNames,
    normalSplitRules,
    knownNames,
    normalize,
  );
  const splitRewrittenNames = rewriteNameValues(rawNames, splitRules);
  return [splitRules, splitRewrittenNames];
}

export function generateCompiledNameRules(
  rawNames: string[],
  splitRules: RewriteRule[],
  splitRewrittenNames: string[],
  splitNameCounts: Record<string, number>,
  knownNames: Set<string>,
  normalize: NormalizeContext = createNormalizeContext(),
): RewriteRule[] {
  normalize.preload([...rawNames, ...splitRewrittenNames, ...knownNames]);
  const normalizeRules = stage2GenerateNormalizeRules(
    splitRewrittenNames,
    splitNameCounts,
    knownNames,
    normalize,
  );
  const saturated = saturateGeneratedRules(dedupRewriteRules([...normalizeRules, ...splitRules]));
  return retainGeneratedRulesWithReachableMatches(
    saturated,
    rawNames,
  );
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
  const lookup = compileRewriteLookup(rules);
  return rewriteNamesWithLookup(input, lookup);
}

export function rewriteNamesWithLookup(
  input: string[],
  lookup: Map<string, string[]>,
): string[] {
  if (input.length === 0) {
    return input;
  }
  return rewriteNamesOnce(dedupPreserve(input), lookup);
}

function rewriteNameValues(values: string[], rules: RewriteRule[]): string[] {
  const out: string[] = [];
  const lookup = compileRewriteLookup(rules);
  for (const value of values) {
    out.push(...rewriteNamesWithLookup([value], lookup));
  }
  return dedupSorted(out);
}

function stage1GenerateSplitRules(
  rawNames: string[],
  normalSplitRules: RewriteRule[],
  knownNames: Set<string>,
  normalize: NormalizeContext,
): RewriteRule[] {
  const aggressiveRules = buildAggressiveSplitRules(rawNames, knownNames, normalize);
  const merged = dedupRewriteRules([...normalSplitRules, ...aggressiveRules]);
  return orderSplitRulesByConfidence(scoreSplitRuleConfidence(merged, knownNames, normalize));
}

function stage2GenerateNormalizeRules(
  splitRewrittenNames: string[],
  splitNameCounts: Record<string, number>,
  knownNames: Set<string>,
  normalize: NormalizeContext,
): RewriteRule[] {
  const low = buildLowConfidenceRegexCaptureRules(
    splitRewrittenNames,
    LOW_CONFIDENCE_REGEX_RULES,
    knownNames,
    normalize,
  );
  const high = buildRegexCaptureRules(splitRewrittenNames, HIGH_CONFIDENCE_REGEX);
  const simple = buildSimpleNormalizeRules(splitRewrittenNames, splitNameCounts, normalize);
  return dedupRewriteRules([...low, ...high, ...simple]);
}

function rewriteTokensAndSplitWithLookup(
  input: string[],
  lookup: Map<string, string[]>,
): string[] {
  const out: string[] = [];
  for (const name of input) {
    for (const token of splitCandidates(name)) {
      out.push(...rewriteNamesWithLookup([token], lookup));
    }
  }
  return dedupPreserve(out);
}

export function compileRewriteLookup(rules: RewriteRule[]): Map<string, string[]> {
  const direct = new Map<string, string[]>();
  for (const rule of rules) {
    for (const from of rule.from) {
      if (!direct.has(from)) {
        direct.set(from, rule.to);
      }
    }
  }
  const lookup = new Map<string, string[]>();
  for (const from of direct.keys()) {
    lookup.set(from, resolveRewriteValue(from, direct, []));
  }
  return lookup;
}

function resolveRewriteValue(
  value: string,
  direct: Map<string, string[]>,
  stack: string[],
): string[] {
  const next = direct.get(value);
  if (!next) {
    return [value];
  }
  if (stack.includes(value)) {
    throw new RewriteCycleError(
      `rewrite cycle while compiling rules: ${[...stack, value].join(" -> ")}`,
    );
  }
  const out: string[] = [];
  for (const item of next) {
    out.push(...resolveRewriteValue(item, direct, [...stack, value]));
  }
  return dedupPreserve(out);
}

function rewriteNamesOnce(input: string[], lookup: Map<string, string[]>): string[] {
  const out: string[] = [];
  for (const name of input) {
    const replacement = lookup.get(name);
    if (replacement) {
      out.push(...replacement);
    } else {
      out.push(name);
    }
  }
  return dedupPreserve(out);
}

function saturateGeneratedRules(rules: RewriteRule[]): RewriteRule[] {
  const snapshot = dedupRewriteRules(rules);
  const lookup = compileRewriteLookup(snapshot);
  return dedupRewriteRules(
    snapshot.map((rule) => ({
      ...rule,
      to: rewriteTokensAndSplitWithLookup(rule.to, lookup),
    })),
  );
}

function scoreSplitRuleConfidence(
  rules: RewriteRule[],
  knownNames: Set<string>,
  normalize: NormalizeContext,
): ScoredRule[] {
  const knownNorm = new Set([...knownNames].map((v) => normalize.normalize(v)));
  return rules.map((rule) => {
    const fromNorm = new Set(rule.from.map((v) => normalize.normalize(v)));
    const confident = rule.to.some((to) => {
      const toNorm = normalize.normalize(to);
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

function buildAggressiveSplitRules(
  values: string[],
  known: Set<string>,
  normalize: NormalizeContext,
): RewriteRule[] {
  const out: RewriteRule[] = [];
  const knownNorm = new Set([...known].map((value) => normalize.normalize(value)));
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
          const leftSeen = knownNorm.has(normalize.normalize(left));
          const rightSeen = knownNorm.has(normalize.normalize(right));
          if (leftSeen || rightSeen) {
            done = true;
            for (const part of [left, right]) {
              const partSeen = knownNorm.has(normalize.normalize(part));
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
  normalize: NormalizeContext,
): RewriteRule[] {
  const byNorm = new Map<string, Set<string>>();
  for (const value of values) {
    const norm = normalize.normalize(value);
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

function buildLowConfidenceRegexCaptureRules(
  values: string[],
  rules: CaptureRegexRule[],
  knownNames: Set<string>,
  normalize: NormalizeContext,
): RewriteRule[] {
  const out: RewriteRule[] = [];
  const knownNorm = new Set([...knownNames].map((name) => normalize.normalize(name)));
  for (const value of values) {
    const source = value.trim();
    if (!source) {
      continue;
    }
    for (const rule of rules) {
      const match = rule.regex.exec(source);
      if (!match?.groups) {
        continue;
      }
      const target = rule.groups
        .flatMap((group, index) => {
          const target = match.groups?.[group]?.trim();
          return target && target !== source
            ? [{ target, groupIndex: index, known: knownNorm.has(normalize.normalize(target)) }]
            : [];
        })
        .sort((a, b) => Number(b.known) - Number(a.known) || a.groupIndex - b.groupIndex)
        .map((candidate) => candidate.target)[0];
      if (target) {
        out.push({ from: [source], to: [target] });
      }
      break;
    }
  }
  return out;
}

export function createNormalizeContext(): NormalizeContext {
  const cjkCache = new Map<string, string>();
  const normalizedCache = new Map<string, string>();
  function cjk(value: string): string {
    const cached = cjkCache.get(value);
    if (cached !== undefined) {
      return cached;
    }
    const converted = normalizeNameCjk(value);
    cjkCache.set(value, converted);
    return converted;
  }
  return {
    preload(values: Iterable<string>): void {
      for (const value of values) {
        cjk(value);
      }
    },
    normalize(value: string): string {
      const cached = normalizedCache.get(value);
      if (cached !== undefined) {
        return cached;
      }
      const normalized = normalizeNameLight(cjk(value));
      normalizedCache.set(value, normalized);
      return normalized;
    },
  };
}

function retainGeneratedRulesWithReachableMatches(
  rules: RewriteRule[],
  values: string[],
): RewriteRule[] {
  const reachable = new Set(values.map((v) => v.trim()).filter((v) => v.length > 0));
  const lookup = compileRewriteLookup(rules);
  let frontier = [...reachable];
  while (frontier.length > 0) {
    const nextFrontier: string[] = [];
    for (const name of frontier) {
      const rewritten = rewriteTokensAndSplitWithLookup([name], lookup);
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

function eq(a: string[], b: string[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
