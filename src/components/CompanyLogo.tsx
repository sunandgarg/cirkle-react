import { useEffect, useState } from "react";
import { Building2 } from "lucide-react";
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
        : <Building2 className="h-5 w-5 text-primary" aria-hidden="true" />}
    </div>
  );
};

export default CompanyLogo;
