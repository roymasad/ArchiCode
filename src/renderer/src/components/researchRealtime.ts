import type { CodexRealtimeClientSecret } from "../../../main/codexRealtime";

export type RealtimeFunctionCall = {
  argumentsJson: string;
  callId: string;
  name: string;
};

export type OpenAiRealtimeCallbacks = {
  onAssistantTranscript: (text: string) => void;
  onError: (message: string) => void;
  onFunctionCall: (call: RealtimeFunctionCall) => void;
  onInputLevel: (level: number) => void;
  onSessionCreated: (sessionId?: string) => void;
  onResponseActiveChanged?: (active: boolean) => void;
  onStatus: (status: "hearing" | "listening" | "speaking" | "thinking") => void;
  onUserTranscript: (text: string) => void;
};

export const OPENAI_REALTIME_SESSION_DURATION_MS = 60 * 60 * 1_000;

type RealtimeServerEvent = {
  type?: string;
  delta?: string;
  text?: string;
  transcript?: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  error?: { message?: string };
  session?: { id?: string };
  item?: {
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    output?: Array<{
      type?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
    }>;
  };
};

function responseErrorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // SDP failures are commonly returned as plain text.
  }
  return body.trim() || `OpenAI Realtime WebRTC negotiation failed (${status}).`;
}

export class OpenAiRealtimeEventBridge {
  private readonly handledFunctionCalls = new Set<string>();
  private readonly assistantTranscriptByItem = new Map<string, string>();
  private readonly assistantTextByItem = new Map<string, string>();

  constructor(private readonly callbacks: OpenAiRealtimeCallbacks) {}

  handle(raw: unknown): void {
    if (typeof raw !== "string") return;
    let event: RealtimeServerEvent;
    try {
      event = JSON.parse(raw) as RealtimeServerEvent;
    } catch {
      return;
    }
    if (event.type === "error") {
      this.callbacks.onError(event.error?.message ?? "OpenAI Realtime returned an error.");
      return;
    }
    if (event.type === "session.created") {
      this.callbacks.onSessionCreated(event.session?.id);
      return;
    }
    if (event.type === "input_audio_buffer.speech_started") {
      this.callbacks.onStatus("hearing");
      return;
    }
    if (event.type === "input_audio_buffer.speech_stopped") {
      this.callbacks.onStatus("thinking");
      return;
    }
    if (event.type === "response.created") {
      this.callbacks.onResponseActiveChanged?.(true);
      this.callbacks.onStatus("thinking");
      return;
    }
    if (event.type === "response.output_audio.started") {
      this.callbacks.onStatus("speaking");
      return;
    }
    if (event.type === "response.done") {
      this.callbacks.onStatus("listening");
      this.callbacks.onResponseActiveChanged?.(false);
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const text = event.transcript?.trim();
      if (text) this.callbacks.onUserTranscript(text);
      return;
    }
    if (event.type === "response.output_audio_transcript.delta") {
      const itemId = event.item_id ?? "active";
      this.assistantTranscriptByItem.set(itemId, `${this.assistantTranscriptByItem.get(itemId) ?? ""}${event.delta ?? ""}`);
      return;
    }
    if (event.type === "response.output_audio_transcript.done") {
      const itemId = event.item_id ?? "active";
      const text = (event.transcript ?? this.assistantTranscriptByItem.get(itemId) ?? "").trim();
      this.assistantTranscriptByItem.delete(itemId);
      if (text) this.callbacks.onAssistantTranscript(text);
      return;
    }
    if (event.type === "response.output_text.delta") {
      const itemId = event.item_id ?? "active";
      this.assistantTextByItem.set(itemId, `${this.assistantTextByItem.get(itemId) ?? ""}${event.delta ?? ""}`);
      return;
    }
    if (event.type === "response.output_text.done") {
      const itemId = event.item_id ?? "active";
      const text = (event.text ?? this.assistantTextByItem.get(itemId) ?? "").trim();
      this.assistantTextByItem.delete(itemId);
      if (text) this.callbacks.onAssistantTranscript(text);
      return;
    }
    if (event.type === "response.function_call_arguments.done") {
      this.emitFunctionCall({
        call_id: event.call_id,
        name: event.name,
        arguments: event.arguments
      });
      return;
    }
    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      this.emitFunctionCall(event.item);
      return;
    }
    if (event.type === "response.done") {
      for (const item of event.response?.output ?? []) {
        if (item.type === "function_call") this.emitFunctionCall(item);
      }
    }
  }

  private emitFunctionCall(item: { call_id?: string; name?: string; arguments?: string }): void {
    const callId = item.call_id?.trim();
    const name = item.name?.trim();
    if (!callId || !name || this.handledFunctionCalls.has(callId)) return;
    this.handledFunctionCalls.add(callId);
    this.callbacks.onFunctionCall({
      argumentsJson: item.arguments ?? "{}",
      callId,
      name
    });
  }
}

export class OpenAiRealtimeCall {
  private readonly peer = new RTCPeerConnection();
  private readonly dataChannel = this.peer.createDataChannel("oai-events");
  private readonly events: OpenAiRealtimeEventBridge;
  private readonly pendingEvents: unknown[] = [];
  private stream: MediaStream | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private meterContext: AudioContext | null = null;
  private meterAnimationFrame: number | null = null;
  private muted = false;
  private closed = false;
  private responseBusy = false;
  private responseQueued = false;

  constructor(private readonly callbacks: OpenAiRealtimeCallbacks) {
    this.events = new OpenAiRealtimeEventBridge({
      ...callbacks,
      onError: (message) => {
        if (message.toLocaleLowerCase().includes("active response in progress")) {
          this.responseBusy = true;
          return;
        }
        callbacks.onError(message);
      },
      onUserTranscript: (text) => {
        callbacks.onUserTranscript(text);
        this.requestResponse();
      },
      onResponseActiveChanged: (active) => {
        this.responseBusy = active;
        callbacks.onResponseActiveChanged?.(active);
        if (!active && this.responseQueued) {
          this.responseQueued = false;
          this.requestResponse();
        }
      }
    });
    this.dataChannel.addEventListener("message", (event) => this.events.handle(event.data));
    this.dataChannel.addEventListener("open", () => this.flushPendingEvents());
    this.dataChannel.addEventListener("error", () => this.callbacks.onError("OpenAI Realtime data channel failed."));
    this.peer.addEventListener("connectionstatechange", () => {
      if (this.closed) return;
      if (this.peer.connectionState === "failed" || this.peer.connectionState === "disconnected") {
        this.callbacks.onError(`OpenAI Realtime connection ${this.peer.connectionState}.`);
      }
    });
    this.peer.addEventListener("track", (event) => {
      const audio = this.remoteAudio ?? document.createElement("audio");
      this.remoteAudio = audio;
      audio.autoplay = true;
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void audio.play().catch(() => undefined);
    });
  }

  async connect(secret: CodexRealtimeClientSecret): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    for (const track of this.stream.getAudioTracks()) this.peer.addTrack(track, this.stream);
    this.startInputMeter(this.stream);

    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp ?? "",
      headers: {
        Authorization: `Bearer ${secret.value}`,
        "Content-Type": "application/sdp"
      }
    });
    const answerSdp = await response.text();
    if (!response.ok) throw new Error(responseErrorMessage(answerSdp, response.status));
    await this.peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
    await this.waitForDataChannel();
    this.callbacks.onStatus("listening");
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
    if (muted) this.callbacks.onInputLevel(0);
  }

  appendText(text: string): void {
    const content = text.trim();
    if (!content) return;
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: content }]
      }
    });
    this.requestResponse();
  }

  appendDeveloperContext(text: string, requestResponse = false): void {
    const content = text.trim();
    if (!content) return;
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: content }]
      }
    });
    if (requestResponse) this.requestResponse();
  }

  sendFunctionOutput(callId: string, output: unknown): void {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output)
      }
    });
    this.requestResponse();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.meterAnimationFrame !== null) cancelAnimationFrame(this.meterAnimationFrame);
    this.meterAnimationFrame = null;
    this.callbacks.onInputLevel(0);
    this.pendingEvents.length = 0;
    this.responseBusy = false;
    this.responseQueued = false;
    this.dataChannel.close();
    this.peer.close();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.remoteAudio) {
      this.remoteAudio.pause();
      this.remoteAudio.srcObject = null;
      this.remoteAudio = null;
    }
    const context = this.meterContext;
    this.meterContext = null;
    if (context && context.state !== "closed") void context.close();
  }

  private send(event: unknown): void {
    if (this.closed || this.dataChannel.readyState === "closing" || this.dataChannel.readyState === "closed") return;
    if (this.dataChannel.readyState !== "open") {
      this.pendingEvents.push(event);
      return;
    }
    this.dataChannel.send(JSON.stringify(event));
  }

  private requestResponse(): void {
    if (this.closed) return;
    if (this.responseBusy) {
      this.responseQueued = true;
      return;
    }
    this.responseBusy = true;
    this.callbacks.onStatus("thinking");
    this.send({ type: "response.create" });
  }

  private flushPendingEvents(): void {
    if (this.closed || this.dataChannel.readyState !== "open") return;
    for (const event of this.pendingEvents.splice(0)) this.dataChannel.send(JSON.stringify(event));
  }

  private async waitForDataChannel(): Promise<void> {
    if (this.dataChannel.readyState === "open") return;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.dataChannel.removeEventListener("open", opened);
        reject(new Error("OpenAI Realtime data channel timed out."));
      }, 12_000);
      const opened = () => {
        window.clearTimeout(timeout);
        this.dataChannel.removeEventListener("open", opened);
        resolve();
      };
      this.dataChannel.addEventListener("open", opened);
    });
  }

  private startInputMeter(stream: MediaStream): void {
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const update = () => {
      if (this.closed) return;
      analyser.getByteTimeDomainData(samples);
      let sumSquares = 0;
      for (const sample of samples) {
        const value = (sample - 128) / 128;
        sumSquares += value * value;
      }
      this.callbacks.onInputLevel(this.muted ? 0 : Math.min(1, Math.sqrt(sumSquares / samples.length) * 8));
      this.meterAnimationFrame = requestAnimationFrame(update);
    };
    this.meterContext = context;
    this.meterAnimationFrame = requestAnimationFrame(update);
  }
}
