import {
  aggregateNamesForTrack,
} from "../core/rule-generation.js";
import {
  parseTimestampValue,
  parseTrackPath,
  timestampPrecisionLevel,
  timestampToDateString,
  timestampsConsistent,
} from "../core/path-parse.js";
import type {
  AlbumStructured,
  AnalysisAudits,
  CircleStructured,
  MetadataMap,
  MetadataTrack,
  ParsedDate,
  StructuredData,
  TrackLite,
  TrackStructured,
} from "../domain/models.js";
import type { AnalyzeLogger } from "../core/logger.js";

interface CircleData {
  albums: Record<string, { tracks: TrackLite[] }>;
}

export interface BuildStructuredResult {
  structured: StructuredData;
  audits: AnalysisAudits;
}

export function buildStructuredFromMetadata(metadata: MetadataMap): BuildStructuredResult {
  const circles: Record<string, CircleData> = {};
  const audits: AnalysisAudits = {
    disc_classification: new Set<string>(),
    different_album_artist: new Set<string>(),
    missing_info: new Set<string>(),
    inconsistent_date: new Set<string>(),
    track_title_rewrite: new Set<string>(),
  };

  for (const [trackPath, fields] of Object.entries(metadata)) {
    const { circle, album, inferredDate } = parseTrackPath(trackPath);
    const metadataDateText = nonEmpty(getString(fields, "Date")) ?? nonEmpty(getString(fields, "Year"));
    const date = resolveTrackDate(
      trackPath,
      metadataDateText ? parseTimestampValue(metadataDateText) : undefined,
      inferredDate,
      metadataDateText,
      audits,
    );
    const circleData = (circles[circle] ??= { albums: {} });
    const albumData = (circleData.albums[album] ??= { tracks: [] });
    albumData.tracks.push({
      path: trackPath,
      title: getString(fields, "Title"),
      date,
      discSubtitle: getString(fields, "Disc subtitle"),
      trackNumber: getNumber(fields, "Track number"),
      artists: getList(fields, "Artists"),
      albumArtists: getList(fields, "Album artists"),
      albumTitle: getString(fields, "Album title"),
      discNumber: getNumber(fields, "Disc number"),
      genre: nonEmpty(getString(fields, "Genre")),
      comment: getString(fields, "Comment"),
    });
  }

  const structured: StructuredData = {};
  for (const [circleName, circleData] of Object.entries(circles)) {
    const outCircle: CircleStructured = { albums: {} };
    for (const [albumNameFromPath, albumData] of Object.entries(circleData.albums)) {
      const albumPath = `${circleName}/${albumNameFromPath}`;
      const [discs, usedRule3] = classifyDiscs(albumData.tracks);
      if (usedRule3) {
        audits.disc_classification.add(albumPath);
      }
      let albumName = albumNameFromPath;
      if (discs.length === 1) {
        const tagged = new Set(
          albumData.tracks
            .map((track) => track.albumTitle?.trim() ?? "")
            .filter((value) => value.length > 0),
        );
        if (tagged.size === 1) {
          const only = [...tagged][0];
          if (only && only !== albumName) {
            albumName = only;
          }
        }
      }

      const albumArtistSets = new Set<string>();
      const albumAlbumArtists = new Set<string>();
      const albumOut: AlbumStructured = { "album artists": [], discs: [] };
      const discCount = discs.length;
      for (const disc of discs) {
        const assignByOrder = disc.every((track) => track.trackNumber === undefined);
        const explicitSubtitle = deriveExplicitDiscSubtitleInDisc(disc);
        const derivedSubtitle =
          explicitSubtitle === undefined && discCount > 1
            ? deriveDiscSubtitleFromAlbumTitleInDisc(disc)
            : undefined;
        const discTracks: Record<string, TrackStructured> = {};
        for (const [idx, track] of disc.entries()) {
          if (track.artists.length === 0) {
            audits.missing_info.add(albumPath);
          }
          const aa = aggregateNamesForTrack(track.albumArtists).names;
          const a = aggregateNamesForTrack(track.artists).names;
          aa.forEach((name) => albumAlbumArtists.add(name));
          albumArtistSets.add(aa.join("|"));
          const trackNumber = assignByOrder ? idx + 1 : (track.trackNumber ?? 0);
          const rewrittenTitle = rewriteTrackOnePrefixTitle(track.title, trackNumber);
          if (rewrittenTitle !== track.title) {
            audits.track_title_rewrite.add(albumPath);
          }
          discTracks[track.path] = {
            title: rewrittenTitle ?? "",
            date: track.date ? timestampToDateString(track.date) : undefined,
            "track number": trackNumber,
            artists: a,
            genre: track.genre,
          };
        }
        albumOut.discs.push({
          $subtitle: explicitSubtitle ?? (discCount > 1 ? derivedSubtitle : undefined),
          tracks: discTracks,
        });
      }
      albumOut["album artists"] = [...albumAlbumArtists];
      if (
        albumArtistSets.size > 1 ||
        (albumOut["album artists"].every((name) => name !== circleName) &&
          albumOut["album artists"].length > 0)
      ) {
        audits.different_album_artist.add(albumPath);
      }

      let finalAlbumName = albumName;
      if (outCircle.albums[finalAlbumName]) {
        finalAlbumName = `${albumName} (dup)`;
      }
      outCircle.albums[finalAlbumName] = albumOut;
    }
    structured[circleName] = outCircle;
  }
  return { structured, audits };
}

export function emitStructuredAudits(
  audits: AnalysisAudits,
  logger: AnalyzeLogger,
): void {
  const map: Record<keyof AnalysisAudits, string> = {
    disc_classification: "disc_classification",
    different_album_artist: "different_album_artist",
    missing_info: "missing_info",
    inconsistent_date: "inconsistent_date",
    track_title_rewrite: "track_title_rewrite",
  };
  for (const [key, field] of Object.entries(map) as [keyof AnalysisAudits, string][]) {
    for (const line of audits[key]) {
      logger.log({
        level: "audit",
        code: field,
        message: line,
      });
    }
  }
}

function classifyDiscs(tracks: TrackLite[]): [TrackLite[][], boolean] {
  const byDisc: Record<number, TrackLite[]> = {};
  const remaining: TrackLite[] = [];
  const titles = new Set<string>();
  let allNoDisc = true;
  for (const track of tracks) {
    if (track.albumTitle) {
      titles.add(track.albumTitle);
    }
    if (track.discNumber !== undefined) {
      allNoDisc = false;
      byDisc[track.discNumber] ??= [];
      byDisc[track.discNumber].push(track);
    } else {
      remaining.push(track);
    }
  }
  if (titles.size === 1 && allNoDisc) {
    return [[[...tracks]], false];
  }
  let usedRule3 = false;
  if (remaining.length > 0) {
    usedRule3 = true;
    let next = Math.max(0, ...Object.keys(byDisc).map(Number)) + 1;
    const byTitle: Record<string, TrackLite[]> = {};
    for (const track of remaining) {
      const title = track.albumTitle ?? "__missing__";
      byTitle[title] ??= [];
      byTitle[title].push(track);
    }
    const groups = Object.values(byTitle).sort((a, b) => {
      const aHasTrackNo = a.some((track) => track.trackNumber !== undefined);
      const bHasTrackNo = b.some((track) => track.trackNumber !== undefined);
      if (aHasTrackNo !== bHasTrackNo) {
        return Number(bHasTrackNo) - Number(aHasTrackNo);
      }
      if (a.length !== b.length) {
        return b.length - a.length;
      }
      const aFirst = a[0]?.path ?? "";
      const bFirst = b[0]?.path ?? "";
      return aFirst.localeCompare(bFirst);
    });
    for (const group of groups) {
      byDisc[next] = group;
      next += 1;
    }
  }
  const outDiscs = Object.keys(byDisc)
    .map(Number)
    .sort((a, b) => a - b)
    .map((index) => byDisc[index])
    .filter((disc): disc is TrackLite[] => Array.isArray(disc));
  return [outDiscs, usedRule3];
}

function deriveExplicitDiscSubtitleInDisc(discTracks: TrackLite[]): string | undefined {
  const subtitles = new Set(
    discTracks
      .map((track) => track.discSubtitle?.trim() ?? "")
      .filter((subtitle) => subtitle.length > 0),
  );
  if (subtitles.size === 1) {
    return [...subtitles][0];
  }
  return undefined;
}

function deriveDiscSubtitleFromAlbumTitleInDisc(
  discTracks: TrackLite[],
): string | undefined {
  const candidates = discTracks
    .flatMap((track) => {
      const candidate = track.albumTitle?.trim();
      if (!candidate) {
        return [];
      }
      return [{ trackNumber: track.trackNumber ?? Number.MAX_SAFE_INTEGER, path: track.path, subtitle: candidate }];
    })
    .sort((a, b) => a.trackNumber - b.trackNumber || a.path.localeCompare(b.path));
  return candidates[0]?.subtitle;
}

function resolveTrackDate(
  trackPath: string,
  metadataDate: ParsedDate | undefined,
  inferredDate: ParsedDate | undefined,
  metadataDateText: string | undefined,
  audits: AnalysisAudits,
): ParsedDate | undefined {
  if (metadataDate && !inferredDate) {
    return metadataDate;
  }
  if (!metadataDate && inferredDate) {
    return inferredDate;
  }
  if (!metadataDate || !inferredDate) {
    return undefined;
  }
  if (!timestampsConsistent(metadataDate, inferredDate)) {
    audits.inconsistent_date.add(
      `${trackPath}: metadata=${metadataDateText ?? timestampToDateString(metadataDate)}, inferred=${timestampToDateString(inferredDate)}`,
    );
    return metadataDate;
  }
  if (timestampPrecisionLevel(metadataDate) < timestampPrecisionLevel(inferredDate)) {
    return inferredDate;
  }
  return metadataDate;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function rewriteTrackOnePrefixTitle(
  title: string | undefined,
  trackNumber: number,
): string | undefined {
  if (!title || trackNumber !== 1) {
    return title;
  }
  const match = /^\s*(?:\(?\[?)0*1(?:\)|\])?\s*(?:[.-]\s*)?(.+?)\s*$/.exec(title);
  if (!match) {
    return title;
  }
  const rewritten = match[1]?.trim();
  return rewritten && rewritten.length > 0 ? rewritten : title;
}

export function getString(track: MetadataTrack, key: string): string | undefined {
  const value = track[key];
  return typeof value === "string" ? value : undefined;
}

export function getList(track: MetadataTrack, key: string): string[] {
  const value = track[key];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    return [value];
  }
  return [];
}

function getNumber(track: MetadataTrack, key: string): number | undefined {
  const value = track[key];
  return typeof value === "number" ? value : undefined;
}
