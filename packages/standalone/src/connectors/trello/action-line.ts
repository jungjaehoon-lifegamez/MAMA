/**
 * One readable line for a Trello board action, in the poller's shape:
 * "card | list (from: previous list) | who". Imported history is stored as this line so search,
 * source.recent and source.read show what happened; the whole action stays in the item metadata.
 */

export interface TrelloActionLike {
  type: string;
  data: Record<string, unknown>;
  memberCreator?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function name(value: unknown): string | undefined {
  return text(record(value)?.name);
}

function cardChange(data: Record<string, unknown>): string {
  const card = record(data.card) ?? {};
  const old = record(data.old) ?? {};
  const before = name(data.listBefore);
  const after = name(data.listAfter);
  const parts: string[] = [];
  if (after !== undefined) parts.push(`${after} (from: ${before ?? 'another list'})`);
  else if ('idList' in old) parts.push('moved to another list');
  for (const key of Object.keys(old)) {
    if (key === 'idList' || key === 'pos') continue;
    if (key === 'closed') parts.push(card.closed === true ? 'archived' : 'restored');
    else if (key === 'name') parts.push(`renamed from "${String(old.name)}"`);
    else if (key === 'desc') parts.push('description edited');
    else if (key === 'due')
      parts.push(`due ${String(old.due ?? 'none')} -> ${String(card.due ?? 'none')}`);
    else if (key === 'dueComplete')
      parts.push(card.dueComplete === true ? 'due done' : 'due reopened');
    else if (key === 'idLabels') parts.push('labels changed');
    else parts.push(`${key} changed`);
  }
  if (parts.length === 0 && 'pos' in old)
    parts.push(`reordered in ${name(data.list) ?? 'its list'}`);
  return parts.length > 0 ? parts.join('; ') : 'updated';
}

function listChange(data: Record<string, unknown>): string {
  const old = record(data.old) ?? {};
  if ('name' in old) return `list renamed from "${String(old.name)}"`;
  if ('closed' in old)
    return record(data.list)?.closed === true ? 'list archived' : 'list restored';
  if ('pos' in old) return 'list reordered';
  return 'list updated';
}

function describe(action: TrelloActionLike): string {
  const data = action.data;
  switch (action.type) {
    case 'updateCard':
      return cardChange(data);
    case 'createCard':
      return `created in ${name(data.list) ?? 'a list'}`;
    case 'copyCard':
      return `copied into ${name(data.list) ?? 'a list'} from "${name(data.cardSource) ?? 'a card'}"`;
    case 'commentCard':
    case 'copyCommentCard':
      return `comment: ${(text(data.text) ?? '').replace(/\s*\n\s*/g, ' / ')}`;
    case 'addAttachmentToCard':
      return `attached ${name(data.attachment) ?? 'a file'}`;
    case 'deleteAttachmentFromCard':
      return `removed attachment ${name(data.attachment) ?? ''}`.trim();
    case 'addMemberToCard':
      return `member added: ${name(data.member) ?? 'unknown'}`;
    case 'removeMemberFromCard':
      return `member removed: ${name(data.member) ?? 'unknown'}`;
    case 'addLabelToCard':
      return `label added: ${name(data.label) ?? 'unnamed'}`;
    case 'removeLabelFromCard':
      return `label removed: ${name(data.label) ?? 'unnamed'}`;
    case 'updateCheckItemStateOnCard':
      return `checklist ${name(data.checkItem) ?? 'item'}: ${String(record(data.checkItem)?.state ?? 'changed')}`;
    case 'moveCardToBoard':
      return `moved here from another board into ${name(data.list) ?? 'a list'}`;
    case 'moveCardFromBoard':
      return 'moved to another board';
    case 'deleteCard':
      return 'deleted';
    case 'createList':
      return 'list created';
    case 'updateList':
      return listChange(data);
    default:
      return action.type;
  }
}

export function trelloActionLine(action: TrelloActionLike): string {
  const data = action.data;
  const subject =
    name(data.card) ?? name(data.list) ?? name(data.board) ?? text(action.type) ?? 'trello';
  const member = record(action.memberCreator);
  const actor = text(member?.fullName) ?? text(member?.username);
  return [subject, describe(action), ...(actor === undefined ? [] : [actor])].join(' | ');
}
