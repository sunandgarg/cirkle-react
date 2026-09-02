import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowRight,
  BadgeCheck,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  ChevronRight,
  CircleDot,
  Handshake,
  LockKeyhole,
  MessageCircleMore,
  MessagesSquare,
  Network,
  Search,
  ShieldCheck,
  Sparkles,
  UserCheck,
  UsersRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useMetaTags } from "@/hooks/useMetaTags";
import cirkLogo from "@/assets/cirkle-logo.png";

const PRODUCT_FEATURES = [
  {
    icon: MessagesSquare,
    eyebrow: "Focused forums",
    title: "The right conversation, already in the right room.",
    description: "Members are placed into relevant community spaces by shared context - not follower counts or noisy algorithms.",
    accent: "bg-[#f5c8b5] dark:bg-[#44291f]",
  },
  {
    icon: Handshake,
    eyebrow: "Trusted connections",
    title: "Connect with context before the first message.",
    description: "A request must be accepted before one-to-one chat opens, keeping outreach intentional and member-controlled.",
    accent: "bg-[#cce9df] dark:bg-[#183a32]",
  },
  {
    icon: BriefcaseBusiness,
    eyebrow: "Relevant opportunities",
    title: "Jobs and expertise travel through real communities.",
    description: "Discover opportunities, people and practical guidance shaped by the circles you genuinely belong to.",
    accent: "bg-[#d9d5ff] dark:bg-[#29264d]",
  },
  {
    icon: CalendarDays,
    eyebrow: "Community moments",
    title: "Know what matters before it passes you by.",
    description: "Events and updates are organised around member relevance, with your own community surfaced first.",
    accent: "bg-[#f9e7a8] dark:bg-[#473b16]",
  },
];

const COMMUNITY_TYPES = [
  { label: "Campus networks", caption: "Students, cohorts and alumni", icon: UsersRound },
  { label: "Professional circles", caption: "Teams, functions and operators", icon: Network },
  { label: "Alumni communities", caption: "People connected by shared history", icon: BadgeCheck },
  { label: "Curated collectives", caption: "Creators, experts and niche groups", icon: Sparkles },
];

const FAQS = [
  {
    question: "What does invite-only mean on Cirkle?",
    answer: "Cirkle opens one community at a time. Access depends on a community invitation or a verifiable relationship with an active circle, rather than an unrestricted public signup.",
  },
  {
    question: "Is Cirkle only for IIT communities?",
    answer: "No. Verified campus communities are Cirkle's first live rollout and proof of the model. The platform is built for community-specific networks across institutions, alumni groups, professions and curated collectives.",
  },
  {
    question: "Can anyone message me?",
    answer: "No. One-to-one messaging opens only after you accept a connection request. Community forums remain scoped to the rooms your membership allows you to access.",
  },
  {
    question: "How is this different from a public social network?",
    answer: "Cirkle starts with shared context, verified access and relevant rooms. It is designed for useful participation - not public follower races, viral reach or unsolicited inbox traffic.",
  },
];

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.2 },
  transition: { duration: 0.55, ease: "easeOut" as const },
};

const Landing = () => {
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  useMetaTags({
    title: "Cirkle - Invite-only community-specific networking",
    description: "Cirkle is the private networking platform for verified communities: focused forums, trusted connections, relevant opportunities, events and expert access.",
    ogTitle: "Cirkle - Find the network you actually belong in",
    ogDescription: "Invite-only, community-specific networking built around shared context - not public follower counts.",
    ogImage: "https://cirkle.world/cirkle-logo.png",
    ogUrl: "https://cirkle.world",
    canonicalUrl: "https://cirkle.world",
    keywords: "private community platform, invite-only network, community networking, alumni network, professional community, verified community, community forum",
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
    <div className="min-h-screen touch-pan-y overflow-x-hidden bg-[#fbfaf8] text-[#12161d] selection:bg-[#1f68c5] selection:text-white dark:bg-[#0b0e13] dark:text-[#f4f6f8]">
      <div className="border-b border-black/10 bg-[#121212] px-4 py-2.5 text-center text-[11px] font-semibold tracking-wide text-white dark:border-white/10 sm:text-xs">
        <span className="mr-2 text-[#f4bd69]">●</span>
        Cirkle is opening community by community.
        <button onClick={goAuth} className="ml-2 underline decoration-white/40 underline-offset-4 hover:decoration-white">Check your access</button>
      </div>

      <header className="sticky top-0 z-50 border-b border-black/10 bg-[#fbfaf8]/90 px-4 backdrop-blur-xl dark:border-white/10 dark:bg-[#0b0e13]/90 sm:px-6">
        <div className="mx-auto flex h-[72px] max-w-7xl items-center justify-between gap-5">
          <Link to="/" className="flex min-h-11 items-center gap-2.5 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1f68c5] focus-visible:ring-offset-2">
            <img src={cirkLogo} alt="" className="h-9 w-9 rounded-[10px] shadow-sm" />
            <div className="leading-none">
              <span className="block text-lg font-black tracking-[-0.03em]">Cirkle</span>
              <span className="mt-1 block text-[8px] font-bold uppercase tracking-[0.19em] text-black/48 dark:text-white/48">Community network</span>
            </div>
          </Link>

          <nav className="hidden items-center gap-1 rounded-full border border-black/10 bg-white/75 p-1 text-sm font-medium shadow-sm dark:border-white/10 dark:bg-white/5 md:flex" aria-label="Main navigation">
            <a href="#product" className="rounded-full px-4 py-2 hover:bg-black/5 dark:hover:bg-white/8">Product</a>
            <a href="#communities" className="rounded-full px-4 py-2 hover:bg-black/5 dark:hover:bg-white/8">For communities</a>
            <a href="#how-it-works" className="rounded-full px-4 py-2 hover:bg-black/5 dark:hover:bg-white/8">How it works</a>
          </nav>

          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={goAuth} className="hidden h-11 rounded-xl px-4 text-sm font-semibold sm:inline-flex">Sign in</Button>
            <Button onClick={goAuth} className="h-11 rounded-xl bg-[#151515] px-4 text-sm font-bold text-white hover:bg-[#292929] dark:bg-white dark:text-black dark:hover:bg-white/90 sm:px-5">
              Find my Cirkle <ArrowRight className="ml-1.5 h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main id="main-content">
        <section className="relative overflow-hidden bg-[#f3d8cc] px-4 pb-16 pt-12 dark:bg-[#15181f] sm:px-6 sm:pb-24 sm:pt-20">
          <div className="pointer-events-none absolute -left-28 top-10 h-80 w-80 rounded-full bg-white/35 blur-3xl dark:bg-[#2767bf]/10" />
          <div className="pointer-events-none absolute bottom-0 right-0 h-72 w-72 rounded-full bg-[#efad8f]/35 blur-3xl dark:bg-[#7c4d36]/15" />
          <div className="relative mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[1.05fr_.95fr] lg:gap-16">
            <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55 }}>
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-black/10 bg-white/55 px-3 py-2 text-[10px] font-extrabold uppercase tracking-[0.16em] shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5 sm:text-[11px]">
                <LockKeyhole className="h-3.5 w-3.5 text-[#1f68c5]" /> Invite-only · Community-specific · People-first
              </div>
              <h1 className="max-w-3xl font-display text-[3.25rem] font-medium leading-[0.94] tracking-[-0.065em] sm:text-7xl lg:text-[5.35rem]">
                The network that starts with what you <span className="font-black">share.</span>
              </h1>
              <p className="mt-7 max-w-xl text-base font-medium leading-7 text-black/66 dark:text-white/66 sm:text-lg sm:leading-8">
                Cirkle brings verified communities into one private network - for focused conversations, trusted connections and opportunities that arrive with context.
              </p>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                <Button onClick={goAuth} className="h-14 rounded-2xl bg-[#151515] px-6 text-sm font-extrabold text-white shadow-xl shadow-black/10 hover:bg-[#292929] dark:bg-white dark:text-black dark:hover:bg-white/90">
                  Check my community access <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
                <a href="#how-it-works" className="inline-flex min-h-14 items-center justify-center rounded-2xl border border-black/15 bg-white/35 px-6 text-sm font-bold hover:bg-white/60 dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10">
                  See how it works
                </a>
              </div>

              <div className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-xs font-semibold text-black/56 dark:text-white/55">
                <span className="flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-[#1f68c5]" /> Verified entry</span>
                <span className="flex items-center gap-1.5"><Check className="h-4 w-4 text-[#1f68c5]" /> Relevant rooms</span>
                <span className="flex items-center gap-1.5"><MessageCircleMore className="h-4 w-4 text-[#1f68c5]" /> Permission-first DMs</span>
              </div>
            </motion.div>

            <motion.div initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.65, delay: 0.1 }} className="relative mx-auto w-full max-w-[550px]">
              <div className="absolute -left-5 top-10 hidden rounded-2xl border border-black/10 bg-white px-4 py-3 text-xs font-bold shadow-xl dark:border-white/10 dark:bg-[#20242c] sm:block">
                <span className="mb-1 block text-[9px] uppercase tracking-[0.14em] text-black/45 dark:text-white/45">Access</span>
                <span className="flex items-center gap-2"><BadgeCheck className="h-4 w-4 text-[#1f68c5]" /> Community verified</span>
              </div>

              <div className="overflow-hidden rounded-[30px] border border-black/10 bg-[#fffdfa] shadow-[0_30px_80px_rgba(45,27,20,0.18)] dark:border-white/10 dark:bg-[#101319]">
                <div className="flex items-center justify-between border-b border-black/8 px-5 py-4 dark:border-white/8">
                  <div className="flex items-center gap-3">
                    <img src={cirkLogo} alt="" className="h-10 w-10 rounded-xl" />
                    <div><p className="text-sm font-black">My Cirkle</p><p className="text-[10px] font-medium text-black/48 dark:text-white/48">Private · verified members</p></div>
                  </div>
                  <Search className="h-5 w-5 text-black/45 dark:text-white/45" />
                </div>

                <div className="grid grid-cols-[84px_1fr] sm:grid-cols-[160px_1fr]">
                  <aside className="border-r border-black/8 bg-[#f5f4f0] p-3 dark:border-white/8 dark:bg-white/[0.025]">
                    <p className="mb-3 hidden px-2 text-[9px] font-extrabold uppercase tracking-[0.17em] text-black/38 dark:text-white/38 sm:block">Your circles</p>
                    {["Campus", "Cohort", "Alumni"].map((room, index) => (
                      <div key={room} className={`mb-1 flex items-center gap-2 rounded-xl px-2 py-2.5 text-[10px] font-bold sm:text-xs ${index === 0 ? "bg-white text-[#1f68c5] shadow-sm dark:bg-white/8" : "text-black/45 dark:text-white/45"}`}>
                        <span className="text-sm">#</span><span className="truncate">{room}</span>
                      </div>
                    ))}
                  </aside>

                  <div className="min-h-[390px] bg-[radial-gradient(circle_at_18px_18px,rgba(31,104,197,.04)_1.2px,transparent_1.4px)] bg-[length:34px_34px] px-4 py-5 sm:px-5">
                    <div className="mx-auto mb-5 w-fit rounded-full border border-black/8 bg-white px-3 py-1 text-[9px] font-bold text-black/45 shadow-sm dark:border-white/8 dark:bg-white/5 dark:text-white/45">Today</div>
                    <div className="max-w-[88%] rounded-2xl rounded-tl-md border border-black/8 bg-white p-3 shadow-sm dark:border-white/8 dark:bg-[#20242c]">
                      <div className="flex items-center gap-2"><div className="flex h-7 w-7 items-center justify-center rounded-full bg-[#d9d5ff] text-[10px] font-black text-[#463ca1]">AK</div><div><p className="text-[11px] font-black">Aarav K.</p><p className="text-[8px] text-black/42 dark:text-white/42">Verified member</p></div></div>
                      <p className="mt-2 text-[11px] leading-5 text-black/72 dark:text-white/72">Sharing the referral opening here first - happy to help anyone from this circle prepare.</p>
                    </div>
                    <div className="ml-auto mt-3 max-w-[82%] rounded-2xl rounded-tr-md bg-[#d4f0e4] p-3 dark:bg-[#194334]">
                      <p className="text-[11px] leading-5">This is exactly the context I needed. Sending a connection request.</p>
                      <p className="mt-1 text-right text-[8px] text-black/38 dark:text-white/38">10:42 AM</p>
                    </div>
                    <div className="mt-3 flex items-center gap-2 rounded-2xl border border-[#1f68c5]/15 bg-[#eaf2fc] p-3 dark:bg-[#17283e]">
                      <UserCheck className="h-5 w-5 shrink-0 text-[#1f68c5]" />
                      <div><p className="text-[10px] font-black">Connection request sent</p><p className="text-[9px] text-black/48 dark:text-white/48">Chat opens after acceptance</p></div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="absolute -bottom-5 right-4 rounded-2xl border border-black/10 bg-[#151515] px-4 py-3 text-white shadow-xl dark:border-white/10 sm:right-8">
                <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-white/50">Built for belonging</p>
                <p className="mt-1 text-xs font-extrabold">No follower race. No cold inbox.</p>
              </div>
            </motion.div>
          </div>
        </section>

        <section className="border-y border-black/10 bg-white px-4 py-6 dark:border-white/10 dark:bg-[#0f1218] sm:px-6">
          <div className="mx-auto grid max-w-7xl grid-cols-2 gap-4 text-center sm:grid-cols-4 sm:text-left">
            {["Verified identity", "Context-first rooms", "Member-controlled access", "Server-saved conversations"].map((item) => (
              <div key={item} className="flex items-center justify-center gap-2 text-[11px] font-bold text-black/58 dark:text-white/58 sm:justify-start sm:text-xs">
                <CircleDot className="h-3.5 w-3.5 text-[#1f68c5]" /> {item}
              </div>
            ))}
          </div>
        </section>

        <section id="product" className="px-4 py-20 dark:bg-[#0b0e13] sm:px-6 sm:py-28">
          <motion.div {...reveal} className="mx-auto max-w-7xl">
            <div className="mb-12 max-w-3xl">
              <p className="mb-4 text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#1f68c5]">One place, less noise</p>
              <h2 className="font-display text-4xl font-medium leading-[1.02] tracking-[-0.05em] sm:text-6xl">Everything a real community needs to stay useful.</h2>
              <p className="mt-5 max-w-2xl text-sm leading-7 text-black/55 dark:text-white/55 sm:text-base">Cirkle combines the immediacy of group chat with the context and trust of a private professional network.</p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              {PRODUCT_FEATURES.map((feature, index) => (
                <motion.article key={feature.title} {...reveal} transition={{ ...reveal.transition, delay: index * 0.06 }} className="group min-h-[300px] rounded-[28px] border border-black/10 bg-white p-6 shadow-sm transition-transform duration-300 hover:-translate-y-1 dark:border-white/10 dark:bg-[#11151c] sm:p-8">
                  <div className={`mb-10 flex h-12 w-12 items-center justify-center rounded-2xl ${feature.accent}`}><feature.icon className="h-5 w-5" /></div>
                  <p className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-black/42 dark:text-white/42">{feature.eyebrow}</p>
                  <h3 className="mt-3 max-w-lg text-2xl font-black leading-tight tracking-[-0.035em] sm:text-3xl">{feature.title}</h3>
                  <p className="mt-4 max-w-lg text-sm leading-6 text-black/55 dark:text-white/55">{feature.description}</p>
                </motion.article>
              ))}
            </div>
          </motion.div>
        </section>

        <section id="communities" className="bg-[#151515] px-4 py-20 text-white sm:px-6 sm:py-28">
          <div className="mx-auto max-w-7xl">
            <motion.div {...reveal} className="grid gap-12 lg:grid-cols-[.85fr_1.15fr] lg:items-end">
              <div>
                <p className="mb-4 text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#f3b99e]">A network of networks</p>
                <h2 className="font-display text-4xl font-medium leading-[1.02] tracking-[-0.05em] sm:text-6xl">Built around belonging - not broadcasting.</h2>
              </div>
              <p className="max-w-2xl text-sm leading-7 text-white/58 sm:text-base">Public platforms ask everyone to perform for everyone. Cirkle gives each community its own boundaries, shared context and way to participate - then lets trusted connections grow naturally across them.</p>
            </motion.div>

            <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {COMMUNITY_TYPES.map((type, index) => (
                <motion.div key={type.label} {...reveal} transition={{ ...reveal.transition, delay: index * 0.06 }} className="rounded-[24px] border border-white/10 bg-white/[0.045] p-5 hover:bg-white/[0.075]">
                  <type.icon className="mb-8 h-6 w-6 text-[#f3b99e]" />
                  <h3 className="text-base font-extrabold">{type.label}</h3>
                  <p className="mt-2 text-xs leading-5 text-white/48">{type.caption}</p>
                </motion.div>
              ))}
            </div>

            <div className="mt-8 rounded-[28px] border border-white/10 bg-[#202020] p-6 sm:flex sm:items-center sm:justify-between sm:gap-8 sm:p-8">
              <div><p className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#f3b99e]">Current rollout</p><p className="mt-2 max-w-2xl text-lg font-bold">Cirkle is proving the model with verified campus circles, then opening carefully to more community types.</p></div>
              <Button onClick={goAuth} className="mt-5 h-12 shrink-0 rounded-xl bg-white px-5 font-bold text-black hover:bg-white/90 sm:mt-0">Explore access <ChevronRight className="ml-1 h-4 w-4" /></Button>
            </div>
          </div>
        </section>

        <section id="how-it-works" className="bg-[#cfe9df] px-4 py-20 text-[#101714] dark:bg-[#11231e] dark:text-white sm:px-6 sm:py-28">
          <div className="mx-auto max-w-7xl">
            <motion.div {...reveal} className="mx-auto max-w-3xl text-center">
              <p className="mb-4 text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#156248] dark:text-[#77d4b3]">Simple by design</p>
              <h2 className="font-display text-4xl font-medium leading-[1.02] tracking-[-0.05em] sm:text-6xl">Your people. Your rooms. Your pace.</h2>
              <p className="mx-auto mt-5 max-w-2xl text-sm leading-7 text-black/58 dark:text-white/58 sm:text-base">No community hunting, room creation maze or open inbox. Cirkle does the organisational work before the conversation begins.</p>
            </motion.div>

            <div className="mt-14 grid gap-4 lg:grid-cols-3">
              {[
                { number: "01", title: "Verify your place", body: "Confirm who you are and the community context you belong to.", icon: ShieldCheck },
                { number: "02", title: "Enter relevant rooms", body: "Cirkle maps you to the right circles using community membership and profile context.", icon: Network },
                { number: "03", title: "Participate with trust", body: "Talk in forums, discover opportunities and connect one-to-one by mutual consent.", icon: MessageCircleMore },
              ].map((step, index) => (
                <motion.article key={step.number} {...reveal} transition={{ ...reveal.transition, delay: index * 0.08 }} className="rounded-[26px] border border-black/10 bg-white/68 p-6 backdrop-blur dark:border-white/10 dark:bg-white/5 sm:p-8">
                  <div className="flex items-center justify-between"><span className="font-mono text-xs font-bold text-black/35 dark:text-white/35">{step.number}</span><step.icon className="h-6 w-6 text-[#156248] dark:text-[#77d4b3]" /></div>
                  <h3 className="mt-14 text-2xl font-black tracking-[-0.035em]">{step.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-black/55 dark:text-white/55">{step.body}</p>
                </motion.article>
              ))}
            </div>
          </div>
        </section>

        <section className="px-4 py-20 sm:px-6 sm:py-28">
          <motion.div {...reveal} className="mx-auto max-w-7xl overflow-hidden rounded-[32px] bg-[#1f68c5] px-6 py-12 text-white shadow-[0_30px_90px_rgba(31,104,197,.25)] sm:px-12 sm:py-16">
            <div className="grid items-center gap-10 lg:grid-cols-[1fr_auto]">
              <div>
                <p className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-white/62">The next useful conversation is already inside your circle</p>
                <h2 className="mt-4 max-w-4xl font-display text-4xl font-medium leading-[1.02] tracking-[-0.05em] sm:text-6xl">Find the network you actually belong in.</h2>
                <p className="mt-5 max-w-2xl text-sm leading-7 text-white/72 sm:text-base">Check whether your community is live. New community categories will open carefully as the network expands.</p>
              </div>
              <Button onClick={goAuth} className="h-14 rounded-2xl bg-white px-7 font-extrabold text-black hover:bg-white/90">Find my Cirkle <ArrowRight className="ml-2 h-4 w-4" /></Button>
            </div>
          </motion.div>
        </section>

        <section className="border-t border-black/10 px-4 py-20 dark:border-white/10 sm:px-6 sm:py-24">
          <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[.7fr_1.3fr]">
            <motion.div {...reveal}>
              <p className="text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#1f68c5]">Questions, answered</p>
              <h2 className="mt-4 font-display text-4xl font-medium tracking-[-0.05em] sm:text-5xl">Clear before you join.</h2>
            </motion.div>
            <div className="divide-y divide-black/10 border-y border-black/10 dark:divide-white/10 dark:border-white/10">
              {FAQS.map((faq) => (
                <details key={faq.question} className="group py-1">
                  <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-5 py-4 text-sm font-extrabold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1f68c5] sm:text-base">
                    {faq.question}<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-black/10 text-lg font-normal transition-transform group-open:rotate-45 dark:border-white/10">+</span>
                  </summary>
                  <p className="max-w-2xl pb-6 pr-10 text-sm leading-7 text-black/55 dark:text-white/55">{faq.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-black/10 bg-white px-4 py-8 dark:border-white/10 dark:bg-[#0f1218] sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-7 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5"><img src={cirkLogo} alt="" className="h-8 w-8 rounded-lg" /><div><p className="text-sm font-black">Cirkle.World</p><p className="text-[9px] font-bold uppercase tracking-[0.14em] text-black/38 dark:text-white/38">Invite-only community networking</p></div></div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-xs font-semibold text-black/52 dark:text-white/52">
            <button onClick={goAuth} className="hover:text-black dark:hover:text-white">Member sign in</button>
            <Link to="/privacy" className="hover:text-black dark:hover:text-white">Privacy</Link>
            <Link to="/terms" className="hover:text-black dark:hover:text-white">Terms</Link>
            <span className="text-black/30 dark:text-white/30">© 2026 Cirkle.World</span>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Landing;
