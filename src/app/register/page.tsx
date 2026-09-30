"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { signIn } from "next-auth/react";
import { registerSchema, type RegisterInput } from "@/lib/validations";
import { useI18n } from "@/components/providers/i18n-provider";
import { readApiError } from "@/lib/api/api-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { APP_NAME } from "@/lib/constants";

/* ═══════════════════════════════════════════════════════════════
   REGISTER — Electric Embossed Neumorphism

   Two state swaps live here, both as CLASS TOGGLES on sibling
   elements rather than frame-by-frame animations:

   - form → confirmation, via `.is-success` on the confirmation panel
     (fade + translateY only, no shadow tween, no layout reflow);
   - form → "registration closed", the existing status card.

   The confirmation panel is the app's real "success screen": after
   the card paints we continue into the app exactly as before. The
   delay is skipped entirely under prefers-reduced-motion so the
   state swap can never become a barrier.
   ═══════════════════════════════════════════════════════════════ */

export default function RegisterPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [formError, setFormError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [statusChecked, setStatusChecked] = React.useState(false);
  const [registrationOpen, setRegistrationOpen] = React.useState(true);
  const [registered, setRegistered] = React.useState(false);

  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    formState: { errors },
  } = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: "", email: "", password: "", confirmPassword: "" },
  });

  // Check whether public registration is currently allowed
  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/registration-status")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) {
          setRegistrationOpen(d.open !== false);
          setStatusChecked(true);
        }
      })
      .catch(() => {
        if (!cancelled) setStatusChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(data: RegisterInput) {
    setFormError(null);
    clearErrors();
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: data.name, email: data.email, password: data.password }),
      });
      const result = await res.json();
      if (!res.ok) {
        // Field-keyed errors land on their own input; anything else (a
        // disabled-registration message, a 500) goes in the form banner.
        const { fields, message } = await readApiError(result, t("auth.registrationFailed"));
        let mapped = false;
        for (const key of ["name", "email", "password"] as const) {
          if (fields[key]) {
            setError(key, { type: "server", message: fields[key] });
            mapped = true;
          }
        }
        if (!mapped) setFormError(message);
        return;
      }
      // Swap to the confirmation state, then continue into the app.
      setRegistered(true);
      const reduceMotion =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
      window.setTimeout(
        async () => {
          const signInResult = await signIn("credentials", {
            email: data.email, password: data.password, redirect: false,
          });
          if (signInResult?.error) { router.push("/login"); return; }
          router.push("/dashboard");
          router.refresh();
        },
        reduceMotion ? 0 : 1100
      );
    } catch {
      setFormError(t("auth.unexpectedError"));
    } finally {
      setLoading(false);
    }
  }

  const closed = statusChecked && !registrationOpen;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-neu-bg px-4 py-8">
      <div className="w-full max-w-[400px]">
        <div className="mb-8 text-center">
          <div className="neu-raised mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl text-neu-primary">
            <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-neu-primary">{APP_NAME}</h1>
          <p className="mt-1 text-sm text-neu-muted">{t("auth.registerTitle")}</p>
        </div>

        {closed ? (
          <div className="neu-card text-center">
            <div className="neu-status-badge neu-status-badge-warning is-status-in mx-auto">
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
              </svg>
            </div>
            <h2 className="neu-status-heading neu-status-heading-warning mt-4">
              {t("auth.registrationClosedTitle")}
            </h2>
            <p className="neu-status-body mt-2">{t("auth.registrationClosedDesc")}</p>
            <div className="mt-6">
              <Link href="/login" className="neu-btn neu-focus neu-btn-block">
                {t("auth.signIn")}
              </Link>
            </div>
          </div>
        ) : (
          <>
            {/* Form panel and confirmation panel are SIBLINGS; the
                confirmation is revealed purely by the `.is-success`
                (+ `hidden`) class toggle. */}
            <div className={cn("neu-card", registered && "hidden")}>
              <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                {formError && (
                  /* Same shape as the login alert: danger is carried by the
                     2px rule + the dot (a non-text indicator, where the 3:1
                     threshold applies), so the message ink stays primary. */
                  <div
                    role="alert"
                    className="neu-inset flex items-start gap-2.5 rounded-[var(--neu-radius-md)] border-s-2 border-s-neu-red p-3 text-sm text-neu-primary"
                  >
                    <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-neu-red" />
                    <span>{formError}</span>
                  </div>
                )}
                <Input label={t("auth.fullName")} placeholder="John Doe" autoComplete="name" required error={errors.name?.message} {...register("name")} />
                <Input label={t("auth.email")} type="email" placeholder="john@example.com" autoComplete="email" required error={errors.email?.message} {...register("email")} />
                <Input label={t("auth.password")} type="password" placeholder="••••••••" autoComplete="new-password" required error={errors.password?.message} hint={t("auth.passwordHint")} {...register("password")} />
                <Input label={t("auth.confirmPassword")} type="password" placeholder="••••••••" autoComplete="new-password" required error={errors.confirmPassword?.message} {...register("confirmPassword")} />
                <Button type="submit" className="neu-btn-block" loading={loading}>{t("auth.createAccount")}</Button>
              </form>
            </div>

            <div
              aria-hidden={!registered}
              className={cn("neu-card text-center", registered ? "is-success" : "hidden")}
            >
              {/* Status badge: solid accent (not embossed), white SVG mark. */}
              <div className="neu-status-badge neu-status-badge-success mx-auto">
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </div>
              <h2 className="neu-status-heading neu-status-heading-success mt-4">
                {t("auth.accountCreatedTitle")}
              </h2>
              <p className="neu-status-body mt-2">{t("auth.accountCreatedDesc")}</p>
            </div>
          </>
        )}

        <p className="mt-6 text-center text-sm text-neu-muted">
          {t("auth.haveAccount")}{" "}
          <Link
            href="/login"
            className="neu-focus rounded-sm font-semibold text-neu-primary underline decoration-neu-cyan underline-offset-4 hover:decoration-2"
          >
            {t("auth.signInLink")}
          </Link>
        </p>
      </div>
    </div>
  );
}
