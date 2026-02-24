type LanguageResources = Record<string, Record<string, unknown>>;

export type TFunction = (key: string, options?: Record<string, unknown>) => string;

type EventName = "languageChanged";
type Listener = (value: string) => void;

function getNestedValue(obj: unknown, key: string): unknown {
  if (!obj || !key) return undefined;
  return key.split(".").reduce<unknown>((acc, part) => {
    if (!acc || typeof acc !== "object") return undefined;
    const record = acc as Record<string, unknown>;
    return record[part];
  }, obj);
}

function interpolate(template: unknown, options?: Record<string, unknown>): string {
  const text = typeof template === "string" ? template : String(template ?? "");
  if (!options) return text;
  return text.replace(/\{\{(.*?)\}\}/g, (_, rawKey: string) => {
    const key = rawKey.trim();
    const value = options[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

export class SimpleI18n {
  private resources: LanguageResources = {};
  public language = "en";
  private fallbackLng = "en";
  private defaultNS = "translation";
  private listeners = new Map<EventName, Set<Listener>>();

  use(_plugin: unknown): this {
    return this;
  }

  init(config: {
    resources?: LanguageResources;
    lng?: string;
    fallbackLng?: string;
    defaultNS?: string;
    ns?: string[];
    interpolation?: Record<string, unknown>;
    returnEmptyString?: boolean;
    returnNull?: boolean;
    initImmediate?: boolean;
  }): Promise<this> {
    this.resources = config.resources || {};
    this.language = config.lng || "en";
    this.fallbackLng = config.fallbackLng || "en";
    this.defaultNS = config.defaultNS || "translation";
    return Promise.resolve(this);
  }

  t(key: string, options: Record<string, unknown> = {}): string {
    const language = (options.lng as string) || this.language;
    const ns = (options.ns as string) || this.defaultNS;
    const current = getNestedValue(this.resources[language]?.[ns], key);
    const fallback = getNestedValue(this.resources[this.fallbackLng]?.[ns], key);
    const resolved =
      current !== undefined
        ? current
        : fallback !== undefined
          ? fallback
          : options.defaultValue !== undefined
            ? options.defaultValue
            : key;
    return interpolate(resolved, options);
  }

  getFixedT(language: string, ns?: string): TFunction {
    return (key: string, options: Record<string, unknown> = {}) =>
      this.t(key, { ...options, ns: ns || options.ns, lng: language });
  }

  changeLanguage(nextLanguage: string): Promise<string> {
    this.language = nextLanguage || this.fallbackLng;
    this.emit("languageChanged", this.language);
    return Promise.resolve(this.language);
  }

  on(event: EventName, listener: Listener): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)?.add(listener);
  }

  off(event: EventName, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  private emit(event: EventName, value: string): void {
    for (const listener of this.listeners.get(event) || []) {
      listener(value);
    }
  }
}

export function createInstance(): SimpleI18n {
  return new SimpleI18n();
}

const defaultInstance = new SimpleI18n();
export default defaultInstance;
