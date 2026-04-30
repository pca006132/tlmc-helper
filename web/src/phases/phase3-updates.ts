import { parseTrackPath } from "../core/path-parse.js";
import { rewriteNames } from "../core/rule-generation.js";
import type {
  MetadataMap,
  MetadataTrack,
  RewritingData,
  StructuredData,
  UpdateMap,
} from "../domain/models.js";
import { buildStructuredFromMetadata, getList, getString } from "./phase1-structured.js";
import {
  applyRewritesToStructured,
  chainRulesWithGlobal,
  rewriteGenre,
} from "./phase1-rewriting.js";

export function runUpdateStage(
  metadata: MetadataMap,
  structuredData: StructuredData,
  rewritingData: RewritingData,
): UpdateMap {
  const updatedMetadata: MetadataMap = {};
  const allRewriting = rewritingData.$all;

  for (const [trackPath, original] of Object.entries(metadata)) {
    const entry = structuredClone(original);
    const { circle } = parseTrackPath(trackPath);
    const circleConfig = rewritingData[circle];
    if (!circleConfig) {
      updatedMetadata[trackPath] = entry;
      continue;
    }
    const artistRules = chainRulesWithGlobal(
      circleConfig["artists rewriting"],
      allRewriting?.["artists rewriting"],
    );
    const albumArtistRules = chainRulesWithGlobal(
      circleConfig["album artists rewriting"],
      allRewriting?.["album artists rewriting"],
    );
    const genreRules = chainRulesWithGlobal(
      circleConfig["genre rewriting"],
      allRewriting?.["genre rewriting"],
    );

    const originalArtists = getList(original, "Artists");
    const artists = rewriteNames(originalArtists, artistRules);
    const originalAlbumArtists = getList(original, "Album artists");
    const albumArtists = rewriteNames(originalAlbumArtists, albumArtistRules);
    const originalGenre = getString(original, "Genre");
    const genre = rewriteGenre(
      originalGenre,
      genreRules,
      circleConfig["default genre"] ?? allRewriting?.["default genre"],
    );

    if (!eq(originalArtists, artists)) {
      entry.Artists = artists;
    }
    if (!eq(originalAlbumArtists, albumArtists)) {
      entry["Album artists"] = albumArtists;
    }
    if (genre !== originalGenre && genre !== undefined) {
      entry.Genre = genre;
    }
    updatedMetadata[trackPath] = entry;
  }

  const { structured: structuredNew } = buildStructuredFromMetadata(updatedMetadata);
  overlayTrackDataFromOld(structuredNew, structuredData);
  applyRewritesToStructured(structuredNew, rewritingData);

  const desired = materializeMetadataFromStructured(structuredNew, updatedMetadata);
  const updates: UpdateMap = {};
  for (const [trackPath, desiredFields] of Object.entries(desired)) {
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

export function overlayTrackDataFromOld(
  structuredNew: StructuredData,
  structuredOld: StructuredData,
): void {
  for (const [circleName, oldCircle] of Object.entries(structuredOld)) {
    const newCircle = structuredNew[circleName];
    if (!newCircle) {
      continue;
    }
    for (const [albumName, oldAlbum] of Object.entries(oldCircle.albums)) {
      const newAlbum = newCircle.albums[albumName];
      if (!newAlbum) {
        continue;
      }
      for (const oldDisc of oldAlbum.discs) {
        for (const [trackPath, oldTrack] of Object.entries(oldDisc.tracks)) {
          for (const newDisc of newAlbum.discs) {
            if (newDisc.tracks[trackPath]) {
              newDisc.tracks[trackPath] = structuredClone(oldTrack);
              if (oldDisc.$subtitle) {
                newDisc.$subtitle = oldDisc.$subtitle;
              }
              if (oldDisc["$track numbers from order"] !== undefined) {
                newDisc["$track numbers from order"] = oldDisc["$track numbers from order"];
              }
              break;
            }
          }
        }
      }
    }
  }
}

function eq(a: string[], b: string[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function valueEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
