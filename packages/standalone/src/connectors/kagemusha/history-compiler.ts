/**
 * Kagemusha History Compiler
 * Groups messages by month for batch compilation via LLM extraction.
 */

import type { NormalizedItem } from '../framework/types.js';

/**
 * Group NormalizedItems by year-month (YYYY-MM).
 */
export function groupByMonth(items: NormalizedItem[]): Map<string, NormalizedItem[]> {
  const map = new Map<string, NormalizedItem[]>();
  for (const item of items) {
    const key = item.timestamp.toISOString().substring(0, 7);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  return map;
}

/**
 * Get compilation stats for a set of items grouped by month.
 */
export function getCompilationStats(grouped: Map<string, NormalizedItem[]>): {
  months: string[];
  totalItems: number;
  perMonth: Record<string, number>;
} {
  const months = Array.from(grouped.keys()).sort();
  const perMonth: Record<string, number> = {};
  let totalItems = 0;
  for (const [month, items] of grouped) {
    perMonth[month] = items.length;
    totalItems += items.length;
  }
  return { months, totalItems, perMonth };
}
