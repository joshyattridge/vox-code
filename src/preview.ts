import { Buffer } from "node:buffer"
import { voiceMeta } from "./types.ts"

export const TTS_SAMPLE_MODEL = "gpt-4o-mini-tts"
export const DEFAULT_VOICE_SAMPLE =
  "Hi. This is how I sound in Vox Code. I'll keep spoken replies short."

export function sampleTextForVoice(voice: string) {
  return voiceMeta(voice)?.sample ?? DEFAULT_VOICE_SAMPLE
}

export async function fetchVoiceSamplePcm(input: {
  apiKey: string
  voice: string
  text?: string
  fetch?: typeof fetch
}): Promise<Buffer> {
  const fetchImpl = input.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== "function") {
    throw new Error("Voice samples need fetch() (Node 18+).")
  }
  const response = await fetchImpl("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TTS_SAMPLE_MODEL,
      voice: input.voice,
      input: input.text ?? sampleTextForVoice(input.voice),
      response_format: "pcm",
    }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Voice sample failed (${response.status}): ${body.slice(0, 180) || response.statusText}`)
  }
  return Buffer.from(await response.arrayBuffer())
}
