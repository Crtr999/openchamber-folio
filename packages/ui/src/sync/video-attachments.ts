import { z } from "zod"
import { runtimeFetch } from "@/lib/runtime-fetch"

/**
 * Chat models cannot read a video container, so a video attachment is
 * expanded by the runtime server (`/api/media/video/expand`) into sampled
 * JPEG frames and an on-device transcript. The result mirrors
 * document-attachments: one `text/plain` file under the original name that
 * cites each frame by filename, plus the frames as separate image files.
 */

const expansionSchema = z.object({
  durationMs: z.number().nonnegative(),
  frames: z.array(z.object({ timeMs: z.number().nonnegative(), data: z.string().min(1) })).min(1),
  audio: z.object({
    status: z.enum(["transcribed", "silent", "no-audio", "model-missing", "failed"]),
    segments: z.array(z.object({ startMs: z.number(), endMs: z.number(), text: z.string() })),
  }),
})

const errorSchema = z.object({ error: z.string() })

type VideoExpansion = z.infer<typeof expansionSchema>

type ExpandedVideoAttachments = {
  textFile: File
  images: File[]
}

const basenameWithoutExtension = (name: string): string => {
  const basename = name.replace(/\\/g, "/").split("/").pop() || "video"
  const index = basename.lastIndexOf(".")
  return (index > 0 ? basename.slice(0, index) : basename).replace(/[^a-zA-Z0-9._-]+/g, "-") || "video"
}

const formatVideoTimestamp = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = String(totalSeconds % 60).padStart(2, "0")
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`
}

const decodeBase64 = (data: string): Uint8Array => {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const AUDIO_NOTES: Record<VideoExpansion["audio"]["status"], string> = {
  "transcribed": "",
  "silent": "[The audio track is silent or contains no recognizable speech.]",
  "no-audio": "[This video has no audio track.]",
  "model-missing": "[Audio was not transcribed: no local speech model is installed. Download one in Dictation settings.]",
  "failed": "[Audio transcription failed; only the frames are available.]",
}

const frameFilenames = (videoName: string, expansion: VideoExpansion, reservedFilenames: Iterable<string>): string[] => {
  const reserved = new Set(Array.from(reservedFilenames, (filename) => filename.toLowerCase()))
  const base = basenameWithoutExtension(videoName)
  return expansion.frames.map((frame, index) => {
    const stamp = formatVideoTimestamp(frame.timeMs).replace(/:/g, "-")
    let filename = `${base}-frame-${index + 1}-at-${stamp}.jpg`
    for (let suffix = 2; reserved.has(filename.toLowerCase()); suffix += 1) {
      filename = `${base}-frame-${index + 1}-at-${stamp}-${suffix}.jpg`
    }
    reserved.add(filename.toLowerCase())
    return filename
  })
}

export const describeVideoExpansion = (videoName: string, expansion: VideoExpansion, filenames: string[]): string => {
  const sections = [
    `# Video: ${videoName}`,
    [
      `Duration: ${formatVideoTimestamp(expansion.durationMs)}.`,
      `This is an attached video. Open Carter sampled ${expansion.frames.length} still frame${expansion.frames.length === 1 ? "" : "s"} across it,`,
      "attached as images in time order, and transcribed its audio on this device.",
      "Treat the frames and transcript together as the video.",
    ].join(" "),
    "## Frames",
    expansion.frames.map((frame, index) => `- ${formatVideoTimestamp(frame.timeMs)}: [${filenames[index]}]`).join("\n"),
    "## Audio transcript",
  ]
  if (expansion.audio.segments.length > 0) {
    sections.push(expansion.audio.segments
      .map((segment) => `[${formatVideoTimestamp(segment.startMs)}–${formatVideoTimestamp(segment.endMs)}] ${segment.text}`)
      .join("\n\n"))
  } else {
    sections.push(AUDIO_NOTES[expansion.audio.status] || AUDIO_NOTES.silent)
  }
  return `${sections.join("\n\n")}\n`
}

const readExpansion = async (response: Response): Promise<VideoExpansion> => {
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const parsedError = errorSchema.safeParse(body)
    throw new Error(parsedError.success ? parsedError.data.error : `Video processing failed (${response.status})`)
  }
  const parsed = expansionSchema.safeParse(body)
  if (!parsed.success) throw new Error("Video processing returned an unexpected response")
  return parsed.data
}

/** Throws with a user-readable message when the runtime cannot process the video. */
export const expandVideoAttachment = async (
  file: File,
  reservedFilenames: Iterable<string> = [],
): Promise<ExpandedVideoAttachments> => {
  const response = await runtimeFetch("/api/media/video/expand", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  })
  const expansion = await readExpansion(response)
  const filenames = frameFilenames(file.name, expansion, reservedFilenames)
  return {
    textFile: new File([describeVideoExpansion(file.name, expansion, filenames)], file.name, { type: "text/plain" }),
    images: expansion.frames.map((frame, index) =>
      new File([decodeBase64(frame.data) as Uint8Array<ArrayBuffer>],filenames[index], { type: "image/jpeg" })),
  }
}
