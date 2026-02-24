import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import i18nInstance, { type SimpleI18n } from "./simpleI18n";

type TranslationContextValue = {
  i18n: SimpleI18n;
};

const TranslationContext = createContext<TranslationContextValue>({
  i18n: i18nInstance,
});

export const initReactI18next = {
  type: "3rdParty",
  init() {
    // No-op shim for compatibility with i18next.use(initReactI18next)
  },
};

export function I18nextProvider({
  i18n,
  children,
}: {
  i18n: SimpleI18n;
  children: React.ReactNode;
}) {
  const value = useMemo(() => ({ i18n }), [i18n]);
  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

export function useTranslation(ns?: string) {
  const { i18n } = useContext(TranslationContext);
  const [, forceRender] = useState(0);

  useEffect(() => {
    const listener = () => forceRender((value) => value + 1);
    i18n.on("languageChanged", listener);
    return () => i18n.off("languageChanged", listener);
  }, [i18n]);

  const t = useMemo(
    () =>
      ((key: string, options: Record<string, unknown> = {}) =>
        i18n.t(key, ns ? { ...options, ns } : options)) as ((
        key: string,
        options?: Record<string, unknown>
      ) => string),
    [i18n, ns]
  );

  return { t, i18n };
}
