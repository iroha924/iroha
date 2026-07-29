import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary: "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline: "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost: "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
        // Brand status tints (matcha/amber/persimmon/paper) — soft, tone-based
        // pills for approved / pending / rejected / neutral state (brand-and-design.md).
        approve: "bg-approve-tint text-approve",
        pending: "bg-warn-tint text-warn",
        reject: "bg-persimmon-tint text-persimmon-hover",
        neutral: "bg-paper-inset text-ink-muted",
        // Knowledge-type tints, one per canonical type, drawn from the same brand
        // family as the chart series so the Review queue and the Overview
        // composition read as the same palette (`lib/status.ts`).
        matcha: "bg-approve-tint text-approve",
        persimmon: "bg-persimmon-tint text-persimmon-hover",
        // clay is decoration-only per brand-and-design.md, so it tints the surface
        // and the label stays sumi ink rather than becoming clay-coloured text.
        clay: "bg-clay-tint text-ink",
        amber: "bg-warn-tint text-warn",
        fuji: "bg-fuji-tint text-fuji",
        suou: "bg-suou-tint text-suou",
        asagi: "bg-asagi-tint text-asagi",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props,
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  });
}

export { Badge, badgeVariants };
