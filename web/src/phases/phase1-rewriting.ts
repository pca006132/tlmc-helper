import {
  aggregateNamesForTrack,
  countNameOccurrences,
  dedupRewriteRules,
  generateCompiledNameRules,
  generateSplitStageOutput,
  knownCircleNames,
  rewriteNames,
} from "../core/rule-generation.js";
import { dedupSorted } from "../core/name-utils.js";
import type {
  CircleRewriting,
  RewritingData,
  RewriteRule,
  StructuredData,
} from "../domain/models.js";

export function rewriteGenre(
  input: string | undefined,
  rules: RewriteRule[],
  defaultGenre: string | undefined,
): string | undefined {
  const value = input ?? defaultGenre;
  if (!value) {
    return undefined;
  }
  for (const rule of rules) {
    if (rule.from.includes(value)) {
      return rule.to[0];
    }
  }
  return value;
}

export function chainRulesWithGlobal(
  primary: RewriteRule[],
  global: RewriteRule[] | undefined,
): RewriteRule[] {
  return [...primary, ...(global ?? [])];
}

export function applyRewritesToStructured(
  structured: StructuredData,
  rewriting: RewritingData,
): void {
  const allRewriting = rewriting.$all;
  for (const [circleName, circle] of Object.entries(structured)) {
    const circleRules = rewriting[circleName];
    if (!circleRules) {
      continue;
    }
    const artistRules = chainRulesWithGlobal(
      circleRules["artists rewriting"],
      allRewriting?.["artists rewriting"],
    );
    const albumArtistRules = chainRulesWithGlobal(
      circleRules["album artists rewriting"],
      allRewriting?.["album artists rewriting"],
    );
    for (const album of Object.values(circle.albums)) {
      album["album artists"] = rewriteNames(album["album artists"], albumArtistRules);
      for (const disc of album.discs) {
        for (const track of Object.values(disc.tracks)) {
          track.artists = rewriteNames(track.artists, artistRules);
        }
      }
    }
  }
}

export function countSubstringHits(
  names: string[],
  nameCounts: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of names) {
    let count = 0;
    for (const [value, valueCount] of Object.entries(nameCounts)) {
      if (value.includes(name)) {
        count += valueCount;
      }
    }
    out[name] = count;
  }
  return out;
}

export function buildRewritingFromStructured(
  structured: StructuredData,
  existing: RewritingData | undefined,
): RewritingData {
  const effectiveStructured: StructuredData = structuredClone(structured);
  if (existing) {
    applyRewritesToStructured(effectiveStructured, existing);
  }

  const out: RewritingData = {};
  for (const [circleName, circleData] of Object.entries(effectiveStructured)) {
    const allGenres = dedupSorted(
      Object.values(circleData.albums)
        .flatMap((album) => album.discs)
        .flatMap((disc) => Object.values(disc.tracks))
        .flatMap((track) => (track.genre?.trim() ? [track.genre] : [])),
    );

    let artistRules: RewriteRule[];
    let albumArtistRules: RewriteRule[];
    let genreRules: RewriteRule[];
    let defaultGenre: string | undefined;

    const existingCircle = existing?.[circleName];
    if (existingCircle) {
      artistRules = dedupRewriteRules(existingCircle["artists rewriting"]);
      albumArtistRules = dedupRewriteRules(existingCircle["album artists rewriting"]);
      genreRules = dedupRewriteRules(existingCircle["genre rewriting"]);
      defaultGenre = existingCircle["default genre"];
    } else {
      // Approved fix: generate rules for newly discovered circles.
      const rawCircle = structured[circleName];
      const normalSplitArtistRules: RewriteRule[] = [];
      const normalSplitAlbumArtistRules: RewriteRule[] = [];
      const rawArtistNames: string[] = [];
      const rawAlbumArtistNames: string[] = [];

      for (const album of Object.values(rawCircle.albums)) {
        rawAlbumArtistNames.push(...album["album artists"]);
        normalSplitAlbumArtistRules.push(
          ...aggregateNamesForTrack(album["album artists"]).splitRules,
        );
        for (const disc of album.discs) {
          for (const track of Object.values(disc.tracks)) {
            rawArtistNames.push(...track.artists);
            normalSplitArtistRules.push(...aggregateNamesForTrack(track.artists).splitRules);
          }
        }
      }
      const knownNames = knownCircleNames(rawArtistNames, rawAlbumArtistNames);
      const [artistStageRules, artistSplitNames] = generateSplitStageOutput(
        rawArtistNames,
        dedupRewriteRules(normalSplitArtistRules),
        knownNames,
      );
      const [albumArtistStageRules, albumArtistSplitNames] = generateSplitStageOutput(
        rawAlbumArtistNames,
        dedupRewriteRules(normalSplitAlbumArtistRules),
        knownNames,
      );
      const splitNameCounts = countNameOccurrences([
        ...artistSplitNames,
        ...albumArtistSplitNames,
      ]);
      artistRules = generateCompiledNameRules(
        rawArtistNames,
        artistStageRules,
        artistSplitNames,
        splitNameCounts,
        5,
      );
      albumArtistRules = generateCompiledNameRules(
        rawAlbumArtistNames,
        albumArtistStageRules,
        albumArtistSplitNames,
        splitNameCounts,
        5,
      );
      genreRules = [];
      defaultGenre = undefined;
    }

    const rewrittenArtistNameCounts: Record<string, number> = {};
    const rewrittenAlbumArtistNameCounts: Record<string, number> = {};
    const combinedNameCounts: Record<string, number> = {};
    for (const album of Object.values(circleData.albums)) {
      const albumRewritten = rewriteNames(album["album artists"], albumArtistRules);
      for (const disc of album.discs) {
        for (const track of Object.values(disc.tracks)) {
          for (const name of rewriteNames(track.artists, artistRules)) {
            rewrittenArtistNameCounts[name] = (rewrittenArtistNameCounts[name] ?? 0) + 1;
            combinedNameCounts[name] = (combinedNameCounts[name] ?? 0) + 1;
          }
          for (const name of albumRewritten) {
            rewrittenAlbumArtistNameCounts[name] =
              (rewrittenAlbumArtistNameCounts[name] ?? 0) + 1;
            combinedNameCounts[name] = (combinedNameCounts[name] ?? 0) + 1;
          }
        }
      }
    }

    out[circleName] = {
      "all album artists": countSubstringHits(
        Object.keys(rewrittenAlbumArtistNameCounts),
        combinedNameCounts,
      ),
      "album artists rewriting": albumArtistRules,
      "all artists": countSubstringHits(Object.keys(rewrittenArtistNameCounts), combinedNameCounts),
      "artists rewriting": artistRules,
      "all genres": allGenres,
      "genre rewriting": genreRules,
      ...(defaultGenre ? { "default genre": defaultGenre } : {}),
    };
  }

  out.$all = buildGlobalRewritingEntry(effectiveStructured, out, existing);
  return out;
}

function buildGlobalRewritingEntry(
  structured: StructuredData,
  perCircle: RewritingData,
  existing: RewritingData | undefined,
): CircleRewriting {
  const existingAll = existing?.$all;
  const globalArtistRules = dedupRewriteRules(existingAll?.["artists rewriting"] ?? []);
  const globalAlbumArtistRules = dedupRewriteRules(
    existingAll?.["album artists rewriting"] ?? [],
  );
  const globalGenreRules = dedupRewriteRules(existingAll?.["genre rewriting"] ?? []);
  const globalDefaultGenre = existingAll?.["default genre"];

  const allGenres: string[] = [];
  const combinedNameCounts: Record<string, number> = {};
  const rewrittenArtistNameCounts: Record<string, number> = {};
  const rewrittenAlbumArtistNameCounts: Record<string, number> = {};

  for (const [circleName, circleData] of Object.entries(structured)) {
    const circleRules = perCircle[circleName];
    if (!circleRules) {
      continue;
    }
    const artistRules = chainRulesWithGlobal(
      circleRules["artists rewriting"],
      globalArtistRules,
    );
    const albumArtistRules = chainRulesWithGlobal(
      circleRules["album artists rewriting"],
      globalAlbumArtistRules,
    );
    const genreRules = chainRulesWithGlobal(
      circleRules["genre rewriting"],
      globalGenreRules,
    );
    for (const album of Object.values(circleData.albums)) {
      const albumRewritten = rewriteNames(album["album artists"], albumArtistRules);
      for (const disc of album.discs) {
        for (const track of Object.values(disc.tracks)) {
          for (const name of rewriteNames(track.artists, artistRules)) {
            rewrittenArtistNameCounts[name] = (rewrittenArtistNameCounts[name] ?? 0) + 1;
            combinedNameCounts[name] = (combinedNameCounts[name] ?? 0) + 1;
          }
          for (const name of albumRewritten) {
            rewrittenAlbumArtistNameCounts[name] =
              (rewrittenAlbumArtistNameCounts[name] ?? 0) + 1;
            combinedNameCounts[name] = (combinedNameCounts[name] ?? 0) + 1;
          }
          const genre = rewriteGenre(
            track.genre,
            genreRules,
            circleRules["default genre"] ?? globalDefaultGenre,
          );
          if (genre?.trim()) {
            allGenres.push(genre);
          }
        }
      }
    }
  }

  return {
    "all album artists": countSubstringHits(
      Object.keys(rewrittenAlbumArtistNameCounts),
      combinedNameCounts,
    ),
    "album artists rewriting": globalAlbumArtistRules,
    "all artists": countSubstringHits(Object.keys(rewrittenArtistNameCounts), combinedNameCounts),
    "artists rewriting": globalArtistRules,
    "all genres": dedupSorted(allGenres),
    "genre rewriting": globalGenreRules,
    ...(globalDefaultGenre ? { "default genre": globalDefaultGenre } : {}),
  };
}
