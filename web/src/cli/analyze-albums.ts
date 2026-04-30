import fs from "node:fs";
import path from "node:path";
import { runPhase1, runPhase3 } from "../core/api.js";
import type { AnalyzeLogger, LogEntry } from "../core/logger.js";
import { parseTrackPath } from "../core/path-parse.js";
import type {
  MetadataMap,
  RewritingData,
  StructuredData,
  UpdateMap,
} from "../domain/models.js";

class FileLogger implements AnalyzeLogger {
  private readonly execDir: string;

  public constructor(execDir: string) {
    this.execDir = execDir;
    fs.appendFileSync(path.join(this.execDir, "verbose.log"), "");
  }

  public log(entry: LogEntry): void {
    const line = `[${entry.level}] ${entry.code}: ${entry.message}\n`;
    fs.appendFileSync(path.join(this.execDir, "verbose.log"), line);
    if (entry.level === "error") {
      fs.appendFileSync(path.join(this.execDir, "error.log"), line);
    }
    if (entry.level === "audit") {
      this.appendAudit(entry.code, entry.message);
    }
  }

  private appendAudit(field: string, line: string): void {
    const auditPath = path.join(this.execDir, "audit.json");
    const root = (fs.existsSync(auditPath) ? readJsonFile(auditPath) : {}) as Record<
      string,
      unknown
    >;
    const entries = Array.isArray(root[field]) ? [...(root[field] as string[])] : [];
    if (!entries.includes(line)) {
      entries.push(line);
    }
    root[field] = entries;
    fs.writeFileSync(auditPath, `${JSON.stringify(root, null, 2)}\n`);
  }
}

function main(): void {
  const selectedCircles = process.argv.slice(2).filter((value) => value.trim().length > 0);
  const execDir = process.cwd();
  const logger = new FileLogger(execDir);

  try {
    const metadata = readJsonFile(path.join(execDir, "metadata.json")) as MetadataMap;
    const structuredPath = path.join(execDir, "structured.json");
    const rewritingPath = path.join(execDir, "rewriting.json");

    const phase1 = runPhase1(
      {
        metadata,
        existingStructured: fs.existsSync(structuredPath)
          ? (readJsonFile(structuredPath) as StructuredData)
          : undefined,
        existingRewriting: fs.existsSync(rewritingPath)
          ? (readJsonFile(rewritingPath) as RewritingData)
          : undefined,
      },
      logger,
    );

    if (phase1.structuredRebuilt) {
      writeJsonFile(structuredPath, phase1.structured);
    }
    writeJsonFile(rewritingPath, phase1.rewriting);

    const phase3 = runPhase3(
      {
        metadata,
        structured: phase1.structured,
        rewriting: phase1.rewriting,
      },
      logger,
    );
    const filtered = selectedCircles.length
      ? filterUpdatesByCircles(phase3.updates, selectedCircles)
      : phase3.updates;
    writeJsonFile(path.join(execDir, "update-metadata.json"), filtered);
  } catch (error) {
    logger.log({
      level: "error",
      code: "fatal",
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

function filterUpdatesByCircles(updates: UpdateMap, circles: string[]): UpdateMap {
  const selected = new Set(circles);
  const out: UpdateMap = {};
  for (const [trackPath, patch] of Object.entries(updates)) {
    try {
      if (selected.has(parseTrackPath(trackPath).circle)) {
        out[trackPath] = patch;
      }
    } catch {
      // Ignore invalid path records while filtering.
    }
  }
  return out;
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

main();
