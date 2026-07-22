import type { RepositoryConfig } from "@iroha/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/client.js";
import { ErrorState, Loading, PageHeader } from "@/components/brand.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { useI18n } from "@/i18n/index.js";

function SettingRow({
  htmlFor,
  label,
  hint,
  children,
}: {
  htmlFor?: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0">
        {htmlFor !== undefined ? (
          <Label htmlFor={htmlFor} className="text-ink">
            {label}
          </Label>
        ) : (
          <span className="text-sm font-medium text-ink">{label}</span>
        )}
        {hint !== undefined && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Shared config editor + redacted local status (dashboard-api.md §6/§8). */
export function Settings() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [config, setConfig] = useState<RepositoryConfig | null>(null);

  useEffect(() => {
    if (q.data !== undefined) setConfig(q.data.shared);
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => {
      if (config === null) throw new Error("no config");
      return api.updateSharedConfig(config);
    },
    onSuccess: () => {
      toast.success(t("common.saved"));
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
    onError: () => toast.error(t("common.error")),
  });

  if (q.isPending) return <Loading />;
  if (q.isError || q.data === undefined || config === null) return <ErrorState />;
  const local = q.data.local;

  return (
    <section className="max-w-2xl">
      <PageHeader eyebrow={t("nav.settings")} title={t("settings.title")} />

      <Card>
        <CardContent className="divide-y divide-hairline">
          <SettingRow
            htmlFor="cfg-language"
            label={t("settings.language")}
            hint={t("settings.languageHint")}
          >
            <Select
              value={config.default_language}
              onValueChange={(value) =>
                setConfig({ ...config, default_language: value as "ja" | "en" })
              }
            >
              <SelectTrigger id="cfg-language" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="ja">日本語</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            htmlFor="cfg-embedding"
            label={t("settings.embeddingEnabled")}
            hint={t("settings.embeddingHint")}
          >
            <Switch
              id="cfg-embedding"
              checked={config.search.embedding.enabled}
              onCheckedChange={(checked) =>
                setConfig({
                  ...config,
                  search: { embedding: { ...config.search.embedding, enabled: checked } },
                })
              }
            />
          </SettingRow>

          <SettingRow label={t("settings.embeddingKey")}>
            <Badge variant={local.embeddingKeyPresent ? "approve" : "neutral"}>
              {local.embeddingKeyPresent ? t("settings.present") : t("settings.absent")}
            </Badge>
          </SettingRow>

          <SettingRow
            htmlFor="cfg-forge"
            label={t("settings.forge")}
            hint={t("settings.forgeHint")}
          >
            <Switch
              id="cfg-forge"
              checked={config.forge.enabled}
              onCheckedChange={(checked) =>
                setConfig({ ...config, forge: { ...config.forge, enabled: checked } })
              }
            />
          </SettingRow>
        </CardContent>
      </Card>

      <div className="mt-6">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {t("common.save")}
        </Button>
      </div>
    </section>
  );
}
