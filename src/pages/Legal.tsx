import { ArrowLeft } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

const termsSections = [
  ["Acceptance of terms", "By accessing or using Cirkle.World, you agree to these Terms of Service and our Privacy Policy."],
  ["Your account", "You must provide accurate information, keep your account secure and notify us if you believe it has been compromised."],
  ["Community conduct", "Harassment, impersonation, spam, unlawful content and attempts to disrupt the service are prohibited. Room access is assigned by Cirkle according to verified academic details."],
  ["Your content", "You retain ownership of content you submit. You grant Cirkle a non-exclusive licence to host, process and display that content only as needed to operate the service."],
  ["Moderation", "Cirkle may remove content or suspend accounts that violate these terms, community safety requirements or applicable law."],
  ["Service availability", "The service is provided on an as-available basis. Features may change as we improve reliability, security and the member experience."],
  ["Contact", "Questions about these terms can be sent to support@cirkle.world."],
] as const;

const privacySections = [
  ["Information we collect", "We collect account identifiers, verified email addresses, profile and academic details, content you submit, connection activity and technical usage information required to provide and secure Cirkle."],
  ["Google sign-in", "If you choose Google sign-in, Google provides your name, email address and profile picture. We use this information only to authenticate you, create or update your Cirkle profile and protect your account."],
  ["How we use information", "We use information to authenticate members, assign eligible community rooms, deliver messages, facilitate connections, prevent abuse and improve the service."],
  ["Sharing and sale", "We do not sell personal information or Google user data. We share information only with service providers acting on our instructions, with your consent, or when legally required."],
  ["Storage and security", "Data is stored using access controls, encryption in transit and other safeguards appropriate to the nature of the information. Messages are retained so members can access their conversation history."],
  ["Your choices", "You can update profile information in Cirkle. You may request access, correction or deletion of your account and associated personal information by contacting us."],
  ["Cookies and local storage", "We use cookies and browser storage for authentication, preferences, caching and reliable offline message delivery."],
  ["Contact", "Privacy questions and data requests can be sent to privacy@cirkle.world."],
] as const;

const Legal = () => {
  const isPrivacy = useLocation().pathname === "/privacy";
  const title = isPrivacy ? "Privacy Policy" : "Terms of Service";
  const sections = isPrivacy ? privacySections : termsSections;

  return (
    <main id="main-content" className="min-h-screen bg-slate-50 px-5 py-8 text-slate-950 dark:bg-[#0d0e10] dark:text-white sm:px-8 sm:py-12">
      <div className="mx-auto max-w-3xl">
        <Link to="/" className="inline-flex items-center gap-2 text-sm font-medium text-blue-700 hover:underline dark:text-blue-300">
          <ArrowLeft className="h-4 w-4" /> Back to Cirkle.World
        </Link>
        <div className="mt-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-[#15171b] sm:p-10">
          <div className="flex items-center gap-3">
            <img src="/cirkle-logo.png" alt="Cirkle.World" className="h-11 w-11 rounded-xl" />
            <div>
              <p className="font-bold">Cirkle.World</p>
              <p className="text-xs text-slate-500 dark:text-white/50">Invite-only community network</p>
            </div>
          </div>
          <h1 className="mt-8 text-3xl font-bold tracking-tight sm:text-4xl">{title}</h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-white/50">Effective 30 August 2026</p>
          <div className="mt-8 space-y-7">
            {sections.map(([heading, body], index) => (
              <section key={heading}>
                <h2 className="text-lg font-semibold">{index + 1}. {heading}</h2>
                <p className="mt-2 leading-7 text-slate-600 dark:text-white/65">{body}</p>
              </section>
            ))}
          </div>
        </div>
        <p className="py-6 text-center text-xs text-slate-500 dark:text-white/40">© 2026 Cirkle.World</p>
      </div>
    </main>
  );
};

export default Legal;
