import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";

/* ═══════════════════════════════════════════════════════════════
   BUTTON — Electric Embossed Neumorphism

   Every shadow (the raised rest state, the inset pressed state, the
   flatter disabled state) is declared once in `.neu-btn` /
   `.neu-btn-sm` / `.neu-btn-icon*` in globals.css. Nothing here
   writes a box-shadow.

   Sizes follow the spec: the default CTA is 52px/600, `--sm` is
   36px/13px and `--icon` is a 44px square. `.neu-btn` deliberately
   does NOT force `width: 100%` — the spec's "full width" applies to
   the form CTA, and ~170 call sites use buttons inside toolbars,
   table rows and icon slots. Pass `neu-btn-block` (or `w-full`) for
   the full-width form button; the auth screens do.
   ═══════════════════════════════════════════════════════════════ */

const buttonVariants = cva(
  [
    "neu-btn neu-focus",
    "whitespace-nowrap",
    "disabled:pointer-events-none",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        /* The spec's canonical button: neutral embossed surface.
           The emboss itself is the affordance and the pressed state
           is the feedback, so there is no hover colour change here.
           In Golden Elite, `.golden .neu-btn-solid` re-skins this SAME
           button into the gold-gradient CTA (sheen site #1). In Neu
           light/dark there is no `.neu-btn-solid` rule, so the class is
           inert and the button is unchanged. */
        primary: "neu-btn-solid",
        /* Quieter action in a pair. Muted → primary on hover keeps
           both ends above AA (6.4:1 → 8.3:1). */
        secondary: "text-neu-muted hover:text-neu-primary",
        /* Tertiary: no emboss at all, so it can sit inside a card. */
        ghost: "shadow-none text-neu-muted hover:text-neu-primary",
        /* Neutral surface; text turns red on hover (spec). */
        danger: "neu-btn-danger",
        success: "",
        link: "neu-btn-plain",
        pos: "neu-btn-solid h-14 rounded-2xl text-lg",
      },
      size: {
        xs: "h-8 px-3 text-xs rounded-[var(--neu-radius-sm)]",
        sm: "neu-btn-sm",
        md: "",
        lg: "h-11 px-6 text-base",
        xl: "h-12 px-7 text-base",
        icon: "neu-btn-icon",
        "icon-sm": "neu-btn-icon-sm",
        "icon-lg": "neu-btn-icon-lg",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading = false,
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const classes = cn(buttonVariants({ variant, size, className }));

    if (asChild && React.isValidElement(children)) {
      const Child = children.type as React.ComponentType<Record<string, unknown>>;
      const childProps = (children.props ?? {}) as Record<string, unknown>;
      return (
        <Child
          {...childProps}
          className={cn(classes, childProps["className"] as string)}
          {...props}
        />
      );
    }

    return (
      <button
        // A bare <button> defaults to type="submit", so ANY Button inside a
        // <form> submits unless it opts out. That silently made the cancel
        // buttons in the CRUD modals SAVE instead of discard. Defaulting to
        // "button" makes submitting the deliberate act it reads as; an
        // explicit `type` still wins because props spread last.
        type={props.type ?? "button"}
        className={classes}
        ref={ref}
        disabled={disabled || loading}
        {...props}
      >
        {loading && <Spinner className="-ms-1" />}
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";

export { Button, buttonVariants };
