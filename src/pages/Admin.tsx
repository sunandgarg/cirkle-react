import { useState, useRef } from "react";
import { ArrowLeft, Upload, Trash2, Users, FileText, Settings2, Image, Ban, CheckCircle2, Search, BarChart3, Shield, TrendingUp, ToggleLeft, Briefcase, Plus, ClipboardCheck, Eye, XCircle, GraduationCap, CalendarDays, Mail, RotateCcw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { convertToWebP } from "@/lib/imageUtils";
import { defaultIitLogo, IIT_LIST, iitLogoSettingKey } from "@/data/iitInstitutes";
import AdminEvents from "@/components/admin/AdminEvents";
import AdminJobs from "@/components/admin/AdminJobs";
import { readEdgeFunctionError } from "@/lib/edgeFunctionError";

const NAV_KEYS = [
  { key: "forum", label: "Cirkle" },
  { key: "home", label: "Home" },
  { key: "network", label: "My Network" },
  { key: "consult", label: "Consult" },
  { key: "jobs", label: "Jobs" },
];

const Admin = () => {
  const navigate = useNavigate();
  const { user, profile, isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [userSearch, setUserSearch] = useState("");
  const [uploadingIitLogo, setUploadingIitLogo] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [reviewingDocument, setReviewingDocument] = useState<string | null>(null);
  const [reviewingCourse, setReviewingCourse] = useState<string | null>(null);
  const [testDataAction, setTestDataAction] = useState<"seed" | "purge" | null>(null);

  const { data: navConfig } = useQuery({
    queryKey: ["nav-config-admin"],
    queryFn: async () => {
      const { data } = await supabase.from("nav_config").select("*");
      const map: Record<string, any> = {};
      (data as any[])?.forEach((c: any) => { map[c.tab_key] = c; });
      return map;
    },
  });

  const { data: users } = useQuery({
    queryKey: ["admin-users"],
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("*").order("created_at", { ascending: false }).limit(200);
      return data ?? [];
    },
    enabled: !!isAdmin,
  });

  const { data: posts } = useQuery({
    queryKey: ["admin-posts"],
    queryFn: async () => {
      const { data } = await supabase.from("posts").select("*").order("created_at", { ascending: false }).limit(100);
      return data ?? [];
    },
    enabled: !!isAdmin,
  });

  const { data: reports } = useQuery({
    queryKey: ["admin-reports"],
    queryFn: async () => {
      const { data: rep } = await supabase.from("reports").select("*").eq("entity_type", "forum_msg").order("created_at", { ascending: false }).limit(500);
      const list = (rep ?? []) as any[];
      if (!list.length) return [];
      const postIds = [...new Set(list.map((r) => r.entity_id))];
      const reporterIds = [...new Set(list.map((r) => r.reporter_id))];
      const [{ data: posts }, { data: profs }] = await Promise.all([
        supabase.from("posts").select("id, content, author_id, is_anonymous, created_at, image_url, scope_type, scope_key").in("id", postIds),
        supabase.from("profiles").select("user_id, name, avatar_url").in("user_id", reporterIds),
      ]);
      const postMap = new Map((posts ?? []).map((p: any) => [p.id, p]));
      const authorIds = [...new Set((posts ?? []).map((p: any) => p.author_id))];
      const { data: authors } = await supabase.from("profiles").select("user_id, name, avatar_url").in("user_id", authorIds);
      const authorMap = new Map((authors ?? []).map((p: any) => [p.user_id, p]));
      const profMap = new Map((profs ?? []).map((p: any) => [p.user_id, p]));
      const grouped = new Map<string, any>();
      list.forEach((r) => {
        const post = postMap.get(r.entity_id);
        if (!post) return;
        const g = grouped.get(r.entity_id) || { post, author: authorMap.get(post.author_id), reports: [], count: 0 };
        g.reports.push({ ...r, reporter: profMap.get(r.reporter_id) });
        g.count = g.reports.length;
        grouped.set(r.entity_id, g);
      });
      return Array.from(grouped.values()).sort((a, b) => b.count - a.count);
    },
    enabled: !!isAdmin,
  });

  const { data: documentSubmissions = [] } = useQuery({
    queryKey: ["admin-document-verifications"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("document_verifications")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      const submissions = (data ?? []) as any[];
      const ids = [...new Set(submissions.map((item) => item.user_id))];
      if (!ids.length) return submissions;
      const { data: profiles } = await supabase.from("profiles").select("user_id,name,avatar_url").in("user_id", ids);
      const profileMap = new Map((profiles ?? []).map((item: any) => [item.user_id, item]));
      return submissions.map((item) => ({ ...item, profile: profileMap.get(item.user_id) }));
    },
    enabled: !!isAdmin,
  });

  const { data: courseRequests = [] } = useQuery({
    queryKey: ["admin-course-verifications"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("course_verification_requests")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      const requests = (data ?? []) as any[];
      const ids = [...new Set(requests.map((item) => item.user_id))];
      if (!ids.length) return requests;
      const { data: profiles } = await supabase.from("profiles").select("user_id,name,avatar_url").in("user_id", ids);
      const profileMap = new Map((profiles ?? []).map((item: any) => [item.user_id, item]));
      return requests.map((item) => ({ ...item, profile: profileMap.get(item.user_id) }));
    },
    enabled: !!isAdmin,
    staleTime: 30_000,
  });

  const { data: adminUsers } = useQuery({
    queryKey: ["admin-roles-list"],
    queryFn: async () => {
      const { data } = await supabase.from("user_roles").select("user_id, role").eq("role", "admin");
      const ids = (data ?? []).map((r: any) => r.user_id);
      if (!ids.length) return [];
      const { data: profs } = await supabase.from("profiles").select("user_id, name, avatar_url").in("user_id", ids);
      return profs ?? [];
    },
    enabled: !!isAdmin,
  });

  const { data: isPlatformOwner = false } = useQuery({
    queryKey: ["platform-owner", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("is_platform_owner");
      if (error) throw error;
      return data === true;
    },
    enabled: !!user && isAdmin,
    staleTime: 5 * 60_000,
  });

  const grantAdmin = async (uid: string) => {
    const { error } = await supabase.rpc("grant_admin_role" as any, { p_target_user_id: uid });
    if (error) { toast.error(error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["admin-roles-list"] });
    queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    toast.success("Promoted to admin");
  };
  const revokeAdmin = async (uid: string) => {
    const { error } = await supabase.rpc("revoke_admin_role" as any, { p_target_user_id: uid });
    if (error) { toast.error(error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["admin-roles-list"] });
    queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    toast.success("Removed admin role");
  };

  const viewVerificationDocument = async (submission: any) => {
    const { data, error } = await supabase.storage.from("verification-documents").createSignedUrl(submission.document_path, 300);
    if (error || !data?.signedUrl) {
      toast.error(error?.message || "Could not open the document");
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  const sendDocumentDecisionEmail = async (submissionId: string) => {
    const { data, error } = await supabase.functions.invoke("notify-verification-decision", {
      body: { submission_id: submissionId },
    });
    if (error) {
      const parsed = await readEdgeFunctionError(error, data, "The review was saved, but the decision email could not be delivered.");
      throw new Error(parsed.message);
    }
    if (data?.error) throw new Error(data.error);
  };

  const resendDocumentDecisionEmail = async (submission: any) => {
    setReviewingDocument(submission.id);
    try {
      await sendDocumentDecisionEmail(submission.id);
      await queryClient.invalidateQueries({ queryKey: ["admin-document-verifications"] });
      toast.success("Decision email sent to the member’s login email");
    } catch (error: any) {
      toast.error(error.message || "Could not send the decision email");
    } finally {
      setReviewingDocument(null);
    }
  };

  const reviewDocument = async (submission: any, status: "approved" | "rejected") => {
    const notes = (reviewNotes[submission.id] || "").trim();
    if (status === "rejected" && !notes) {
      toast.error("Add a clear rejection reason first");
      return;
    }
    setReviewingDocument(submission.id);
    try {
      const { error } = await (supabase as any).rpc("review_document_verification", {
        p_submission_id: submission.id,
        p_status: status,
        p_notes: notes || null,
      });
      if (error) throw error;
      let notificationError = "";
      try {
        await sendDocumentDecisionEmail(submission.id);
      } catch (error: any) {
        notificationError = error.message || "Decision email could not be delivered";
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-document-verifications"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
      ]);
      setReviewNotes((current) => ({ ...current, [submission.id]: "" }));
      if (notificationError) {
        toast.warning(`${status === "approved" ? "Document approved" : "Submission rejected"}, but email delivery failed. Use “Send email” to retry.`);
      } else {
        toast.success(status === "approved" ? "Approved and notification email sent" : "Rejected and notification email sent");
      }
    } catch (error: any) {
      toast.error(error.message || "Could not review this submission");
    } finally {
      setReviewingDocument(null);
    }
  };

  const reviewCourse = async (request: any, status: "approved" | "rejected") => {
    const notes = (reviewNotes[request.id] || "").trim();
    if (status === "rejected" && !notes) {
      toast.error("Add a clear rejection reason first");
      return;
    }
    setReviewingCourse(request.id);
    try {
      const { error } = await (supabase as any).rpc("review_course_verification", {
        p_request_id: request.id,
        p_status: status,
        p_notes: notes || null,
      });
      if (error) throw error;
      await queryClient.invalidateQueries({ queryKey: ["admin-course-verifications"] });
      setReviewNotes((current) => ({ ...current, [request.id]: "" }));
      toast.success(status === "approved" ? "Course approved" : "Course request rejected");
    } catch (error: any) {
      toast.error(error.message || "Could not review this course");
    } finally {
      setReviewingCourse(null);
    }
  };

  const dismissReports = async (postId: string) => {
    await supabase.from("reports").delete().eq("entity_id", postId);
    queryClient.invalidateQueries({ queryKey: ["admin-reports"] });
    toast.success("Reports dismissed");
  };
  const removeReportedPost = async (postId: string) => {
    await supabase.from("posts").delete().eq("id", postId);
    await supabase.from("reports").delete().eq("entity_id", postId);
    queryClient.invalidateQueries({ queryKey: ["admin-reports"] });
    queryClient.invalidateQueries({ queryKey: ["forum-posts"] });
    toast.success("Message removed");
  };

  const { data: stats } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: async () => {
      const [usersRes, postsRes, jobsRes, eventsRes, connectionsRes] = await Promise.all([
        supabase.from("profiles").select("user_id", { count: "exact", head: true }),
        supabase.from("posts").select("id", { count: "exact", head: true }),
        supabase.from("jobs").select("id", { count: "exact", head: true }),
        supabase.from("events").select("id", { count: "exact", head: true }),
        supabase.from("connections").select("id", { count: "exact", head: true }).eq("status", "accepted"),
      ]);
      return { users: usersRes.count ?? 0, posts: postsRes.count ?? 0, jobs: jobsRes.count ?? 0, events: eventsRes.count ?? 0, connections: connectionsRes.count ?? 0 };
    },
    enabled: !!isAdmin,
  });

  const { data: appSettings } = useQuery({
    queryKey: ["admin-app-settings"],
    queryFn: async () => {
      const { data } = await supabase.from("app_settings").select("*");
      const map: Record<string, string> = {};
      (data as any[])?.forEach((s: any) => { map[s.key] = s.value; });
      return map;
    },
    enabled: !!isAdmin,
  });

  const updateSetting = async (key: string, value: string) => {
    await supabase.from("app_settings").update({ value, updated_at: new Date().toISOString() } as any).eq("key", key);
    queryClient.invalidateQueries({ queryKey: ["admin-app-settings"] });
    queryClient.invalidateQueries({ queryKey: ["app-setting-test-mode"] });
    toast.success(`${key} updated!`);
  };

  const manageTestData = async (action: "seed" | "purge") => {
    if (action === "purge" && !window.confirm("Remove every tracked dummy user, message, thread, connection and chat? Real user data will not be touched.")) return;
    setTestDataAction(action);
    try {
      const { data, error } = await supabase.functions.invoke("seed-data", { body: { action } });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-app-settings"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-posts"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-stats"] }),
      ]);
      toast.success(action === "seed" ? `${data.messagesCreated || 0} cohort messages created` : `${data.deletedUsers || 0} dummy users removed`);
    } catch (error: any) {
      toast.error(error.message || "Test-data operation failed");
    } finally {
      setTestDataAction(null);
    }
  };

  const handleIconUpload = async (tabKey: string, file: File) => {
    const ext = file.name.split(".").pop();
    const path = `${tabKey}-${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage.from("nav-icons").upload(path, file, { upsert: true });
    if (uploadError) { toast.error(uploadError.message); return; }
    const { data: urlData } = supabase.storage.from("nav-icons").getPublicUrl(path);
    const existing = navConfig?.[tabKey];
    if (existing) { await supabase.from("nav_config").update({ icon_url: urlData.publicUrl } as any).eq("tab_key", tabKey); }
    else { await supabase.from("nav_config").insert({ tab_key: tabKey, label: NAV_KEYS.find(n => n.key === tabKey)?.label || tabKey, icon_url: urlData.publicUrl } as any); }
    queryClient.invalidateQueries({ queryKey: ["nav-config"] });
    queryClient.invalidateQueries({ queryKey: ["nav-config-admin"] });
    toast.success("Icon updated!");
  };

  const handleLabelUpdate = async (tabKey: string, label: string) => {
    const existing = navConfig?.[tabKey];
    if (existing) { await supabase.from("nav_config").update({ label } as any).eq("tab_key", tabKey); }
    else { await supabase.from("nav_config").insert({ tab_key: tabKey, label } as any); }
    queryClient.invalidateQueries({ queryKey: ["nav-config"] });
    queryClient.invalidateQueries({ queryKey: ["nav-config-admin"] });
    toast.success("Label updated!");
  };

  const handleIitLogoUpload = async (domain: string, file: File) => {
    if (!user || !file.type.startsWith("image/")) {
      toast.error("Choose a valid image file");
      return;
    }
    setUploadingIitLogo(domain);
    try {
      const optimized = await convertToWebP(file, 0.82, 256);
      const path = `${domain.replace(/[^a-z0-9]/gi, "-")}.webp`;
      const { error: uploadError } = await supabase.storage
        .from("institute-logos")
        .upload(path, optimized, { upsert: true, contentType: "image/webp", cacheControl: "31536000" });
      if (uploadError) throw uploadError;
      const { data: publicUrl } = supabase.storage.from("institute-logos").getPublicUrl(path);
      const key = iitLogoSettingKey(domain);
      const { error: settingError } = await supabase.from("app_settings").upsert({
        key,
        value: `${publicUrl.publicUrl}?v=${Date.now()}`,
        updated_at: new Date().toISOString(),
        updated_by: user.id,
      }, { onConflict: "key" });
      if (settingError) throw settingError;
      await queryClient.invalidateQueries({ queryKey: ["admin-app-settings"] });
      await queryClient.invalidateQueries({ queryKey: ["iit-logos"] });
      toast.success("Institute logo updated");
    } catch (error: any) {
      toast.error(error.message || "Could not upload institute logo");
    } finally {
      setUploadingIitLogo(null);
    }
  };

  const handleResetIitLogo = async (domain: string) => {
    setUploadingIitLogo(domain);
    try {
      const { error } = await supabase.from("app_settings").delete().eq("key", iitLogoSettingKey(domain));
      if (error) throw error;
      await queryClient.invalidateQueries({ queryKey: ["admin-app-settings"] });
      await queryClient.invalidateQueries({ queryKey: ["iit-logos"] });
      toast.success("Official institute logo restored");
    } catch (error: any) {
      toast.error(error.message || "Could not restore the official logo");
    } finally {
      setUploadingIitLogo(null);
    }
  };

  const deletePost = async (postId: string) => {
    await supabase.from("posts").delete().eq("id", postId);
    queryClient.invalidateQueries({ queryKey: ["admin-posts"] });
    toast.success("Post deleted");
  };

  const toggleVerify = async (userId: string, current: boolean) => {
    const { error } = await supabase.rpc("set_member_verification", {
      p_target_user_id: userId,
      p_verified: !current,
    });
    if (error) { toast.error(error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    toast.success(current ? "Unverified" : "Verified!");
  };

  const filteredUsers = users?.filter((u: any) =>
    !userSearch || (u.name || "").toLowerCase().includes(userSearch.toLowerCase()) ||
    (u.iit_name || "").toLowerCase().includes(userSearch.toLowerCase()) ||
    (u.user_id || "").includes(userSearch)
  );

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4">
        <Shield className="w-12 h-12 text-muted-foreground mb-4" />
        <h2 className="text-lg font-bold text-foreground">Admin Access Required</h2>
        <p className="text-sm text-muted-foreground mt-1">You don't have permission to access this page.</p>
        <Button className="mt-4" onClick={() => navigate(-1)}>Go Back</Button>
      </div>
    );
  }

  return (
    <div className="bg-background min-h-screen">
      <header className="sticky top-0 z-40 bg-card border-b border-border px-4 py-4">
        <div className="flex items-center gap-3 max-w-4xl mx-auto">
          <button onClick={() => navigate(-1)} className="p-1 text-foreground hover-scale"><ArrowLeft className="w-5 h-5" /></button>
          <div>
            <h1 className="text-xl font-bold text-foreground">Admin</h1>
            <p className="text-[10px] text-muted-foreground">Manage users, content & settings</p>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-4">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
          {[
            { label: "Users", value: stats?.users ?? 0, icon: Users, color: "text-primary" },
            { label: "Posts", value: stats?.posts ?? 0, icon: FileText, color: "text-[hsl(var(--success))]" },
            { label: "Jobs", value: stats?.jobs ?? 0, icon: BarChart3, color: "text-[hsl(var(--warning))]" },
            { label: "Events", value: stats?.events ?? 0, icon: TrendingUp, color: "text-destructive" },
            { label: "Connections", value: stats?.connections ?? 0, icon: Users, color: "text-primary" },
          ].map(({ label, value, icon: Icon, color }) => (
            <div key={label} className="bg-card border border-border rounded-xl p-4 flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl bg-muted flex items-center justify-center ${color}`}><Icon className="w-5 h-5" /></div>
              <div><p className="text-2xl font-bold text-foreground">{value}</p><p className="text-xs text-muted-foreground">{label}</p></div>
            </div>
          ))}
        </div>

        <Tabs defaultValue="users">
          <TabsList className="w-full bg-secondary rounded-xl h-auto min-h-11 mb-4 grid grid-cols-4 sm:grid-cols-8 gap-1 p-1">
            <TabsTrigger value="users" className="flex-1 rounded-lg data-[state=active]:bg-primary data-[state=active]:text-primary-foreground text-xs font-semibold"><Users className="w-3.5 h-3.5 mr-1" /> Users</TabsTrigger>
            <TabsTrigger value="jobs" className="flex-1 rounded-lg data-[state=active]:bg-primary data-[state=active]:text-primary-foreground text-xs font-semibold"><Briefcase className="w-3.5 h-3.5 mr-1" /> Jobs</TabsTrigger>
            <TabsTrigger value="events" className="flex-1 rounded-lg data-[state=active]:bg-primary data-[state=active]:text-primary-foreground text-xs font-semibold"><CalendarDays className="w-3.5 h-3.5 mr-1" /> Events</TabsTrigger>
            <TabsTrigger value="posts" className="flex-1 rounded-lg data-[state=active]:bg-primary data-[state=active]:text-primary-foreground text-xs font-semibold"><FileText className="w-3.5 h-3.5 mr-1" /> Posts</TabsTrigger>
            <TabsTrigger value="reports" className="flex-1 rounded-lg data-[state=active]:bg-primary data-[state=active]:text-primary-foreground text-xs font-semibold"><Ban className="w-3.5 h-3.5 mr-1" /> Reports</TabsTrigger>
            <TabsTrigger value="documents" className="flex-1 rounded-lg data-[state=active]:bg-primary data-[state=active]:text-primary-foreground text-xs font-semibold"><ClipboardCheck className="w-3.5 h-3.5 mr-1" /> Documents</TabsTrigger>
            <TabsTrigger value="courses" className="flex-1 rounded-lg data-[state=active]:bg-primary data-[state=active]:text-primary-foreground text-xs font-semibold"><GraduationCap className="w-3.5 h-3.5 mr-1" /> Courses</TabsTrigger>
            <TabsTrigger value="settings" className="flex-1 rounded-lg data-[state=active]:bg-primary data-[state=active]:text-primary-foreground text-xs font-semibold"><Settings2 className="w-3.5 h-3.5 mr-1" /> Settings</TabsTrigger>
          </TabsList>

          {/* Users Tab */}
          <TabsContent value="users" className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input placeholder="Search users..." value={userSearch} onChange={(e) => setUserSearch(e.target.value)} className="pl-9 h-10 rounded-xl bg-secondary border-0" />
            </div>
            <p className="text-xs text-muted-foreground">{filteredUsers?.length || 0} users found</p>
            <div className="grid gap-2 lg:grid-cols-2">
              {filteredUsers?.map((u: any) => (
                <div key={u.user_id} className="bg-card border border-border rounded-xl p-3 flex items-center gap-3">
                  {u.avatar_url ? <img src={u.avatar_url} className="w-10 h-10 rounded-full object-cover" alt="" />
                    : <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center"><span className="text-sm font-bold text-primary">{(u.name || "?")[0]}</span></div>}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">{u.name || "Unnamed"}</p>
                    <p className="text-xs text-muted-foreground truncate">{u.headline || "No headline"}</p>
                    <p className="text-[10px] text-muted-foreground">{u.iit_name || "No IIT"} · {u.role} · {u.location || "Unknown"}</p>
                  </div>
                  <button onClick={() => toggleVerify(u.user_id, u.is_verified)}
                    className={`text-[10px] font-medium px-2 py-0.5 rounded-full cursor-pointer transition-colors ${u.is_verified ? "bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]" : "bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary"}`}>
                    {u.is_verified ? "✓ Verified" : "Verify"}
                  </button>
                </div>
              ))}
            </div>
          </TabsContent>

          {/* Jobs Tab */}
          <TabsContent value="jobs" className="space-y-3">
            <AdminJobs />
          </TabsContent>

          <TabsContent value="events" className="space-y-3">
            <AdminEvents />
          </TabsContent>

          {/* Posts Tab */}
          <TabsContent value="posts" className="space-y-2">
            <p className="text-xs text-muted-foreground mb-2">{posts?.length || 0} posts</p>
            <div className="grid gap-2 lg:grid-cols-2">
              {posts?.map((p: any) => (
                <div key={p.id} className="bg-card border border-border rounded-xl p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-foreground line-clamp-3 flex-1">{p.content}</p>
                    <button onClick={() => deletePost(p.id)} className="p-1.5 text-destructive hover:bg-destructive/10 rounded-lg flex-shrink-0"><Trash2 className="w-4 h-4" /></button>
                  </div>
                  {p.image_url && <img src={p.image_url} alt="" className="mt-2 rounded-lg h-20 object-cover" />}
                  <div className="flex items-center gap-2 mt-2">
                    {p.is_anonymous && <span className="text-[10px] bg-[hsl(var(--anonymous))]/10 text-[hsl(var(--anonymous))] px-2 py-0.5 rounded-full">Anonymous</span>}
                    <span className="text-[10px] text-muted-foreground">{new Date(p.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </TabsContent>

          {/* Reports Tab - grouped by message with severity buckets */}
          <TabsContent value="reports" className="space-y-3">
            <p className="text-xs text-muted-foreground mb-2">{reports?.length || 0} reported messages</p>
            {reports?.length === 0 && (
              <div className="text-center py-12">
                <CheckCircle2 className="w-10 h-10 text-[hsl(var(--success))] mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No reports to review</p>
              </div>
            )}
            {reports?.map((g: any) => {
              const c = g.count;
              const tier = c >= 20 ? { label: `${c}+ reports`, cls: "bg-destructive text-destructive-foreground" }
                : c >= 15 ? { label: `${c} reports`, cls: "bg-destructive/80 text-destructive-foreground" }
                : c >= 10 ? { label: `${c} reports`, cls: "bg-[hsl(var(--warning))] text-background" }
                : c >= 5 ? { label: `${c} reports`, cls: "bg-[hsl(var(--warning))]/70 text-background" }
                : { label: `${c} report${c > 1 ? "s" : ""}`, cls: "bg-muted text-foreground" };
              return (
                <div key={g.post.id} className="bg-card border border-border rounded-xl p-3">
                  <div className="flex items-start gap-3">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${tier.cls}`}>{tier.label}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-foreground">
                          {g.post.is_anonymous ? "Anonymous" : (g.author?.name || "Unknown")}
                        </span>
                        {g.post.is_anonymous && (
                          <span className="text-[10px] bg-[hsl(var(--anonymous))]/10 text-[hsl(var(--anonymous))] px-1.5 py-0.5 rounded">ANON · admin sees: {g.author?.name || g.post.author_id.slice(0, 8)}</span>
                        )}
                        <span className="text-[10px] text-muted-foreground">{g.post.scope_type}/{g.post.scope_key}</span>
                      </div>
                      <p className="text-sm text-foreground mt-1 line-clamp-3">{g.post.content}</p>
                      {g.post.image_url && <img src={g.post.image_url} alt="" className="mt-2 rounded-lg h-20 object-cover" />}
                      <p className="text-[10px] text-muted-foreground mt-1">{new Date(g.post.created_at).toLocaleString()}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-3">
                    <Button size="sm" variant="destructive" className="h-8 text-xs" onClick={() => removeReportedPost(g.post.id)}>
                      <Trash2 className="w-3.5 h-3.5 mr-1" /> Remove message
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => dismissReports(g.post.id)}>
                      Dismiss reports
                    </Button>
                  </div>
                  <details className="mt-2">
                    <summary className="text-[11px] text-muted-foreground cursor-pointer">View {g.reports.length} reporter{g.reports.length > 1 ? "s" : ""}</summary>
                    <div className="mt-2 space-y-1">
                      {g.reports.map((r: any) => (
                        <div key={r.id} className="text-[11px] text-muted-foreground flex items-center gap-2">
                          <span className="font-medium text-foreground">{r.reporter?.name || r.reporter_id.slice(0, 8)}</span>
                          · {r.reason || "No reason"}
                          · {new Date(r.created_at).toLocaleDateString()}
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
              );
            })}
          </TabsContent>

          <TabsContent value="documents" className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-foreground">Document verification</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Review private institute documents and approve access.</p>
              </div>
              <span className="text-xs font-semibold bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))] px-2.5 py-1 rounded-full">
                {documentSubmissions.filter((item: any) => item.status === "pending").length} pending
              </span>
            </div>
            {documentSubmissions.length === 0 && (
              <div className="text-center py-12 bg-card border border-border rounded-xl">
                <ClipboardCheck className="w-10 h-10 text-muted-foreground mx-auto mb-2" />
                <p className="text-sm font-semibold text-foreground">No document submissions</p>
                <p className="text-xs text-muted-foreground mt-1">New submissions will appear here.</p>
              </div>
            )}
            <div className="grid gap-3 lg:grid-cols-2">
              {documentSubmissions.map((submission: any) => {
                const isPending = submission.status === "pending";
                const isReviewing = reviewingDocument === submission.id;
                return (
                  <div key={submission.id} className="bg-card border border-border rounded-xl p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-foreground truncate">{submission.profile?.name || "Unnamed member"}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{submission.iit_name} · {submission.student_status?.replace("_", " ")}</p>
                      </div>
                      <span className={`text-[10px] font-bold px-2 py-1 rounded-full capitalize ${submission.status === "approved" ? "bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]" : submission.status === "rejected" ? "bg-destructive/10 text-destructive" : submission.status === "withdrawn" ? "bg-primary/10 text-primary" : "bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))]"}`}>{submission.status}</span>
                    </div>
                    <div className="rounded-xl bg-secondary/60 p-3 flex items-center gap-3">
                      <FileText className="w-5 h-5 text-primary shrink-0" />
                      <div className="flex-1 min-w-0"><p className="text-xs font-semibold text-foreground truncate">{submission.original_filename}</p><p className="text-[10px] text-muted-foreground capitalize">{submission.document_type?.replaceAll("_", " ")} · {(submission.file_size / 1024 / 1024).toFixed(2)} MB</p></div>
                      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => viewVerificationDocument(submission)}><Eye className="w-3.5 h-3.5 mr-1" /> View</Button>
                    </div>
                    {isPending ? (
                      <>
                        <Textarea value={reviewNotes[submission.id] || ""} onChange={(event) => setReviewNotes((current) => ({ ...current, [submission.id]: event.target.value }))} placeholder="Review note (required when rejecting)" rows={2} className="bg-secondary border-0 text-xs" maxLength={500} />
                        <div className="grid grid-cols-2 gap-2">
                          <Button size="sm" className="h-9 text-xs" onClick={() => reviewDocument(submission, "approved")} disabled={isReviewing}><CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Approve</Button>
                          <Button size="sm" variant="destructive" className="h-9 text-xs" onClick={() => reviewDocument(submission, "rejected")} disabled={isReviewing}><XCircle className="w-3.5 h-3.5 mr-1" /> Reject</Button>
                        </div>
                      </>
                    ) : submission.status === "withdrawn" ? (
                      <p className="text-xs font-medium text-primary">Withdrawn by the member to try another verification method.</p>
                    ) : (
                      <>
                        {submission.review_notes && <p className="text-xs text-muted-foreground"><span className="font-semibold text-foreground">Review note:</span> {submission.review_notes}</p>}
                        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/40 p-2.5">
                          <div className="flex min-w-0 items-center gap-2">
                            <Mail className="h-4 w-4 shrink-0 text-primary" />
                            <span className="truncate text-[11px] text-muted-foreground">
                              {submission.decision_notified_at ? `Email sent ${new Date(submission.decision_notified_at).toLocaleString()}` : "Decision email not sent"}
                            </span>
                          </div>
                          <Button size="sm" variant="outline" className="h-8 shrink-0 text-[11px]" onClick={() => void resendDocumentDecisionEmail(submission)} disabled={isReviewing}>
                            {submission.decision_notified_at ? "Resend email" : "Send email"}
                          </Button>
                        </div>
                        {submission.decision_notification_error && !submission.decision_notified_at && <p className="text-[10px] text-destructive">Last delivery failed. Retry after checking email delivery status.</p>}
                      </>
                    )}
                    <p className="text-[10px] text-muted-foreground">Submitted {new Date(submission.created_at).toLocaleString()}</p>
                  </div>
                );
              })}
            </div>
          </TabsContent>

          <TabsContent value="courses" className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-foreground">Custom course approvals</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Review course names submitted through “Other”.</p>
              </div>
              <span className="text-xs font-semibold bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))] px-2.5 py-1 rounded-full">
                {courseRequests.filter((item: any) => item.status === "pending").length} pending
              </span>
            </div>
            {courseRequests.length === 0 && (
              <div className="text-center py-12 bg-card border border-border rounded-xl">
                <GraduationCap className="w-10 h-10 text-muted-foreground mx-auto mb-2" />
                <p className="text-sm font-semibold text-foreground">No custom course requests</p>
                <p className="text-xs text-muted-foreground mt-1">New requests will appear here.</p>
              </div>
            )}
            <div className="grid gap-3 lg:grid-cols-2">
              {courseRequests.map((request: any) => {
                const isPending = request.status === "pending";
                const isReviewing = reviewingCourse === request.id;
                const statusClass = request.status === "approved"
                  ? "bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]"
                  : request.status === "rejected"
                    ? "bg-destructive/10 text-destructive"
                    : request.status === "withdrawn"
                      ? "bg-primary/10 text-primary"
                      : "bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))]";
                return (
                  <div key={request.id} className="bg-card border border-border rounded-xl p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-foreground truncate">{request.applicant_name || request.profile?.name || "Unnamed member"}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{request.iit_name}</p>
                      </div>
                      <span className={`text-[10px] font-bold px-2 py-1 rounded-full capitalize ${statusClass}`}>{request.status}</span>
                    </div>
                    <div className="rounded-xl bg-secondary/60 p-3 flex items-center gap-3">
                      <GraduationCap className="w-5 h-5 text-primary shrink-0" />
                      <div className="min-w-0"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Requested course</p><p className="text-sm font-bold text-foreground break-words">{request.course_name}</p></div>
                    </div>
                    {isPending ? (
                      <>
                        <Textarea value={reviewNotes[request.id] || ""} onChange={(event) => setReviewNotes((current) => ({ ...current, [request.id]: event.target.value }))} placeholder="Review note (required when rejecting)" rows={2} className="bg-secondary border-0 text-xs" maxLength={500} />
                        <div className="grid grid-cols-2 gap-2">
                          <Button size="sm" className="h-9 text-xs" onClick={() => reviewCourse(request, "approved")} disabled={isReviewing}><CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Approve</Button>
                          <Button size="sm" variant="destructive" className="h-9 text-xs" onClick={() => reviewCourse(request, "rejected")} disabled={isReviewing}><XCircle className="w-3.5 h-3.5 mr-1" /> Reject</Button>
                        </div>
                      </>
                    ) : request.status === "withdrawn" ? (
                      <p className="text-xs font-medium text-primary">Withdrawn by the member after choosing another course.</p>
                    ) : request.review_notes ? (
                      <p className="text-xs text-muted-foreground"><span className="font-semibold text-foreground">Review note:</span> {request.review_notes}</p>
                    ) : null}
                    <p className="text-[10px] text-muted-foreground">Submitted {new Date(request.created_at).toLocaleString()}</p>
                  </div>
                );
              })}
            </div>
          </TabsContent>

          {/* Settings Tab */}
          <TabsContent value="settings" className="space-y-4">
            <div className="bg-card border border-border rounded-xl p-4 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center"><Image className="w-5 h-5 text-primary" /></div>
                <div>
                  <p className="text-sm font-semibold text-foreground">IIT institute logos</p>
                  <p className="text-xs text-muted-foreground">Upload or replace the logo shown beside each IIT during verification.</p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {IIT_LIST.map((iit) => {
                  const logoUrl = appSettings?.[iitLogoSettingKey(iit.studentDomain)] || defaultIitLogo(iit.studentDomain);
                  const uploading = uploadingIitLogo === iit.studentDomain;
                  return (
                    <div key={iit.studentDomain} className="flex items-center gap-3 rounded-xl bg-secondary/50 p-2.5 border border-border/60">
                      <div className="w-10 h-10 rounded-lg bg-white border border-border flex items-center justify-center overflow-hidden shrink-0">
                        <img src={logoUrl} alt={`${iit.name} logo`} className="w-8 h-8 object-contain" />
                      </div>
                      <span className="text-xs font-semibold text-foreground flex-1 min-w-0 truncate">{iit.name}</span>
                      {appSettings?.[iitLogoSettingKey(iit.studentDomain)] && (
                        <button
                          type="button"
                          title="Restore official logo"
                          aria-label={`Restore official ${iit.name} logo`}
                          className="h-8 w-8 rounded-lg border border-border bg-background flex items-center justify-center hover:border-primary disabled:opacity-60"
                          disabled={uploading}
                          onClick={() => void handleResetIitLogo(iit.studentDomain)}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <label className={`h-8 px-2.5 rounded-lg border border-border bg-background text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer hover:border-primary ${uploading ? "opacity-60 pointer-events-none" : ""}`}>
                        <Upload className="w-3.5 h-3.5" /> {uploading ? "Uploading" : "Upload"}
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/svg+xml"
                          className="sr-only"
                          disabled={uploading}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) void handleIitLogoUpload(iit.studentDomain, file);
                            event.target.value = "";
                          }}
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">Images are converted to WebP and resized before upload to reduce storage and egress.</p>
            </div>

            {/* Show Home & Network Toggle */}
            <div className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center"><ToggleLeft className="w-5 h-5 text-primary" /></div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">Show Home & Network</p>
                    <p className="text-xs text-muted-foreground">When OFF, Home feed and Network tabs are hidden for all users</p>
                  </div>
                </div>
                <Switch checked={appSettings?.show_home_network === "true"} onCheckedChange={(checked) => {
                  updateSetting("show_home_network", checked ? "true" : "false");
                  queryClient.invalidateQueries({ queryKey: ["app-settings"] });
                }} />
              </div>
            </div>
            <div className="bg-card border border-border rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center"><Users className="w-5 h-5 text-primary" /></div>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-foreground">Launch test data</p>
                  <p className="text-xs text-muted-foreground">24 dummy IIT Delhi · MBA · General · 2026 members and 1,500 forum messages/threads.</p>
                </div>
              </div>
              {appSettings?.test_seed_summary && <p className="rounded-lg bg-secondary px-3 py-2 text-[11px] text-muted-foreground">Dummy cohort is currently installed and tracked for safe removal.</p>}
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" className="rounded-xl" disabled={!!testDataAction || !!appSettings?.test_seed_summary} onClick={() => void manageTestData("seed")}>
                  <Plus className="w-4 h-4 mr-1.5" /> {testDataAction === "seed" ? "Adding…" : "Add test data"}
                </Button>
                <Button variant="destructive" className="rounded-xl" disabled={!!testDataAction || !appSettings?.test_seed_summary} onClick={() => void manageTestData("purge")}>
                  <Trash2 className="w-4 h-4 mr-1.5" /> {testDataAction === "purge" ? "Removing…" : "Remove dummy data"}
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">Requires the seed-data Edge Function with SEED_DATA_ENABLED=true. Purge only uses tracked dummy user IDs.</p>
            </div>


            {/* Terms & Conditions editor */}
            <div className="bg-card border border-border rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center"><FileText className="w-5 h-5 text-primary" /></div>
                <div>
                  <p className="text-sm font-semibold text-foreground">Terms & Conditions text</p>
                  <p className="text-xs text-muted-foreground">Shown next to the checkbox during onboarding</p>
                </div>
              </div>
              <Textarea id="terms-text-input" defaultValue={appSettings?.terms_text || ""} className="bg-secondary border-0 text-sm" rows={3} />
              <Button size="sm" onClick={() => {
                const v = (document.getElementById("terms-text-input") as HTMLTextAreaElement)?.value || "";
                updateSetting("terms_text", v);
              }}>Save terms</Button>
            </div>

            {/* Admin role manager (database-authorized platform owners only) */}
            {isPlatformOwner && (
              <div className="bg-card border border-border rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center"><Shield className="w-5 h-5 text-primary" /></div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">Admin users</p>
                    <p className="text-xs text-muted-foreground">Promote users to admin (platform owners only)</p>
                  </div>
                </div>
                <div className="space-y-1">
                  {adminUsers?.map((a: any) => (
                    <div key={a.user_id} className="flex items-center gap-2 p-2 rounded-lg bg-secondary/40">
                      <span className="text-xs font-semibold text-foreground flex-1">{a.name || a.user_id.slice(0, 8)}</span>
                      <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => revokeAdmin(a.user_id)}>Revoke</Button>
                    </div>
                  ))}
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Promote user from list below</Label>
                  <div className="mt-2 max-h-48 overflow-y-auto space-y-1">
                    {filteredUsers?.filter((u: any) => !adminUsers?.some((a: any) => a.user_id === u.user_id)).slice(0, 30).map((u: any) => (
                      <div key={u.user_id} className="flex items-center gap-2 p-2 rounded-lg bg-secondary/40">
                        <span className="text-xs text-foreground flex-1 truncate">{u.name || "Unnamed"}</span>
                        <Button size="sm" className="h-7 text-[11px]" onClick={() => grantAdmin(u.user_id)}>Make admin</Button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default Admin;
