import type { AnalyzeLogger } from "../core/logger.js";
import { rewriteNames } from "../core/rule-generation.js";
import type {
  CircleRewriting,
  RewritingData,
  RewriteRule,
  StructuredData,
} from "../domain/models.js";
import { applyRewritesToStructured, chainRulesWithGlobal } from "./phase1-rewriting.js";

export interface NameListSnapshot {
  artists: Record<string, number>;
  albumArtists: Record<string, number>;
  genres: string[];
}

export interface CircleApplyResult {
  circle: string;
  nameList: NameListSnapshot;
}

export type CircleRewritingPatch = Partial<{
  "artists rewriting": RewriteRule[];
  "album artists rewriting": RewriteRule[];
  "genre rewriting": RewriteRule[];
  "default genre": string | undefined;
}>;

export interface Phase2Session {
  applyCircleRewriting(circleName: string, patch?: CircleRewritingPatch): CircleApplyResult;
  applyGlobalRewriting(patch?: CircleRewritingPatch): { circles: string[] };
  getCircleNameLists(circleName: string): NameListSnapshot;
  materializeStructured(): StructuredData;
  materializeRewriting(): RewritingData;
}

export function createPhase2Session(
  structured: StructuredData,
  rewriting: RewritingData,
  logger: AnalyzeLogger,
): Phase2Session {
  const baseStructured = structuredClone(structured);
  const mutableRewriting = structuredClone(rewriting);
  let currentStructured = structuredClone(baseStructured);
  applyRewritesToStructured(currentStructured, mutableRewriting);

  function recomputeAll(): void {
    currentStructured = structuredClone(baseStructured);
    applyRewritesToStructured(currentStructured, mutableRewriting);
  }

  function applyCircleRewriting(
    circleName: string,
    patch: CircleRewritingPatch = {},
  ): CircleApplyResult {
    const circle = mutableRewriting[circleName];
    if (!circle) {
      throw new Error(`circle not found in rewriting data: ${circleName}`);
    }
    mutateCircle(circle, patch);
    recomputeAll();
    logger.log({
      level: "info",
      code: "phase2.applyCircle",
      message: `Applied rewriting patch to circle ${circleName}`,
    });
    return {
      circle: circleName,
      nameList: getCircleNameLists(circleName),
    };
  }

  function applyGlobalRewriting(
    patch: CircleRewritingPatch = {},
  ): { circles: string[] } {
    const globalCircle = (mutableRewriting.$all ??= emptyCircleRewriting());
    mutateCircle(globalCircle, patch);
    recomputeAll();
    const circles = Object.keys(currentStructured);
    logger.log({
      level: "info",
      code: "phase2.applyGlobal",
      message: "Applied global rewriting patch",
      context: { circles: circles.length },
    });
    return { circles };
  }

  function getCircleNameLists(circleName: string): NameListSnapshot {
    const circle = currentStructured[circleName];
    if (!circle) {
      throw new Error(`circle not found in structured data: ${circleName}`);
    }
    const rewritingCircle = mutableRewriting[circleName];
    const allRewriting = mutableRewriting.$all;

    const artists: Record<string, number> = {};
    const albumArtists: Record<string, number> = {};
    const genres = new Set<string>();
    const artistRules = chainRulesWithGlobal(
      rewritingCircle?.["artists rewriting"] ?? [],
      allRewriting?.["artists rewriting"],
    );
    const albumArtistRules = chainRulesWithGlobal(
      rewritingCircle?.["album artists rewriting"] ?? [],
      allRewriting?.["album artists rewriting"],
    );

    for (const album of Object.values(circle.albums)) {
      const rewrittenAlbumArtists = rewriteNames(album["album artists"], albumArtistRules);
      rewrittenAlbumArtists.forEach((name) => {
        albumArtists[name] = (albumArtists[name] ?? 0) + 1;
      });
      for (const disc of album.discs) {
        for (const track of Object.values(disc.tracks)) {
          for (const artist of rewriteNames(track.artists, artistRules)) {
            artists[artist] = (artists[artist] ?? 0) + 1;
          }
          if (track.genre?.trim()) {
            genres.add(track.genre);
          }
        }
      }
    }
    return {
      artists,
      albumArtists,
      genres: [...genres].sort(),
    };
  }

  return {
    applyCircleRewriting,
    applyGlobalRewriting,
    getCircleNameLists,
    materializeStructured: () => structuredClone(currentStructured),
    materializeRewriting: () => structuredClone(mutableRewriting),
  };
}

function mutateCircle(circle: CircleRewriting, patch: CircleRewritingPatch): void {
  if (patch["artists rewriting"]) {
    circle["artists rewriting"] = patch["artists rewriting"];
  }
  if (patch["album artists rewriting"]) {
    circle["album artists rewriting"] = patch["album artists rewriting"];
  }
  if (patch["genre rewriting"]) {
    circle["genre rewriting"] = patch["genre rewriting"];
  }
  if ("default genre" in patch) {
    if (patch["default genre"]) {
      circle["default genre"] = patch["default genre"];
    } else {
      delete circle["default genre"];
    }
  }
}

function emptyCircleRewriting(): CircleRewriting {
  return {
    "all album artists": {},
    "album artists rewriting": [],
    "all artists": {},
    "artists rewriting": [],
    "all genres": [],
    "genre rewriting": [],
  };
}
