import type { RepositoryConfig } from "@iroha/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "@/api/client.js";
import { ErrorState, Loading, PageHeader } from "@/components/brand.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
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

/**
 * One provider key: its presence, a field to replace it, and nothing that reads
 * it back. The field is cleared on success rather than showing the saved value —
 * the API has no endpoint that returns one, and a masked field holding a key the
 * user cannot verify only invites re-saving it.
 */
function CredentialRow({
  provider,
  label,
  hint,
  present,
}: {
  provider: "voyage" | "github";
  label: string;
  hint: string;
  present: boolean;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const save = useMutation({
    mutationFn: () => api.setCredential(provider, value.trim()),
    onSuccess: () => {
      setValue("");
      toast.add({ type: "success", title: t("common.saved") });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      // Both report whether the key is present, so a stale copy of either would
      // still show "Not set" right after saving one.
      void queryClient.invalidateQueries({ queryKey: ["doctor"] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: () => toast.add({ type: "error", title: t("common.error") }),
  });

  return (
    <SettingRow htmlFor={`cfg-key-${provider}`} label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <Badge variant={present ? "approve" : "neutral"}>
          {present ? t("settings.present") : t("settings.absent")}
        </Badge>
        <Input
          id={`cfg-key-${provider}`}
          type="password"
          autoComplete="off"
          className="w-52"
          placeholder={t("settings.keyPlaceholder")}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        {/* The visible word is "Save" like the config button below, so the
            accessible name names the field — three identically-named buttons on
            one page is a maze to anyone not looking at the layout. */}
        <Button
          variant="secondary"
          aria-label={`${t("common.save")}: ${label}`}
          disabled={value.trim() === "" || save.isPending}
          onClick={() => save.mutate()}
        >
          {t("common.save")}
        </Button>
      </div>
    </SettingRow>
  );
}

/**
 * `local_settings` key for the retention window, mirroring
 * `RETENTION_SETTING_KEY` in `@iroha/core` (the SPA depends on the API's
 * generated types only, never on core).
 */
const RETENTION_SETTING_KEY = "retention.local_events";

/** Offered windows; the API accepts any 1-3650 day value. */
const RETENTION_CHOICES = [30, 90, 180, 365] as const;

/** Endonyms, not translations — the locale picker names each language in itself. */
const LANGUAGE_LABELS = { en: "English", ja: "日本語" };

/** Shared config editor + redacted local status (contracts/dashboard-api.md §6/§8). */
export function Settings() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [config, setConfig] = useState<RepositoryConfig | null>(null);
  const retentionLabels: Record<string, string> = {
    forever: t("settings.retentionForever"),
    ...Object.fromEntries(
      RETENTION_CHOICES.map((days) => [
        String(days),
        t("settings.retentionDays").replace("{days}", String(days)),
      ]),
    ),
  };

  useEffect(() => {
    if (q.data !== undefined) setConfig(q.data.shared);
  }, [q.data]);

  const saveRetention = useMutation({
    mutationFn: (days: number | null) => api.updateLocalSetting(RETENTION_SETTING_KEY, { days }),
    onSuccess: () => {
      toast.add({ type: "success", title: t("common.saved") });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      // The Doctor page reports the window and the row counts it governs.
      void queryClient.invalidateQueries({ queryKey: ["doctor"] });
    },
    onError: () => toast.add({ type: "error", title: t("common.error") }),
  });

  const save = useMutation({
    mutationFn: () => {
      if (config === null) throw new Error("no config");
      return api.updateSharedConfig(config);
    },
    onSuccess: () => {
      toast.add({ type: "success", title: t("common.saved") });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
    onError: () => toast.add({ type: "error", title: t("common.error") }),
  });

  if (q.isPending) return <Loading />;
  if (q.isError || q.data === undefined || config === null) return <ErrorState />;
  const local = q.data.local;

  return (
    <section className="max-w-2xl">
      <PageHeader title={t("settings.title")} />

      <Card>
        <CardContent className="divide-y divide-hairline">
          <SettingRow
            htmlFor="cfg-language"
            label={t("settings.language")}
            hint={t("settings.languageHint")}
          >
            {/* `items` is what makes the closed trigger show the label: without it
                Base UI's Select.Value renders the raw stored value ("en"). */}
            <Select
              items={LANGUAGE_LABELS}
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

          <CredentialRow
            provider="voyage"
            label={t("settings.embeddingKey")}
            hint={t("settings.embeddingKeyHint")}
            present={local.embeddingKeyPresent}
          />

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

          <CredentialRow
            provider="github"
            label={t("settings.forgeToken")}
            hint={t("settings.forgeTokenHint")}
            present={local.forgeTokenPresent}
          />

          <SettingRow
            htmlFor="cfg-retention"
            label={t("settings.retention")}
            hint={t("settings.retentionHint")}
          >
            {/* Saved on change, unlike the shared config above: this is a single
                local key, not part of the config.yaml the Save button rewrites.
                Disabled while a save is in flight — two overlapping upserts would
                let completion order decide the stored window, so picking a short
                window and then "Forever" could leave the short one persisted and a
                later sync would delete history the final choice meant to keep. */}
            <Select
              items={retentionLabels}
              disabled={saveRetention.isPending}
              value={local.retentionDays === null ? "forever" : String(local.retentionDays)}
              onValueChange={(value) =>
                saveRetention.mutate(value === "forever" ? null : Number(value))
              }
            >
              <SelectTrigger id="cfg-retention" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="forever">{t("settings.retentionForever")}</SelectItem>
                {RETENTION_CHOICES.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {t("settings.retentionDays").replace("{days}", String(days))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
