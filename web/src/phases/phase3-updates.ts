import { compileRewriteLookup } from "../core/rule-generation.js";
import type {
  MetadataMap,
  MetadataTrack,
  RewritingData,
  StructuredData,
  UpdateMap,
} from "../domain/models.js";
import {
  applyRewritesToStructured,
  chainRulesWithGlobal,
} from "./phase1-rewriting.js";

export function runUpdateStage(
  metadata: MetadataMap,
  structuredData: StructuredData,
  rewritingData: RewritingData,
): UpdateMap {
  const structured = structuredClone(structuredData);
  applyRewritesToStructured(structured, rewritingData);
  applyGenreRewritesToStructured(structured, rewritingData);
  const desired = materializeMetadataFromStructured(structured, metadata);
  const auditedTrackPaths = collectAuditedTrackPaths(structured, rewritingData);
  const updates: UpdateMap = {};
  for (const [trackPath, desiredFields] of Object.entries(desired)) {
    if (!auditedTrackPaths.has(trackPath)) {
      continue;
    }
    const originalFields = metadata[trackPath];
    if (!originalFields) {
      continue;
    }
    const patch = diffTrackMetadata(originalFields, desiredFields);
    if (Object.keys(patch).length > 0) {
      updates[trackPath] = patch;
    }
  }
  return updates;
}

function collectAuditedTrackPaths(
  structured: StructuredData,
  rewriting: RewritingData,
): Set<string> {
  const out = new Set<string>();
  for (const [circleName, circleData] of Object.entries(structured)) {
    if (rewriting[circleName]?.audited !== true) {
      continue;
    }
    for (const album of Object.values(circleData.albums)) {
      for (const disc of album.discs) {
        for (const trackPath of Object.keys(disc.tracks)) {
          out.add(trackPath);
        }
      }
    }
  }
  return out;
}

function applyGenreRewritesToStructured(
  structured: StructuredData,
  rewriting: RewritingData,
): void {
  const allRewriting = rewriting.$all;
  for (const [circleName, circle] of Object.entries(structured)) {
    const circleRules = rewriting[circleName];
    if (!circleRules) {
      continue;
    }
    const genreRules = chainRulesWithGlobal(
      circleRules["genre rewriting"],
      allRewriting?.["genre rewriting"],
    );
    const genreLookup = compileRewriteLookup(genreRules);
    for (const album of Object.values(circle.albums)) {
      for (const disc of album.discs) {
        for (const track of Object.values(disc.tracks)) {
          const initial =
            track.genre ?? circleRules["default genre"] ?? allRewriting?.["default genre"];
          if (initial) {
            track.genre = genreLookup.get(initial)?.[0] ?? initial;
          }
        }
      }
    }
  }
}

export function materializeMetadataFromStructured(
  structured: StructuredData,
  basis: MetadataMap,
): MetadataMap {
  const out: MetadataMap = {};
  for (const circleData of Object.values(structured)) {
    for (const [albumTitle, albumData] of Object.entries(circleData.albums)) {
      const totalDiscs = albumData.discs.length;
      for (const [discIdx, disc] of albumData.discs.entries()) {
        const discNo = discIdx + 1;
        const totalTracks = Object.keys(disc.tracks).length;
        const useTrackOrder = disc["$track numbers from order"] === true;
        for (const [trackIndex, [trackPath, track]] of Object.entries(disc.tracks).entries()) {
          const base = basis[trackPath] ?? {};
          const model: MetadataTrack = {};
          model.Title = track.title;
          if (track.date) {
            model.Date = track.date;
            model.Year = track.date.slice(0, 4);
          } else if (typeof base.Year === "string") {
            model.Year = base.Year;
          }
          if (disc.$subtitle) {
            model["Disc subtitle"] = disc.$subtitle;
          }
          if (useTrackOrder) {
            model["Track number"] = trackIndex + 1;
          } else if (track["track number"] !== undefined) {
            model["Track number"] = track["track number"];
          }
          model["Total tracks"] = totalTracks;
          model.Artists = [...track.artists];
          if (track.genre) {
            model.Genre = track.genre;
          }
          model["Album title"] = albumTitle;
          model["Album artists"] = [...albumData["album artists"]];
          model["Disc number"] = discNo;
          model["Total discs"] = totalDiscs;
          if (typeof base.Comment === "string") {
            model.Comment = base.Comment;
          }
          out[trackPath] = model;
        }
      }
    }
  }
  return out;
}

export function diffTrackMetadata(
  original: MetadataTrack,
  desired: MetadataTrack,
): MetadataTrack {
  const patch: MetadataTrack = {};
  for (const [key, desiredValue] of Object.entries(desired)) {
    const current = original[key];
    if (!valueEq(current, desiredValue)) {
      patch[key] = desiredValue;
    }
  }
  if (Object.keys(patch).length > 0) {
    const totalDiscsIsOne = desired["Total discs"] === 1;
    if (totalDiscsIsOne) {
      delete patch["Disc number"];
      delete patch["Total discs"];
    }
  }
  return patch;
}

function valueEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
