import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enPrompts from "./locales/en/prompts.json";
import enTranslation from "./locales/en/translation.json";

export const SUPPORTED_UI_LANGUAGES = [
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "it",
  "ru",
  "ja",
  "zh-CN",
  "zh-TW",
] as const;
export type UiLanguage = (typeof SUPPORTED_UI_LANGUAGES)[number];

export function normalizeUiLanguage(language: string | null | undefined): UiLanguage {
  const candidate = (language || "").trim();

  // Check full language-region code first (e.g. "zh-CN", "zh-TW")
  const normalized = candidate.replace("_", "-");
  const fullMatch = SUPPORTED_UI_LANGUAGES.find(
    (lang) => lang.toLowerCase() === normalized.toLowerCase()
  );
  if (fullMatch) return fullMatch;

  // Fall back to base language code (e.g. "en" from "en-US")
  const base = candidate.split("-")[0].split("_")[0].toLowerCase() as UiLanguage;
  if (SUPPORTED_UI_LANGUAGES.includes(base)) {
    return base;
  }

  return "en";
}

const LOCALE_LOADERS: Record<
  UiLanguage,
  () => Promise<{ translation: unknown; prompts: unknown }>
> = {
  en: async () => ({ translation: enTranslation, prompts: enPrompts }),
  es: async () => {
    const [{ default: translation }, { default: prompts }] = await Promise.all([
      import("./locales/es/translation.json"),
      import("./locales/es/prompts.json"),
    ]);
    return { translation, prompts };
  },
  fr: async () => {
    const [{ default: translation }, { default: prompts }] = await Promise.all([
      import("./locales/fr/translation.json"),
      import("./locales/fr/prompts.json"),
    ]);
    return { translation, prompts };
  },
  de: async () => {
    const [{ default: translation }, { default: prompts }] = await Promise.all([
      import("./locales/de/translation.json"),
      import("./locales/de/prompts.json"),
    ]);
    return { translation, prompts };
  },
  pt: async () => {
    const [{ default: translation }, { default: prompts }] = await Promise.all([
      import("./locales/pt/translation.json"),
      import("./locales/pt/prompts.json"),
    ]);
    return { translation, prompts };
  },
  it: async () => {
    const [{ default: translation }, { default: prompts }] = await Promise.all([
      import("./locales/it/translation.json"),
      import("./locales/it/prompts.json"),
    ]);
    return { translation, prompts };
  },
  ru: async () => {
    const [{ default: translation }, { default: prompts }] = await Promise.all([
      import("./locales/ru/translation.json"),
      import("./locales/ru/prompts.json"),
    ]);
    return { translation, prompts };
  },
  ja: async () => {
    const [{ default: translation }, { default: prompts }] = await Promise.all([
      import("./locales/ja/translation.json"),
      import("./locales/ja/prompts.json"),
    ]);
    return { translation, prompts };
  },
  "zh-CN": async () => {
    const [{ default: translation }, { default: prompts }] = await Promise.all([
      import("./locales/zh-CN/translation.json"),
      import("./locales/zh-CN/prompts.json"),
    ]);
    return { translation, prompts };
  },
  "zh-TW": async () => {
    const [{ default: translation }, { default: prompts }] = await Promise.all([
      import("./locales/zh-TW/translation.json"),
      import("./locales/zh-TW/prompts.json"),
    ]);
    return { translation, prompts };
  },
};

const resources = {
  en: {
    translation: enTranslation,
    prompts: enPrompts,
  },
} as const;

const browserLanguage =
  typeof navigator !== "undefined" ? navigator.language || navigator.languages?.[0] : undefined;

const storageLanguage =
  typeof window !== "undefined" ? window.localStorage.getItem("uiLanguage") : undefined;

const initialLanguage = normalizeUiLanguage(storageLanguage || browserLanguage || "en");

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage,
  fallbackLng: "en",
  ns: ["translation", "prompts"],
  defaultNS: "translation",
  interpolation: {
    escapeValue: false,
  },
  returnEmptyString: true,
  returnNull: false,
});

export async function ensureLocaleResources(
  language: string | null | undefined
): Promise<UiLanguage> {
  const normalized = normalizeUiLanguage(language);

  if (
    i18n.hasResourceBundle(normalized, "translation") &&
    i18n.hasResourceBundle(normalized, "prompts")
  ) {
    return normalized;
  }

  const loader = LOCALE_LOADERS[normalized];
  if (!loader) {
    return "en";
  }

  const { translation, prompts } = await loader();
  i18n.addResourceBundle(normalized, "translation", translation, true, true);
  i18n.addResourceBundle(normalized, "prompts", prompts, true, true);

  return normalized;
}

if (initialLanguage !== "en") {
  void ensureLocaleResources(initialLanguage)
    .then((resolvedLanguage) => i18n.changeLanguage(resolvedLanguage))
    .catch(() => {
      // Keep English fallback if the selected locale fails to load.
    });
}

export default i18n;
