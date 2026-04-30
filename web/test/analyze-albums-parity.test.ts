import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { runPhase1, runPhase3 } from "../src/core/api.js";
import type {
  AnalyzeLogger,
  LogEntry,
} from "../src/core/logger.js";
import type { MetadataMap, RewritingData } from "../src/domain/models.js";

class CaptureLogger implements AnalyzeLogger {
  public readonly entries: LogEntry[] = [];

  public log(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

describe("analyze-albums TypeScript parity", () => {
  test("auto-generates rules for newly discovered circles", () => {
    const metadata: MetadataMap = {
      "CircleA/2024.01.01 Album/01.mp3": {
        Title: "A",
        Artists: ["Known"],
        "Album artists": ["Known"],
        "Track number": 1,
      },
      "CircleB/2024.01.01 Album/01.mp3": {
        Title: "B",
        Artists: ["vo. Alice"],
        "Album artists": ["vo. Alice"],
        "Track number": 1,
      },
    };
    const existingRewriting: RewritingData = {
      CircleA: emptyCircleRewriting(),
      $all: emptyCircleRewriting(),
    };
    const logger = new CaptureLogger();
    const phase1 = runPhase1({ metadata, existingRewriting }, logger);

    expect(phase1.rewriting.CircleB["artists rewriting"].length).toBeGreaterThan(0);
    expect(phase1.rewriting.CircleB["album artists rewriting"].length).toBeGreaterThan(0);
  });

  test("emits structured build audits when structured is rebuilt", () => {
    const metadata: MetadataMap = {
      "CircleA/2024.01.01 Album/01.mp3": {
        Title: "A",
        Artists: [],
        "Album artists": ["CircleA"],
      },
    };
    const logger = new CaptureLogger();
    runPhase1({ metadata }, logger);

    const missingInfo = logger.entries.filter((entry) => entry.code === "missing_info");
    expect(missingInfo.length).toBeGreaterThan(0);
  });

  test("structured build preserves joined artist fields and generates split rules separately", () => {
    const metadata: MetadataMap = {
      "CircleA/2024.01.01 Album/01.mp3": {
        Title: "A",
        Artists: ["Alice + Bob"],
        "Album artists": ["CircleA"],
        "Track number": 1,
      },
    };
    const logger = new CaptureLogger();
    const phase1 = runPhase1({ metadata }, logger);

    const track =
      phase1.structured.CircleA.albums.Album.discs[0].tracks[
        "CircleA/2024.01.01 Album/01.mp3"
      ];
    expect(track.artists).toEqual(["Alice + Bob"]);
    expect(phase1.rewriting.CircleA["artists rewriting"]).toContainEqual({
      from: ["Alice + Bob"],
      to: ["Alice", "Bob"],
    });
  });

  test("rewrites matching numeric title prefixes and audits album", () => {
    const metadata: MetadataMap = {
      "CircleA/2024.01.01 Album/01.mp3": {
        Title: "[01]. Intro",
        Artists: ["CircleA"],
        "Album artists": ["CircleA"],
        "Track number": 1,
      },
      "CircleA/2024.01.01 Album/02.mp3": {
        Title: "02. Second",
        Artists: ["CircleA"],
        "Album artists": ["CircleA"],
        "Track number": 2,
      },
      "CircleA/2024.01.01 Album/10.mp3": {
        Title: "(10) Tenth",
        Artists: ["CircleA"],
        "Album artists": ["CircleA"],
        "Track number": 10,
      },
    };
    const logger = new CaptureLogger();
    const phase1 = runPhase1({ metadata }, logger);

    const tracks = phase1.structured.CircleA.albums.Album.discs[0].tracks;
    expect(
      tracks[
        "CircleA/2024.01.01 Album/01.mp3"
      ].title,
    ).toBe("Intro");
    expect(
      tracks[
        "CircleA/2024.01.01 Album/02.mp3"
      ].title,
    ).toBe("Second");
    expect(
      tracks[
        "CircleA/2024.01.01 Album/10.mp3"
      ].title,
    ).toBe("Tenth");

    const rewriteAudit = logger.entries.filter(
      (entry) => entry.code === "track_title_rewrite",
    );
    expect(rewriteAudit.map((entry) => entry.message)).toContain("CircleA/Album");
  });

  test("update generation includes Year and Total tracks when needed", () => {
    const metadata: MetadataMap = {
      "CircleA/2024.01.01 Album/01.mp3": {
        Title: "Song",
        Artists: ["Old"],
        "Album artists": ["Old"],
        "Track number": 1,
        "Disc number": 1,
        "Total discs": 1,
        Date: "2024.01.01",
        Genre: "Pop",
        Comment: "Keep",
      },
    };
    const logger = new CaptureLogger();
    const phase1 = runPhase1(
      {
        metadata,
        existingRewriting: {
          CircleA: {
            ...emptyCircleRewriting(),
            "artists rewriting": [{ from: ["Old"], to: ["New"] }],
            "album artists rewriting": [{ from: ["Old"], to: ["New"] }],
          },
          $all: emptyCircleRewriting(),
        },
      },
      logger,
    );
    const phase3 = runPhase3(
      {
        metadata,
        structured: phase1.structured,
        rewriting: phase1.rewriting,
      },
      logger,
    );

    const patch = phase3.updates["CircleA/2024.01.01 Album/01.mp3"];
    expect(patch.Artists).toEqual(["New"]);
    expect(patch["Album artists"]).toEqual(["New"]);
    expect(patch.Year).toBe("2024");
    expect(patch["Total tracks"]).toBe(1);
  });

  test("applies chained rewriting rules and rejects cycles", () => {
    const metadata: MetadataMap = {
      "CircleA/2024.01.01 Album/01.mp3": {
        Title: "Song",
        Artists: ["Old"],
        "Album artists": ["Old"],
        "Track number": 1,
      },
    };
    const logger = new CaptureLogger();
    const rewriting: RewritingData = {
      CircleA: {
        ...emptyCircleRewriting(),
        "artists rewriting": [
          { from: ["Old"], to: ["Middle"] },
          { from: ["Middle"], to: ["New"] },
        ],
        "album artists rewriting": [
          { from: ["Old"], to: ["Middle"] },
          { from: ["Middle"], to: ["New"] },
        ],
      },
      $all: emptyCircleRewriting(),
    };
    const phase1 = runPhase1({ metadata, existingRewriting: rewriting }, logger);
    const phase3 = runPhase3(
      { metadata, structured: phase1.structured, rewriting: phase1.rewriting },
      logger,
    );

    expect(phase3.updates["CircleA/2024.01.01 Album/01.mp3"].Artists).toEqual(["New"]);
    expect(() =>
      runPhase1({
        metadata,
        existingRewriting: {
          CircleA: {
            ...emptyCircleRewriting(),
            "artists rewriting": [
              { from: ["Old"], to: ["Middle"] },
              { from: ["Middle"], to: ["Old"] },
            ],
          },
        },
      }, logger),
    ).toThrow(/rewrite cycle/);
  });

  test("uses global known names for aggressive split generation", () => {
    const metadata: MetadataMap = {
      "CircleA/2024.01.01 Album/01.mp3": {
        Title: "A",
        Artists: ["Alice"],
        "Album artists": ["CircleA"],
        "Track number": 1,
      },
      "CircleB/2024.01.01 Album/01.mp3": {
        Title: "B",
        Artists: ["Alice/Bob"],
        "Album artists": ["CircleB"],
        "Track number": 1,
      },
    };
    const logger = new CaptureLogger();
    const phase1 = runPhase1({ metadata }, logger);

    expect(phase1.rewriting.CircleB["artists rewriting"]).toContainEqual({
      from: ["Alice/Bob"],
      to: ["Alice", "Bob"],
    });
  });

  test("saturates generated split rule outputs through normalization", () => {
    const metadata: MetadataMap = {
      "CircleA/2024.01.01 Album/01.mp3": {
        Title: "A",
        Artists: ["Bob"],
        "Album artists": ["CircleA"],
        "Track number": 1,
      },
      "CircleA/2024.01.01 Album/02.mp3": {
        Title: "B",
        Artists: ["Alice + ＢＯＢ"],
        "Album artists": ["CircleA"],
        "Track number": 2,
      },
    };
    const logger = new CaptureLogger();
    const phase1 = runPhase1({ metadata }, logger);

    expect(phase1.rewriting.CircleA["artists rewriting"]).toContainEqual({
      from: ["Alice + ＢＯＢ"],
      to: ["Alice", "Bob"],
    });
  });

  test("uses the first ordered low-confidence capture result", () => {
    const metadata: MetadataMap = {
      "CircleA/2024.01.01 Album/01.mp3": {
        Title: "A",
        Artists: ["Circle"],
        "Album artists": ["CircleA"],
        "Track number": 1,
      },
      "CircleA/2024.01.01 Album/02.mp3": {
        Title: "B",
        Artists: ["Alice (Circle)"],
        "Album artists": ["CircleA"],
        "Track number": 2,
      },
    };
    const logger = new CaptureLogger();
    const phase1 = runPhase1({ metadata }, logger);

    expect(phase1.rewriting.CircleA["artists rewriting"]).toContainEqual({
      from: ["Alice (Circle)"],
      to: ["Circle"],
    });
  });

  test("refreshes per-circle genres with genre rewriting and default genre", () => {
    const metadata: MetadataMap = {
      "CircleA/2024.01.01 Album/01.mp3": {
        Title: "A",
        Artists: ["CircleA"],
        "Album artists": ["CircleA"],
        "Track number": 1,
        Genre: "Soundtrack",
      },
      "CircleA/2024.01.01 Album/02.mp3": {
        Title: "B",
        Artists: ["CircleA"],
        "Album artists": ["CircleA"],
        "Track number": 2,
      },
    };
    const logger = new CaptureLogger();
    const phase1 = runPhase1({
      metadata,
      existingRewriting: {
        CircleA: {
          ...emptyCircleRewriting(),
          "genre rewriting": [{ from: ["Soundtrack"], to: ["Touhou"] }],
          "default genre": "Arrange",
        },
        $all: emptyCircleRewriting(),
      },
    }, logger);

    expect(phase1.rewriting.CircleA["all genres"]).toEqual(["Arrange", "Touhou"]);
  });

  test("normalizes CJK variants for generated simple rules", () => {
    const metadata: MetadataMap = {
      "CircleA/2024.01.01 Album/01.mp3": {
        Title: "A",
        Artists: ["乐团"],
        "Album artists": ["CircleA"],
        "Track number": 1,
      },
      "CircleA/2024.01.01 Album/02.mp3": {
        Title: "B",
        Artists: ["乐团"],
        "Album artists": ["CircleA"],
        "Track number": 2,
      },
      "CircleA/2024.01.01 Album/03.mp3": {
        Title: "C",
        Artists: ["樂團"],
        "Album artists": ["CircleA"],
        "Track number": 3,
      },
      "CircleA/2024.01.01 Album/04.mp3": {
        Title: "D",
        Artists: ["楽団"],
        "Album artists": ["CircleA"],
        "Track number": 4,
      },
    };
    const logger = new CaptureLogger();
    const phase1 = runPhase1({ metadata }, logger);

    expect(phase1.rewriting.CircleA["artists rewriting"]).toContainEqual({
      from: ["楽団", "樂團"],
      to: ["乐团"],
    });
  });

  test("cli supports circle filtering", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tlmc-web-cli-"));
    try {
      const metadata: MetadataMap = {
        "CircleA/2024.01.01 Album/01.mp3": {
          Title: "Song A",
          Artists: ["OldA"],
          "Album artists": ["OldA"],
          "Track number": 1,
          "Disc number": 1,
          "Total discs": 1,
        },
        "CircleB/2024.01.01 Album/01.mp3": {
          Title: "Song B",
          Artists: ["OldB"],
          "Album artists": ["OldB"],
          "Track number": 1,
          "Disc number": 1,
          "Total discs": 1,
        },
      };
      const rewriting: RewritingData = {
        CircleA: {
          ...emptyCircleRewriting(),
          "artists rewriting": [{ from: ["OldA"], to: ["NewA"] }],
          "album artists rewriting": [{ from: ["OldA"], to: ["NewA"] }],
        },
        $all: emptyCircleRewriting(),
      };
      fs.writeFileSync(
        path.join(tmpDir, "metadata.json"),
        `${JSON.stringify(metadata, null, 2)}\n`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "rewriting.json"),
        `${JSON.stringify(rewriting, null, 2)}\n`,
      );

      execFileSync(
        path.join(process.cwd(), "node_modules", ".bin", "tsx"),
        [path.join(process.cwd(), "src/cli/analyze-albums.ts"), "CircleA"],
        { cwd: tmpDir, stdio: "pipe" },
      );

      const update = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "update-metadata.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(Object.keys(update)).toEqual(["CircleA/2024.01.01 Album/01.mp3"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("update generation uses edited structured album names", () => {
    const metadata: MetadataMap = {
      "CircleA/2024.01.01 Folder Name/01.mp3": {
        Title: "Song",
        Artists: ["CircleA"],
        "Album artists": ["CircleA"],
        "Album title": "Folder Name",
        "Track number": 1,
      },
    };
    const logger = new CaptureLogger();
    const phase1 = runPhase1({ metadata }, logger);
    const structured = structuredClone(phase1.structured);
    const album = structured.CircleA.albums["Folder Name"];
    delete structured.CircleA.albums["Folder Name"];
    structured.CircleA.albums["Edited Album"] = album;

    const phase3 = runPhase3(
      { metadata, structured, rewriting: phase1.rewriting },
      logger,
    );

    expect(phase3.updates["CircleA/2024.01.01 Folder Name/01.mp3"]["Album title"]).toBe(
      "Edited Album",
    );
  });

  test("sync merges new metadata tracks into existing structured data", () => {
    const initialMetadata: MetadataMap = {
      "CircleA/2024.01.01 Album/01.mp3": {
        Title: "One",
        Artists: ["CircleA"],
        "Album artists": ["CircleA"],
        "Track number": 1,
      },
    };
    const rescannedMetadata: MetadataMap = {
      ...initialMetadata,
      "CircleA/2024.01.01 Album/02.mp3": {
        Title: "Two",
        Artists: ["CircleA"],
        "Album artists": ["CircleA"],
        "Track number": 2,
      },
    };
    const logger = new CaptureLogger();
    const initial = runPhase1({ metadata: initialMetadata }, logger);
    const synced = runPhase1(
      {
        metadata: rescannedMetadata,
        existingStructured: initial.structured,
        existingRewriting: initial.rewriting,
      },
      logger,
    );

    expect(
      synced.structured.CircleA.albums.Album.discs[0].tracks[
        "CircleA/2024.01.01 Album/02.mp3"
      ]?.title,
    ).toBe("Two");
  });

  test("cycle validation follows first-wins and global effective rules", () => {
    const metadata: MetadataMap = {
      "CircleA/2024.01.01 Album/01.mp3": {
        Title: "Song",
        Artists: ["Old"],
        "Album artists": ["CircleA"],
        "Track number": 1,
      },
    };
    const logger = new CaptureLogger();

    expect(() =>
      runPhase1(
        {
          metadata,
          existingRewriting: {
            CircleA: {
              ...emptyCircleRewriting(),
              "artists rewriting": [
                { from: ["A"], to: ["B"] },
                { from: ["A"], to: ["C"] },
                { from: ["C"], to: ["A"] },
              ],
            },
            $all: emptyCircleRewriting(),
          },
        },
        logger,
      ),
    ).not.toThrow();

    expect(() =>
      runPhase1(
        {
          metadata,
          existingRewriting: {
            CircleA: {
              ...emptyCircleRewriting(),
              "artists rewriting": [{ from: ["A"], to: ["B"] }],
            },
            $all: {
              ...emptyCircleRewriting(),
              "artists rewriting": [{ from: ["B"], to: ["A"] }],
            },
          },
        },
        logger,
      ),
    ).toThrow(/rewrite cycle/);
  });
});

function emptyCircleRewriting(): RewritingData["$all"] {
  return {
    "all album artists": {},
    "album artists rewriting": [],
    "all artists": {},
    "artists rewriting": [],
    "all genres": [],
    "genre rewriting": [],
  };
}
