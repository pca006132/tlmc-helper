export type LogLevel = "debug" | "info" | "warn" | "error" | "audit";

export interface LogEntry {
  level: LogLevel;
  code: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface AnalyzeLogger {
  log(entry: LogEntry): void;
}

export class NoopLogger implements AnalyzeLogger {
  log(_entry: LogEntry): void {
    // Intentionally empty for library consumers.
  }
}
