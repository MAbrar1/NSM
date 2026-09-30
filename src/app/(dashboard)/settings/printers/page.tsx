"use client";

import * as React from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/stores/toast-store";
import { useI18n } from "@/components/providers/i18n-provider";
import { printerProfileSchema } from "@/lib/validations/print";
import { enqueuePrint } from "@/lib/print/print-service";
import { buildCalibrationHtml } from "@/lib/print/calibration";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PrinterProfile } from "@prisma/client";

/* ═══════════════════════════════════════════════════════════════
   PRINTER PROFILES SETTINGS
   Presets 58/80/112 mm are seeded rows; a custom width (88 mm) is
   created by editing the numbers — never code. Calibration prints
   through the PrintService (BrowserPrintDriver) so the page proves
   the whole chain with no direct window.print here.
   ═══════════════════════════════════════════════════════════════ */

const BLANK = {
  name: "",
  connectionType: "browser" as const,
  connectionTarget: "",
  paperWidthMm: 80,
  printableDots: 576,
  dpi: 203,
  charsPerLine: 48,
  bandHeight: 256,
  interBandGapFix: 0,
  feedBeforeCutLines: 3,
  cutMode: "full" as const,
  drawerKick: false,
  drawerPin: 2 as 2 | 5,
};

export default function PrinterProfilesPage() {
  const { t } = useI18n();
  const [profiles, setProfiles] = React.useState<PrinterProfile[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [draft, setDraft] = React.useState<typeof BLANK>(BLANK);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(() => {
    setLoading(true);
    fetch("/api/printer-profiles")
      .then((r) => r.json())
      .then((d) => setProfiles(d.profiles ?? []))
      .catch(() => toast.error(t("settings.loadFailed")))
      .finally(() => setLoading(false));
  }, [t]);

  React.useEffect(load, [load]);

  function applyPreset(preset: { name: string; paperWidthMm: number; printableDots: number; dpi: number; charsPerLine: number }) {
    setDraft((d) => ({
      ...d,
      ...preset,
      name: preset.name,
    }));
  }

  async function save() {
    setSaving(true);
    try {
      const parsed = printerProfileSchema.safeParse(draft);
      if (!parsed.success) {
        toast.error(t("common.invalidInput"), parsed.error.issues[0]?.message);
        return;
      }
      const res = await fetch(editingId ? `/api/printer-profiles/${editingId}` : "/api/printer-profiles", {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(t("settings.saveFailed"), typeof body.error === "string" ? body.error : undefined);
        return;
      }
      toast.success(t("settings.saved"));
      setDraft(BLANK);
      setEditingId(null);
      load();
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    const res = await fetch(`/api/printer-profiles/${id}`, { method: "DELETE" });
    if (!res.ok) toast.error(t("common.deleteFailed"));
    else toast.success(t("settings.saved"));
    load();
  }

  // ── On-screen calibration inspection ────────────────────────────
  // The software-verifiable half of calibration: render the EXACT
  // document the rasterizer consumes inside a sandboxed preview, so
  // width/Urdu glyphs/seams can be checked before (and after) burning
  // paper. The hardware half stays the physical print + eyeball.
  const [inspectProfile, setInspectProfile] = React.useState<PrinterProfile | null>(null);

  function inspectHtml(p: PrinterProfile): string {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return buildCalibrationHtml({
      name: p.name,
      printableDots: p.printableDots,
      dpi: p.dpi,
      bandHeight: p.bandHeight,
      feedBeforeCutLines: p.feedBeforeCutLines,
      cutMode: p.cutMode as "full" | "partial" | "none",
      drawerKick: p.drawerKick,
    }).replaceAll(/url\(("?)\/fonts\//g, `url($1${origin}/fonts/`);
  }

  async function printCalibration(profile: PrinterProfile) {
    const html = buildCalibrationHtml({
      name: profile.name,
      printableDots: profile.printableDots,
      dpi: profile.dpi,
      bandHeight: profile.bandHeight,
      feedBeforeCutLines: profile.feedBeforeCutLines,
      cutMode: profile.cutMode as "full" | "partial" | "none",
      drawerKick: profile.drawerKick,
    });
    try {
      await enqueuePrint(
        { id: `cal-${profile.id}-${Date.now()}`, kind: "browser-html", html, filename: `calibration-${profile.name}` },
        {
          id: profile.id,
          name: profile.name,
          connectionType: profile.connectionType,
          connectionTarget: profile.connectionTarget,
          charsPerLine: profile.charsPerLine,
          feedBeforeCutLines: profile.feedBeforeCutLines,
          cutMode: profile.cutMode as "full" | "partial" | "none",
          drawerKick: profile.drawerKick,
          drawerPin: profile.drawerPin as 2 | 5,
        }
      );
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("printerProfiles.title")}
        description={t("printerProfiles.description")}
        breadcrumbs={[{ label: t("settings.title"), href: "/settings" }, { label: t("printerProfiles.breadcrumb") }]}
      />

      {loading ? (
        <div className="skeleton h-40 w-full rounded" />
      ) : profiles.length === 0 ? (
        <EmptyState title={t("printerProfiles.none")} description={t("printerProfiles.noneDesc")} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {profiles.map((p) => (
            <Card key={p.id}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {p.name}
                  {p.isEnabled ? <Badge variant="success" size="sm">{t("common.active")}</Badge> : <Badge size="sm">{t("common.disabled")}</Badge>}
                </CardTitle>
                <CardDescription>
                  {p.paperWidthMm}mm · {p.printableDots} dots · {p.dpi} dpi · {p.connectionType}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => printCalibration(p)}>
                  {t("printerProfiles.calibrate")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setInspectProfile(p)}>
                  {t("printerProfiles.inspect")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setEditingId(p.id);
                    setDraft({
                      name: p.name,
                      connectionType: p.connectionType as typeof BLANK.connectionType,
                      connectionTarget: p.connectionTarget ?? "",
                      paperWidthMm: p.paperWidthMm,
                      printableDots: p.printableDots,
                      dpi: p.dpi,
                      charsPerLine: p.charsPerLine,
                      bandHeight: p.bandHeight,
                      interBandGapFix: p.interBandGapFix,
                      feedBeforeCutLines: p.feedBeforeCutLines,
                      cutMode: p.cutMode as typeof BLANK.cutMode,
                      drawerKick: p.drawerKick,
                      drawerPin: p.drawerPin as 2 | 5,
                    });
                  }}
                >
                  {t("common.edit")}
                </Button>
                <Button size="sm" variant="danger" onClick={() => remove(p.id)}>
                  {t("common.delete")}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{editingId ? t("printerProfiles.editTitle") : t("printerProfiles.addTitle")}</CardTitle>
          <CardDescription>{t("printerProfiles.presetsHint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {[
              { name: "58 mm thermal", paperWidthMm: 58, printableDots: 384, dpi: 203, charsPerLine: 32 },
              { name: "80 mm thermal", paperWidthMm: 80, printableDots: 576, dpi: 203, charsPerLine: 48 },
              { name: "112 mm thermal", paperWidthMm: 112, printableDots: 832, dpi: 203, charsPerLine: 64 },
              { name: "Custom 88 mm", paperWidthMm: 88, printableDots: 704, dpi: 203, charsPerLine: 52 },
            ].map((preset) => (
              <Button key={preset.name} size="sm" variant="secondary" onClick={() => applyPreset(preset)}>
                {preset.name}
              </Button>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Input label={t("printerProfiles.name")} value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
            <Input label="paperWidthMm" type="number" value={String(draft.paperWidthMm)} onChange={(e) => setDraft((d) => ({ ...d, paperWidthMm: Number(e.target.value) }))} />
            <Input label="printableDots" type="number" value={String(draft.printableDots)} onChange={(e) => setDraft((d) => ({ ...d, printableDots: Number(e.target.value) }))} />
            <Input label="dpi" type="number" value={String(draft.dpi)} onChange={(e) => setDraft((d) => ({ ...d, dpi: Number(e.target.value) }))} />
            <Input label="charsPerLine" type="number" value={String(draft.charsPerLine)} onChange={(e) => setDraft((d) => ({ ...d, charsPerLine: Number(e.target.value) }))} />
            <Input label="bandHeight" type="number" value={String(draft.bandHeight)} onChange={(e) => setDraft((d) => ({ ...d, bandHeight: Number(e.target.value) }))} />
            <Input label="interBandGapFix" type="number" value={String(draft.interBandGapFix)} onChange={(e) => setDraft((d) => ({ ...d, interBandGapFix: Number(e.target.value) }))} />
            <Input label="feedBeforeCutLines" type="number" value={String(draft.feedBeforeCutLines)} onChange={(e) => setDraft((d) => ({ ...d, feedBeforeCutLines: Number(e.target.value) }))} />
            <Input label="connectionTarget (vid:pid)" value={draft.connectionTarget} onChange={(e) => setDraft((d) => ({ ...d, connectionTarget: e.target.value }))} />
          </div>
          <div className="flex gap-2">
            <Button onClick={save} loading={saving}>{t("settings.save")}</Button>
            {editingId && (
              <Button variant="secondary" onClick={() => { setEditingId(null); setDraft(BLANK); }}>{t("common.cancel")}</Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ═══ ON-SCREEN CALIBRATION INSPECTION ═══ */}
      <Dialog open={Boolean(inspectProfile)} onOpenChange={(o) => !o && setInspectProfile(null)}>
        <DialogContent size="lg" height="tall">
          <DialogHeader>
            <DialogTitle>
              {t("printerProfiles.inspectTitle")} · {inspectProfile?.name}
            </DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {/* Eyeball checklist — what to verify on this preview AND on the
                paper the physical calibration print produces. */}
            <ul className="space-y-1.5 rounded-xl border border-neu-hairline bg-neu-sunken p-4 text-sm text-neu-muted">
              {[
                t("printerProfiles.checkWidth"),
                t("printerProfiles.checkGlyphs"),
                t("printerProfiles.checkSeams"),
                t("printerProfiles.checkQr"),
              ].map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <svg className="mt-0.5 h-4 w-4 shrink-0 text-neu-accent-ink" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            {inspectProfile && (
              <iframe
                title={`${t("printerProfiles.inspectTitle")} — ${inspectProfile.name}`}
                src={`data:text/html;charset=utf-8;base64,${btoa(String.fromCharCode(...new TextEncoder().encode(inspectHtml(inspectProfile))))}`}
                sandbox=""
                className="h-[52dvh] w-full rounded-xl border border-neu-hairline bg-white"
              />
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setInspectProfile(null)}>{t("common.close")}</Button>
            {inspectProfile && (
              <Button onClick={() => printCalibration(inspectProfile)}>{t("printerProfiles.calibrate")}</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
