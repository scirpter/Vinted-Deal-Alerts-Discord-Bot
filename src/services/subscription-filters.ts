import { z } from 'zod';

const keywordListSchema = z.array(z.string());

export function normalizeKeywordInput(raw: string): string[] {
  const items = raw
    .split(/[\n,;]+/g)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    unique.push(item);
  }
  return unique;
}

export function serializeKeywordList(list: string[]): string | null {
  const normalized = list.map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (normalized.length === 0) return null;
  return JSON.stringify(normalized);
}

export function parseKeywordList(raw: string | null | undefined): string[] {
  if (!raw) return [];

  const trimmed = raw.trim();
  if (!trimmed) return [];

  try {
    const parsed = keywordListSchema.safeParse(JSON.parse(trimmed));
    if (parsed.success) {
      return parsed.data.map((s) => s.trim().toLowerCase()).filter(Boolean);
    }
  } catch {
    // ignore
  }

  return normalizeKeywordInput(trimmed);
}

