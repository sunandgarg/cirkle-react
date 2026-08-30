import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { ArrowLeft, GraduationCap, CheckCircle2, Mail, ShieldCheck, AlertCircle, Search, FileUp, Clock3, LockKeyhole, RefreshCw, User, LogOut } from "lucide-react";
import PostVerifyOnboarding from "@/components/PostVerifyOnboarding";
import { useQuery } from "@tanstack/react-query";
import { defaultIitLogo, expectedIitEmailDomain, IIT_LIST, iitLogoSettingKey, isMatchingIitEmail, type IitInstitute, type IitMemberStatus } from "@/data/iitInstitutes";
import { readResumeRoute } from "@/lib/sessionResume";
import CountryCodeSelect, { COUNTRY_CODES, type CountryOption } from "@/components/CountryCodeSelect";
import { loadOnboardingProgress, saveOnboardingProgress } from "@/lib/onboardingProgress";
import { readEdgeFunctionError } from "@/lib/edgeFunctionError";

const IitLogo = ({ iit, customUrl }: { iit: IitInstitute; customUrl?: string }) => {
  const officialUrl = defaultIitLogo(iit.studentDomain);
  const [source, setSource] = useState(customUrl || officialUrl);
  const [failed, setFailed] = useState(false);
  const [wide, setWide] = useState(false);
  const usesWhiteOfficialMark = source === officialUrl && iit.studentDomain === "iitd.ac.in";
  const initials = iit.name
    .replace("IIT ", "")
    .replace(" (ISM)", "")
    .split(" ")
    .map((word) => word[0])
    .join("")
    .slice(0, 3)
    .toUpperCase();

  useEffect(() => {
    setSource(customUrl || officialUrl);
    setFailed(false);
    setWide(false);
  }, [customUrl, officialUrl]);

  return (
    <div className={`relative w-11 h-11 rounded-xl border border-border/70 shadow-sm flex items-center justify-center overflow-hidden shrink-0 ${usesWhiteOfficialMark ? "bg-[#5b1734]" : "bg-white"}`}>
      {failed ? (
        <span className="text-sm font-black tracking-tight text-primary">{initials}</span>
      ) : (
        <img
          src={source}
          alt={`${iit.name} logo`}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => {
            if (source !== officialUrl) {
              setSource(officialUrl);
              setWide(false);
              return;
            }
            setFailed(true);
          }}
          onLoad={(event) => {
            const image = event.currentTarget;
            setWide(image.naturalWidth / Math.max(image.naturalHeight, 1) > 1.65);
          }}
          className={wide
            ? `absolute h-9 w-auto max-w-none ${iit.studentDomain === "iitism.ac.in" ? "left-1/2 -translate-x-1/2" : "left-1.5"}`
            : "w-9 h-9 object-contain"}
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

type Step = "account_details" | "select_iit" | "select_status" | "verify_email" | "verify_otp" | "upload_documents" | "documents_pending" | "onboarding";

const IitVerification = () => {
  const navigate = useNavigate();
  const { user, profile, refetchProfile, loading: authLoading, profileResolved, profileError } = useAuth();
  const restoredProgressRef = useRef(false);
  const [step, setStep] = useState<Step>("account_details");
  const [selectedIit, setSelectedIit] = useState<IitInstitute | null>(null);
  const [studentStatus, setStudentStatus] = useState<string>("");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [accountName, setAccountName] = useState(() => profile?.name || (user?.user_metadata as any)?.full_name || (user?.user_metadata as any)?.name || "");
  const [country, setCountry] = useState<CountryOption>(COUNTRY_CODES[0]);
  const [phone, setPhone] = useState((profile as any)?.phone_number || "");
  const [searchQuery, setSearchQuery] = useState("");
  const [existingRecordMessage, setExistingRecordMessage] = useState("");
  const [documentType, setDocumentType] = useState("student_id");
  const [documentFile, setDocumentFile] = useState<File | null>(null);

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

  const { data: savedProgress, isFetched: progressFetched } = useQuery({
    queryKey: ["onboarding-progress", user?.id],
    queryFn: () => loadOnboardingProgress(user!.id),
    enabled: !!user,
    staleTime: 0,
    retry: 1,
  });

  const { data: latestDocumentSubmission, refetch: refetchDocumentSubmission, isFetching: checkingDocumentStatus, isFetched: documentStatusFetched } = useQuery({
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
    enabled: !!user,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (authLoading || !profileResolved || !user || !progressFetched || !documentStatusFetched || restoredProgressRef.current) return;
    restoredProgressRef.current = true;

    const saved = savedProgress?.progress_data;
    if (saved?.selectedIit) {
      const restoredIit = IIT_LIST.find((iit) => iit.name === saved.selectedIit);
      if (restoredIit) setSelectedIit(restoredIit);
    }
    if (saved?.studentStatus === "current_student" || saved?.studentStatus === "alumni") setStudentStatus(saved.studentStatus);
    if (saved?.iitEmail) setEmail(saved.iitEmail);
    if (saved?.accountName) setAccountName(saved.accountName);
    if (saved?.phone) setPhone(saved.phone);
    if (saved?.phoneCountryCode) {
      const savedCountry = COUNTRY_CODES.find((item) => item.code === saved.phoneCountryCode);
      if (savedCountry) setCountry(savedCountry);
    }

    if (profile?.is_verified && profile?.onboarding_completed && user?.id) {
      navigate(readResumeRoute(user.id), { replace: true });
      return;
    }
    if (latestDocumentSubmission?.iit_name) {
      const restoredIit = IIT_LIST.find((iit) => iit.name === latestDocumentSubmission.iit_name);
      if (restoredIit) setSelectedIit(restoredIit);
      setStudentStatus(latestDocumentSubmission.student_status);
    }
    if (latestDocumentSubmission?.status === "pending") {
      setStep("documents_pending");
      return;
    }
    if (latestDocumentSubmission?.status === "rejected") {
      setStep("upload_documents");
      return;
    }
    const accountComplete = !!profile?.name && !!(profile as any)?.phone_number;
    if (!accountComplete) {
      setStep("account_details");
      return;
    }
    if (profile?.is_verified && !profile.onboarding_completed) {
      setStep("onboarding");
      return;
    }

    const savedStep = savedProgress?.flow_step?.replace(/^verification:/, "") as Step | undefined;
    const validSteps: Step[] = ["select_iit", "select_status", "verify_email", "verify_otp", "upload_documents", "documents_pending"];
    const restoredIitName = saved?.selectedIit || latestDocumentSubmission?.iit_name;
    const restoredStatus = saved?.studentStatus || latestDocumentSubmission?.student_status;
    if (savedStep && validSteps.includes(savedStep)) {
      if ((savedStep === "select_status" || savedStep === "verify_email" || savedStep === "verify_otp" || savedStep === "upload_documents") && !restoredIitName) {
        setStep("select_iit");
      } else if ((savedStep === "verify_email" || savedStep === "verify_otp" || savedStep === "upload_documents") && !restoredStatus) {
        setStep("select_status");
      } else if (savedStep === "documents_pending") {
        setStep("verify_email");
      } else {
        setStep(savedStep);
      }
      return;
    }
    setStep("select_iit");
  }, [authLoading, documentStatusFetched, latestDocumentSubmission, navigate, profile, profileResolved, progressFetched, savedProgress, user]);

  useEffect(() => {
    if (!user || !restoredProgressRef.current || step === "onboarding" || profile?.onboarding_completed) return;
    const timeout = window.setTimeout(() => {
      void saveOnboardingProgress(user.id, `verification:${step}`, {
        selectedIit: selectedIit?.name,
        studentStatus: studentStatus as "current_student" | "alumni" | "",
        iitEmail: email.trim().toLowerCase(),
        accountName: accountName.trim(),
        phoneCountryCode: country.code,
        phone,
      }).catch((error) => console.warn("Could not save onboarding checkpoint", error));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [accountName, country.code, email, phone, profile?.onboarding_completed, selectedIit?.name, step, studentStatus, user]);

  useEffect(() => {
    if (profile?.name) {
      setAccountName(profile.name);
    } else if ((user?.user_metadata as any)?.full_name || (user?.user_metadata as any)?.name) {
      setAccountName((user?.user_metadata as any)?.full_name || (user?.user_metadata as any)?.name);
    }
    if ((profile as any)?.phone_number) setPhone((profile as any).phone_number);
  }, [profile, user?.user_metadata]);

  const filteredIits = IIT_LIST.filter((iit) =>
    iit.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleSelectIit = (iit: IitInstitute) => {
    setSelectedIit(iit);
    setStep("select_status");
  };

  const handleSelectStatus = (status: string) => {
    setStudentStatus(status);
    setStep("verify_email");
  };

  const handleSaveAccountDetails = async () => {
    const cleanPhone = phone.replace(/\D/g, "").slice(0, 10);
    if (accountName.trim().length < 2) {
      toast.error("Enter your name");
      return;
    }
    if (cleanPhone.length !== 10) {
      toast.error("A valid 10-digit phone number is required");
      return;
    }
    setLoading(true);
    try {
      const { error } = await (supabase as any).rpc("save_account_details", {
        p_name: accountName.trim(),
        p_phone_country_code: country.code,
        p_phone: cleanPhone,
      });
      if (error) throw error;
      await refetchProfile();
      setStep(profile?.is_verified ? "onboarding" : "select_iit");
    } catch (error: any) {
      toast.error(error.message || "Could not save your details");
    } finally {
      setLoading(false);
    }
  };

  const getExpectedDomain = () => {
    if (!selectedIit || (studentStatus !== "current_student" && studentStatus !== "alumni")) return "";
    return expectedIitEmailDomain(selectedIit, studentStatus);
  };

  const completeEmailVerification = async () => {
    await refetchProfile();
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
      const res = await supabase.functions.invoke("send-verification-email", {
        body: { email: normalizedEmail, iit_name: selectedIit.name, student_status: studentStatus },
      });
      
      const data = res.data as any;
      
      // Handle errors from edge function (409 etc.)
      if (res.error) {
        const parsed = await readEdgeFunctionError(res.error, data, "Could not send the verification code. Please try again.");
        const errMsg = parsed.message;
        // If user already verified with same email, just go to onboarding
        if (data?.already_verified) {
          await refetchProfile();
          toast.success("Already verified! Let's complete your profile.");
          setStep("onboarding");
          setLoading(false);
          return;
        }
        if (parsed.code === "EMAIL_ALREADY_LINKED" || parsed.code === "USER_ALREADY_VERIFIED") {
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
        await refetchProfile();
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
    if (!selectedIit || (studentStatus !== "current_student" && studentStatus !== "alumni")) {
      toast.error("Restart verification and choose your IIT again");
      setStep("select_iit");
      return;
    }
    setLoading(true);
    try {
      const normalizedEmail = email.trim().toLowerCase();
      const { data, error } = await supabase.functions.invoke("verify-iit-email", {
        body: {
          email: normalizedEmail,
          iit_name: selectedIit.name,
          student_status: studentStatus,
          code: otp,
        },
      });
      if (error) {
        const parsed = await readEdgeFunctionError(error, data, "Could not verify this code. Request a new code and try again.");
        throw new Error(parsed.message);
      }
      if (data?.error) throw new Error(data.error);
      await completeEmailVerification();
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
      if (user) {
        await saveOnboardingProgress(user.id, `verification:${step}`, {
          selectedIit: selectedIit?.name,
          studentStatus: studentStatus as "current_student" | "alumni" | "",
          iitEmail: email.trim().toLowerCase(),
          accountName: accountName.trim(),
          phoneCountryCode: country.code,
          phone,
        });
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
      if (!latestDocumentSubmission?.id || latestDocumentSubmission.status !== "pending") {
        throw new Error("No pending verification request was found");
      }
      const { error } = await (supabase as any).rpc("withdraw_document_verification", {
        p_submission_id: latestDocumentSubmission.id,
      });
      if (error) throw error;
      await refetchDocumentSubmission();
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

  if (user && !profileResolved) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background px-6">
        <div className="w-full max-w-sm text-center">
          {profileError ? (
            <>
              <h1 className="text-xl font-bold text-foreground">Could not load your verification</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{profileError}</p>
              <Button className="mt-5 rounded-xl" onClick={() => { void refetchProfile().catch(() => undefined); }}>
                Try again
              </Button>
            </>
          ) : (
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          )}
        </div>
      </div>
    );
  }

  // Show onboarding wizard after verification
  if (step === "onboarding") {
    return (
      <PostVerifyOnboarding
        derivedIit={selectedIit?.name || profile?.iit_name || latestDocumentSubmission?.iit_name || deriveIitFromEmail(email)}
        onBack={() => setStep("verify_email")}
        onComplete={async () => {
          // Ensure profile is fresh before navigating
          await refetchProfile();
          navigate(readResumeRoute(user?.id), { replace: true });
        }}
      />
    );
  }

  const stepIndex = step === "account_details" ? 0 : step === "select_iit" ? 1 : step === "select_status" ? 2 : step === "verify_email" ? 3 : 4;

  return (
    <div className="onboarding-shell">
      <header className="onboarding-topbar">
        <button
          aria-label="Go back"
          onClick={() => {
            if (step === "documents_pending") void handleTryAnotherWay();
            else if (step === "upload_documents" || step === "verify_otp") setStep("verify_email");
            else if (step === "verify_email") setStep("select_status");
            else if (step === "select_status") setStep("select_iit");
            else if (step === "select_iit") setStep("account_details");
            else navigate(-1);
          }}
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="truncate text-xs font-bold text-foreground">Verify your IIT identity</p>
            <span className="text-[10px] font-semibold text-muted-foreground">{Math.min(stepIndex + 1, 5)} of 5</span>
          </div>
          <div className="flex gap-1.5" aria-label={`Verification step ${Math.min(stepIndex + 1, 5)} of 5`}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${stepIndex >= i ? "bg-primary shadow-[0_3px_10px_-4px_hsl(var(--primary))]" : "bg-border"}`} />
          ))}
          </div>
        </div>
        <button
          aria-label="Log out"
          title="Log out"
          onClick={() => void handleReturnToLogin()}
          disabled={loading}
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
        >
          <LogOut className="h-5 w-5" />
        </button>
      </header>

      <div className="onboarding-scroll touch-pan-y">
        {step === "account_details" && (
          <div className="onboarding-stage animate-fade-in">
            <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-5">
              <User className="w-7 h-7 text-primary" />
            </div>
            <span className="text-xs font-bold uppercase tracking-[0.16em] text-primary">Account verified</span>
            <h1 className="text-2xl font-black tracking-tight text-foreground mt-2 mb-2">Add your basic details</h1>
            <p className="text-sm leading-6 text-muted-foreground mb-6">
              We use these required details to create your profile before IIT verification. Your phone number is never shown publicly.
            </p>
            <div className="space-y-4">
              <div>
                <label htmlFor="account-name" className="mb-1.5 block text-sm font-semibold text-foreground">Full name <span className="text-destructive" aria-hidden="true">*</span></label>
                <Input
                  id="account-name"
                  value={accountName}
                  onChange={(event) => setAccountName(event.target.value)}
                  placeholder="e.g., Rahul Sharma"
                  className="h-12 rounded-xl bg-secondary border-border text-[16px]"
                  autoComplete="name"
                  onKeyDown={(event) => event.key === "Enter" && handleSaveAccountDetails()}
                />
              </div>
              <div>
                <label htmlFor="account-phone" className="mb-1.5 block text-sm font-semibold text-foreground">
                  Phone number <span className="text-destructive" aria-hidden="true">*</span>
                </label>
                <div className="flex items-center gap-2">
                  <CountryCodeSelect value={country} onChange={setCountry} className="h-12 w-[96px] justify-center rounded-xl bg-secondary" />
                  <Input
                    id="account-phone"
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel-national"
                    placeholder="10-digit number"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 10))}
                    className="h-12 min-w-0 flex-1 rounded-xl bg-secondary border-border text-[16px]"
                    maxLength={10}
                    onKeyDown={(event) => event.key === "Enter" && handleSaveAccountDetails()}
                  />
                </div>
              </div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground"><span className="text-destructive">*</span> Required fields</p>
            <Button className="mt-4 h-12 w-full rounded-xl font-bold" onClick={handleSaveAccountDetails} disabled={loading || accountName.trim().length < 2 || phone.length !== 10}>
              {loading ? "Saving..." : "Continue to IIT verification"}
            </Button>
          </div>
        )}

        {step === "select_iit" && (
          <div className="onboarding-stage animate-fade-in !max-w-2xl">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                <GraduationCap className="w-6 h-6 text-primary" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Personalize your community</p>
                <h1 className="text-2xl font-black tracking-tight text-foreground">Which IIT are you from?</h1>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mb-5 ml-[60px]">Select your institute to personalize your Cirkle community.</p>
            <div className="relative mb-5">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
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
                  className="onboarding-option group flex min-h-[68px] items-center gap-3 px-4 py-2.5">
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
          <div className="onboarding-stage animate-fade-in">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 className="w-4 h-4 text-primary" />
              <span className="text-sm text-primary font-medium">{selectedIit?.name}</span>
            </div>
            <h1 className="text-2xl font-black tracking-tight text-foreground mb-2 mt-4">How are you connected?</h1>
            <p className="text-sm leading-6 text-muted-foreground mb-6">We’ll use this only to show the right current-student or alumni spaces.</p>
            <div className="space-y-3">
              {[
                { value: "current_student", label: "🎓 Current Student", desc: `I'm currently studying at ${selectedIit?.name}` },
                { value: "alumni", label: "🏛️ Alumni", desc: `I graduated from ${selectedIit?.name}` },
              ].map(s => (
                <button key={s.value} onClick={() => handleSelectStatus(s.value)} className="onboarding-option w-full p-5">
                  <p className="text-base font-bold text-foreground">{s.label}</p>
                  <p className="text-sm text-muted-foreground mt-1">{s.desc}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === "verify_email" && (
          <div className="onboarding-stage animate-fade-in">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">{selectedIit?.name}</span>
              <span className="text-xs bg-secondary text-muted-foreground px-2 py-0.5 rounded-full capitalize">{studentStatus?.replace("_", " ")}</span>
            </div>
            <div className="flex items-center gap-3 mt-6 mb-2">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                <Mail className="w-6 h-6 text-primary" />
              </div>
              <h1 className="text-2xl font-black tracking-tight text-foreground">Verify your email</h1>
            </div>
            <p className="text-sm text-muted-foreground mb-6">
              Enter your official <span className="text-foreground font-medium">@{getExpectedDomain()}</span> email. Other IIT or academic domains will not be accepted.
            </p>
            <Input type="email" placeholder={`yourname@${getExpectedDomain()}`} value={email} onChange={(e) => setEmail(e.target.value)} className="bg-secondary border-border h-12 rounded-xl mb-4" onKeyDown={(e) => e.key === "Enter" && handleSendCode()} />
            <Button size="lg" className="w-full h-12 text-base font-semibold rounded-xl" onClick={handleSendCode} disabled={loading}>
              {loading ? "Sending..." : "Send Verification Code"}
            </Button>
            <p className="text-xs text-muted-foreground mt-4 text-center">We'll send a 6-digit code to verify that you own this email.</p>
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
          <div className="onboarding-stage animate-fade-in">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">{selectedIit?.name}</span>
              <span className="text-xs bg-secondary text-muted-foreground px-2 py-0.5 rounded-full capitalize">{studentStatus?.replace("_", " ")}</span>
            </div>
            <div className="flex items-center gap-3 mt-6 mb-2">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center"><FileUp className="w-6 h-6 text-primary" /></div>
              <div>
                <h1 className="text-2xl font-black tracking-tight text-foreground">Verify with a document</h1>
                <p className="text-sm text-muted-foreground mt-0.5">A clear document helps us review faster.</p>
              </div>
            </div>
            <div className="space-y-4 mt-7">
              {latestDocumentSubmission?.status === "rejected" && (
                <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
                  <p className="font-semibold">Your previous document was not approved.</p>
                  <p className="mt-1 text-xs leading-5">{latestDocumentSubmission.review_notes || "Upload a clearer institute document or go back to verify with your IIT email."}</p>
                </div>
              )}
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
          <div className="onboarding-stage animate-fade-in flex min-h-[min(65vh,580px)] flex-col items-center justify-center text-center">
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
          <div className="onboarding-stage animate-fade-in">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">{selectedIit?.name}</span>
              <span className="text-xs bg-secondary text-muted-foreground px-2 py-0.5 rounded-full">{email}</span>
            </div>
            <div className="flex items-center gap-3 mt-6 mb-2">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                <ShieldCheck className="w-6 h-6 text-primary" />
              </div>
              <h1 className="text-2xl font-black tracking-tight text-foreground">Enter verification code</h1>
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
            <Button size="lg" className="w-full h-12 text-base font-semibold rounded-xl" onClick={handleVerifyOtp} disabled={loading}>
              {loading ? "Verifying..." : "Verify & Continue"}
            </Button>
            <button onClick={() => { setOtp(""); handleSendCode(); }} className="text-xs text-primary mt-4 block mx-auto hover:underline">Resend Code</button>
          </div>
        )}
      </div>

      <Dialog open={!!existingRecordMessage} onOpenChange={(open) => !open && setExistingRecordMessage("")}>
        <DialogContent className="max-h-[88dvh] w-[calc(100%_-_1.5rem)] max-w-sm overflow-y-auto rounded-[24px] p-5 sm:p-6">
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
