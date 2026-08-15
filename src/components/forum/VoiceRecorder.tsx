import { useState, useRef, useCallback, useEffect } from "react";
import { Trash2, Send, Pause, Play, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface VoiceRecorderProps {
  userId: string;
  onSend: (voiceUrl: string, duration: number) => Promise<void> | void;
  onCancel: () => void;
  localOnly?: boolean;
}

const getSupportedVoiceMimeType = () => {
  if (typeof MediaRecorder === "undefined") return "";
  return [
    "audio/webm;codecs=opus",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/webm",
  ].find((type) => MediaRecorder.isTypeSupported(type)) || "";
};

const VoiceRecorder = ({ userId, onSend, onCancel, localOnly = false }: VoiceRecorderProps) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [duration, setDuration] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [waveformData, setWaveformData] = useState<number[]>([]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mountedRef = useRef(true);
  const onCancelRef = useRef(onCancel);
  const onSendRef = useRef(onSend);
  const durationRef = useRef(0);
  const sendAfterStopRef = useRef(false);
  const maxDuration = localOnly ? 120 : 300;

  useEffect(() => { onCancelRef.current = onCancel; }, [onCancel]);
  useEffect(() => { onSendRef.current = onSend; }, [onSend]);

  const releaseMedia = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      void audioContextRef.current.close();
    }
    audioContextRef.current = null;
    if (animFrameRef.current !== null) cancelAnimationFrame(animFrameRef.current);
    animFrameRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const uploadVoice = useCallback(async (blob: Blob, seconds: number) => {
    setIsUploading(true);
    try {
      if (blob.size === 0 || seconds < 1) throw new Error("Record at least one second before sending.");
      if (localOnly) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not prepare this recording."));
          reader.onerror = () => reject(new Error("Could not prepare this recording."));
          reader.readAsDataURL(blob);
        });
        await onSendRef.current(dataUrl, seconds);
        return;
      }
      const ext = blob.type.includes("webm") ? "webm" : "m4a";
      const path = `${userId}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await supabase.storage.from("voice-notes").upload(path, blob, {
        contentType: blob.type || (ext === "webm" ? "audio/webm" : "audio/mp4"),
        cacheControl: "31536000",
        upsert: false,
      });
      if (uploadError) throw uploadError;
      const { data: urlData } = supabase.storage.from("voice-notes").getPublicUrl(path);
      try {
        await onSendRef.current(urlData.publicUrl, seconds);
      } catch (error) {
        await supabase.storage.from("voice-notes").remove([path]);
        throw error;
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Voice note could not be sent. Please try again.");
    } finally {
      if (mountedRef.current) setIsUploading(false);
    }
  }, [localOnly, userId]);

  const startRecording = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error("Voice recording is not supported by this browser.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      const mimeType = getSupportedVoiceMimeType();
      const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 64000 } : undefined);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      try {
        const audioContext = new AudioContext();
        audioContextRef.current = audioContext;
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 64;
        source.connect(analyser);
        analyserRef.current = analyser;
      } catch {
        analyserRef.current = null;
      }

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mediaRecorder.mimeType || mimeType || "audio/mp4" });
        if (!mountedRef.current) return;
        const recordedDuration = Math.max(1, durationRef.current);
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        releaseMedia();
        if (sendAfterStopRef.current) {
          sendAfterStopRef.current = false;
          void uploadVoice(blob, recordedDuration);
        }
      };
      mediaRecorder.onerror = () => {
        releaseMedia();
        toast.error("Recording stopped unexpectedly. Please try again.");
        onCancelRef.current();
      };

      mediaRecorder.start(250);
      setIsRecording(true);
      setDuration(0);
      durationRef.current = 0;
      setWaveformData([]);

      timerRef.current = setInterval(() => {
        setDuration((current) => {
          const next = current + 1;
          durationRef.current = Math.min(next, maxDuration);
          if (next >= maxDuration && mediaRecorder.state !== "inactive") {
            mediaRecorder.stop();
            setIsRecording(false);
            setIsPaused(false);
          }
          return Math.min(next, maxDuration);
        });
      }, 1000);

      // Waveform animation
      const updateWaveform = () => {
        if (!analyserRef.current || mediaRecorderRef.current?.state === "inactive") return;
        const data = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setWaveformData((prev) => [...prev.slice(-40), avg / 255]);
        animFrameRef.current = requestAnimationFrame(updateWaveform);
      };
      updateWaveform();
    } catch (error) {
      releaseMedia();
      const message = error instanceof DOMException && error.name === "NotAllowedError"
        ? "Microphone access is off. Allow it in Safari Settings, then try again."
        : error instanceof Error ? error.message : "Could not start voice recording.";
      toast.error(message);
      onCancelRef.current();
    }
  }, [maxDuration, releaseMedia, uploadVoice]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    setIsPaused(false);
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  const togglePause = useCallback(() => {
    if (!mediaRecorderRef.current) return;
    if (isPaused) {
      mediaRecorderRef.current.resume();
      timerRef.current = setInterval(() => setDuration((current) => {
        const next = Math.min(current + 1, maxDuration);
        durationRef.current = next;
        return next;
      }), 1000);
    } else {
      mediaRecorderRef.current.pause();
      if (timerRef.current) clearInterval(timerRef.current);
    }
    setIsPaused(!isPaused);
  }, [isPaused, maxDuration]);

  const handleSend = useCallback(async () => {
    if (!audioBlob) return;
    await uploadVoice(audioBlob, duration);
  }, [audioBlob, duration, uploadVoice]);

  const sendCurrentRecording = useCallback(() => {
    if (isUploading) return;
    if (audioBlob) {
      void handleSend();
      return;
    }
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive") return;
    if (durationRef.current < 1) {
      toast("Keep recording for a moment before sending.");
      return;
    }
    sendAfterStopRef.current = true;
    stopRecording();
  }, [audioBlob, handleSend, isUploading, stopRecording]);

  const handleDiscard = useCallback(() => {
    stopRecording();
    setAudioBlob(null);
    setAudioUrl(null);
    setDuration(0);
    durationRef.current = 0;
    sendAfterStopRef.current = false;
    setWaveformData([]);
    onCancel();
  }, [stopRecording, onCancel]);

  useEffect(() => {
    mountedRef.current = true;
    startRecording();
    return () => {
      mountedRef.current = false;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      releaseMedia();
    };
  }, [releaseMedia, startRecording]);

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;

  return (
    <div className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-1.5 w-full min-w-0 animate-fade-in" data-testid="voice-recorder">
      {/* Discard */}
      <button onClick={handleDiscard} aria-label="Discard voice note" className="min-h-11 min-w-11 flex items-center justify-center text-destructive hover:bg-destructive/10 rounded-full transition-colors">
        <Trash2 className="w-5 h-5" />
      </button>

      {/* Waveform + timer */}
      <div className="min-w-0 flex items-center gap-1.5 bg-secondary rounded-full pl-2 pr-3 py-1.5 overflow-hidden">
        {isRecording && !audioUrl && (
          <button onClick={togglePause} aria-label={isPaused ? "Resume recording" : "Pause recording"} className="min-h-8 min-w-8 flex items-center justify-center text-muted-foreground hover:text-foreground rounded-full hover:bg-background/70 transition-colors">
            {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
          </button>
        )}
        <div className="flex items-center gap-1 flex-1 min-w-0 h-7 overflow-hidden">
          {isRecording && !audioUrl ? (
            <>
              <div className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
              <div className="flex items-end gap-[2px] h-6 flex-1 min-w-0 overflow-hidden">
                {waveformData.map((v, i) => (
                  <div
                    key={i}
                    className="w-[3px] rounded-full bg-primary transition-all"
                    style={{ height: `${Math.max(4, v * 24)}px` }}
                  />
                ))}
              </div>
            </>
          ) : audioUrl ? (
            <VoicePlayback url={audioUrl} duration={duration} />
          ) : null}
        </div>
        <span className="text-xs font-mono text-muted-foreground min-w-[40px] text-right">
          {formatTime(duration)}
        </span>
      </div>

      {/* A single primary action stays visible throughout recording and review. */}
      <button
        onClick={sendCurrentRecording}
        disabled={isUploading || (!isRecording && !audioUrl)}
        aria-label={isUploading ? "Sending voice note" : "Send voice note"}
        className="min-h-11 min-w-11 flex items-center justify-center bg-primary text-primary-foreground rounded-full shadow-sm hover:opacity-90 active:scale-95 transition-all disabled:opacity-50"
      >
        {isUploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
      </button>
    </div>
  );
};

/* ── Voice Playback with waveform ── */
export const VoicePlayback = ({ url, duration }: { url: string; duration: number }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
      audioRef.current = null;
    }
  }, [url]);

  const ensureAudio = () => {
    if (!audioRef.current) {
      const audio = new Audio(url);
      audio.preload = "metadata";
      audio.playbackRate = playbackRate;
      audio.onended = () => {
        setIsPlaying(false);
        setProgress(0);
      };
      audio.onpause = () => setIsPlaying(false);
      audio.ontimeupdate = () => {
        setProgress(audio.currentTime / (audio.duration || duration || 1));
      };
      audio.onerror = () => {
        setIsPlaying(false);
        toast.error("This voice note could not be played.");
      };
      audioRef.current = audio;
    }
    return audioRef.current;
  };

  const togglePlay = async () => {
    const audio = ensureAudio();
    if (isPlaying) {
      audio.pause();
      return;
    }
    try {
      await audio.play();
      setIsPlaying(true);
    } catch {
      setIsPlaying(false);
      toast.error("Tap play again or check Silent Mode and media permissions.");
    }
  };

  const seekTo = (nextProgress: number) => {
    const audio = ensureAudio();
    const resolvedDuration = Number.isFinite(audio.duration) ? audio.duration : duration;
    audio.currentTime = Math.max(0, Math.min(resolvedDuration, resolvedDuration * nextProgress));
    setProgress(nextProgress);
  };

  const cycleSpeed = () => {
    const speeds = [1, 1.5, 2];
    const next = speeds[(speeds.indexOf(playbackRate) + 1) % speeds.length];
    setPlaybackRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;

  return (
    <div className="flex items-center gap-2 w-full">
      <button onClick={() => void togglePlay()} aria-label={isPlaying ? "Pause voice note" : "Play voice note"} className="min-h-9 min-w-9 flex items-center justify-center text-primary hover:text-primary/80 transition-colors flex-shrink-0 rounded-full">
        {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
      </button>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={progress}
        onChange={(event) => seekTo(Number(event.target.value))}
        aria-label="Voice note playback position"
        className="flex-1 h-1.5 accent-primary cursor-pointer"
      />
      <span className="text-[10px] font-mono text-muted-foreground min-w-[32px]">
        {formatTime(Math.round(duration * (1 - progress)))}
      </span>
      <button onClick={cycleSpeed} aria-label={`Playback speed ${playbackRate} times`} className="min-h-8 text-[10px] font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-full hover:bg-primary/20 transition-colors">
        {playbackRate}x
      </button>
    </div>
  );
};

export default VoiceRecorder;
