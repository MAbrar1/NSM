"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { signIn } from "next-auth/react";
import { loginSchema, type LoginInput } from "@/lib/validations";
import { useI18n } from "@/components/providers/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { APP_NAME } from "@/lib/constants";

export default function LoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(data: LoginInput) {
    setError(null);
    setLoading(true);
    try {
      const result = await signIn("credentials", {
        email: data.email,
        password: data.password,
        redirect: false,
      });
      if (result?.error) {
        // A custom CredentialsSignin code (see src/lib/auth.ts) lets us tell
        // the account lockout apart from a device/IP throttle; the generic
        // Auth.js `Configuration` error means the server itself is mis-set-up,
        // so blaming the credentials there would be misleading.
        if (result.code === "rate_limited_ip") {
          setError(t("auth.tooManyAttemptsDevice"));
        } else if (result.code === "rate_limited") {
          setError(t("auth.tooManyAttempts"));
        } else if (result.error === "Configuration") {
          setError(t("auth.serverError"));
        } else {
          setError(t("auth.invalidCredentials"));
        }
        return;
      }
      // Honor the callbackUrl the middleware set when the user was sent
      // here (e.g. /orders?redirect=...), so they land where they intended.
      // Only allow same-app paths — never external URLs.
      let destination = "/dashboard";
      try {
        const target = new URLSearchParams(window.location.search).get("callbackUrl");
        if (target && target.startsWith("/") && !target.startsWith("//")) {
          destination = target;
        }
      } catch {
        /* ignore — fall back to the dashboard */
      }
      router.push(destination);
      router.refresh();
    } catch {
      setError(t("auth.unexpectedError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-neu-bg px-4 py-8">
      <div className="w-full max-w-[400px]">
        {/* Brand */}
        <div className="mb-8 text-center">
          <div className="neu-raised mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl text-neu-primary">
            <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-neu-primary">{APP_NAME}</h1>
          <p className="mt-1 text-sm text-neu-muted">{t("auth.loginTitle")}</p>
        </div>

        {/* Card — .neu-card supplies the 28px radius, the dual-direction
            emboss and the thin cyan gradient top-border. */}
        <div className="neu-card">
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
            {error && (
              /* Message ink stays primary: the vivid red would only be
                 3.16:1 at 14px, so danger is carried by the 2px rule and
                 the dot instead — a non-text indicator, where the 3:1
                 threshold applies and the red passes. */
              <div
                role="alert"
                className="neu-inset flex items-start gap-2.5 rounded-[var(--neu-radius-md)] border-s-2 border-s-neu-red p-3 text-sm text-neu-primary"
              >
                <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-neu-red" />
                <span>{error}</span>
              </div>
            )}

            <Input
              label={t("auth.email")}
              type="email"
              placeholder="admin@elitepos.com"
              autoComplete="email"
              error={errors.email?.message}
              {...register("email")}
            />

            <Input
              label={t("auth.password")}
              type="password"
              placeholder="••••••••"
              autoComplete="current-password"
              error={errors.password?.message}
              {...register("password")}
            />

            <Button type="submit" className="neu-btn-block" loading={loading}>
              {t("auth.signIn")}
            </Button>
          </form>
        </div>

        {/* Footer */}
        <p className="mt-6 text-center text-sm text-neu-muted">
          {t("auth.noAccount")}{" "}
          <Link
            href="/register"
            className="neu-focus rounded-sm font-semibold text-neu-primary underline decoration-neu-cyan underline-offset-4 hover:decoration-2"
          >
            {t("auth.createOne")}
          </Link>
        </p>
      </div>
    </div>
  );
}
