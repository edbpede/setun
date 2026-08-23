import type { WithElementRef, WithoutChildrenOrChild } from "bits-ui";
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// shadcn-svelte's vendored components import these prop helpers from `$lib/utils.js`.
// They originate in bits-ui; re-exported here so the copied components resolve them.
export type { WithElementRef, WithoutChildrenOrChild };
