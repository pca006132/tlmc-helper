import type { ParsedDate } from "../domain/models.js";

const ALBUM_FOLDER_RE =
  /^(?:(?<date>\d{4}(?:[.-]\d{2}(?:[.-]\d{2})?)?)(?:\s+|$))?(?:\[[^\]]+\]\s+)?(?<album>.*?)(?:\s+\[[^\]]+\])?$/;

export interface ParsedTrackPath {
  circle: string;
  album: string;
  inferredDate?: ParsedDate;
}

export function parseTrackPath(trackPath: string): ParsedTrackPath {
  const parts = trackPath.split("/");
  if (parts.length < 3) {
    throw new Error(`invalid track path: ${trackPath}`);
  }
  const circle = extractCircleName(parts[0]);
  const albumFolder = parts[1];
  const parsed = parseAlbumFolderComponents(albumFolder);
  return {
    circle,
    album: parsed?.album ?? albumFolder,
    inferredDate: parsed?.date,
  };
}

export function parseTimestampValue(value: string): ParsedDate | undefined {
  const normalized = value.trim().replace(/\./g, "-");
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(normalized);
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : undefined;
  const day = match[3] ? Number(match[3]) : undefined;
  if (month !== undefined && (month < 1 || month > 12)) {
    return undefined;
  }
  if (day !== undefined && (day < 1 || day > 31)) {
    return undefined;
  }
  return { year, month, day };
}

export function timestampToDateString(date: ParsedDate): string {
  let out = String(date.year);
  if (date.month !== undefined) {
    out += `.${String(date.month).padStart(2, "0")}`;
  }
  if (date.day !== undefined) {
    out += `.${String(date.day).padStart(2, "0")}`;
  }
  return out;
}

export function timestampPrecisionLevel(date: ParsedDate): number {
  if (date.day !== undefined) {
    return 3;
  }
  if (date.month !== undefined) {
    return 2;
  }
  return 1;
}

export function timestampsConsistent(a: ParsedDate, b: ParsedDate): boolean {
  return (
    a.year === b.year &&
    (a.month === undefined || b.month === undefined || a.month === b.month) &&
    (a.day === undefined || b.day === undefined || a.day === b.day)
  );
}

function extractCircleName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`invalid empty circle name in track path: ${raw}`);
  }
  if (!trimmed.startsWith("[")) {
    return trimmed;
  }
  const end = trimmed.indexOf("]");
  if (end < 0) {
    throw new Error(`invalid bracketed circle name: ${raw}`);
  }
  const core = trimmed.slice(1, end).trim();
  if (!core) {
    throw new Error(`invalid bracketed circle name: ${raw}`);
  }
  return core;
}

function parseAlbumFolderComponents(
  folder: string,
): { date?: ParsedDate; album: string } | undefined {
  const match = ALBUM_FOLDER_RE.exec(folder.trim());
  if (!match?.groups) {
    return undefined;
  }
  const album = (match.groups.album ?? "").trim();
  const date = match.groups.date
    ? parseTimestampValue(match.groups.date.replace(/\./g, "-"))
    : undefined;
  return { date, album };
}
