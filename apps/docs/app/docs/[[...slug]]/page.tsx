import { source } from "@/lib/source";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/mdx-components";
import { JsonLd } from "@/components/json-ld";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import type { Metadata } from "next";

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const url = `${SITE_URL}${page.url}`;
  const breadcrumb = [
    { name: SITE_NAME, item: SITE_URL },
    { name: "Docs", item: `${SITE_URL}/docs` },
    ...(page.url === "/docs" ? [] : [{ name: page.data.title, item: url }]),
  ];

  return (
    <DocsPage toc={page.data.toc} full={page.data.full ?? true}>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "TechArticle",
          headline: page.data.title,
          description: page.data.description,
          url,
          mainEntityOfPage: url,
          isPartOf: { "@type": "WebSite", name: SITE_NAME, url: SITE_URL },
        }}
      />
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: breadcrumb.map((c, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: c.name,
            item: c.item,
          })),
        }}
      />
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const { title, description } = page.data;
  return {
    title,
    description,
    alternates: { canonical: page.url },
    openGraph: {
      type: "article",
      url: page.url,
      siteName: SITE_NAME,
      title,
      description,
      images: ["/og/default.png"],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/og/default.png"],
    },
  };
}
