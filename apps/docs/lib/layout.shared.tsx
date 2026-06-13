import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { LogoLockup } from "@/components/logo";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <LogoLockup />,
    },
    links: [
      {
        text: "Docs",
        url: "/docs",
        active: "nested-url",
      },
    ],
  };
}
