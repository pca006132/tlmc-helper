import type { AnalyzeLogger } from "./logger.js";
import { createPhase2Session, type Phase2Session } from "../phases/phase2-apply.js";
import { buildStructuredFromMetadata, emitStructuredAudits } from "../phases/phase1-structured.js";
import { buildRewritingFromStructured } from "../phases/phase1-rewriting.js";
import { runUpdateStage } from "../phases/phase3-updates.js";
import type {
  MetadataMap,
  RewritingData,
  StructuredData,
  UpdateMap,
} from "../domain/models.js";

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

export function runPhase1(input: Phase1Input, logger: AnalyzeLogger): Phase1Result {
  let structured = input.existingStructured;
  let structuredRebuilt = false;
  if (!structured) {
    const built = buildStructuredFromMetadata(input.metadata);
    emitStructuredAudits(built.audits, logger);
    structured = built.structured;
    structuredRebuilt = true;
  }

  const rewriting = buildRewritingFromStructured(structured, input.existingRewriting);
  validateRewriteChains(rewriting, logger);
  return {
    structured,
    rewriting,
    structuredRebuilt,
  };
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

function validateRewriteChains(rewriting: RewritingData, logger: AnalyzeLogger): void {
  for (const [circle, data] of Object.entries(rewriting)) {
    checkRuleChain(circle, "artists_rewriting", data["artists rewriting"], logger);
    checkRuleChain(
      circle,
      "album_artists_rewriting",
      data["album artists rewriting"],
      logger,
    );
    checkRuleChain(circle, "genre_rewriting", data["genre rewriting"], logger);
  }
}

function checkRuleChain(
  circle: string,
  ruleSet: string,
  rules: { from: string[]; to: string[] }[],
  logger: AnalyzeLogger,
): void {
  const seen = new Set<string>();
  for (const [i, left] of rules.entries()) {
    for (const [j, right] of rules.entries()) {
      if (i === j) {
        continue;
      }
      const overlaps = left.to.filter(
        (value) => right.from.includes(value) && !left.from.includes(value),
      );
      if (overlaps.length === 0) {
        continue;
      }
      const line = `circle=${circle} set=${ruleSet} rule_a=${JSON.stringify(left)} rule_b=${JSON.stringify(right)}`;
      if (!seen.has(line)) {
        seen.add(line);
        logger.log({
          level: "audit",
          code: "rewrite_chain_warning",
          message: line,
        });
      }
    }
  }
}
