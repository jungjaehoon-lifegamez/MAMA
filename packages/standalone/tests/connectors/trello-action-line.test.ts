import { describe, expect, it } from 'vitest';

import { trelloActionLine } from '../../src/connectors/trello/action-line.js';

const member = { id: 'm', fullName: 'Member A' };
const card = { id: 'c', name: 'Card' };

describe('trelloActionLine', () => {
  it('names the change of each card update shape', () => {
    const line = (old: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      trelloActionLine({
        type: 'updateCard',
        data: { card: { ...card, ...extra }, list: { id: 'l', name: 'Doing' }, old },
        memberCreator: member,
      });
    expect(line({ pos: 1 })).toBe('Card | reordered in Doing | Member A');
    expect(line({ idList: 'x' })).toBe('Card | moved to another list | Member A');
    expect(line({ closed: false }, { closed: true })).toBe('Card | archived | Member A');
    expect(line({ due: null }, { due: '2026-09-30T09:00:00.000Z' })).toBe(
      'Card | due none -> 2026-09-30T09:00:00.000Z | Member A'
    );
    expect(line({ dueComplete: false }, { dueComplete: true })).toBe('Card | due done | Member A');
    expect(line({ idLabels: [] })).toBe('Card | labels changed | Member A');
    expect(line({ name: 'Old' })).toBe('Card | renamed from "Old" | Member A');
  });

  it('describes card, list and board actions without an actor when none is given', () => {
    expect(
      trelloActionLine({
        type: 'copyCard',
        data: { card, list: { name: 'Waiting' }, cardSource: { name: 'Template' } },
      })
    ).toBe('Card | copied into Waiting from "Template"');
    expect(
      trelloActionLine({
        type: 'addAttachmentToCard',
        data: { card, attachment: { name: 'a.png' } },
      })
    ).toBe('Card | attached a.png');
    expect(
      trelloActionLine({ type: 'moveCardToBoard', data: { card, list: { name: 'Delivered' } } })
    ).toBe('Card | moved here from another board into Delivered');
    expect(trelloActionLine({ type: 'createList', data: { list: { name: 'New' } } })).toBe(
      'New | list created'
    );
    expect(
      trelloActionLine({ type: 'enableBoardPlugin', data: { board: { name: 'Board' } } })
    ).toBe('Board | enableBoardPlugin');
  });
});
