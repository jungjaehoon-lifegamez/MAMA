/**
 * The backfill file: what a reader concluded about one period of raw, in a form a push can
 * write without judging anything.
 *
 * The reader (an agent) reads the whole period, decides the pieces of work and writes each one
 * complete, like a history: its revisions in event order, each at the time of the message that
 * shows the change and citing it. The push turns the file into the owner's own actions, so the
 * same write contract checks every row. Sources are named by their exact
 * `connector_event_index.source_id`; the push resolves them to observation refs after import.
 *
 * Lines judged not to be work stay in the file (`noUpdate`): `work.no_update` keeps nothing
 * outside a model turn, so this is the one part of the reader's coverage that MAMA does not hold.
 */
import { LINK_RELATIONS, offsetIsoTime } from '../api/work-actions.js';
import { isValidPageType, type WikiPageType } from '../wiki/types.js';

export const BACKFILL_FORMAT = 'mama-backfill/1';

export type BackfillLinkRelation = (typeof LINK_RELATIONS)[number];

export interface BackfillRevision {
  at: number;
  summary: string;
  set?: Record<string, unknown>;
  clear?: string[];
  sources: string[];
}

export interface BackfillItem {
  key: string;
  /** Existing work this period's history belongs to; absent for work first seen here. */
  commitmentId?: string;
  /** When this period's revisions of existing work stop applying; the push computes it if absent. */
  appliesUntil?: number;
  topic?: string;
  revisions: BackfillRevision[];
  /** Lines about the item that change nothing, grouped by the reason the reader states. */
  mentions?: Array<{ reason: string; sources: string[] }>;
  links?: Array<{
    to: { item: string } | { commitmentId: string };
    relation: BackfillLinkRelation;
    reason: string;
    sources?: string[];
  }>;
}

export interface BackfillLesson {
  key: string;
  at: number;
  topic: string;
  summary: string;
  details: string;
  /** When the lesson applies; the ledger refuses a lesson without it. */
  appliesWhen: string;
  sources: string[];
}

/**
 * A wiki page the period adds: a new page carries its whole content; an existing page gets
 * section appends, so its title, metadata and earlier evidence stay as they are.
 */
export type BackfillWikiPage =
  | { path: string; title: string; type: WikiPageType; content: string; sources?: string[] }
  | { path: string; append: Array<{ section: string; text: string }>; sources?: string[] };

export interface BackfillFile {
  format: typeof BACKFILL_FORMAT;
  period: { from: number; until: number };
  items: BackfillItem[];
  lessons: BackfillLesson[];
  wiki: BackfillWikiPage[];
  noUpdate: Array<{ reason: string; sources: string[] }>;
  /** Links between pieces of work where the source is existing work, e.g. a later case that builds on one of this period. */
  links: BackfillWorkLink[];
}

export type BackfillWorkRef = { item: string } | { commitmentId: string };

export interface BackfillWorkLink {
  from: BackfillWorkRef;
  to: BackfillWorkRef;
  relation: BackfillLinkRelation;
  reason: string;
  sources?: string[];
}

type Json = Record<string, unknown>;

/** Parse and check a backfill file. Every problem is listed at once; nothing is guessed. */
export function parseBackfillFile(raw: unknown): BackfillFile {
  const errors: string[] = [];
  const fail = (where: string, message: string): undefined => {
    errors.push(`${where}: ${message}`);
    return undefined;
  };
  const object = (value: unknown, where: string, keys: readonly string[]): Json | undefined => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return fail(where, 'must be an object');
    // A field the format does not know is refused, so `recordedAt` and the like cannot slip in.
    for (const key of Object.keys(value))
      if (!keys.includes(key)) fail(where, `unknown field ${key}`);
    return value as Json;
  };
  const text = (value: unknown, where: string): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value : fail(where, 'must be nonblank text');
  const time = (value: unknown, where: string): number | undefined =>
    offsetIsoTime(value) ?? fail(where, 'must be an ISO time with its offset');
  const list = (value: unknown, where: string, min = 1): unknown[] | undefined =>
    Array.isArray(value) && value.length >= min
      ? value
      : fail(where, `must be a list of at least ${min}`);
  const sources = (value: unknown, where: string): string[] => {
    const entries = list(value, where) ?? [];
    return entries.flatMap((entry, index) => text(entry, `${where}[${index}]`) ?? []);
  };
  const ref = (value: unknown, where: string): BackfillWorkRef | undefined => {
    const target = object(value, where, ['item', 'commitmentId']);
    if (!target) return undefined;
    if ((target.item === undefined) === (target.commitmentId === undefined))
      return fail(where, 'must name exactly one of item or commitmentId');
    if (target.item !== undefined) {
      const key = text(target.item, `${where}.item`);
      return key === undefined ? undefined : { item: key };
    }
    const id = text(target.commitmentId, `${where}.commitmentId`);
    return id === undefined ? undefined : { commitmentId: id };
  };

  const file = object(raw, 'file', [
    'format',
    'period',
    'items',
    'lessons',
    'wiki',
    'noUpdate',
    'links',
  ]);
  if (!file) throw new Error(errors.join('\n'));
  if (file.format !== BACKFILL_FORMAT) fail('format', `must be ${BACKFILL_FORMAT}`);
  const period = object(file.period, 'period', ['from', 'until']);
  const from = time(period?.from, 'period.from');
  const until = time(period?.until, 'period.until');
  if (from !== undefined && until !== undefined && from >= until)
    fail('period', 'from must come before until');
  const inPeriod = (at: number | undefined, where: string): void => {
    if (at !== undefined && from !== undefined && until !== undefined && (at < from || at >= until))
      fail(where, 'is outside the period');
  };

  const keys = new Set<string>();
  const items: BackfillItem[] = (list(file.items, 'items') ?? []).flatMap((value, index) => {
    const where = `items[${index}]`;
    const item = object(value, where, [
      'key',
      'commitmentId',
      'appliesUntil',
      'topic',
      'revisions',
      'mentions',
      'links',
    ]);
    if (!item) return [];
    const key = text(item.key, `${where}.key`) ?? where;
    if (keys.has(key)) fail(`${where}.key`, `repeats ${key}`);
    keys.add(key);
    const at = `item ${key}`;
    const commitmentId =
      item.commitmentId === undefined ? undefined : text(item.commitmentId, `${at}.commitmentId`);
    if (commitmentId === undefined && item.appliesUntil !== undefined)
      fail(`${at}.appliesUntil`, 'belongs only to existing work (commitmentId)');
    if (commitmentId !== undefined && item.topic !== undefined)
      fail(`${at}.topic`, 'belongs only to new work');
    const appliesUntil =
      item.appliesUntil === undefined ? undefined : time(item.appliesUntil, `${at}.appliesUntil`);
    const revisions = (list(item.revisions, `${at}.revisions`) ?? []).flatMap((entry, n) => {
      const rw = `${at}.revisions[${n}]`;
      const revision = object(entry, rw, ['at', 'summary', 'set', 'clear', 'sources']);
      if (!revision) return [];
      const when = time(revision.at, `${rw}.at`);
      inPeriod(when, `${rw}.at`);
      // The work fields are the ledger's to check; here the patch only has to be an object.
      const set =
        revision.set === undefined
          ? undefined
          : typeof revision.set === 'object' &&
              revision.set !== null &&
              !Array.isArray(revision.set)
            ? (revision.set as Json)
            : fail(`${rw}.set`, 'must be an object');
      const clear =
        revision.clear === undefined
          ? undefined
          : (list(revision.clear, `${rw}.clear`) ?? []).flatMap(
              (field, c) => text(field, `${rw}.clear[${c}]`) ?? []
            );
      return [
        {
          at: when ?? 0,
          summary: text(revision.summary, `${rw}.summary`) ?? '',
          ...(set === undefined ? {} : { set }),
          ...(clear === undefined ? {} : { clear }),
          sources: sources(revision.sources, `${rw}.sources`),
        },
      ];
    });
    for (let n = 1; n < revisions.length; n++)
      if (revisions[n]!.at < revisions[n - 1]!.at)
        fail(`${at}.revisions[${n}].at`, 'is earlier than the revision before it');
    // At a time inside the period the fold starts from these revisions alone, so the first one
    // must say what the work is.
    if (revisions[0] && typeof revisions[0].set?.title !== 'string')
      fail(`${at}.revisions[0].set.title`, 'the first revision must state the title');
    const last = revisions[revisions.length - 1];
    if (appliesUntil !== undefined && last && appliesUntil <= last.at)
      fail(`${at}.appliesUntil`, 'must follow every revision of the period');
    const mentions = (
      item.mentions === undefined ? [] : (list(item.mentions, `${at}.mentions`) ?? [])
    ).flatMap((entry, n) => {
      const mw = `${at}.mentions[${n}]`;
      const m = object(entry, mw, ['reason', 'sources']);
      return m
        ? [
            {
              reason: text(m.reason, `${mw}.reason`) ?? '',
              sources: sources(m.sources, `${mw}.sources`),
            },
          ]
        : [];
    });
    const links = (item.links === undefined ? [] : (list(item.links, `${at}.links`) ?? [])).flatMap(
      (entry, n) => {
        const lw = `${at}.links[${n}]`;
        const link = object(entry, lw, ['to', 'relation', 'reason', 'sources']);
        if (!link) return [];
        const to = ref(link.to, `${lw}.to`);
        if (!(LINK_RELATIONS as readonly unknown[]).includes(link.relation))
          fail(`${lw}.relation`, `must be one of ${LINK_RELATIONS.join(', ')}`);
        if (!to) return [];
        return [
          {
            to,
            relation: link.relation as BackfillLinkRelation,
            reason: text(link.reason, `${lw}.reason`) ?? '',
            ...(link.sources === undefined
              ? {}
              : { sources: sources(link.sources, `${lw}.sources`) }),
          },
        ];
      }
    );
    return [
      {
        key,
        ...(commitmentId === undefined ? {} : { commitmentId }),
        ...(appliesUntil === undefined ? {} : { appliesUntil }),
        ...(item.topic === undefined ? {} : { topic: text(item.topic, `${at}.topic`) ?? '' }),
        revisions,
        ...(mentions.length === 0 ? {} : { mentions }),
        ...(links.length === 0 ? {} : { links }),
      },
    ];
  });
  for (const item of items)
    for (const link of item.links ?? [])
      if ('item' in link.to && (!keys.has(link.to.item) || link.to.item === item.key))
        fail(`item ${item.key}.links`, `names no other item ${link.to.item}`);

  const lessonKeys = new Set<string>();
  const lessons: BackfillLesson[] = (
    file.lessons === undefined ? [] : (list(file.lessons, 'lessons', 0) ?? [])
  ).flatMap((value, index) => {
    const where = `lessons[${index}]`;
    const lesson = object(value, where, [
      'key',
      'at',
      'topic',
      'summary',
      'details',
      'appliesWhen',
      'sources',
    ]);
    if (!lesson) return [];
    const key = text(lesson.key, `${where}.key`) ?? where;
    if (lessonKeys.has(key)) fail(`${where}.key`, `repeats ${key}`);
    lessonKeys.add(key);
    const at = time(lesson.at, `${where}.at`);
    inPeriod(at, `${where}.at`);
    return [
      {
        key,
        at: at ?? 0,
        topic: text(lesson.topic, `${where}.topic`) ?? '',
        summary: text(lesson.summary, `${where}.summary`) ?? '',
        details: text(lesson.details, `${where}.details`) ?? '',
        appliesWhen: text(lesson.appliesWhen, `${where}.appliesWhen`) ?? '',
        sources: sources(lesson.sources, `${where}.sources`),
      },
    ];
  });

  const paths = new Set<string>();
  const wiki: BackfillWikiPage[] = (
    file.wiki === undefined ? [] : (list(file.wiki, 'wiki', 0) ?? [])
  ).flatMap((value, index): BackfillWikiPage[] => {
    const where = `wiki[${index}]`;
    const page = object(value, where, ['path', 'title', 'type', 'content', 'append', 'sources']);
    if (!page) return [];
    const path = text(page.path, `${where}.path`) ?? '';
    if (path.startsWith('/') || path.split('/').includes('..') || !path.endsWith('.md'))
      fail(`${where}.path`, 'must be a relative .md path inside the wiki');
    if (paths.has(path)) fail(`${where}.path`, `repeats ${path}`);
    paths.add(path);
    const pageSources =
      page.sources === undefined ? {} : { sources: sources(page.sources, `${where}.sources`) };
    if (page.append === undefined) {
      const type = text(page.type, `${where}.type`);
      if (type !== undefined && !isValidPageType(type))
        fail(`${where}.type`, 'must be a supported wiki page type');
      return [
        {
          path,
          title: text(page.title, `${where}.title`) ?? '',
          type: type as WikiPageType,
          content: text(page.content, `${where}.content`) ?? '',
          ...pageSources,
        },
      ];
    }
    if (page.title !== undefined || page.type !== undefined || page.content !== undefined)
      fail(
        where,
        'carries either title, type and content (a new page) or append (an existing page)'
      );
    const append = (list(page.append, `${where}.append`) ?? []).flatMap((entry, n) => {
      const edit = object(entry, `${where}.append[${n}]`, ['section', 'text']);
      if (!edit) return [];
      const section = text(edit.section, `${where}.append[${n}].section`) ?? '';
      if (!/^#{1,6}\s/.test(section))
        fail(`${where}.append[${n}].section`, 'must be a Markdown heading line');
      return [{ section, text: text(edit.text, `${where}.append[${n}].text`) ?? '' }];
    });
    return [{ path, append, ...pageSources }];
  });

  const noUpdate = (
    file.noUpdate === undefined ? [] : (list(file.noUpdate, 'noUpdate', 0) ?? [])
  ).flatMap((value, index) => {
    const entry = object(value, `noUpdate[${index}]`, ['reason', 'sources']);
    if (!entry) return [];
    return [
      {
        reason: text(entry.reason, `noUpdate[${index}].reason`) ?? '',
        sources: sources(entry.sources, `noUpdate[${index}].sources`),
      },
    ];
  });

  const workRef = (value: unknown, where: string): BackfillWorkRef | undefined => {
    const found = ref(value, where);
    if (found && 'item' in found && !keys.has(found.item))
      fail(`${where}.item`, `names no item ${found.item}`);
    return found;
  };
  const links: BackfillWorkLink[] = (
    file.links === undefined ? [] : (list(file.links, 'links', 0) ?? [])
  ).flatMap((value, index) => {
    const where = `links[${index}]`;
    const link = object(value, where, ['from', 'to', 'relation', 'reason', 'sources']);
    if (!link) return [];
    const from = workRef(link.from, `${where}.from`);
    const to = workRef(link.to, `${where}.to`);
    if (from && to && JSON.stringify(from) === JSON.stringify(to))
      fail(where, 'links work to itself');
    if (!(LINK_RELATIONS as readonly unknown[]).includes(link.relation))
      fail(`${where}.relation`, `must be one of ${LINK_RELATIONS.join(', ')}`);
    if (!from || !to) return [];
    return [
      {
        from,
        to,
        relation: link.relation as BackfillLinkRelation,
        reason: text(link.reason, `${where}.reason`) ?? '',
        ...(link.sources === undefined
          ? {}
          : { sources: sources(link.sources, `${where}.sources`) }),
      },
    ];
  });

  if (errors.length > 0) throw new Error(`Backfill file is invalid:\n${errors.join('\n')}`);
  return {
    format: BACKFILL_FORMAT,
    period: { from: from!, until: until! },
    items,
    lessons,
    wiki,
    noUpdate,
    links,
  };
}
