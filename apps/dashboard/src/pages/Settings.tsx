import type { RepositoryConfig } from "@iroha/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/api/client.js";
import { btnPrimary, Card, ErrorNote, Loading } from "@/components/ui.js";
import { useI18n } from "@/i18n/index.js";

/** Shared config editor + redacted local status (dashboard-api.md §6/§8). */
export function Settings() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [config, setConfig] = useState<RepositoryConfig | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (q.data !== undefined) setConfig(q.data.shared);
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => {
      if (config === null) throw new Error("no config");
      return api.updateSharedConfig(config);
    },
    onSuccess: () => {
      setNotice(t("common.saved"));
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
    onError: () => setNotice(t("common.error")),
  });

  if (q.isPending) return <Loading />;
  if (q.isError || q.data === undefined || config === null) return <ErrorNote />;

  return (
    <section className="max-w-xl">
      <h1 className="mb-6 font-display text-[30px] font-semibold tracking-[-0.01em] text-ink">
        {t("settings.title")}
      </h1>
      {notice !== null && (
        <p className="mb-4 rounded-xl bg-approve-tint px-3 py-2 text-sm text-approve">{notice}</p>
      )}
      <Card className="space-y-5">
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm text-ink">{t("settings.language")}</span>
          <select
            value={config.default_language}
            onChange={(e) =>
              setConfig({ ...config, default_language: e.target.value as "ja" | "en" })
            }
            className="h-9 rounded-xl border border-hairline bg-paper-raised px-2 text-ink"
          >
            <option value="en">English</option>
            <option value="ja">日本語</option>
          </select>
        </label>

        <label className="flex items-center justify-between gap-4">
          <span className="text-sm text-ink">{t("settings.embeddingEnabled")}</span>
          <input
            type="checkbox"
            checked={config.search.embedding.enabled}
            onChange={(e) =>
              setConfig({
                ...config,
                search: {
                  embedding: { ...config.search.embedding, enabled: e.target.checked },
                },
              })
            }
            className="h-4 w-4 accent-matcha"
          />
        </label>

        <div className="flex items-center justify-between gap-4 text-sm">
          <span className="text-ink">{t("settings.embeddingKey")}</span>
          <span className="text-ink-muted">
            {q.data.local.embeddingKeyPresent ? t("settings.present") : t("settings.absent")}
          </span>
        </div>

        <label className="flex items-center justify-between gap-4">
          <span className="text-sm text-ink">{t("settings.forge")}</span>
          <input
            type="checkbox"
            checked={config.forge.enabled}
            onChange={(e) =>
              setConfig({ ...config, forge: { ...config.forge, enabled: e.target.checked } })
            }
            className="h-4 w-4 accent-matcha"
          />
        </label>

        <button type="button" onClick={() => save.mutate()} className={btnPrimary}>
          {t("common.save")}
        </button>
      </Card>
    </section>
  );
}
