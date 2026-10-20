# Audio & Media Credits - Agent Clearing Desk (Galuxium Nexus V2)

All visual assets, narration, ambient pads, and UI sound cues in `galuxium-pitch-demo.mp4` and `galuxium-iteration-trail.mp4` are original works created specifically for the Galuxium Nexus V2 hackathon submission.

## Audio Tracks & Sound Design (`opus-sound-layer`)

- **Spoken Narration (`voiceover.wav`)**: Generated locally via macOS neural speech synthesis (`Samantha` voice at 175 WPM) from the timecoded script in `submission/galuxium/video.md`.
- **Ambient Synth Bed (`ambient-bed.wav`)**: Synthesized procedurally via `ffmpeg` (`aevalsrc` warm C-major9 harmonic drone at `130.81 Hz`, `196.00 Hz`, `246.94 Hz`, and `293.66 Hz`, low-pass filtered at `900 Hz` and sidechain-ducked under the narration).
- **UI Transition & Receipt Verification Cues (`ui-cues.wav`)**: Synthesized procedurally via `ffmpeg` sine/bell envelopes (`523.25 Hz` and `659.25 Hz` confirmation chimes, `220 Hz` refusal guard tone).
- **Loudness Normalization**: Mixed and EBU R128 loudness-normalized to `-14.0 LUFS` integrated (`TP <= -1.0 dBTP`) via `ffmpeg loudnorm`.

## Visual Assets

- **Live Control Plane Screenshots (`screenshots/01..04.png`)**: Captured at `1440x900@2x` directly from the deployed Cloudflare Worker (`https://agent-clearing-desk.nguyenhieuec.workers.dev/admin`).
- **System Architecture Diagram (`architecture.svg`)**: Original vector diagram authored in `submission/galuxium/architecture.svg`.
- **License**: MIT License (`https://github.com/nguyenhieuec/agent-clearing-desk`).
