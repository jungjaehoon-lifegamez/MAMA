export function countElementsWithClass(html: string | undefined, className: string): number {
  if (!html || !className) {
    return 0;
  }

  const uncommentedHtml = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  const elementPattern = /<[A-Za-z][A-Za-z0-9:-]*\b[^>]*>/g;
  let count = 0;

  for (const match of uncommentedHtml.matchAll(elementPattern)) {
    const openingTag = match[0];
    const tagName = /^<[A-Za-z][A-Za-z0-9:-]*/.exec(openingTag);
    if (!tagName) {
      continue;
    }

    let index = tagName[0].length;
    while (index < openingTag.length) {
      while (/\s/.test(openingTag[index] ?? '')) {
        index += 1;
      }
      if (openingTag[index] === '>' || openingTag[index] === '/') {
        break;
      }

      const nameStart = index;
      while (index < openingTag.length && !/[\s=/>]/.test(openingTag[index] ?? '')) {
        index += 1;
      }
      if (index === nameStart) {
        index += 1;
        continue;
      }
      const attributeName = openingTag.slice(nameStart, index).toLowerCase();
      while (/\s/.test(openingTag[index] ?? '')) {
        index += 1;
      }
      if (openingTag[index] !== '=') {
        continue;
      }
      index += 1;
      while (/\s/.test(openingTag[index] ?? '')) {
        index += 1;
      }

      const quote = openingTag[index];
      if (quote !== '"' && quote !== "'") {
        while (index < openingTag.length && !/[\s>]/.test(openingTag[index] ?? '')) {
          index += 1;
        }
        continue;
      }
      const valueStart = index + 1;
      const valueEnd = openingTag.indexOf(quote, valueStart);
      if (valueEnd === -1) {
        break;
      }
      if (attributeName === 'class') {
        const classTokens = openingTag.slice(valueStart, valueEnd).split(/\s+/).filter(Boolean);
        if (classTokens.includes(className)) {
          count += 1;
        }
        break;
      }
      index = valueEnd + 1;
    }
  }

  return count;
}

export function countActionRequiredCards(html: string | undefined): number {
  return countElementsWithClass(html, 'report-card');
}
