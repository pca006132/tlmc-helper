use std::fs;
use std::path::Path;

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
    let exec_dir = match std::env::current_dir() {
        Ok(v) => v,
        Err(_) => return,
    };
    let mut logger = match Logger::new(&exec_dir) {
        Ok(v) => v,
        Err(_) => return,
    };
    let result = run_analyze_albums(&exec_dir, &mut logger);
    if let Err(err) = result {
        let _ = logger.error(&format!("fatal: {err}"));
    }
}

fn run_analyze_albums(exec_dir: &Path, logger: &mut Logger) -> Result<(), String> {
    let metadata = pipeline_structured::read_metadata(exec_dir.join("metadata.json"))?;
    let structured_data = pipeline_structured::run_structured_stage(exec_dir, &metadata, logger)?;
    let rewriting_data =
        pipeline_rewriting::run_rewriting_stage(exec_dir, &structured_data, logger)?;
    let updates = pipeline_update::run_update_stage(&metadata, &structured_data, &rewriting_data)?;
    let update_json =
        serde_json::to_string_pretty(&Value::Object(updates)).map_err(|e| e.to_string())?;
    fs::write(exec_dir.join("update-metadata.json"), update_json).map_err(|e| e.to_string())
}

