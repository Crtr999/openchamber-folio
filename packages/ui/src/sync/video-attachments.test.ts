import { describe, expect, test } from "bun:test"
import { describeVideoExpansion } from "./video-attachments"

describe("video attachment description", () => {
  test("cites every frame by filename and timestamps the transcript", () => {
    const text = describeVideoExpansion("demo clip.mov", {
      durationMs: 75_000,
      frames: [{ timeMs: 1_000, data: "x" }, { timeMs: 61_500, data: "y" }],
      audio: {
        status: "transcribed",
        segments: [{ startMs: 0, endMs: 60_000, text: "Hello there." }],
      },
    }, ["demo-clip-frame-1-at-0-01.jpg", "demo-clip-frame-2-at-1-01.jpg"])

    expect(text).toContain("# Video: demo clip.mov")
    expect(text).toContain("Duration: 1:15.")
    expect(text).toContain("sampled 2 still frames")
    expect(text).toContain("- 0:01: [demo-clip-frame-1-at-0-01.jpg]")
    expect(text).toContain("- 1:01: [demo-clip-frame-2-at-1-01.jpg]")
    expect(text).toContain("[0:00–1:00] Hello there.")
  })

  test("explains why there is no transcript", () => {
    const text = describeVideoExpansion("silent.mp4", {
      durationMs: 3_000,
      frames: [{ timeMs: 1_500, data: "x" }],
      audio: { status: "model-missing", segments: [] },
    }, ["silent-frame-1-at-0-01.jpg"])

    expect(text).toContain("sampled 1 still frame across")
    expect(text).toContain("no local speech model is installed")
  })
})
