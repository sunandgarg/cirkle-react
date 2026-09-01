export const EMAIL_LOGO_URL = "https://cirkle.world/cirkle-oauth-logo.png";

type SesInlineAttachment = {
  RawContent: string;
  ContentDisposition: "INLINE";
  FileName: string;
  ContentId: string;
  ContentTransferEncoding: "BASE64";
  ContentType: "image/png";
};

let cachedLogo: Promise<SesInlineAttachment | null> | undefined;

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const fetchLogo = async (): Promise<SesInlineAttachment | null> => {
  try {
    const response = await fetch(EMAIL_LOGO_URL, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`logo returned ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("image/png")) throw new Error("logo is not a PNG");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 250_000) throw new Error("logo size is invalid");
    return {
      RawContent: toBase64(bytes),
      ContentDisposition: "INLINE",
      FileName: "cirkle-logo.png",
      ContentId: "cirkle-logo",
      ContentTransferEncoding: "BASE64",
      ContentType: "image/png",
    };
  } catch (error) {
    console.warn("Cirkle email logo could not be embedded", error instanceof Error ? error.message : error);
    return null;
  }
};

export const prepareEmailBranding = async (html: string) => {
  cachedLogo ||= fetchLogo();
  const attachment = await cachedLogo;
  return attachment
    ? { html, attachments: [attachment] }
    : { html: html.replace(/cid:cirkle-logo/g, EMAIL_LOGO_URL), attachments: [] as SesInlineAttachment[] };
};
