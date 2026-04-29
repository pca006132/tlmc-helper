use std::fs;
use std::path::Path;
use std::{collections::HashSet, env};

use serde_json::Value;
use tlmc::logger::Logger;

#[path = "analyze_albums/models.rs"]
mod models;
#[path = "analyze_albums/name_utils.rs"]
mod name_utils;
#[path = "analyze_albums/pipeline_rewriting.rs"]
mod pipeline_rewriting;
#[path = "analyze_albums/pipeline_structured.rs"]
mod pipeline_structured;
#[path = "analyze_albums/pipeline_update.rs"]
mod pipeline_update;
#[path = "analyze_albums/rewriting.rs"]
mod rewriting;
#[path = "analyze_albums/rule_generation.rs"]
mod rule_generation;

fn main() {
    let selected_circles: Vec<String> = env::args().skip(1).filter(|s| !s.is_empty()).collect();
    let exec_dir = match std::env::current_dir() {
        Ok(v) => v,
        Err(_) => return,
    };
    let mut logger = match Logger::new(&exec_dir) {
        Ok(v) => v,
        Err(_) => return,
    };
    let result = run_analyze_albums(&exec_dir, &mut logger, &selected_circles);
    if let Err(err) = result {
        let _ = logger.error(&format!("fatal: {err}"));
    }
}

fn run_analyze_albums(
    exec_dir: &Path,
    logger: &mut Logger,
    selected_circles: &[String],
) -> Result<(), String> {
    let metadata = pipeline_structured::read_metadata(exec_dir.join("metadata.json"))?;
    let structured_data = pipeline_structured::run_structured_stage(exec_dir, &metadata, logger)?;
    let rewriting_data =
        pipeline_rewriting::run_rewriting_stage(exec_dir, &structured_data, logger)?;
    let mut updates =
        pipeline_update::run_update_stage(&metadata, &structured_data, &rewriting_data)?;
    if !selected_circles.is_empty() {
        let selected: HashSet<&str> = selected_circles.iter().map(String::as_str).collect();
        updates.retain(|track_path, _| {
            match pipeline_structured::parse_track_path(track_path) {
                Ok((circle, _, _)) => selected.contains(circle.as_str()),
                Err(_) => false,
            }
        });
    }
    let update_json =
        serde_json::to_string_pretty(&Value::Object(updates)).map_err(|e| e.to_string())?;
    fs::write(exec_dir.join("update-metadata.json"), update_json).map_err(|e| e.to_string())
}

