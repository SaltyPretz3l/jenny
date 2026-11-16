// Jenny's replacement for upstream src/icons.ts: one bundled Lucide set, no Simple Icons, no file reads.
// An unknown icon name is reported as unknown (hasIcon false, resolveIcon undefined), never thrown;
// the checking layer drops such an icon before the strict builder sees it.
import lucide from "@iconify-json/lucide/icons.json";

type IconSet = {
  width?: number;
  height?: number;
  icons: Record<string, { body: string; width?: number; height?: number }>;
  aliases?: Record<string, { parent: string }>;
};
const set = lucide as unknown as IconSet;

function keyFor(name: string): string | undefined {
  const [prefix, iconName] = name.includes(":") ? name.split(":", 2) : ["lucide", name];
  if (prefix !== "lucide" || !iconName) return undefined;
  if (Object.hasOwn(set.icons, iconName)) return iconName;
  const alias = set.aliases && Object.hasOwn(set.aliases, iconName) ? set.aliases[iconName] : undefined;
  return alias && Object.hasOwn(set.icons, alias.parent) ? alias.parent : undefined;
}

export function hasIcon(name: string): boolean {
  return keyFor(name) !== undefined;
}

export function resolveIcon(name: string): { body: string; width: number; height: number } | undefined {
  const key = keyFor(name);
  if (!key) return undefined;
  const icon = set.icons[key]!;
  return { body: icon.body, width: icon.width ?? set.width ?? 24, height: icon.height ?? set.height ?? 24 };
}

export function suggestIcons(_query?: string, _limit?: number): string[] {
  return [];
}
