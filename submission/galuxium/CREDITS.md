# Audio and Media Credits - Agent Clearing Desk (Galuxium Nexus V2)

The pitch video `agent-clearing-desk-pitch.mp4` was made for this submission with the repository's own video engine (`packages/video-engine` in the Agent Tools monorepo).
It uses no stock footage, no stock music and no third-party clips.

## Audio

- **Narration:** Google Gemini text-to-speech, prebuilt voice `Charon`, reading the script in `video.md` word for word.
  Each line was checked against a local whisper.cpp transcript before the mix.
- **Music:** a bed generated in code by the video engine (key of D, 84 bpm, documentary mood), ducked under the narration.
- **Sound cues:** the soft tick, whoosh and end chime are also generated in code by the video engine.
- **Loudness:** mixed to -14 LUFS integrated.

## Visuals

- **Live demo steps:** captured from the deployed desk at https://agent-clearing-desk.nguyenhieuec.workers.dev.
  A real run of the judge sandbox was recorded in a headless browser, and each of the 7 steps is shown in the state it reached.
- **Operator console and audit log:** screenshots of the deployed desk, from `screenshots/`.
- **Terminal scenes:** real output of the live end-to-end run and of `verify-receipt.mjs` on a real receipt, set in a terminal frame.
- **Architecture diagram:** `architecture.svg`, made for this submission.
- **Comparison table:** made for this video from the public source of LiteLLM and Helicone, checked on 2026-10-20.
- **Fonts:** Inter and JetBrains Mono, both under the SIL Open Font License 1.1.

## License

The code is under the MIT License: https://github.com/nguyenhieuec/agent-clearing-desk.
