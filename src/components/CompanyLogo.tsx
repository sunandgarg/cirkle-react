import { useEffect, useState } from "react";
import { getCompanyLogo, getCompanyLogoAsync } from "@/lib/companyCatalog";
import { cn } from "@/lib/utils";

interface CompanyLogoProps {
  company?: string | null;
  src?: string | null;
  className?: string;
}

const CompanyLogo = ({ company, src, className }: CompanyLogoProps) => {
  const [catalogSource, setCatalogSource] = useState(() => getCompanyLogo(company));
  const resolvedSource = src || catalogSource;
  const [failed, setFailed] = useState(false);
  const initials = (company || "Company").trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join("").toUpperCase();

  useEffect(() => {
    let active = true;
    setFailed(false);
    if (src) {
      setCatalogSource(null);
      return () => { active = false; };
    }
    setCatalogSource(getCompanyLogo(company));
    void getCompanyLogoAsync(company).then((logo) => {
      if (active) setCatalogSource(logo);
    });
    return () => { active = false; };
  }, [company, src]);

  return (
    <div className={cn("grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg border border-border/70 bg-white", className)}>
      {resolvedSource && !failed
        ? <img src={resolvedSource} alt={`${company || "Company"} logo`} width={48} height={48} loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-full object-contain p-1.5" />
        : <span role="img" aria-label={`${company || "Company"} monogram`} className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/12 to-primary/5 text-xs font-black tracking-tight text-primary">{initials || "CO"}</span>}
    </div>
  );
};

export default CompanyLogo;
