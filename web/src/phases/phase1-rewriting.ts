import {
  aggregateNamesForTrack,
  countNameOccurrences,
  createNormalizeContext,
  dedupRewriteRules,
  generateCompiledNameRules,
  generateSplitStageOutput,
  knownNamesFromValues,
  compileRewriteLookup,
  rewriteNamesWithLookup,
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
  const initial = input ?? defaultGenre;
  if (!initial) {
    return undefined;
  }
  const lookup = compileRewriteLookup(rules);
  return rewriteGenreWithLookup(initial, lookup);
}

function rewriteGenreWithLookup(
  initial: string,
  lookup: Map<string, string[]>,
): string {
  return lookup.get(initial)?.[0] ?? initial;
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
    const artistLookup = compileRewriteLookup(artistRules);
    const albumArtistLookup = compileRewriteLookup(albumArtistRules);
    for (const album of Object.values(circle.albums)) {
      album["album artists"] = rewriteNamesWithLookup(album["album artists"], albumArtistLookup);
      for (const disc of album.discs) {
        for (const track of Object.values(disc.tracks)) {
          track.artists = rewriteNamesWithLookup(track.artists, artistLookup);
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
  const globalKnownNames = collectKnownNames(structured);

  const out: RewritingData = {};
  for (const [circleName, circleData] of Object.entries(structured)) {
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
      const normalize = createNormalizeContext();
      normalize.preload([
        ...globalKnownNames,
        ...rawArtistNames,
        ...rawAlbumArtistNames,
      ]);
      const [artistStageRules, artistSplitNames] = generateSplitStageOutput(
        rawArtistNames,
        dedupRewriteRules(normalSplitArtistRules),
        globalKnownNames,
        normalize,
      );
      const [albumArtistStageRules, albumArtistSplitNames] = generateSplitStageOutput(
        rawAlbumArtistNames,
        dedupRewriteRules(normalSplitAlbumArtistRules),
        globalKnownNames,
        normalize,
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
        globalKnownNames,
        normalize,
      );
      albumArtistRules = generateCompiledNameRules(
        rawAlbumArtistNames,
        albumArtistStageRules,
        albumArtistSplitNames,
        splitNameCounts,
        globalKnownNames,
        normalize,
      );
      genreRules = [];
      defaultGenre = undefined;
    }

    const allGenreRules = chainRulesWithGlobal(
      genreRules,
      existing?.$all?.["genre rewriting"],
    );
    const allArtistRules = chainRulesWithGlobal(
      artistRules,
      existing?.$all?.["artists rewriting"],
    );
    const allAlbumArtistRules = chainRulesWithGlobal(
      albumArtistRules,
      existing?.$all?.["album artists rewriting"],
    );
    const allGenreLookup = compileRewriteLookup(allGenreRules);
    const allGenres = collectEffectiveGenres(
      circleData,
      allGenreLookup,
      defaultGenre ?? existing?.$all?.["default genre"],
    );

    const rewrittenArtistNameCounts: Record<string, number> = {};
    const rewrittenAlbumArtistNameCounts: Record<string, number> = {};
    const combinedNameCounts: Record<string, number> = {};
    const artistLookup = compileRewriteLookup(allArtistRules);
    const albumArtistLookup = compileRewriteLookup(allAlbumArtistRules);
    for (const album of Object.values(circleData.albums)) {
      const albumRewritten = rewriteNamesWithLookup(album["album artists"], albumArtistLookup);
      for (const disc of album.discs) {
        for (const track of Object.values(disc.tracks)) {
          for (const name of rewriteNamesWithLookup(track.artists, artistLookup)) {
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

  out.$all = buildGlobalRewritingEntry(structured, out, existing);
  return out;
}

function collectKnownNames(structured: StructuredData): Set<string> {
  const values: string[] = [];
  for (const circle of Object.values(structured)) {
    for (const album of Object.values(circle.albums)) {
      values.push(...album["album artists"]);
      for (const disc of album.discs) {
        for (const track of Object.values(disc.tracks)) {
          values.push(...track.artists);
        }
      }
    }
  }
  return knownNamesFromValues(values);
}

function collectEffectiveGenres(
  circleData: StructuredData[string],
  lookup: Map<string, string[]>,
  defaultGenre: string | undefined,
): string[] {
  const values: string[] = [];
  for (const album of Object.values(circleData.albums)) {
    for (const disc of album.discs) {
      for (const track of Object.values(disc.tracks)) {
        const initial = track.genre ?? defaultGenre;
        const genre = initial ? rewriteGenreWithLookup(initial, lookup) : undefined;
        if (genre?.trim()) {
          values.push(genre);
        }
      }
    }
  }
  return dedupSorted(values);
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
    const artistLookup = compileRewriteLookup(artistRules);
    const albumArtistLookup = compileRewriteLookup(albumArtistRules);
    const genreLookup = compileRewriteLookup(genreRules);
    for (const album of Object.values(circleData.albums)) {
      const albumRewritten = rewriteNamesWithLookup(album["album artists"], albumArtistLookup);
      for (const disc of album.discs) {
        for (const track of Object.values(disc.tracks)) {
          for (const name of rewriteNamesWithLookup(track.artists, artistLookup)) {
            rewrittenArtistNameCounts[name] = (rewrittenArtistNameCounts[name] ?? 0) + 1;
            combinedNameCounts[name] = (combinedNameCounts[name] ?? 0) + 1;
          }
          for (const name of albumRewritten) {
            rewrittenAlbumArtistNameCounts[name] =
              (rewrittenAlbumArtistNameCounts[name] ?? 0) + 1;
            combinedNameCounts[name] = (combinedNameCounts[name] ?? 0) + 1;
          }
          const genre = track.genre ?? circleRules["default genre"] ?? globalDefaultGenre;
          const rewrittenGenre = genre ? rewriteGenreWithLookup(genre, genreLookup) : undefined;
          if (rewrittenGenre?.trim()) {
            allGenres.push(rewrittenGenre);
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
