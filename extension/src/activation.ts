/**
 * One-time activation per browser: the user enters the author's mobile
 * number, and the extension stays active in that browser profile for good.
 *
 * Only a salted SHA-256 of the number is kept here. This stops casual use,
 * not a determined one: anyone who reads this code can skip the check. No DOM,
 * so Node tests it.
 */
export const ACTIVATION_HASH = "cd09b9902b0821a556a8e9d7290dc942fa24c0ad8ea960e4fa05b1e399ec3124";
export const ACTIVATION_KEY = "activated";

/** Digits only, with Persian and Arabic-Indic digits turned into 0-9. */
export function normalizeNumber(input: string): string {
  return input
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\D/g, "")
    .replace(/^98(?=9\d{9}$)/, "0")
    .replace(/^(?=9\d{9}$)/, "0");
}

export async function isAuthorNumber(input: string): Promise<boolean> {
  const bytes = new TextEncoder().encode(`zx-ai:${normalizeNumber(input)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === ACTIVATION_HASH;
}
