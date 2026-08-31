import { useState, useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { CheckCircle2, ArrowRight, ArrowLeft, GraduationCap, Briefcase, Sparkles, Clock3, RefreshCw, LogOut } from "lucide-react";
import SearchableSelect from "@/components/SearchableSelect";
import { locations } from "@/data/locationsList";
import { companies } from "@/data/companiesList";
import { ALL_COURSES, getSpecialisations } from "@/data/courseSpecialisations";
import { clearMobileTestCourseRequest, clearMobileTestSession, readMobileTestSession, saveMobileTestCourseRequest, updateMobileTestSession, withdrawMobileTestCourseRequest } from "@/lib/mobileVerification";
import { useQuery } from "@tanstack/react-query";
import { clearOnboardingProgress, loadOnboardingProgress, saveOnboardingProgress } from "@/lib/onboardingProgress";
import { convertToWebP } from "@/lib/imageUtils";
import { findCompanyOption, shouldOfferInitialCompanyLogo } from "@/lib/companyCatalog";
import { reportError } from "@/lib/errorTelemetry";

const YEARS = Array.from({ length: 56 }, (_, i) => String(2035 - i));

type Step = "degree" | "specialisation" | "year" | "optional" | "course_pending" | "done";
const STEP_ORDER: Step[] = ["degree", "specialisation", "year", "optional"];

interface PostVerifyOnboardingProps {
  derivedIit?: string;
  onComplete: () => void;
  onBack?: () => void;
  academicRecovery?: boolean;
}

const PostVerifyOnboarding = ({ derivedIit, onComplete, onBack, academicRecovery = false }: PostVerifyOnboardingProps) => {
  const { user, profile, refetchProfile } = useAuth();
  const restoredProgressRef = useRef(false);
  const [step, setStep] = useState<Step>("degree");
  const [loading, setLoading] = useState(false);

  const [name, setName] = useState(profile?.name || "");
  const iit = derivedIit || profile?.iit_name || "";
  const [degree, setDegree] = useState("");
  const [otherCourse, setOtherCourse] = useState("");
  const [specialisation, setSpecialisation] = useState("");
  const [year, setYear] = useState("");
  const [location, setLocation] = useState(profile?.location || "");
  const [linkedin, setLinkedin] = useState("");
  const [company, setCompany] = useState("");
  const [companyLogoUrl, setCompanyLogoUrl] = useState("");
  const [uploadingCompanyLogo, setUploadingCompanyLogo] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [termsText, setTermsText] = useState("I agree to the Cirkle Terms of Service and Privacy Policy.");
  const mobileTestSession = readMobileTestSession();
  const phone = (profile as any)?.phone_number || "";
  const phoneCountryCode = (profile as any)?.phone_country_code || "+91";

  const { data: savedProgress, isFetched: progressFetched } = useQuery({
    queryKey: ["onboarding-progress", user?.id],
    queryFn: () => loadOnboardingProgress(user!.id),
    enabled: !!user && !mobileTestSession,
    staleTime: 0,
    retry: 1,
  });

  const { data: courseRequest, refetch: refetchCourseRequest, isFetching: checkingCourse } = useQuery({
    queryKey: ["my-course-verification", user?.id],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("course_verification_requests")
        .select("id,course_name,iit_name,applicant_name,status,review_notes")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as { id: string; course_name: string; iit_name: string; applicant_name?: string; status: "pending" | "approved" | "rejected" | "withdrawn"; review_notes?: string } | null;
    },
    enabled: !!user && !mobileTestSession,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  const { data: customCompanyOptions = [] } = useQuery({
    queryKey: ["onboarding-company-options", user?.id],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("custom_options")
        .select("id,category,value,status,created_by,logo_url")
        .eq("category", "company")
        .order("value");
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!user && !mobileTestSession,
    staleTime: 60_000,
  });

  const onboardingCompanyOptions = useMemo(() => [
    ...new Set([
      ...companies,
      ...customCompanyOptions.map((option: any) => option.value as string),
    ]),
  ].sort(), [customCompanyOptions]);
  const selectedCompanyOption = findCompanyOption(company, customCompanyOptions);
  const isNewCustomCompany = shouldOfferInitialCompanyLogo(company, false, companies, customCompanyOptions);

  useEffect(() => {
    supabase.from("app_settings").select("value").eq("key", "terms_text").maybeSingle()
      .then(({ data }) => { if (data?.value) setTermsText(data.value); });
  }, []);

  const activeStepOrder = academicRecovery ? (["degree", "specialisation", "year"] as Step[]) : STEP_ORDER;
  const stepIdx = activeStepOrder.indexOf(step);
  const totalSteps = activeStepOrder.length;

  const specialisations = useMemo(() => getSpecialisations(degree), [degree]);

  useEffect(() => {
    if (!user || mobileTestSession || !progressFetched || restoredProgressRef.current) return;
    restoredProgressRef.current = true;
    const saved = savedProgress?.progress_data;
    if (!saved) return;
    if (saved.name) setName(saved.name);
    if (saved.degree) setDegree(saved.degree);
    if (saved.otherCourse) setOtherCourse(saved.otherCourse);
    if (saved.specialisation) setSpecialisation(saved.specialisation);
    if (saved.year) setYear(saved.year);
    if (saved.location) setLocation(saved.location);
    if (saved.linkedin) setLinkedin(saved.linkedin);
    if (saved.company) setCompany(saved.company);
    if (saved.companyLogoUrl) setCompanyLogoUrl(saved.companyLogoUrl);
    if (saved.acceptedTerms) setAcceptedTerms(true);
    const savedStep = savedProgress?.flow_step?.replace(/^profile:/, "") as Step | undefined;
    if (savedStep && STEP_ORDER.includes(savedStep)) setStep(savedStep);
  }, [mobileTestSession, progressFetched, savedProgress, user]);

  useEffect(() => {
    if (!user || mobileTestSession || !restoredProgressRef.current || step === "done") return;
    const timeout = window.setTimeout(() => {
      void saveOnboardingProgress(user.id, `profile:${step}`, {
        name: name.trim(),
        degree,
        otherCourse: otherCourse.trim(),
        specialisation,
        year,
        location,
        linkedin: linkedin.trim(),
        company,
        companyLogoUrl,
        acceptedTerms,
      }).catch((error) => console.warn("Could not save profile checkpoint", error));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [acceptedTerms, company, companyLogoUrl, degree, linkedin, location, mobileTestSession, name, otherCourse, specialisation, step, user, year]);

  useEffect(() => {
    if (mobileTestSession?.courseApprovalStatus === "pending" && mobileTestSession.customCourseName) {
      setOtherCourse(mobileTestSession.customCourseName);
      setStep("course_pending");
      return;
    }
    if (courseRequest?.status === "pending" || courseRequest?.status === "rejected") {
      setOtherCourse(courseRequest.course_name);
      if (courseRequest.applicant_name) setName(courseRequest.applicant_name);
      setStep("course_pending");
      return;
    }
    if (courseRequest?.status === "approved") {
      setDegree(courseRequest.course_name);
      if (courseRequest.applicant_name) setName(courseRequest.applicant_name);
      setStep("specialisation");
    }
  }, [courseRequest, mobileTestSession?.courseApprovalStatus, mobileTestSession?.customCourseName]);

  const canProceed = () => {
    switch (step) {
      case "degree": return !!degree && (degree !== "Other" || otherCourse.trim().length >= 2);
      case "specialisation": return !!specialisation;
      case "year": return !!year;
      case "optional": return acceptedTerms;
      default: return true;
    }
  };

  const handleNext = () => {
    if (step === "degree" && degree === "Other") {
      void handleSubmitCustomCourse();
      return;
    }
    if (stepIdx < activeStepOrder.length - 1) {
      setStep(activeStepOrder[stepIdx + 1]);
    } else {
      handleComplete();
    }
  };

  const handleSubmitCustomCourse = async () => {
    if (!user || !iit) return;
    const courseName = otherCourse.trim().replace(/\s+/g, " ");
    if (courseName.length < 2 || courseName.length > 100) {
      toast.error("Enter a course name between 2 and 100 characters");
      return;
    }
    if (ALL_COURSES.some((course) => course !== "Other" && course.toLowerCase() === courseName.toLowerCase())) {
      toast.error("That course is already listed. Please select it above.");
      return;
    }
    setLoading(true);
    try {
      if (mobileTestSession) {
        saveMobileTestCourseRequest(courseName);
      } else {
        const { error } = await (supabase as any).from("course_verification_requests").insert({
          user_id: user.id,
          course_name: courseName,
          iit_name: iit,
          applicant_name: name.trim(),
        });
        if (error) throw error;
        await refetchCourseRequest();
      }
      setOtherCourse(courseName);
      setStep("course_pending");
      toast.success("Course sent for admin approval");
    } catch (error: any) {
      reportError(error, { flow: "member_onboarding", action: "submit_custom_course" });
      toast.error(error.message || "Could not submit your course");
    } finally {
      setLoading(false);
    }
  };

  const handleChooseAnotherCourse = async () => {
    setLoading(true);
    try {
      if (mobileTestSession) {
        withdrawMobileTestCourseRequest();
      } else if (courseRequest?.status === "pending") {
        const { error } = await (supabase as any).rpc("withdraw_course_verification", { p_request_id: courseRequest.id });
        if (error) throw error;
        await refetchCourseRequest();
      }
      setDegree("");
      setOtherCourse("");
      setSpecialisation("");
      setStep("degree");
    } catch (error: any) {
      reportError(error, { flow: "member_onboarding", action: "change_custom_course", severity: "warning" });
      toast.error(error.message || "Could not change your course");
    } finally {
      setLoading(false);
    }
  };

  const handleCheckCourseStatus = async () => {
    if (mobileTestSession) {
      toast.info("Your test course is still pending admin approval");
      return;
    }
    const result = await refetchCourseRequest();
    if (result.data?.status === "approved") toast.success("Course approved — continue your profile");
    else if (result.data?.status === "rejected") toast.error(result.data.review_notes || "Course was not approved. Choose another course.");
    else toast.info("Your course is still pending admin approval");
  };

  const handleReturnToLogin = async () => {
    setLoading(true);
    try {
      if (mobileTestSession) {
        clearMobileTestSession();
        window.location.replace("/auth");
        return;
      }
      if (user) {
        await saveOnboardingProgress(user.id, `profile:${step}`, {
          name: name.trim(), degree, otherCourse: otherCourse.trim(), specialisation, year,
          location, linkedin: linkedin.trim(), company, acceptedTerms,
        });
      }
      const { error } = await supabase.auth.signOut({ scope: "local" });
      if (error) throw error;
      window.location.replace("/auth");
    } catch (error: any) {
      toast.error(error.message || "Could not sign out");
      setLoading(false);
    }
  };

  const handleBack = () => {
    if (stepIdx > 0) setStep(activeStepOrder[stepIdx - 1]);
    else if (onBack) onBack();
    else window.history.back();
  };

  const uploadCompanyLogo = async (file: File) => {
    if (!user || !isNewCustomCompany) return;
    setUploadingCompanyLogo(true);
    try {
      const optimized = await convertToWebP(file, 0.82, 512);
      const path = `${user.id}/${crypto.randomUUID()}.webp`;
      const { error } = await supabase.storage.from("entity-logos").upload(path, optimized, {
        contentType: "image/webp",
        cacheControl: "31536000",
      });
      if (error) throw error;
      const { data } = supabase.storage.from("entity-logos").getPublicUrl(path);
      setCompanyLogoUrl(data.publicUrl);
      toast.success("Company logo ready");
    } catch (error: any) {
      reportError(error, { flow: "member_onboarding", action: "upload_company_logo" });
      toast.error(error.message || "Logo upload failed");
    } finally {
      setUploadingCompanyLogo(false);
    }
  };

  const handleComplete = async () => {
    if (!user) return;
    setLoading(true);
    try {
      if (readMobileTestSession()) {
        clearMobileTestCourseRequest();
        updateMobileTestSession({
          name: name.trim(),
          iitName: iit,
          degree,
          specialisation,
          passingYear: year,
          isVerified: true,
          onboardingCompleted: true,
        });
        await refetchProfile();
        toast.success("Test profile complete! Welcome to Cirkle 🎉");
        onComplete();
        return;
      }
      let companyOption = selectedCompanyOption as any;
      if (isNewCustomCompany) {
        const { data, error } = await (supabase as any).rpc("submit_custom_option", {
          p_category: "company",
          p_value: company.trim(),
          p_logo_url: companyLogoUrl || null,
        });
        if (error) throw error;
        companyOption = data?.[0];
      }

      // One database transaction owns education, primary profile linkage and
      // optional details. A refresh can no longer observe a half-saved profile.
      const { error: onboardingError } = await (supabase as any).rpc("complete_member_onboarding", {
        p_name: name.trim(),
        p_iit_name: iit,
        p_degree: degree,
        p_specialisation: specialisation,
        p_passing_year: year,
        p_location: location || null,
        p_linkedin: linkedin.trim() || null,
        p_company: company.trim() || null,
        p_phone_country_code: phone ? phoneCountryCode : null,
        p_phone: phone || null,
      });
      if (onboardingError) throw onboardingError;

      if (company.trim() && companyOption) {
        const optionId = companyOption.option_id || companyOption.id;
        const optionLogo = companyOption.option_logo_url || companyOption.logo_url || null;
        const { error: experienceError } = await (supabase as any)
          .from("professional_experience")
          .update({
            is_other_company: true,
            company_option_id: optionId,
            logo_url: optionLogo,
          })
          .eq("user_id", user.id)
          .eq("is_current", true)
          .ilike("company_name", company.trim());
        if (experienceError) throw experienceError;
      }

      await clearOnboardingProgress(user.id);
      await refetchProfile();
      toast.success("Profile complete! Welcome to Cirkle 🎉");
      onComplete();
    } catch (err: any) {
      reportError(err, { flow: "member_onboarding", action: "complete_profile" });
      toast.error(err.message || "Failed to save profile");
    } finally {
      setLoading(false);
    }
  };

  if (step === "course_pending") {
    const rejected = courseRequest?.status === "rejected";
    return (
      <div className="onboarding-shell fixed inset-0 z-50">
        <header className="onboarding-topbar">
          <button aria-label="Go back" onClick={() => void handleChooseAnotherCourse()} disabled={loading} className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1 text-center text-xs font-bold text-foreground">Course verification</div>
          <button aria-label="Log out" title="Log out" onClick={() => void handleReturnToLogin()} disabled={loading} className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50">
            <LogOut className="h-5 w-5" />
          </button>
        </header>
        <div className="onboarding-scroll flex items-center">
        <div className="onboarding-stage my-auto text-center animate-fade-in">
          <div className={`w-20 h-20 rounded-3xl flex items-center justify-center mx-auto mb-6 ${rejected ? "bg-destructive/10" : "bg-primary/10"}`}>
            {rejected ? <GraduationCap className="w-9 h-9 text-destructive" /> : <Clock3 className="w-9 h-9 text-primary" />}
          </div>
          <span className={`text-xs font-bold uppercase tracking-[0.16em] ${rejected ? "text-destructive" : "text-primary"}`}>
            {rejected ? "Needs another selection" : "Admin review in progress"}
          </span>
          <h1 className="text-2xl font-bold text-foreground mt-3">
            {rejected ? "This course wasn’t approved" : "Your course is pending approval"}
          </h1>
          <p className="text-sm text-muted-foreground mt-3 leading-6">
            {rejected ? (courseRequest?.review_notes || "Choose a listed course or submit a different course name.") : "You’re done for now. We’ll keep your place and bring you back here whenever you log in."}
          </p>

          <div className="mt-7 rounded-2xl bg-card border border-border p-4 text-left shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Course submitted</p>
            <p className="text-base font-bold text-foreground mt-1 break-words">{otherCourse || mobileTestSession?.customCourseName}</p>
            <div className="flex items-center justify-between mt-4 pt-3 border-t border-border">
              <span className="text-xs text-muted-foreground">Verification status</span>
              <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${rejected ? "bg-destructive/10 text-destructive" : "bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))]"}`}>
                {rejected ? "Not approved" : "Pending"}
              </span>
            </div>
          </div>

          <div className="space-y-2.5 mt-5">
            {!rejected && (
              <Button variant="outline" className="w-full h-12 rounded-xl font-semibold" onClick={handleCheckCourseStatus} disabled={checkingCourse}>
                <RefreshCw className={`w-4 h-4 mr-2 ${checkingCourse ? "animate-spin" : ""}`} />
                {checkingCourse ? "Checking..." : "Check approval status"}
              </Button>
            )}
            <Button className="w-full h-12 rounded-xl font-semibold" onClick={handleChooseAnotherCourse} disabled={loading}>
              <GraduationCap className="w-4 h-4 mr-2" /> Choose another course
            </Button>
            <Button variant="ghost" className="w-full h-11 rounded-xl text-muted-foreground" onClick={handleReturnToLogin} disabled={loading}>
              <LogOut className="w-4 h-4 mr-2" /> {loading ? "Signing out..." : "Return to login"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-5">Only authorized admins can review custom course names.</p>
        </div></div>
      </div>
    );
  }

  if (step === "done") {
    return (
      <div className="onboarding-shell fixed inset-0 z-50 items-center justify-center p-6">
        <div className="onboarding-stage text-center animate-fade-in">
          <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-6">
            <Sparkles className="w-10 h-10 text-primary" />
          </div>
          <h2 className="text-2xl font-bold text-foreground mb-2">You're all set!</h2>
          <p className="text-muted-foreground">Welcome to your IIT community.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="onboarding-shell fixed inset-0 z-50">
      {/* Progress */}
      <header className="onboarding-topbar">
        <button aria-label="Go back" onClick={handleBack} className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="truncate text-xs font-bold text-foreground">Build your Cirkle profile</span>
            <span className="text-[10px] font-semibold text-muted-foreground">{stepIdx + 1} of {totalSteps}</span>
          </div>
          <div className="flex gap-1.5" aria-label={`Profile step ${stepIdx + 1} of ${totalSteps}`}>
          {activeStepOrder.map((_, i) => (
            <div key={i} className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${stepIdx >= i ? "bg-primary shadow-[0_3px_10px_-4px_hsl(var(--primary))]" : "bg-border"}`} />
          ))}
          </div>
        </div>
        <button aria-label="Log out" title="Log out" onClick={() => void handleReturnToLogin()} disabled={loading} className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50">
          <LogOut className="h-5 w-5" />
        </button>
      </header>

      <div className="onboarding-scroll">
        <div className="onboarding-stage">
          {/* Locked IIT badge */}
          {iit && (
            <div className="flex items-center gap-2 mb-4">
              <CheckCircle2 className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium text-primary">{iit}</span>
              <span className="text-xs text-muted-foreground">(verified)</span>
            </div>
          )}

          {step === "degree" && (
            <div className="animate-fade-in">
              {academicRecovery && (
                <div className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary mb-4">
                  <Sparkles className="w-3.5 h-3.5" /> 3 quick details to build your groups
                </div>
              )}
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                <GraduationCap className="w-6 h-6 text-primary" />
              </div>
              <h2 className="text-2xl font-black tracking-tight text-foreground mb-1">Select your program</h2>
              <p className="text-sm text-muted-foreground mb-6">{academicRecovery ? "We’ll use this only to place you in the right course, batch, and cohort conversations." : "Choose your primary course of study."}</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {ALL_COURSES.map(d => (
                  <button key={d} onClick={() => { if (degree !== d) setSpecialisation(""); setDegree(d); }}
                    className={`onboarding-option min-h-[52px] text-center text-sm ${
                      degree === d ? "onboarding-option-selected" : ""
                    }`}>
                    {d}
                  </button>
                ))}
              </div>
              {degree === "Other" && (
                <div className="mt-5 rounded-2xl border border-primary/20 bg-primary/5 p-4 animate-fade-in">
                  <label htmlFor="other-course" className="text-sm font-semibold text-foreground">Enter your course name</label>
                  <p className="text-xs text-muted-foreground mt-1 mb-3">Use the official name shown by your institute.</p>
                  <Input id="other-course" value={otherCourse} onChange={(event) => setOtherCourse(event.target.value.slice(0, 100))} placeholder="e.g., Master of Urban Systems" className="h-12 rounded-xl bg-background border-border text-[16px]" />
                  <div className="flex justify-between mt-2"><span className="text-[11px] text-muted-foreground">Admin approval required</span><span className="text-[11px] text-muted-foreground">{otherCourse.trim().length}/100</span></div>
                </div>
              )}
            </div>
          )}

          {step === "specialisation" && (
            <div className="animate-fade-in">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">{degree}</span>
              </div>
              <h2 className="text-2xl font-black tracking-tight text-foreground mb-1">Select your specialisation</h2>
              <p className="text-sm text-muted-foreground mb-6">Your branch or area of focus</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {specialisations.map(b => (
                  <button key={b} onClick={() => setSpecialisation(b)}
                    className={`onboarding-option min-h-[52px] text-sm ${
                      specialisation === b ? "onboarding-option-selected" : ""
                    }`}>
                    {b}
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === "year" && (
            <div className="animate-fade-in">
              <h2 className="text-2xl font-black tracking-tight text-foreground mb-1">Your graduation year</h2>
              <p className="text-sm text-muted-foreground mb-6">This creates your batch and cohort conversations automatically.</p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {YEARS.map(y => (
                  <button key={y} onClick={() => setYear(y)}
                    className={`onboarding-option min-h-[50px] text-center text-sm ${
                      year === y ? "onboarding-option-selected" : ""
                    }`}>
                    {y}
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === "optional" && (
            <div className="animate-fade-in">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                <Briefcase className="w-6 h-6 text-primary" />
              </div>
              <h2 className="text-2xl font-black tracking-tight text-foreground mb-1">Make the network useful</h2>
              <p className="text-sm leading-6 text-muted-foreground mb-6">Optional details help people find relevant peers. You can edit them later.</p>
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Location</label>
                  <SearchableSelect
                    options={locations}
                    value={location}
                    onChange={setLocation}
                    placeholder="Search city worldwide..."
                    allowOther={true}
                    className="rounded-xl"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">LinkedIn URL</label>
                  <Input value={linkedin} onChange={e => setLinkedin(e.target.value)} placeholder="https://linkedin.com/in/..." className="h-12 rounded-xl bg-secondary border-border text-[16px]" inputMode="url" autoComplete="url" />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Current Company</label>
                  <SearchableSelect
                    options={onboardingCompanyOptions}
                    value={company}
                    onChange={(value) => {
                      setCompany(value);
                      if (findCompanyOption(value, customCompanyOptions) || companies.some((item) => item.toLowerCase() === value.trim().toLowerCase())) {
                        setCompanyLogoUrl("");
                      }
                    }}
                    placeholder="Search company..."
                    allowOther={true}
                    className="rounded-xl"
                  />
                </div>
                {isNewCustomCompany && (
                  <div className="rounded-2xl border border-border bg-secondary/50 p-3">
                    <p className="text-sm font-medium text-foreground">Company logo (optional)</p>
                    <div className="mt-2 flex items-center gap-3">
                      {companyLogoUrl ? <img src={companyLogoUrl} alt="Company preview" className="h-12 w-12 rounded-xl border border-border bg-white object-contain p-1" /> : <div className="grid h-12 w-12 place-items-center rounded-xl bg-background"><Briefcase className="h-5 w-5 text-muted-foreground" /></div>}
                      <label className="cursor-pointer rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold hover:border-primary">
                        {uploadingCompanyLogo ? "Uploading..." : "Upload logo"}
                        <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={uploadingCompanyLogo} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadCompanyLogo(file); event.target.value = ""; }} />
                      </label>
                    </div>
                    <p className="mt-2 text-[10px] leading-4 text-muted-foreground">Available only while submitting a new company. The logo is converted to WebP and reviewed with the company.</p>
                  </div>
                )}

                {/* Terms acceptance */}
                <label className="flex min-h-12 cursor-pointer select-none items-start gap-3 rounded-2xl border border-border bg-secondary/50 p-3">
                  <input
                    type="checkbox"
                    checked={acceptedTerms}
                    onChange={(e) => setAcceptedTerms(e.target.checked)}
                    className="mt-0.5 h-5 w-5 flex-shrink-0 rounded border-border accent-primary"
                  />
                  <span className="text-xs text-muted-foreground leading-snug">{termsText}</span>
                </label>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom action */}
      {(step as string) !== "done" && (
      <div className="onboarding-footer">
          <div className="max-w-lg mx-auto">
            <Button
              className="w-full h-12 rounded-xl font-bold gap-2 shadow-[0_14px_30px_-16px_hsl(var(--primary))]"
              onClick={handleNext}
              disabled={!canProceed() || loading}
            >
              {loading ? "Saving..." : academicRecovery && step === "year" ? "Create My Groups" : step === "optional" ? "Complete Profile" : step === "degree" && degree === "Other" ? "Submit for approval" : "Continue"}
              {!loading && <ArrowRight className="w-4 h-4" />}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default PostVerifyOnboarding;
