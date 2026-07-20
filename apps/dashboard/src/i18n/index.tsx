import { createContext, type ReactNode, useContext, useState } from "react";

export type Locale = "ja" | "en";
type Dict = Record<string, string>;

const ja: Dict = {
  "app.title": "iroha ダッシュボード",
  "nav.overview": "概要",
  "nav.review": "レビュー待ち",
  "nav.knowledge": "ナレッジ",
  "nav.search": "検索",
  "overview.pending": "レビュー待ち候補",
  "overview.approved": "承認済みナレッジ",
  "overview.sessions": "セッション",
  "overview.dirty": "未解決マーカー",
  "overview.oldestPending": "最も古い未レビュー",
  "overview.lastSync": "最終同期",
  "review.title": "レビュー待ちキュー",
  "review.empty": "レビュー待ちの候補はありません。",
  "review.approve": "承認",
  "review.reject": "却下",
  "review.preview": "canonical プレビュー",
  "review.validation": "検証結果",
  "review.secretBlocked": "秘密情報が検出されたため承認できません。",
  "review.approvable": "承認可能です。",
  "review.notApprovable": "検証を通過するまで承認できません。",
  "review.reviewer": "レビュー担当者名",
  "review.approved": "承認しました。",
  "review.rejected": "却下しました。",
  "knowledge.title": "承認済みナレッジ",
  "knowledge.empty": "承認済みナレッジはまだありません。",
  "knowledge.authority": "権威度",
  "search.title": "検索",
  "search.placeholder": "承認済みナレッジを検索…",
  "search.run": "検索",
  "search.empty": "該当する結果はありません。",
  "common.loading": "読み込み中…",
  "common.error": "エラーが発生しました。",
  "common.none": "なし",
  "common.back": "戻る",
  "common.status": "状態",
  "common.type": "種類",
  "auth.required": "iroha dashboard コマンドから起動してください（認証が必要です）。",
};

const en: Dict = {
  "app.title": "iroha dashboard",
  "nav.overview": "Overview",
  "nav.review": "Review",
  "nav.knowledge": "Knowledge",
  "nav.search": "Search",
  "overview.pending": "Pending candidates",
  "overview.approved": "Approved knowledge",
  "overview.sessions": "Sessions",
  "overview.dirty": "Unresolved markers",
  "overview.oldestPending": "Oldest pending",
  "overview.lastSync": "Last sync",
  "review.title": "Review queue",
  "review.empty": "No candidates awaiting review.",
  "review.approve": "Approve",
  "review.reject": "Reject",
  "review.preview": "Canonical preview",
  "review.validation": "Validation",
  "review.secretBlocked": "A secret was detected; approval is blocked.",
  "review.approvable": "Ready to approve.",
  "review.notApprovable": "Cannot approve until validation passes.",
  "review.reviewer": "Reviewer name",
  "review.approved": "Approved.",
  "review.rejected": "Rejected.",
  "knowledge.title": "Approved knowledge",
  "knowledge.empty": "No approved knowledge yet.",
  "knowledge.authority": "Authority",
  "search.title": "Search",
  "search.placeholder": "Search approved knowledge…",
  "search.run": "Search",
  "search.empty": "No matching results.",
  "common.loading": "Loading…",
  "common.error": "Something went wrong.",
  "common.none": "None",
  "common.back": "Back",
  "common.status": "Status",
  "common.type": "Type",
  "auth.required": "Launch from the iroha dashboard command (authentication required).",
};

const messages: Record<Locale, Dict> = { ja, en };

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  // English is the default distributable locale; Japanese is selectable and can
  // be preselected from the repository's `config.default_language` (App).
  const [locale, setLocale] = useState<Locale>("en");
  const t = (key: string): string => messages[locale][key] ?? key;
  return <I18nContext value={{ locale, setLocale, t }}>{children}</I18nContext>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (value === null) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return value;
}
