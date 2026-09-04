import { useEffect, useRef, useState } from "react";
import DailyIframe, { DailyCall } from "@daily-co/daily-js";
import { X, Loader2, Mic, Video as VideoIcon, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface CallModalProps {
  roomId: string;
  mode: "audio" | "video";
  sessionId?: string;
  onClose: () => void;
}

type Stage =
  | { kind: "permission" }
  | { kind: "checking" }
  | { kind: "permission_denied"; reason: string }
  | { kind: "no_devices" }
  | { kind: "fetching_token" }
  | { kind: "joining" }
  | { kind: "in_call" }
  | { kind: "reconnecting" }
  | { kind: "error"; message: string };

const PARTICIPANT_LEASE_INTERVAL_MS = 30_000;

const CallModal = ({ roomId, mode, sessionId, onClose }: CallModalProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const callRef = useRef<DailyCall | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const participantRowRef = useRef<string | null>(null);
  const participantLeaseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const participantLeaseRefreshInFlightRef = useRef(false);
  const teardownPromiseRef = useRef<Promise<void> | null>(null);
  const teardownCompleteRef = useRef(false);
  const teardownStartedRef = useRef(false);
  const [stage, setStage] = useState<Stage>({ kind: "permission" });
  const { user } = useAuth();

  const stopParticipantLeaseHeartbeat = () => {
    if (participantLeaseTimerRef.current !== null) {
      clearInterval(participantLeaseTimerRef.current);
      participantLeaseTimerRef.current = null;
    }
  };

  const refreshParticipantLease = async () => {
    const participantId = participantRowRef.current;
    if (!participantId || teardownStartedRef.current || participantLeaseRefreshInFlightRef.current) return;
    participantLeaseRefreshInFlightRef.current = true;
    try {
      const { error } = await supabase.from("call_participants")
        .update({ lease_refreshed_at: new Date().toISOString() })
        .eq("id", participantId);
      if (error) throw new Error(error.message || "Could not refresh the call participant lease");
    } finally {
      participantLeaseRefreshInFlightRef.current = false;
    }
  };

  const startParticipantLeaseHeartbeat = () => {
    stopParticipantLeaseHeartbeat();
    if (!participantRowRef.current || teardownStartedRef.current) return;
    const refreshOrEndCall = () => {
      void refreshParticipantLease().catch(async (error) => {
        if (teardownStartedRef.current) return;
        stopParticipantLeaseHeartbeat();
        const detail = error instanceof Error ? error.message : "The participant lease could not be refreshed";
        const message = `${detail}. This call was ended to keep its participant state accurate. Close and rejoin the call.`;
        try {
          await teardown("participant_lease_failed");
        } catch (cleanupError) {
          console.error("Call cleanup after lease failure failed", cleanupError);
        }
        toast.error(message);
        setStage({ kind: "error", message });
      });
    };
    // Refresh immediately on reconnection so an already-expired lease cannot
    // be silently revived or remain ambiguous for another interval.
    refreshOrEndCall();
    participantLeaseTimerRef.current = setInterval(refreshOrEndCall, PARTICIPANT_LEASE_INTERVAL_MS);
  };

  // ── Cleanup helpers ────────────────────────────────────────────────────
  const recordParticipantLeave = async () => {
    stopParticipantLeaseHeartbeat();
    const participantId = participantRowRef.current;
    if (participantId) {
      const { error } = await supabase.from("call_participants")
        .update({ left_at: new Date().toISOString() })
        .eq("id", participantId);
      if (error) throw new Error(error.message || "Could not record that you left the call");
      participantRowRef.current = null;
    }
  };

  const finalizeSession = async (failureReason?: string) => {
    if (!sessionIdRef.current) return;
    // If I'm the last participant, mark session ended.
    const { count, error: countError } = await supabase.from("call_participants")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionIdRef.current)
      .is("left_at", null);
    if (countError) throw new Error(countError.message || "Could not check the active call participants");
    if ((count ?? 0) === 0) {
      const { error } = await supabase.from("call_sessions").update({
        ended_at: new Date().toISOString(),
        failure_reason: failureReason ?? null,
      }).eq("id", sessionIdRef.current);
      if (error && error.code !== "call_still_active") throw new Error(error.message || "Could not finalize the call session");
    }
  };

  const teardown = async (failureReason?: string) => {
    teardownStartedRef.current = true;
    stopParticipantLeaseHeartbeat();
    if (teardownCompleteRef.current) return;
    if (teardownPromiseRef.current) return teardownPromiseRef.current;
    const call = callRef.current;
    callRef.current = null;
    const operation = Promise.resolve().then(async () => {
      try { await call?.leave(); } catch { /* Daily may already have left. */ }
      try { call?.destroy(); } catch { /* Frame cleanup is best-effort. */ }
      await recordParticipantLeave();
      await finalizeSession(failureReason);
      teardownCompleteRef.current = true;
    });
    teardownPromiseRef.current = operation;
    try {
      await operation;
    } finally {
      teardownPromiseRef.current = null;
    }
  };

  const closeAfterTeardown = async (failureReason?: string) => {
    try {
      await teardown(failureReason);
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save the call state. Try again.";
      toast.error(message);
      setStage({ kind: "error", message });
    }
  };

  // ── Pre-flight permission check ────────────────────────────────────────
  const requestPermissions = async () => {
    setStage({ kind: "checking" });
    if (!navigator.mediaDevices?.getUserMedia) {
      setStage({ kind: "no_devices" });
      return;
    }
    try {
      const constraints = mode === "video"
        ? { audio: true, video: true }
        : { audio: true, video: false };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.getTracks().forEach(t => t.stop()); // release immediately, Daily will re-acquire
      await joinCall();
    } catch (e: any) {
      const name = e?.name ?? "";
      let reason = "Could not access your microphone/camera.";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        reason = "You denied microphone/camera access. Please enable it in your browser settings and try again.";
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setStage({ kind: "no_devices" }); return;
      } else if (name === "NotReadableError") {
        reason = "Your microphone or camera is being used by another app.";
      } else if (name === "OverconstrainedError") {
        reason = "No device matches the requested settings.";
      }
      setStage({ kind: "permission_denied", reason });
    }
  };

  // ── Main join flow ─────────────────────────────────────────────────────
  const joinCall = async () => {
    try {
      setStage({ kind: "fetching_token" });
      const { data, error } = await supabase.functions.invoke("daily-create-room", {
        body: { roomId, mode, ...(sessionId ? { sessionId } : {}) },
      });
      if (error) throw new Error(error.message ?? "Failed to fetch call token");
      if (!data?.url || !data?.token || !data?.sessionId) throw new Error("Invalid call token response");
      sessionIdRef.current = data.sessionId;

      if (!containerRef.current) throw new Error("Call container not ready");

      const call = DailyIframe.createFrame(containerRef.current, {
        iframeStyle: { width: "100%", height: "100%", border: "0", borderRadius: "12px" },
        showLeaveButton: true,
        showFullscreenButton: true,
      });
      callRef.current = call;

      call.on("joined-meeting", async () => {
        try {
          if (!user || !sessionIdRef.current) throw new Error("Your call session is no longer available");
          const { data: row, error: participantError } = await supabase.from("call_participants")
            .insert({ session_id: sessionIdRef.current, user_id: user.id })
            .select("id").single();
          if (participantError || !row?.id) throw new Error(participantError?.message || "Could not join the call session");
          participantRowRef.current = row.id;
          if (teardownStartedRef.current) {
            await recordParticipantLeave();
            return;
          }
          startParticipantLeaseHeartbeat();
          setStage({ kind: "in_call" });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not join the call session";
          toast.error(message);
          try { await teardown(message); } catch { /* The visible error below remains actionable. */ }
          setStage({ kind: "error", message });
        }
      });
      call.on("left-meeting", () => { void closeAfterTeardown(); });
      call.on("error", async (ev: any) => {
        console.error("Daily error", ev);
        const message = ev?.errorMsg ?? "Call error";
        try { await teardown(`daily_error: ${message}`); }
        catch (cleanupError) {
          const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : "Could not save the call state";
          toast.error(cleanupMessage);
        }
        setStage({ kind: "error", message });
      });
      call.on("network-connection", (ev: any) => {
        if (ev?.event === "interrupted") {
          stopParticipantLeaseHeartbeat();
          setStage({ kind: "reconnecting" });
        }
        if (ev?.event === "connected") {
          startParticipantLeaseHeartbeat();
          setStage({ kind: "in_call" });
        }
      });

      setStage({ kind: "joining" });
      await call.join({ url: data.url, token: data.token, startVideoOff: mode === "audio" });
    } catch (e: any) {
      console.error(e);
      const msg = e?.message ?? "Failed to start call";
      toast.error(msg);
      await teardown(msg);
      setStage({ kind: "error", message: msg });
    }
  };

  // ── Cleanup on unmount ─────────────────────────────────────────────────
  useEffect(() => {
    return () => { void teardown().catch((error) => console.error("Call cleanup failed", error)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void closeAfterTeardown();
        return;
      }
      if (event.key !== "Tab" || !modalRef.current) return;
      const focusable = [...modalRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hasAttribute("hidden"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
    // Teardown and onClose belong to this modal instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-2 sm:p-4"
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))", paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
    >
      <div ref={modalRef} role="dialog" aria-modal="true" aria-label={`${mode === "video" ? "Video" : "Audio"} call`} className="relative w-full h-full max-w-5xl max-h-[100dvh] sm:max-h-[90vh] bg-card rounded-xl overflow-hidden shadow-2xl">
        <button
          ref={closeButtonRef}
          type="button"
          onClick={() => { void closeAfterTeardown(); }}
          className="absolute top-3 right-3 z-20 p-2 rounded-full bg-black/60 text-white hover:bg-black/80 transition"
          aria-label="Close call"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Permission gate */}
        {stage.kind === "permission" && (
          <div className="w-full h-full flex flex-col items-center justify-center text-center p-6 gap-4">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              {mode === "video" ? <VideoIcon className="w-8 h-8 text-primary" /> : <Mic className="w-8 h-8 text-primary" />}
            </div>
            <h2 className="text-lg font-bold text-foreground">Allow {mode === "video" ? "camera & microphone" : "microphone"} access</h2>
            <p className="text-sm text-muted-foreground max-w-sm">
              We need access to your {mode === "video" ? "camera and microphone" : "microphone"} to start this call. Your browser will ask for permission next.
            </p>
            <div className="flex gap-3 mt-2">
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={requestPermissions}>Continue</Button>
            </div>
          </div>
        )}

        {(stage.kind === "checking" || stage.kind === "fetching_token" || stage.kind === "joining") && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-white bg-black/40">
            <Loader2 className="w-8 h-8 animate-spin" />
            <span className="ml-3 text-sm">
              {stage.kind === "checking" ? "Checking devices…" : stage.kind === "fetching_token" ? "Preparing call…" : "Joining call…"}
            </span>
          </div>
        )}

        {stage.kind === "reconnecting" && (
          <div className="absolute top-12 left-1/2 -translate-x-1/2 z-20 bg-yellow-500/90 text-black text-xs font-medium px-3 py-1.5 rounded-full flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" /> Reconnecting…
          </div>
        )}

        {stage.kind === "permission_denied" && (
          <div className="w-full h-full flex flex-col items-center justify-center text-center p-6 gap-4">
            <AlertTriangle className="w-12 h-12 text-destructive" />
            <h2 className="text-lg font-bold text-foreground">Permission required</h2>
            <p className="text-sm text-muted-foreground max-w-sm">{stage.reason}</p>
            <div className="flex gap-3 mt-2">
              <Button variant="outline" onClick={onClose}>Close</Button>
              <Button onClick={requestPermissions}>Try again</Button>
            </div>
          </div>
        )}

        {stage.kind === "no_devices" && (
          <div className="w-full h-full flex flex-col items-center justify-center text-center p-6 gap-4">
            <AlertTriangle className="w-12 h-12 text-destructive" />
            <h2 className="text-lg font-bold text-foreground">No microphone or camera found</h2>
            <p className="text-sm text-muted-foreground max-w-sm">Connect a device and try again.</p>
            <Button onClick={onClose}>Close</Button>
          </div>
        )}

        {stage.kind === "error" && (
          <div className="w-full h-full flex flex-col items-center justify-center text-center p-6 gap-4">
            <AlertTriangle className="w-12 h-12 text-destructive" />
            <h2 className="text-lg font-bold text-foreground">Call failed</h2>
            <p className="text-sm text-muted-foreground max-w-sm">{stage.message}</p>
            <div className="flex gap-3">
              <Button variant="outline" onClick={onClose}>Close</Button>
              <Button onClick={() => { void (participantRowRef.current || sessionIdRef.current ? closeAfterTeardown() : requestPermissions()); }}>
                {participantRowRef.current || sessionIdRef.current ? "Retry cleanup" : "Retry"}
              </Button>
            </div>
          </div>
        )}

        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
  );
};

export default CallModal;
