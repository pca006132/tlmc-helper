import type { AnalyzeLogger } from "./logger.js";
import { createPhase2Session, type Phase2Session } from "../phases/phase2-apply.js";
import { buildStructuredFromMetadata, emitStructuredAudits } from "../phases/phase1-structured.js";
import { buildRewritingFromStructured } from "../phases/phase1-rewriting.js";
import { runUpdateStage } from "../phases/phase3-updates.js";
import { parseTrackPath } from "./path-parse.js";
import type {
  AlbumStructured,
  DiscStructured,
  MetadataMap,
  RewritingData,
  RewriteRule,
  StructuredData,
  UpdateMap,
} from "../domain/models.js";

const REWRITE_TARGETS = [
  "artists rewriting",
  "album artists rewriting",
  "genre rewriting",
] as const;

export interface Phase1Input {
  metadata: MetadataMap;
  existingStructured?: StructuredData;
  existingRewriting?: RewritingData;
}

export interface Phase1Result {
  structured: StructuredData;
  rewriting: RewritingData;
  structuredRebuilt: boolean;
}

export interface Phase3Input {
  metadata: MetadataMap;
  structured: StructuredData;
  rewriting: RewritingData;
}

export interface Phase3Result {
  updates: UpdateMap;
}

export interface RewritingRefreshInput {
  structured: StructuredData;
  existingRewriting: RewritingData;
}

export function runPhase1(input: Phase1Input, logger: AnalyzeLogger): Phase1Result {
  if (input.existingRewriting) {
    validateRewriteCycles(input.existingRewriting);
  }
  let structured = input.existingStructured;
  let structuredRebuilt = false;
  if (!structured) {
    const built = buildStructuredFromMetadata(input.metadata);
    emitStructuredAudits(built.audits, logger);
    structured = built.structured;
    structuredRebuilt = true;
  } else {
    structured = mergeNewMetadataTracks(structured, input.metadata);
  }

  const rewriting = buildRewritingFromStructured(structured, input.existingRewriting);
  validateRewriteCycles(rewriting);
  return {
    structured,
    rewriting,
    structuredRebuilt,
  };
}

export function refreshRewriting(
  input: RewritingRefreshInput,
  _logger: AnalyzeLogger,
): RewritingData {
  validateRewriteCycles(input.existingRewriting);
  const rewriting = buildRewritingFromStructured(
    input.structured,
    input.existingRewriting,
  );
  validateRewriteCycles(rewriting);
  return rewriting;
}

export function createInteractivePhase2(
  phase1: Pick<Phase1Result, "structured" | "rewriting">,
  logger: AnalyzeLogger,
): Phase2Session {
  return createPhase2Session(phase1.structured, phase1.rewriting, logger);
}

export function runPhase3(input: Phase3Input, _logger: AnalyzeLogger): Phase3Result {
  const updates = runUpdateStage(input.metadata, input.structured, input.rewriting);
  return { updates };
}

function validateRewriteCycles(rewriting: RewritingData): void {
  const all = rewriting.$all;
  if (all) {
    for (const target of REWRITE_TARGETS) {
      checkRuleCycle("$all", target, all[target]);
    }
  }
  for (const [circle, data] of Object.entries(rewriting)) {
    if (circle === "$all") {
      continue;
    }
    for (const target of REWRITE_TARGETS) {
      checkRuleCycle(circle, target, chainRules(data[target], all?.[target]));
    }
  }
}

function chainRules(primary: RewriteRule[], global: RewriteRule[] | undefined): RewriteRule[] {
  return [...primary, ...(global ?? [])];
}

function checkRuleCycle(
  circle: string,
  ruleSet: string,
  rules: { from: string[]; to: string[] }[],
): void {
  const graph = new Map<string, Set<string>>();
  const edgeRules = new Map<string, number>();
  const seenFrom = new Set<string>();
  for (const [ruleIndex, rule] of rules.entries()) {
    const fromValues = rule.from.filter((value) => value.trim().length > 0);
    const toValues = rule.to.filter((value) => value.trim().length > 0);
    if (fromValues.length === 0 || toValues.length === 0) {
      continue;
    }
    for (const from of fromValues) {
      if (seenFrom.has(from)) {
        continue;
      }
      seenFrom.add(from);
      const edges = graph.get(from) ?? new Set<string>();
      graph.set(from, edges);
      for (const to of toValues) {
        if (to !== from) {
          edges.add(to);
          edgeRules.set(edgeKey(from, to), ruleIndex);
        }
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  function visit(node: string): void {
    if (visiting.has(node)) {
      const start = path.indexOf(node);
      const cycle = [...path.slice(start), node].join(" -> ");
      const ruleIndexes = cycleRuleIndexes(path.slice(start), node, edgeRules);
      const location = formatRewritePath(circle, ruleSet);
      throw new Error(
        `rewrite cycle at ${location} rules=${JSON.stringify(ruleIndexes)}: ${cycle}`,
      );
    }
    if (visited.has(node)) {
      return;
    }
    visiting.add(node);
    path.push(node);
    for (const next of graph.get(node) ?? []) {
      visit(next);
    }
    path.pop();
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) {
    visit(node);
  }
}

function formatRewritePath(circle: string, ruleSet: string): string {
  return `$[${JSON.stringify(circle)}][${JSON.stringify(ruleSet)}]`;
}

function cycleRuleIndexes(
  cyclePath: string[],
  closingNode: string,
  edgeRules: Map<string, number>,
): number[] {
  const nodes = [...cyclePath, closingNode];
  const out: number[] = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const index = edgeRules.get(edgeKey(nodes[i], nodes[i + 1]));
    if (index !== undefined && !out.includes(index)) {
      out.push(index);
    }
  }
  return out;
}

function edgeKey(from: string, to: string): string {
  return `${JSON.stringify(from)}=>${JSON.stringify(to)}`;
}

function mergeNewMetadataTracks(
  existing: StructuredData,
  metadata: MetadataMap,
): StructuredData {
  const existingPaths = collectStructuredTrackPaths(existing);
  const missingPaths = Object.keys(metadata).filter((trackPath) => !existingPaths.has(trackPath));
  if (missingPaths.length === 0) {
    return existing;
  }

  const missingMetadata = Object.fromEntries(
    missingPaths.map((trackPath) => [trackPath, metadata[trackPath]]),
  );
  const fresh = buildStructuredFromMetadata(missingMetadata).structured;
  const out = structuredClone(existing);
  const albumNameByPathIdentity = indexAlbumNamesByPathIdentity(out);

  for (const [circleName, freshCircle] of Object.entries(fresh)) {
    const outCircle = (out[circleName] ??= { albums: {} });
    for (const [freshAlbumName, freshAlbum] of Object.entries(freshCircle.albums)) {
      const targetAlbumName =
        findAlbumNameForFreshAlbum(albumNameByPathIdentity, freshAlbum) ?? freshAlbumName;

      if (!outCircle.albums[targetAlbumName]) {
        outCircle.albums[targetAlbumName] = structuredClone(freshAlbum);
        indexFreshAlbum(albumNameByPathIdentity, targetAlbumName, freshAlbum);
        continue;
      }

      mergeAlbumArtists(outCircle.albums[targetAlbumName], freshAlbum["album artists"]);
      for (const [discIndex, freshDisc] of freshAlbum.discs.entries()) {
        const targetDisc = ensureDisc(outCircle.albums[targetAlbumName], discIndex, freshDisc);
        for (const [trackPath, track] of Object.entries(freshDisc.tracks)) {
          if (!existingPaths.has(trackPath)) {
            targetDisc.tracks[trackPath] = structuredClone(track);
            existingPaths.add(trackPath);
          }
        }
      }
    }
  }

  return out;
}

function collectStructuredTrackPaths(structured: StructuredData): Set<string> {
  const out = new Set<string>();
  for (const circle of Object.values(structured)) {
    for (const album of Object.values(circle.albums)) {
      for (const disc of album.discs) {
        for (const trackPath of Object.keys(disc.tracks)) {
          out.add(trackPath);
        }
      }
    }
  }
  return out;
}

function indexAlbumNamesByPathIdentity(structured: StructuredData): Map<string, string> {
  const out = new Map<string, string>();
  for (const circle of Object.values(structured)) {
    for (const [albumName, album] of Object.entries(circle.albums)) {
      indexFreshAlbum(out, albumName, album);
    }
  }
  return out;
}

function indexFreshAlbum(
  index: Map<string, string>,
  albumName: string,
  album: AlbumStructured,
): void {
  for (const disc of album.discs) {
    for (const trackPath of Object.keys(disc.tracks)) {
      const identity = pathIdentity(trackPath);
      if (identity && !index.has(identity)) {
        index.set(identity, albumName);
      }
    }
  }
}

function findAlbumNameForFreshAlbum(
  index: Map<string, string>,
  album: AlbumStructured,
): string | undefined {
  for (const disc of album.discs) {
    for (const trackPath of Object.keys(disc.tracks)) {
      const identity = pathIdentity(trackPath);
      if (identity && index.has(identity)) {
        return index.get(identity);
      }
    }
  }
  return undefined;
}

function pathIdentity(trackPath: string): string | undefined {
  try {
    const parsed = parseTrackPath(trackPath);
    return `${parsed.circle}\0${parsed.album}`;
  } catch {
    return undefined;
  }
}

function mergeAlbumArtists(album: AlbumStructured, artists: string[]): void {
  const seen = new Set(album["album artists"]);
  for (const artist of artists) {
    if (!seen.has(artist)) {
      seen.add(artist);
      album["album artists"].push(artist);
    }
  }
}

function ensureDisc(
  album: AlbumStructured,
  discIndex: number,
  freshDisc: DiscStructured,
): DiscStructured {
  while (album.discs.length <= discIndex) {
    album.discs.push({ tracks: {} });
  }
  const targetDisc = album.discs[discIndex];
  if (!targetDisc.$subtitle && freshDisc.$subtitle) {
    targetDisc.$subtitle = freshDisc.$subtitle;
  }
  if (
    targetDisc["$track numbers from order"] === undefined &&
    freshDisc["$track numbers from order"] !== undefined
  ) {
    targetDisc["$track numbers from order"] = freshDisc["$track numbers from order"];
  }
  return targetDisc;
}
