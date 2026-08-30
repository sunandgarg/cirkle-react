const sites = {
  bombay: "https://www.iitb.ac.in/",
  delhi: "https://home.iitd.ac.in/",
  madras: "https://www.iitm.ac.in/",
  kanpur: "https://www.iitk.ac.in/",
  kharagpur: "https://www.iitkgp.ac.in/",
  roorkee: "https://www.iitr.ac.in/",
  guwahati: "https://www.iitg.ac.in/",
  hyderabad: "https://www.iith.ac.in/",
  bhu: "https://iitbhu.ac.in/",
  indore: "https://www.iiti.ac.in/",
  ropar: "https://www.iitrpr.ac.in/",
  patna: "https://www.iitp.ac.in/",
  bhubaneswar: "https://www.iitbbs.ac.in/",
  gandhinagar: "https://iitgn.ac.in/",
  jodhpur: "https://iitj.ac.in/",
  mandi: "https://www.iitmandi.ac.in/",
  tirupati: "https://www.iittp.ac.in/",
  palakkad: "https://iitpkd.ac.in/",
  dharwad: "https://www.iitdh.ac.in/",
  bhilai: "https://www.iitbhilai.ac.in/",
  goa: "https://iitgoa.ac.in/",
  jammu: "https://www.iitjammu.ac.in/",
  dhanbad: "https://www.iitism.ac.in/",
};

const startAt = process.argv[2];
const entries = Object.entries(sites);
const startIndex = startAt ? Math.max(0, entries.findIndex(([slug]) => slug === startAt)) : 0;

for (const [slug, site] of entries.slice(startIndex)) {
  try {
    const response = await fetch(site, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 Cirkle/1.0" },
      signal: AbortSignal.timeout(12_000),
    });
    const html = await response.text();
    const matches = [...html.matchAll(/<img\b[^>]*(?:src|data-src)=["']([^"']+)["'][^>]*>/gi)]
      .map((match) => ({ src: match[1], tag: match[0].replace(/\s+/g, " ").slice(0, 240) }))
      .filter((item) => /logo|emblem|brand|iit/i.test(item.tag))
      .slice(0, 8);
    console.log(`\n${slug} ${response.status} ${response.url}`);
    for (const match of matches) console.log(new URL(match.src, response.url).href, "|", match.tag);
    if (!matches.length) {
      const icons = [...html.matchAll(/<link\b[^>]*rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/gi)]
        .map((match) => match[1]);
      const firstImages = [...html.matchAll(/<img\b[^>]*(?:src|data-src)=["']([^"']+)["'][^>]*>/gi)]
        .slice(0, 12)
        .map((match) => match[1]);
      for (const asset of [...icons, ...firstImages]) console.log(new URL(asset, response.url).href);
    }
  } catch (error) {
    console.log(`\n${slug} ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
}
