function getNestedValue(obj, key) {
  if (!obj || !key) return undefined;
  return key.split(".").reduce((acc, part) => (acc && acc[part] !== undefined ? acc[part] : undefined), obj);
}

function interpolate(template, options) {
  if (typeof template !== "string" || !options) return template;
  return template.replace(/\{\{(.*?)\}\}/g, (_, rawKey) => {
    const key = String(rawKey || "").trim();
    const value = options[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

function createSimpleI18nInstance() {
  let language = "en";
  let fallbackLng = "en";
  let resources = {};
  let defaultNS = "translation";

  return {
    get language() {
      return language;
    },
    init(config = {}) {
      resources = config.resources || {};
      language = config.lng || "en";
      fallbackLng = config.fallbackLng || "en";
      defaultNS = config.defaultNS || "translation";
      return this;
    },
    t(key, options = {}) {
      const ns = options.ns || defaultNS;
      const current = getNestedValue(resources[language]?.[ns], key);
      const fallback = getNestedValue(resources[fallbackLng]?.[ns], key);
      const defaultValue = options.defaultValue;
      const resolved =
        current !== undefined
          ? current
          : fallback !== undefined
            ? fallback
            : defaultValue !== undefined
              ? defaultValue
              : key;
      return interpolate(resolved, options);
    },
    changeLanguage(nextLanguage) {
      language = nextLanguage || fallbackLng;
      return Promise.resolve(language);
    },
  };
}

module.exports = {
  createInstance: createSimpleI18nInstance,
};
