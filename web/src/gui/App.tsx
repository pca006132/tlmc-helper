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

  const discListRef = useRef<HTMLDivElement | null>(null);
  const rulesRef = useRef<HTMLDivElement | null>(null);
  const discSortableRef = useRef<Sortable | null>(null);
  const ruleSortableRef = useRef<Sortable | null>(null);
  const highlightTimeoutRef = useRef<number | undefined>(undefined);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
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
        setEditor(saved.state);
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
        setStatusMessage("Restored previous session.");
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
    setEditor((previous) => {
      if (!previous) {
        return previous;
      }
      const draft = structuredClone(previous);
      updater(draft);
      return draft;
    });
    setStatusMessage("Local edits updated. Press Sync now to recompute rewriting.");
  }

  function commitRewriting(updater: (draft: RewritingData) => void): void {
    setEditor((previous) => {
      if (!previous) {
        return previous;
      }
      const draft = structuredClone(previous);
      updater(draft.rewriting);
      return draft;
    });
    setStatusMessage("Local edits updated. Press Sync now to recompute rewriting.");
  }

  useEffect(() => {
    discSortableRef.current?.destroy();
    if (!discListRef.current || !selectedAlbum) {
      discSortableRef.current = null;
      return;
    }
    discSortableRef.current = Sortable.create(discListRef.current, {
      animation: 120,
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
      handle: ".rule-header",
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
      setEditor(initial);
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
    setEditor(initial);
    setAuditFilter("all");
    setStructuredCircle(firstCircle);
    setStructuredAlbum(firstAlbum);
    setRewritingCircle(firstNonGlobalRewritingCircle(initial.rewriting) || firstCircle);
    setRewriteCycleSelection(undefined);
    setStatusMessage("Loaded debug sample.");
    setAuditLog(normalizeAuditLog(response.audits));
    setIsLoading(false);
  }

  async function syncEditor(nextEditor: EditorState): Promise<void> {
    if (!nextEditor) {
      return;
    }
    setIsLoading(true);
    const response = await callWorker({
      type: "sync",
      structured: nextEditor.structured,
      rewriting: nextEditor.rewriting,
    });
    if (!response.ok || response.type !== "sync") {
      const cycleSelection = response.ok ? undefined : parseRewriteCycleError(response.error);
      if (cycleSelection) {
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
      setStatusMessage(`Sync failed: ${response.ok ? "Unexpected response." : response.error}`);
      setIsLoading(false);
      return;
    }
    setEditor((previous) =>
      previous
        ? {
            ...previous,
            structured: response.structured,
            rewriting: response.rewriting,
          }
        : previous,
    );
    setAuditLog((previous) => mergeAuditLogs(previous, normalizeAuditLog(response.audits)));
    setRewriteCycleSelection(undefined);
    setStatusMessage("Sync complete.");
    setIsLoading(false);
  }

  async function onSync(): Promise<void> {
    if (!editor) {
      return;
    }
    await syncEditor(editor);
  }

  async function onAuditedChange(checked: boolean): Promise<void> {
    if (!editor || !rewritingCircle || rewritingCircle === "$all") {
      return;
    }
    const nextEditor = structuredClone(editor);
    nextEditor.rewriting[rewritingCircle].audited = checked;
    setEditor(nextEditor);
    setStatusMessage("Audited state updated. Syncing.");
    await syncEditor(nextEditor);
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
    if (!editor) {
      return;
    }
    setIsLoading(true);
    const response = await callWorker({ type: "compute-updates", state: editor });
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

  return (
    <div className="app">
      {isLoading ? (
        <div className="overlay">
          <div className="spinner" />
        </div>
      ) : null}
      <div className="panel">
        <h2>Import</h2>
        <ImportPanel onImport={onImport} onLoadDebugSample={onLoadDebugSample} />
        {statusMessage ? <div className="muted">{statusMessage}</div> : null}
      </div>

      {editor && (
        <>
          <div className="panel">
            <h2>Workspace</h2>
            <div className="toolbar workspace-toolbar">
              <div className="row">
                <label>
                  <select value={tab} onChange={(event) => onTabChange(event.target.value as TabKey)}>
                    <option value="structured">Album Metadata</option>
                    <option value="rewriting">Rewrite Rules</option>
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => void onSync()}
                >
                  Sync now
                </button>
              </div>
              <div className="full-row">
                <div className="field-label">Download</div>
                <div className="row row-tight">
                  <button type="button" onClick={() => downloadJsonFile("structured.json", editor.structured)}>
                    structured.json
                  </button>
                  <button type="button" onClick={() => downloadJsonFile("rewriting.json", editor.rewriting)}>
                    rewriting.json
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDownloadUpdates()}
                  >
                    update-metadata.json
                  </button>
                </div>
              </div>
            </div>
          </div>

          {tab === "structured" ? (
            <div className="panel">
              <h2>Album Metadata</h2>
              <div className="row">
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

              {selectedAlbum && structuredCircleData && (
                <div className="list">
                  <label>
                    <div className="field-label">Album name</div>
                    <input
                      className="grow"
                      defaultValue={structuredAlbum}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") {
                          return;
                        }
                        const nextName = (event.currentTarget.value || "").trim();
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
                      }}
                    />
                  </label>

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
                      <div className="card" key={`${discIndex}-${Object.keys(disc.tracks).join(":")}`}>
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
                        <label className="row row-tight">
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
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="panel">
              <h2>Rewrite Rules</h2>
              <div className="toolbar">
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
                <label>
                  Rewrite target
                  <select
                    value={rewritingTarget}
                    onChange={(event) => setRewritingTarget(event.target.value as RewritingTarget)}
                  >
                    <option value="artists rewriting">artists rewriting</option>
                    <option value="album artists rewriting">album artists rewriting</option>
                    <option value="genre rewriting">genre rewriting</option>
                  </select>
                </label>
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
              <div className="split rewrite-split">
                <div className="card">
                  <h3>{rewritingNameHeader}</h3>
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
                <div className="card">
                  <h3>Rules</h3>
                  <div className="muted">
                    Drag rule cards to reorder. In each rule, the first name list is `from` and the second
                    list is `to`. You can drag names between the two lists.
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
          <div className="panel">
            <h2>Audit log</h2>
            <div className="row row-align-end">
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
  return (
    <div className="card">
      <div className="muted">{trackPath}</div>
      <label>
        <div className="field-label">Title</div>
        <input
          defaultValue={track.title}
          onBlur={(event) => onCommit({ ...track, title: event.currentTarget.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onCommit({ ...track, title: event.currentTarget.value });
            }
          }}
        />
      </label>
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
      <div className="row">
        <label>
          <div className="field-label">Track number</div>
          <input
            type="number"
            defaultValue={track["track number"] ?? ""}
            onBlur={(event) => {
              const raw = event.currentTarget.value.trim();
              const parsed = raw ? Number(raw) : undefined;
              onCommit({
                ...track,
                "track number":
                  parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
              });
            }}
          />
        </label>
        <label>
          <div className="field-label">Date</div>
          <input
            defaultValue={track.date ?? ""}
            onBlur={(event) => onCommit({ ...track, date: event.currentTarget.value || undefined })}
          />
        </label>
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
  return (
    <div className="list">
      <div className="row">
        <label>
          metadata.json
          <input ref={metadataRef} type="file" accept=".json" />
        </label>
        <label>
          structured.json (optional)
          <input ref={structuredRef} type="file" accept=".json" />
        </label>
        <label>
          rewriting.json (optional)
          <input ref={rewritingRef} type="file" accept=".json" />
        </label>
      </div>
      <div className="row row-align-end">
        <button
          type="button"
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
          Load debug sample
        </button>
      </div>
    </div>
  );
}

function ReadonlyTagList(props: { label: string; values: string[] }) {
  return (
    <div className="field-group">
      <div className="field-label">{props.label}</div>
      <div className="readonly-tag-list" aria-readonly="true">
        {props.values.length > 0 ? (
          props.values.map((value) => (
            <span className="readonly-tag" key={value}>
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
      "Total discs": 1,
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
      "Total discs": 1,
      Genre: "Arrange",
    },
    "DemoCircle/2024.01.01 - Demo Album/03 - Encore.flac": {
      Title: "Encore",
      Artists: ["Ａｌｉｃｅ"],
      Date: "2024.01.01",
      Year: "2024",
      "Album artists": ["Demo Circle"],
      "Album title": "Demo Album",
      "Track number": 3,
      "Total tracks": 3,
      "Disc number": 1,
      "Total discs": 1,
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

  return (
    <div className="rule-tag-editor">
      <div
        className="tag-chip-list"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const payload = event.dataTransfer.getData("text/plain");
          if (!payload) {
            return;
          }
          const source = parseDragPayload(payload);
          if (!source) {
            return;
          }
          moveTag(source, "from");
        }}
      >
        {rule.from.map((tag, index) => (
          <span
            className="tag-chip"
            data-tag={tag}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(
                "text/plain",
                JSON.stringify({ side: "from", index }),
              );
            }}
            key={`${sortGroup}-from-${tag}-${index}`}
          >
            {tag}
            <button
              type="button"
              className="tag-chip-remove"
              onClick={() => onChange({ ...rule, from: rule.from.filter((_, i) => i !== index) })}
            >
              x
            </button>
          </span>
        ))}
      </div>
      <div
        className="tag-chip-list"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const payload = event.dataTransfer.getData("text/plain");
          if (!payload) {
            return;
          }
          const source = parseDragPayload(payload);
          if (!source) {
            return;
          }
          moveTag(source, "to");
        }}
      >
        {rule.to.map((tag, index) => (
          <span
            className="tag-chip"
            data-tag={tag}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(
                "text/plain",
                JSON.stringify({ side: "to", index }),
              );
            }}
            key={`${sortGroup}-to-${tag}-${index}`}
          >
            {tag}
            <button
              type="button"
              className="tag-chip-remove"
              onClick={() => onChange({ ...rule, to: rule.to.filter((_, i) => i !== index) })}
            >
              x
            </button>
          </span>
        ))}
      </div>
      <div className="row rule-actions">
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
        <button type="button" onClick={addToTag}>
          Add name
        </button>
        <button type="button" className="rule-remove-button" onClick={onRemove}>
          Remove
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
