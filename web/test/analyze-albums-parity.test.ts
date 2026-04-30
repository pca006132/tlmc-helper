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

  test("rewrites track-1 numeric title prefix and audits album", () => {
    const metadata: MetadataMap = {
      "CircleA/2024.01.01 Album/01.mp3": {
        Title: "[01]. Intro",
        Artists: ["CircleA"],
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
    expect(track.title).toBe("Intro");

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
