export interface RewriteRule {
  from: string[];
  to: string[];
}

export interface TrackStructured {
  title: string;
  date?: string;
  "track number"?: number;
  artists: string[];
  genre?: string;
}

export interface DiscStructured {
  $subtitle?: string;
  "$track numbers from order"?: boolean;
  // track path -> track metadata
  tracks: Record<string, TrackStructured>;
}

export interface AlbumStructured {
  "album artists": string[];
  discs: DiscStructured[];
}

export interface CircleStructured {
  // album name -> album metadata
  albums: Record<string, AlbumStructured>;
}

export interface CircleRewriting {
  audited?: boolean;
  // name -> count
  "all album artists": Record<string, number>;
  "album artists rewriting": RewriteRule[];
  // name -> count
  "all artists": Record<string, number>;
  "artists rewriting": RewriteRule[];
  "all genres": string[];
  "genre rewriting": RewriteRule[];
  "default genre"?: string;
}

export interface AnalysisAudits {
  disc_classification: Set<string>;
  different_album_artist: Set<string>;
  missing_info: Set<string>;
  inconsistent_date: Set<string>;
  track_title_rewrite: Set<string>;
}

export interface TrackLite {
  path: string;
  title?: string;
  date?: ParsedDate;
  discSubtitle?: string;
  trackNumber?: number;
  artists: string[];
  albumArtists: string[];
  albumTitle?: string;
  discNumber?: number;
  genre?: string;
  comment?: string;
}

export interface ParsedDate {
  year: number;
  month?: number;
  day?: number;
}

export type MetadataFieldValue =
  | string
  | number
  | string[]
  | null
  | undefined;
export type MetadataTrack = Record<string, MetadataFieldValue>;
export type MetadataMap = Record<string, MetadataTrack>;
export type StructuredData = Record<string, CircleStructured>;
export type RewritingData = Record<string, CircleRewriting>;
export type UpdateMap = Record<string, MetadataTrack>;
