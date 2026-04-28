use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use serde_json::{Map, Value};

pub struct Logger {
    exec_dir: PathBuf,
    verbose: File,
    error: File,
}

impl Logger {
    pub fn new(exec_dir: &Path) -> Result<Self, std::io::Error> {
        Ok(Self {
            exec_dir: exec_dir.to_path_buf(),
            verbose: open_append(exec_dir.join("verbose.log"))?,
            error: open_append(exec_dir.join("error.log"))?,
        })
    }

    pub fn verbose(&mut self, msg: &str, indent: bool) -> Result<(), String> {
        let line = if indent {
            format!("  {msg}\n")
        } else {
            format!("{msg}\n")
        };
        print!("{line}");
        self.verbose.write_all(line.as_bytes()).map_err(ioe)
    }

    pub fn error(&mut self, msg: &str) -> Result<(), String> {
        self.error
            .write_all(format!("{msg}\n").as_bytes())
            .map_err(ioe)
    }

    pub fn append_audit(&mut self, field: &str, line: &str) -> Result<(), String> {
        let path = self.exec_dir.join("audit.json");
        let mut root = if path.exists() {
            serde_json::from_str::<Value>(&std::fs::read_to_string(&path).map_err(ioe)?)
                .map_err(|e| e.to_string())?
        } else {
            Value::Object(Map::new())
        };
        let obj = root
            .as_object_mut()
            .ok_or_else(|| "audit.json is not a JSON object".to_string())?;
        let entry = obj
            .entry(field.to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        let arr = entry
            .as_array_mut()
            .ok_or_else(|| format!("audit field {field} is not an array"))?;
        if !arr.iter().any(|v| v.as_str() == Some(line)) {
            arr.push(Value::String(line.to_string()));
        }
        let text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
        std::fs::write(path, text).map_err(ioe)?;
        self.verbose(&format!("audit {field}: {line}"), true)
    }
}

pub fn rel(exec_dir: &Path, p: &Path) -> String {
    p.strip_prefix(exec_dir)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

pub fn ioe(err: std::io::Error) -> String {
    err.to_string()
}

fn open_append(path: PathBuf) -> Result<File, std::io::Error> {
    OpenOptions::new().create(true).append(true).open(path)
}
