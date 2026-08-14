import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { ArrowLeft, GraduationCap, CheckCircle2, Mail, ShieldCheck, AlertCircle, Search, FileUp, Clock3, LockKeyhole, RefreshCw } from "lucide-react";
import PostVerifyOnboarding from "@/components/PostVerifyOnboarding";
import { useQuery } from "@tanstack/react-query";
import { defaultIitLogo, expectedIitEmailDomain, IIT_LIST, iitLogoSettingKey, isMatchingIitEmail, type IitInstitute, type IitMemberStatus } from "@/data/iitInstitutes";
import { clearMobileTestDocumentSubmission, clearMobileTestSession, isEmailTestMode, MOBILE_TEST_OTP, readMobileTestSession, saveMobileTestDocumentSubmission, updateMobileTestSession, withdrawMobileTestDocumentSubmission } from "@/lib/mobileVerification";

const IitLogo = ({ iit, customUrl }: { iit: IitInstitute; customUrl?: string }) => {
  const [failed, setFailed] = useState(false);
  const initials = iit.name
    .replace("IIT ", "")
    .replace(" (ISM)", "")
    .split(" ")
    .map((word) => word[0])
    .join("")
    .slice(0, 3)
    .toUpperCase();

  return (
    <div className="w-11 h-11 rounded-xl bg-white border border-border/70 shadow-sm flex items-center justify-center overflow-hidden shrink-0">
      {failed ? (
        <span className="text-sm font-black tracking-tight text-primary">{initials}</span>
      ) : (
        <img
          src={customUrl || defaultIitLogo(iit.studentDomain)}
          alt={`${iit.name} logo`}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="w-8 h-8 object-contain"
        />
      )}
    </div>
  );
};

/** Derive IIT name from email domain */
function deriveIitFromEmail(email: string): string | undefined {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return undefined;
  const match = IIT_LIST.find(iit => domain === iit.studentDomain || domain === iit.alumniDomain || domain.endsWith(iit.studentDomain));
  return match?.name;
}

type Step = "select_iit" | "select_status" | "verify_email" | "verify_otp" | "upload_documents" | "documents_pending" | "onboarding";

const IitVerification = () => {
  const navigate = useNavigate();
  const { user, profile, refetchProfile } = useAuth();
  const [step, setStep] = useState<Step>(() => readMobileTestSession()?.documentVerificationStatus === "pending" ? "documents_pending" : "select_iit");
  const [selectedIit, setSelectedIit] = useState<typeof IIT_LIST[0] | null>(() => {
    const session = readMobileTestSession();
    return IIT_LIST.find((iit) => iit.name === session?.iitName) || null;
  });
  const [studentStatus, setStudentStatus] = useState<string>(() => readMobileTestSession()?.studentStatus || "");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [existingRecordMessage, setExistingRecordMessage] = useState("");
  const [documentType, setDocumentType] = useState("student_id");
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const emailTestMode = isEmailTestMode();

  const { data: iitLogos = {} } = useQuery({
    queryKey: ["iit-logos"],
    queryFn: async () => {
      const keys = IIT_LIST.map((iit) => iitLogoSettingKey(iit.studentDomain));
      const { data } = await supabase.from("app_settings").select("key,value").in("key", keys);
      return Object.fromEntries((data ?? []).map((item) => [item.key, item.value])) as Record<string, string>;
    },
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
  });

  const { data: latestDocumentSubmission, refetch: refetchDocumentSubmission, isFetching: checkingDocumentStatus } = useQuery({
    queryKey: ["my-document-verification", user?.id],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("document_verifications")
        .select("id,status,iit_name,student_status,review_notes")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as { id: string; status: "pending" | "approved" | "rejected" | "withdrawn"; iit_name: string; student_status: string; review_notes?: string } | null;
    },
    enabled: !!user && !readMobileTestSession(),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (latestDocumentSubmission?.iit_name) {
      const restoredIit = IIT_LIST.find((iit) => iit.name === latestDocumentSubmission.iit_name);
      if (restoredIit) setSelectedIit(restoredIit);
      setStudentStatus(latestDocumentSubmission.student_status);
    }
    if (latestDocumentSubmission?.status === "pending") {
      setStep("documents_pending");
      return;
    }
    if (profile?.is_verified && !profile.onboarding_completed) {
      setStep("onboarding");
    }
  }, [latestDocumentSubmission, profile?.is_verified, profile?.onboarding_completed]);

  const filteredIits = IIT_LIST.filter((iit) =>
    iit.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleSelectIit = (iit: typeof IIT_LIST[0]) => {
    setSelectedIit(iit);
    setStep("select_status");
  };

  const handleSelectStatus = (status: string) => {
    setStudentStatus(status);
    setStep("verify_email");
  };

  const getExpectedDomain = () => {
    if (!selectedIit || (studentStatus !== "current_student" && studentStatus !== "alumni")) return "";
    return expectedIitEmailDomain(selectedIit, studentStatus);
  };

  const completeEmailVerification = async (normalizedEmail: string) => {
    const mobileTestSession = readMobileTestSession();
    if (mobileTestSession) {
      clearMobileTestDocumentSubmission();
      updateMobileTestSession({
        iitName: selectedIit?.name,
        iitEmail: normalizedEmail,
        studentStatus,
        isVerified: true,
        onboardingCompleted: false,
        documentVerificationStatus: undefined,
      });
      await refetchProfile();
    } else if (user) {
      const userPhone = (user as any).phone || (user as any).user_metadata?.phone || "";
      const { data: existingVerif } = await supabase.from("verifications").select("id").eq("user_id", user.id).maybeSingle();
      const verificationPayload = {
        iit_email: normalizedEmail,
        iit_email_normalized: normalizedEmail,
        iit_domain: normalizedEmail.split("@")[1],
        email_verified_at: new Date().toISOString(),
        verified_status: "VERIFIED",
        locked_to_phone: userPhone,
        updated_at: new Date().toISOString(),
      };
      const verificationResult = existingVerif
        ? await supabase.from("verifications").update(verificationPayload).eq("id", existingVerif.id)
        : await supabase.from("verifications").insert({ ...verificationPayload, user_id: user.id });
      if (verificationResult.error) throw verificationResult.error;

      const { error: profileError } = await supabase.from("profiles").upsert({
        user_id: user.id,
        name: (user.user_metadata?.name as string) || user.email || "Cirkle Member",
        iit_name: selectedIit?.name,
        student_status: studentStatus,
        iit_email: normalizedEmail,
        is_verified: true,
        onboarding_completed: false,
      } as any, { onConflict: "user_id" });
      if (profileError) throw profileError;
      await refetchProfile();
    } else {
      throw new Error("Your session expired. Please sign in again.");
    }
    toast.success("Email verified. Let’s complete your profile 🎉");
    setStep("onboarding");
  };

  const handleSendCode = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!selectedIit || (studentStatus !== "current_student" && studentStatus !== "alumni")) {
      toast.error("Choose your IIT and member type first");
      setStep("select_iit");
      return;
    }
    const expectedDomain = getExpectedDomain();
    if (!isMatchingIitEmail(normalizedEmail, selectedIit, studentStatus as IitMemberStatus)) {
      const accountType = studentStatus === "alumni" ? "alumni" : "institute";
      toast.error(`Use your official ${selectedIit.name} ${accountType} email ending in @${expectedDomain}`);
      return;
    }
    setLoading(true);
    try {
      if (emailTestMode) {
        await completeEmailVerification(normalizedEmail);
        return;
      }
      const res = await supabase.functions.invoke("send-verification-email", {
        body: { email: normalizedEmail, iit_name: selectedIit.name, student_status: studentStatus, user_id: user?.id },
      });
      
      const data = res.data as any;
      
      // Handle errors from edge function (409 etc.)
      if (res.error) {
        const errMsg = data?.error || "Failed to send code";
        // If user already verified with same email, just go to onboarding
        if (data?.already_verified) {
          toast.success("Already verified! Let's complete your profile.");
          setStep("onboarding");
          setLoading(false);
          return;
        }
        if (data?.code === "EMAIL_ALREADY_LINKED" || data?.code === "USER_ALREADY_VERIFIED") {
          setExistingRecordMessage(errMsg);
          setLoading(false);
          return;
        }
        toast.error(errMsg);
        setLoading(false);
        return;
      }
      
      if (data?.error) {
        if (data?.code === "EMAIL_ALREADY_LINKED" || data?.code === "USER_ALREADY_VERIFIED") {
          setExistingRecordMessage(data.error);
        } else {
          toast.error(data.error);
        }
        setLoading(false);
        return;
      }
      // If already verified with same email, skip to onboarding
      if (data?.already_verified) {
        toast.success("Already verified! Let's complete your profile.");
        setStep("onboarding");
        setLoading(false);
        return;
      }
      toast.success("Verification code sent to your email!");
      setStep("verify_otp");
    } catch (err: any) {
      toast.error(err.message || "Failed to send verification code");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (otp.length !== 6) { toast.error("Please enter the 6-digit code"); return; }
    setLoading(true);
    try {
      const { data: testModeSetting } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "verification_test_mode")
        .maybeSingle();
      const isTestMode = emailTestMode || testModeSetting?.value === "true";

      let isValidCode = false;
      const normalizedEmail = email.trim().toLowerCase();

      if (isTestMode && otp === MOBILE_TEST_OTP) {
        isValidCode = true;
      } else {
        const { data: codeData } = await supabase
          .from("verification_codes")
          .select("*")
          .eq("email", normalizedEmail)
          .eq("code", otp)
          .eq("used", false)
          .gte("expires_at", new Date().toISOString())
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (codeData) {
          isValidCode = true;
          await supabase.from("verification_codes").update({ used: true } as any).eq("id", codeData.id);
        }
      }

      if (!isValidCode) {
        toast.error("Invalid or expired code. Please try again.");
        setLoading(false);
        return;
      }

      await completeEmailVerification(normalizedEmail);
    } catch (err: any) {
      toast.error(err.message || "Verification failed");
    } finally {
      setLoading(false);
    }
  };

  const handleDocumentUpload = async () => {
    if (!selectedIit || !studentStatus || !documentFile) {
      toast.error("Choose a document to continue");
      return;
    }
    const allowedTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
    if (!allowedTypes.has(documentFile.type)) {
      toast.error("Upload a PDF, JPG, PNG, or WebP file");
      return;
    }
    if (documentFile.size > 10 * 1024 * 1024) {
      toast.error("Document must be smaller than 10 MB");
      return;
    }
    setLoading(true);
    try {
      const mobileTestSession = readMobileTestSession();
      if (mobileTestSession) {
        saveMobileTestDocumentSubmission(selectedIit.name, studentStatus);
        setStep("documents_pending");
        toast.success("Test submission recorded locally");
        return;
      }
      if (!user) throw new Error("Your session expired. Please sign in again.");
      const extension = documentFile.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
      const path = `${user.id}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await supabase.storage.from("verification-documents").upload(path, documentFile, {
        cacheControl: "3600",
        contentType: documentFile.type,
        upsert: false,
      });
      if (uploadError) throw uploadError;
      const { error: insertError } = await (supabase as any).from("document_verifications").insert({
        user_id: user.id,
        iit_name: selectedIit.name,
        student_status: studentStatus,
        document_type: documentType,
        document_path: path,
        original_filename: documentFile.name,
        mime_type: documentFile.type,
        file_size: documentFile.size,
      });
      if (insertError) {
        await supabase.storage.from("verification-documents").remove([path]);
        throw insertError;
      }
      setStep("documents_pending");
      toast.success("Document submitted securely");
    } catch (error: any) {
      toast.error(error.message || "Could not submit your document");
    } finally {
      setLoading(false);
    }
  };

  const handleCheckDocumentStatus = async () => {
    if (readMobileTestSession()) {
      toast.info("Your test submission is still pending");
      return;
    }
    try {
      const result = await refetchDocumentSubmission();
      const submission = result.data;
      if (submission?.status === "approved") {
        await refetchProfile();
        toast.success("Your document has been approved");
        setStep("onboarding");
      } else if (submission?.status === "rejected") {
        setDocumentFile(null);
        setStep("upload_documents");
        toast.error(submission.review_notes || "Your document was not approved. Please submit another document.");
      } else {
        toast.info("Your verification is still being reviewed");
      }
    } catch (error: any) {
      toast.error(error.message || "Could not check verification status");
    }
  };

  const handleReturnToLogin = async () => {
    if (loading) return;
    setLoading(true);
    try {
      if (readMobileTestSession()) {
        clearMobileTestSession();
        window.location.replace("/auth");
        return;
      }
      const { error } = await supabase.auth.signOut({ scope: "local" });
      if (error) throw error;
      navigate("/auth", { replace: true });
    } catch (error: any) {
      toast.error(error.message || "Could not sign out. Please try again.");
      setLoading(false);
    }
  };

  const handleTryAnotherWay = async () => {
    if (loading) return;
    setLoading(true);
    try {
      if (readMobileTestSession()) {
        withdrawMobileTestDocumentSubmission();
      } else {
        if (!latestDocumentSubmission?.id || latestDocumentSubmission.status !== "pending") {
          throw new Error("No pending verification request was found");
        }
        const { error } = await (supabase as any).rpc("withdraw_document_verification", {
          p_submission_id: latestDocumentSubmission.id,
        });
        if (error) throw error;
        await refetchDocumentSubmission();
      }
      setEmail("");
      setOtp("");
      setStep("verify_email");
      toast.success("Document request withdrawn. Choose another verification method.");
    } catch (error: any) {
      toast.error(error.message || "Could not withdraw this request");
    } finally {
      setLoading(false);
    }
  };

  // Show onboarding wizard after verification
  if (step === "onboarding") {
    return (
      <PostVerifyOnboarding
        derivedIit={selectedIit?.name || profile?.iit_name || latestDocumentSubmission?.iit_name || deriveIitFromEmail(email)}
        onComplete={async () => {
          // Ensure profile is fresh before navigating
          await refetchProfile();
          navigate("/cirkle-forum", { replace: true });
        }}
      />
    );
  }

  const stepIndex = step === "select_iit" ? 0 : step === "select_status" ? 1 : 2;

  return (
    <div className="h-[100dvh] min-h-0 bg-background flex flex-col overflow-hidden" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div className="px-4 pt-6 pb-4 flex items-center gap-3">
        <button
          onClick={() => {
            if (step === "documents_pending") void handleReturnToLogin();
            else if (step === "upload_documents" || step === "verify_otp") setStep("verify_email");
            else if (step === "verify_email") setStep("select_status");
            else if (step === "select_status") setStep("select_iit");
            else navigate(-1);
          }}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex gap-1.5 flex-1">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={`h-1 flex-1 rounded-full transition-all duration-300 ${stepIndex >= i ? "bg-primary" : "bg-border"}`} />
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 px-4 pb-8 overflow-y-auto overscroll-y-contain touch-pan-y" style={{ WebkitOverflowScrolling: "touch" }}>
        {step === "select_iit" && (
          <div className="animate-fade-in max-w-2xl mx-auto">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                <GraduationCap className="w-6 h-6 text-primary" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Step 1 of 4</p>
                <h1 className="text-2xl font-bold tracking-tight text-foreground">Which IIT are you from?</h1>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mb-5 ml-[60px]">Select your institute to personalize your Cirkle community.</p>
            <div className="relative mb-5">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                autoFocus
                aria-label="Search all IITs"
                placeholder="Search all 23 IITs"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-secondary border-border rounded-xl h-12 pl-10"
              />
            </div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-foreground">All IITs</p>
              <span className="text-xs text-muted-foreground">{filteredIits.length} institutes</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pb-4">
              {filteredIits.map((iit) => (
                <button key={iit.studentDomain} onClick={() => handleSelectIit(iit)}
                  className="group min-h-[68px] px-4 py-2.5 rounded-2xl bg-card border border-border hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary transition-all text-left press-scale flex items-center gap-3">
                  <IitLogo iit={iit} customUrl={iitLogos[iitLogoSettingKey(iit.studentDomain)]} />
                  <span className="text-sm leading-5 text-foreground font-semibold group-hover:text-primary transition-colors">{iit.name}</span>
                </button>
              ))}
              {filteredIits.length === 0 && (
                <div className="col-span-full py-12 text-center">
                  <p className="font-semibold text-foreground">No IIT found</p>
                  <p className="text-sm text-muted-foreground mt-1">Try a city or institute name.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {step === "select_status" && (
          <div className="animate-fade-in max-w-lg mx-auto">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 className="w-4 h-4 text-primary" />
              <span className="text-sm text-primary font-medium">{selectedIit?.name}</span>
            </div>
            <h1 className="text-xl font-bold text-foreground mb-2 mt-4">Student or Alumni?</h1>
            <p className="text-sm text-muted-foreground mb-8">This helps personalize your experience</p>
            <div className="space-y-3">
              {[
                { value: "current_student", label: "🎓 Current Student", desc: `I'm currently studying at ${selectedIit?.name}` },
                { value: "alumni", label: "🏛️ Alumni", desc: `I graduated from ${selectedIit?.name}` },
              ].map(s => (
                <button key={s.value} onClick={() => handleSelectStatus(s.value)} className="w-full p-5 rounded-2xl bg-card border border-border hover:border-primary hover:bg-primary/5 transition-all text-left press-scale">
                  <p className="text-base font-bold text-foreground">{s.label}</p>
                  <p className="text-sm text-muted-foreground mt-1">{s.desc}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === "verify_email" && (
          <div className="animate-fade-in max-w-lg mx-auto">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">{selectedIit?.name}</span>
              <span className="text-xs bg-secondary text-muted-foreground px-2 py-0.5 rounded-full capitalize">{studentStatus?.replace("_", " ")}</span>
            </div>
            <div className="flex items-center gap-3 mt-6 mb-2">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                <Mail className="w-6 h-6 text-primary" />
              </div>
              <h1 className="text-xl font-bold text-foreground">Verify your email</h1>
            </div>
            <p className="text-sm text-muted-foreground mb-6">
              Enter your official <span className="text-foreground font-medium">@{getExpectedDomain()}</span> email. Other IIT or academic domains will not be accepted.
            </p>
            <Input type="email" placeholder={`yourname@${getExpectedDomain()}`} value={email} onChange={(e) => setEmail(e.target.value)} className="bg-secondary border-border h-12 rounded-xl mb-4" onKeyDown={(e) => e.key === "Enter" && handleSendCode()} />
            <Button size="lg" className="w-full h-12 text-base font-semibold rounded-xl" onClick={handleSendCode} disabled={loading}>
              {loading ? "Verifying..." : emailTestMode ? "Verify & Continue" : "Send Verification Code"}
            </Button>
            <p className="text-xs text-muted-foreground mt-4 text-center">{emailTestMode ? "Test mode skips the code step, but the official IIT domain is still required." : "We'll send a 6-digit code to verify that you own this email."}</p>
            <div className="flex items-center gap-3 my-6" aria-hidden="true">
              <div className="h-px bg-border flex-1" />
              <span className="text-xs font-medium text-muted-foreground">or</span>
              <div className="h-px bg-border flex-1" />
            </div>
            <Button variant="outline" size="lg" className="w-full h-12 text-sm font-semibold rounded-xl" onClick={() => setStep("upload_documents")}>
              <FileUp className="w-4 h-4 mr-2" /> Verify with documents
            </Button>
            <p className="text-xs text-muted-foreground mt-3 text-center">Use a student ID, admission letter, or degree certificate.</p>
          </div>
        )}

        {step === "upload_documents" && (
          <div className="animate-fade-in max-w-lg mx-auto">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">{selectedIit?.name}</span>
              <span className="text-xs bg-secondary text-muted-foreground px-2 py-0.5 rounded-full capitalize">{studentStatus?.replace("_", " ")}</span>
            </div>
            <div className="flex items-center gap-3 mt-6 mb-2">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center"><FileUp className="w-6 h-6 text-primary" /></div>
              <div>
                <h1 className="text-xl font-bold text-foreground">Verify with a document</h1>
                <p className="text-sm text-muted-foreground mt-0.5">A clear document helps us review faster.</p>
              </div>
            </div>
            <div className="space-y-4 mt-7">
              <div>
                <label htmlFor="document-type" className="text-sm font-semibold text-foreground">Document type</label>
                <select id="document-type" value={documentType} onChange={(event) => setDocumentType(event.target.value)} className="mt-2 w-full h-12 rounded-xl bg-secondary border border-border px-3 text-sm text-foreground">
                  <option value="student_id">Student ID card</option>
                  <option value="admission_letter">Admission letter</option>
                  <option value="degree_certificate">Degree certificate</option>
                  <option value="other">Other institute document</option>
                </select>
              </div>
              <label className="min-h-40 rounded-2xl border-2 border-dashed border-border hover:border-primary bg-card flex flex-col items-center justify-center text-center px-6 cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-primary">
                <FileUp className="w-7 h-7 text-primary mb-3" />
                <span className="text-sm font-semibold text-foreground">{documentFile ? documentFile.name : "Choose your document"}</span>
                <span className="text-xs text-muted-foreground mt-1">PDF, JPG, PNG, or WebP · maximum 10 MB</span>
                <input type="file" className="sr-only" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(event) => setDocumentFile(event.target.files?.[0] || null)} />
              </label>
              <div className="rounded-xl bg-primary/5 border border-primary/15 p-3 flex gap-3">
                <LockKeyhole className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                <p className="text-xs text-muted-foreground">Your document stays private and is available only to authorized admins during verification.</p>
              </div>
              <Button size="lg" className="w-full h-12 text-base font-semibold rounded-xl" onClick={handleDocumentUpload} disabled={loading || !documentFile}>
                {loading ? "Uploading securely..." : "Submit for verification"}
              </Button>
            </div>
          </div>
        )}

        {step === "documents_pending" && (
          <div className="animate-fade-in max-w-lg mx-auto min-h-[65vh] flex flex-col items-center justify-center text-center">
            <div className="w-20 h-20 rounded-3xl bg-primary/10 flex items-center justify-center mb-6"><Clock3 className="w-9 h-9 text-primary" /></div>
            <span className="text-xs font-bold uppercase tracking-[0.16em] text-primary">Submitted securely</span>
            <h1 className="text-2xl font-bold text-foreground mt-3">We’ll get back to you after verification</h1>
            <p className="text-sm text-muted-foreground mt-3 max-w-sm">Our team will review your institute document. You’ll get access as soon as it is approved.</p>
            <div className="mt-7 w-full rounded-2xl bg-card border border-border p-4 text-left">
              <div className="flex items-center justify-between gap-3"><span className="text-sm font-semibold text-foreground">Review status</span><span className="text-xs font-semibold bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))] px-2.5 py-1 rounded-full">Pending</span></div>
              <p className="text-xs text-muted-foreground mt-2">No action is needed right now. Your document remains private.</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full mt-4">
              <Button variant="outline" className="h-11 rounded-xl" onClick={handleCheckDocumentStatus} disabled={checkingDocumentStatus}>
                <RefreshCw className={`w-4 h-4 mr-2 ${checkingDocumentStatus ? "animate-spin" : ""}`} />
                {checkingDocumentStatus ? "Checking..." : "Check status"}
              </Button>
              <Button variant="ghost" className="h-11 rounded-xl" onClick={handleReturnToLogin} disabled={loading}>
                {loading ? "Signing out..." : "Return to login"}
              </Button>
            </div>
            <Button variant="link" className="mt-3 text-primary font-semibold" onClick={handleTryAnotherWay} disabled={loading}>
              Try another verification method
            </Button>
          </div>
        )}

        {step === "verify_otp" && (
          <div className="animate-fade-in max-w-lg mx-auto">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">{selectedIit?.name}</span>
              <span className="text-xs bg-secondary text-muted-foreground px-2 py-0.5 rounded-full">{email}</span>
            </div>
            <div className="flex items-center gap-3 mt-6 mb-2">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                <ShieldCheck className="w-6 h-6 text-primary" />
              </div>
              <h1 className="text-xl font-bold text-foreground">Enter verification code</h1>
            </div>
            <p className="text-sm text-muted-foreground mb-6">
              Enter the 6-digit code sent to <span className="text-foreground font-medium">{email}</span>
            </p>
            <div className="flex justify-center mb-6">
              <InputOTP maxLength={6} value={otp} onChange={setOtp}>
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>
            {emailTestMode && (
              <button onClick={() => setOtp(MOBILE_TEST_OTP)} className="text-xs text-primary font-semibold mb-4 block mx-auto hover:underline">Tap to use test code {MOBILE_TEST_OTP}</button>
            )}
            <Button size="lg" className="w-full h-12 text-base font-semibold rounded-xl" onClick={handleVerifyOtp} disabled={loading}>
              {loading ? "Verifying..." : "Verify & Continue"}
            </Button>
            <button onClick={() => { setOtp(""); handleSendCode(); }} className="text-xs text-primary mt-4 block mx-auto hover:underline">Resend Code</button>
          </div>
        )}
      </div>

      <Dialog open={!!existingRecordMessage} onOpenChange={(open) => !open && setExistingRecordMessage("")}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <div className="w-12 h-12 rounded-xl bg-destructive/10 flex items-center justify-center mb-2">
              <AlertCircle className="w-6 h-6 text-destructive" />
            </div>
            <DialogTitle>Already existing record</DialogTitle>
            <DialogDescription>{existingRecordMessage}</DialogDescription>
          </DialogHeader>
          <Button className="w-full h-11 rounded-xl" onClick={() => navigate("/auth", { replace: true })}>
            Go to login
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default IitVerification;
