use std::collections::{BTreeMap, BTreeSet};

use id3::Timestamp;
use serde::{Deserialize, Serialize};

#[derive(Default)]
pub(super) struct CircleData {
    pub(super) albums: BTreeMap<String, AlbumData>,
}

#[derive(Default)]
pub(super) struct AlbumData {
    pub(super) tracks: Vec<TrackLite>,
}

#[derive(Clone)]
pub(super) struct TrackLite {
    pub(super) path: String,
    pub(super) title: Option<String>,
    pub(super) date: Option<Timestamp>,
    pub(super) disc_subtitle: Option<String>,
    pub(super) track_number: Option<u64>,
    pub(super) artists: Vec<String>,
    pub(super) album_artists: Vec<String>,
    pub(super) album_title: Option<String>,
    pub(super) disc_number: Option<u64>,
    pub(super) genre: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub(super) struct CircleStructured {
    pub(super) albums: BTreeMap<String, AlbumStructured>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub(super) struct CircleRewriting {
    #[serde(rename = "all album artists")]
    pub(super) all_album_artists: BTreeMap<String, u64>,
    #[serde(rename = "album artists rewriting")]
    pub(super) album_artists_rewriting: Vec<RewriteRule>,
    #[serde(rename = "all artists")]
    pub(super) all_artists: BTreeMap<String, u64>,
    #[serde(rename = "artists rewriting")]
    pub(super) artists_rewriting: Vec<RewriteRule>,
    #[serde(rename = "all genres")]
    pub(super) all_genres: Vec<String>,
    #[serde(rename = "genre rewriting")]
    pub(super) genre_rewriting: Vec<RewriteRule>,
    #[serde(rename = "default genre", skip_serializing_if = "Option::is_none")]
    pub(super) default_genre: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub(super) struct AlbumStructured {
    #[serde(rename = "album artists")]
    pub(super) album_artists: Vec<String>,
    pub(super) discs: Vec<DiscStructured>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub(super) struct DiscStructured {
    #[serde(rename = "$subtitle", default, skip_serializing_if = "Option::is_none")]
    pub(super) subtitle: Option<String>,
    #[serde(flatten)]
    pub(super) tracks: BTreeMap<String, TrackStructured>,
}

#[derive(Serialize, Deserialize, Clone)]
pub(super) struct TrackStructured {
    pub(super) title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) date: Option<String>,
    #[serde(rename = "track number")]
    pub(super) track_number: u64,
    pub(super) artists: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) genre: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub(super) struct RewriteRule {
    pub(super) from: Vec<String>,
    pub(super) to: Vec<String>,
}

pub(super) struct NameAggregation {
    pub(super) names: Vec<String>,
    pub(super) split_rules: Vec<RewriteRule>,
}

pub(super) struct ScoredRewriteRule {
    pub(super) rule: RewriteRule,
    pub(super) confident: bool,
}

pub(super) struct AnalysisAudits {
    pub(super) disc_classification: BTreeSet<String>,
    pub(super) different_album_artist: BTreeSet<String>,
    pub(super) missing_info: BTreeSet<String>,
    pub(super) inconsistent_date: BTreeSet<String>,
}
