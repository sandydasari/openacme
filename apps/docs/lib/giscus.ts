/*
 * Giscus (GitHub Discussions-backed comments) config.
 *
 * To turn comments on:
 *   1. Enable Discussions on the repo (Settings → General → Features).
 *   2. Install the giscus app: https://github.com/apps/giscus
 *   3. Visit https://giscus.app, enter the repo, pick a Discussion category
 *      (e.g. "Announcements"), and copy the four values it generates below.
 *
 * Until repoId + categoryId are filled in, `isGiscusConfigured` is false and
 * the comments block renders nothing — so the build stays green meanwhile.
 */
export const GISCUS = {
  repo: "sandydasari/openacme" as `${string}/${string}`,
  repoId: "R_kgDOSwdwnw",
  category: "Announcements",
  categoryId: "DIC_kwDOSwdwn84C_KR5",
  mapping: "pathname",
  reactionsEnabled: "1",
  inputPosition: "top",
} as const;

export const isGiscusConfigured =
  GISCUS.repoId.length > 0 && GISCUS.categoryId.length > 0;
