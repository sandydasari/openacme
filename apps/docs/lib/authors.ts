export type Author = {
  name: string;
  role?: string;
  url?: string;
};

export const AUTHORS: Record<string, Author> = {
  team: {
    name: "The OpenAcme team",
    role: "Maintainers",
    url: "https://github.com/sandydasari/openacme",
  },
  sandy: {
    name: "Sandy Dasari",
    role: "Creator",
    url: "https://github.com/sandydasari",
  },
};

export function getAuthor(id: string): Author {
  return AUTHORS[id] ?? { name: id };
}
