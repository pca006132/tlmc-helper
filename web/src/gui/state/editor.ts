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

const logger = new NoopLogger();

export function initializeEditorState(
  metadata: MetadataMap,
  structured?: StructuredData,
  rewriting?: RewritingData,
): EditorState {
  const phase1 = runPhase1(
    { metadata, existingStructured: structured, existingRewriting: rewriting },
    logger,
  );
  return {
    metadata,
    structured: phase1.structured,
    rewriting: phase1.rewriting,
  };
}

export function syncEditorState(state: EditorState): { state: EditorState; audits: AuditEntry[] } {
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
    audits: auditLogger.auditEntries,
  };
}

export function computeUpdates(state: EditorState): UpdateMap {
  return runPhase3(
    { metadata: state.metadata, structured: state.structured, rewriting: state.rewriting },
    logger,
  ).updates;
}

class CollectingLogger extends NoopLogger {
  public readonly auditEntries: AuditEntry[] = [];

  public override log(entry: { level: string; code: string; message: string }): void {
    if (entry.level === "audit") {
      this.auditEntries.push({ code: entry.code, message: entry.message });
    }
  }
}
