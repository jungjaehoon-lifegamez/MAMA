import { describe, expect, it } from 'vitest';
import {
  countActionRequiredCards,
  countElementsWithClass,
} from '../../src/api/operator-summary.js';

describe('Story M9.4: Operator report summary', () => {
  it('counts multiple exact report-card elements', () => {
    const html = '<div class="report-card">A</div><article class="report-card">B</article>';
    expect(countActionRequiredCards(html)).toBe(2);
  });

  it('supports mixed class order, extra classes, and single quotes', () => {
    const html = [
      '<div class="urgent report-card selected"></div>',
      "<section class='report-card quiet'></section>",
    ].join('');
    expect(countActionRequiredCards(html)).toBe(2);
  });

  it('ignores partial tokens, text, and unrelated attributes', () => {
    const html = [
      '<div class="report-card-extra"></div>',
      '<div data-class="report-card"></div>',
      '<p>report-card</p>',
    ].join('');
    expect(countActionRequiredCards(html)).toBe(0);
  });

  it('ignores report cards inside HTML comments', () => {
    expect(countActionRequiredCards('<!-- <div class="report-card">Hidden</div> -->')).toBe(0);
  });

  it('ignores class-like tokens inside quoted attributes', () => {
    expect(countActionRequiredCards('<div title="Use class=\'report-card\' here"></div>')).toBe(0);
  });

  it('handles greater-than characters inside quoted attributes before the class attribute', () => {
    const html = '<div data-info="foo > bar" class="report-card"></div>';
    expect(countActionRequiredCards(html)).toBe(1);
  });

  it('ignores malformed and non-element strings', () => {
    expect(countActionRequiredCards('class="report-card" < class="report-card">')).toBe(0);
  });

  it('returns zero for missing or empty HTML', () => {
    expect(countActionRequiredCards(undefined)).toBe(0);
    expect(countActionRequiredCards('')).toBe(0);
  });

  it('counts an arbitrary exact class token', () => {
    expect(countElementsWithClass('<aside class="one target two"></aside>', 'target')).toBe(1);
  });
});
