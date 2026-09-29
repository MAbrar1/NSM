import * as React from "react";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   INPUT — Electric Embossed Neumorphism

   The recessed surface, the cyan focus ring + glow, the red error
   ring and the flatter disabled state are all defined once in
   `.neu-input` (globals.css). Browser chrome (appearance, outline,
   border, number spinners) is stripped there too, so nothing here
   has to opt out of it.

   Variants:
   - default (email / text / password / numeric): 48px tall,
     16px/500, start-aligned, 16px inline padding.
   - otp: 56×64px box, 24px/700, centred and tabular — the OTP entry
     surface from the reference.
   ═══════════════════════════════════════════════════════════════ */

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  wrapperClassName?: string;
  /** OTP boxes are a different box spec, not a different component. */
  variant?: "default" | "otp";
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      type = "text",
      label,
      error,
      hint,
      leftIcon,
      rightIcon,
      wrapperClassName,
      variant = "default",
      id,
      required,
      ...props
    },
    ref
  ) => {
    const generatedId = React.useId();
    const inputId = id || generatedId;
    const otp = variant === "otp";
    const invalid = Boolean(error) || props["aria-invalid"] === true;

    return (
      <div className={cn("flex flex-col gap-2", wrapperClassName)}>
        {label && (
          <label
            htmlFor={inputId}
            data-required={required ? "true" : undefined}
            className="neu-label"
          >
            {label}
          </label>
        )}
        <div className={cn("relative", otp && "flex justify-center")}>
          {leftIcon && (
            <div className="pointer-events-none absolute start-4 top-1/2 -translate-y-1/2 text-neu-muted [&_svg]:h-4 [&_svg]:w-4">
              {leftIcon}
            </div>
          )}
          <input
            type={type}
            id={inputId}
            ref={ref}
            required={required}
            aria-invalid={invalid ? true : undefined}
            className={cn(
              "neu-input neu-focus",
              otp && "neu-input-otp",
              leftIcon && !otp && "ps-11",
              rightIcon && !otp && "pe-11",
              className
            )}
            {...props}
          />
          {rightIcon && (
            <div className="absolute end-4 top-1/2 -translate-y-1/2 text-neu-muted [&_svg]:h-4 [&_svg]:w-4">
              {rightIcon}
            </div>
          )}
        </div>
        {(error || hint) && (
          /* Error text is ink, not the vivid accent — 12px needs 4.5:1. */
          <p className={cn("text-xs", error ? "text-neu-ink-red" : "text-neu-muted")}>
            {error || hint}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = "Input";

export { Input };
