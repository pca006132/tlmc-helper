import {
  computeUpdates,
  initializeEditorState,
  syncEditorState,
  type AuditLog,
  type EditorState,
} from "./editor.js";
import type { MetadataMap, RewritingData, StructuredData } from "../../domain/models.js";

type WorkerRequest =
  | {
      id: number;
      type: "import";
      metadataText: string;
      structuredText?: string;
      rewritingText?: string;
    }
  | {
      id: number;
      type: "sync";
      state: EditorState;
    }
  | {
      id: number;
      type: "compute-updates";
      state: EditorState;
    };

type WorkerResponse =
  | { id: number; ok: true; type: "import"; state: EditorState; audits: AuditLog }
  | { id: number; ok: true; type: "sync"; state: EditorState; audits: AuditLog }
  | { id: number; ok: true; type: "compute-updates"; updates: unknown }
  | { id: number; ok: false; error: string };

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === "import") {
      const metadata = JSON.parse(request.metadataText) as MetadataMap;
      const structured = request.structuredText
        ? (JSON.parse(request.structuredText) as StructuredData)
        : undefined;
      const rewriting = request.rewritingText
        ? (JSON.parse(request.rewritingText) as RewritingData)
        : undefined;
      const initialized = initializeEditorState(metadata, structured, rewriting);
      post({
        id: request.id,
        ok: true,
        type: "import",
        state: initialized.state,
        audits: initialized.audits,
      });
      return;
    }
    if (request.type === "sync") {
      const synced = syncEditorState(request.state);
      post({
        id: request.id,
        ok: true,
        type: "sync",
        state: synced.state,
        audits: synced.audits,
      });
      return;
    }
    const updates = computeUpdates(request.state);
    post({
      id: request.id,
      ok: true,
      type: "compute-updates",
      updates,
    });
  } catch (error) {
    post({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

function post(message: WorkerResponse): void {
  self.postMessage(message);
}
