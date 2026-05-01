import React, { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import Sortable, { type SortableEvent } from "sortablejs";
import type {
  CircleRewriting,
  RewritingData,
  RewriteRule,
  StructuredData,
  TrackStructured,
} from "../domain/models.js";
import { compileRewriteLookup } from "../core/rule-generation.js";
import { TagInput } from "./components/TagInput";
import type { AuditLog, EditorState } from "./state/editor";
import { downloadJsonFile } from "./utils/json";

type TabKey = "structured" | "rewriting";
type RewritingTarget = "artists rewriting" | "album artists rewriting" | "genre rewriting";
type AuditFilter = "all" | string;
type SyncStatus = "idle" | "queued" | "syncing" | "error";
type RewriteCycleSelection = {
  circle: string;
  target: RewritingTarget;
  rules: Set<number>;
};
type HighlightTarget =
  | {
      circle: string;
      album: string;
      field: "album artists";
    }
  | {
      circle: string;
      album: string;
      trackPath: string;
      field: "artists" | "genre";
    };
type WorkerResponse =
  | { id: number; ok: true; type: "import"; state: EditorState; audits: AuditLog }
  | {
      id: number;
      ok: true;
      type: "sync";
      structured: EditorState["structured"];
      rewriting: EditorState["rewriting"];
      audits: AuditLog;
    }
  | { id: number; ok: true; type: "compute-updates"; updates: unknown }
  | { id: number; ok: false; error: string };
const DB_NAME = "tlmc-gui";
const STORE_NAME = "session";
const SESSION_KEY = "latest";

export function App() {
  const [editor, setEditor] = useState<EditorState | undefined>(undefined);
  const [auditLog, setAuditLog] = useState<AuditLog>({});
  const [auditFilter, setAuditFilter] = useState<AuditFilter>("all");
  const [statusMessage, setStatusMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [tab, setTab] = useState<TabKey>("structured");
  const [structuredCircle, setStructuredCircle] = useState("");
  const [structuredAlbum, setStructuredAlbum] = useState("");
  const [rewritingCircle, setRewritingCircle] = useState("");
  const [rewritingTarget, setRewritingTarget] =
    useState<RewritingTarget>("artists rewriting");
  const [rewriteCycleSelection, setRewriteCycleSelection] =
    useState<RewriteCycleSelection | undefined>(undefined);
  const [highlightTarget, setHighlightTarget] = useState<HighlightTarget | undefined>(
    undefined,
  );
  const [isEditingAlbumName, setIsEditingAlbumName] = useState(false);

  const discListRef = useRef<HTMLDivElement | null>(null);
  const rulesRef = useRef<HTMLDivElement | null>(null);
  const discSortableRef = useRef<Sortable | null>(null);
  const ruleSortableRef = useRef<Sortable | null>(null);
  const highlightTimeoutRef = useRef<number | undefined>(undefined);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const editorVersionRef = useRef(0);
  const latestEditorRef = useRef<EditorState | undefined>(undefined);
  const syncInFlightRef = useRef(false);
  const syncQueuedRef = useRef(false);
  const syncRequestVersionRef = useRef(0);
  const syncHealthyRef = useRef(true);
  const syncIdleResolversRef = useRef(new Set<() => void>());
  const requestResolverRef = useRef(
    new Map<number, (response: WorkerResponse) => void>(),
  );

  const structuredCircleData =
    editor && structuredCircle ? editor.structured[structuredCircle] : undefined;
  const albumNames = useMemo(
    () =>
      structuredCircleData ? Object.keys(structuredCircleData.albums).sort((a, b) => a.localeCompare(b)) : [],
    [structuredCircleData],
  );
  const selectedAlbum = structuredCircleData?.albums[structuredAlbum];
  const rewritingCircleData = editor?.rewriting[rewritingCircle];
  const selectedAlbumArtistsAfterRewriting =
    editor && selectedAlbum
      ? rewriteMetadataValues(
          selectedAlbum["album artists"],
          editor.rewriting,
          structuredCircle,
          "album artists rewriting",
        )
      : [];
  const rewritingRules = rewritingCircleData?.[rewritingTarget] ?? [];
  const rewritingNameEntries = useMemo(
    () => getNameEntriesForTarget(rewritingCircleData, rewritingTarget),
    [rewritingCircleData, rewritingTarget],
  );
  const rewritingNameSuggestions = useMemo(
    () => rewritingNameEntries.map((entry) => entry.name),
    [rewritingNameEntries],
  );
  const rewritingNameHeader = getNameHeaderForTarget(rewritingTarget);
  const rewriteRuleDuplicateCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const rule of rewritingRules) {
      if (isInvalidRewriteRule(rule)) {
        continue;
      }
      const signature = getRuleSignature(rule);
      counts.set(signature, (counts.get(signature) ?? 0) + 1);
    }
    return counts;
  }, [rewritingRules]);
  const auditCodes = useMemo(
    () => Object.keys(auditLog).sort((a, b) => a.localeCompare(b)),
    [auditLog],
  );
  const visibleAuditLines = useMemo(() => {
    if (auditFilter === "all") {
      return auditCodes.flatMap((code) =>
        (auditLog[code] ?? []).map((line) => ({ code, line })),
      );
    }
    return (auditLog[auditFilter] ?? []).map((line) => ({ code: auditFilter, line }));
  }, [auditCodes, auditFilter, auditLog]);

  useEffect(() => {
    const worker = new Worker(new URL("./state/sync.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const resolver = requestResolverRef.current.get(response.id);
      if (resolver) {
        requestResolverRef.current.delete(response.id);
        resolver(response);
      }
    };
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
      if (highlightTimeoutRef.current !== undefined) {
        window.clearTimeout(highlightTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const saved = await loadSession();
        if (!saved?.state) {
          return;
        }
        replaceEditor(saved.state);
        const firstCircle =
          Object.keys(saved.state.structured).sort((a, b) => a.localeCompare(b))[0] ?? "";
        const firstAlbum = firstCircle
          ? Object.keys(saved.state.structured[firstCircle].albums).sort((a, b) =>
              a.localeCompare(b),
            )[0] ?? ""
          : "";
        setStructuredCircle(firstCircle);
        setStructuredAlbum(firstAlbum);
        setRewritingCircle(firstNonGlobalRewritingCircle(saved.state.rewriting) || firstCircle);
        setAuditLog(normalizeAuditLog(saved.audits));
      } catch {
        setStatusMessage("Failed to restore previous session.");
      }
    })();
  }, []);

  useEffect(() => {
    if (!editor) {
      return;
    }
    void saveSession({ state: editor, audits: auditLog }).catch(() => {
      setStatusMessage("Warning: failed to persist session.");
    });
  }, [editor, auditLog]);

  function commitStructured(updater: (draft: EditorState) => void): void {
    updateEditor((draft) => {
      updater(draft);
    });
  }

  function commitRewriting(updater: (draft: RewritingData) => void): void {
    updateEditor((draft) => {
      updater(draft.rewriting);
    });
  }

  function replaceEditor(nextEditor: EditorState): void {
    editorVersionRef.current += 1;
    latestEditorRef.current = nextEditor;
    setEditor(nextEditor);
  }

  function updateEditor(updater: (draft: EditorState) => void): void {
    const current = latestEditorRef.current;
    if (!current) {
      return;
    }
    const nextEditor = structuredClone(current);
    updater(nextEditor);
    editorVersionRef.current += 1;
    latestEditorRef.current = nextEditor;
    setEditor(nextEditor);
    setStatusMessage("Local edits updated. Sync queued.");
    queueSync(nextEditor);
  }

  useEffect(() => {
    discSortableRef.current?.destroy();
    if (!discListRef.current || !selectedAlbum) {
      discSortableRef.current = null;
      return;
    }
    discSortableRef.current = Sortable.create(discListRef.current, {
      animation: 120,
      handle: ".disc-drag-handle",
      onEnd: ({ oldIndex, newIndex }: SortableEvent) => {
        if (oldIndex === undefined || newIndex === undefined || oldIndex === newIndex) {
          return;
        }
        commitStructured((draft) => {
          const discs = draft.structured[structuredCircle].albums[structuredAlbum].discs;
          const [moved] = discs.splice(oldIndex, 1);
          discs.splice(newIndex, 0, moved);
        });
      },
    });
    return () => {
      discSortableRef.current?.destroy();
      discSortableRef.current = null;
    };
  }, [selectedAlbum, structuredAlbum, structuredCircle]);

  useEffect(() => {
    ruleSortableRef.current?.destroy();
    if (!rulesRef.current || !rewritingCircleData) {
      ruleSortableRef.current = null;
      return;
    }
    ruleSortableRef.current = Sortable.create(rulesRef.current, {
      animation: 120,
      handle: ".rule-drag-handle",
      onEnd: ({ oldIndex, newIndex }: SortableEvent) => {
        if (oldIndex === undefined || newIndex === undefined || oldIndex === newIndex) {
          return;
        }
        commitRewriting((draft) => {
          const rules = draft[rewritingCircle][rewritingTarget];
          const [moved] = rules.splice(oldIndex, 1);
          rules.splice(newIndex, 0, moved);
        });
      },
    });
    return () => {
      ruleSortableRef.current?.destroy();
      ruleSortableRef.current = null;
    };
  }, [rewritingCircleData, rewritingCircle, rewritingTarget]);

  async function callWorker(request: {
    type: "import";
    metadataText: string;
    structuredText?: string;
    rewritingText?: string;
  }): Promise<WorkerResponse>;
  async function callWorker(request: {
    type: "sync";
    structured: EditorState["structured"];
    rewriting: EditorState["rewriting"];
  }): Promise<WorkerResponse>;
  async function callWorker(request: {
    type: "compute-updates";
    state: EditorState;
  }): Promise<WorkerResponse>;
  async function callWorker(
    request:
      | { type: "import"; metadataText: string; structuredText?: string; rewritingText?: string }
      | {
          type: "sync";
          structured: EditorState["structured"];
          rewriting: EditorState["rewriting"];
        }
      | { type: "compute-updates"; state: EditorState },
  ): Promise<WorkerResponse> {
    if (!workerRef.current) {
      return { id: -1, ok: false, error: "Worker not initialized." };
    }
    const id = ++requestIdRef.current;
    const payload = { ...request, id };
    const response = await new Promise<WorkerResponse>((resolve) => {
      requestResolverRef.current.set(id, resolve);
      workerRef.current?.postMessage(payload);
    });
    return response;
  }

  async function onImport(files: {
    metadata?: File | null;
    structured?: File | null;
    rewriting?: File | null;
  }): Promise<void> {
    try {
      if (!files.metadata) {
        throw new Error("metadata.json is required");
      }
      setIsLoading(true);
      const response = await callWorker({
        type: "import",
        metadataText: await files.metadata.text(),
        structuredText: files.structured ? await files.structured.text() : undefined,
        rewritingText: files.rewriting ? await files.rewriting.text() : undefined,
      });
      if (!response.ok || response.type !== "import") {
        throw new Error(response.ok ? "Invalid import response" : response.error);
      }
      const initial = response.state;
      const firstCircle =
        Object.keys(initial.structured).sort((a, b) => a.localeCompare(b))[0] ?? "";
      const firstAlbum = firstCircle
        ? Object.keys(initial.structured[firstCircle].albums).sort((a, b) => a.localeCompare(b))[0] ?? ""
        : "";
      replaceEditor(initial);
      setAuditFilter("all");
      setStructuredCircle(firstCircle);
      setStructuredAlbum(firstAlbum);
      setRewritingCircle(firstNonGlobalRewritingCircle(initial.rewriting) || firstCircle);
      setRewriteCycleSelection(undefined);
      setAuditLog(normalizeAuditLog(response.audits));
      setStatusMessage("Import success.");
    } catch (error) {
      setStatusMessage(
        `Import failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function onLoadDebugSample(): Promise<void> {
    if (
      editor &&
      !window.confirm("Load the debug sample? This will replace the current workspace data.")
    ) {
      return;
    }
    setIsLoading(true);
    const response = await callWorker({
      type: "import",
      metadataText: JSON.stringify(createDebugMetadata()),
    });
    if (!response.ok || response.type !== "import") {
      setStatusMessage(`Debug sample failed: ${response.ok ? "Unexpected response." : response.error}`);
      setIsLoading(false);
      return;
    }
    const initial = response.state;
    const firstCircle = Object.keys(initial.structured).sort((a, b) => a.localeCompare(b))[0] ?? "";
    const firstAlbum = firstCircle
      ? Object.keys(initial.structured[firstCircle].albums).sort((a, b) => a.localeCompare(b))[0] ?? ""
      : "";
    replaceEditor(initial);
    setAuditFilter("all");
    setStructuredCircle(firstCircle);
    setStructuredAlbum(firstAlbum);
    setRewritingCircle(firstNonGlobalRewritingCircle(initial.rewriting) || firstCircle);
    setRewriteCycleSelection(undefined);
    setStatusMessage("Loaded debug sample.");
    setAuditLog(normalizeAuditLog(response.audits));
    setIsLoading(false);
  }

  function queueSync(nextEditor: EditorState): void {
    latestEditorRef.current = nextEditor;
    syncQueuedRef.current = true;
    syncHealthyRef.current = true;
    setSyncStatus("queued");
    void drainSyncQueue();
  }

  async function drainSyncQueue(): Promise<void> {
    if (syncInFlightRef.current) {
      return;
    }
    const nextEditor = latestEditorRef.current;
    if (!syncQueuedRef.current || !nextEditor) {
      settleSyncWaiters();
      return;
    }
    syncQueuedRef.current = false;
    syncInFlightRef.current = true;
    syncRequestVersionRef.current = editorVersionRef.current;
    setSyncStatus("syncing");
    const synced = await syncEditor(nextEditor, syncRequestVersionRef.current);
    syncInFlightRef.current = false;
    if (syncQueuedRef.current) {
      setSyncStatus("queued");
      void drainSyncQueue();
      return;
    }
    setSyncStatus(synced ? "idle" : "error");
    settleSyncWaiters();
  }

  async function syncEditor(nextEditor: EditorState, requestVersion: number): Promise<boolean> {
    const response = await callWorker({
      type: "sync",
      structured: nextEditor.structured,
      rewriting: sanitizeRewritingForSync(nextEditor.rewriting),
    });
    if (!response.ok || response.type !== "sync") {
      const cycleSelection = response.ok ? undefined : parseRewriteCycleError(response.error);
      if (cycleSelection && requestVersion === editorVersionRef.current) {
        setTab("rewriting");
        setRewritingCircle(cycleSelection.circle);
        setRewritingTarget(cycleSelection.target);
        setRewriteCycleSelection(cycleSelection);
        window.setTimeout(() => {
          document.querySelector(".rewrite-rule-card-error")?.scrollIntoView({
            block: "center",
            behavior: "smooth",
          });
        }, 0);
      }
      if (requestVersion === editorVersionRef.current) {
        setStatusMessage(`Sync failed: ${response.ok ? "Unexpected response." : response.error}`);
        setSyncStatus("error");
        syncHealthyRef.current = false;
      }
      return false;
    }
    if (requestVersion === editorVersionRef.current) {
      const syncedEditor: EditorState = {
        metadata: nextEditor.metadata,
        structured: response.structured,
        rewriting: preserveEditableRewritingRules(response.rewriting, nextEditor.rewriting),
      };
      latestEditorRef.current = syncedEditor;
      setEditor(syncedEditor);
      setRewriteCycleSelection(undefined);
      setStatusMessage("Sync complete.");
      syncHealthyRef.current = true;
    }
    setAuditLog((previous) => mergeAuditLogs(previous, normalizeAuditLog(response.audits)));
    return true;
  }

  function settleSyncWaiters(): void {
    const waiters = [...syncIdleResolversRef.current];
    syncIdleResolversRef.current.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }

  async function waitForSync(): Promise<boolean> {
    if (!syncInFlightRef.current && !syncQueuedRef.current) {
      return syncHealthyRef.current;
    }
    await new Promise<void>((resolve) => {
      syncIdleResolversRef.current.add(resolve);
    });
    return syncHealthyRef.current;
  }

  async function onAuditedChange(checked: boolean): Promise<void> {
    if (!editor || !rewritingCircle || rewritingCircle === "$all") {
      return;
    }
    commitRewriting((draft) => {
      draft[rewritingCircle].audited = checked;
    });
  }

  function onTabChange(nextTab: TabKey): void {
    setTab(nextTab);
    if (!editor) {
      return;
    }
    if (nextTab === "rewriting") {
      if (structuredCircle && editor.rewriting[structuredCircle]) {
        setRewritingCircle(structuredCircle);
        return;
      }
      const firstCircle = firstNonGlobalRewritingCircle(editor.rewriting);
      if (firstCircle) {
        setRewritingCircle(firstCircle);
      }
      return;
    }
    if (rewritingCircle && rewritingCircle !== "$all" && editor.structured[rewritingCircle]) {
      setStructuredCircle(rewritingCircle);
      setStructuredAlbum(firstAlbumName(editor.structured, rewritingCircle));
    }
  }

  function renameStructuredAlbum(rawName: string): void {
    const nextName = rawName.trim();
    setIsEditingAlbumName(false);
    if (!nextName || nextName === structuredAlbum) {
      return;
    }
    commitStructured((draft) => {
      const albums = draft.structured[structuredCircle].albums;
      const payload = albums[structuredAlbum];
      delete albums[structuredAlbum];
      albums[nextName] = payload;
    });
    setStructuredAlbum(nextName);
  }

  function revealRewrittenName(name: string): void {
    if (!editor) {
      return;
    }
    const target = findFirstRewrittenNameTarget(
      editor.structured,
      editor.rewriting,
      rewritingCircle,
      rewritingTarget,
      name,
    );
    if (!target) {
      setStatusMessage(`No metadata field found for ${name}.`);
      return;
    }
    setTab("structured");
    setStructuredCircle(target.circle);
    setStructuredAlbum(target.album);
    setHighlightTarget(target);
    if (highlightTimeoutRef.current !== undefined) {
      window.clearTimeout(highlightTimeoutRef.current);
    }
    highlightTimeoutRef.current = window.setTimeout(() => {
      setHighlightTarget(undefined);
      highlightTimeoutRef.current = undefined;
    }, 2000);
    window.setTimeout(() => {
      document.querySelector(".metadata-field-highlight")?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    }, 0);
  }

  async function onDownloadUpdates(): Promise<void> {
    const currentEditor = latestEditorRef.current;
    if (!currentEditor) {
      return;
    }
    setStatusMessage("Waiting for sync before download.");
    if (!(await waitForSync())) {
      setStatusMessage("Download skipped because sync failed.");
      return;
    }
    const syncedEditor = latestEditorRef.current;
    if (!syncedEditor) {
      return;
    }
    setIsLoading(true);
    const response = await callWorker({
      type: "compute-updates",
      state: {
        ...syncedEditor,
        rewriting: sanitizeRewritingForSync(syncedEditor.rewriting),
      },
    });
    if (!response.ok || response.type !== "compute-updates") {
      setStatusMessage(
        `Failed to compute updates: ${response.ok ? "Unexpected response." : response.error}`,
      );
      setIsLoading(false);
      return;
    }
    downloadJsonFile("update-metadata.json", response.updates);
    setStatusMessage("Computed and downloaded update-metadata.json.");
    setIsLoading(false);
  }

  async function onDownloadStructured(): Promise<void> {
    setStatusMessage("Waiting for sync before download.");
    if (!(await waitForSync())) {
      setStatusMessage("Download skipped because sync failed.");
      return;
    }
    const syncedEditor = latestEditorRef.current;
    if (!syncedEditor) {
      return;
    }
    downloadJsonFile("structured.json", syncedEditor.structured);
    setStatusMessage("Downloaded structured.json.");
  }

  async function onDownloadRewriting(): Promise<void> {
    setStatusMessage("Waiting for sync before download.");
    if (!(await waitForSync())) {
      setStatusMessage("Download skipped because sync failed.");
      return;
    }
    const syncedEditor = latestEditorRef.current;
    if (!syncedEditor) {
      return;
    }
    downloadJsonFile("rewriting.json", syncedEditor.rewriting);
    setStatusMessage("Downloaded rewriting.json.");
  }

  return (
    <div className="app">
      {isLoading ? (
        <div className="overlay">
          <div className="loading-card" role="status" aria-live="polite">
            <div className="loading-title">Working</div>
            <div className="skeleton-line skeleton-line-wide" />
            <div className="skeleton-line" />
            <div className="skeleton-grid">
              <span />
              <span />
              <span />
            </div>
          </div>
        </div>
      ) : null}
      <header className="app-header">
        <div>
          <p className="eyebrow">metadata workspace</p>
          <h1>TLMC editor</h1>
        </div>
        <div className="app-header-copy">
          Import source metadata, review normalized albums, tune rewrite rules, then export the generated JSON.
        </div>
      </header>
      <div className={`app-top${editor ? "" : " app-top-single"}`}>
        <div className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">start</p>
              <h2>Import workspace</h2>
            </div>
            {statusMessage ? <div className="status-pill">{statusMessage}</div> : null}
          </div>
          <ImportPanel onImport={onImport} onLoadDebugSample={onLoadDebugSample} />
        </div>
        {editor ? (
          <div className="panel downloads-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">finish</p>
                <h2>Export</h2>
              </div>
            </div>
            <div className="download-actions">
              <button type="button" onClick={() => void onDownloadStructured()}>
                structured
              </button>
              <button type="button" onClick={() => void onDownloadRewriting()}>
                rewriting
              </button>
              <button type="button" onClick={() => void onDownloadUpdates()}>
                updates
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {!editor ? (
        <section className="empty-state panel" aria-label="Empty workspace">
          <div>
            <p className="eyebrow">ready when you are</p>
            <h2>No workspace loaded</h2>
          </div>
          <p>
            Choose metadata.json to build a new workspace, or add existing structured and rewriting files
            to resume an edit session.
          </p>
        </section>
      ) : null}

      {editor && (
        <div className="panel editor-panel">
          <div className="editor-topbar">
            <div className="editor-tabs" role="tablist" aria-label="Workspace view">
              <button
                type="button"
                className={tab === "structured" ? "editor-tab editor-tab-active" : "editor-tab"}
                onClick={() => onTabChange("structured")}
              >
                Album Metadata
              </button>
              <button
                type="button"
                className={tab === "rewriting" ? "editor-tab editor-tab-active" : "editor-tab"}
                onClick={() => onTabChange("rewriting")}
              >
                Rewrite Rules
              </button>
            </div>
            <div className="editor-actions">
              <SyncIndicator status={syncStatus} />
            </div>
          </div>
          {tab === "structured" ? (
            <div className="editor-view metadata-panel">
              <div className="metadata-layout">
                <aside className="metadata-sidebar">
                  <div className="metadata-nav">
                    <label>
                      Circle
                      <select
                        value={structuredCircle}
                        onChange={(event) => {
                          const circle = event.target.value;
                          setStructuredCircle(circle);
                          const nextAlbum =
                            Object.keys(editor.structured[circle]?.albums ?? {})
                              .sort((a, b) => a.localeCompare(b))[0] ?? "";
                          setStructuredAlbum(nextAlbum);
                        }}
                      >
                        {Object.keys(editor.structured)
                          .sort((a, b) => a.localeCompare(b))
                          .map((circle) => (
                            <option key={circle} value={circle}>
                              {circle}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      Album
                      <select value={structuredAlbum} onChange={(event) => setStructuredAlbum(event.target.value)}>
                        {albumNames.map((albumName) => (
                          <option key={albumName} value={albumName}>
                            {albumName}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </aside>

                {selectedAlbum && structuredCircleData && (
                  <div className="list metadata-editor">
                  <div className="album-title-cell">
                    {isEditingAlbumName ? (
                      <input
                        className="album-title-input"
                        defaultValue={structuredAlbum}
                        autoFocus
                        onBlur={(event) => renameStructuredAlbum(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            renameStructuredAlbum(event.currentTarget.value);
                          }
                          if (event.key === "Escape") {
                            setIsEditingAlbumName(false);
                          }
                        }}
                      />
                    ) : (
                      <h2 className="album-title" onDoubleClick={() => setIsEditingAlbumName(true)}>
                        {structuredAlbum}
                      </h2>
                    )}
                  </div>

                  <div className="metadata-field-pair">
                    <div className="field-group">
                      <div className="field-label">Album artists</div>
                      <div
                        className={
                          highlightTarget?.circle === structuredCircle &&
                          highlightTarget.album === structuredAlbum &&
                          highlightTarget.field === "album artists"
                            ? "metadata-field-highlight"
                            : undefined
                        }
                      >
                        <TagInput
                          value={selectedAlbum["album artists"]}
                          suggestions={Object.keys(editor.rewriting[structuredCircle]?.["all album artists"] ?? {})}
                          onCommit={(next) =>
                            commitStructured((draft) => {
                              draft.structured[structuredCircle].albums[structuredAlbum]["album artists"] = next;
                            })
                          }
                        />
                      </div>
                    </div>
                    <ReadonlyTagList
                      label="Album artists (after rewriting)"
                      values={selectedAlbumArtistsAfterRewriting}
                    />
                  </div>

                  <div className="list" ref={discListRef}>
                    {selectedAlbum.discs.map((disc, discIndex) => (
                      <div
                        className={`disc-section${selectedAlbum.discs.length > 1 ? " disc-section-draggable" : ""}`}
                        key={`${discIndex}-${Object.keys(disc.tracks).join(":")}`}
                      >
                        {selectedAlbum.discs.length > 1 ? (
                          <div
                            className="disc-drag-handle"
                            aria-label={`Drag disc ${discIndex + 1} to reorder`}
                            title={`Drag disc ${discIndex + 1} to reorder`}
                          >
                            <span />
                          </div>
                        ) : null}
                        <div className="disc-content">
                          {selectedAlbum.discs.length > 1 ? (
                            <h2 className="disc-title">Disc {discIndex + 1}</h2>
                          ) : null}
                          <div className="disc-header">
                            <label>
                              Disc subtitle
                              <input
                                defaultValue={disc.$subtitle ?? ""}
                                onBlur={(event) =>
                                  commitStructured((draft) => {
                                    const value = event.currentTarget.value.trim();
                                    draft.structured[structuredCircle].albums[structuredAlbum].discs[
                                      discIndex
                                    ].$subtitle = value || undefined;
                                  })
                                }
                              />
                            </label>
                            <label className="checkbox-label">
                              <input
                                type="checkbox"
                                checked={disc["$track numbers from order"] === true}
                                onChange={(event) =>
                                  commitStructured((draft) => {
                                    draft.structured[structuredCircle].albums[structuredAlbum].discs[
                                      discIndex
                                    ]["$track numbers from order"] = event.currentTarget.checked;
                                  })
                                }
                              />
                              <span>Update track numbers from track order</span>
                            </label>
                          </div>
                          <div className="tracks-title">Tracks</div>
                          <DiscTrackList
                            disc={disc}
                            discIndex={discIndex}
                            structuredCircle={structuredCircle}
                            structuredAlbum={structuredAlbum}
                            commitStructured={commitStructured}
                          >
                            {Object.entries(disc.tracks).map(([trackPath, track]) => (
                              <TrackEditor
                                key={trackPath}
                                trackPath={trackPath}
                                track={track}
                                artistSuggestions={Object.keys(
                                  editor.rewriting[structuredCircle]?.["all artists"] ?? {},
                                )}
                                artistsAfterRewriting={rewriteMetadataValues(
                                  track.artists,
                                  editor.rewriting,
                                  structuredCircle,
                                  "artists rewriting",
                                )}
                                genreAfterRewriting={rewriteMetadataGenre(
                                  track.genre,
                                  editor.rewriting,
                                  structuredCircle,
                                )}
                                highlightedField={
                                  highlightTarget?.circle === structuredCircle &&
                                  highlightTarget.album === structuredAlbum &&
                                  "trackPath" in highlightTarget &&
                                  highlightTarget.trackPath === trackPath
                                    ? highlightTarget.field
                                    : undefined
                                }
                                onCommit={(nextTrack) =>
                                  commitStructured((draft) => {
                                    draft.structured[structuredCircle].albums[structuredAlbum].discs[
                                      discIndex
                                    ].tracks[trackPath] = nextTrack;
                                  })
                                }
                              />
                            ))}
                          </DiscTrackList>
                        </div>
                      </div>
                    ))}
                  </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="editor-view rewrite-workspace">
              <aside className="rewrite-sidebar">
                <label>
                  Circle
                  <select value={rewritingCircle} onChange={(event) => setRewritingCircle(event.target.value)}>
                    {Object.keys(editor.rewriting)
                      .sort((a, b) => (a === "$all" ? -1 : b === "$all" ? 1 : a.localeCompare(b)))
                      .map((circle) => (
                        <option key={circle} value={circle}>
                          {circle}
                        </option>
                      ))}
                  </select>
                </label>
                <div className="section-pane names-pane">
                  <div className="pane-header">
                    <h3>{rewritingNameHeader}</h3>
                    <span className="count-badge">{rewritingNameEntries.length}</span>
                  </div>
                  <div className="list names-list">
                    {rewritingNameEntries.map((entry) => (
                      <div
                        className="name-row"
                        key={entry.name}
                        onDoubleClick={() => revealRewrittenName(entry.name)}
                      >
                        <span>{entry.name}</span>
                        {entry.count !== undefined ? (
                          <span className="name-count">{entry.count}</span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              </aside>
              <div className="rewrite-main">
                <div className="rewrite-toolbar-main">
                  <div className="rewrite-target-tabs" role="tablist" aria-label="Rewrite target">
                    {(
                      [
                        "artists rewriting",
                        "album artists rewriting",
                        "genre rewriting",
                      ] satisfies RewritingTarget[]
                    ).map((target) => (
                      <button
                        type="button"
                        className={
                          rewritingTarget === target
                            ? "rewrite-target-tab rewrite-target-tab-active"
                            : "rewrite-target-tab"
                        }
                        onClick={() => setRewritingTarget(target)}
                        key={target}
                      >
                        {target.replace(" rewriting", "")}
                      </button>
                    ))}
                  </div>
                  {rewritingCircle !== "$all" && rewritingCircleData ? (
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={rewritingCircleData.audited === true}
                        onChange={(event) =>
                          void onAuditedChange(event.currentTarget.checked)
                        }
                      />
                      <span>Audited</span>
                    </label>
                  ) : null}
                </div>
                <div className="section-pane rules-pane">
                  <div className="pane-header">
                    <h3>Rules</h3>
                    <span className="count-badge">{rewritingRules.length}</span>
                  </div>
                  <div className="muted pane-copy">
                    Drag rule headers to reorder. Move chips between From and To to adjust each mapping.
                  </div>
                  <div className="list rules-list" ref={rulesRef}>
                    {rewritingRules.map((rule, index) => {
                      const hasCycleError =
                        rewriteCycleSelection?.circle === rewritingCircle &&
                        rewriteCycleSelection.target === rewritingTarget &&
                        rewriteCycleSelection.rules.has(index);
                      return (
                      <div
                        className={`card rewrite-rule-card${hasCycleError ? " rewrite-rule-card-error" : ""}`}
                        key={`rule-${index}`}
                      >
                        <div
                          className="rule-drag-handle"
                          aria-label={`Drag rule ${index + 1} to reorder`}
                          title={`Drag rule ${index + 1} to reorder`}
                        >
                          <span />
                        </div>
                        <div className="rule-card-body">
                          <div className="rule-validation-stack">
                            {hasCycleError ? (
                              <div className="muted validation-hint validation-error">
                                This rule participates in a rewrite cycle.
                              </div>
                            ) : null}
                            {rule.from.length === 0 || rule.to.length === 0 ? (
                              <div className="muted validation-hint">
                                A rule needs at least one value in both `from` and `to`.
                              </div>
                            ) : null}
                            {rewriteRuleDuplicateCounts.get(getRuleSignature(rule)) && rewriteRuleDuplicateCounts.get(getRuleSignature(rule))! > 1 ? (
                              <div className="muted validation-hint">
                                This rule duplicates another rule in the current target.
                              </div>
                            ) : null}
                          </div>
                          <RuleEditor
                            rule={rule}
                            sortGroup={`rule-${index}`}
                            suggestions={rewritingNameSuggestions}
                            onRemove={() =>
                              commitRewriting((draft) => {
                                draft[rewritingCircle][rewritingTarget].splice(index, 1);
                              })
                            }
                            onChange={(nextRule) =>
                              commitRewriting((draft) => {
                                draft[rewritingCircle][rewritingTarget][index] = nextRule;
                              })
                            }
                          />
                        </div>
                      </div>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      commitRewriting((draft) => {
                        draft[rewritingCircle][rewritingTarget].push({ from: [], to: [] });
                      })
                    }
                  >
                    Add rule
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {editor && (
        <>
          <div className="panel">
            <div className="panel-header">
              <h2>Audit log</h2>
              <div className="muted">{visibleAuditLines.length} visible entries</div>
            </div>
            <div className="toolbar section-toolbar">
              <label>
                Filter
                <select
                  value={auditFilter}
                  onChange={(event) => setAuditFilter(event.target.value)}
                >
                  <option value="all">all</option>
                  {auditCodes.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={() => setAuditLog({})}>
                Clear log
              </button>
            </div>
            <div className="list audit-list">
              {visibleAuditLines.map((entry, index) => (
                <div className="card" key={`${entry.code}-${index}-${entry.line}`}>
                  <div className="muted">{entry.code}</div>
                  <div>{entry.line}</div>
                </div>
              ))}
              {visibleAuditLines.length === 0 ? <div className="muted">No audit entries.</div> : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function TrackEditor(props: {
  trackPath: string;
  track: TrackStructured;
  artistSuggestions: string[];
  artistsAfterRewriting: string[];
  genreAfterRewriting?: string;
  highlightedField?: "artists" | "genre";
  onCommit: (track: TrackStructured) => void;
}) {
  const {
    trackPath,
    track,
    artistSuggestions,
    artistsAfterRewriting,
    genreAfterRewriting,
    highlightedField,
    onCommit,
  } = props;
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const trackNumber = Number.isFinite(track["track number"])
    ? Number(track["track number"])
    : undefined;

  useEffect(() => {
    if (isEditingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [isEditingTitle]);

  const commitTitle = (rawTitle: string): void => {
    onCommit({ ...track, title: rawTitle });
    setIsEditingTitle(false);
  };

  const changeTrackNumber = (delta: number): void => {
    const next = Math.max(1, (trackNumber ?? 1) + delta);
    onCommit({ ...track, "track number": next });
  };

  return (
    <div className="card track-card">
      <div className="track-summary-row">
        <div
          className="track-drag-handle"
          aria-label={`Drag ${track.title || trackPath} to reorder`}
          title={`Drag ${track.title || trackPath} to reorder`}
        >
          <span />
        </div>
        <div className="track-title-cell">
          {isEditingTitle ? (
            <input
              ref={titleInputRef}
              className="track-title-input"
              defaultValue={track.title}
              onBlur={(event) => commitTitle(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitTitle(event.currentTarget.value);
                }
                if (event.key === "Escape") {
                  setIsEditingTitle(false);
                }
              }}
            />
          ) : (
            <h3 className="track-title" onDoubleClick={() => setIsEditingTitle(true)}>
              {track.title || "Untitled track"}
            </h3>
          )}
        </div>
        <input
          className="track-date-input"
          aria-label="Date"
          placeholder="Date"
          defaultValue={track.date ?? ""}
          onBlur={(event) => onCommit({ ...track, date: event.currentTarget.value || undefined })}
        />
        <div className="track-number-stepper" aria-label="Track number">
          <button
            type="button"
            aria-label="Decrease track number"
            onClick={() => changeTrackNumber(-1)}
            disabled={(trackNumber ?? 1) <= 1}
          >
            -
          </button>
          <span>{trackNumber ? `Track ${trackNumber}` : "Track"}</span>
          <button
            type="button"
            aria-label="Increase track number"
            onClick={() => changeTrackNumber(1)}
          >
            +
          </button>
        </div>
      </div>
      <div className="metadata-field-pair">
        <div className="field-group">
          <div className="field-label">Artists</div>
          <div className={highlightedField === "artists" ? "metadata-field-highlight" : undefined}>
            <TagInput
              value={track.artists}
              suggestions={artistSuggestions}
              onCommit={(artists) => onCommit({ ...track, artists })}
            />
          </div>
        </div>
        <ReadonlyTagList label="Artists (after rewriting)" values={artistsAfterRewriting} />
      </div>
      <div className="metadata-field-pair">
        <label>
          <div className="field-label">Genre</div>
          <input
            className={highlightedField === "genre" ? "metadata-field-highlight" : undefined}
            defaultValue={track.genre ?? ""}
            onBlur={(event) => onCommit({ ...track, genre: event.currentTarget.value || undefined })}
          />
        </label>
        <ReadonlyTagList
          label="Genre (after rewriting)"
          values={genreAfterRewriting ? [genreAfterRewriting] : []}
        />
      </div>
      <div className="track-path-group">
        <div className="field-label">File path</div>
        <div className="track-path">{trackPath}</div>
      </div>
    </div>
  );
}

function ImportPanel(props: {
  onImport: (files: {
    metadata?: File | null;
    structured?: File | null;
    rewriting?: File | null;
  }) => Promise<void>;
  onLoadDebugSample: () => Promise<void>;
}) {
  const metadataRef = useRef<HTMLInputElement | null>(null);
  const structuredRef = useRef<HTMLInputElement | null>(null);
  const rewritingRef = useRef<HTMLInputElement | null>(null);
  const [selectedFiles, setSelectedFiles] = useState({
    metadata: "",
    structured: "",
    rewriting: "",
  });
  const updateSelectedFile = (
    key: "metadata" | "structured" | "rewriting",
    input: HTMLInputElement | null,
  ): void => {
    setSelectedFiles((previous) => ({
      ...previous,
      [key]: input?.files?.[0]?.name ?? "",
    }));
  };
  return (
    <div className="import-panel">
      <div className="import-file-grid">
        <label className="file-picker">
          <input
            ref={metadataRef}
            className="visually-hidden"
            type="file"
            accept=".json"
            onChange={(event) => updateSelectedFile("metadata", event.currentTarget)}
          />
          <span className="file-picker-box">
            {selectedFiles.metadata || "Select metadata.json"}
          </span>
        </label>
        <label className="file-picker">
          <input
            ref={structuredRef}
            className="visually-hidden"
            type="file"
            accept=".json"
            onChange={(event) => updateSelectedFile("structured", event.currentTarget)}
          />
          <span className="file-picker-box">
            {selectedFiles.structured || "Select structured.json"}
          </span>
        </label>
        <label className="file-picker">
          <input
            ref={rewritingRef}
            className="visually-hidden"
            type="file"
            accept=".json"
            onChange={(event) => updateSelectedFile("rewriting", event.currentTarget)}
          />
          <span className="file-picker-box">
            {selectedFiles.rewriting || "Select rewriting.json"}
          </span>
        </label>
        <button
          type="button"
          className="import-primary-button"
          onClick={() =>
            props.onImport({
              metadata: metadataRef.current?.files?.[0],
              structured: structuredRef.current?.files?.[0],
              rewriting: rewritingRef.current?.files?.[0],
            })
          }
        >
          Import
        </button>
        <button type="button" onClick={() => void props.onLoadDebugSample()}>
          Debug sample
        </button>
      </div>
    </div>
  );
}

function SyncIndicator({ status }: { status: SyncStatus }): ReactNode {
  const label =
    status === "syncing"
      ? "Syncing"
      : status === "queued"
        ? "Queued"
        : status === "error"
          ? "Sync failed"
          : "Synced";
  return <div className={`sync-indicator sync-indicator-${status}`}>{label}</div>;
}

function ReadonlyTagList(props: { label: string; values: string[] }) {
  return (
    <div className="field-group">
      <div className="field-label">{props.label}</div>
      <div className="readonly-tag-list" aria-readonly="true">
        {props.values.length > 0 ? (
          props.values.map((value, index) => (
            <span className="readonly-tag" key={`${value}-${index}`}>
              {value}
            </span>
          ))
        ) : (
          <span className="muted">None</span>
        )}
      </div>
    </div>
  );
}

function getNameEntriesForTarget(
  circle: CircleRewriting | undefined,
  target: RewritingTarget,
): { name: string; count?: number }[] {
  if (!circle) {
    return [];
  }
  if (target === "artists rewriting") {
    return entriesFromCounts(circle["all artists"]);
  }
  if (target === "album artists rewriting") {
    return entriesFromCounts(circle["all album artists"]);
  }
  return circle["all genres"].map((name) => ({ name }));
}

function getNameHeaderForTarget(target: RewritingTarget): string {
  if (target === "artists rewriting") {
    return "All Artists";
  }
  if (target === "album artists rewriting") {
    return "All Album Artists";
  }
  return "All Genres";
}

function firstNonGlobalRewritingCircle(rewriting: RewritingData): string {
  return (
    Object.keys(rewriting)
      .filter((circle) => circle !== "$all")
      .sort((a, b) => a.localeCompare(b))[0] ?? ""
  );
}

function firstAlbumName(structured: StructuredData, circle: string): string {
  return (
    Object.keys(structured[circle]?.albums ?? {}).sort((a, b) => a.localeCompare(b))[0] ?? ""
  );
}

function mergeAuditLogs(previous: AuditLog, next: AuditLog): AuditLog {
  const merged: AuditLog = structuredClone(previous);
  for (const [code, lines] of Object.entries(next)) {
    const current = (merged[code] ??= []);
    for (const line of lines) {
      if (!current.includes(line)) {
        current.push(line);
      }
    }
  }
  return merged;
}

const REWRITE_TARGETS = [
  "artists rewriting",
  "album artists rewriting",
  "genre rewriting",
] satisfies RewritingTarget[];

function isInvalidRewriteRule(rule: RewriteRule): boolean {
  return (
    rule.from.filter((value) => value.trim().length > 0).length === 0 ||
    rule.to.filter((value) => value.trim().length > 0).length === 0
  );
}

function sanitizeRewritingForSync(rewriting: RewritingData): RewritingData {
  const sanitized = structuredClone(rewriting);
  for (const circle of Object.values(sanitized)) {
    for (const target of REWRITE_TARGETS) {
      circle[target] = circle[target]
        .map((rule) => ({
          from: rule.from.filter((value) => value.trim().length > 0),
          to: rule.to.filter((value) => value.trim().length > 0),
        }))
        .filter((rule) => !isInvalidRewriteRule(rule));
    }
  }
  return sanitized;
}

function preserveEditableRewritingRules(
  refreshed: RewritingData,
  source: RewritingData,
): RewritingData {
  const merged = structuredClone(refreshed);
  for (const [circleName, sourceCircle] of Object.entries(source)) {
    const targetCircle = merged[circleName];
    if (!targetCircle) {
      continue;
    }
    for (const target of REWRITE_TARGETS) {
      targetCircle[target] = structuredClone(sourceCircle[target]);
    }
    if (sourceCircle.audited !== undefined) {
      targetCircle.audited = sourceCircle.audited;
    }
    if (sourceCircle["default genre"] !== undefined) {
      targetCircle["default genre"] = sourceCircle["default genre"];
    } else {
      delete targetCircle["default genre"];
    }
  }
  return merged;
}

function findFirstRewrittenNameTarget(
  structured: StructuredData,
  rewriting: RewritingData,
  selectedCircle: string,
  target: RewritingTarget,
  name: string,
): HighlightTarget | undefined {
  const circleNames =
    selectedCircle && selectedCircle !== "$all"
      ? [selectedCircle]
      : Object.keys(structured).sort((a, b) => a.localeCompare(b));
  for (const circleName of circleNames) {
    const circle = structured[circleName];
    const circleRules = rewriting[circleName];
    if (!circle || !circleRules) {
      continue;
    }
    const globalRules = rewriting.$all;
    if (target === "album artists rewriting") {
      const lookup = compileRewriteLookup([
        ...circleRules["album artists rewriting"],
        ...(globalRules?.["album artists rewriting"] ?? []),
      ]);
      for (const [albumName, album] of Object.entries(circle.albums)) {
        if (rewriteValues(album["album artists"], lookup).includes(name)) {
          return { circle: circleName, album: albumName, field: "album artists" };
        }
      }
      continue;
    }
    if (target === "artists rewriting") {
      const lookup = compileRewriteLookup([
        ...circleRules["artists rewriting"],
        ...(globalRules?.["artists rewriting"] ?? []),
      ]);
      for (const [albumName, album] of Object.entries(circle.albums)) {
        for (const disc of album.discs) {
          for (const [trackPath, track] of Object.entries(disc.tracks)) {
            if (rewriteValues(track.artists, lookup).includes(name)) {
              return { circle: circleName, album: albumName, trackPath, field: "artists" };
            }
          }
        }
      }
      continue;
    }
    const lookup = compileRewriteLookup([
      ...circleRules["genre rewriting"],
      ...(globalRules?.["genre rewriting"] ?? []),
    ]);
    for (const [albumName, album] of Object.entries(circle.albums)) {
      for (const disc of album.discs) {
        for (const [trackPath, track] of Object.entries(disc.tracks)) {
          const initial = track.genre ?? circleRules["default genre"] ?? globalRules?.["default genre"];
          if (initial && (lookup.get(initial)?.[0] ?? initial) === name) {
            return { circle: circleName, album: albumName, trackPath, field: "genre" };
          }
        }
      }
    }
  }
  return undefined;
}

function rewriteValues(values: string[], lookup: Map<string, string[]>): string[] {
  return values.flatMap((value) => lookup.get(value) ?? [value]);
}

function rewriteMetadataValues(
  values: string[],
  rewriting: RewritingData,
  circle: string,
  target: Extract<RewritingTarget, "artists rewriting" | "album artists rewriting">,
): string[] {
  const circleRules = rewriting[circle]?.[target] ?? [];
  const globalRules = rewriting.$all?.[target] ?? [];
  return rewriteValues(values, compileRewriteLookup([...circleRules, ...globalRules]));
}

function rewriteMetadataGenre(
  genre: string | undefined,
  rewriting: RewritingData,
  circle: string,
): string | undefined {
  const circleRules = rewriting[circle];
  const globalRules = rewriting.$all;
  const initial = genre ?? circleRules?.["default genre"] ?? globalRules?.["default genre"];
  if (!initial) {
    return undefined;
  }
  const lookup = compileRewriteLookup([
    ...(circleRules?.["genre rewriting"] ?? []),
    ...(globalRules?.["genre rewriting"] ?? []),
  ]);
  return lookup.get(initial)?.[0] ?? initial;
}

function entriesFromCounts(counts: Record<string, number>): { name: string; count: number }[] {
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => ({ name, count }));
}

function parseRewriteCycleError(message: string): RewriteCycleSelection | undefined {
  const match =
    /rewrite cycle at \$\[(?<circle>"(?:\\.|[^"\\])*")\]\[(?<target>"(?:\\.|[^"\\])*")\] rules=(?<rules>\[[^\]]*\])/.exec(
      message,
    );
  if (!match?.groups) {
    return undefined;
  }
  try {
    const target = JSON.parse(match.groups.target) as string;
    if (
      target !== "artists rewriting" &&
      target !== "album artists rewriting" &&
      target !== "genre rewriting"
    ) {
      return undefined;
    }
    const rules = JSON.parse(match.groups.rules) as unknown;
    return {
      circle: JSON.parse(match.groups.circle) as string,
      target,
      rules: new Set(Array.isArray(rules) ? rules.filter((item) => typeof item === "number") : []),
    };
  } catch {
    return undefined;
  }
}

function reorderObjectByIndex<T>(
  value: Record<string, T>,
  oldIndex: number,
  newIndex: number,
): Record<string, T> {
  const entries = Object.entries(value);
  const [moved] = entries.splice(oldIndex, 1);
  entries.splice(newIndex, 0, moved);
  return Object.fromEntries(entries);
}

function applyTrackNumbersByOrder(
  tracks: Record<string, TrackStructured>,
): Record<string, TrackStructured> {
  return Object.fromEntries(
    Object.entries(tracks).map(([trackPath, track], index) => [
      trackPath,
      { ...track, "track number": index + 1 },
    ]),
  );
}

function DiscTrackList(props: {
  disc: {
    "$track numbers from order"?: boolean;
    tracks: Record<string, TrackStructured>;
  };
  discIndex: number;
  structuredCircle: string;
  structuredAlbum: string;
  commitStructured: (
    updater: (draft: EditorState) => void,
  ) => void;
  children: ReactNode;
}) {
  const {
    disc,
    discIndex,
    structuredCircle,
    structuredAlbum,
    commitStructured,
    children,
  } = props;
  const listRef = useRef<HTMLDivElement | null>(null);
  const sortableRef = useRef<Sortable | null>(null);

  useEffect(() => {
    sortableRef.current?.destroy();
    if (!listRef.current) {
      sortableRef.current = null;
      return;
    }
    sortableRef.current = Sortable.create(listRef.current, {
      animation: 120,
      handle: ".track-drag-handle",
      onEnd: ({ oldIndex, newIndex }: SortableEvent) => {
        if (oldIndex === undefined || newIndex === undefined || oldIndex === newIndex) {
          return;
        }
        commitStructured((draft) => {
          const currentDisc = draft.structured[structuredCircle].albums[structuredAlbum].discs[
            discIndex
          ];
          const reorderedTracks = reorderObjectByIndex(currentDisc.tracks, oldIndex, newIndex);
          currentDisc.tracks = applyTrackNumbersByOrder(reorderedTracks);
          currentDisc["$track numbers from order"] = true;
        });
      },
    });
    return () => {
      sortableRef.current?.destroy();
      sortableRef.current = null;
    };
  }, [disc, discIndex, structuredAlbum, structuredCircle]);

  return <div className="list" ref={listRef}>{children}</div>;
}

export type { RewriteRule };

function getRuleSignature(rule: RewriteRule): string {
  const from = [...rule.from].map((item) => item.trim()).sort((a, b) => a.localeCompare(b));
  const to = [...rule.to].map((item) => item.trim()).sort((a, b) => a.localeCompare(b));
  return `${from.join("\u001f")}=>${to.join("\u001f")}`;
}

function createDebugMetadata(): Record<string, Record<string, unknown>> {
  return {
    "DemoCircle/2024.01.01 - Demo Album/01 - Intro.flac": {
      Title: "Intro",
      Artists: ["Alice + Bob"],
      Date: "2024.01.01",
      Year: "2024",
      "Album artists": ["DemoCircle"],
      "Album title": "Demo Album",
      "Track number": 1,
      "Total tracks": 3,
      "Disc number": 1,
      "Total discs": 2,
      Genre: "Touhou",
    },
    "DemoCircle/2024.01.01 - Demo Album/02 - Theme.flac": {
      Title: "Theme",
      Artists: ["vo. Alice"],
      Date: "2024.01.01",
      Year: "2024",
      "Album artists": ["DemoCircle"],
      "Album title": "Demo Album",
      "Track number": 2,
      "Total tracks": 3,
      "Disc number": 1,
      "Total discs": 2,
      Genre: "Arrange",
    },
    "DemoCircle/2024.01.01 - Demo Album/Disc 2/01 - Encore.flac": {
      Title: "Encore",
      Artists: ["Ａｌｉｃｅ"],
      Date: "2024.01.01",
      Year: "2024",
      "Album artists": ["Demo Circle"],
      "Album title": "Demo Album",
      "Track number": 1,
      "Total tracks": 1,
      "Disc number": 2,
      "Total discs": 2,
      Genre: "Touhou",
    },
  };
}

function RuleEditor(props: {
  rule: RewriteRule;
  suggestions: string[];
  sortGroup: string;
  onRemove: () => void;
  onChange: (next: RewriteRule) => void;
}) {
  const { rule, suggestions, sortGroup, onRemove, onChange } = props;
  const [toDraft, setToDraft] = useState("");
  const draggingTagRef = useRef<{ side: "from" | "to"; index: number } | undefined>(
    undefined,
  );
  const handledTagDropRef = useRef(false);

  const addToTag = (): void => {
    const normalized = toDraft.trim();
    if (!normalized) {
      return;
    }
    onChange({ ...rule, to: [...rule.to, normalized] });
    setToDraft("");
  };

  const moveTag = (
    source: { side: "from" | "to"; index: number },
    toSide: "from" | "to",
  ): void => {
    if (source.side === toSide) {
      return;
    }
    if (source.side === "from") {
      const value = rule.from[source.index];
      if (!value) {
        return;
      }
      onChange({
        from: rule.from.filter((_, idx) => idx !== source.index),
        to: [...rule.to, value],
      });
    } else {
      const value = rule.to[source.index];
      if (!value) {
        return;
      }
      onChange({
        from: [...rule.from, value],
        to: rule.to.filter((_, idx) => idx !== source.index),
      });
    }
  };

  const startTagDrag = (
    event: React.DragEvent<HTMLSpanElement>,
    source: { side: "from" | "to"; index: number },
  ): void => {
    event.stopPropagation();
    draggingTagRef.current = source;
    handledTagDropRef.current = false;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-tlmc-rewrite-tag", JSON.stringify(source));
    event.dataTransfer.setData("text/plain", JSON.stringify(source));
  };

  const finishTagDrag = (event: React.DragEvent<HTMLSpanElement>): void => {
    event.stopPropagation();
    if (handledTagDropRef.current || !draggingTagRef.current) {
      draggingTagRef.current = undefined;
      handledTagDropRef.current = false;
      return;
    }
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const side = target?.closest(".rule-from-list")
      ? "from"
      : target?.closest(".rule-to-list")
        ? "to"
        : undefined;
    if (side) {
      moveTag(draggingTagRef.current, side);
    }
    draggingTagRef.current = undefined;
    handledTagDropRef.current = false;
  };

  const dropTag = (
    event: React.DragEvent<HTMLElement>,
    toSide: "from" | "to",
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    const payload =
      event.dataTransfer.getData("application/x-tlmc-rewrite-tag") ||
      event.dataTransfer.getData("text/plain");
    if (!payload) {
      return;
    }
    const source = parseDragPayload(payload);
    if (!source) {
      return;
    }
    handledTagDropRef.current = true;
    moveTag(source, toSide);
  };

  return (
    <div className="rule-tag-editor">
      <div
        className="tag-chip-list rule-from-list"
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => dropTag(event, "from")}
      >
        <div className="tag-chip-list-label">From</div>
        {rule.from.map((tag, index) => (
          <span
            className="tag-chip"
            data-tag={tag}
            draggable
            onDragStart={(event) => startTagDrag(event, { side: "from", index })}
            onDragEnd={finishTagDrag}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => dropTag(event, "from")}
            key={`${sortGroup}-from-${tag}-${index}`}
          >
            {tag}
            <button
              type="button"
              className="tag-chip-remove"
              aria-label={`Remove ${tag}`}
              onClick={() => onChange({ ...rule, from: rule.from.filter((_, i) => i !== index) })}
            >
              x
            </button>
          </span>
        ))}
      </div>
      <div
        className="tag-chip-list rule-to-list"
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => dropTag(event, "to")}
      >
        <div className="tag-chip-list-label">To</div>
        {rule.to.map((tag, index) => (
          <span
            className="tag-chip"
            data-tag={tag}
            draggable
            onDragStart={(event) => startTagDrag(event, { side: "to", index })}
            onDragEnd={finishTagDrag}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => dropTag(event, "to")}
            key={`${sortGroup}-to-${tag}-${index}`}
          >
            {tag}
            <button
              type="button"
              className="tag-chip-remove"
              aria-label={`Remove ${tag}`}
              onClick={() => onChange({ ...rule, to: rule.to.filter((_, i) => i !== index) })}
            >
              x
            </button>
          </span>
        ))}
      </div>
      <div className="rule-actions">
        <div className="add-name-control">
          <input
            list={`suggestions-${sortGroup}`}
            value={toDraft}
            placeholder="Add name..."
            onChange={(event) => setToDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addToTag();
              }
            }}
          />
          <button type="button" aria-label="Add name" onClick={addToTag}>
            +
          </button>
        </div>
        <button type="button" className="rule-remove-button" aria-label="Remove rule" onClick={onRemove}>
          x
        </button>
      </div>
      <datalist id={`suggestions-${sortGroup}`}>
        {suggestions.map((item) => (
          <option key={item} value={item} />
        ))}
      </datalist>
    </div>
  );
}

function parseDragPayload(
  raw: string,
): { side: "from" | "to"; index: number } | undefined {
  try {
    const parsed = JSON.parse(raw) as { side?: string; index?: number };
    if ((parsed.side === "from" || parsed.side === "to") && typeof parsed.index === "number") {
      return { side: parsed.side, index: parsed.index };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

interface PersistedSession {
  state: EditorState;
  audits: unknown;
}

function normalizeAuditLog(input: unknown): AuditLog {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const out: AuditLog = {};
  for (const [code, lines] of Object.entries(input as Record<string, unknown>)) {
    if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) {
      return {};
    }
    out[code] = lines as string[];
  }
  return out;
}

async function openDb(): Promise<IDBDatabase> {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveSession(session: PersistedSession): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(session, SESSION_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function loadSession(): Promise<PersistedSession | undefined> {
  const db = await openDb();
  const result = await new Promise<PersistedSession | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(SESSION_KEY);
    request.onsuccess = () => resolve(request.result as PersistedSession | undefined);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return result;
}
