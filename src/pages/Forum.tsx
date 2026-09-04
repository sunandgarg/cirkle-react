import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Send, Smile, Search, ImageIcon, X, BarChart3, Plus, Trash2, Reply,
  Menu, Hash, Bookmark, Pin,
  MoreHorizontal, Check, Users, Megaphone, Copy,
  Clock, Pencil, AtSign, ArrowDown, ArrowLeft,
  Mic, Paperclip, MessageSquare, Bold, Italic, Code, Timer, Settings2, Eye,
  Filter, Calendar, User, Link2, Image as ImageLucide, ChevronRight, Camera,
  Volume2, EyeOff, Flag, Keyboard
} from "lucide-react";
import BottomNav from "@/components/BottomNav";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { format, isToday, isYesterday, subDays, subHours, subMinutes } from "date-fns";
import MaskedContent from "@/components/MaskedContent";
import GifPicker from "@/components/GifPicker";
import { renderFormattedMessage } from "@/components/forum/MessageFormatting";
import VoiceRecorder, { VoicePlayback } from "@/components/forum/VoiceRecorder";
import ImageLightbox from "@/components/forum/ImageLightbox";
import FileAttachment from "@/components/forum/FileAttachment";
import ThreadPanel from "@/components/forum/ThreadPanel";
import ScopeNavigationItem from "@/components/forum/ScopeNavigationItem";
import DirectMessageSidebar from "@/components/forum/DirectMessageSidebar";
import PostVerifyOnboarding from "@/components/PostVerifyOnboarding";
import {
  getCachedPosts, setCachedPosts, getUnreadChannels, setChannelRead,
  getForumDraft, setForumDraft, getForumScroll, setForumScroll,
  getForumTestPosts, appendForumTestPost, getLastForumRoom, setLastForumRoom,
} from "@/hooks/useForumCache";
import { useScrollBehavior } from "@/hooks/useScrollBehavior";
import {
  buildForumScopes, hasCompleteForumEducation,
  type CanonicalAcademicIdentity, type ForumScope as ScopeDef,
} from "@/lib/forumScopes";
import { hasMobileTestAcademicProfile, readMobileTestSession } from "@/lib/mobileVerification";
import { applyForumRealtimeBatch, getForumBroadcastRow, type ForumRealtimeEvent } from "@/lib/forumRealtime";
import { acknowledgeForumPost } from "@/lib/forumMessages";
import { hydrateForumMediaUrls } from "@/lib/forumMedia";
import { publishForumOutboxItem } from "@/lib/forumPublisher";
import {
  deleteForumOutboxItem, listForumOutboxItems, markForumOutboxFailed,
  putForumOutboxItem, subscribeForumOutbox, type ForumOutboxItem,
} from "@/lib/forumOutbox";
import {
  forumSendFingerprint, resolveForumSendIdentity,
  type ForumSendIdentity, type ForumSendSnapshot,
} from "@/lib/forumSend";
import {
  MAX_ROOM_HISTORY, mergeForumHistoryPosts, persistForumHistory, readForumHistory,
} from "@/lib/forumHistoryCache";
import { createRealtimeRecoveryController } from "@/lib/realtimeRecovery";
import {
  appSyncRealtimeEnabled, getForumAppSyncChannels, publishAppSync, subscribeAppSync,
} from "@/lib/appsyncEvents";
import { useRealtimeActivity } from "@/hooks/useRealtimeActivity";
import { shouldAnchorLatestDuringKeyboard, useVisualViewportHeight } from "@/hooks/useVisualViewportHeight";
import { safeHttpUrl } from "@/lib/safeUrl";
import NotificationBell from "@/components/NotificationBell";

const isDemoId = (id: string) => typeof id === "string" && (
  id.startsWith("demo-") || id.startsWith("test-") || id.startsWith("outbox-")
);
const QUICK_REACTIONS = ["❤️", "🔥", "👍", "😂", "💯"];
const LEGACY_FORUM_POST_COLUMNS = "id,community_id,scope_type,scope_key,channel,content,is_anonymous,author_id,created_at,image_url,image_path,reply_to_id,file_url,file_path,file_name,file_size,file_type,deleted_at,deleted_for_users,is_deleted_for_everyone,edited_at,pinned_at,voice_url,voice_path,voice_duration";

/* ─── Color helpers ─── */
const DISCORD_COLORS = [
  "text-[hsl(359,82%,65%)]", "text-[hsl(38,96%,65%)]", "text-[hsl(139,47%,55%)]",
  "text-[hsl(197,100%,64%)]", "text-[hsl(234,89%,74%)]", "text-[hsl(313,64%,68%)]",
  "text-[hsl(27,90%,65%)]", "text-[hsl(168,76%,52%)]",
];
const AVATAR_COLORS = [
  "bg-[hsl(359,82%,55%)]", "bg-[hsl(38,96%,55%)]", "bg-[hsl(139,47%,45%)]",
  "bg-[hsl(197,100%,54%)]", "bg-[hsl(234,89%,64%)]", "bg-[hsl(313,64%,58%)]",
  "bg-[hsl(27,90%,55%)]", "bg-[hsl(168,76%,42%)]",
];
const getUserColor = (userId: string) => {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  const idx = Math.abs(hash) % DISCORD_COLORS.length;
  return { bg: AVATAR_COLORS[idx], text: DISCORD_COLORS[idx] };
};
const getInitials = (name?: string | null): string => {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return parts[0][0].toUpperCase();
};

const getDateLabel = (dateStr: string): string => {
  const date = new Date(dateStr);
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  return format(date, "MMMM d, yyyy");
};

/* ─── Build query for a scope ─── */
type ForumCursor = { createdAt: string; id: string };

const buildScopeQuery = (scopeType: string, scopeKey: string, limit = 50, before?: ForumCursor) => {
  let q = supabase.from("posts").select(LEGACY_FORUM_POST_COLUMNS)
    .is("reply_to_id", null)
    .is("deleted_at", null)
    .eq("scope_type", scopeType)
    .eq("scope_key", scopeKey)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit) as any;
  
  if (before) {
    // A timestamp-only cursor can skip rows created in the same transaction.
    // The posts index uses this same (created_at, id) ordering.
    q = q.or(`created_at.lt.${before.createdAt},and(created_at.eq.${before.createdAt},id.lt.${before.id})`);
  }

  return q;
};

const fetchForumPage = async (scopeType: string, scopeKey: string, limit = 50, before?: ForumCursor) => {
  const { data, error } = await (supabase as any).rpc("get_forum_posts_page", {
    p_scope_type: scopeType, p_scope_key: scopeKey, p_limit: limit,
    p_before_created_at: before?.createdAt || null, p_before_id: before?.id || null,
  });
  if (error) throw error;
  return hydrateForumMediaUrls<any>((data || []).map((row: any) => row.post || row)) as Promise<any[]>;
};

/* ─── Expanded test data (60+ messages) ─── */
const DEMO_NAMES = [
  "Arjun Mehta", "Priya Sharma", "Karthik Nair", "Sneha Reddy", "Rahul Verma",
  "Ananya Gupta", "Vikram Singh", "Deepika Joshi", "Rohan Das", "Megha Patel",
  "Aditya Kumar", "Ishita Banerjee", "Siddharth Rao", "Kavya Iyer", "Nikhil Chopra",
];
const DEMO_IDS = DEMO_NAMES.map((_, i) => `demo-user-${i + 1}`);

const generateTestMessages = (): any[] => {
  const now = new Date();
  const msgs: any[] = [];
  let id = 1;
  const m = (content: string, authorIdx: number, hoursAgo: number, opts: Partial<any> = {}) => {
    const created = subMinutes(subHours(now, Math.floor(hoursAgo)), Math.round((hoursAgo % 1) * 60));
    msgs.push({
      id: `demo-${id++}`, content, author_id: opts.is_anonymous ? `anon-${id}` : DEMO_IDS[authorIdx % DEMO_IDS.length],
      created_at: created.toISOString(), is_anonymous: opts.is_anonymous || false,
      scope_type: "GLOBAL", scope_key: "IIT_ALL", channel: "global",
      image_url: opts.image_url || null, voice_url: null, file_url: null,
      pinned_at: opts.pinned_at || null, reply_to_id: opts.reply_to_id || null,
      deleted_at: null, is_deleted_for_everyone: false, seen_by: [],
      edited_at: opts.edited_at || null, tags: opts.tags || null,
      profile: { name: DEMO_NAMES[authorIdx % DEMO_NAMES.length], avatar_url: null, slug: null },
      poll: opts.poll || null,
      replyCount: opts.replyCount || 0,
      reactions: opts.reactions || {},
      myReactions: [],
    });
  };

  // ── Tech discussions (spread over 5 days) ──
  m("🚀 React 19 just dropped! Server Components are now stable. Anyone tried migrating a production app yet?", 0, 96);
  m("We migrated our dashboard last week. The streaming SSR is incredible - TTFB dropped by 60%", 2, 95, { replyCount: 3 });
  m("Honest question: is it worth the migration pain? We have a massive codebase on React 17 still 😅", 4, 94);
  m("@Karthik Worth it if you're doing SSR. If it's a pure SPA, the benefits are more subtle", 1, 93, { reactions: { "👍": 4, "💯": 2 } });
  m("Has anyone here run Bun in production? Our Node.js cold starts on Lambda are killing us", 3, 88);
  m("We switched 3 months ago. Cold starts went from ~800ms to ~120ms. No regrets.", 5, 87.5, { reactions: { "🔥": 6 } });
  m("Careful with Bun - some npm packages with native bindings still break. Test thoroughly.", 7, 87);
  m("Rust vs Go for backend services - what's the IIT consensus? Starting a new microservice and genuinely torn", 6, 80);
  m("Go for 90% of use cases. Rust only if you need zero-cost abstractions or systems-level perf.", 8, 79, { reactions: { "👍": 8, "❤️": 2 } });
  m("Go has a gentler learning curve too. Your team will thank you when onboarding new devs", 9, 78.5);
  m("Platform engineering AMA happening next Friday! Drop your questions here and I'll compile them 📋", 0, 72, { pinned_at: new Date().toISOString(), replyCount: 7 });
  m("Question: How are we balancing typed relational data with flexible community features?", 10, 71);
  m("AI made me 40% more productive but 40% more lazy. Is this a net positive? 🤖", 11, 65, { is_anonymous: true, reactions: { "😂": 12, "💯": 5, "🔥": 3 } });
  m("The real question is: does your manager know the productivity gain is from AI? 😏", 4, 64.5, { reactions: { "😂": 8 } });
  m("TypeScript 5.4 discriminated unions are so clean. Here's a pattern I've been using for API responses…", 12, 56);
  m("```\ntype Result<T> = \n  | { ok: true; data: T }\n  | { ok: false; error: string }\n```\nSimple but powerful", 12, 55.8, { reactions: { "💯": 4 } });
  m("Just discovered htmx. Is anyone using it seriously or is it just Twitter hype?", 13, 48);
  m("We use it for internal tools. It's genuinely good for CRUD apps. Not a React replacement though.", 1, 47.5);
  m("Tailwind v4 alpha is looking interesting. CSS-first config, no more tailwind.config.js 🎨", 3, 40, { reactions: { "👍": 3 } });

  // ── Jobs channel ──
  m("🔥 Razorpay is hiring SDE-2s. DM me for referral. TC: 35-42L. Bangalore/Remote", 5, 92, { reactions: { "🔥": 5, "👍": 3 } });
  m("FAANG vs unicorn comp thread - let's be real about numbers. I'll start: L5 at Google Bangalore, 65L TC", 8, 84, { replyCount: 12, reactions: { "😮": 6 } });
  m("Meesho SDE-3: 52L. Joined at 26, now 28. Best decision of my career honestly", 10, 83);
  m("Staff Eng journey at 28 - AMA. Went from SDE-1 at Infosys to Staff at Razorpay in 5 years", 6, 76, { replyCount: 15, reactions: { "🔥": 9, "💯": 4 } });
  m("is job hopping every 18 months the new normal? I've done 4 companies in 6 years and my salary 5x'd", 14, 68, { is_anonymous: true, reactions: { "😂": 3, "👍": 7 } });
  m("Counterpoint: I stayed 4 years at Amazon, got promoted twice. Loyalty still works if the company is right", 2, 67);
  m("Bangalore SDE-3 salary benchmarks 2025 - let's crowdsource this. Drop your TC anonymously 📊", 9, 52, { replyCount: 8 });
  m("45L Flipkart SDE-3, 3 YOE at this level", 0, 51.5, { is_anonymous: true });
  m("58L Atlassian SDE-3, Bangalore. RSUs are the real game changer", 1, 51, { is_anonymous: true, reactions: { "🔥": 2 } });
  m("Anyone know about Cred's hiring freeze? Was supposed to interview next week and got ghosted", 11, 44);
  m("PhonePe is doing a campus drive at IIT KGP next month. Internship → PPO pipeline", 3, 36, { reactions: { "👍": 2 } });

  // ── Random channel ──
  m("Best chai spots in Koramangala? Just moved here from Delhi and the chai scene is… different 🍵", 7, 90, { reactions: { "😂": 3 } });
  m("Third Wave Coffee on 80 feet road isn't chai but their filter coffee is elite", 9, 89.5);
  m("There's a street vendor near Sony Signal. ₹15 cutting chai, better than anything in Delhi fight me", 13, 89, { reactions: { "🔥": 4, "❤️": 2 } });
  m("WFH vs office hot take: I'm more productive at home but more creative in office. Hybrid 3 days is the sweet spot", 1, 82, { replyCount: 6, reactions: { "👍": 5 } });
  m("Deployed on Friday. Production went down. Classic. 🫠", 4, 74, { reactions: { "😂": 15, "🔥": 3 } });
  m("```\ngit push origin main --force\n# What could go wrong?\n```", 4, 73.8, { reactions: { "😂": 8 } });
  m("does anyone else pretend to be busy during standups? 'Yeah I was... refactoring... the auth module... 👀'", 12, 60, { is_anonymous: true, reactions: { "😂": 18, "💯": 7 } });
  m("Weekend hiking near Bangalore - Skandagiri sunrise trek this Saturday. Who's in? 🏔️", 6, 50, { reactions: { "❤️": 4 }, replyCount: 5 });
  m("Count me in! Last time we went to Nandi Hills it was magical at 5am", 10, 49.5);
  m("Just finished reading 'Staff Engineer' by Will Larson. Highly recommend for anyone eyeing that path 📚", 0, 42, { reactions: { "👍": 6 } });
  m("Monday motivation: Remember when you couldn't even center a div? Look at you now building distributed systems 💪", 1, 28, { reactions: { "❤️": 9, "🔥": 4 } });
  m("The irony is I still can't center a div without Flexbox 😂", 3, 27.5, { reactions: { "😂": 11 } });

  // ── Announcements ──
  m("🎉 We just hit 1000 members! Thank you all for making this community incredible. Here's to the next 1000!", 0, 70, { pinned_at: new Date().toISOString(), reactions: { "🎉": 20, "❤️": 12, "🔥": 8 } });
  m("📢 Anonymous posting is now live! Toggle the 👁️ icon in the composer to post anonymously. Your identity stays hidden.", 0, 62, { reactions: { "👍": 15, "🔥": 6 } });
  m("Monthly IIT Alumni Meetup - This Saturday 7PM IST at Cubbon Park, Bangalore. DM for exact location 📍", 0, 34, { replyCount: 9, reactions: { "👍": 8, "❤️": 3 } });
  m("🚀 Job board feature coming next week! Post and discover opportunities within the IIT network. Stay tuned!", 0, 20, { reactions: { "🔥": 10, "💯": 5 } });

  // ── Recent messages (today) ──
  m("Good morning everyone! ☀️ What's everyone working on today?", 5, 8);
  m("Building a real-time dashboard with Node, MySQL and React Query. The combo is 🤌", 2, 7.5, { reactions: { "🔥": 2 } });
  m("Debugging a memory leak in our Node service. Send help 🆘", 8, 6, { reactions: { "😂": 3 } });
  m("Have you tried the --inspect flag with Chrome DevTools? Saved my life last week", 0, 5.5);
  m("Hot take: Prettier > ESLint for code formatting. Fight me.", 14, 4, { reactions: { "👍": 3, "😂": 2 } });
  m("That's not even a hot take, that's just facts 😤", 3, 3.5);
  m("Anyone else excited about Deno 2.0? The npm compat story is finally solid", 11, 2, { reactions: { "👍": 2 } });
  m("Just shipped my first Rust + WASM module in a React app. Performance is insane for image processing", 6, 1, { reactions: { "🔥": 5, "💯": 2 } });
  m("The future is polyglot. JS for UI, Rust for compute, Go for services, Python for ML. Master your stack.", 0, 0.5, { reactions: { "💯": 8, "❤️": 3 } });

  return msgs;
};

const DEMO_MESSAGES = generateTestMessages();
const comparePostsChronologically = (left: any, right: any) => {
  const byTime = new Date(left?.created_at || 0).getTime() - new Date(right?.created_at || 0).getTime();
  return byTime || String(left?.id || "").localeCompare(String(right?.id || ""));
};
const sortPostsChronologically = (items: any[] = []) => [...items].sort(comparePostsChronologically);

/* ─── Scope-specific demo messages (so each channel feels unique) ─── */
const generateScopeDemos = (scopeType: string, scopeKey: string, scopeDef?: any): any[] => {
  if (scopeType === "GLOBAL") return DEMO_MESSAGES;

  const now = new Date();
  const label = scopeDef?.label || "this channel";
  const subtitle = scopeDef?.subtitle || "";
  const parts = scopeKey.split("|");
  const iit = (parts[0] || "").replace(/_/g, " ");
  const seed = scopeType + "_" + scopeKey;
  let h = 0; for (let i = 0; i < seed.length; i++) h = seed.charCodeAt(i) + ((h << 5) - h);
  const pick = (arr: string[], offset = 0) => arr[Math.abs(h + offset) % arr.length];

  let templates: string[] = [];
  switch (scopeType) {
    case "CAMPUS":
      templates = [
        `Welcome to the ${iit} channel 👋 Drop a hi so we know who's around!`,
        `Anyone heading to the ${iit} hostel mess tonight? The Tuesday menu is actually decent`,
        `${iit} placement cell just opened registrations for the spring drive - link in pinned`,
        `Looking for a ${iit} senior who did MS in Germany - quick chai/coffee chat?`,
        `Auditorium AC is broken again 🥲 Anyone raised a complaint?`,
        `${iit} tech fest dates are out. Volunteers needed for logistics`,
        `Selling cycle in good condition, graduating next month - ${iit} hostel pickup`,
        `Library extended hours till 2am during endsems - finally`,
      ];
      break;
    case "COURSE_CAMPUS":
    case "COURSE_GLOBAL": {
      const course = (parts[parts.length - 1] || "").replace(/_/g, " ");
      templates = [
        `${course} folks - what electives did you regret NOT taking?`,
        `Best prof for the core ${course} sequence? Asking for a junior`,
        `Any ${course} grads working in product roles? Curious about the transition`,
        `${course} project ideas - sharing a Notion doc with 30+ ideas, DM for link`,
        `Internship season tips for ${course} students - what worked for you?`,
        `${course} alumni meetup happening this weekend, IRL + Zoom`,
      ];
      break;
    }
    case "BATCH_CAMPUS":
    case "BATCH_GLOBAL": {
      const batch = parts[parts.length - 1] || "our batch";
      templates = [
        `Batch ${batch} - convocation photos, drop them here 📸`,
        `Whatsapp groups are dead, glad we have this. How's everyone doing post-grad?`,
        `Batch ${batch} reunion - Goa or Bangalore? Vote with reactions 🏖️🌆`,
        `Who else from ${batch} is doing MBA this year? Forming a study group`,
        `Throwback to ${batch} freshers night… we were so confused 😂`,
        `${batch} - anyone got married recently?? Share the news!`,
      ];
      break;
    }
    case "COHORT": {
      const degree = (parts[1] || "").replace(/_/g, " ");
      const branch = (parts[2] || "").replace(/_/g, " ");
      const batch = parts[3] || "";
      templates = [
        `${degree} ${branch} ${batch} - our private corner. No outsiders 🤫`,
        `Project allocation list dropped - who got which guide?`,
        `${branch} comprehensive viva tips please 🙏`,
        `Lab partners for next sem - drop a 🙋 if you need one`,
        `Anyone else struggling with the ${branch} core sequence this sem?`,
        `${batch} ${branch} placement stats - shall we make a shared sheet?`,
      ];
      break;
    }
    case "COHORT_GLOBAL": {
      const degree = (parts[0] || "").replace(/_/g, " ");
      const branch = (parts[1] || "").replace(/_/g, " ");
      const batch = parts[2] || "";
      templates = [
        `${degree} ${branch} ${batch} across all 23 IITs - say hi from your campus 👋`,
        `Curriculum comparison: how does ${branch} differ at your IIT?`,
        `Inter-IIT ${branch} project collab - anyone interested?`,
        `${batch} ${branch} placement trends across IITs - let's pool data`,
        `Best ${branch} electives at your campus? Recommendations welcome`,
        `Anyone from ${branch} ${batch} going for higher studies abroad?`,
      ];
      break;
    }

    default:
      templates = [`Welcome to ${label} ${subtitle ? "· " + subtitle : ""}`, "Be the first to start a conversation here ✨"];
  }

  return templates.map((content, i) => ({
    id: `demo-${seed}-${i}`,
    content,
    author_id: DEMO_IDS[(Math.abs(h) + i) % DEMO_IDS.length],
    created_at: subHours(now, (templates.length - i) * 2 + (i % 3)).toISOString(),
    is_anonymous: false,
    scope_type: scopeType, scope_key: scopeKey,
    channel: scopeType.toLowerCase(),
    image_url: null, voice_url: null, file_url: null,
    pinned_at: i === 0 ? new Date().toISOString() : null,
    reply_to_id: null, deleted_at: null, is_deleted_for_everyone: false, seen_by: [],
    edited_at: null, tags: null,
    profile: { name: pick(DEMO_NAMES, i), avatar_url: null, slug: null },
    poll: null, replyCount: i % 4, reactions: i % 2 === 0 ? { "👍": (i % 5) + 1 } : {},
    myReactions: [],
  }));
};

const PAGE_SIZE = 50;
const MAX_RENDERED = MAX_ROOM_HISTORY;
const FORUM_BUILD = "2026.09.03.1";

/* ══════════════════════════════════════════════════ */
/*                  FORUM PAGE                       */
/* ══════════════════════════════════════════════════ */
const Forum = () => {
  const { user, profile, isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const realtimeActive = useRealtimeActivity();

  // Core state
  const [activeScope, setActiveScope] = useState<{ type: string; key: string }>({ type: "GLOBAL", key: "IIT_ALL" });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [desktopSidebarActive, setDesktopSidebarActive] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches);
  const [memberPanelOpen, setMemberPanelOpen] = useState(false);
  const [content, setContent] = useState("");
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [showPollCreator, setShowPollCreator] = useState(false);
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState(["", ""]);
  const [replyTo, setReplyTo] = useState<any>(null);
  const [editingPost, setEditingPost] = useState<any>(null);
  const [editContent, setEditContent] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [searchTab, setSearchTab] = useState<"messages" | "media" | "pins" | "links">("messages");
  const [activeTab, setActiveTab] = useState<"feed" | "pinned">("feed");
  const [highlightedPostId, setHighlightedPostId] = useState<string | null>(null);
  const [deepLinkedPost, setDeepLinkedPost] = useState<any>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [showMentionSuggestions, setShowMentionSuggestions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [threadPost, setThreadPost] = useState<any>(null);
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showFormatBar, setShowFormatBar] = useState(false);
  const [newMsgCount, setNewMsgCount] = useState(0);
  const [unreadDots, setUnreadDots] = useState<Record<string, boolean>>(() => getUnreadChannels());
  const [testRoomPosts, setTestRoomPosts] = useState<any[]>([]);
  const [outboxPosts, setOutboxPosts] = useState<any[]>([]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const sync = () => setDesktopSidebarActive(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (searchParams.get("channels") !== "open") return;
    if (!desktopSidebarActive) setSidebarOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("channels");
    setSearchParams(next, { replace: true });
  }, [desktopSidebarActive, searchParams, setSearchParams]);

  // Pagination state
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(true);
  const [olderPages, setOlderPages] = useState<any[]>([]);

  const presenceChannelRef = useRef<any>(null);
  const typingLastSentRef = useRef(0);
  const remoteTypingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasScrolledRef = useRef(false);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const prevPostCountRef = useRef(0);
  const shouldFollowLiveRef = useRef(true);
  const sendIdentityRef = useRef<ForumSendIdentity | null>(null);
  const processingOutboxRef = useRef(false);
  const deepLinkRequestRef = useRef<string | null>(null);
  const outboxPreviewUrlsRef = useRef<Map<string, string>>(new Map());
  const anchorLatestDuringKeyboardRef = useRef(false);
  const scrollWorkFrameRef = useRef<number | null>(null);
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const olderPageRequestRef = useRef(false);
  const olderPageTriggerArmedRef = useRef(true);

  // Slow mode state
  const [slowModeEnabled, setSlowModeEnabled] = useState(false);
  const [slowModeSeconds, setSlowModeSeconds] = useState(30);
  const [lastPostTime, setLastPostTime] = useState<number>(0);
  const [slowModeCooldown, setSlowModeCooldown] = useState(0);

  const { data: slowModeSettings } = useQuery({
    queryKey: ["slow-mode-settings", activeScope.type, activeScope.key],
    queryFn: async () => {
      const scopeSettingKey = `slow_mode_${activeScope.type}_${activeScope.key}`;
      const { data } = await supabase.from("app_settings").select("*").or(`key.eq.slow_mode_global,key.eq.${scopeSettingKey}`);
      const map: Record<string, string> = {};
      (data as any[])?.forEach((s: any) => { map[s.key] = s.value; });
      return map;
    },
    staleTime: 30000,
  });

  useEffect(() => {
    if (!slowModeSettings) return;
    const scopeKey = `slow_mode_${activeScope.type}_${activeScope.key}`;
    const setting = slowModeSettings[scopeKey] || slowModeSettings["slow_mode_global"];
    if (setting) {
      try {
        const parsed = JSON.parse(setting);
        setSlowModeEnabled(parsed.enabled || false);
        setSlowModeSeconds(parsed.seconds || 30);
      } catch { setSlowModeEnabled(false); }
    } else {
      setSlowModeEnabled(false);
    }
  }, [slowModeSettings, activeScope]);

  useEffect(() => {
    if (!slowModeEnabled || slowModeCooldown <= 0) return;
    const timer = setInterval(() => {
      setSlowModeCooldown(prev => {
        if (prev <= 1) { clearInterval(timer); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [slowModeEnabled, slowModeCooldown]);

  const isVerified = profile?.is_verified;

  /* ─── Education data ─── */
  const { data: primaryEducation, isSuccess: educationLoaded } = useQuery({
    queryKey: ["primary-education", user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const testSession = readMobileTestSession();
      if (testSession) {
        return hasMobileTestAcademicProfile(testSession) ? {
          institution: testSession.iitName || profile?.iit_name || "",
          degree: testSession.degree!,
          branch_area: testSession.specialisation!,
          passing_year: testSession.passingYear!,
        } : null;
      }
      if ((profile as any)?.primary_education_id) {
        const { data, error } = await supabase.from("education").select("*").eq("id", (profile as any).primary_education_id).maybeSingle();
        if (error) throw error;
        if (hasCompleteForumEducation(data)) return data;
      }
      const { data, error } = await supabase.from("education").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(20);
      if (error) throw error;
      return data?.find(hasCompleteForumEducation) || null;
    },
    enabled: !!user?.id,
    staleTime: 5 * 60 * 1000,
    refetchOnMount: "always",
    refetchOnReconnect: true,
  });

  const { data: canonicalIdentity, isSuccess: identityLoaded } = useQuery({
    queryKey: ["canonical-academic-identity", user?.id],
    queryFn: async () => {
      if (!user?.id || readMobileTestSession()) return null;
      const { data, error } = await (supabase as any).rpc("get_my_academic_identity");
      // Gracefully support a frontend-first deploy while the migration rolls out.
      if (error) return null;
      const row = Array.isArray(data) ? data[0] : data;
      return (row || null) as CanonicalAcademicIdentity | null;
    },
    enabled: !!user?.id,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const scopes = useMemo(
    () => buildForumScopes(profile, primaryEducation, canonicalIdentity),
    [profile, primaryEducation, canonicalIdentity],
  );

  useEffect(() => {
    const session = readMobileTestSession();
    setTestRoomPosts(session ? getForumTestPosts(activeScope.type, activeScope.key) : []);
  }, [activeScope.type, activeScope.key]);

  const { data: userPinnedIds = [] } = useQuery({
    queryKey: ["user-pins", user?.id, activeScope.type, activeScope.key],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data } = await supabase.from("user_pinned_messages").select("message_id")
        .eq("user_id", user.id)
        .eq("forum_scope_type", activeScope.type)
        .eq("forum_scope_key", activeScope.key);
      return (data || []).map((d: any) => d.message_id);
    },
    enabled: !!user?.id,
    staleTime: 30000,
  });

  const { data: adMessages } = useQuery({
    queryKey: ["ad-messages", activeScope.type, activeScope.key],
    queryFn: async () => {
      const { data } = await supabase.from("ad_messages").select("*")
        .eq("is_active", true)
        .or(`and(scope_type.eq.${activeScope.type},scope_key.eq.${activeScope.key}),and(scope_type.eq.GLOBAL,scope_key.eq.IIT_ALL)`)
        .order("created_at", { ascending: false }).limit(3);
      return data || [];
    },
    staleTime: 60000,
  });

  const { data: scopeMembers } = useQuery({
    queryKey: ["scope-members", activeScope.type, activeScope.key],
    queryFn: async () => {
      const q = buildScopeQuery(activeScope.type, activeScope.key);
      const { data: posts } = await q;
      if (!posts?.length) return [];
      const authorIds = [...new Set((posts as any[]).map((p: any) => p.author_id).filter(Boolean))].slice(0, 30) as string[];
      if (!authorIds.length) return [];
      const { data: profiles } = await supabase.from("profiles").select("user_id, name, avatar_url, headline, iit_name, is_verified, slug").in("user_id", authorIds);
      return profiles || [];
    },
    staleTime: 60000,
  });

  const profileMap = useMemo(() => {
    const map = new Map<string, any>();
    scopeMembers?.forEach((p: any) => map.set(p.user_id, p));
    return map;
  }, [scopeMembers]);

  const activeScopeDef = useMemo(() => {
    for (const s of scopes) {
      if (s.hasToggle && s.toggleOptions) {
        const opt = s.toggleOptions.find((option) => option.type === activeScope.type && option.key === activeScope.key);
        if (opt) {
          return { ...s, label: opt.scopeLabel || s.label, subtitle: opt.subtitle || s.subtitle };
        }
      }
      if (s.type === activeScope.type && s.key === activeScope.key) return s;
    }
    return scopes[0] || { label: "Multiverse", subtitle: "Global", emoji: "🌐" };
  }, [scopes, activeScope]);

  useEffect(() => {
    if (!scopes.length || !user?.id) return;
    const availableRooms = scopes.flatMap((scope) => [
      { type: scope.type, key: scope.key },
      ...(scope.toggleOptions || []).map((option) => ({ type: option.type, key: option.key })),
    ]);
    const isAvailable = (room: { type: string; key: string } | null) =>
      !!room && availableRooms.some((candidate) => candidate.type === room.type && candidate.key === room.key);
    const local = getLastForumRoom(user.id);
    const fallback = scopes.find((scope) => scope.type === "GLOBAL") || scopes[0];
    if (isAvailable(local)) setActiveScope(local!);
    else setActiveScope({ type: fallback.type, key: fallback.key });

    if (readMobileTestSession()) return;
    let cancelled = false;
    void (supabase as any).rpc("get_last_forum_room").then(({ data, error }: any) => {
      if (cancelled || error) return;
      const row = Array.isArray(data) ? data[0] : data;
      const remote = row ? { type: row.scope_type, key: row.scope_key } : null;
      if (isAvailable(remote)) {
        setActiveScope(remote!);
        setLastForumRoom(user.id, remote!);
      }
    });
    return () => { cancelled = true; };
  }, [scopes, user?.id]);

  // Smart scroll hide/show
  const { showInput, showNavBar, showHeader, restoreAll } = useScrollBehavior(scrollContainerRef);
  const visualViewportHeight = useVisualViewportHeight();

  // Keep the latest message anchored only when the member was already near
  // the end of the conversation. Opening the keyboard while reading history
  // must never pull them through the timeline.
  useEffect(() => {
    if (!anchorLatestDuringKeyboardRef.current || document.activeElement !== textareaRef.current) return;
    const frame = requestAnimationFrame(() => {
      const scroller = scrollContainerRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [visualViewportHeight]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    setContent(getForumDraft(activeScope.type, activeScope.key));
    return () => {
      if (scrollWorkFrameRef.current !== null) cancelAnimationFrame(scrollWorkFrameRef.current);
      scrollWorkFrameRef.current = null;
      if (scrollSaveTimerRef.current !== null) clearTimeout(scrollSaveTimerRef.current);
      scrollSaveTimerRef.current = null;
      const offset = scrollContainer?.scrollTop || 0;
      setForumScroll(activeScope.type, activeScope.key, offset);
    };
  }, [activeScope.type, activeScope.key]);

  // Mark channel as read when opened - also reset pagination
  useEffect(() => {
    setChannelRead(activeScope.type, activeScope.key);
    setUnreadDots(getUnreadChannels());
    setNewMsgCount(0);
    setHasMoreOlder(true);
    setOlderPages([]);
    olderPageRequestRef.current = false;
    olderPageTriggerArmedRef.current = true;
    if (user?.id && !readMobileTestSession()) {
      void (supabase as any).rpc("mark_forum_scope_read", {
        p_scope_type: activeScope.type,
        p_scope_key: activeScope.key,
      }).then(() => queryClient.invalidateQueries({ queryKey: ["forum-unread", user.id] }));
    }
  }, [activeScope.type, activeScope.key, queryClient, user?.id]);

  useEffect(() => {
    if (!user?.id || readMobileTestSession()) return;
    let cancelled = false;
    void (supabase as any).rpc("get_forum_room_state", {
      p_scope_type: activeScope.type,
      p_scope_key: activeScope.key,
    }).then(({ data, error }: any) => {
      if (cancelled || error) return;
      const room = Array.isArray(data) ? data[0] : data;
      if (!room) return;
      if (!getForumDraft(activeScope.type, activeScope.key) && room.draft) {
        setForumDraft(activeScope.type, activeScope.key, room.draft);
        setContent((current) => current || room.draft);
      }
      if (!getForumScroll(activeScope.type, activeScope.key) && room.scroll_offset) {
        setForumScroll(activeScope.type, activeScope.key, room.scroll_offset);
      }
    });
    return () => { cancelled = true; };
  }, [activeScope.type, activeScope.key, user?.id]);

  const { data: serverUnread } = useQuery({
    queryKey: ["forum-unread", user?.id],
    queryFn: async () => {
      if (!user?.id || readMobileTestSession()) return [];
      const { data, error } = await (supabase as any).rpc("get_my_forum_unread");
      if (error) return [];
      return (data || []) as Array<{ scope_type: string; scope_key: string; has_unread: boolean }>;
    },
    enabled: !!user?.id,
    staleTime: 20_000,
    refetchInterval: 30_000,
    retry: false,
  });

  useEffect(() => {
    if (!serverUnread?.length) return;
    setUnreadDots(Object.fromEntries(
      serverUnread.filter((room) => room.has_unread).map((room) => [`${room.scope_type}_${room.scope_key}`, true]),
    ));
  }, [serverUnread]);

  /* ─── Helper: enrich raw posts with profiles, polls, replies, reactions ─── */
  const enrichPosts = useCallback(async (postsData: any[]) => {
    if (!postsData?.length) return [];
    const postIds = postsData.map((p: any) => p.id);
    const authorIds = [...new Set(postsData.map((p: any) => p.author_id))] as string[];

    const [{ data: profiles }, { data: polls }, { data: replies }, { data: reactions }] = await Promise.all([
      supabase.from("profiles").select("user_id, name, avatar_url, iit_name, student_status, slug").in("user_id", authorIds),
      supabase.from("polls").select("*").in("post_id", postIds),
      supabase.from("posts").select("id, reply_to_id").in("reply_to_id", postIds).is("deleted_at", null),
      supabase.from("reactions").select("*").in("entity_id", postIds).eq("entity_type", "forum_msg"),
    ]);

    const pMap = new Map(profiles?.map((p) => [p.user_id, p]) ?? []);
    const pollMap = new Map(polls?.map((p: any) => [p.post_id, p]) ?? []);
    const replyCountMap = new Map<string, number>();
    (replies as any[])?.forEach((r: any) => replyCountMap.set(r.reply_to_id, (replyCountMap.get(r.reply_to_id) || 0) + 1));
    const reactionMap = new Map<string, Record<string, string[]>>();
    (reactions as any[])?.forEach((r: any) => {
      const map = reactionMap.get(r.entity_id) || {};
      const emoji = r.emoji || "👍";
      if (!map[emoji]) map[emoji] = [];
      map[emoji].push(r.user_id);
      reactionMap.set(r.entity_id, map);
    });

    let userDeletedIds: string[] = [];
    if (user?.id) {
      const { data: deletedRows } = await supabase.from("forum_deleted_for_user" as any)
        .select("post_id").eq("user_id", user.id).in("post_id", postIds);
      userDeletedIds = (deletedRows || []).map((r: any) => r.post_id);
    }

    return postsData
      .filter((post: any) => {
        if (userDeletedIds.includes(post.id)) return false;
        if (post.deleted_for_users && user?.id && (post.deleted_for_users as string[]).includes(user.id)) return false;
        return true;
      })
      .map((post: any) => {
        const rxMap = reactionMap.get(post.id) || {};
        const rxCounts: Record<string, number> = {};
        const myRx: string[] = [];
        Object.entries(rxMap).forEach(([emoji, userIds]) => {
          rxCounts[emoji] = (userIds as string[]).length;
          if ((userIds as string[]).includes(user?.id || "")) myRx.push(emoji);
        });
        return {
          ...post,
          profile: pMap.get(post.author_id) ?? null,
          poll: pollMap.get(post.id) ?? null,
          replyCount: replyCountMap.get(post.id) || 0,
          reactions: rxCounts,
          myReactions: myRx,
        };
      });
  }, [user?.id]);

  /* ─── Posts query with localStorage cache ─── */
  const initialCachedPosts = useMemo(
    () => readMobileTestSession() ? null : getCachedPosts(activeScope.type, activeScope.key, user?.id),
    [activeScope.type, activeScope.key, user?.id],
  );
  const { data: postsData, isLoading } = useQuery({
    queryKey: ["forum-posts", user?.id, activeScope.type, activeScope.key],
    queryFn: async () => {
      // Test accounts are a fully local sandbox. Do not wait for the API or let
      // an unavailable/partially-migrated backend hide the room from testers.
      if (readMobileTestSession()) {
        return {
          posts: [],
          isDemo: true,
          demos: generateScopeDemos(activeScope.type, activeScope.key, activeScopeDef),
        };
      }
      let rawPosts: any[];
      let serverEnriched = true;
      try {
        rawPosts = await fetchForumPage(activeScope.type, activeScope.key, PAGE_SIZE);
      } catch {
        const { data, error } = await buildScopeQuery(activeScope.type, activeScope.key, PAGE_SIZE);
        if (error) throw error;
        rawPosts = (data || []) as any[];
        serverEnriched = false;
      }
      const history = user?.id
        ? await readForumHistory<any>(user.id, activeScope.type, activeScope.key)
        : [];
      if (!rawPosts || rawPosts.length === 0) {
        if (history.length > 0) {
          setCachedPosts(activeScope.type, activeScope.key, history, user?.id);
          return { posts: history, isDemo: false, demos: [] };
        }
        // A real empty room stays empty. Demo conversations are restricted to
        // the explicit mobile test session above so production outages and
        // fresh communities are never disguised as successful data loads.
        return { posts: [], isDemo: false, demos: [] };
      }
      const enriched = (serverEnriched ? rawPosts : await enrichPosts(rawPosts)).reverse();
      const merged = mergeForumHistoryPosts(history, enriched);
      setCachedPosts(activeScope.type, activeScope.key, merged, user?.id);
      if (user?.id) void persistForumHistory(user.id, activeScope.type, activeScope.key, merged);
      if ((rawPosts as any[]).length < PAGE_SIZE) setHasMoreOlder(false);
      return { posts: merged, isDemo: false, demos: [] };
    },
    initialData: initialCachedPosts
      ? { posts: initialCachedPosts, isDemo: false, demos: [] }
      : undefined,
    initialDataUpdatedAt: initialCachedPosts ? 0 : undefined,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // Hydrate deeper browser history without delaying the first paint or waiting
  // for a server response. The latest localStorage snapshot stays synchronous.
  useEffect(() => {
    if (!user?.id || readMobileTestSession()) return;
    let cancelled = false;
    void readForumHistory<any>(user.id, activeScope.type, activeScope.key).then((history) => hydrateForumMediaUrls(history)).then((history) => {
      if (cancelled || history.length === 0) return;
      queryClient.setQueryData(["forum-posts", user.id, activeScope.type, activeScope.key], (current: any) => {
        const merged = mergeForumHistoryPosts(history, current?.posts || []);
        setCachedPosts(activeScope.type, activeScope.key, merged, user.id);
        return { ...current, posts: merged, isDemo: false, demos: [] };
      });
    });
    return () => { cancelled = true; };
  }, [activeScope.type, activeScope.key, queryClient, user?.id]);

  // Merge older pages on top
  const posts = useMemo(() => {
    if (!postsData) return undefined;
    const base = postsData.isDemo ? postsData.demos : [...olderPages, ...(postsData.posts || [])];
    const persisted = readMobileTestSession() ? [...base, ...testRoomPosts.filter((post) => !post.reply_to_id)] : base;
    const roomOutbox = outboxPosts.filter((post) =>
      post.scope_type === activeScope.type && post.scope_key === activeScope.key && !post.reply_to_id
    );
    const linked = deepLinkedPost?.scope_type === activeScope.type && deepLinkedPost?.scope_key === activeScope.key
      && ![...persisted, ...roomOutbox].some((post) => post.id === deepLinkedPost.id)
      ? [deepLinkedPost]
      : [];
    return sortPostsChronologically([...persisted, ...roomOutbox, ...linked]);
  }, [postsData, olderPages, testRoomPosts, outboxPosts, activeScope.type, activeScope.key, deepLinkedPost]);
  const isEmptyChannel = !!postsData && !postsData.isDemo && (posts?.length || 0) === 0;

  const getCurrentSendSnapshot = (): ForumSendSnapshot => ({
    scopeType: activeScope.type,
    scopeKey: activeScope.key,
    content,
    isAnonymous,
    replyToId: replyTo?.id || null,
    imageFingerprint: imageFile
      ? `${imageFile.name}:${imageFile.size}:${imageFile.lastModified}`
      : null,
    fileFingerprint: attachedFile
      ? `${attachedFile.name}:${attachedFile.size}:${attachedFile.lastModified}`
      : null,
    pollQuestion,
    pollOptions,
  });

  const resolveCurrentSendIdentity = () => {
    const identity = resolveForumSendIdentity(sendIdentityRef.current, getCurrentSendSnapshot());
    sendIdentityRef.current = identity;
    return identity;
  };

  const buildCurrentOutboxItem = (): ForumOutboxItem | undefined => {
    if (!user) return undefined;
    const identity = resolveCurrentSendIdentity();
    return {
      id: identity.id, userId: user.id, scopeType: activeScope.type, scopeKey: activeScope.key,
      content: content.trim(), isAnonymous, replyToId: replyTo?.id || null,
      createdAt: new Date().toISOString(), attempts: 0, nextAttemptAt: Date.now() + 30_000,
      image: imageFile ? { blob: imageFile, name: imageFile.name, type: imageFile.type, lastModified: imageFile.lastModified } : null,
      file: attachedFile ? { blob: attachedFile, name: attachedFile.name, type: attachedFile.type, lastModified: attachedFile.lastModified } : null,
      pollQuestion: showPollCreator ? pollQuestion : "", pollOptions: showPollCreator ? pollOptions : [],
    };
  };


  // Track new message arrivals for pill
  useEffect(() => {
    if (!posts) return;
    const currentCount = posts.length;
    if (prevPostCountRef.current > 0 && currentCount > prevPostCountRef.current) {
      const el = scrollContainerRef.current;
      if (el) {
        if (shouldFollowLiveRef.current) {
          requestAnimationFrame(() => {
            el.scrollTop = el.scrollHeight;
            setNewMsgCount(0);
          });
        } else {
          setNewMsgCount(prev => Math.min(prev + (currentCount - prevPostCountRef.current), 99));
        }
      }
    }
    prevPostCountRef.current = currentCount;
  }, [posts]);

  /* ─── Mutations ─── */
  const createPost = useMutation({
    mutationFn: async (queuedItem?: ForumOutboxItem) => {
      if (!user) { navigate("/auth"); return; }
      if (slowModeEnabled && !isAdmin) {
        const now = Date.now();
        const elapsed = (now - lastPostTime) / 1000;
        if (elapsed < slowModeSeconds) {
          const remaining = Math.ceil(slowModeSeconds - elapsed);
          setSlowModeCooldown(remaining);
          throw new Error(`Slow mode: wait ${remaining}s`);
        }
      }
      if (!queuedItem && !content.trim() && !imageFile && !showPollCreator && !attachedFile) throw new Error("Please type a message");

      const sendIdentity = queuedItem
        ? { id: queuedItem.id, fingerprint: forumSendFingerprint({
            scopeType: queuedItem.scopeType, scopeKey: queuedItem.scopeKey, content: queuedItem.content,
            isAnonymous: queuedItem.isAnonymous, replyToId: queuedItem.replyToId,
            imageFingerprint: queuedItem.image ? `${queuedItem.image.name}:${queuedItem.image.blob.size}:${queuedItem.image.lastModified || 0}` : null,
            fileFingerprint: queuedItem.file ? `${queuedItem.file.name}:${queuedItem.file.blob.size}:${queuedItem.file.lastModified || 0}` : null,
            pollQuestion: queuedItem.pollQuestion || "", pollOptions: queuedItem.pollOptions || [],
          }) }
        : resolveCurrentSendIdentity();

      const testSession = readMobileTestSession();
      if (testSession) {
        const localPost = {
          id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          community_id: "test", scope_type: activeScope.type, scope_key: activeScope.key,
          channel: activeScope.type.toLowerCase().replace(/_/g, "-"),
          content: content.trim() || (imageFile ? "📷 Test image" : attachedFile ? `📎 ${attachedFile.name}` : `📊 ${pollQuestion}`),
          is_anonymous: isAnonymous, author_id: user.id, created_at: new Date().toISOString(),
          image_url: imagePreview, file_url: null, file_name: attachedFile?.name || null,
          file_size: attachedFile?.size || null, file_type: attachedFile?.type || null,
          reply_to_id: replyTo?.id || null, deleted_at: null, is_deleted_for_everyone: false,
          seen_by: [], edited_at: null, pinned_at: null,
          profile: { name: testSession.name || profile?.name || "Test User", avatar_url: null, slug: null },
          poll: showPollCreator && pollQuestion.trim() ? {
            id: `test-poll-${Date.now()}`, question: pollQuestion.trim(),
            options: pollOptions.filter((option) => option.trim()), votes: [],
          } : null,
          replyCount: 0, reactions: {}, myReactions: [],
        };
        return { localPost, serverPost: null, scopeType: activeScope.type, scopeKey: activeScope.key, sendIdentity };
      }

      const deliveryItem = queuedItem || buildCurrentOutboxItem();
      if (!deliveryItem) throw new Error("Message could not be prepared for delivery");
      await putForumOutboxItem(deliveryItem);
      try {
        const serverPost = await publishForumOutboxItem(deliveryItem);
        await deleteForumOutboxItem(deliveryItem.id);
        return {
          localPost: null,
          serverPost: { ...serverPost, profile: deliveryItem.isAnonymous ? null : profile },
          scopeType: deliveryItem.scopeType,
          scopeKey: deliveryItem.scopeKey,
          sendIdentity: { id: deliveryItem.id, fingerprint: sendIdentity.fingerprint },
        };
      } catch (error) {
        await markForumOutboxFailed(deliveryItem, error);
        throw error;
      }
    },
    onMutate: async (queuedItem?: ForumOutboxItem) => {
      if (!user) return { pendingId: null };
      const sendIdentity = queuedItem
        ? { id: queuedItem.id, fingerprint: "queued" }
        : resolveCurrentSendIdentity();
      if (queuedItem && !readMobileTestSession()) await putForumOutboxItem(queuedItem);
      const pendingId = `outbox-${sendIdentity.id}`;
      setOutboxPosts((current) => [...current.filter((post) => post.send_identity_id !== sendIdentity.id), {
        id: pendingId,
        send_identity_id: sendIdentity.id,
        community_id: "outbox", scope_type: queuedItem?.scopeType || activeScope.type, scope_key: queuedItem?.scopeKey || activeScope.key,
        channel: (queuedItem?.scopeType || activeScope.type).toLowerCase().replace(/_/g, "-"),
        content: queuedItem?.content || content.trim() || (imageFile ? "📷 Sending image…" : attachedFile ? `📎 ${attachedFile.name}` : `📊 ${pollQuestion}`),
        is_anonymous: queuedItem?.isAnonymous ?? isAnonymous, author_id: user.id, created_at: queuedItem?.createdAt || new Date().toISOString(),
        image_url: imagePreview, file_url: null, file_name: queuedItem?.file?.name || attachedFile?.name || null,
        reply_to_id: queuedItem?.replyToId ?? replyTo?.id ?? null, deleted_at: null, is_deleted_for_everyone: false,
        seen_by: [], edited_at: null, pinned_at: null,
        profile: (queuedItem?.isAnonymous ?? isAnonymous) ? null : profile,
        poll: null, replyCount: 0, reactions: {}, myReactions: [], is_pending: true,
      }]);
      requestAnimationFrame(() => scrollContainerRef.current?.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: "smooth",
      }));
      return { pendingId, sendIdentity };
    },
    onSuccess: (result, _variables, context) => {
      if (result?.localPost) {
        setTestRoomPosts(appendForumTestPost(
          result.scopeType, result.scopeKey, result.localPost,
        ));
      } else if (result?.serverPost && !result.serverPost.reply_to_id) {
        queryClient.setQueryData(
          ["forum-posts", user?.id, result.scopeType, result.scopeKey],
          (current: any) => {
            const existing = current?.posts || [];
            const nextPosts = acknowledgeForumPost(existing, result.serverPost, MAX_ROOM_HISTORY);
            setCachedPosts(result.scopeType, result.scopeKey, nextPosts, user?.id);
            if (user?.id) void persistForumHistory(user.id, result.scopeType, result.scopeKey, nextPosts);
            return { ...current, posts: nextPosts, isDemo: false, demos: [] };
          },
        );
      } else if (result?.serverPost?.reply_to_id) {
        const parentId = result.serverPost.reply_to_id;
        queryClient.setQueryData(["thread-replies", parentId], (current: any) => {
          if (!current?.pages) return current;
          const pages = current.pages.map((page: any[]) => page.filter((reply) => reply.id !== result.serverPost.id));
          pages[0] = [result.serverPost, ...(pages[0] || [])].sort((left: any, right: any) =>
            String(right.created_at).localeCompare(String(left.created_at)) || String(right.id).localeCompare(String(left.id)));
          return { ...current, pages };
        });
        queryClient.setQueriesData({ queryKey: ["forum-posts"] }, (current: any) => current?.posts ? {
          ...current,
          posts: current.posts.map((post: any) => post.id === parentId
            ? { ...post, replyCount: Math.max(post.replyCount || 0, (post.replyCount || 0) + 1) }
            : post),
        } : current);
      }
      if (context?.pendingId) {
        setOutboxPosts((current) => current.filter((post) => post.id !== context.pendingId));
      }
      if (result?.sendIdentity?.id) void deleteForumOutboxItem(result.sendIdentity.id);
      if (result?.sendIdentity && sendIdentityRef.current?.id === result.sendIdentity.id) {
        sendIdentityRef.current = null;
      }
      // Do not erase a second message the user typed while the first send was
      // awaiting its server acknowledgement.
      if (!result?.sendIdentity || forumSendFingerprint(getCurrentSendSnapshot()) === result.sendIdentity.fingerprint) {
        setContent(""); setIsAnonymous(false); setImageFile(null); setImagePreview(null);
        setForumDraft(activeScope.type, activeScope.key, "");
        setShowPollCreator(false); setPollQuestion(""); setPollOptions(["", ""]); setReplyTo(null);
        setAttachedFile(null); setShowAttachMenu(false); setShowFormatBar(false);
      }
      setLastPostTime(Date.now());
      if (slowModeEnabled && !isAdmin) setSlowModeCooldown(slowModeSeconds);
      setTimeout(() => scrollContainerRef.current?.scrollTo({ top: scrollContainerRef.current.scrollHeight, behavior: "smooth" }), 300);
    },
    onError: (err: any, queuedItem, context) => {
      if (context?.pendingId) {
        setOutboxPosts((current) => current.map((post) => post.id === context.pendingId
          ? { ...post, is_pending: false, is_failed: true }
          : post));
      }
      if (err?.code === "42501" || /row-level security|permission denied/i.test(err?.message || "")) {
        toast.error("Your verified community access is still syncing. Refresh once, then try again.");
        void queryClient.invalidateQueries({ queryKey: ["canonical-academic-identity", user?.id] });
        return;
      }
      const message = String(err?.message || "");
      if (/poll options|question before sending/i.test(message)) {
        toast.error(message);
        return;
      }
      toast.error(navigator.onLine
        ? "Message could not be saved right now. Tap the failed message to retry."
        : "You are offline. Your message is saved and will retry automatically.");
    },
  });
  const createPostRef = useRef(createPost);
  createPostRef.current = createPost;

  useEffect(() => {
    if (!user?.id || readMobileTestSession()) return;
    let disposed = false;
    const syncOutbox = async () => {
      const queued = await listForumOutboxItems(user.id);
      if (disposed) return;
      const activeIds = new Set(queued.map((item) => item.id));
      outboxPreviewUrlsRef.current.forEach((url, id) => {
        if (!activeIds.has(id)) { URL.revokeObjectURL(url); outboxPreviewUrlsRef.current.delete(id); }
      });
      setOutboxPosts(queued.map((item) => ({
        id: `outbox-${item.id}`, send_identity_id: item.id, community_id: "outbox",
        scope_type: item.scopeType, scope_key: item.scopeKey, content: item.content || "Queued attachment",
        is_anonymous: item.isAnonymous, author_id: item.userId, created_at: item.createdAt,
        image_url: item.image ? (() => {
          const cached = outboxPreviewUrlsRef.current.get(item.id);
          if (cached) return cached;
          const created = URL.createObjectURL(item.image.blob);
          outboxPreviewUrlsRef.current.set(item.id, created);
          return created;
        })() : item.imageUrl,
        file_name: item.file?.name || null, reply_to_id: item.replyToId,
        profile: item.isAnonymous ? null : profile, replyCount: 0, reactions: {}, myReactions: [],
        is_pending: !item.lastError, is_failed: !!item.lastError,
      })));
      const due = queued.find((item) => item.nextAttemptAt <= Date.now());
      if (due && navigator.onLine && !createPostRef.current.isPending && !processingOutboxRef.current) {
        processingOutboxRef.current = true;
        createPostRef.current.mutate(due, { onSettled: () => { processingOutboxRef.current = false; } });
      }
    };
    void syncOutbox();
    const unsubscribe = subscribeForumOutbox(() => void syncOutbox());
    const retryTimer = window.setInterval(() => void syncOutbox(), 5_000);
    window.addEventListener("online", syncOutbox);
    return () => {
      disposed = true; unsubscribe(); window.clearInterval(retryTimer); window.removeEventListener("online", syncOutbox);
    };
  }, [user?.id, profile]);

  useEffect(() => () => {
    outboxPreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    outboxPreviewUrlsRef.current.clear();
  }, []);

  const retryOutboxPost = async (post: any) => {
    if (!user?.id || processingOutboxRef.current) return;
    const queued = await listForumOutboxItems(user.id);
    const item = queued.find((entry) => entry.id === post.send_identity_id);
    if (!item) return;
    processingOutboxRef.current = true;
    createPost.mutate({ ...item, nextAttemptAt: 0 }, { onSettled: () => { processingOutboxRef.current = false; } });
  };

  const editPost = useMutation({
    mutationFn: async () => {
      if (!user || !editingPost || !editContent.trim()) return;
      if (isDemoId(editingPost.id)) { toast("This is a demo message"); return; }
      const { error } = await supabase.from("posts")
        .update({ content: editContent.trim(), edited_at: new Date().toISOString() } as any)
        .eq("id", editingPost.id);
      if (error) throw new Error("Could not edit message");
    },
    onSuccess: () => {
      setEditingPost(null); setEditContent("");
      queryClient.invalidateQueries({ queryKey: ["forum-posts"] });
      toast.success("Message edited");
    },
    onError: (err: any) => toast.error(err.message),
  });

  const deletePost = useMutation({
    mutationFn: async ({ postId, forEveryone }: { postId: string; forEveryone: boolean }) => {
      if (!user) return;
      if (isDemoId(postId)) { toast("This is a demo message"); return; }
      if (forEveryone) {
        const { error } = await supabase.from("posts")
          .update({ is_deleted_for_everyone: true } as any)
          .eq("id", postId);
        if (error) {
          if (error.message.includes("3 minutes")) throw new Error("Cannot delete for everyone after 3 minutes");
          if (error.message.includes("sender")) throw new Error("Only the sender can delete for everyone");
          throw new Error("Could not delete message");
        }
      } else {
        const { error } = await supabase.from("forum_deleted_for_user" as any)
          .upsert({ post_id: postId, user_id: user.id }, { onConflict: "post_id,user_id" });
        if (error) {
          if (error.message?.includes("duplicate")) return;
          throw new Error("Could not hide message");
        }
      }
    },
    onSuccess: (_data, { postId }) => {
      setOlderPages((current) => current.filter((post) => post.id !== postId));
      if (deepLinkedPost?.id === postId) setDeepLinkedPost(null);
      queryClient.invalidateQueries({ queryKey: ["forum-posts"] });
      queryClient.invalidateQueries({ queryKey: ["user-deleted-messages"] });
      toast.success("Message removed");
    },
    onError: (err: any) => toast.error(err.message),
  });

  const toggleReaction = useMutation({
    mutationFn: async ({ postId, emoji }: { postId: string; emoji: string }) => {
      if (!user) throw new Error("Please sign in to react");
      if (isDemoId(postId)) { toast("This is a demo message"); return; }
      const { data: existing } = await supabase.from("reactions")
        .select("id").eq("entity_id", postId).eq("user_id", user.id).eq("entity_type", "forum_msg").eq("emoji", emoji).maybeSingle();
      if (existing) {
        await supabase.from("reactions").delete().eq("id", existing.id);
      } else {
        const { error } = await supabase.from("reactions").insert({ entity_id: postId, entity_type: "forum_msg", user_id: user.id, emoji });
        if (error) throw new Error("Could not add reaction");
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["forum-posts"] }),
    onError: (err: any) => toast.error(err.message),
  });

  const toggleUserPin = useMutation({
    mutationFn: async (postId: string) => {
      if (!user) return;
      if (isDemoId(postId)) { toast("This is a demo message"); return; }
      const isPinned = userPinnedIds.includes(postId);
      if (isPinned) {
        await supabase.from("user_pinned_messages").delete().eq("user_id", user.id).eq("message_id", postId);
      } else {
        await supabase.from("user_pinned_messages").insert({
          user_id: user.id, message_id: postId,
          forum_scope_type: activeScope.type, forum_scope_key: activeScope.key,
        });
      }
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["user-pins"] }); toast.success("Pin updated"); },
    onError: () => toast.error("Could not update pin"),
  });

  const toggleAdminPin = useMutation({
    mutationFn: async (postId: string) => {
      if (!isAdmin) return;
      if (isDemoId(postId)) { toast("This is a demo message"); return; }
      const post = posts?.find((p: any) => p.id === postId);
      const newPinned = post?.pinned_at ? null : new Date().toISOString();
      await supabase.from("posts").update({ pinned_at: newPinned } as any).eq("id", postId);
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["forum-posts"] }); toast.success("Pin updated"); },
  });

  /* ─── Realtime: subscribe only to the open room ─── */
  useEffect(() => {
    if (readMobileTestSession() || !realtimeActive) return;
    const filter = `scope_identity=eq.${activeScope.type}:${activeScope.key}`;
    const roomQueryKey = ["forum-posts", user?.id, activeScope.type, activeScope.key] as const;
    const pendingEvents: ForumRealtimeEvent[] = [];
    let flushFrame: number | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let historyPersistTimer: ReturnType<typeof setTimeout> | null = null;
    let latestHistorySnapshot: any[] = [];
    const scheduleHistoryPersistence = (posts: any[]) => {
      if (!user?.id) return;
      latestHistorySnapshot = posts;
      if (historyPersistTimer !== null) clearTimeout(historyPersistTimer);
      historyPersistTimer = setTimeout(() => {
        historyPersistTimer = null;
        void persistForumHistory(user.id, activeScope.type, activeScope.key, latestHistorySnapshot);
      }, 1_200);
    };
    const flushRoomEvents = () => {
      flushFrame = null;
      flushTimer = null;
      if (pendingEvents.length === 0) return;
      const events = pendingEvents.splice(0, pendingEvents.length);
      queryClient.setQueryData(roomQueryKey, (current: any) => {
        if (!current?.posts) return current;
        const enrichedEvents = events.map((event) => event.eventType === "INSERT" && event.new ? {
          ...event,
          new: {
            ...event.new,
            profile: event.new.profile || profileMap.get(event.new.author_id) || null,
            poll: event.new.poll || null,
            replyCount: event.new.replyCount || 0,
            reactions: event.new.reactions || {},
            myReactions: event.new.myReactions || [],
          },
        } : event);
        const nextPosts = applyForumRealtimeBatch(
          current.posts,
          enrichedEvents,
          { type: activeScope.type, key: activeScope.key },
          MAX_ROOM_HISTORY,
        );
        setCachedPosts(activeScope.type, activeScope.key, nextPosts, user?.id);
        scheduleHistoryPersistence(nextPosts);
        return { ...current, posts: nextPosts };
      });
    };
    const applyRoomEvent = (event: ForumRealtimeEvent) => {
      pendingEvents.push(event);
      if (flushFrame !== null || flushTimer !== null) return;
      if (typeof requestAnimationFrame === "function") flushFrame = requestAnimationFrame(flushRoomEvents);
      else flushTimer = setTimeout(flushRoomEvents, 16);
    };
    const applyHydratedRoomEvent = (event: ForumRealtimeEvent) => {
      if (!event.new || (!event.new.image_path && !event.new.file_path && !event.new.voice_path)) {
        applyRoomEvent(event);
        return;
      }
      void hydrateForumMediaUrls([event.new]).then(([post]) => applyRoomEvent({ ...event, new: post }))
        .catch(() => applyRoomEvent(event));
    };
    let fallbackChannel: ReturnType<typeof supabase.channel> | null = null;
    let broadcastChannel: ReturnType<typeof supabase.channel> | null = null;
    let fallbackStarted = false;
    let broadcastHealthy = false;
    let fallbackHealthy = false;
    let fallbackRestartTimer: ReturnType<typeof setTimeout> | null = null;
    let recoveryController: ReturnType<typeof createRealtimeRecoveryController> | null = null;
    let unsubscribeAppSync: (() => void) | null = null;
    let disposed = false;
    const recoverMissedMessages = async () => {
      if (disposed) return;
      const current = queryClient.getQueryData<any>(roomQueryKey);
      const latest = [...(current?.posts || [])].reverse().find((post: any) =>
        post?.created_at && !isDemoId(post.id));
      let query = supabase.from("posts")
        .select(LEGACY_FORUM_POST_COLUMNS)
        .eq("scope_type", activeScope.type)
        .eq("scope_key", activeScope.key)
        .is("reply_to_id", null)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(latest ? MAX_ROOM_HISTORY : PAGE_SIZE) as any;
      if (latest?.created_at) query = query.gte("created_at", latest.created_at);
      const { data, error } = await query;
      if (disposed || error || !data?.length) return;
      const enriched = await hydrateForumMediaUrls(await enrichPosts(data as any[]));
      enriched.forEach((post) => applyRoomEvent({ eventType: "INSERT", new: post }));
      flushRoomEvents();
    };
    function scheduleFallbackRestart() {
      if (disposed || fallbackRestartTimer !== null) return;
      fallbackHealthy = false;
      const previous = fallbackChannel;
      fallbackChannel = null;
      fallbackStarted = false;
      if (previous) void supabase.removeChannel(previous);
      fallbackRestartTimer = setTimeout(() => {
        fallbackRestartTimer = null;
        startPostgresFallback();
      }, 1_500);
    }
    function startPostgresFallback() {
      if (fallbackStarted || disposed) return;
      fallbackStarted = true;
      const channel = supabase.channel(`forum-pg-${activeScope.type}-${activeScope.key}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts', filter }, (payload: any) => {
        applyHydratedRoomEvent({ eventType: "INSERT", new: payload.new || {} });
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'posts', filter }, (payload: any) => {
        applyHydratedRoomEvent({ eventType: "UPDATE", new: payload.new || {} });
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'posts', filter }, (payload: any) => {
        applyRoomEvent({ eventType: "DELETE", old: payload.old || {} });
      })
      .subscribe((status) => {
        if (disposed || fallbackChannel !== channel) return;
        if (status === "SUBSCRIBED") {
          fallbackHealthy = true;
          void (recoveryController?.recoverNow() || recoverMissedMessages());
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          scheduleFallbackRestart();
        }
      });
      fallbackChannel = channel;
    }

    recoveryController = createRealtimeRecoveryController({
      recover: recoverMissedMessages,
      ensureConnected: () => {
        if (!broadcastHealthy && !fallbackHealthy) startPostgresFallback();
      },
    });

    // The archived AppSync compatibility branch stays disabled in production.
    // Socket.IO provides fan-out; MySQL remains the durable history for recovery.
    if (appSyncRealtimeEnabled) void (async () => {
      const channels = await getForumAppSyncChannels(activeScope.type, activeScope.key);
      if (disposed) return;
      unsubscribeAppSync = subscribeAppSync(channels.message_channel, (event: any) => {
        const eventType = String(event.eventType || "INSERT") as ForumRealtimeEvent["eventType"];
        if (eventType === "DELETE") applyRoomEvent({ eventType, old: event.old || {} });
        else applyHydratedRoomEvent({ eventType, new: event.new || {} });
      }, (status) => {
        if (disposed) return;
        if (status === "SUBSCRIBED") {
          broadcastHealthy = true;
          void (recoveryController?.recoverNow() || recoverMissedMessages());
        } else if (status === "CHANNEL_ERROR" || status === "CLOSED") {
          broadcastHealthy = false;
          startPostgresFallback();
          void recoveryController?.recoverNow();
        }
      });
    })().catch(() => {
      broadcastHealthy = false;
      startPostgresFallback();
    });
    else void (async () => {
      const { data: broadcastReady } = await (supabase as any).rpc("forum_broadcast_ready");
      if (disposed) return;
      if (broadcastReady !== true) {
        startPostgresFallback();
        return;
      }
      await supabase.realtime.setAuth();
      if (disposed) return;
      broadcastChannel = supabase.channel(`forum:${activeScope.type}:${activeScope.key}`, {
        config: { private: true },
      })
        .on('broadcast', { event: 'INSERT' }, (payload: any) => {
          applyHydratedRoomEvent({ eventType: "INSERT", new: getForumBroadcastRow(payload, "new") || {} });
        })
        .on('broadcast', { event: 'UPDATE' }, (payload: any) => {
          applyHydratedRoomEvent({ eventType: "UPDATE", new: getForumBroadcastRow(payload, "new") || {} });
        })
        .on('broadcast', { event: 'DELETE' }, (payload: any) => {
          applyRoomEvent({ eventType: "DELETE", old: getForumBroadcastRow(payload, "old") || {} });
        })
        .subscribe((status) => {
          if (disposed) return;
          if (status === "SUBSCRIBED") {
            broadcastHealthy = true;
            void (recoveryController?.recoverNow() || recoverMissedMessages());
            return;
          }
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            broadcastHealthy = false;
            startPostgresFallback();
            void recoveryController?.recoverNow();
          }
        });
    })().catch(() => {
      broadcastHealthy = false;
      startPostgresFallback();
    });

    return () => {
      disposed = true;
      recoveryController?.dispose();
      if (fallbackRestartTimer !== null) clearTimeout(fallbackRestartTimer);
      if (flushFrame !== null) cancelAnimationFrame(flushFrame);
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushRoomEvents();
      if (historyPersistTimer !== null) clearTimeout(historyPersistTimer);
      if (user?.id && latestHistorySnapshot.length > 0) {
        void persistForumHistory(user.id, activeScope.type, activeScope.key, latestHistorySnapshot);
      }
      if (broadcastChannel) supabase.removeChannel(broadcastChannel);
      if (fallbackChannel) supabase.removeChannel(fallbackChannel);
      unsubscribeAppSync?.();
    };
  }, [queryClient, activeScope.type, activeScope.key, enrichPosts, profileMap, realtimeActive, user?.id]);


  /* ─── Typing indicator ─── */
  useEffect(() => {
    // Typing fan-out is useful in small cohorts and wasteful in campus/global
    // rooms where thousands of people may be active simultaneously.
    const typingEnabled = activeScope.type === "COHORT" || activeScope.type === "COHORT_GLOBAL";
    if (!user?.id || readMobileTestSession() || !typingEnabled || !realtimeActive) return;
    const typingTimers = remoteTypingTimersRef.current;
    if (appSyncRealtimeEnabled) {
      let disposed = false;
      let unsubscribe: (() => void) | null = null;
      void getForumAppSyncChannels(activeScope.type, activeScope.key).then((channels) => {
        if (disposed) return;
        const handleTyping = (payload: any) => {
          const remoteUserId = payload?.userId;
          const name = payload?.name;
          if (!remoteUserId || remoteUserId === user.id || !name) return;
          setTypingUsers((current) => [...new Set([...current, name])].slice(0, 3));
          const previousTimer = typingTimers.get(remoteUserId);
          if (previousTimer) clearTimeout(previousTimer);
          typingTimers.set(remoteUserId, setTimeout(() => {
            setTypingUsers((current) => current.filter((item) => item !== name));
            typingTimers.delete(remoteUserId);
          }, 2500));
        };
        unsubscribe = subscribeAppSync(channels.typing_channel, handleTyping);
        presenceChannelRef.current = {
          send: ({ payload }: any) => publishAppSync(channels.typing_channel, payload),
        };
      }).catch(() => { /* Message delivery has its own durable fallback. */ });
      return () => {
        disposed = true;
        unsubscribe?.();
        presenceChannelRef.current = null;
        typingTimers.forEach(clearTimeout);
        typingTimers.clear();
        setTypingUsers([]);
      };
    }
    const presenceChannel = supabase.channel(`typing-${activeScope.type}-${activeScope.key}`, {
      config: { broadcast: { self: false } },
    });
    presenceChannelRef.current = presenceChannel;
    presenceChannel
      .on('broadcast', { event: 'typing' }, ({ payload }: any) => {
        const remoteUserId = payload?.userId;
        const name = payload?.name;
        if (!remoteUserId || remoteUserId === user.id || !name) return;
        setTypingUsers((current) => [...new Set([...current, name])].slice(0, 3));
        const previousTimer = typingTimers.get(remoteUserId);
        if (previousTimer) clearTimeout(previousTimer);
        typingTimers.set(remoteUserId, setTimeout(() => {
          setTypingUsers((current) => current.filter((item) => item !== name));
          typingTimers.delete(remoteUserId);
        }, 2500));
      })
      .subscribe();
    return () => {
      if (presenceChannelRef.current === presenceChannel) presenceChannelRef.current = null;
      typingTimers.forEach(clearTimeout);
      typingTimers.clear();
      setTypingUsers([]);
      supabase.removeChannel(presenceChannel);
    };
  }, [user?.id, activeScope.type, activeScope.key, realtimeActive]);

  const broadcastTyping = useCallback(() => {
    if (!user?.id || !profile?.name) return;
    const ch = presenceChannelRef.current;
    if (!ch) return;
    const now = Date.now();
    if (now - typingLastSentRef.current < 1500) return;
    typingLastSentRef.current = now;
    void ch.send({
      type: 'broadcast',
      event: 'typing',
      payload: { userId: user.id, name: profile.name },
    });
  }, [user?.id, profile?.name]);

  // Auto-scroll on initial load
  useEffect(() => {
    if (posts && posts.length > 0 && !hasScrolledRef.current && scrollContainerRef.current) {
      const savedOffset = getForumScroll(activeScope.type, activeScope.key);
      scrollContainerRef.current.scrollTop = savedOffset || scrollContainerRef.current.scrollHeight;
      hasScrolledRef.current = true;
    }
  }, [posts, activeScope.type, activeScope.key]);
  useEffect(() => { hasScrolledRef.current = false; }, [activeScope.type, activeScope.key]);

  const dismissKeyboard = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) active.blur();
  }, []);

  const dismissComposerOverlays = useCallback(() => {
    dismissKeyboard();
    setShowAttachMenu(false);
    setShowGifPicker(false);
    setShowFormatBar(false);
    setShowMentionSuggestions(false);
  }, [dismissKeyboard]);

  const loadOlderMessages = useCallback(async () => {
    const el = scrollContainerRef.current;
    if (!el || olderPageRequestRef.current || !hasMoreOlder || !posts?.length) return;
    olderPageRequestRef.current = true;
    try {
      const oldestReal = posts.find((p: any) => !isDemoId(p.id));
      if (!oldestReal) {
        setHasMoreOlder(false);
        return;
      }
      setLoadingOlder(true);
      const prevHeight = el.scrollHeight;
      try {
        let olderArr: any[];
        let serverEnriched = true;
        try {
          olderArr = await fetchForumPage(activeScope.type, activeScope.key, PAGE_SIZE, {
            createdAt: oldestReal.created_at, id: oldestReal.id,
          });
        } catch {
          const { data, error } = await buildScopeQuery(activeScope.type, activeScope.key, PAGE_SIZE, {
            createdAt: oldestReal.created_at, id: oldestReal.id,
          });
          if (error) throw error;
          olderArr = (data || []) as any[];
          serverEnriched = false;
        }
        if (olderArr.length === 0) {
          setHasMoreOlder(false);
        } else {
          const enriched = (serverEnriched ? olderArr : await enrichPosts(olderArr)).reverse();
          setOlderPages(prev => mergeForumHistoryPosts(enriched, prev));
          if (user?.id) void persistForumHistory(user.id, activeScope.type, activeScope.key, enriched);
          if (olderArr.length < PAGE_SIZE) setHasMoreOlder(false);
          // Preserve scroll position
          requestAnimationFrame(() => {
            const newHeight = el.scrollHeight;
            el.scrollTop = newHeight - prevHeight + el.scrollTop;
          });
        }
      } catch {
        setHasMoreOlder(false);
      } finally {
        setLoadingOlder(false);
      }
    } finally {
      olderPageRequestRef.current = false;
    }
  }, [hasMoreOlder, posts, activeScope.type, activeScope.key, enrichPosts, user?.id]);

  const handleScroll = useCallback(() => {
    // Mobile browsers can emit well over 60 scroll events per second. Keep all
    // React work and pagination checks to one animation-frame callback.
    if (scrollWorkFrameRef.current !== null) return;
    scrollWorkFrameRef.current = requestAnimationFrame(() => {
      scrollWorkFrameRef.current = null;
      const el = scrollContainerRef.current;
      if (!el) return;
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      shouldFollowLiveRef.current = distFromBottom < 120;
      const shouldShowScrollDown = distFromBottom > 100;
      setShowScrollDown((current) => current === shouldShowScrollDown ? current : shouldShowScrollDown);
      if (distFromBottom < 50) setNewMsgCount((current) => current === 0 ? current : 0);

      // Save only after scrolling settles. Synchronous localStorage writes in a
      // scroll handler are visible as dropped frames on iOS and slower Androids.
      if (scrollSaveTimerRef.current !== null) clearTimeout(scrollSaveTimerRef.current);
      const offset = el.scrollTop;
      scrollSaveTimerRef.current = setTimeout(() => {
        scrollSaveTimerRef.current = null;
        setForumScroll(activeScope.type, activeScope.key, offset);
      }, 250);

      // Fire pagination once per visit to the top threshold. Cached IndexedDB
      // history is already merged before this point, so the server is contacted
      // only when the member reaches beyond locally available history.
      if (el.scrollTop > 280) olderPageTriggerArmedRef.current = true;
      if (el.scrollTop < 100 && olderPageTriggerArmedRef.current) {
        olderPageTriggerArmedRef.current = false;
        void loadOlderMessages();
      }
    });
  }, [activeScope.type, activeScope.key, loadOlderMessages]);


  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && (content.trim() || imageFile || attachedFile)) {
      e.preventDefault();
      const item = buildCurrentOutboxItem();
      if (item) createPost.mutate(item);
    }
  };

  // Auto-grow textarea
  const handleContentChange = (value: string) => {
    setContent(value);
    setForumDraft(activeScope.type, activeScope.key, value);
    broadcastTyping();

    // Auto-resize textarea
    if (textareaRef.current) {
      textareaRef.current.style.height = '40px';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 96) + 'px';
    }

    const lastAt = value.lastIndexOf("@");
    if (lastAt !== -1) {
      const afterAt = value.slice(lastAt + 1);
      const spaceIdx = afterAt.indexOf(" ");
      if (spaceIdx === -1 && afterAt.length > 0) {
        setMentionQuery(afterAt.toLowerCase());
        setShowMentionSuggestions(true);
        return;
      }
    }
    setShowMentionSuggestions(false);
  };

  const insertMention = (name: string) => {
    const lastAt = content.lastIndexOf("@");
    if (lastAt !== -1) setContent(content.slice(0, lastAt) + `@${name} `);
    setShowMentionSuggestions(false);
    textareaRef.current?.focus();
  };

  const insertEmoji = (emoji: string) => {
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? content.length;
    const end = ta?.selectionEnd ?? content.length;
    const next = content.slice(0, start) + emoji + content.slice(end);
    setContent(next);
    setForumDraft(activeScope.type, activeScope.key, next);
    setShowGifPicker(false);
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  };

  const insertFormatting = (wrapper: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = content.slice(start, end);
    const newContent = content.slice(0, start) + wrapper + (selected || "text") + wrapper + content.slice(end);
    setContent(newContent);
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(start + wrapper.length, start + wrapper.length + (selected || "text").length);
    }, 0);
  };

  const mentionSuggestions = useMemo(() => {
    if (!showMentionSuggestions || !mentionQuery) return [];
    return (scopeMembers || []).filter((m: any) => m.name?.toLowerCase().includes(mentionQuery)).slice(0, 5);
  }, [showMentionSuggestions, mentionQuery, scopeMembers]);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast.error("Image must be under 5MB"); return; }
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
    setShowAttachMenu(false);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { toast.error("File must be under 20MB"); return; }
    setAttachedFile(file);
    setShowAttachMenu(false);
  };

  const handleReply = (post: any) => { setThreadPost(post); setShowGifPicker(false); };

  const handleGifSelect = async (gifUrl: string) => {
    if (!user) return;
    setShowGifPicker(false);
    try {
      const { data: newPost, error } = await supabase.from("posts").insert({
        id: crypto.randomUUID(),
        community_id: "default", scope_type: activeScope.type, scope_key: activeScope.key,
        channel: activeScope.type.toLowerCase().replace(/_/g, "-"),
        content: "GIF", is_anonymous: isAnonymous, author_id: user.id,
        image_url: gifUrl, reply_to_id: replyTo?.id || null,
      }).select("*").single();
      if (error || !newPost) throw error;
      queryClient.setQueryData(
        ["forum-posts", user.id, activeScope.type, activeScope.key],
        (current: any) => {
          const nextPosts = acknowledgeForumPost(current?.posts || [], {
            ...newPost,
            profile: isAnonymous ? null : profile,
            replyCount: 0,
            reactions: {},
            myReactions: [],
          }, MAX_ROOM_HISTORY);
          setCachedPosts(activeScope.type, activeScope.key, nextPosts, user.id);
          void persistForumHistory(user.id, activeScope.type, activeScope.key, nextPosts);
          return { ...current, posts: nextPosts, isDemo: false, demos: [] };
        },
      );
      setReplyTo(null); setIsAnonymous(false);
      setTimeout(() => scrollContainerRef.current?.scrollTo({ top: scrollContainerRef.current.scrollHeight, behavior: "smooth" }), 300);
    } catch {
      toast.error("Failed to send GIF");
    }
  };

  const handleVoiceSend = async (voiceUrl: string, duration: number, voicePath?: string) => {
    if (!user) return;
    const testSession = readMobileTestSession();
    if (testSession) {
      const localPost = {
        id: `test-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        community_id: "test", scope_type: activeScope.type, scope_key: activeScope.key,
        channel: activeScope.type.toLowerCase().replace(/_/g, "-"),
        content: "🎤 Voice message", is_anonymous: isAnonymous, author_id: user.id,
        created_at: new Date().toISOString(), voice_url: voiceUrl, voice_duration: duration,
        image_url: null, file_url: null, reply_to_id: replyTo?.id || null,
        deleted_at: null, is_deleted_for_everyone: false, seen_by: [], edited_at: null, pinned_at: null,
        profile: isAnonymous ? null : { name: testSession.name || profile?.name || "Test User", avatar_url: null, slug: null },
        poll: null, replyCount: 0, reactions: {}, myReactions: [],
      };
      setTestRoomPosts(appendForumTestPost(activeScope.type, activeScope.key, localPost));
      setIsRecordingVoice(false);
      setReplyTo(null); setIsAnonymous(false);
      requestAnimationFrame(() => scrollContainerRef.current?.scrollTo({ top: scrollContainerRef.current.scrollHeight, behavior: "smooth" }));
      return;
    }

    try {
      const queued: ForumOutboxItem = {
        id: crypto.randomUUID(), userId: user.id, scopeType: activeScope.type, scopeKey: activeScope.key,
        content: "🎤 Voice message", isAnonymous, replyToId: replyTo?.id || null,
        voiceUrl, voicePath: voicePath || null, voiceDuration: duration,
        createdAt: new Date().toISOString(), attempts: 0, nextAttemptAt: Date.now() + 30_000,
      };
      await putForumOutboxItem(queued);
      const newPost = await publishForumOutboxItem(queued);
      await deleteForumOutboxItem(queued.id);
      queryClient.setQueryData(
        ["forum-posts", user?.id, activeScope.type, activeScope.key],
        (current: any) => {
          const existing = current?.posts || [];
          if (!newPost) return current;
          const nextPosts = acknowledgeForumPost(existing, {
            ...newPost, voice_url: voiceUrl, profile: isAnonymous ? null : profile, replyCount: 0, reactions: {}, myReactions: [],
          }, MAX_ROOM_HISTORY);
          setCachedPosts(activeScope.type, activeScope.key, nextPosts, user?.id);
          if (user?.id) void persistForumHistory(user.id, activeScope.type, activeScope.key, nextPosts);
          return {
            ...current,
            posts: nextPosts,
            isDemo: false,
            demos: [],
          };
        },
      );
      setIsRecordingVoice(false);
      setReplyTo(null); setIsAnonymous(false);
      setTimeout(() => scrollContainerRef.current?.scrollTo({ top: scrollContainerRef.current.scrollHeight, behavior: "smooth" }), 300);
    } catch {
      throw new Error("The recording was saved, but the voice message could not be published.");
    }
  };

  const handleEdit = (post: any) => { setEditingPost(post); setEditContent(post.content); };
  const handleCopy = (text: string) => { navigator.clipboard.writeText(text); toast.success("Copied!"); };
  const handleThread = (post: any) => { setThreadPost(post); };

  const scrollToMessage = (postId: string) => {
    const el = messageRefs.current[postId];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedPostId(postId);
    setTimeout(() => setHighlightedPostId((current) => current === postId ? null : current), 2000);
  };

  useEffect(() => {
    const requested = searchParams.get("post") || "";
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(requested) || !user?.id) return;
    const clearDeepLink = () => {
      const next = new URLSearchParams(searchParams);
      next.delete("post");
      next.delete("scope_type");
      next.delete("scope_key");
      setSearchParams(next, { replace: true });
    };
    const available = (posts || []).find((post: any) => post.id === requested)
      || (deepLinkedPost?.id === requested ? deepLinkedPost : null);
    if (available) {
      if (available.scope_type !== activeScope.type || available.scope_key !== activeScope.key) {
        setActiveScope({ type: available.scope_type, key: available.scope_key });
        setActiveTab("feed");
        setThreadPost(null);
        return;
      }
      const timer = window.setTimeout(() => {
        if (deepLinkedPost?.id === requested) {
          setOlderPages((current) => current.some((post) => post.id === requested) ? current : [deepLinkedPost, ...current]);
          setDeepLinkedPost(null);
        }
        scrollToMessage(requested);
        clearDeepLink();
      }, 80);
      return () => window.clearTimeout(timer);
    }
    if (deepLinkRequestRef.current === requested) return;
    deepLinkRequestRef.current = requested;
    let cancelled = false;
    void (supabase as any).rpc("get_forum_post", { p_post_id: requested }).then(async ({ data, error }: any) => {
      if (cancelled) return;
      if (error || !data) {
        toast.error("That forum post is no longer available.");
        clearDeepLink();
        return;
      }
      const [hydrated] = await hydrateForumMediaUrls([data.post || data]);
      if (!cancelled && hydrated) setDeepLinkedPost(hydrated);
    }).finally(() => {
      if (deepLinkRequestRef.current === requested) deepLinkRequestRef.current = null;
    });
    return () => { cancelled = true; };
  }, [activeScope.key, activeScope.type, deepLinkedPost, posts, searchParams, setSearchParams, user?.id]);

  const scrollToBottom = () => {
    shouldFollowLiveRef.current = true;
    scrollContainerRef.current?.scrollTo({ top: scrollContainerRef.current.scrollHeight, behavior: "smooth" });
    setNewMsgCount(0);
  };
  const selectScope = (type: string, key: string, keepSidebarOpen = false) => {
    const scrollOffset = scrollContainerRef.current?.scrollTop || 0;
    setForumDraft(activeScope.type, activeScope.key, content);
    setForumScroll(activeScope.type, activeScope.key, scrollOffset);
    if (user?.id && !readMobileTestSession()) {
      void (supabase as any).rpc("save_forum_room_state", {
        p_scope_type: activeScope.type,
        p_scope_key: activeScope.key,
        p_draft: content,
        p_scroll_offset: Math.max(0, Math.round(scrollOffset)),
      });
    }
    setContent(getForumDraft(type, key));
    setActiveScope({ type, key });
    if (user?.id) setLastForumRoom(user.id, { type, key });
    if (!keepSidebarOpen) setSidebarOpen(false);
    setActiveTab("feed");
    setThreadPost(null);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearchQuery(searchQuery.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const { data: serverSearchPosts = [], isFetching: isSearchingServer } = useQuery({
    queryKey: ["forum-search", user?.id, activeScope.type, activeScope.key, debouncedSearchQuery, searchTab],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("search_forum_posts", {
        p_scope_type: activeScope.type, p_scope_key: activeScope.key,
        p_query: debouncedSearchQuery, p_kind: searchTab, p_limit: 100,
        p_before_created_at: null, p_before_id: null,
      });
      if (error) {
        let fallback = sortPostsChronologically(posts || []);
        const query = debouncedSearchQuery.toLowerCase();
        if (query) fallback = fallback.filter((post: any) => post.content?.toLowerCase().includes(query) || post.profile?.name?.toLowerCase().includes(query));
        if (searchTab === "media") fallback = fallback.filter((post: any) => post.image_url || post.voice_url);
        if (searchTab === "links") fallback = fallback.filter((post: any) => /https?:\/\//i.test(post.content || ""));
        if (searchTab === "pins") fallback = fallback.filter((post: any) => post.pinned_at || userPinnedIds.includes(post.id));
        return fallback.slice(-100);
      }
      return hydrateForumMediaUrls((data || []).map((row: any) => row.post || row));
    },
    enabled: !!user?.id && showSearch && !readMobileTestSession(),
    staleTime: 15_000,
  });

  const filteredPosts = useMemo(() => {
    let filtered = sortPostsChronologically(showSearch && !readMobileTestSession() ? serverSearchPosts : (posts || []));
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      switch (searchTab) {
        case "messages": filtered = filtered.filter((p: any) => p.content?.toLowerCase().includes(q) || p.profile?.name?.toLowerCase().includes(q)); break;
        case "media": filtered = filtered.filter((p: any) => p.image_url); break;
        case "pins": filtered = filtered.filter((p: any) => userPinnedIds.includes(p.id) || p.pinned_at); break;
        case "links": filtered = filtered.filter((p: any) => p.content?.match(/https?:\/\//)); break;
      }
    } else if (searchTab !== "messages" && showSearch) {
      switch (searchTab) {
        case "media": filtered = filtered.filter((p: any) => p.image_url); break;
        case "pins": filtered = filtered.filter((p: any) => userPinnedIds.includes(p.id) || p.pinned_at); break;
        case "links": filtered = filtered.filter((p: any) => p.content?.match(/https?:\/\//)); break;
      }
    }
    if (activeTab === "pinned") filtered = filtered.filter((p: any) => userPinnedIds.includes(p.id) || p.pinned_at);
    // Cap at MAX_RENDERED
    if (filtered.length > MAX_RENDERED) filtered = filtered.slice(filtered.length - MAX_RENDERED);
    return sortPostsChronologically(filtered);
  }, [posts, serverSearchPosts, searchQuery, searchTab, showSearch, activeTab, userPinnedIds]);

  const searchCounts = useMemo(() => {
    if (!posts) return { messages: 0, media: 0, pins: 0, links: 0 };
    const q = searchQuery.toLowerCase();
    const matchingPosts = q ? posts.filter((p: any) => p.content?.toLowerCase().includes(q) || p.profile?.name?.toLowerCase().includes(q)) : posts;
    return {
      messages: matchingPosts.length,
      media: posts.filter((p: any) => p.image_url && (!q || p.content?.toLowerCase().includes(q))).length,
      pins: posts.filter((p: any) => (userPinnedIds.includes(p.id) || p.pinned_at) && (!q || p.content?.toLowerCase().includes(q))).length,
      links: posts.filter((p: any) => p.content?.match(/https?:\/\//) && (!q || p.content?.toLowerCase().includes(q))).length,
    };
  }, [posts, searchQuery, userPinnedIds]);

  const groupedByDate = useMemo(() => {
    return filteredPosts.reduce<Record<string, any[]>>((acc, post: any) => {
      const dateKey = getDateLabel(post.created_at);
      if (!acc[dateKey]) acc[dateKey] = [];
      acc[dateKey].push(post);
      return acc;
    }, {});
  }, [filteredPosts]);

  const canPost = !!user && !!isVerified;
  const findParentPost = useCallback((replyToId: string | null) => {
    if (!replyToId || !posts) return null;
    return posts.find((p: any) => p.id === replyToId) || null;
  }, [posts]);

  const hasContent = content.trim() || imageFile || attachedFile || showPollCreator;

  /* ════════════════════ RENDER ════════════════════ */
  if (isVerified && educationLoaded && identityLoaded && !canonicalIdentity && !hasCompleteForumEducation(primaryEducation)) {
    return (
      <PostVerifyOnboarding
        derivedIit={profile?.iit_name || undefined}
        academicRecovery
        onComplete={async () => {
          await queryClient.invalidateQueries({ queryKey: ["primary-education", user?.id] });
          await queryClient.invalidateQueries({ queryKey: ["canonical-academic-identity", user?.id] });
        }}
      />
    );
  }

  return (
    <div
      className="flex flex-col bg-background overflow-hidden w-full"
      data-testid="forum-shell"
      style={{ height: `${visualViewportHeight}px`, maxHeight: "100dvh" }}
    >
      <div className="flex flex-1 min-h-0 overflow-hidden">

      {/* ═══ CHANNEL SIDEBAR (Desktop: 280px) ═══ */}
      <aside className="hidden lg:flex w-[280px] flex-col border-r border-border bg-card flex-shrink-0 overflow-hidden">
        <div className="h-12 flex items-center px-4 border-b border-border flex-shrink-0">
          <h2 className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Channels</h2>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex-shrink-0">
            <ScopeList
              scopes={scopes} activeScope={activeScope}
              unreadDots={unreadDots}
              onSelect={selectScope}
              onToggle={(scopeId, idx) => { const scope = scopes.find(s => s.id === scopeId); if (scope?.toggleOptions?.[idx]) selectScope(scope.toggleOptions[idx].type, scope.toggleOptions[idx].key, true); }}
            />
          </div>
          {desktopSidebarActive && <DirectMessageSidebar />}
        </div>
        <div className="flex-shrink-0 border-t border-border px-4 py-2.5 bg-card">
          <p className="text-[10px] font-semibold text-muted-foreground/70">Cirkle Forum · build {FORUM_BUILD}</p>
        </div>
      </aside>

      {/* Mobile sidebar sheet */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="w-[300px] p-0 bg-card flex flex-col [&>button]:hidden">
          <SheetTitle className="h-12 flex items-center justify-between px-4 border-b border-border text-xs font-bold text-muted-foreground uppercase tracking-widest">
            Channels
            <button onClick={() => setSidebarOpen(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
          </SheetTitle>
          <SheetDescription className="sr-only">Choose a forum channel or open a direct-message conversation.</SheetDescription>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex-shrink-0">
              <ScopeList
                scopes={scopes} activeScope={activeScope}
                unreadDots={unreadDots}
                onSelect={selectScope}
                onToggle={(scopeId, idx) => { const scope = scopes.find(s => s.id === scopeId); if (scope?.toggleOptions?.[idx]) selectScope(scope.toggleOptions[idx].type, scope.toggleOptions[idx].key, true); }}
              />
            </div>
            {sidebarOpen && <DirectMessageSidebar onNavigate={() => setSidebarOpen(false)} />}
          </div>
          <div className="flex-shrink-0 border-t border-border px-4 py-2.5 bg-card">
            <p className="text-[10px] font-semibold text-muted-foreground/70">Cirkle Forum · build {FORUM_BUILD}</p>
          </div>
        </SheetContent>
      </Sheet>

      {/* ═══ MAIN CHAT AREA ═══ */}
      <div className="flex-1 flex flex-col min-w-0 relative overflow-x-hidden">
        {/* ── Compact, touch-safe group header ── */}
        <div className={`h-16 flex items-center gap-2.5 px-2.5 sm:px-3 border-b border-border/55 bg-card/[0.88] backdrop-blur-2xl flex-shrink-0 z-10 shadow-[0_8px_28px_-22px_hsl(var(--foreground)/0.55)] transition-transform duration-200 ease-in-out ${showHeader ? 'translate-y-0' : '-translate-y-full'}`}>
          <button onClick={() => setSidebarOpen(true)} className="lg:hidden w-11 h-11 flex items-center justify-center rounded-2xl hover:bg-accent active:scale-95 transition-all" aria-label="Open channels">
            <ArrowLeft className="w-5 h-5" />
          </button>

          <div className="relative w-10 h-10 rounded-2xl bg-card flex items-center justify-center flex-shrink-0 shadow-sm ring-1 ring-primary/10 overflow-hidden">
            <img src="/cirkle-logo.png" alt="" className="w-9 h-9 rounded-xl" />
            <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-[hsl(142,68%,42%)] border-2 border-card" aria-label="Community active" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[14px] sm:text-[15px] font-bold text-foreground truncate leading-tight">{(activeScopeDef as any)?.label}</p>
            {(activeScopeDef as any)?.subtitle && (
              <p className="text-[10px] sm:text-[11px] text-muted-foreground truncate leading-tight">{(activeScopeDef as any)?.subtitle}</p>
            )}
          </div>

          {typingUsers.length > 0 && (
            <span className="text-[11px] text-primary animate-pulse hidden sm:inline truncate max-w-32">
              {typingUsers.length === 1 ? `${typingUsers[0]} typing...` : `${typingUsers.length} typing...`}
            </span>
          )}

          <div className="flex items-center gap-0 flex-shrink-0">
            {isAdmin && (
              <button
                className={`w-11 h-11 flex items-center justify-center rounded-2xl transition-colors ${slowModeEnabled ? "text-warning bg-warning/10" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}
                aria-label={slowModeEnabled ? "Disable slow mode" : "Enable slow mode"}
                onClick={async () => {
                  const scopeKey = `slow_mode_${activeScope.type}_${activeScope.key}`;
                  const newEnabled = !slowModeEnabled;
                  const value = JSON.stringify({ enabled: newEnabled, seconds: slowModeSeconds });
                  const { data: existing } = await supabase.from("app_settings").select("id").eq("key", scopeKey).maybeSingle();
                  if (existing) {
                    await supabase.from("app_settings").update({ value, updated_by: user?.id } as any).eq("id", existing.id);
                  } else {
                    await supabase.from("app_settings").insert({ key: scopeKey, value, updated_by: user?.id });
                  }
                  queryClient.invalidateQueries({ queryKey: ["slow-mode-settings"] });
                  toast.success(newEnabled ? `Slow mode: ${slowModeSeconds}s` : "Slow mode off");
                }}
              >
                <Timer className="w-4 h-4" />
              </button>
            )}

            <NotificationBell />
            <button onClick={() => { setShowSearch(!showSearch); setSearchQuery(""); setSearchTab("messages"); }} className={`w-11 h-11 flex items-center justify-center rounded-2xl transition-colors ${showSearch ? "text-primary bg-primary/10" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`} aria-label="Search messages">
              <Search className="w-4 h-4" />
            </button>
            <button onClick={() => setMemberPanelOpen(!memberPanelOpen)} className={`w-11 h-11 flex items-center justify-center rounded-2xl transition-colors ${memberPanelOpen ? "text-primary bg-primary/10" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`} aria-label="View channel members">
              <Users className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Slow mode banner */}
        {slowModeEnabled && (
          <div className="px-4 py-1 bg-warning/5 border-b border-warning/10 flex-shrink-0">
            <div className="flex items-center gap-2 text-[11px] text-warning">
              <Timer className="w-3 h-3 flex-shrink-0" />
              <span className="font-medium">Slow mode · {slowModeSeconds}s</span>
              {slowModeCooldown > 0 && <span className="ml-auto font-bold tabular-nums">{slowModeCooldown}s</span>}
            </div>
          </div>
        )}

        {/* ── Search overlay ── */}
        {showSearch && (
          <div className="flex flex-col border-b border-border bg-card flex-shrink-0 animate-fade-in">
            <div className="flex items-center gap-2 px-3 py-2">
              <button onClick={() => { setShowSearch(false); setSearchQuery(""); }} className="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent flex-shrink-0">
                <ArrowDown className="w-4 h-4 rotate-90" />
              </button>
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input placeholder="Search..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-9 pl-9 pr-8 bg-accent border-0 rounded-lg text-sm" autoFocus />
                {searchQuery && (
                  <button onClick={() => setSearchQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-muted-foreground/20 flex items-center justify-center hover:bg-muted-foreground/30">
                    <X className="w-3 h-3 text-foreground" />
                  </button>
                )}
              </div>
            </div>

            <div className="flex px-3 gap-0 overflow-x-auto scrollbar-hide">
              {([
                { key: "messages", label: "Messages", count: searchCounts.messages },
                { key: "media", label: "Media", count: searchCounts.media },
                { key: "pins", label: "Pins", count: searchCounts.pins },
                { key: "links", label: "Links", count: searchCounts.links },
              ] as const).map(tab => (
                <button key={tab.key} onClick={() => setSearchTab(tab.key)}
                  className={`px-3 py-2 text-[12px] font-semibold border-b-2 transition-all whitespace-nowrap flex items-center gap-1.5 ${
                    searchTab === tab.key ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}>
                  {tab.label}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${searchTab === tab.key ? "bg-primary/15 text-primary" : "bg-accent text-muted-foreground"}`}>
                    {tab.count}
                  </span>
                </button>
              ))}
            </div>

          </div>
        )}

        {/* ── Messages area ── */}
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          onPointerDown={dismissComposerOverlays}
          className="forum-chat-wallpaper forum-scroll-region flex-1"
        >
          <div className="mx-auto w-full max-w-5xl px-0">
            {/* Pagination: Beginning marker or spinner */}
            {!hasMoreOlder && posts && posts.length > 0 && (
              <div className="flex items-center justify-center py-6">
                <span className="text-[12px] text-muted-foreground font-medium">✦ Beginning of #{(activeScopeDef as any)?.label || "channel"}</span>
              </div>
            )}
            {loadingOlder && (
              <div className="flex justify-center py-4">
                <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            )}

            {!isVerified && user ? (
              <MaskedContent>
                <MessagesView isLoading={isLoading} groupedByDate={groupedByDate} messagesEndRef={messagesEndRef} scrollContainerRef={scrollContainerRef}
                  onReply={handleReply} onReact={(postId, emoji) => toggleReaction.mutate({ postId, emoji })}
                  userId={user?.id} isAdmin={!!isAdmin}
                  onAdminPin={(id) => toggleAdminPin.mutate(id)}
                  onUserPin={(id) => toggleUserPin.mutate(id)} userPinnedIds={userPinnedIds}
                  navigate={navigate} messageRefs={messageRefs} highlightedPostId={highlightedPostId}
                  onScrollToMessage={scrollToMessage} findParentPost={findParentPost}
                  adMessages={adMessages} activeScopeDef={activeScopeDef}
                  isEmptyChannel={isEmptyChannel} onStartFirst={() => textareaRef.current?.focus()}
                  onEdit={handleEdit} onDelete={(id, forAll) => deletePost.mutate({ postId: id, forEveryone: forAll })}
                  onCopy={handleCopy} profileMap={profileMap}
                  onImageClick={setLightboxImage} onThread={handleThread} onRetry={retryOutboxPost} />
              </MaskedContent>
            ) : (
              <MessagesView isLoading={isLoading} groupedByDate={groupedByDate} messagesEndRef={messagesEndRef} scrollContainerRef={scrollContainerRef}
                onReply={handleReply} onReact={(postId, emoji) => toggleReaction.mutate({ postId, emoji })}
                userId={user?.id} isAdmin={!!isAdmin}
                onAdminPin={(id) => toggleAdminPin.mutate(id)}
                onUserPin={(id) => toggleUserPin.mutate(id)} userPinnedIds={userPinnedIds}
                navigate={navigate} messageRefs={messageRefs} highlightedPostId={highlightedPostId}
                onScrollToMessage={scrollToMessage} findParentPost={findParentPost}
                adMessages={adMessages} activeScopeDef={activeScopeDef}
                isEmptyChannel={isEmptyChannel} onStartFirst={() => textareaRef.current?.focus()}
                onEdit={handleEdit} onDelete={(id, forAll) => deletePost.mutate({ postId: id, forEveryone: forAll })}
                onCopy={handleCopy} profileMap={profileMap}
                onImageClick={setLightboxImage} onThread={handleThread} onRetry={retryOutboxPost} />
            )}
          </div>
        </div>

        {/* New messages pill (FIX 9) */}
        {newMsgCount > 0 && (
          <button onClick={scrollToBottom}
            className="absolute bottom-24 left-1/2 -translate-x-1/2 z-10 px-4 py-2 rounded-full bg-primary text-primary-foreground text-[13px] font-semibold shadow-lg animate-bounce flex items-center gap-1.5 transition-all active:scale-95">
            <ArrowDown className="w-3.5 h-3.5" />
            {newMsgCount > 9 ? "9+" : newMsgCount} new message{newMsgCount !== 1 ? "s" : ""}
          </button>
        )}

        {/* Scroll to bottom FAB */}
        {showScrollDown && newMsgCount === 0 && (
          <button onClick={scrollToBottom}
            className="absolute bottom-24 right-4 z-10 w-9 h-9 rounded-full bg-card border border-border shadow-lg flex items-center justify-center text-muted-foreground hover:text-foreground transition-all active:scale-95">
            <ArrowDown className="w-4 h-4" />
          </button>
        )}

        {/* Typing indicator bar */}
        {typingUsers.length > 0 && (
          <div className="px-4 py-1 text-[12px] text-muted-foreground flex items-center gap-2 bg-card/50 flex-shrink-0 border-t border-border/50">
            <div className="flex gap-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
            <span className="font-medium">
              {typingUsers.length === 1 ? `${typingUsers[0]} is typing...` : `${typingUsers.join(", ")} are typing...`}
            </span>
          </div>
        )}

        {/* Edit bar */}
        {editingPost && (
          <div className="px-4 py-2 bg-card border-t border-border flex-shrink-0 animate-fade-in">
            <div className="flex items-center gap-2 mb-1.5">
              <Pencil className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-semibold text-primary">Editing message</span>
              <button onClick={() => setEditingPost(null)} className="ml-auto text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <div className="flex items-end gap-2">
              <Textarea ref={textareaRef} value={editContent} onChange={(e) => setEditContent(e.target.value)}
                className="flex-1 min-h-[40px] max-h-24 bg-accent border-0 rounded-lg text-sm resize-none"
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); editPost.mutate(); } }} autoFocus />
              <Button size="icon" className="rounded-lg w-9 h-9 flex-shrink-0" onClick={() => editPost.mutate()} disabled={editPost.isPending || !editContent.trim()}>
                <Check className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}

        {/* ── Ultra-smooth Composer (FIX 2) ── */}
        {canPost && !editingPost && (
          <div className={`z-20 backdrop-blur-2xl bg-card/[0.9] border-t border-border/55 px-2 sm:px-3 py-2 flex-shrink-0 safe-bottom shadow-[0_-12px_40px_-32px_hsl(var(--foreground)/0.6)] transition-[transform,opacity] duration-200 ease-out ${showInput ? 'relative translate-y-0 opacity-100' : 'absolute translate-y-full opacity-0 bottom-0 left-0 right-0 pointer-events-none'}`}>
            {/* Reply preview */}
            {replyTo && (
              <div className="flex items-center bg-accent/80 rounded-t-lg mb-1 overflow-hidden animate-fade-in">
                <div className="w-1 self-stretch bg-primary flex-shrink-0" />
                <div className="flex-1 px-3 py-1.5 min-w-0">
                  <p className="text-[11px] font-semibold text-primary truncate">{replyTo.is_anonymous ? "Anonymous" : replyTo.profile?.name || "User"}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{replyTo.content}</p>
                </div>
                <button onClick={() => setReplyTo(null)} className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-foreground flex-shrink-0">
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Poll creator */}
            {showPollCreator && (
              <div className="bg-accent/60 rounded-lg p-3 mb-2 animate-fade-in">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-foreground flex items-center gap-1"><BarChart3 className="w-3.5 h-3.5 text-primary" /> Create Poll</p>
                  <button onClick={() => setShowPollCreator(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
                </div>
                <Input placeholder="Ask a question..." value={pollQuestion} onChange={(e) => setPollQuestion(e.target.value)} className="h-8 text-xs mb-2 bg-background/50 border-border" />
                {pollOptions.map((opt, i) => (
                  <div key={i} className="flex items-center gap-1 mb-1">
                    <Input placeholder={`Option ${i + 1}`} value={opt} onChange={(e) => { const n = [...pollOptions]; n[i] = e.target.value; setPollOptions(n); }} className="h-7 text-xs bg-background/50 border-border" />
                    {i >= 2 && <button onClick={() => setPollOptions(pollOptions.filter((_, j) => j !== i))} className="text-muted-foreground"><X className="w-3 h-3" /></button>}
                  </div>
                ))}
                {pollOptions.length < 6 && <button onClick={() => setPollOptions([...pollOptions, ""])} className="text-[11px] text-primary font-medium hover:underline">+ Add option</button>}
              </div>
            )}

            {/* Image/File preview */}
            {imagePreview && (
              <div className="relative mb-2 inline-block animate-fade-in">
                <img src={imagePreview} className="h-20 rounded-lg border border-border object-cover" alt="" />
                <button onClick={() => { setImageFile(null); setImagePreview(null); }}
                  className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center text-xs shadow"><X className="w-3 h-3" /></button>
              </div>
            )}
            {attachedFile && (
              <div className="mb-2 flex items-center gap-2 bg-accent/60 rounded-lg px-3 py-2 animate-fade-in">
                <Paperclip className="w-4 h-4 text-primary" />
                <span className="text-xs text-foreground truncate flex-1">{attachedFile.name}</span>
                <button onClick={() => setAttachedFile(null)} className="text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
              </div>
            )}

            {/* Voice recorder */}
            {isRecordingVoice && <VoiceRecorder userId={user?.id || ""} localOnly={Boolean(readMobileTestSession())} onSend={handleVoiceSend} onCancel={() => setIsRecordingVoice(false)} />}

            {/* GIF picker */}
            {showGifPicker && (
              <div className="mb-2 animate-fade-in"><GifPicker onSelect={handleGifSelect} onEmojiSelect={insertEmoji} onClose={() => setShowGifPicker(false)} /></div>
            )}

            {/* Mention suggestions */}
            {showMentionSuggestions && mentionSuggestions.length > 0 && (
              <div className="mb-2 bg-card border border-border rounded-lg shadow-lg overflow-hidden animate-fade-in">
                {mentionSuggestions.map((m: any) => (
                  <button key={m.user_id} onClick={() => insertMention(m.name)}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent transition-colors text-left">
                    {m.avatar_url ? <img src={m.avatar_url} className="w-6 h-6 rounded-full" alt="" /> : (
                      <div className={`w-6 h-6 rounded-full ${getUserColor(m.user_id).bg} flex items-center justify-center`}><span className="text-[8px] font-bold text-white">{getInitials(m.name)}</span></div>
                    )}
                    <span className="text-sm font-medium text-foreground">{m.name}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Formatting bar */}
            {showFormatBar && (
              <div className="flex items-center gap-1 mb-2 animate-fade-in">
                <button onClick={() => insertFormatting("**")} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors" title="Bold"><Bold className="w-4 h-4" /></button>
                <button onClick={() => insertFormatting("*")} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors" title="Italic"><Italic className="w-4 h-4" /></button>
                <button onClick={() => insertFormatting("`")} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors" title="Code"><Code className="w-4 h-4" /></button>
                <button onClick={() => insertFormatting("~~")} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors" title="Strikethrough"><span className="text-sm font-bold line-through">S</span></button>
                <button onClick={() => insertFormatting("||")} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors" title="Spoiler"><Eye className="w-4 h-4" /></button>
              </div>
            )}

            {/* WhatsApp-inspired attachment tray */}
            {showAttachMenu && (
              <div className="absolute z-30 bottom-full left-1 right-1 lg:left-3 lg:right-auto lg:w-[430px] mb-2 bg-gradient-to-b from-card via-card to-secondary backdrop-blur-xl border border-border rounded-3xl shadow-2xl p-3.5 grid grid-cols-5 gap-1.5 animate-bounce-in overflow-hidden">
                <label className="flex flex-col items-center gap-2 rounded-2xl p-1.5 hover:bg-accent cursor-pointer transition-colors">
                  <div className="w-11 h-11 rounded-full bg-[hsl(213,90%,55%)]/14 flex items-center justify-center"><ImageLucide className="w-5 h-5 text-[hsl(213,90%,55%)]" /></div>
                  <span className="text-[11px] font-medium text-foreground">Photos</span>
                  <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageSelect} />
                </label>
                <label className="flex flex-col items-center gap-2 rounded-2xl p-1.5 hover:bg-accent cursor-pointer transition-colors">
                  <div className="w-11 h-11 rounded-full bg-[hsl(142,65%,42%)]/14 flex items-center justify-center"><Camera className="w-5 h-5 text-[hsl(142,65%,42%)]" /></div>
                  <span className="text-[11px] font-medium text-foreground">Camera</span>
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handleImageSelect} />
                </label>
                <label className="flex flex-col items-center gap-2 rounded-2xl p-1.5 hover:bg-accent cursor-pointer transition-colors">
                  <div className="w-11 h-11 rounded-full bg-[hsl(234,89%,64%)]/14 flex items-center justify-center"><Paperclip className="w-5 h-5 text-[hsl(234,89%,64%)]" /></div>
                  <span className="text-[11px] font-medium text-foreground">Document</span>
                  <input ref={docInputRef} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip" className="hidden" onChange={handleFileSelect} />
                </label>
                <button onClick={() => { setShowPollCreator(true); setShowAttachMenu(false); }}
                  className="flex flex-col items-center gap-2 rounded-2xl p-1.5 hover:bg-accent transition-colors">
                  <div className="w-11 h-11 rounded-full bg-[hsl(38,96%,55%)]/14 flex items-center justify-center"><BarChart3 className="w-5 h-5 text-[hsl(38,96%,48%)]" /></div>
                  <span className="text-[11px] font-medium text-foreground">Poll</span>
                </button>
                <button onClick={() => { setShowAttachMenu(false); navigate("/calendar"); }}
                  className="flex flex-col items-center gap-2 rounded-2xl p-1.5 hover:bg-accent transition-colors">
                  <div className="w-11 h-11 rounded-full bg-[hsl(340,78%,52%)]/14 flex items-center justify-center"><Calendar className="w-5 h-5 text-[hsl(340,78%,52%)]" /></div>
                  <span className="text-[11px] font-medium text-foreground">Event</span>
                </button>
              </div>
            )}

            {/* Input row - buttery smooth */}
            {!isRecordingVoice && (
              <div className="flex items-end gap-1.5">
                <button onClick={() => { setShowAttachMenu(!showAttachMenu); setShowGifPicker(false); setShowFormatBar(false); dismissKeyboard(); }}
                  type="button"
                  aria-label={showAttachMenu ? "Close attachments" : "Open attachments"}
                  className={`w-11 h-11 flex items-center justify-center rounded-full flex-shrink-0 transition-all active:scale-95 ${showAttachMenu ? "text-primary bg-primary/10 rotate-45" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}>
                  <Plus className="w-5 h-5" />
                </button>

                <div className="flex-1 min-w-0 relative">
                  <textarea
                    ref={textareaRef}
                    data-testid="forum-composer"
                    aria-label={`Message ${(activeScopeDef as any)?.label || "channel"}`}
                    value={content}
                    onChange={(e) => handleContentChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onFocus={() => {
                      setShowAttachMenu(false);
                      setShowGifPicker(false);
                      const scroller = scrollContainerRef.current;
                      anchorLatestDuringKeyboardRef.current = Boolean(scroller)
                        && shouldAnchorLatestDuringKeyboard(scroller.scrollHeight, scroller.scrollTop, scroller.clientHeight);
                      restoreAll();
                    }}
                    onBlur={() => { anchorLatestDuringKeyboardRef.current = false; }}
                    placeholder={(activeScopeDef as any)?.label || "Forum"}
                    rows={1}
                    style={{ transition: 'height 100ms ease' }}
                    className="w-full min-h-[44px] max-h-[104px] bg-secondary/80 border border-border/45 rounded-[24px] text-[16px] resize-none py-2.5 px-4 pr-24 shadow-inner focus:outline-none focus:border-primary/25 focus:ring-2 focus:ring-primary/10 placeholder:text-[14px] placeholder:font-medium placeholder:text-muted-foreground/60"
                  />
                  <div className="absolute right-1 bottom-1 flex items-center gap-0">
                    <button
                      type="button"
                      onClick={() => {
                        const opening = !showGifPicker;
                        setShowGifPicker(opening);
                        setShowAttachMenu(false);
                        setShowFormatBar(false);
                        if (opening) dismissKeyboard();
                      }}
                      aria-label={showGifPicker ? "Show keyboard" : "Open emoji and GIF picker"}
                      className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${showGifPicker ? "text-primary bg-primary/10" : "text-muted-foreground hover:text-foreground"}`}>
                      {showGifPicker ? <Keyboard className="w-[18px] h-[18px]" /> : <Smile className="w-[18px] h-[18px]" />}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setIsAnonymous((v) => {
                          toast(v ? "Posting as yourself" : "Posting anonymously 👁️");
                          return !v;
                        });
                      }}
                      aria-label={isAnonymous ? "Send anonymously" : "Send as yourself"}
                      className={`w-8 h-8 flex items-center justify-center rounded relative transition-all duration-200 ${
                        isAnonymous
                          ? "text-primary bg-primary/10 shadow-[0_0_8px_hsl(var(--primary)/0.3)]"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      title={isAnonymous ? "Sending anonymously" : "Send as yourself"}
                    >
                      <EyeOff className="w-4 h-4" />
                      {isAnonymous && (
                        <span className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 text-[7px] font-bold text-primary leading-none">ANON</span>
                      )}
                    </button>
                  </div>
                </div>

                {/* Send / Voice button with smooth state transition */}
                {hasContent ? (
                  <button
                    type="button"
                    aria-label="Send message"
                    onClick={() => { const item = buildCurrentOutboxItem(); if (item) createPost.mutate(item); }}
                    disabled={createPost.isPending || (slowModeEnabled && slowModeCooldown > 0 && !isAdmin)}
                    className="w-11 h-11 flex items-center justify-center rounded-full bg-primary text-primary-foreground flex-shrink-0 shadow-[0_8px_22px_-10px_hsl(var(--primary))] active:scale-95 transition-all duration-150 disabled:opacity-50"
                  >
                    {slowModeCooldown > 0 && slowModeEnabled && !isAdmin
                      ? <span className="text-[10px] font-bold tabular-nums">{slowModeCooldown}</span>
                      : <Send className="w-4 h-4" />
                    }
                  </button>
                ) : (
                  <button type="button" aria-label="Record voice message" onClick={() => { dismissKeyboard(); setShowAttachMenu(false); setShowGifPicker(false); setIsRecordingVoice(true); }}
                    className="w-11 h-11 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-accent flex-shrink-0 active:scale-95 transition-all duration-150">
                    <Mic className="w-4 h-4" />
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {user && !isVerified && (
          <div className="bg-card border-t border-border px-4 py-3 flex-shrink-0 safe-bottom">
            <p className="text-xs text-muted-foreground text-center">
              <button onClick={() => navigate("/iit-verify")} className="text-primary font-semibold hover:underline">Verify your IIT email</button> to post messages
            </p>
          </div>
        )}
      </div>

      {/* ═══ RIGHT PANEL: Thread / Members ═══ */}
      {threadPost ? (
        <aside className="hidden lg:flex w-80 flex-shrink-0">
          <ThreadPanel parentPost={threadPost} onClose={() => setThreadPost(null)} onJumpToParent={() => { const id = threadPost.id; setThreadPost(null); requestAnimationFrame(() => scrollToMessage(id)); }} activeScope={activeScope} profileMap={profileMap} navigate={navigate} />
        </aside>
      ) : memberPanelOpen ? (
        <aside className="hidden lg:flex w-60 flex-col border-l border-border bg-card flex-shrink-0 overflow-hidden">
          <div className="h-12 flex items-center px-4 border-b border-border justify-between flex-shrink-0">
            <h3 className="text-sm font-bold text-foreground">Room members</h3>
            <span className="text-[10px] bg-primary/10 text-primary px-2 py-0.5 rounded-full font-bold">{scopeMembers?.length || 0}</span>
          </div>
          <div className="native-scroll-region flex-1 p-2 scrollbar-hide">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-2 py-2">
              Recent contributors - {scopeMembers?.length || 0}
            </p>
            {scopeMembers?.map((member: any) => (
              <button key={member.user_id} onClick={() => navigate(member.slug ? `/u/${member.slug}` : `/profile/${member.user_id}`)}
                className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-accent transition-colors text-left group">
                <div className="relative flex-shrink-0">
                  {member.avatar_url ? (
                    <img src={member.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover" loading="lazy" />
                  ) : (
                    <div className={`w-8 h-8 rounded-full ${getUserColor(member.user_id).bg} flex items-center justify-center`}>
                      <span className="text-[10px] font-bold text-white">{getInitials(member.name)}</span>
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-[13px] font-medium truncate flex items-center gap-1 ${getUserColor(member.user_id).text} group-hover:text-foreground`}>
                    {member.name}
                    {member.is_verified && <Check className="w-3 h-3 text-primary" />}
                  </p>
                  {member.headline && <p className="text-[10px] text-muted-foreground truncate">{member.headline}</p>}
                </div>
              </button>
            ))}
            {!scopeMembers?.length && (
              <p className="px-3 py-8 text-center text-xs leading-relaxed text-muted-foreground">
                No recent contributors yet. The first people to join this conversation will appear here.
              </p>
            )}
          </div>
        </aside>
      ) : null}

      {/* Mobile member panel sheet */}
      <Sheet open={memberPanelOpen && typeof window !== 'undefined' && window.innerWidth < 1024} onOpenChange={setMemberPanelOpen}>
        <SheetContent side="right" className="w-[min(88vw,340px)] p-0 bg-card opacity-100 shadow-2xl supports-[backdrop-filter]:bg-card">
          <SheetTitle className="h-14 flex items-center pl-4 pr-14 border-b border-border text-sm font-bold text-foreground gap-2 bg-card">
            <Users className="w-4 h-4 text-primary" /> Room members
            <span className="text-[10px] bg-primary/10 text-primary px-2 py-0.5 rounded-full font-bold ml-auto">{scopeMembers?.length || 0}</span>
          </SheetTitle>
          <div className="native-scroll-region scrollbar-hide p-2 bg-card" style={{ height: 'calc(100% - 56px)' }}>
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-2 py-2">
              Recent contributors - {scopeMembers?.length || 0}
            </p>
            {scopeMembers?.map((member: any) => (
              <button key={member.user_id} onClick={() => { navigate(member.slug ? `/u/${member.slug}` : `/profile/${member.user_id}`); setMemberPanelOpen(false); }}
                className="w-full flex items-center gap-2.5 px-2 py-2 rounded-md hover:bg-accent transition-colors text-left">
                <div className="relative flex-shrink-0">
                  {member.avatar_url ? (
                    <img src={member.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover" loading="lazy" />
                  ) : (
                    <div className={`w-8 h-8 rounded-full ${getUserColor(member.user_id).bg} flex items-center justify-center`}>
                      <span className="text-[10px] font-bold text-white">{getInitials(member.name)}</span>
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-[13px] font-medium truncate ${getUserColor(member.user_id).text}`}>{member.name}</p>
                  {member.headline && <p className="text-[10px] text-muted-foreground truncate">{member.headline}</p>}
                </div>
              </button>
            ))}
            {!scopeMembers?.length && (
              <p className="px-3 py-8 text-center text-xs leading-relaxed text-muted-foreground">
                No recent contributors yet. The first people to join this conversation will appear here.
              </p>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Image lightbox */}
      {lightboxImage && <ImageLightbox src={lightboxImage} onClose={() => setLightboxImage(null)} />}

      {/* Mobile thread sheet */}
      {threadPost && (
        <Sheet open={!!threadPost} onOpenChange={(open) => { if (!open) setThreadPost(null); }}>
          <SheetContent side="right" className="w-full sm:w-96 p-0">
            <SheetTitle className="sr-only">Thread</SheetTitle>
            <ThreadPanel parentPost={threadPost} onClose={() => setThreadPost(null)} onJumpToParent={() => { const id = threadPost.id; setThreadPost(null); requestAnimationFrame(() => scrollToMessage(id)); }} activeScope={activeScope} profileMap={profileMap} navigate={navigate} />
          </SheetContent>
        </Sheet>
      )}

      {/* Dismiss attach menu backdrop */}
      {showAttachMenu && <div className="fixed inset-0 z-10" onClick={() => setShowAttachMenu(false)} />}
      </div>
      {/* Forum's own bottom nav with scroll hide */}
      <div className={`lg:hidden flex-shrink-0 overflow-hidden transition-[max-height,opacity] duration-200 ease-out ${showNavBar ? 'max-h-20 opacity-100' : 'max-h-0 opacity-0 pointer-events-none'}`}>
        <BottomNav />
      </div>
    </div>
  );
};

/* ══════════════════════════════════════════════════ */
/*              SCOPE LIST SIDEBAR                   */
/* ══════════════════════════════════════════════════ */
const ScopeList = ({ scopes, activeScope, unreadDots, onSelect, onToggle }: {
  scopes: ScopeDef[]; activeScope: { type: string; key: string };
  unreadDots: Record<string, boolean>;
  onSelect: (type: string, key: string) => void;
  onToggle: (scopeId: string, idx: number) => void;
}) => {
  const recommended = scopes.filter(s => s.section === "recommended");
  const all = scopes.filter(s => s.section === "all");
  return (
    <div className="py-2">
      {recommended.length > 0 && (
        <>
          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest px-4 pt-2 pb-2">For You</p>
          {recommended.map(s => <ScopeNavigationItem key={s.id} scope={s} activeScope={activeScope} unreadDots={unreadDots} onSelect={onSelect} onToggle={onToggle} />)}
        </>
      )}
      {all.length > 0 && (
        <>
          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest px-4 pt-5 pb-2">All Channels</p>
          {all.map(s => <ScopeNavigationItem key={s.id} scope={s} activeScope={activeScope} unreadDots={unreadDots} onSelect={onSelect} onToggle={onToggle} />)}
        </>
      )}
    </div>
  );
};

/* ══════════════════════════════════════════════════ */
/*              MESSAGES VIEW                        */
/* ══════════════════════════════════════════════════ */
const MessagesView = ({ isLoading, groupedByDate, messagesEndRef, scrollContainerRef, onReply, onReact, userId, isAdmin, onAdminPin, onUserPin, userPinnedIds, navigate, messageRefs, highlightedPostId, onScrollToMessage, findParentPost, adMessages, activeScopeDef, isEmptyChannel, onStartFirst, onEdit, onDelete, onCopy, profileMap, onImageClick, onThread, onRetry }: {
  isLoading: boolean; groupedByDate: Record<string, any[]>; messagesEndRef: React.RefObject<HTMLDivElement>;
  scrollContainerRef: React.RefObject<HTMLDivElement>;
  onReply: (post: any) => void; onReact: (postId: string, emoji: string) => void; userId?: string;
  isAdmin: boolean; onAdminPin: (id: string) => void; onUserPin: (id: string) => void;
  userPinnedIds: string[]; navigate: (path: string) => void;
  messageRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  highlightedPostId: string | null; onScrollToMessage: (postId: string) => void;
  findParentPost: (replyToId: string | null) => any; adMessages?: any[];
  activeScopeDef?: any;
  isEmptyChannel?: boolean; onStartFirst?: () => void;
  onEdit: (post: any) => void; onDelete: (id: string, forAll: boolean) => void;
  onCopy: (text: string) => void;
  profileMap: Map<string, any>;
  onImageClick: (src: string) => void; onThread: (post: any) => void;
  onRetry: (post: any) => void;
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const timelineItems = useMemo(() => Object.entries(groupedByDate).flatMap(([date, datePosts]) => [
    { type: "date" as const, key: `date-${date}`, date },
    ...datePosts.map((post: any) => ({ type: "post" as const, key: post.id, post })),
  ]), [groupedByDate]);
  const virtualizer = useVirtualizer({
    count: timelineItems.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => timelineItems[index]?.type === "date" ? 48 : 82,
    // Six rows keeps fast flick scrolling visually complete without mounting
    // dozens of media/reaction-heavy message cards outside the viewport.
    overscan: 6,
    getItemKey: (index) => timelineItems[index]?.key || index,
    scrollMargin: listRef.current?.offsetTop || 0,
    useAnimationFrameWithResizeObserver: true,
    isScrollingResetDelay: 120,
  });
  useEffect(() => {
    if (!highlightedPostId) return;
    const targetIndex = timelineItems.findIndex((item) => item.type === "post" && item.post.id === highlightedPostId);
    if (targetIndex < 0) return;
    const frame = requestAnimationFrame(() => virtualizer.scrollToIndex(targetIndex, { align: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [highlightedPostId, timelineItems, virtualizer]);
  return (
  <>
    {isLoading ? (
      /* ── Shimmer Skeleton (FIX 8) - 8 skeleton messages ── */
      <div className="space-y-4 p-4 animate-fade-in">
        {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <div key={i} className="flex gap-3 px-4">
            {/* Avatar shimmer */}
            <div className="w-10 h-10 rounded-full flex-shrink-0 bg-gradient-to-r from-accent via-accent/40 to-accent bg-[length:200%_100%] animate-[shimmer_1.5s_infinite]" />
            <div className="space-y-2 flex-1">
              <div className="flex items-center gap-2">
                <div className="h-3.5 w-24 rounded bg-gradient-to-r from-accent via-accent/40 to-accent bg-[length:200%_100%] animate-[shimmer_1.5s_infinite]" />
                <div className="h-2.5 w-14 rounded bg-gradient-to-r from-accent via-accent/40 to-accent bg-[length:200%_100%] animate-[shimmer_1.5s_infinite]" />
              </div>
              <div className="h-4 rounded bg-gradient-to-r from-accent via-accent/40 to-accent bg-[length:200%_100%] animate-[shimmer_1.5s_infinite]" style={{ width: `${[60, 90, 75, 85, 55, 70, 80, 65][i - 1]}%` }} />
              {i % 3 === 0 && (
                <div className="h-4 rounded bg-gradient-to-r from-accent via-accent/40 to-accent bg-[length:200%_100%] animate-[shimmer_1.5s_infinite]" style={{ width: `${[40, 50, 35, 45, 55, 30, 60, 40][i - 1]}%` }} />
              )}
            </div>
          </div>
        ))}
      </div>
    ) : Object.keys(groupedByDate).length > 0 ? (
      <>
        {adMessages && adMessages.length > 0 && (
          <div className="px-4 pt-3">
            {adMessages.slice(0, 1).map((ad: any) => (
              <div key={ad.id} className="bg-primary/5 border border-primary/15 rounded-lg p-3 flex items-start gap-3">
                <Megaphone className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground">{ad.content}</p>
                  {safeHttpUrl(ad.link_url) && <a href={safeHttpUrl(ad.link_url)!} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary hover:underline mt-1 block">Learn more →</a>}
                </div>
                <span className="text-[8px] text-muted-foreground uppercase font-bold">Ad</span>
              </div>
            ))}
          </div>
        )}
        <div ref={listRef} style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = timelineItems[virtualRow.index];
            return (
              <div key={item.key} ref={virtualizer.measureElement} data-index={virtualRow.index}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)` }}>
                {item.type === "date" ? (
                  <div className="my-3 flex justify-center px-4 pointer-events-none">
                    <span className="rounded-full border border-white/60 bg-card/80 px-3 py-1 text-[11px] font-semibold text-muted-foreground shadow-sm backdrop-blur-xl dark:border-border/70">{item.date}</span>
                  </div>
                ) : (() => {
              const post = item.post;
              const previousItem = timelineItems[virtualRow.index - 1];
              const prevPost = previousItem?.type === "post" ? previousItem.post : null;
              const isSameAuthor = prevPost && prevPost.author_id === post.author_id && !prevPost.deleted_at;
              const timeDiff = prevPost ? (new Date(post.created_at).getTime() - new Date(prevPost.created_at).getTime()) / 60000 : 999;
              const isGrouped = isSameAuthor && timeDiff < 7;
              return (
                <MemoizedDiscordMessage post={post} onReply={onReply} onReact={onReact}
                  userId={userId} isAdmin={isAdmin} onAdminPin={onAdminPin}
                  onUserPin={onUserPin} isUserPinned={userPinnedIds.includes(post.id)}
                  navigate={navigate} messageRefs={messageRefs} highlightedPostId={highlightedPostId}
                  onScrollToMessage={onScrollToMessage} findParentPost={findParentPost}
                  onEdit={onEdit} onDelete={onDelete} onCopy={onCopy}
                  profileMap={profileMap} onImageClick={onImageClick} onThread={onThread}
                  onRetry={onRetry}
                  isGrouped={isGrouped} />
              );
                })()}
              </div>
            );
          })}
        </div>
      </>
    ) : (
      <div className="flex flex-col items-center justify-center py-16 sm:py-20 text-center px-6">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center mb-4">
          <Hash className="w-8 h-8 text-primary" />
        </div>
        <p className="text-foreground text-base sm:text-lg font-bold">
          {isEmptyChannel ? `No messages yet in #${activeScopeDef?.label || "channel"}` : `Welcome to #${activeScopeDef?.label || "channel"}!`}
        </p>
        <p className="text-muted-foreground text-xs sm:text-sm mt-1.5 max-w-xs">
          {isEmptyChannel
            ? `Be the first to start a conversation here. Your message will be visible to everyone in ${activeScopeDef?.subtitle || "this scope"}.`
            : "This is the very beginning of this channel. Start the conversation!"}
        </p>
        {isEmptyChannel && onStartFirst && (
          <button onClick={onStartFirst}
            className="mt-5 px-5 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 active:scale-95 transition-all shadow-sm">
            Start the first chat
          </button>
        )}
      </div>
    )}
    <div ref={messagesEndRef} className="h-4" />
  </>
  );
};

/* ══════════════════════════════════════════════════ */
/*       Discord-style MESSAGE ROW (React.memo FIX 6)*/
/* ══════════════════════════════════════════════════ */
interface DiscordMessageProps {
  post: any; onReply: (p: any) => void; onReact: (id: string, emoji: string) => void;
  userId?: string; isAdmin: boolean; onAdminPin: (id: string) => void;
  onUserPin: (id: string) => void; isUserPinned: boolean;
  navigate: (path: string) => void;
  messageRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  highlightedPostId: string | null; onScrollToMessage: (postId: string) => void;
  findParentPost: (replyToId: string | null) => any;
  onEdit: (post: any) => void; onDelete: (id: string, forAll: boolean) => void;
  onCopy: (text: string) => void;
  profileMap: Map<string, any>;
  onImageClick: (src: string) => void; onThread: (post: any) => void;
  isGrouped?: boolean;
  onRetry: (post: any) => void;
}

const DiscordMessage = ({ post, onReply, onReact, userId, isAdmin, onAdminPin, onUserPin, isUserPinned, navigate, messageRefs, highlightedPostId, onScrollToMessage, findParentPost, onEdit, onDelete, onCopy, profileMap, onImageClick, onThread, isGrouped, onRetry }: DiscordMessageProps) => {
  const [showActions, setShowActions] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gestureStartRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const swipeThreshold = 60;

  const isMine = post.viewer_is_author === true || post.author_id === userId;
  const displayName = post.is_anonymous ? (isMine ? "You · Anonymous" : "Anonymous") : (post.profile?.name || "User");
  const avatar = post.is_anonymous ? null : post.profile?.avatar_url;
  const colors = getUserColor(post.is_anonymous ? "anon" : post.author_id);
  const time = format(new Date(post.created_at), "h:mm a");
  const fullTime = format(new Date(post.created_at), "MMM d, yyyy h:mm a");
  const poll = post.poll;
  const reactions: Record<string, number> = post.reactions || {};
  const myReactions: string[] = post.myReactions || [];
  const profileSlug = post.profile?.slug;
  const isHighlighted = highlightedPostId === post.id;
  const isDeleted = !!post.deleted_at || !!post.is_deleted_for_everyone;
  const isEdited = !!post.edited_at;
  const imageUrl = safeHttpUrl(post.image_url);
  const fileUrl = safeHttpUrl(post.file_url);
  const voiceUrl = safeHttpUrl(post.voice_url);
  const replyCount = post.replyCount || 0;
  const parentPost = findParentPost(post.reply_to_id);
  const canDeleteForEveryone = isMine && !isDeleted && ((Date.now() - new Date(post.created_at).getTime()) < 3 * 60 * 1000);
  const goToProfile = () => {
    if (post.is_anonymous) return;
    if (profileSlug) navigate(`/u/${profileSlug}`);
    else if (post.author_id) navigate(`/profile/${post.author_id}`);
  };

  const cancelLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  // A single pointer gesture handles touch, pen and hybrid devices. Vertical
  // movement always belongs to scrolling; horizontal movement can reveal reply.
  const handlePointerDown = (e: React.PointerEvent) => {
    if (!e.isPrimary || (e.pointerType !== "touch" && e.pointerType !== "pen")) return;
    if ((e.target as HTMLElement).closest("button, a, input, textarea, audio")) return;
    gestureStartRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    cancelLongPress();
    longPressTimer.current = setTimeout(() => {
      setSwipeOffset(0);
      setShowActions(true);
      gestureStartRef.current = null;
      longPressTimer.current = null;
      if ("vibrate" in navigator) navigator.vibrate(8);
    }, 460);
  };

  const messageRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => cancelLongPress(), []);

  const handlePointerMove = (e: React.PointerEvent) => {
    const start = gestureStartRef.current;
    if (!start || start.pointerId !== e.pointerId) return;
    const diffX = e.clientX - start.x;
    const diffY = e.clientY - start.y;
    if (Math.abs(diffX) > 10 || Math.abs(diffY) > 10) cancelLongPress();
    if (diffX > 0 && Math.abs(diffX) > Math.abs(diffY) * 1.15) {
      setSwipeOffset(Math.min(diffX * 0.55, 76));
    } else if (Math.abs(diffY) > Math.abs(diffX)) {
      setSwipeOffset(0);
    }
  };

  const finishPointerGesture = (e: React.PointerEvent, cancelled = false) => {
    cancelLongPress();
    const start = gestureStartRef.current;
    gestureStartRef.current = null;
    setSwipeOffset(0);
    if (!cancelled && start && start.pointerId === e.pointerId && e.clientX - start.x > swipeThreshold && Math.abs(e.clientY - start.y) < 42 && !isDeleted) {
      onReply(post);
    }
  };

  // Right-click = same sheet (desktop, FIX 1 + 7)
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!isDeleted) setShowActions(true);
  };

  return (
    <div
      ref={(el) => { messageRefs.current[post.id] = el; messageRef.current = el; }}
      className={`forum-message-row relative transition-colors duration-300 ${isHighlighted ? 'bg-primary/5' : ''} ${isMine && post.is_anonymous ? 'bg-primary/[0.035]' : ''} ${isGrouped ? '' : 'mt-[2px]'}`}
      style={{ transform: `translateX(${swipeOffset}px)`, transition: swipeOffset === 0 ? 'transform 0.18s ease-out' : 'none', touchAction: 'pan-y pinch-zoom', WebkitTouchCallout: 'none', contentVisibility: 'auto', containIntrinsicSize: '0 76px' } as React.CSSProperties}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(e) => finishPointerGesture(e)}
      onPointerCancel={(e) => finishPointerGesture(e, true)}
      onPointerLeave={(e) => { if (e.pointerType !== "mouse") finishPointerGesture(e, true); }}
      onContextMenu={handleContextMenu}
      data-message-id={post.id}
    >
      {/* Pinned indicator */}
      {post.pinned_at && (
        <div className="flex items-center gap-1.5 text-[10px] text-warning font-medium px-3 sm:px-4 pl-[60px] sm:pl-[72px] pt-1">
          <Pin className="w-3 h-3" /> Pinned message
        </div>
      )}
      {isUserPinned && !post.pinned_at && (
        <div className="flex items-center gap-1.5 text-[10px] text-primary font-medium px-3 sm:px-4 pl-[60px] sm:pl-[72px] pt-1">
          <Bookmark className="w-3 h-3" /> Saved
        </div>
      )}

      {/* Reply reference */}
      {parentPost && (
        <button onClick={() => onScrollToMessage(parentPost.id)}
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground px-3 sm:px-4 pl-[60px] sm:pl-[72px] pt-1 hover:text-foreground transition-colors">
          <Reply className="w-3 h-3 flex-shrink-0" />
          <span className="w-4 h-4 rounded-full overflow-hidden flex-shrink-0">
            {parentPost.profile?.avatar_url ? (
              <img src={parentPost.profile.avatar_url} className="w-full h-full object-cover" alt="" />
            ) : (
              <div className={`w-full h-full ${getUserColor(parentPost.author_id).bg} flex items-center justify-center`}>
                <span className="text-[6px] font-bold text-white">{getInitials(parentPost.profile?.name)}</span>
              </div>
            )}
          </span>
          <span className={`font-semibold ${getUserColor(parentPost.author_id).text}`}>
            {parentPost.is_anonymous ? "Anonymous" : parentPost.profile?.name || "User"}
          </span>
          <span className="truncate">{parentPost.content}</span>
        </button>
      )}

      <div className={`flex gap-2 px-2.5 sm:px-5 ${isMine ? "justify-end" : "justify-start"} ${isGrouped ? 'py-[1px]' : 'pt-1.5 pb-0.5'} ${isDeleted ? "opacity-50" : ""}`}>
        {/* Avatar column */}
        {!isMine && <div className="w-8 sm:w-9 flex-shrink-0 self-end mb-0.5">
          {!isGrouped ? (
            <button onClick={goToProfile} className="w-8 h-8 sm:w-9 sm:h-9 rounded-full overflow-hidden hover:opacity-80 transition-opacity block">
              {avatar ? (
                <img src={avatar} alt="" className="w-8 h-8 sm:w-9 sm:h-9 rounded-full object-cover" loading="lazy" />
              ) : (
                <div className={`w-8 h-8 sm:w-9 sm:h-9 rounded-full ${post.is_anonymous ? "bg-muted" : colors.bg} flex items-center justify-center`}>
                  <span className="text-xs font-bold text-white">{post.is_anonymous ? "?" : getInitials(post.profile?.name)}</span>
                </div>
              )}
            </button>
          ) : (
            <span className="block w-8 sm:w-9" aria-hidden="true" />
          )}
        </div>}

        {/* Compact group-chat bubble */}
        <div className={`relative min-w-0 max-w-[84%] sm:max-w-[min(72%,44rem)] px-3.5 py-2 shadow-[0_3px_14px_-9px_hsl(var(--foreground)/0.55)] border border-border/30 backdrop-blur-sm ${
          isMine
            ? "bg-gradient-to-br from-[hsl(142,54%,91%)] to-[hsl(142,48%,87%)] dark:from-[hsl(152,50%,22%)] dark:to-[hsl(152,48%,18%)] rounded-2xl rounded-br-[5px]"
            : "bg-card/95 rounded-2xl rounded-bl-[5px]"
        }`}>
          {!isGrouped && (!isMine || post.is_anonymous) && (
            <div className="flex items-baseline gap-1.5 mb-0.5">
              <button onClick={goToProfile} className={`text-[15px] font-semibold hover:underline ${post.is_anonymous ? "text-muted-foreground italic" : colors.text}`}>
                {displayName}
              </button>
              {post.is_anonymous && <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${isMine ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>{isMine ? "ANONYMOUS TO OTHERS" : "ANON"}</span>}
              {isEdited && <span className="text-[10px] text-muted-foreground italic">(edited)</span>}
            </div>
          )}

          {/* Message content */}
          {isDeleted ? (
            <p className="text-[14px] text-muted-foreground italic">
              {isMine ? "🚫 You deleted this message" : "🚫 This message was deleted"}
            </p>
          ) : (
            <div className="text-[14px] text-foreground leading-[1.375rem] whitespace-pre-wrap break-words">
              {renderFormattedMessage(post.content, profileMap, navigate)}
            </div>
          )}

          {/* Image */}
          {!isDeleted && imageUrl && (
            <img src={imageUrl} alt={post.content === "GIF" ? "Shared GIF" : "Shared image"} className="mt-1.5 block h-auto max-h-72 w-full max-w-[400px] rounded-lg object-contain cursor-pointer hover:opacity-90 transition-opacity"
              loading="lazy" onClick={() => onImageClick(imageUrl)} />
          )}

          {/* File */}
          {!isDeleted && fileUrl && post.file_name && (
            <div className="mt-1.5 max-w-[300px]">
              <FileAttachment fileName={post.file_name} fileUrl={fileUrl} fileSize={post.file_size} fileType={post.file_type} />
            </div>
          )}

          {/* Voice */}
          {!isDeleted && voiceUrl && (
            <div className="mt-1.5 max-w-[280px]">
              <VoicePlayback url={voiceUrl} duration={post.voice_duration || 0} />
            </div>
          )}

          {!isDeleted && poll && <PollDisplay poll={poll} />}

          {!isDeleted && Object.keys(reactions).length > 0 && (
            <ReactionDisplay reactions={reactions} myReactions={myReactions} postId={post.id} onReact={onReact} />
          )}

          {/* Thread indicator */}
          {!isDeleted && replyCount > 0 && (
            <button onClick={() => onThread(post)} className="flex items-center gap-1.5 mt-1.5 text-[12px] text-primary hover:text-primary/80 font-semibold transition-colors group/thread">
              <MessageSquare className="w-3.5 h-3.5" />
              <span>{replyCount} {replyCount === 1 ? "reply" : "replies"}</span>
              <ChevronRight className="w-3 h-3 opacity-0 group-hover/thread:opacity-100 transition-opacity" />
            </button>
          )}

          <div className="flex items-center justify-end gap-1 pl-10 -mt-0.5 min-h-[14px]">
            {isEdited && isMine && <span className="text-[9px] text-muted-foreground">edited</span>}
            <span className="text-[10px] text-muted-foreground tabular-nums" title={fullTime}>{time}</span>
            {isMine && post.is_pending && <Clock className="w-3 h-3 text-muted-foreground" aria-label="Sending" />}
            {isMine && post.is_failed && <button type="button" onClick={() => onRetry(post)} className="text-[9px] font-semibold text-destructive hover:underline">Not sent · tap to retry</button>}
          </div>
        </div>
      </div>

      {/* Swipe reply indicator */}
      {swipeOffset > 20 && (
        <div className="absolute left-2 top-1/2 -translate-y-1/2 opacity-60">
          <Reply className="w-5 h-5 text-primary" />
        </div>
      )}

      {/* NO hover actions (FIX 1 - removed entirely) */}

      {/* Portal-based action sheet: never clipped by a message or keyboard. */}
      <Sheet open={showActions} onOpenChange={(open) => { setShowActions(open); if (!open) setConfirmDelete(false); }}>
        <SheetContent side="bottom" aria-describedby={undefined} data-testid="message-action-sheet"
          className="max-h-[min(78dvh,640px)] overflow-y-auto overscroll-contain rounded-t-[28px] border-border bg-card px-3 pb-[max(14px,env(safe-area-inset-bottom))] pt-2 shadow-2xl sm:left-1/2 sm:right-auto sm:w-[420px] sm:-translate-x-1/2 sm:rounded-[22px] sm:border [&>button.absolute]:hidden">
          <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-muted-foreground/25" aria-hidden="true" />
          <SheetTitle className="sr-only">Message actions</SheetTitle>
          <div className="mb-2 rounded-2xl bg-accent/55 px-3 py-2.5">
            <p className="text-[11px] font-semibold text-muted-foreground">{isMine ? "You" : displayName} · {time}</p>
            <p className="mt-0.5 truncate text-[13px] text-foreground">{post.content || "Attachment"}</p>
          </div>
          <div className="mb-2 flex items-center justify-between rounded-2xl border border-border/60 bg-background/55 px-2 py-1.5">
            {QUICK_REACTIONS.map(emoji => (
              <button key={emoji} onClick={() => { onReact(post.id, emoji); setShowActions(false); }}
                aria-label={`React ${emoji}`}
                className={`text-xl min-w-11 min-h-11 flex items-center justify-center rounded-xl hover:bg-accent transition-all active:scale-90 ${myReactions.includes(emoji) ? "bg-primary/10 ring-2 ring-primary/30" : ""}`}>
                {emoji}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1 rounded-2xl bg-background/45 p-1">
                <ActionButton icon={Reply} label="Reply in thread" onClick={() => { onReply(post); setShowActions(false); }} />
                <ActionButton icon={Copy} label="Copy" onClick={() => { onCopy(post.content); setShowActions(false); }} />
                <ActionButton icon={Bookmark} label={isUserPinned ? "Remove saved pin" : "Save for me"} onClick={() => { onUserPin(post.id); setShowActions(false); }} active={isUserPinned} />
                {isMine && !isDeleted && <ActionButton icon={Pencil} label="Edit" onClick={() => { onEdit(post); setShowActions(false); }} />}
                {isAdmin && (
                  <ActionButton icon={Pin} label={post.pinned_at ? "Unpin from room" : "Pin for room"} onClick={() => { onAdminPin(post.id); setShowActions(false); }} />
                )}
                {!isMine && !isDeleted && <ActionButton icon={Trash2} label="Delete for me" onClick={() => { onDelete(post.id, false); setShowActions(false); }} muted />}
                {!isMine && !isDeleted && <ActionButton icon={Flag} label="Report" onClick={async () => {
                  if (!userId) { toast.error("Please sign in to report"); setShowActions(false); return; }
                  if (isDemoId(post.id)) { toast("This is a demo message"); setShowActions(false); return; }
                  try {
                    const { error } = await supabase.from("reports").insert({ entity_id: post.id, entity_type: "forum_msg", reporter_id: userId, reason: "Reported via forum" });
                    if (error) throw error;
                    toast.success("Report submitted");
                  } catch { toast.error("Could not submit report"); }
                  setShowActions(false);
                }} />}
          </div>
          {isMine && !isDeleted && (
            <div className="mt-2 rounded-2xl border border-destructive/20 bg-destructive/5 p-1">
              {!confirmDelete ? (
                <ActionButton icon={Trash2} label="Delete message" onClick={() => setConfirmDelete(true)} destructive />
              ) : (
                <div className="space-y-1 p-1 animate-fade-in">
                  <p className="px-3 py-1 text-[12px] font-semibold text-destructive">Choose where to delete it</p>
                  {canDeleteForEveryone && <ActionButton icon={Trash2} label="Delete for everyone" onClick={() => { onDelete(post.id, true); setShowActions(false); }} destructive />}
                  <ActionButton icon={Trash2} label="Delete for me" onClick={() => { onDelete(post.id, false); setShowActions(false); }} muted />
                  <button onClick={() => setConfirmDelete(false)} className="min-h-11 w-full rounded-xl px-4 text-left text-[14px] font-medium text-foreground hover:bg-accent">Cancel</button>
                </div>
              )}
            </div>
          )}
          <button onClick={() => setShowActions(false)} className="mt-2 min-h-11 w-full rounded-2xl bg-accent text-[14px] font-semibold text-foreground active:scale-[0.99]">Close</button>
        </SheetContent>
      </Sheet>
    </div>
  );
};

/* FIX 6: React.memo with custom comparator */
const MemoizedDiscordMessage = React.memo(DiscordMessage, (prev, next) => {
  return (
    prev.post === next.post &&
    prev.isUserPinned === next.isUserPinned &&
    prev.highlightedPostId === next.highlightedPostId &&
    prev.isGrouped === next.isGrouped
  );
});

/* ── Reaction Display ── */
const ReactionDisplay = ({ reactions, myReactions, postId, onReact }: {
  reactions: Record<string, number>; myReactions: string[]; postId: string;
  onReact: (id: string, emoji: string) => void;
}) => {
  const allEmojis = Object.keys(reactions);
  const totalCount = Object.values(reactions).reduce((a, b) => a + b, 0);
  const hasMyReaction = myReactions.length > 0;

  return (
    <div className="relative mt-1.5">
      <div className="flex items-center gap-1 flex-wrap">
        {allEmojis.map(emoji => (
          <button key={emoji} onClick={() => onReact(postId, emoji)}
            className={`text-[12px] h-[26px] px-2 rounded-full border transition-all flex items-center gap-1 ${
              myReactions.includes(emoji) ? "bg-primary/10 border-primary/30" : "bg-accent/60 border-border hover:border-primary/20"
            }`}>
            <span>{emoji}</span>
            <span className={`text-[11px] font-medium ${myReactions.includes(emoji) ? "text-primary" : "text-foreground"}`}>
              {reactions[emoji]}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};

/* Action button for context menu */
const ActionButton = ({ icon: Icon, label, onClick, destructive, muted, active }: {
  icon: any; label: string; onClick: () => void; destructive?: boolean; muted?: boolean; active?: boolean;
}) => (
  <button onClick={onClick}
    className={`min-h-11 w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] font-medium transition-colors active:bg-accent/80 ${
      destructive ? "text-destructive hover:bg-destructive/10" :
      muted ? "text-muted-foreground hover:bg-accent" :
      "text-foreground hover:bg-accent"
    }`}>
    <Icon className={`w-[18px] h-[18px] ${active ? "text-primary fill-primary" : destructive ? "" : "text-muted-foreground"}`} />
    {label}
  </button>
);

/* ── Poll Display ── */
const PollDisplay = ({ poll }: { poll: any }) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isTestPoll = typeof poll.id === "string" && poll.id.startsWith("test-poll-");
  const [testVote, setTestVote] = useState<number | null>(null);
  const rawOptions = poll.options;
  const options: string[] = Array.isArray(rawOptions) ? rawOptions : [];
  const { data: votes } = useQuery({
    queryKey: ["poll-votes", poll.id],
    queryFn: async () => { const { data } = await supabase.from("poll_votes").select("*").eq("poll_id", poll.id); return data ?? []; },
    staleTime: 30000,
    enabled: !isTestPoll,
  });
  const myVote = isTestPoll && testVote !== null ? { option_index: testVote } : votes?.find((v: any) => v.user_id === user?.id);
  const totalVotes = isTestPoll ? (testVote === null ? 0 : 1) : (votes?.length || 0);
  const voteCounts = options.map((_, i) => isTestPoll ? (testVote === i ? 1 : 0) : (votes?.filter((v: any) => v.option_index === i).length || 0));
  const vote = async (idx: number) => {
    if (!user) return;
    if (isTestPoll) {
      setTestVote((current) => current === idx ? null : idx);
      return;
    }
    if (myVote && "id" in myVote) {
      if (myVote.option_index === idx) await supabase.from("poll_votes").delete().eq("id", myVote.id);
      else await supabase.from("poll_votes").update({ option_index: idx }).eq("id", myVote.id);
    } else {
      await supabase.from("poll_votes").insert({ poll_id: poll.id, user_id: user.id, option_index: idx });
    }
    queryClient.invalidateQueries({ queryKey: ["poll-votes", poll.id] });
  };
  return (
    <div className="mt-2 space-y-1.5 max-w-[300px]">
      <p className="text-xs font-semibold text-foreground flex items-center gap-1.5"><BarChart3 className="w-3.5 h-3.5 text-primary" /> {poll.question}</p>
      {options.map((opt: string, i: number) => {
        const pct = totalVotes > 0 ? Math.round((voteCounts[i] / totalVotes) * 100) : 0;
        const isMyVote = myVote?.option_index === i;
        return (
          <button key={i} onClick={() => vote(i)} className="w-full text-left relative overflow-hidden rounded-md border border-border bg-accent/40 p-2 text-xs transition-all hover:border-primary/30">
            <div className="absolute inset-0 bg-primary/10 transition-all" style={{ width: `${pct}%` }} />
            <div className="relative flex items-center justify-between">
              <span className={`font-medium ${isMyVote ? "text-primary" : "text-foreground"}`}>{opt}</span>
              <span className="text-muted-foreground text-[10px] tabular-nums">{pct}%</span>
            </div>
          </button>
        );
      })}
      <p className="text-[10px] text-muted-foreground text-right">{totalVotes} vote{totalVotes !== 1 ? "s" : ""}</p>
    </div>
  );
};

export default Forum;
