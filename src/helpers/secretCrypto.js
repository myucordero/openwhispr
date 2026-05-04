const crypto = require("crypto");
const { safeStorage } = require("electron");
const debugLogger = require("./debugLogger");

const SERVICE = "OpenWhispr";
const ACCOUNT = "secrets-master-key";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

let mode = null;
let masterKey = null;

function _initKeychain() {
  let Entry;
  try {
    ({ Entry } = require("@napi-rs/keyring"));
  } catch (error) {
    debugLogger.warn("@napi-rs/keyring failed to load", { error: error?.message }, "secretCrypto");
    return false;
  }

  try {
    const entry = new Entry(SERVICE, ACCOUNT);
    let stored = null;
    try {
      stored = entry.getPassword();
    } catch {}
    if (stored) {
      const key = Buffer.from(stored, "base64");
      if (key.length !== KEY_LEN) throw new Error("stored key length invalid");
      masterKey = key;
    } else {
      masterKey = crypto.randomBytes(KEY_LEN);
      entry.setPassword(masterKey.toString("base64"));
    }
    return true;
  } catch (error) {
    debugLogger.warn(
      "OS keychain unavailable — falling back to safeStorage",
      { error: error?.message, platform: process.platform },
      "secretCrypto"
    );
    return false;
  }
}

function _ensureInit() {
  if (mode) return;
  if (_initKeychain()) {
    mode = "keychain";
    return;
  }
  mode = safeStorage.isEncryptionAvailable() ? "safeStorage" : "unavailable";
}

function isAvailable() {
  _ensureInit();
  return mode !== "unavailable";
}

function encrypt(plaintext) {
  _ensureInit();
  if (mode === "keychain") {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, masterKey, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
  }
  if (mode === "safeStorage") return safeStorage.encryptString(plaintext);
  throw new Error("no encryption backend available");
}

function decrypt(blob) {
  _ensureInit();
  if (mode === "keychain" && blob.length > IV_LEN + TAG_LEN) {
    try {
      const iv = blob.subarray(0, IV_LEN);
      const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
      const ct = blob.subarray(IV_LEN + TAG_LEN);
      const decipher = crypto.createDecipheriv(ALGO, masterKey, iv);
      decipher.setAuthTag(tag);
      const value = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
      return { value, needsReencrypt: false };
    } catch {
      // Legacy safeStorage blob — handled by the fallback below.
    }
  }
  if (safeStorage.isEncryptionAvailable()) {
    return {
      value: safeStorage.decryptString(blob),
      needsReencrypt: mode === "keychain",
    };
  }
  throw new Error("decryption failed: no backend available");
}

module.exports = { encrypt, decrypt, isAvailable };
