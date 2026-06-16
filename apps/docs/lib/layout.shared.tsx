import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { LogoLockup } from "@/components/logo";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <LogoLockup />,
    },
    githubUrl: "https://github.com/sandydasari/openacme",
    links: [
      {
        text: "Docs",
        url: "/docs",
        active: "nested-url",
      },
      {
        text: "Blog",
        url: "/blog",
        active: "nested-url",
      },
      {
        text: "Changelog",
        url: "/changelog",
        active: "nested-url",
      },
    ],
  };
}
