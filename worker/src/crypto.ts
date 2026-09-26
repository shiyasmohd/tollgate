// Seller API secrets are stored AES-GCM encrypted under MASTER_KEY (base64, 32 bytes).
// Stored form: "v1:" + base64(iv || ciphertext).

const keys = new Map<string, Promise<CryptoKey>>();

function importKey(masterKey: string): Promise<CryptoKey> {
  let key = keys.get(masterKey);
  if (!key) {
    const raw = Uint8Array.from(atob(masterKey), (ch) => ch.charCodeAt(0));
    if (raw.length !== 32) throw new Error("MASTER_KEY must be 32 bytes, base64 encoded");
    key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    keys.set(masterKey, key);
  }
  return key;
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

export async function encryptSecret(masterKey: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(masterKey), new TextEncoder().encode(plaintext));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), iv.length);
  return `v1:${toBase64(out)}`;
}

export async function decryptSecret(masterKey: string, stored: string): Promise<string> {
  if (!stored.startsWith("v1:")) throw new Error("unknown secret format");
  const bytes = fromBase64(stored.slice(3));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await importKey(masterKey), bytes.slice(12));
  return new TextDecoder().decode(pt);
}
