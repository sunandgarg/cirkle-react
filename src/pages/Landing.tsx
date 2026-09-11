import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MotionConfig, motion, useReducedMotion } from "framer-motion";
import {
  ArrowRight,
  BadgeCheck,
  BriefcaseBusiness,
  CalendarDays,
  ChevronRight,
  CircleDot,
  Compass,
  Handshake,
  Infinity as InfinityIcon,
  Landmark,
  MessageCircleMore,
  MessagesSquare,
  Network,
  Quote,
  Search,
  ShieldCheck,
  Sparkles,
  UserCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useMetaTags } from "@/hooks/useMetaTags";
import cirkLogo from "@/assets/cirkle-logo.png";
import "./landing.css";

const PRODUCT_FEATURES = [
  {
    icon: MessagesSquare,
    eyebrow: "Focused forums",
    title: "Walk into the conversation that already fits.",
    description: "Community, campus, course and cohort context put every discussion in the right room from the beginning.",
    tags: ["Campus", "Course", "Cohort"],
    className: "bg-[hsl(var(--landing-peach))] lg:col-span-7",
  },
  {
    icon: Handshake,
    eyebrow: "Permission-first connections",
    title: "A warm introduction, even before hello.",
    description: "Shared context is visible first. Private chat opens only after a connection is accepted.",
    tags: ["Mutual context", "You stay in control"],
    className: "bg-[hsl(var(--landing-mint))] lg:col-span-5",
  },
  {
    icon: BriefcaseBusiness,
    eyebrow: "Relevant opportunities",
    title: "Find the opening behind the people you trust.",
    description: "Jobs, referrals and practical guidance travel through communities where relevance is already understood.",
    tags: ["Jobs", "Referrals", "Mentors"],
    className: "bg-[hsl(var(--landing-lilac))] lg:col-span-5",
  },
  {
    icon: CalendarDays,
    eyebrow: "Community momentum",
    title: "The moments worth showing up for, in one place.",
    description: "Events, updates and useful activity stay attached to the community they belong to instead of disappearing in a generic feed.",
    tags: ["Events", "Updates", "Saved context"],
    className: "bg-[#e8edf4] dark:bg-[#17202c] lg:col-span-7",
  },
];

const COMMUNITY_TYPES = [
  { label: "Campus networks", caption: "Students, courses and cohorts", icon: Landmark },
  { label: "Alumni circles", caption: "Shared history that stays useful", icon: BadgeCheck },
  { label: "Professional circles", caption: "Peers, operators and trusted experts", icon: Network },
  { label: "Curated collectives", caption: "Focused groups with a real purpose", icon: Sparkles },
];

const SIGNALS = [
  "Verified identity",
  "Relevant rooms",
  "Community-first discovery",
  "Mutual connections",
  "Server-saved conversations",
];

const JOURNEY = [
  { marker: "The belief", title: "Context should come first", body: "Useful networks begin with what people genuinely share, not how loudly they broadcast." },
  { marker: "First proof", title: "Verified campus circles", body: "Campus, course, cohort and alumni spaces give each conversation a meaningful starting point." },
  { marker: "As we grow", title: "More communities, same trust", body: "New academic and professional circles can expand the network without flattening their identity." },
  { marker: "Always", title: "Belonging without the noise", body: "Every new Cirkle should make discovery more relevant while keeping members in control." },
];

const COMMUNITY_NEEDS = [
  {
    quote: "Show me the people who understand my context before asking me to build another audience.",
    role: "What a member needs",
    context: "Belonging before reach",
  },
  {
    quote: "Let the right opportunity reach the right circle without turning every conversation into content.",
    role: "What a community needs",
    context: "Usefulness before virality",
  },
  {
    quote: "Give us a place with memory, trusted access and a reason to keep coming back.",
    role: "What an operator needs",
    context: "Continuity before noise",
  },
];

const FAQS = [
  {
    question: "Who can join Cirkle?",
    answer: "Anyone can create an account. Access to verified community spaces is unlocked when membership can be confirmed, keeping every circle relevant, useful and trustworthy.",
  },
  {
    question: "Is Cirkle only for IIT communities?",
    answer: "No. Verified campus communities are Cirkle's first live rollout and proof of the model. The platform is designed to grow into other academic, alumni, professional and curated communities.",
  },
  {
    question: "Can anyone message me?",
    answer: "No. One-to-one messaging opens only after you accept a connection request. Community forums remain scoped to the rooms your membership allows you to access.",
  },
  {
    question: "How is this different from a public social network?",
    answer: "Cirkle starts with shared context, verified access and relevant rooms. It is designed for useful participation, not public follower races, viral reach or unsolicited inbox traffic.",
  },
];

const REVEAL = {
  initial: { opacity: 0, y: 22 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.18 },
  transition: { duration: 0.58, ease: [0.22, 1, 0.36, 1] as const },
};

const Landing = () => {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const reduceMotion = Boolean(useReducedMotion());

  useMetaTags({
    title: "Cirkle - Shared context before the first hello",
    description: "Cirkle is a verified community networking platform for focused conversations, trusted connections, relevant opportunities, events and expert access.",
    ogTitle: "Cirkle - Where your community becomes your network",
    ogDescription: "Verified community networking built around shared context, trusted people and useful opportunity.",
    ogImage: "https://cirkle.world/cirkle-logo.png",
    ogUrl: "https://cirkle.world",
    canonicalUrl: "https://cirkle.world",
    keywords: "verified community platform, community networking, alumni network, professional community, campus network, trusted connections, community forum",
  });

  useEffect(() => {
    if (!loading && user) navigate("/cirkle-forum", { replace: true });
  }, [user, loading, navigate]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-label="Loading Cirkle" />
      </div>
    );
  }
  if (user) return null;

  const goAuth = () => navigate("/auth");

  return (
    <MotionConfig reducedMotion="user">
      <div className="cirkle-landing min-h-screen touch-pan-y overflow-x-hidden selection:bg-[#2866c7] selection:text-white">
        <div className="border-b border-white/10 bg-[#101317] px-4 py-2.5 text-center text-[11px] font-semibold tracking-wide text-white sm:text-xs">
          <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-[#74d8b2] align-middle" aria-hidden="true" />
          Built for verified campus communities first.
          <span className="ml-2 font-bold text-[#a8d1ff]">Membership is open.</span>
        </div>

        <header className="sticky top-0 z-50 border-b border-black/10 bg-[hsl(var(--landing-paper)/.88)] px-4 backdrop-blur-xl dark:border-white/10 sm:px-6">
          <div className="mx-auto flex h-[72px] max-w-7xl items-center justify-between gap-5">
            <Link to="/" aria-label="Cirkle home" className="flex min-h-11 items-center gap-2.5 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2866c7] focus-visible:ring-offset-2">
              <img src={cirkLogo} alt="" className="h-9 w-9 rounded-[10px] shadow-sm" />
              <div className="leading-none">
                <span className="block text-lg font-black tracking-[-0.03em]">Cirkle</span>
                <span className="mt-1 hidden text-[8px] font-bold uppercase tracking-[0.19em] opacity-65 min-[360px]:block">Community network</span>
              </div>
            </Link>

            <nav className="hidden items-center gap-1 rounded-full border border-black/10 bg-white/65 p-1 text-sm font-semibold shadow-sm dark:border-white/10 dark:bg-white/5 md:flex" aria-label="Landing page">
              <a href="#difference" className="rounded-full px-4 py-2 hover:bg-black/5 dark:hover:bg-white/10">Why Cirkle</a>
              <a href="#product" className="rounded-full px-4 py-2 hover:bg-black/5 dark:hover:bg-white/10">Product</a>
              <a href="#communities" className="rounded-full px-4 py-2 hover:bg-black/5 dark:hover:bg-white/10">Communities</a>
              <a href="#how-it-works" className="rounded-full px-4 py-2 hover:bg-black/5 dark:hover:bg-white/10">How it works</a>
            </nav>

            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={goAuth} className="hidden h-11 rounded-xl px-4 text-sm font-semibold sm:inline-flex">Sign in</Button>
              <Button onClick={goAuth} className="landing-cta-shine h-11 rounded-xl bg-[#15171a] px-4 text-sm font-bold text-white hover:bg-[#282b30] dark:bg-white dark:text-black dark:hover:bg-white/90 sm:px-5">
                Join Cirkle <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        </header>

        <main id="main-content">
          <section className="relative overflow-hidden bg-[hsl(var(--landing-peach))] px-4 pb-16 pt-10 dark:bg-[#15181f] sm:px-6 sm:pb-24 sm:pt-16 lg:pt-20">
            <div className="landing-paper-grid pointer-events-none absolute inset-0" aria-hidden="true" />
            <div className="pointer-events-none absolute -left-28 top-6 h-80 w-80 rounded-full bg-white/35 blur-3xl dark:bg-[#2767bf]/10" aria-hidden="true" />
            <div className="pointer-events-none absolute -right-28 bottom-0 h-80 w-80 rounded-full bg-[#efad8f]/35 blur-3xl dark:bg-[#7c4d36]/15" aria-hidden="true" />

            <div className="relative mx-auto grid min-w-0 max-w-7xl items-center gap-12 lg:grid-cols-[1.05fr_.95fr] lg:gap-16">
              <motion.div initial={reduceMotion ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }} className="min-w-0">
                <div className="mb-6 inline-flex max-w-full items-center gap-2 rounded-full border border-black/10 bg-white/65 px-3 py-2 text-[10px] font-extrabold uppercase tracking-[0.15em] shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5 sm:text-[11px]">
                  <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-[#2866c7]" aria-hidden="true" />
                  <span className="truncate">Verified communities · Trusted connections · People-first</span>
                </div>

                <h1 className="landing-text-balance max-w-4xl font-display text-[3.2rem] font-medium leading-[0.94] tracking-[-0.067em] sm:text-7xl lg:text-[5.35rem]">
                  Where your community becomes your <span className="font-black">network.</span>
                </h1>
                <p className="mt-7 max-w-xl text-base font-medium leading-7 opacity-65 sm:text-lg sm:leading-8">
                  Meet the right people, join focused conversations and discover opportunities that already come with shared context.
                </p>

                <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <Button onClick={goAuth} className="landing-cta-shine h-14 rounded-2xl bg-[#15171a] px-6 text-sm font-extrabold text-white shadow-xl shadow-black/10 hover:bg-[#282b30] dark:bg-white dark:text-black dark:hover:bg-white/90">
                    Join your community <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                  </Button>
                  <a href="#how-it-works" className="inline-flex min-h-14 items-center justify-center rounded-2xl border border-black/15 bg-white/40 px-6 text-sm font-bold hover:bg-white/70 dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10">
                    Explore the platform
                  </a>
                </div>

                <div className="mt-8 grid max-w-xl gap-2 text-xs font-semibold opacity-65 sm:grid-cols-3">
                  <span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-[#2866c7]" aria-hidden="true" /> Verified profiles</span>
                  <span className="flex items-center gap-2"><Compass className="h-4 w-4 text-[#2866c7]" aria-hidden="true" /> Relevant rooms</span>
                  <span className="flex items-center gap-2"><UserCheck className="h-4 w-4 text-[#2866c7]" aria-hidden="true" /> Consent-led DMs</span>
                </div>
              </motion.div>

              <motion.div initial={reduceMotion ? false : { opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.68, delay: 0.08, ease: [0.22, 1, 0.36, 1] }} className="relative mx-auto min-w-0 w-full max-w-[550px]">
                <div className="absolute -left-5 top-10 z-20 hidden rounded-2xl border border-black/10 bg-white px-4 py-3 text-xs font-bold text-[#12161d] shadow-xl dark:border-white/10 dark:bg-[#20242c] dark:text-white sm:block">
                  <span className="mb-1 block text-[9px] uppercase tracking-[0.14em] opacity-55">Access</span>
                  <span className="flex items-center gap-2"><BadgeCheck className="h-4 w-4 text-[#2866c7]" aria-hidden="true" /> Community verified</span>
                </div>

                <div className="overflow-hidden rounded-[30px] border border-black/10 bg-[#fffdfa] shadow-[0_30px_80px_rgba(45,27,20,0.18)] dark:border-white/10 dark:bg-[#101319]" role="img" aria-label="Cirkle's verified community forum showing a referral conversation and a consent-based connection request">
                  <div className="flex items-center justify-between border-b border-black/10 px-5 py-4 dark:border-white/10">
                    <div className="flex items-center gap-3">
                      <img src={cirkLogo} alt="" className="h-10 w-10 rounded-xl" />
                      <div><p className="text-sm font-black">My Cirkle</p><p className="text-[10px] font-medium opacity-55">Private · verified members</p></div>
                    </div>
                    <Search className="h-5 w-5 opacity-55" aria-hidden="true" />
                  </div>

                  <div className="grid grid-cols-[84px_1fr] sm:grid-cols-[160px_1fr]">
                    <div className="border-r border-black/10 bg-[#f5f4f0] p-3 dark:border-white/10 dark:bg-white/[0.025]">
                      <p className="mb-3 hidden px-2 text-[9px] font-extrabold uppercase tracking-[0.17em] opacity-50 sm:block">Your circles</p>
                      {["Campus", "Cohort", "Alumni"].map((room, index) => (
                        <div key={room} className={`mb-1 flex items-center gap-2 rounded-xl px-2 py-2.5 text-[10px] font-bold sm:text-xs ${index === 0 ? "bg-white text-[#2866c7] shadow-sm dark:bg-white/10" : "opacity-55"}`}>
                          <span className="text-sm" aria-hidden="true">#</span><span className="truncate">{room}</span>
                        </div>
                      ))}
                    </div>

                    <div className="min-h-[390px] bg-[radial-gradient(circle_at_18px_18px,rgba(40,102,199,.05)_1.2px,transparent_1.4px)] bg-[length:34px_34px] px-4 py-5 sm:px-5">
                      <div className="mx-auto mb-5 w-fit rounded-full border border-black/10 bg-white px-3 py-1 text-[9px] font-bold opacity-55 shadow-sm dark:border-white/10 dark:bg-white/5">Today</div>
                      <div className="max-w-[88%] rounded-2xl rounded-tl-md border border-black/10 bg-white p-3 shadow-sm dark:border-white/10 dark:bg-[#20242c]">
                        <div className="flex items-center gap-2"><div className="flex h-7 w-7 items-center justify-center rounded-full bg-[#d9d5ff] text-[10px] font-black text-[#463ca1]">AK</div><div><p className="text-[11px] font-black">Aarav K.</p><p className="text-[8px] opacity-50">Verified member</p></div></div>
                        <p className="mt-2 text-[11px] leading-5 opacity-75">Sharing the referral opening here first - happy to help anyone from this circle prepare.</p>
                      </div>
                      <div className="ml-auto mt-3 max-w-[82%] rounded-2xl rounded-tr-md bg-[#d4f0e4] p-3 text-[#101714] dark:bg-[#194334] dark:text-white">
                        <p className="text-[11px] leading-5">This is exactly the context I needed. Sending a connection request.</p>
                        <p className="mt-1 text-right text-[8px] opacity-50">10:42 AM</p>
                      </div>
                      <div className="mt-3 flex items-center gap-2 rounded-2xl border border-[#2866c7]/15 bg-[#eaf2fc] p-3 dark:bg-[#17283e]">
                        <UserCheck className="h-5 w-5 shrink-0 text-[#2866c7]" aria-hidden="true" />
                        <div><p className="text-[10px] font-black">Connection request sent</p><p className="text-[9px] opacity-55">Chat opens after acceptance</p></div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="absolute -bottom-5 right-4 z-20 rounded-2xl border border-black/10 bg-[#15171a] px-4 py-3 text-white shadow-xl dark:border-white/10 sm:right-8">
                  <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-white/65">Built for belonging</p>
                  <p className="mt-1 text-xs font-extrabold">No follower race. No cold inbox.</p>
                </div>
              </motion.div>
            </div>
          </section>

          <section className="border-y border-black/10 bg-white py-4 dark:border-white/10 dark:bg-[#0e1218]" aria-label="Cirkle principles">
            <div className="landing-signal-viewport overflow-hidden">
              <div className="landing-signal-track">
                {[0, 1].map((copy) => (
                  <div key={copy} aria-hidden={copy === 1} className="flex shrink-0 items-center">
                    {SIGNALS.map((signal) => (
                      <div key={`${copy}-${signal}`} className="flex items-center gap-3 whitespace-nowrap px-5 text-[10px] font-extrabold uppercase tracking-[0.17em] opacity-65 sm:px-8 sm:text-[11px]">
                        <CircleDot className="h-3.5 w-3.5 text-[#2866c7]" aria-hidden="true" /> {signal}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section id="difference" className="px-4 py-20 sm:px-6 sm:py-28">
            <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[.92fr_1.08fr] lg:items-center lg:gap-20">
              <motion.div {...REVEAL}>
                <p className="mb-4 text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#2866c7]">A different starting point</p>
                <h2 className="landing-text-balance font-display text-4xl font-medium leading-[1.01] tracking-[-0.055em] sm:text-6xl">A network should know the context before the first hello.</h2>
                <p className="mt-6 max-w-2xl text-sm leading-7 opacity-65 sm:text-base">Most platforms make you assemble relevance from profiles, followers and cold outreach. Cirkle begins with the community you share, then helps useful relationships grow from there.</p>
                <button onClick={goAuth} className="landing-link-line mt-7 inline-flex min-h-11 items-center gap-2 text-sm font-extrabold text-[#2866c7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2866c7]">
                  Start with your community <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </motion.div>

              <motion.div {...REVEAL} className="overflow-hidden rounded-[30px] border border-black/10 bg-[#101317] p-4 text-white shadow-[0_28px_80px_-42px_rgba(16,19,23,.9)] sm:p-6">
                <div className="flex items-center justify-between border-b border-white/10 pb-5">
                  <div>
                    <p className="text-[9px] font-extrabold uppercase tracking-[0.17em] text-white/70">Cirkle logic</p>
                    <p className="mt-1 text-sm font-black">Relevance is part of the architecture</p>
                  </div>
                  <div className="grid h-10 w-10 place-items-center rounded-2xl bg-white/10"><BadgeCheck className="h-5 w-5 text-[#7eddb9]" aria-hidden="true" /></div>
                </div>
                <div className="divide-y divide-white/10">
                  {[
                    ["Instead of a public feed", "Enter the rooms you belong to"],
                    ["Instead of a cold inbox", "Connect by mutual consent"],
                    ["Instead of claimed context", "Verify meaningful membership"],
                  ].map(([before, after], index) => (
                    <div key={before} className="grid gap-3 py-5 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                      <p className="text-xs font-medium text-white/65">{before}</p>
                      <ChevronRight className="hidden h-4 w-4 text-white/25 sm:block" aria-hidden="true" />
                      <div className="flex items-center gap-2 text-sm font-bold"><span className="grid h-6 w-6 place-items-center rounded-full bg-[#2866c7] text-[9px]">0{index + 1}</span>{after}</div>
                    </div>
                  ))}
                </div>
              </motion.div>
            </div>
          </section>

          <section id="product" className="border-y border-black/10 bg-white px-4 py-20 dark:border-white/10 dark:bg-[#0e1218] sm:px-6 sm:py-28">
            <div className="mx-auto max-w-7xl">
              <motion.div {...REVEAL} className="mb-12 grid gap-6 lg:grid-cols-[1fr_.7fr] lg:items-end">
                <div>
                  <p className="mb-4 text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#2866c7]">One place, less noise</p>
                  <h2 className="landing-text-balance max-w-4xl font-display text-4xl font-medium leading-[1.01] tracking-[-0.055em] sm:text-6xl">Everything a real community needs to stay useful.</h2>
                </div>
                <p className="max-w-xl text-sm leading-7 opacity-65 sm:text-base">The immediacy of a group conversation, the clarity of a professional network and the trust of a space with meaningful access.</p>
              </motion.div>

              <div className="grid gap-4 lg:grid-cols-12">
                {PRODUCT_FEATURES.map((feature, index) => (
                  <motion.article key={feature.title} {...REVEAL} transition={{ ...REVEAL.transition, delay: index * 0.05 }} className={`landing-feature-card min-h-[320px] rounded-[30px] border border-black/10 p-6 dark:border-white/10 sm:p-8 ${feature.className}`}>
                    <div className="flex items-start justify-between gap-5">
                      <div className="grid h-12 w-12 place-items-center rounded-2xl border border-black/10 bg-white/55 dark:border-white/10 dark:bg-white/5"><feature.icon className="h-5 w-5" aria-hidden="true" /></div>
                      <span className="font-mono text-[10px] font-bold opacity-50" aria-hidden="true">0{index + 1}</span>
                    </div>
                    <div className="mt-12 max-w-xl">
                      <p className="text-[10px] font-extrabold uppercase tracking-[0.17em] opacity-65">{feature.eyebrow}</p>
                      <h3 className="landing-text-balance mt-3 text-2xl font-black leading-tight tracking-[-0.038em] sm:text-3xl">{feature.title}</h3>
                      <p className="mt-4 max-w-lg text-sm leading-6 opacity-65">{feature.description}</p>
                      <div className="mt-6 flex flex-wrap gap-2">
                        {feature.tags.map((tag) => <span key={tag} className="rounded-full border border-black/10 bg-white/45 px-3 py-1.5 text-[9px] font-bold dark:border-white/10 dark:bg-white/5 sm:text-[10px]">{tag}</span>)}
                      </div>
                    </div>
                  </motion.article>
                ))}
              </div>
            </div>
          </section>

          <section id="communities" className="bg-[#101317] px-4 py-20 text-white sm:px-6 sm:py-28">
            <div className="mx-auto max-w-7xl">
              <motion.div {...REVEAL} className="grid gap-10 lg:grid-cols-[.9fr_1.1fr] lg:items-end">
                <div>
                  <p className="mb-4 text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#f3b99e]">A network of networks</p>
                  <h2 className="landing-text-balance font-display text-4xl font-medium leading-[1.01] tracking-[-0.055em] sm:text-6xl">Built around belonging, not broadcasting.</h2>
                </div>
                <p className="max-w-2xl text-sm leading-7 text-white/70 sm:text-base">Each community keeps its identity, boundaries and useful shared context. Trusted connections can grow across the wider network without turning every member into a broadcaster.</p>
              </motion.div>

              <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {COMMUNITY_TYPES.map((type, index) => (
                  <motion.article key={type.label} {...REVEAL} transition={{ ...REVEAL.transition, delay: index * 0.05 }} className="group rounded-[26px] border border-white/10 bg-white/[0.045] p-5 transition-colors hover:bg-white/[0.075] motion-reduce:transition-none sm:p-6">
                    <div className="grid h-11 w-11 place-items-center rounded-2xl bg-white/[0.07] text-[#f3b99e] transition-transform duration-300 group-hover:-translate-y-1 motion-reduce:transform-none motion-reduce:transition-none"><type.icon className="h-5 w-5" aria-hidden="true" /></div>
                    <h3 className="mt-12 text-base font-extrabold">{type.label}</h3>
                    <p className="mt-2 text-xs leading-5 text-white/70">{type.caption}</p>
                  </motion.article>
                ))}
              </div>

              <motion.div {...REVEAL} className="mt-5 rounded-[26px] border border-white/10 bg-[linear-gradient(115deg,rgba(40,102,199,.28),rgba(255,255,255,.045))] p-6 sm:flex sm:items-center sm:justify-between sm:gap-8 sm:p-8">
                <div>
                  <p className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#9fc3ff]">Campus communities are the first chapter</p>
                  <p className="mt-2 max-w-2xl text-lg font-bold">A focused beginning for a network designed to grow without losing the feeling of belonging.</p>
                </div>
                <Button onClick={goAuth} className="mt-5 h-12 shrink-0 rounded-xl bg-white px-5 font-bold text-black hover:bg-white/90 sm:mt-0">Find my Cirkle <ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" /></Button>
              </motion.div>
            </div>
          </section>

          <section id="how-it-works" className="bg-[hsl(var(--landing-mint))] px-4 py-20 sm:px-6 sm:py-28">
            <div className="mx-auto max-w-7xl">
              <motion.div {...REVEAL} className="mx-auto max-w-3xl text-center">
                <p className="mb-4 text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#176248] dark:text-[#7eddb9]">Simple by design</p>
                <h2 className="landing-text-balance font-display text-4xl font-medium leading-[1.01] tracking-[-0.055em] sm:text-6xl">Your identity. Your rooms. Your pace.</h2>
                <p className="mx-auto mt-5 max-w-2xl text-sm leading-7 opacity-65 sm:text-base">Cirkle does the organisational work before the conversation begins, so joining feels clear instead of overwhelming.</p>
              </motion.div>

              <ol className="mt-14 grid gap-4 lg:grid-cols-3">
                {[
                  { number: "01", title: "Verify your place", body: "Confirm who you are and the community context you genuinely belong to.", icon: ShieldCheck },
                  { number: "02", title: "Enter relevant rooms", body: "Move into the circles matched to your community membership and profile context.", icon: Compass },
                  { number: "03", title: "Participate with trust", body: "Join forums, discover opportunities and connect one-to-one by mutual consent.", icon: MessageCircleMore },
                ].map((step, index) => (
                  <motion.li key={step.number} {...REVEAL} transition={{ ...REVEAL.transition, delay: index * 0.06 }} className="rounded-[28px] border border-black/10 bg-white/60 p-6 backdrop-blur dark:border-white/10 dark:bg-white/5 sm:p-8">
                    <div className="flex items-center justify-between"><span className="font-mono text-xs font-bold opacity-60">{step.number}</span><step.icon className="h-6 w-6 text-[#176248] dark:text-[#7eddb9]" aria-hidden="true" /></div>
                    <h3 className="mt-16 text-2xl font-black tracking-[-0.035em]">{step.title}</h3>
                    <p className="mt-3 text-sm leading-6 opacity-65">{step.body}</p>
                  </motion.li>
                ))}
              </ol>
            </div>
          </section>

          <section id="journey" className="relative overflow-hidden px-4 py-20 sm:px-6 sm:py-28">
            <div className="pointer-events-none absolute left-1/2 top-12 h-72 w-72 -translate-x-1/2 rounded-full bg-[#f3b99e]/20 blur-3xl" aria-hidden="true" />
            <div className="relative mx-auto max-w-7xl">
              <motion.div {...REVEAL} className="max-w-3xl">
                <p className="mb-4 text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#b6502e] dark:text-[#f3b99e]">Our journey</p>
                <h2 className="landing-text-balance font-display text-4xl font-medium leading-[1.01] tracking-[-0.055em] sm:text-6xl">Start specific. Grow without losing the Cirkle.</h2>
                <p className="mt-5 max-w-2xl text-sm leading-7 opacity-65 sm:text-base">The network becomes broader over time. The experience stays grounded in identity, relevance and member control.</p>
              </motion.div>

              <div className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                {JOURNEY.map((stop, index) => (
                  <motion.article key={stop.marker} {...REVEAL} transition={{ ...REVEAL.transition, delay: index * 0.05 }} className="relative min-h-[250px] rounded-[28px] border border-black/10 bg-white/68 p-6 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/[0.035]">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-black uppercase tracking-[0.16em] text-[#2866c7]">{stop.marker}</span>
                      {index === JOURNEY.length - 1 ? <InfinityIcon className="h-5 w-5 text-[#b6502e] dark:text-[#f3b99e]" aria-hidden="true" /> : <span className="font-mono text-[10px] opacity-55" aria-hidden="true">0{index + 1}</span>}
                    </div>
                    <h3 className="mt-16 text-xl font-black leading-tight tracking-[-0.03em]">{stop.title}</h3>
                    <p className="mt-3 text-xs leading-5 opacity-65">{stop.body}</p>
                  </motion.article>
                ))}
              </div>
            </div>
          </section>

          <section id="voices" className="border-y border-black/10 bg-white px-4 py-20 dark:border-white/10 dark:bg-[#0e1218] sm:px-6 sm:py-28">
            <div className="mx-auto max-w-7xl">
              <motion.div {...REVEAL} className="grid gap-8 lg:grid-cols-[.76fr_1.24fr] lg:items-end">
                <div>
                  <p className="text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#2866c7]">Voices shaping Cirkle</p>
                  <h2 className="landing-text-balance mt-4 font-display text-4xl font-medium leading-[1.01] tracking-[-0.055em] sm:text-6xl">Design around the need, not the feed.</h2>
                </div>
                <p className="max-w-2xl text-sm leading-7 opacity-65 sm:text-base">These are product principles distilled from early community conversations, not paid endorsements or invented performance claims.</p>
              </motion.div>

              <div className="mt-12 grid gap-4 lg:grid-cols-3">
                {COMMUNITY_NEEDS.map((item, index) => (
                  <motion.figure key={item.role} {...REVEAL} transition={{ ...REVEAL.transition, delay: index * 0.05 }} className="flex min-h-[300px] flex-col rounded-[28px] border border-black/10 bg-[hsl(var(--landing-paper))] p-6 dark:border-white/10 sm:p-8">
                    <Quote className="h-7 w-7 text-[#2866c7]" fill="currentColor" aria-hidden="true" />
                    <blockquote className="landing-text-balance mt-8 flex-1 text-xl font-bold leading-8 tracking-[-0.027em]">“{item.quote}”</blockquote>
                    <figcaption className="mt-8 border-t border-black/10 pt-5 dark:border-white/10">
                      <p className="text-sm font-black">{item.role}</p>
                      <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.14em] opacity-65">{item.context}</p>
                    </figcaption>
                  </motion.figure>
                ))}
              </div>
            </div>
          </section>

          <section className="px-4 py-20 sm:px-6 sm:py-28">
            <motion.div {...REVEAL} className="relative mx-auto max-w-7xl overflow-hidden rounded-[34px] bg-[#2866c7] px-6 py-12 text-white shadow-[0_32px_90px_-30px_rgba(40,102,199,.65)] sm:px-12 sm:py-16">
              <div className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full border-[52px] border-white/[0.07]" aria-hidden="true" />
              <div className="relative grid items-center gap-10 lg:grid-cols-[1fr_auto]">
                <div>
                  <p className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-white/90">Your next useful connection already has context</p>
                  <h2 className="landing-text-balance mt-4 max-w-4xl font-display text-4xl font-medium leading-[1.01] tracking-[-0.055em] sm:text-6xl">Find the people who already get where you come from.</h2>
                  <p className="mt-5 max-w-2xl text-sm leading-7 text-white/90 sm:text-base">Create your profile, verify your community and step into conversations and opportunities that feel relevant from day one.</p>
                </div>
                <Button onClick={goAuth} className="landing-cta-shine h-14 rounded-2xl bg-white px-7 font-extrabold text-black hover:bg-white/90">Create my profile <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" /></Button>
              </div>
            </motion.div>
          </section>

          <section className="border-t border-black/10 px-4 py-20 dark:border-white/10 sm:px-6 sm:py-24">
            <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[.72fr_1.28fr]">
              <motion.div {...REVEAL}>
                <p className="text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#2866c7]">Questions, answered</p>
                <h2 className="landing-text-balance mt-4 font-display text-4xl font-medium tracking-[-0.055em] sm:text-5xl">Clear before you join.</h2>
              </motion.div>
              <div className="divide-y divide-black/10 border-y border-black/10 dark:divide-white/10 dark:border-white/10">
                {FAQS.map((faq) => (
                  <details key={faq.question} className="group py-1">
                    <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-5 rounded-sm py-4 text-sm font-extrabold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2866c7] sm:text-base">
                      {faq.question}<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-black/10 text-lg font-normal transition-transform group-open:rotate-45 motion-reduce:transform-none motion-reduce:transition-none dark:border-white/10" aria-hidden="true">+</span>
                    </summary>
                    <p className="max-w-2xl pb-6 pr-10 text-sm leading-7 opacity-65">{faq.answer}</p>
                  </details>
                ))}
              </div>
            </div>
          </section>
        </main>

        <footer className="border-t border-black/10 bg-white px-4 py-8 dark:border-white/10 dark:bg-[#0e1218] sm:px-6">
          <div className="mx-auto flex max-w-7xl flex-col gap-7 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2.5"><img src={cirkLogo} alt="" className="h-8 w-8 rounded-lg" /><div><p className="text-sm font-black">Cirkle.World</p><p className="text-[9px] font-bold uppercase tracking-[0.14em] opacity-65">Verified community networking</p></div></div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs font-semibold opacity-65">
              <button onClick={goAuth} className="inline-flex min-h-11 items-center hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2866c7]">Member sign in</button>
              <Link to="/privacy" className="inline-flex min-h-11 items-center hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2866c7]">Privacy</Link>
              <Link to="/terms" className="inline-flex min-h-11 items-center hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2866c7]">Terms</Link>
              <span>© 2026 Cirkle.World</span>
            </div>
          </div>
        </footer>
      </div>
    </MotionConfig>
  );
};

export default Landing;
