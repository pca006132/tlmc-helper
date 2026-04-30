import { NoopLogger } from "../../core/logger.js";
import { runPhase1, runPhase3 } from "../../core/api.js";
import type {
  MetadataMap,
  RewritingData,
  StructuredData,
  UpdateMap,
} from "../../domain/models.js";

export interface EditorState {
  metadata: MetadataMap;
  structured: StructuredData;
  rewriting: RewritingData;
}

export interface AuditEntry {
  code: string;
  message: string;
}
export type AuditLog = Record<string, string[]>;

const logger = new NoopLogger();

export function initializeEditorState(
  metadata: MetadataMap,
  structured?: StructuredData,
  rewriting?: RewritingData,
): { state: EditorState; audits: AuditLog } {
  const auditLogger = new CollectingLogger();
  const phase1 = runPhase1(
    {
      metadata,
      existingStructured: structured,
      existingRewriting: rewriting,
    },
    auditLogger,
  );
  return {
    state: {
      metadata,
      structured: phase1.structured,
      rewriting: phase1.rewriting,
    },
    audits: auditLogger.auditLog,
  };
}

export function syncEditorState(state: EditorState): { state: EditorState; audits: AuditLog } {
  const auditLogger = new CollectingLogger();
  const phase1 = runPhase1(
    {
      metadata: state.metadata,
      existingStructured: state.structured,
      existingRewriting: state.rewriting,
    },
    auditLogger,
  );
  return {
    state: {
      ...state,
      structured: phase1.structured,
      rewriting: phase1.rewriting,
    },
    audits: auditLogger.auditLog,
  };
}

export function computeUpdates(state: EditorState): UpdateMap {
  return runPhase3(
    { metadata: state.metadata, structured: state.structured, rewriting: state.rewriting },
    logger,
  ).updates;
}

class CollectingLogger extends NoopLogger {
  public readonly auditLog: AuditLog = {};

  public override log(entry: { level: string; code: string; message: string }): void {
    if (entry.level === "audit") {
      const lines = (this.auditLog[entry.code] ??= []);
      if (!lines.includes(entry.message)) {
        lines.push(entry.message);
      }
    }
  }
}
