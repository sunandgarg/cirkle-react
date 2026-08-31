import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Pencil, Settings, MapPin, BadgeCheck, UserPlus, Check, MessageSquare,
  LogOut, Camera, GraduationCap, Calendar, Briefcase, Share2, LinkIcon,
  Plus, X, Trash2, Phone, Video, ShieldCheck, Link2
} from "lucide-react";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";
import SearchableSelect from "@/components/SearchableSelect";
import ExpertiseSelect from "@/components/ExpertiseSelect";
import { institutions } from "@/data/institutionsList";
import { passingYears } from "@/data/dropdownOptions";
import { ALL_COURSES, getSpecialisations } from "@/data/courseSpecialisations";
import { companies } from "@/data/companiesList";
import { locations } from "@/data/locationsList";
import { clearMobileTestSession } from "@/lib/mobileVerification";
import { defaultIitLogo, IIT_LIST } from "@/data/iitInstitutes";
import { buildSocialLinks, MENTOR_CATEGORIES, readSocialLinks, SOCIAL_FIELDS, socialLabel, type CustomSocialLink } from "@/lib/profileOptions";
import { compressProfileImage, convertToWebP } from "@/lib/imageUtils";
import { findCompanyOption, shouldOfferInitialCompanyLogo } from "@/lib/companyCatalog";
import { effectiveMemberStatus } from "@/lib/memberStatus";

const PROFILE_TABS = [
  { label: "About Me", compact: "About" },
  { label: "Education", compact: "Edu" },
  { label: "Professional Details", compact: "Career" },
  { label: "Expertise", compact: "Skills" },
  { label: "Pricing Information", compact: "Pricing" },
  { label: "Social Handles", compact: "Social" },
  { label: "Activity", compact: "Activity" },
] as const;

const formatMemberStatus = (status?: string | null) => status
  ? status.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase())
  : "";

const getIitLogo = (name?: string | null) => {
  const institute = IIT_LIST.find((item) => item.name.toLowerCase() === name?.trim().toLowerCase());
  return institute ? defaultIitLogo(institute.studentDomain) : null;
};

const Profile = () => {
  const { userId, slug } = useParams();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const { user, profile: myProfile, isAdmin, refetchProfile: refetchAuthProfile } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Determine if we're looking up by slug or userId
  const isSlugRoute = location.pathname.startsWith("/u/");
  const isOwnProfile = !userId && !slug || userId === user?.id;
  const [resolvedUserId, setResolvedUserId] = useState<string | null>(isOwnProfile ? user?.id || null : userId || null);

  const [activeTab, setActiveTab] = useState(0);
  const [editingSection, setEditingSection] = useState<string | null>(searchParams.get("edit") === "true" ? "about" : null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // Slug edit state
  const [editingSlug, setEditingSlug] = useState(false);
  const [slugInput, setSlugInput] = useState("");

  // Section-specific edit forms
  const [aboutForm, setAboutForm] = useState({ name: "", headline: "", bio: "", location: "", date_of_birth: "" });
  const [expertiseList, setExpertiseList] = useState<string[]>([]);
  const [pricingForm, setPricingForm] = useState({ is_mentor: false, mentor_category: "", mentor_price_chat: "", mentor_price_audio: "", mentor_price_video: "" });
  const [socialForm, setSocialForm] = useState<Record<string, string>>({});
  const [customSocialLinks, setCustomSocialLinks] = useState<CustomSocialLink[]>([]);
  const [eduForm, setEduForm] = useState({ institution: "", degree: "", branch_area: "", passing_year: "", location: "" });
  const [editingEducationId, setEditingEducationId] = useState<string | null>(null);
  const [expForm, setExpForm] = useState({ company_name: "", job_title: "", start_date: "", end_date: "", location: "", is_current: false, logo_url: "" });
  const [editingExperienceId, setEditingExperienceId] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState<"avatar_url" | "cover_photo_url" | "company_logo" | null>(null);

  // Resolve slug to user_id
  const { data: slugProfile } = useQuery({
    queryKey: ["profile-by-slug", slug],
    queryFn: async () => {
      if (!slug) return null;
      const { data } = await supabase.from("profiles").select("user_id").eq("slug", slug).maybeSingle();
      return data;
    },
    enabled: isSlugRoute && !!slug,
  });

  useEffect(() => {
    if (isSlugRoute && slugProfile) {
      setResolvedUserId(slugProfile.user_id);
    } else if (!isSlugRoute) {
      setResolvedUserId(isOwnProfile ? user?.id || null : userId || null);
    }
  }, [slugProfile, isSlugRoute, isOwnProfile, user?.id, userId]);

  const targetId = resolvedUserId;
  const isOwn = targetId === user?.id;

  const { data: profile, refetch: refetchProfile, isFetched: profileFetched } = useQuery({
    queryKey: ["profile", targetId],
    queryFn: async () => {
      if (!targetId) return null;
      const { data } = await supabase.from("profiles").select("*").eq("user_id", targetId).maybeSingle();
      return data;
    },
    enabled: !!targetId,
    placeholderData: isOwn ? myProfile : undefined,
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnMount: false,
  });

  const { data: education, refetch: refetchEducation } = useQuery({
    queryKey: ["education", targetId],
    queryFn: async () => {
      if (!targetId) return [];
      const { data } = await supabase.from("education").select("*").eq("user_id", targetId).order("created_at", { ascending: false });
      return data ?? [];
    },
    enabled: !!targetId, staleTime: 5 * 60 * 1000, refetchOnMount: false,
  });

  const { data: experience, refetch: refetchExperience } = useQuery({
    queryKey: ["professional_experience", targetId],
    queryFn: async () => {
      if (!targetId) return [];
      const { data } = await supabase.from("professional_experience").select("*").eq("user_id", targetId).order("created_at", { ascending: false });
      return data ?? [];
    },
    enabled: !!targetId, staleTime: 5 * 60 * 1000, refetchOnMount: false,
  });

  const { data: customOptions = [] } = useQuery({
    queryKey: ["profile-custom-options", user?.id],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("custom_options").select("*").order("value");
      if (error) throw error;
      return (data ?? []) as any[];
    },
    enabled: !!user,
    staleTime: 60_000,
  });

  const { data: pendingProfileOptions = [] } = useQuery({
    queryKey: ["pending-profile-options", user?.id],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("pending_profile_options").select("*").eq("user_id", user!.id);
      if (error) throw error;
      return (data ?? []) as any[];
    },
    enabled: !!user && isOwn,
  });

  const approvedOrMine = (category: string) => customOptions
    .filter((option: any) => option.category === category && (option.status === "approved" || option.created_by === user?.id))
    .map((option: any) => option.value as string);
  const companyOptions = [...new Set([...companies, ...approvedOrMine("company")])].sort();
  const institutionOptions = [...new Set([...institutions, ...approvedOrMine("institution")])].sort();
  const locationOptions = [...new Set([...locations, ...approvedOrMine("location")])].sort();
  const mentorCategoryOptions = [...new Set([...MENTOR_CATEGORIES, ...approvedOrMine("mentor_category")])].sort();
  const selectedCompanyOption = findCompanyOption(expForm.company_name, customOptions);
  const isNewCustomCompany = shouldOfferInitialCompanyLogo(expForm.company_name, !!editingExperienceId, companies, customOptions);

  const { data: connectionStatus } = useQuery({
    queryKey: ["connection-status", targetId],
    queryFn: async () => {
      if (!user || isOwn || !targetId) return "none";
      const { data } = await supabase.from("connections").select("*")
        .or(`and(requester_id.eq.${user.id},receiver_id.eq.${targetId}),and(requester_id.eq.${targetId},receiver_id.eq.${user.id})`);
      if (!data || data.length === 0) return "none";
      return data[0].status;
    },
    enabled: !!user && !isOwn && !!targetId,
  });

  const { data: userActivity } = useQuery({
    queryKey: ["user-activity", targetId],
    queryFn: async () => {
      if (!targetId) return [];
      // Only show home feed posts (channel is null), exclude forum messages
      const { data: posts } = await supabase.from("posts").select("*").eq("author_id", targetId).eq("is_anonymous", false)
        .is("channel", null)
        .order("created_at", { ascending: false }).limit(20);
      return (posts || []).map(p => ({ type: p.reshared_post_id ? "reshare" : "post", data: p, date: p.created_at }))
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    },
    enabled: !!targetId,
  });

  const { data: stats } = useQuery({
    queryKey: ["profile-stats", targetId],
    queryFn: async () => {
      if (!targetId) return { posts: 0, connections: 0, sessions: 0 };
      const [postsRes, connectionsRes, sessionsRes] = await Promise.all([
        supabase.from("posts").select("id", { count: "exact", head: true }).eq("author_id", targetId),
        supabase.from("connections").select("id", { count: "exact", head: true })
          .or(`requester_id.eq.${targetId},receiver_id.eq.${targetId}`).eq("status", "accepted"),
        supabase.from("consultations").select("id", { count: "exact", head: true })
          .or(`consultant_id.eq.${targetId},client_id.eq.${targetId}`),
      ]);
      return { posts: postsRes.count || 0, connections: connectionsRes.count || 0, sessions: sessionsRes.count || 0 };
    },
    enabled: !!targetId,
  });

  useEffect(() => {
    if (profile) {
      setAboutForm({ name: (profile as any).name || "", headline: (profile as any).headline || "", bio: (profile as any).bio || "", location: (profile as any).location || "", date_of_birth: (profile as any).date_of_birth || "" });
      setExpertiseList((profile as any).skills || []);
      setPricingForm({ is_mentor: !!(profile as any).is_mentor, mentor_category: (profile as any).mentor_category || "", mentor_price_chat: (profile as any).mentor_price_chat?.toString() || "", mentor_price_audio: (profile as any).mentor_price_audio?.toString() || "", mentor_price_video: (profile as any).mentor_price_video?.toString() || "" });
      const parsedSocial = readSocialLinks((profile as any).social_links as any || {});
      setSocialForm(parsedSocial.fixed);
      setCustomSocialLinks(parsedSocial.custom);
    }
  }, [profile]);

  useEffect(() => {
    if (!isOwn || pendingProfileOptions.length === 0) return;
    const pendingLocation = pendingProfileOptions.find((item: any) => item.field === "location");
    const pendingCategory = pendingProfileOptions.find((item: any) => item.field === "mentor_category");
    if (pendingLocation) setAboutForm((current) => ({ ...current, location: pendingLocation.value }));
    if (pendingCategory) setPricingForm((current) => ({ ...current, mentor_category: pendingCategory.value }));
  }, [isOwn, pendingProfileOptions]);

  const saveSection = useMutation({
    mutationFn: async (section: string) => {
      if (!user) return;
      let update: any = {};
      if (section === "about") {
        if (!aboutForm.name?.trim()) throw new Error("Name is required");
        const locationValue = aboutForm.location.trim();
        const isCustomLocation = !!locationValue && !locations.includes(locationValue) && !customOptions.some((option: any) => option.category === "location" && option.status === "approved" && option.value === locationValue);
        if (isCustomLocation) {
          const { error } = await (supabase as any).rpc("submit_profile_custom_value", { p_field: "location", p_value: locationValue });
          if (error) throw error;
        }
        update = {
          name: aboutForm.name.trim(),
          headline: aboutForm.headline.trim() || null,
          bio: aboutForm.bio.trim() || null,
          ...(isCustomLocation ? {} : { location: locationValue || null }),
          date_of_birth: aboutForm.date_of_birth || null,
        };
      } else if (section === "expertise") {
        update = { skills: expertiseList };
      } else if (section === "pricing") {
        const categoryValue = pricingForm.mentor_category.trim();
        const isCustomCategory = !!categoryValue && !MENTOR_CATEGORIES.includes(categoryValue as any) && !customOptions.some((option: any) => option.category === "mentor_category" && option.status === "approved" && option.value === categoryValue);
        if (pricingForm.is_mentor && isCustomCategory) {
          const { error } = await (supabase as any).rpc("submit_profile_custom_value", { p_field: "mentor_category", p_value: categoryValue });
          if (error) throw error;
        }
        update = {
          is_mentor: pricingForm.is_mentor,
          ...(isCustomCategory ? {} : { mentor_category: categoryValue || null }),
          mentor_price_chat: pricingForm.mentor_price_chat ? (parseInt(pricingForm.mentor_price_chat) || null) : null,
          mentor_price_audio: pricingForm.mentor_price_audio ? (parseInt(pricingForm.mentor_price_audio) || null) : null,
          mentor_price_video: pricingForm.mentor_price_video ? (parseInt(pricingForm.mentor_price_video) || null) : null,
        };
      } else if (section === "social") {
        update = { social_links: buildSocialLinks(socialForm, customSocialLinks) };
      }
      const { error } = await supabase.from("profiles").update(update as any).eq("user_id", user.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ["profile"] });
      queryClient.invalidateQueries({ queryKey: ["profile-custom-options"] });
      queryClient.invalidateQueries({ queryKey: ["pending-profile-options"] });
      await refetchProfile();
      await refetchAuthProfile();
      setEditingSection(null);
      toast.success("Saved successfully", { description: "Custom catalog values stay private until an admin approves them." });
    },
    onError: (err: any) => toast.error(err.message),
  });

  const addEducation = useMutation({
    mutationFn: async () => {
      if (!user || !eduForm.institution) throw new Error("Institution required");
      const isOtherInstitution = !institutions.includes(eduForm.institution);
      const knownSpecs = eduForm.degree ? getSpecialisations(eduForm.degree) : [];
      const isOtherBranch = eduForm.branch_area ? !knownSpecs.includes(eduForm.branch_area) : false;
      const submitOption = async (category: string, value: string) => {
        const { data, error } = await (supabase as any).rpc("submit_custom_option", { p_category: category, p_value: value, p_logo_url: null });
        if (error) throw error;
        return data?.[0] as any;
      };
      const institutionOption = isOtherInstitution ? await submitOption("institution", eduForm.institution) : null;
      const branchOption = isOtherBranch ? await submitOption("branch", eduForm.branch_area) : null;
      const locationOption = eduForm.location && !locations.includes(eduForm.location) ? await submitOption("location", eduForm.location) : null;
      const payload = {
        user_id: user.id,
        institution: eduForm.institution,
        degree: eduForm.degree || null,
        branch_area: eduForm.branch_area || null,
        passing_year: eduForm.passing_year || null,
        location: eduForm.location || null,
        is_other_institution: isOtherInstitution,
        is_other_branch: isOtherBranch,
        institution_option_id: institutionOption?.option_id || null,
        branch_option_id: branchOption?.option_id || null,
        location_option_id: locationOption?.option_id || null,
      };
      const query = editingEducationId
        ? (supabase as any).from("education").update(payload).eq("id", editingEducationId).eq("user_id", user.id)
        : (supabase as any).from("education").insert(payload);
      const { error } = await query;
      if (error) throw new Error(error.message);
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ["education", targetId] });
      await refetchEducation();
      setEditingSection(null);
      setEditingEducationId(null);
      setEduForm({ institution: "", degree: "", branch_area: "", passing_year: "", location: "" });
      toast.success(editingEducationId ? "Education updated" : "Education added", { description: "Custom values remain visible only to you until approved." });
    },
    onError: (err: any) => toast.error(err.message),
  });

  const deleteEducation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("education").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["education", targetId] }); refetchEducation(); toast.success("Deleted"); },
    onError: (error: any) => toast.error(error.message || "This education cannot be deleted"),
  });

  const addExperience = useMutation({
    mutationFn: async () => {
      if (!user || !expForm.company_name) throw new Error("Company required");
      const isOtherCompany = !companies.some((company) => company.toLowerCase() === expForm.company_name.trim().toLowerCase());
      let companyOption: any = null;
      if (isOtherCompany) {
        const { data, error } = await (supabase as any).rpc("submit_custom_option", {
          p_category: "company",
          p_value: expForm.company_name,
          p_logo_url: !editingExperienceId && !selectedCompanyOption ? expForm.logo_url || null : null,
        });
        if (error) throw error;
        companyOption = data?.[0];
      }
      let locationOption: any = null;
      if (expForm.location && !locations.includes(expForm.location)) {
        const { data, error } = await (supabase as any).rpc("submit_custom_option", { p_category: "location", p_value: expForm.location, p_logo_url: null });
        if (error) throw error;
        locationOption = data?.[0];
      }
      const payload: Record<string, unknown> = {
        user_id: user.id,
        company_name: expForm.company_name,
        job_title: expForm.job_title || null,
        start_date: expForm.start_date || null,
        end_date: expForm.is_current ? null : (expForm.end_date || null),
        is_current: expForm.is_current,
        location: expForm.location || null,
        is_other_company: isOtherCompany,
        company_option_id: companyOption?.option_id || null,
        location_option_id: locationOption?.option_id || null,
      };
      if (!editingExperienceId) {
        payload.logo_url = expForm.logo_url || companyOption?.option_logo_url || null;
      } else {
        const originalExperience = experience?.find((item: any) => item.id === editingExperienceId);
        const companyChanged = originalExperience?.company_name?.trim().toLowerCase() !== expForm.company_name.trim().toLowerCase();
        if (companyChanged) payload.logo_url = companyOption?.option_logo_url || null;
      }
      const query = editingExperienceId
        ? (supabase as any).from("professional_experience").update(payload).eq("id", editingExperienceId).eq("user_id", user.id)
        : (supabase as any).from("professional_experience").insert(payload);
      const { error } = await query;
      if (error) throw new Error(error.message);
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ["professional_experience", targetId] });
      await refetchExperience();
      setEditingSection(null);
      setEditingExperienceId(null);
      setExpForm({ company_name: "", job_title: "", start_date: "", end_date: "", location: "", is_current: false, logo_url: "" });
      toast.success(editingExperienceId ? "Experience updated" : "Experience added", { description: "Custom companies remain private until approved." });
    },
    onError: (err: any) => toast.error(err.message),
  });

  const deleteExperience = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("professional_experience").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["professional_experience", targetId] }); refetchExperience(); toast.success("Deleted"); },
    onError: (error: any) => toast.error(error.message || "Could not delete experience"),
  });

  const saveSlug = useMutation({
    mutationFn: async () => {
      if (!user) return;
      const clean = slugInput.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
      if (clean.length < 3 || clean.length > 50) throw new Error("Slug must be 3-50 characters");
      // Check uniqueness
      const { data: existing } = await supabase.from("profiles").select("user_id").eq("slug", clean).maybeSingle();
      if (existing && existing.user_id !== user.id) throw new Error("This URL is already taken");
      const { error } = await supabase.from("profiles").update({ slug: clean, slug_updated_at: new Date().toISOString() } as any).eq("user_id", user.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: async () => {
      await refetchProfile();
      await refetchAuthProfile();
      setEditingSlug(false);
      toast.success("Profile URL updated!");
    },
    onError: (err: any) => toast.error(err.message),
  });

  const sendConnect = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("connections").insert({ requester_id: user!.id, receiver_id: targetId!, community_id: "default", status: "pending" });
      if (error) throw error;
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["connection-status"] }); toast.success("Request sent!"); },
  });

  const uploadImage = async (file: File, bucket: string, field: string) => {
    if (!user) return;
    const profileField = field as "avatar_url" | "cover_photo_url";
    setUploadingPhoto(profileField);
    try {
      const optimized = await compressProfileImage(file, field === "cover_photo_url" ? 1920 : 800);
      const extension = optimized.type === "image/png" ? "png" : "jpg";
      const path = `${user.id}/${field}-${Date.now()}.${extension}`;
      const { error: uploadError } = await supabase.storage.from(bucket).upload(path, optimized, { upsert: false, contentType: optimized.type, cacheControl: "31536000" });
      if (uploadError) throw uploadError;
      const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(path);
      const { error: profileError } = await supabase.from("profiles").update({ [field]: urlData.publicUrl } as any).eq("user_id", user.id);
      if (profileError) throw profileError;
      await refetchProfile();
      await refetchAuthProfile();
      toast.success("Photo updated", { description: "Optimized toward a 30% size reduction while preserving JPEG/PNG format." });
    } catch (err: any) { toast.error(err.message || "Photo upload failed"); }
    finally { setUploadingPhoto(null); }
  };

  const uploadCompanyLogo = async (file: File) => {
    if (!user) return;
    setUploadingPhoto("company_logo");
    try {
      const optimized = await convertToWebP(file, 0.82, 512);
      const path = `${user.id}/${crypto.randomUUID()}.webp`;
      const { error } = await supabase.storage.from("entity-logos").upload(path, optimized, { contentType: "image/webp", cacheControl: "31536000" });
      if (error) throw error;
      const { data } = supabase.storage.from("entity-logos").getPublicUrl(path);
      setExpForm((current) => ({ ...current, logo_url: data.publicUrl }));
      toast.success("Company logo ready");
    } catch (error: any) {
      toast.error(error.message || "Logo upload failed");
    } finally {
      setUploadingPhoto(null);
    }
  };

  const handleLogout = async () => { clearMobileTestSession(); await supabase.auth.signOut({ scope: "local" }); navigate("/"); };

  if (!user && isOwn) { navigate("/auth"); return null; }

  const displayProfile = isOwn ? (profile || myProfile) : profile;
  const primaryEducation = education?.find((item: any) => item.id === (displayProfile as any)?.primary_education_id)
    || education?.find((item: any) => item.is_verified)
    || education?.[0];
  const displayMemberStatus = effectiveMemberStatus((displayProfile as any)?.student_status, (primaryEducation as any)?.passing_year);
  const skills = (displayProfile as any)?.skills || [];
  const socialLinks = (displayProfile as any)?.social_links as any || {};
  const profileSlug = (displayProfile as any)?.slug;
  const slugUpdatedAt = (displayProfile as any)?.slug_updated_at;
  const pendingLocationValue = isOwn ? pendingProfileOptions.find((item: any) => item.field === "location")?.value : null;
  const pendingMentorCategory = isOwn ? pendingProfileOptions.find((item: any) => item.field === "mentor_category")?.value : null;
  const formatCount = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);

  const shareUrl = profileSlug ? `${window.location.origin}/u/${profileSlug}` : window.location.href;

  const EditButton = ({ section, tab }: { section: string; tab?: number }) => (
    isOwn ? (
      <button onClick={() => { if (tab !== undefined) setActiveTab(tab); setEditingSection(section); }}
        className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/10">
        <Pencil className="w-3 h-3" /> Edit
      </button>
    ) : null
  );

  if (targetId && !displayProfile && !profileFetched) {
    return (
      <div className="min-h-screen w-full overflow-hidden bg-background">
        <div className="h-48 animate-pulse bg-primary/35 sm:h-56" />
        <div className="relative z-10 mx-auto -mt-14 w-full max-w-3xl px-3 sm:px-5">
          <div className="h-64 animate-pulse rounded-[24px] border border-border bg-card shadow-sm" />
          <div className="mt-4 h-12 animate-pulse rounded-2xl bg-card" />
          <div className="mt-4 h-52 animate-pulse rounded-[24px] bg-card" />
        </div>
      </div>
    );
  }

  if (targetId && !displayProfile && profileFetched) {
    return (
      <div className="grid min-h-[60vh] place-items-center bg-background px-6 text-center">
        <div><h1 className="text-lg font-bold text-foreground">Profile unavailable</h1><p className="mt-1 text-sm text-muted-foreground">This member profile could not be found.</p><Button className="mt-4 rounded-xl" onClick={() => navigate(-1)}>Go back</Button></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full overflow-x-hidden bg-background pb-[max(2rem,env(safe-area-inset-bottom))]">
      {/* Cover */}
      <div className="profile-cover relative h-48 overflow-hidden sm:h-56">
        {(displayProfile as any)?.cover_photo_url ? <><img src={(displayProfile as any).cover_photo_url} alt="Cover" className="absolute inset-0 h-full w-full object-cover object-center" loading="eager" decoding="async" /><div className="absolute inset-0 bg-gradient-to-b from-black/15 via-transparent to-black/10" /></>
          : <div className="absolute inset-0 bg-gradient-to-br from-primary via-primary/80 to-primary/60" />}
        <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-3 pt-[max(1rem,env(safe-area-inset-top))] sm:px-5">
          <button aria-label="Go back" onClick={() => navigate(-1)} className="grid h-10 w-10 place-items-center rounded-full border border-white/30 bg-card/80 shadow-sm backdrop-blur-md transition-transform active:scale-95"><ArrowLeft className="h-[18px] w-[18px] text-foreground" /></button>
          <div className="flex items-center gap-2">
            {isOwn && (
              <>
                <button aria-label="Change cover photo" disabled={!!uploadingPhoto} onClick={() => coverInputRef.current?.click()} className="grid h-10 w-10 place-items-center rounded-full border border-white/30 bg-card/80 shadow-sm backdrop-blur-md transition-transform active:scale-95 disabled:opacity-50" title="Change cover"><Camera className="w-4 h-4 text-foreground" /></button>
                <input ref={coverInputRef} type="file" accept="image/jpeg,image/png" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadImage(f, "avatars", "cover_photo_url"); e.target.value = ""; }} />
                <button aria-label="Open settings" onClick={() => navigate("/settings")} className="grid h-10 w-10 place-items-center rounded-full border border-white/30 bg-card/80 shadow-sm backdrop-blur-md transition-transform active:scale-95"><Settings className="w-4 h-4 text-foreground" /></button>
              </>
            )}
          </div>
        </div>
      </div>

      <main className="relative z-10 mx-auto -mt-14 w-full max-w-3xl px-3 sm:-mt-16 sm:px-5">
        {/* Avatar + Name */}
        <div className="rounded-[24px] border border-border/80 bg-card p-4 shadow-[0_14px_35px_-22px_rgba(15,23,42,0.45)] sm:p-5">
          <div className="mb-3 flex items-end gap-3.5 -mt-[58px] sm:gap-4">
            <div className="flex-shrink-0 relative">
              {(displayProfile as any)?.avatar_url ? (
                <div className="h-[104px] w-[104px] overflow-hidden rounded-full border-[5px] border-card bg-secondary shadow-lg"><img src={(displayProfile as any).avatar_url} alt="Profile" className="h-full w-full object-cover" decoding="async" /></div>
              ) : (
                <div className="flex h-[104px] w-[104px] items-center justify-center rounded-full border-[5px] border-card bg-secondary shadow-lg"><span className="text-3xl font-bold text-primary">{((displayProfile as any)?.name || "?")[0]}</span></div>
              )}
              {isOwn && (
                <>
                  <button aria-label="Change profile photo" disabled={!!uploadingPhoto} onClick={() => avatarInputRef.current?.click()} className="absolute bottom-0 right-0 grid h-8 w-8 place-items-center rounded-full border-[3px] border-card bg-primary text-primary-foreground shadow-md transition-transform active:scale-95 disabled:opacity-50"><Camera className="w-3 h-3" /></button>
                  <input ref={avatarInputRef} type="file" accept="image/jpeg,image/png" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadImage(f, "avatars", "avatar_url"); e.target.value = ""; }} />
                </>
              )}
            </div>
            <div className="min-w-0 flex-1 overflow-hidden pb-1.5">
              <div className="flex items-center gap-1.5 flex-wrap">
                <h1 className="break-words text-xl font-black tracking-tight text-foreground">{(displayProfile as any)?.name || "Anonymous"}</h1>
                {(displayProfile as any)?.is_verified && <BadgeCheck className="w-5 h-5 text-primary flex-shrink-0" />}
              </div>
              {(displayProfile as any)?.headline && <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{(displayProfile as any).headline}</p>}
              {/* Slug URL display */}
              {profileSlug && (
                <div className="flex items-center gap-1 mt-1">
                  <Link2 className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                  <span className="text-[10px] text-muted-foreground truncate">cirkle.app/u/{profileSlug}</span>
                  {isOwn && !slugUpdatedAt && (
                    <button onClick={() => { setSlugInput(profileSlug); setEditingSlug(true); }} className="text-[10px] text-primary hover:underline ml-1 flex-shrink-0">Edit</button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Slug edit modal */}
          {editingSlug && (
            <div className="bg-secondary/50 rounded-xl p-3 mb-3 space-y-2">
              <Label className="text-xs">Custom Profile URL</Label>
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground">/u/</span>
                <Input value={slugInput} onChange={e => setSlugInput(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                  className="bg-background border-border h-8 text-sm flex-1" placeholder="your-custom-url" />
              </div>
              <p className="text-[10px] text-muted-foreground">Lowercase letters, numbers, hyphens only. You can only change this once.</p>
              <div className="flex gap-2">
                <Button size="sm" className="text-xs h-7" onClick={() => saveSlug.mutate()} disabled={saveSlug.isPending}>{saveSlug.isPending ? "Saving..." : "Save"}</Button>
                <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => setEditingSlug(false)}>Cancel</Button>
              </div>
            </div>
          )}

          <div className="mb-3 mt-4 grid grid-cols-3 rounded-2xl border border-border/50 bg-secondary/55 px-1 py-3">
            <div className="text-center"><p className="text-lg font-black leading-none text-foreground">{formatCount(stats?.connections || 0)}</p><p className="mt-1.5 text-[10px] font-medium text-muted-foreground">Connections</p></div>
            <div className="border-x border-border text-center"><p className="text-lg font-black leading-none text-foreground">{formatCount(stats?.posts || 0)}</p><p className="mt-1.5 text-[10px] font-medium text-muted-foreground">Posts</p></div>
            <div className="text-center"><p className="text-lg font-black leading-none text-foreground">{formatCount(stats?.sessions || 0)}</p><p className="mt-1.5 text-[10px] font-medium text-muted-foreground">Sessions</p></div>
          </div>
          <div className="flex min-w-0 gap-2">
            {isOwn ? (
              <>
                <Button className="h-10 min-w-0 flex-1 gap-1 rounded-xl text-xs font-semibold" onClick={() => { setActiveTab(0); setEditingSection("about"); }}><Pencil className="w-3.5 h-3.5" /> Edit Profile</Button>
                <Button aria-label="Share profile" title="Share profile" variant="outline" className="h-10 w-10 shrink-0 rounded-xl p-0" onClick={() => { navigator.clipboard.writeText(shareUrl); toast.success("Link copied!"); }}><Share2 className="w-3.5 h-3.5" /></Button>
                {isAdmin && <Button variant="outline" className="h-10 shrink-0 gap-1 rounded-xl px-2.5 text-xs sm:px-3" onClick={() => navigate("/admin")}><ShieldCheck className="w-3.5 h-3.5" /> Admin</Button>}
                <Button aria-label="Log out" title="Log out" variant="outline" className="h-10 w-10 shrink-0 rounded-xl p-0" onClick={handleLogout}><LogOut className="w-3.5 h-3.5" /></Button>
              </>
            ) : (
              <>
                {connectionStatus === "none" && <Button className="flex-1 rounded-xl h-9 gap-1 text-xs" onClick={() => sendConnect.mutate()}><UserPlus className="w-3.5 h-3.5" /> Connect</Button>}
                {connectionStatus === "pending" && <Button variant="outline" className="flex-1 rounded-xl h-9 text-xs" disabled><Check className="w-3.5 h-3.5 mr-1" /> Pending</Button>}
                {connectionStatus === "accepted" && <Button variant="outline" className="flex-1 rounded-xl h-9 gap-1 text-xs" onClick={() => navigate("/chats")}><MessageSquare className="w-3.5 h-3.5" /> Message</Button>}
                <Button variant="outline" className="rounded-xl h-9 px-3" onClick={() => { navigator.clipboard.writeText(shareUrl); toast.success("Link copied!"); }}><Share2 className="w-3.5 h-3.5" /></Button>
              </>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div role="tablist" aria-label="Profile sections" className="mt-4 grid grid-cols-7 overflow-hidden rounded-2xl border border-border/80 bg-card px-1 shadow-sm">
          {PROFILE_TABS.map((tab, i) => (
            <button key={tab.label} role="tab" aria-selected={activeTab === i} aria-controls={`profile-panel-${i}`} onClick={() => setActiveTab(i)}
              className={`min-w-0 border-b-2 px-0.5 py-3 text-center text-[10px] font-bold leading-none transition-colors sm:px-1 sm:text-[11px] ${activeTab === i ? "border-primary bg-primary/5 text-primary" : "border-transparent text-muted-foreground hover:bg-secondary/60 hover:text-foreground"}`}>
              <span className="sm:hidden">{tab.compact}</span><span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Section Edit Modals */}
        {editingSection && (
          <div className="fixed inset-0 z-[60] flex items-end justify-center bg-background/80 backdrop-blur-sm sm:items-center">
            <div className="max-h-[calc(100dvh-2rem)] w-full max-w-md animate-fade-in overflow-y-auto rounded-t-[24px] border border-border bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:max-h-[85dvh] sm:rounded-[24px] sm:p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold text-foreground">{editingSection === "about" ? "Edit About Me" : editingSection === "expertise" ? "Edit Expertise" : editingSection === "pricing" ? "Edit Pricing" : editingSection === "social" ? "Edit Social Handles" : editingSection === "education" ? (editingEducationId ? "Edit Education" : "Add Education") : (editingExperienceId ? "Edit Experience" : "Add Experience")}</h3>
                <button onClick={() => { setEditingSection(null); setEditingEducationId(null); setEditingExperienceId(null); }} className="p-1 text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
              </div>

              {editingSection === "about" && (
                <div className="space-y-3">
                  <div><Label className="text-xs">Name</Label><Input value={aboutForm.name} onChange={e => setAboutForm({ ...aboutForm, name: e.target.value })} className="bg-secondary border-border mt-1" /></div>
                  <div><Label className="text-xs">Headline</Label><Input value={aboutForm.headline} onChange={e => setAboutForm({ ...aboutForm, headline: e.target.value })} className="bg-secondary border-border mt-1" /></div>
                  <div><Label className="text-xs">Bio</Label><Textarea value={aboutForm.bio} onChange={e => setAboutForm({ ...aboutForm, bio: e.target.value })} className="bg-secondary border-border mt-1" rows={3} /></div>
                  <div><Label className="text-xs">Location</Label><div className="mt-1"><SearchableSelect options={locationOptions} value={aboutForm.location} onChange={value => setAboutForm({ ...aboutForm, location: value })} placeholder="Select location..." /></div><p className="mt-1 text-[10px] text-muted-foreground">New locations are sent to admin review and remain private meanwhile.</p></div>
                  <div><Label className="text-xs">Date of Birth</Label><Input type="date" value={aboutForm.date_of_birth} onChange={e => setAboutForm({ ...aboutForm, date_of_birth: e.target.value })} className="bg-secondary border-border mt-1" /></div>
                  <Button className="w-full rounded-xl" onClick={() => saveSection.mutate("about")} disabled={saveSection.isPending}>{saveSection.isPending ? "Saving..." : "Save"}</Button>
                </div>
              )}

              {editingSection === "expertise" && (
                <div className="space-y-3">
                  <ExpertiseSelect value={expertiseList} onChange={setExpertiseList} />
                  <Button className="w-full rounded-xl" onClick={() => saveSection.mutate("expertise")} disabled={saveSection.isPending}>{saveSection.isPending ? "Saving..." : "Save"}</Button>
                </div>
              )}

              {editingSection === "pricing" && (
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <Label className="text-xs">Mentor</Label>
                    <button onClick={() => setPricingForm({ ...pricingForm, is_mentor: !pricingForm.is_mentor })}
                      className={`text-xs px-3 py-1.5 rounded-full border ${pricingForm.is_mentor ? "bg-primary/10 border-primary text-primary" : "border-border text-muted-foreground"}`}>
                      {pricingForm.is_mentor ? "Yes" : "No"}
                    </button>
                  </div>
                  {pricingForm.is_mentor && (
                    <>
                      <div><Label className="text-xs">Category</Label><div className="mt-1"><SearchableSelect options={mentorCategoryOptions} value={pricingForm.mentor_category} onChange={value => setPricingForm({ ...pricingForm, mentor_category: value })} placeholder="Select mentoring category..." /></div><p className="mt-1 text-[10px] text-muted-foreground">Choose a common category or suggest a new one.</p></div>
                      <div className="grid grid-cols-3 gap-2">
                        <div><Label className="text-[10px]">Chat ₹</Label><Input type="number" value={pricingForm.mentor_price_chat} onChange={e => setPricingForm({ ...pricingForm, mentor_price_chat: e.target.value })} className="bg-secondary border-border h-9 text-xs" /></div>
                        <div><Label className="text-[10px]">Audio ₹</Label><Input type="number" value={pricingForm.mentor_price_audio} onChange={e => setPricingForm({ ...pricingForm, mentor_price_audio: e.target.value })} className="bg-secondary border-border h-9 text-xs" /></div>
                        <div><Label className="text-[10px]">Video ₹</Label><Input type="number" value={pricingForm.mentor_price_video} onChange={e => setPricingForm({ ...pricingForm, mentor_price_video: e.target.value })} className="bg-secondary border-border h-9 text-xs" /></div>
                      </div>
                    </>
                  )}
                  <Button className="w-full rounded-xl" onClick={() => saveSection.mutate("pricing")} disabled={saveSection.isPending}>{saveSection.isPending ? "Saving..." : "Save"}</Button>
                </div>
              )}

              {editingSection === "social" && (
                <div className="space-y-3">
                  {SOCIAL_FIELDS.map(({ key, label, placeholder }) => (
                    <div key={key}><Label className="text-xs">{label}</Label><Input inputMode="url" placeholder={placeholder} value={socialForm[key] || ""} onChange={e => setSocialForm({ ...socialForm, [key]: e.target.value })} className="bg-secondary border-border mt-1" /></div>
                  ))}
                  {customSocialLinks.map((link, index) => (
                    <div key={link.id} className="rounded-xl border border-border bg-secondary/35 p-3 space-y-2">
                      <div className="flex items-center justify-between"><Label className="text-xs">Other link</Label><button type="button" aria-label="Remove link" onClick={() => setCustomSocialLinks((current) => current.filter((item) => item.id !== link.id))} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button></div>
                      <Input placeholder="Label, e.g. Portfolio" maxLength={40} value={link.label} onChange={event => setCustomSocialLinks((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} className="bg-secondary border-border" />
                      <Input inputMode="url" placeholder="https://..." value={link.url} onChange={event => setCustomSocialLinks((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, url: event.target.value } : item))} className="bg-secondary border-border" />
                    </div>
                  ))}
                  <Button type="button" variant="outline" className="w-full rounded-xl" onClick={() => setCustomSocialLinks((current) => [...current, { id: crypto.randomUUID(), label: "", url: "" }])}><Plus className="mr-1.5 h-4 w-4" /> Add another link</Button>
                  <Button className="w-full rounded-xl" onClick={() => saveSection.mutate("social")} disabled={saveSection.isPending}>{saveSection.isPending ? "Saving..." : "Save"}</Button>
                </div>
              )}

              {editingSection === "education" && (
                <div className="space-y-3">
                  <div><Label className="text-xs">Institution *</Label><div className="mt-1"><SearchableSelect options={institutionOptions} value={eduForm.institution} onChange={v => setEduForm({ ...eduForm, institution: v })} placeholder="Select institution..." /></div></div>
                  <div><Label className="text-xs">Course</Label><div className="mt-1"><SearchableSelect options={[...ALL_COURSES]} value={eduForm.degree} onChange={v => setEduForm({ ...eduForm, degree: v, branch_area: "" })} placeholder="Select course..." /></div></div>
                  <div><Label className="text-xs">Specialisation</Label><div className="mt-1"><SearchableSelect options={eduForm.degree ? getSpecialisations(eduForm.degree) : []} value={eduForm.branch_area} onChange={v => setEduForm({ ...eduForm, branch_area: v })} placeholder={eduForm.degree ? "Select specialisation..." : "Select course first"} /></div></div>
                  <div><Label className="text-xs">Passing Year</Label><div className="mt-1"><SearchableSelect options={passingYears} value={eduForm.passing_year} onChange={v => setEduForm({ ...eduForm, passing_year: v })} placeholder="Select year..." /></div></div>
                  <div><Label className="text-xs">Location</Label><div className="mt-1"><SearchableSelect options={locationOptions} value={eduForm.location} onChange={v => setEduForm({ ...eduForm, location: v })} placeholder="Select location..." /></div></div>
                  <Button className="w-full rounded-xl" onClick={() => addEducation.mutate()} disabled={addEducation.isPending}>{addEducation.isPending ? "Saving..." : editingEducationId ? "Save Education" : "Add Education"}</Button>
                </div>
              )}

              {editingSection === "experience" && (
                <div className="space-y-3">
                  <div><Label className="text-xs">Company *</Label><div className="mt-1"><SearchableSelect options={companyOptions} value={expForm.company_name} onChange={v => setExpForm({ ...expForm, company_name: v })} placeholder="Select company..." /></div></div>
                  {isNewCustomCompany && <div className="rounded-xl border border-border bg-secondary/35 p-3"><Label className="text-xs">Company logo (optional)</Label><div className="mt-2 flex items-center gap-3">{expForm.logo_url ? <img src={expForm.logo_url} alt="Company preview" className="h-12 w-12 rounded-xl border border-border bg-white object-contain p-1" /> : <div className="grid h-12 w-12 place-items-center rounded-xl bg-secondary"><Briefcase className="h-5 w-5 text-muted-foreground" /></div>}<label className="cursor-pointer rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold hover:border-primary">{uploadingPhoto === "company_logo" ? "Uploading..." : "Upload logo"}<input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={uploadingPhoto === "company_logo"} onChange={event => { const file = event.target.files?.[0]; if (file) void uploadCompanyLogo(file); event.target.value = ""; }} /></label></div><p className="mt-2 text-[10px] text-muted-foreground">Shown only for a new company. The WebP logo and company enter admin review together.</p></div>}
                  <div><Label className="text-xs">Job Title</Label><Input value={expForm.job_title} onChange={e => setExpForm({ ...expForm, job_title: e.target.value })} className="bg-secondary border-border mt-1" /></div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><Label className="text-xs">Start Date</Label><Input type="month" value={expForm.start_date} onChange={e => setExpForm({ ...expForm, start_date: e.target.value })} className="bg-secondary border-border mt-1" /></div>
                    <div><Label className="text-xs">End Date</Label><Input type="month" value={expForm.end_date} onChange={e => setExpForm({ ...expForm, end_date: e.target.value })} disabled={expForm.is_current} className="bg-secondary border-border mt-1" /></div>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-foreground">
                    <input type="checkbox" checked={expForm.is_current} onChange={e => setExpForm({ ...expForm, is_current: e.target.checked })} /> Currently working here
                  </label>
                  <div><Label className="text-xs">Location</Label><div className="mt-1"><SearchableSelect options={locationOptions} value={expForm.location} onChange={v => setExpForm({ ...expForm, location: v })} placeholder="Select location..." /></div></div>
                  <Button className="w-full rounded-xl" onClick={() => addExperience.mutate()} disabled={addExperience.isPending}>{addExperience.isPending ? "Saving..." : editingExperienceId ? "Save Experience" : "Add Experience"}</Button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab Content */}
        <div id={`profile-panel-${activeTab}`} role="tabpanel" className="mt-4 animate-fade-in space-y-4">
          {/* ─── Profile Capsule Pricing Buttons (₹499 / ₹999 / ₹1999) ─── */}
          {(displayProfile as any)?.is_mentor && !isOwn && activeTab === 0 && (
            <div className="rounded-[24px] border border-border/80 bg-card p-5 shadow-sm">
              <h3 className="font-bold text-foreground text-sm mb-3">Book a Session</h3>
              <div className="flex gap-2">
                {[
                  { type: "chat" as const, price: (displayProfile as any)?.mentor_price_chat },
                  { type: "audio" as const, price: (displayProfile as any)?.mentor_price_audio },
                  { type: "video" as const, price: (displayProfile as any)?.mentor_price_video },
                ].filter((tier) => tier.price != null).map((tier) => (
                  <button
                    key={tier.type}
                    onClick={() => navigate(`/consult?mentor=${displayProfile.user_id}&service=${tier.type}`)}
                    className="flex-1 py-3 px-4 rounded-full bg-primary/10 border border-primary/20 text-primary font-bold text-sm hover:bg-primary hover:text-primary-foreground transition-all hover:shadow-md"
                  >
                    ₹{tier.price}
                    <span className="block text-[9px] font-medium opacity-70 capitalize">{tier.type}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {activeTab === 0 && (
            <div className="space-y-4 rounded-[24px] border border-border/80 bg-card p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-foreground text-sm">About Me</h3>
                <EditButton section="about" />
              </div>
              {(displayProfile as any)?.bio ? <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">{(displayProfile as any).bio}</p>
                : <p className="text-sm text-muted-foreground/50 italic">No bio added yet</p>}
              <div className="space-y-3 pt-2 border-t border-border">
                {((displayProfile as any)?.location || pendingLocationValue) && <div className="flex items-center gap-2.5 text-sm text-muted-foreground"><MapPin className="w-4 h-4 text-primary flex-shrink-0" /> {pendingLocationValue || (displayProfile as any).location}{pendingLocationValue && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[9px] font-bold text-amber-700 dark:text-amber-300">Private · pending</span>}</div>}
                {(displayProfile as any)?.date_of_birth && <div className="flex items-center gap-2.5 text-sm text-muted-foreground"><Calendar className="w-4 h-4 text-primary flex-shrink-0" /> {format(new Date((displayProfile as any).date_of_birth + "T00:00:00"), "do MMM, yyyy")}</div>}
                {(displayProfile as any)?.iit_name && <div className="flex min-w-0 items-center gap-2.5 text-sm text-muted-foreground">{getIitLogo((displayProfile as any).iit_name) ? <img src={getIitLogo((displayProfile as any).iit_name)!} alt="" className="h-6 w-6 flex-shrink-0 rounded-md border border-border bg-white object-contain p-0.5" /> : <GraduationCap className="w-4 h-4 text-primary flex-shrink-0" />}<span className="min-w-0 break-words">{(displayProfile as any).iit_name}{displayMemberStatus && <span className="text-xs"> · {formatMemberStatus(displayMemberStatus)}</span>}</span>{(displayProfile as any)?.is_verified && <BadgeCheck aria-label="Verified IIT identity" className="h-4 w-4 flex-shrink-0 fill-primary text-primary-foreground" />}</div>}
                {(displayProfile as any)?.is_mentor && <div className="flex items-center gap-2.5 text-sm text-primary"><BadgeCheck className="w-4 h-4 flex-shrink-0" /> Mentor{((displayProfile as any).mentor_category || pendingMentorCategory) && <span className="text-xs bg-primary/10 px-2 py-0.5 rounded-full">{pendingMentorCategory || (displayProfile as any).mentor_category}</span>}{pendingMentorCategory && <span className="text-[9px] text-amber-700 dark:text-amber-300">Private · pending</span>}</div>}
              </div>
            </div>
          )}

          {activeTab === 1 && (
            <div className="rounded-[24px] border border-border/80 bg-card p-5 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-foreground text-sm">Education</h3>
                {isOwn && <button onClick={() => { setEditingEducationId(null); setEduForm({ institution: "", degree: "", branch_area: "", passing_year: "", location: "" }); setEditingSection("education"); }} className="text-xs text-primary font-medium flex items-center gap-1 hover:underline"><Plus className="w-3 h-3" /> Add</button>}
              </div>
              {education && education.length > 0 ? (
                <div className="space-y-4">
                  {education.map((edu: any) => (
                    <div key={edu.id} className="flex min-w-0 gap-3">
                      <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 overflow-hidden">{getIitLogo(edu.institution) ? <img src={getIitLogo(edu.institution)!} alt="" className="h-full w-full bg-white object-contain p-1" /> : <GraduationCap className="w-5 h-5 text-primary" />}</div>
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1 break-words font-semibold text-sm text-foreground">{edu.institution}{edu.is_verified && <BadgeCheck aria-label="Verified education" className="h-4 w-4 flex-shrink-0 fill-primary text-primary-foreground" />}</p>
                        <p className="text-xs text-muted-foreground">{[edu.degree, edu.branch_area].filter(Boolean).join(" - ")}</p>
                        {edu.passing_year && <p className="text-[10px] text-muted-foreground/70 mt-0.5">Class of {edu.passing_year}</p>}
                        {edu.approval_status && edu.approval_status !== "approved" && <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[9px] font-bold ${edu.approval_status === "rejected" ? "bg-destructive/10 text-destructive" : "bg-amber-500/10 text-amber-700 dark:text-amber-300"}`}>{edu.approval_status === "pending" ? "Private · awaiting approval" : "Private · changes requested"}</span>}
                      </div>
                      {isOwn && <div className="flex gap-0.5">{!edu.is_verified && <button aria-label="Edit education" onClick={() => { setEditingEducationId(edu.id); setEduForm({ institution: edu.institution || "", degree: edu.degree || "", branch_area: edu.branch_area || "", passing_year: edu.passing_year || "", location: edu.location || "" }); setEditingSection("education"); }} className="p-1 text-muted-foreground hover:text-primary"><Pencil className="w-3.5 h-3.5" /></button>}{!edu.is_verified && <button aria-label="Delete education" onClick={() => deleteEducation.mutate(edu.id)} className="p-1 text-muted-foreground hover:text-destructive"><Trash2 className="w-3.5 h-3.5" /></button>}</div>}
                    </div>
                  ))}
                </div>
              ) : <p className="text-sm text-muted-foreground/50 italic text-center py-8">No education added yet</p>}
            </div>
          )}

          {activeTab === 2 && (
            <div className="rounded-[24px] border border-border/80 bg-card p-5 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-foreground text-sm">Professional Details</h3>
                {isOwn && <button onClick={() => { setEditingExperienceId(null); setExpForm({ company_name: "", job_title: "", start_date: "", end_date: "", location: "", is_current: false, logo_url: "" }); setEditingSection("experience"); }} className="text-xs text-primary font-medium flex items-center gap-1 hover:underline"><Plus className="w-3 h-3" /> Add</button>}
              </div>
              {experience && experience.length > 0 ? (
                <div className="space-y-4">
                  {experience.map((exp: any) => {
                    const logoUrl = exp.logo_url;
                    return (
                      <div key={exp.id} className="flex min-w-0 gap-3">
                        {logoUrl ? <img src={logoUrl} alt={exp.company_name} className="w-10 h-10 rounded-lg object-contain bg-white border border-border p-1 flex-shrink-0" /> : <div className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-lg bg-primary/10"><Briefcase className="h-5 w-5 text-primary" /></div>}
                        <div className="min-w-0 flex-1">
                          <p className="break-words font-semibold text-sm text-foreground">{exp.job_title || "Role"} at {exp.company_name}</p>
                          <p className="text-xs text-muted-foreground">{exp.start_date || ""}{exp.start_date && " - "}{exp.is_current ? "Present" : exp.end_date || ""}</p>
                          {exp.location && <p className="text-[10px] text-muted-foreground/70 mt-0.5">{exp.location}</p>}
                          {exp.approval_status && exp.approval_status !== "approved" && <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[9px] font-bold ${exp.approval_status === "rejected" ? "bg-destructive/10 text-destructive" : "bg-amber-500/10 text-amber-700 dark:text-amber-300"}`}>{exp.approval_status === "pending" ? "Private · awaiting approval" : "Private · changes requested"}</span>}
                        </div>
                        {isOwn && <div className="flex gap-0.5"><button aria-label="Edit experience" onClick={() => { setEditingExperienceId(exp.id); setExpForm({ company_name: exp.company_name || "", job_title: exp.job_title || "", start_date: exp.start_date?.slice(0, 7) || "", end_date: exp.end_date?.slice(0, 7) || "", location: exp.location || "", is_current: !!exp.is_current, logo_url: exp.logo_url || "" }); setEditingSection("experience"); }} className="p-1 text-muted-foreground hover:text-primary"><Pencil className="w-3.5 h-3.5" /></button><button aria-label="Delete experience" onClick={() => deleteExperience.mutate(exp.id)} className="p-1 text-muted-foreground hover:text-destructive"><Trash2 className="w-3.5 h-3.5" /></button></div>}
                      </div>
                    );
                  })}
                </div>
              ) : <p className="text-sm text-muted-foreground/50 italic text-center py-8">No experience added yet</p>}
            </div>
          )}

          {activeTab === 3 && (
            <div className="rounded-[24px] border border-border/80 bg-card p-5 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-foreground text-sm">Expertise & Skills</h3>
                <EditButton section="expertise" />
              </div>
              {skills.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {skills.map((skill: string) => <span key={skill} className="px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium">{skill}</span>)}
                </div>
              ) : <p className="text-sm text-muted-foreground/50 italic text-center py-8">No skills added yet</p>}
            </div>
          )}

          {activeTab === 4 && (
            <div className="rounded-[24px] border border-border/80 bg-card p-5 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-foreground text-sm">Pricing Information</h3>
                <EditButton section="pricing" />
              </div>
              {(displayProfile as any)?.is_mentor ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between py-2 border-b border-border"><div className="flex items-center gap-2"><MessageSquare className="w-4 h-4 text-muted-foreground" /><span className="text-sm text-foreground">Chat</span></div><span className="text-sm font-semibold text-foreground">₹{(displayProfile as any).mentor_price_chat || "-"}</span></div>
                  <div className="flex items-center justify-between py-2 border-b border-border"><div className="flex items-center gap-2"><Phone className="w-4 h-4 text-muted-foreground" /><span className="text-sm text-foreground">Audio Call</span></div><span className="text-sm font-semibold text-foreground">₹{(displayProfile as any).mentor_price_audio || "-"}</span></div>
                  <div className="flex items-center justify-between py-2"><div className="flex items-center gap-2"><Video className="w-4 h-4 text-muted-foreground" /><span className="text-sm text-foreground">Video Call</span></div><span className="text-sm font-semibold text-foreground">₹{(displayProfile as any).mentor_price_video || "-"}</span></div>
                </div>
              ) : <p className="text-sm text-muted-foreground/50 italic text-center py-8">Not a mentor</p>}
            </div>
          )}

          {activeTab === 5 && (
            <div className="rounded-[24px] border border-border/80 bg-card p-5 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-foreground text-sm">Social Handles</h3>
                <EditButton section="social" />
              </div>
              {Object.keys(socialLinks).length > 0 && Object.values(socialLinks).some(v => !!v) ? (
                <div className="space-y-3">
                  {Object.entries(socialLinks).map(([key, val]) => val ? (
                    <a key={key} href={val as string} target="_blank" rel="noopener noreferrer" className="flex min-w-0 items-start gap-2.5 border-b border-border py-2 text-sm text-primary last:border-0 hover:underline">
                      <LinkIcon className="mt-0.5 w-4 h-4 text-muted-foreground flex-shrink-0" /><span>{socialLabel(key)}:</span><span className="min-w-0 break-all">{val as string}</span>
                    </a>
                  ) : null)}
                </div>
              ) : <p className="text-sm text-muted-foreground/50 italic text-center py-8">No social links added</p>}
            </div>
          )}

          {activeTab === 6 && (
            <div className="rounded-[24px] border border-border/80 bg-card p-5 shadow-sm">
              <h3 className="font-bold text-foreground text-sm">Activity</h3>
              <p className="mb-3 mt-1 text-[11px] text-muted-foreground">Public feed posts and reshares appear here. Private chats, forum messages, consultations and anonymous activity never appear on a profile.</p>
              <div className="space-y-3">
                {userActivity && userActivity.length > 0 ? userActivity.map((activity: any, i: number) => (
                  <div key={i} className="bg-secondary/50 rounded-xl p-3">
                    {activity.type === "post" && (
                      <>
                        <p className="text-sm text-foreground line-clamp-3">{activity.data.content}</p>
                        <p className="text-[10px] text-muted-foreground mt-2">{formatDistanceToNow(new Date(activity.date), { addSuffix: true })}</p>
                      </>
                    )}
                    {activity.type === "reshare" && (
                      <div className="flex items-center gap-1 text-xs text-muted-foreground"><Share2 className="w-3 h-3" /> Reshared a post · {formatDistanceToNow(new Date(activity.date), { addSuffix: true })}</div>
                    )}
                  </div>
                )) : <p className="text-sm text-muted-foreground/50 italic text-center py-8">No activity yet</p>}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default Profile;
