import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { tmpdir } from "node:os";

// Official institute-hosted assets. Run manually when an institute publishes
// refreshed brand artwork, then visually review the generated contact sheet.
const assets = {
  "iit-bombay.png": "https://www.iitb.ac.in/themes/custom/iitb_bootstrap/logo.png",
  "iit-delhi.png": "https://home.iitd.ac.in/images/logo-iit.png",
  "iit-madras.png": "https://www.iitm.ac.in/themes/custom/iitm/assets/images/iitm_logo.png",
  "iit-kanpur.png": "https://www.iitk.ac.in/data/IITK.png",
  "iit-kharagpur.png": "https://www.iitkgp.ac.in/assets/pages/images/logo.png",
  "iit-roorkee.png": "https://cmsredesign.channeli.in/library/assets/images/iitrLogo.png",
  "iit-guwahati.jpg": "https://www.iitg.ac.in/core/img/iitglogo.jpg",
  "iit-hyderabad.png": "https://iith.ac.in/assets/images/horzlogolong.png",
  "iit-bhu.png": "https://iitbhu.ac.in/sites/default/files/iitbhu/images/other/iit_logo_original.png",
  "iit-indore.png": "https://www.iiti.ac.in/images/logo.png",
  "iit-ropar.png": "https://www.iitrpr.ac.in/img/logos/logo.png",
  "iit-patna.jpg": "https://academics.iitp.ac.in/revised_syllabus/iit%20logo.jpg",
  "iit-bhubaneswar.png": "https://www.iitbbs.ac.in/wp-content/uploads/2024/04/IIT_Bhubaneswar_Logo-768x225.png",
  "iit-gandhinagar.png": "https://iitgn.ac.in/assets/img/iitgn-logo.png",
  "iit-jodhpur.png": "https://iitj.ac.in/Website/assets/images/logo-1.png",
  "iit-mandi.png": "https://iitmandi.ac.in/images/logo_hires.png",
  "iit-tirupati.png": "https://cse.iittp.ac.in/assets/images/iittp-logo.png",
  "iit-palakkad.jpg": "https://iitpkd.ac.in/sites/default/files/IITWEBLOGO%20%283%29.jpg",
  "iit-dharwad.png": "https://www.iitdh.ac.in/sites/default/files/2024-01/logo_black_final.png",
  "iit-bhilai.jpg": "https://cse.iitbhilai.ac.in/phd/iit-logo.jpg",
  "iit-goa.png": "https://iitgoa.ac.in/wp-content/uploads/iitGoaWebsiteBanner.png",
  "iit-jammu.png": "https://iitjammu.ac.in/images/iitjammulogo.png",
  "iit-dhanbad.png": "https://www.iitism.ac.in/images/logo_new%201.png",
};

const destination = resolve("public/iit-logos");
mkdirSync(destination, { recursive: true });
const downloadDirectory = mkdtempSync(resolve(tmpdir(), "cirkle-iit-logos-"));

const failures = [];
for (const [filename, url] of Object.entries(assets)) {
  const target = resolve(destination, `${basename(filename, extname(filename))}.webp`);
  const source = resolve(downloadDirectory, filename);
  try {
    if (existsSync(target) && statSync(target).size >= 500) {
      console.log(`${basename(target)}: already generated`);
      continue;
    }
    execFileSync("curl", ["-L", "--fail", "--silent", "--show-error", "--connect-timeout", "5", "--max-time", "12", "-A", "Cirkle asset updater/1.0", "-o", source, url]);
    if (statSync(source).size < 500) throw new Error("downloaded asset was unexpectedly small");
    execFileSync("cwebp", ["-quiet", "-q", "88", "-resize", "0", "768", source, "-o", target]);
    const size = statSync(target).size;
    if (size < 500) throw new Error(`generated WebP was only ${size} bytes`);
    console.log(`${basename(target)}: ${size} bytes`);
  } catch (error) {
    failures.push(`${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
rmSync(downloadDirectory, { recursive: true, force: true });

if (failures.length) {
  console.error(`Failed assets:\n${failures.join("\n")}`);
  process.exitCode = 1;
}
