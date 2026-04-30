import React, { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import Sortable, { type SortableEvent } from "sortablejs";
import type {
  CircleRewriting,
  RewritingData,
  RewriteRule,
  TrackStructured,
} from "../domain/models.js";
import { TagInput } from "./components/TagInput";
import type { AuditEntry, EditorState } from "./state/editor";
import { downloadJsonFile } from "./utils/json";

type TabKey = "structured" | "rewriting";
type RewritingTarget = "artists rewriting" | "album artists rewriting" | "genre rewriting";
type AuditFilter = "all" | string;
type WorkerResponse =
  | { id: number; ok: true; type: "import"; state: EditorState; audits: AuditEntry[] }
  | { id: number; ok: true; type: "sync"; state: EditorState; audits: AuditEntry[] }
  | { id: number; ok: true; type: "compute-updates"; updates: unknown }
  | { id: number; ok: false; error: string };
const DB_NAME = "tlmc-gui";
const STORE_NAME = "session";
const SESSION_KEY = "latest";

export function App() {
  const [editor, setEditor] = useState<EditorState | undefined>(undefined);
  const [audits, setAudits] = useState<AuditEntry[]>([]);
  const [auditFilter, setAuditFilter] = useState<AuditFilter>("all");
  const [statusMessage, setStatusMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [tab, setTab] = useState<TabKey>("structured");
  const [structuredCircle, setStructuredCircle] = useState("");
  const [structuredAlbum, setStructuredAlbum] = useState("");
  const [rewritingCircle, setRewritingCircle] = useState("");
  const [rewritingTarget, setRewritingTarget] =
    useState<RewritingTarget>("artists rewriting");

  const discListRef = useRef<HTMLDivElement | null>(null);
  const rulesRef = useRef<HTMLDivElement | null>(null);
  const discSortableRef = useRef<Sortable | null>(null);
  const ruleSortableRef = useRef<Sortable | null>(null);
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
  const rewritingRules = rewritingCircleData?.[rewritingTarget] ?? [];
  const auditCodes = useMemo(
    () => [...new Set(audits.map((entry) => entry.code))].sort((a, b) => a.localeCompare(b)),
    [audits],
  );
  const visibleAudits = useMemo(
    () => (auditFilter === "all" ? audits : audits.filter((entry) => entry.code === auditFilter)),
    [auditFilter, audits],
  );

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
        setRewritingCircle(saved.state.rewriting.$all ? "$all" : firstCircle);
        setAudits(saved.audits ?? []);
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
    void saveSession({ state: editor, audits }).catch(() => {
      setStatusMessage("Warning: failed to persist session.");
    });
  }, [editor, audits]);

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
    state: EditorState;
  }): Promise<WorkerResponse>;
  async function callWorker(request: {
    type: "compute-updates";
    state: EditorState;
  }): Promise<WorkerResponse>;
  async function callWorker(
    request:
      | { type: "import"; metadataText: string; structuredText?: string; rewritingText?: string }
      | { type: "sync"; state: EditorState }
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
      setAudits(response.audits);
      setAuditFilter("all");
      setStructuredCircle(firstCircle);
      setStructuredAlbum(firstAlbum);
      setRewritingCircle(initial.rewriting.$all ? "$all" : firstCircle);
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
    setAudits(response.audits);
    setAuditFilter("all");
    setStructuredCircle(firstCircle);
    setStructuredAlbum(firstAlbum);
    setRewritingCircle(initial.rewriting.$all ? "$all" : firstCircle);
    setStatusMessage("Loaded debug sample.");
    setIsLoading(false);
  }

  async function onSync(): Promise<void> {
    if (!editor) {
      return;
    }
    setIsLoading(true);
    const response = await callWorker({ type: "sync", state: editor });
    if (!response.ok || response.type !== "sync") {
      setStatusMessage(`Sync failed: ${response.ok ? "Unexpected response." : response.error}`);
      setIsLoading(false);
      return;
    }
    setEditor(response.state);
    setAudits((previous) => [...previous, ...response.audits]);
    setStatusMessage("Sync complete.");
    setIsLoading(false);
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
          <div className="panel row">
            <label>
              View
              <select value={tab} onChange={(event) => setTab(event.target.value as TabKey)}>
                <option value="structured">structured.json</option>
                <option value="rewriting">rewriting.json</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => void onSync()}
            >
              Sync now
            </button>
            <button type="button" onClick={() => downloadJsonFile("structured.json", editor.structured)}>
              Download structured.json
            </button>
            <button type="button" onClick={() => downloadJsonFile("rewriting.json", editor.rewriting)}>
              Download rewriting.json
            </button>
            <button
              type="button"
              onClick={() => void onDownloadUpdates()}
            >
              Download update-metadata.json
            </button>
          </div>

          {tab === "structured" ? (
            <div className="panel">
              <h2>structured.json editor</h2>
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
                    Album name
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

                  <div>
                    <div>Album artists</div>
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

                  <div className="list" ref={discListRef}>
                    {selectedAlbum.discs.map((disc, discIndex) => (
                      <div className="card" key={`${discIndex}-${Object.keys(disc.tracks).join(":")}`}>
                        <div className="track-header">
                          <strong>Disc {discIndex + 1}</strong>
                        </div>
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
              <h2>rewriting.json editor</h2>
              <div className="row">
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
              <div className="split">
                <div className="card">
                  <h3>Names</h3>
                  <div className="list">
                    {getNamesForTarget(rewritingCircleData, rewritingTarget).map((name) => (
                      <div key={name}>{name}</div>
                    ))}
                  </div>
                </div>
                <div className="card">
                  <h3>Rules</h3>
                  <div className="list" ref={rulesRef}>
                    {rewritingRules.map((rule, index) => (
                      <div className="card" key={`${index}-${rule.from.join("|")}-${rule.to.join("|")}`}>
                        <div className="rule-header">
                          <strong>Rule {index + 1}</strong>
                          <button
                            type="button"
                            onClick={() =>
                              commitRewriting((draft) => {
                                draft[rewritingCircle][rewritingTarget].splice(index, 1);
                              })
                            }
                          >
                            Remove
                          </button>
                        </div>
                        <div className="muted">from</div>
                        <TagInput
                          value={rule.from}
                          suggestions={getNamesForTarget(rewritingCircleData, rewritingTarget)}
                          onCommit={(nextFrom) =>
                            commitRewriting((draft) => {
                              draft[rewritingCircle][rewritingTarget][index].from = nextFrom;
                            })
                          }
                        />
                        <div className="muted">to</div>
                        <TagInput
                          value={rule.to}
                          suggestions={getNamesForTarget(rewritingCircleData, rewritingTarget)}
                          onCommit={(nextTo) =>
                            commitRewriting((draft) => {
                              draft[rewritingCircle][rewritingTarget][index].to = nextTo;
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
          <div className="panel">
            <h2>Audit log</h2>
            <div className="row">
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
              <button type="button" onClick={() => setAudits([])}>
                Clear log
              </button>
            </div>
            <div className="list audit-list">
              {visibleAudits.map((entry, index) => (
                <div className="card" key={`${entry.code}-${index}`}>
                  <div className="muted">{entry.code}</div>
                  <div>{entry.message}</div>
                </div>
              ))}
              {visibleAudits.length === 0 ? <div className="muted">No audit entries.</div> : null}
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
  onCommit: (track: TrackStructured) => void;
}) {
  const { trackPath, track, artistSuggestions, onCommit } = props;
  return (
    <div className="card">
      <div className="muted">{trackPath}</div>
      <label>
        Title
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
      <div>
        <div>Artists</div>
        <TagInput
          value={track.artists}
          suggestions={artistSuggestions}
          onCommit={(artists) => onCommit({ ...track, artists })}
        />
      </div>
      <div className="row">
        <label>
          Track number
          <input
            type="number"
            defaultValue={track["track number"]}
            onBlur={(event) =>
              onCommit({
                ...track,
                "track number": Number(event.currentTarget.value || track["track number"]),
              })
            }
          />
        </label>
        <label>
          Date
          <input
            defaultValue={track.date ?? ""}
            onBlur={(event) => onCommit({ ...track, date: event.currentTarget.value || undefined })}
          />
        </label>
        <label>
          Genre
          <input
            defaultValue={track.genre ?? ""}
            onBlur={(event) => onCommit({ ...track, genre: event.currentTarget.value || undefined })}
          />
        </label>
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
  );
}

function getNamesForTarget(
  circle: CircleRewriting | undefined,
  target: RewritingTarget,
): string[] {
  if (!circle) {
    return [];
  }
  if (target === "artists rewriting") {
    return Object.keys(circle["all artists"]).sort((a, b) => a.localeCompare(b));
  }
  if (target === "album artists rewriting") {
    return Object.keys(circle["all album artists"]).sort((a, b) => a.localeCompare(b));
  }
  return [...circle["all genres"]];
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

function DiscTrackList(props: {
  disc: { tracks: Record<string, TrackStructured> };
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
          currentDisc.tracks = reorderObjectByIndex(currentDisc.tracks, oldIndex, newIndex);
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
      "Total tracks": 2,
      "Disc number": 1,
      "Total discs": 1,
      Genre: "Touhou",
    },
    "DemoCircle/2024.01.01 - Demo Album/02 - Theme.flac": {
      Title: "Theme",
      Artists: ["Alice"],
      Date: "2024.01.01",
      Year: "2024",
      "Album artists": ["DemoCircle"],
      "Album title": "Demo Album",
      "Track number": 2,
      "Total tracks": 2,
      "Disc number": 1,
      "Total discs": 1,
      Genre: "Arrange",
    },
  };
}

interface PersistedSession {
  state: EditorState;
  audits: AuditEntry[];
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
