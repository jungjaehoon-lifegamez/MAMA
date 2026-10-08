/**
 * Memory Timeline Module - what was saved, and when
 * @module modules/memory-timeline
 *
 * The memory view's list: a period (today, 7 days, 30 days or one day), then by day, then by
 * kind, then by work item and its updates. Every filter is a server read, so the list and the
 * counts on the kind chips always describe the same records.
 */

/* eslint-env browser */

import { escapeAttr, escapeHtml, debounce, getElementByIdOrNull } from '../utils/dom.js';
import {
  API,
  type MemoryTimelineResponse,
  type TimelineGroup,
  type TimelineItem,
  type TimelineRecord,
} from '../utils/api.js';

/** The groups the server names first, in its order, with the words and colours the list shows. */
const GROUPS: Record<string, { label: string; hint: string; color: string }> = {
  owner_rule: {
    label: 'Owner rules',
    hint: 'Rules the owner set in their own chat',
    color: '#FB7185',
  },
  learned: {
    label: 'Learned rules',
    hint: 'Lessons, preferences, constraints and workflows learned in other turns',
    color: '#FBBF24',
  },
  decision: { label: 'Decisions', hint: 'Decisions recorded', color: '#60A5FA' },
  fact: { label: 'Facts', hint: 'Facts recorded', color: '#2DD4BF' },
  work: { label: 'Work updates', hint: 'Work items opened or updated', color: '#FB923C' },
};

const VIA_LABELS: Record<string, string> = {
  owner_chat: 'owner chat',
  source_delta: 'source update',
  report: 'report',
};

const OPERATION_LABELS: Record<string, string> = {
  create: 'opened',
  revise: 'updated',
  withdraw: 'withdrawn',
};

export function groupInfo(group: string): { label: string; hint: string; color: string } {
  return GROUPS[group] ?? { label: group, hint: `Records of kind ${group}`, color: '#CBD5E1' };
}

function dayLabel(day: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));
}

export class MemoryTimelineModule {
  period = '7d';
  day: string | null = null;
  query = '';
  groups = new Set<string>();
  selectedId: string | null = null;
  private request = 0;
  private bound = false;
  private debouncedLoad = debounce(() => void this.load(), 300);

  constructor(
    private readonly hooks: {
      /** A listed record was picked. */
      onSelect: (id: string) => void;
      /** The list now shows this answer; the graph draws the same records. */
      onRender: (data: MemoryTimelineResponse) => void;
    }
  ) {}

  /** Wire the controls once, then read the current period. */
  async init(): Promise<void> {
    if (!this.bound) {
      this.bind();
      this.bound = true;
    }
    await this.load();
  }

  private bind(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-memory-period]').forEach((button) => {
      button.addEventListener('click', () => {
        this.period = button.dataset.memoryPeriod ?? '7d';
        this.day = null;
        const dayInput = getElementByIdOrNull<HTMLInputElement>('memory-day');
        if (dayInput) dayInput.value = '';
        void this.load();
      });
    });
    getElementByIdOrNull<HTMLInputElement>('memory-day')?.addEventListener('change', (event) => {
      const value = (event.target as HTMLInputElement).value;
      this.day = value === '' ? null : value;
      void this.load();
    });
    getElementByIdOrNull<HTMLInputElement>('memory-timeline-search')?.addEventListener(
      'input',
      (event) => {
        this.query = (event.target as HTMLInputElement).value.trim();
        this.debouncedLoad();
      }
    );
    getElementByIdOrNull<HTMLElement>('memory-group-chips')?.addEventListener('click', (event) => {
      const chip = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-group]');
      if (!chip?.dataset.group) return;
      const group = chip.dataset.group;
      if (this.groups.has(group)) this.groups.delete(group);
      else this.groups.add(group);
      void this.load();
    });
    getElementByIdOrNull<HTMLElement>('memory-timeline')?.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-record-id]');
      if (!row?.dataset.recordId) return;
      this.select(row.dataset.recordId);
    });
  }

  private select(id: string): void {
    this.selectedId = id;
    document.querySelectorAll('#memory-timeline .mt-row.selected').forEach((row) => {
      row.classList.remove('selected');
    });
    document
      .querySelector(`#memory-timeline [data-record-id="${CSS.escape(id)}"]`)
      ?.classList.add('selected');
    this.hooks.onSelect(id);
  }

  private params(): Record<string, string> {
    return {
      ...(this.day === null ? { period: this.period } : { from: this.day, to: this.day }),
      ...(this.query === '' ? {} : { q: this.query }),
      ...(this.groups.size === 0 ? {} : { groups: [...this.groups].join(',') }),
    };
  }

  async load(): Promise<void> {
    const list = getElementByIdOrNull<HTMLElement>('memory-timeline');
    if (!list) return;
    const request = ++this.request;
    list.setAttribute('aria-busy', 'true');
    try {
      const data = await API.getMemoryTimeline(this.params());
      // A slower earlier read must not overwrite the answer to the latest filter.
      if (request !== this.request) return;
      this.render(data);
      this.hooks.onRender(data);
    } catch (error) {
      if (request !== this.request) return;
      list.innerHTML = `<div class="mt-empty mt-error">Could not read what was saved: ${escapeHtml(
        error instanceof Error ? error.message : String(error)
      )}</div>`;
    } finally {
      if (request === this.request) list.removeAttribute('aria-busy');
    }
  }

  render(data: MemoryTimelineResponse): void {
    document.querySelectorAll<HTMLButtonElement>('[data-memory-period]').forEach((button) => {
      button.setAttribute(
        'aria-pressed',
        String(this.day === null && button.dataset.memoryPeriod === this.period)
      );
    });
    const range = getElementByIdOrNull<HTMLElement>('memory-timeline-range');
    if (range) {
      range.textContent =
        data.from === data.to
          ? dayLabel(data.from)
          : `${dayLabel(data.from)} – ${dayLabel(data.to)}`;
    }
    const count = getElementByIdOrNull<HTMLElement>('memory-timeline-count');
    if (count) count.textContent = `${data.total} saved`;
    this.renderChips(data.counts);

    const list = getElementByIdOrNull<HTMLElement>('memory-timeline');
    if (!list) return;
    if (data.days.length === 0) {
      list.innerHTML = `<div class="mt-empty">Nothing saved${
        this.query === '' ? '' : ` matching “${escapeHtml(this.query)}”`
      } in this period.</div>`;
      return;
    }
    list.innerHTML = data.days
      .map(
        (day) =>
          `<section class="mt-day"><h3 class="mt-day-head"><span>${escapeHtml(
            day.day === null ? 'Erased records' : dayLabel(day.day)
          )}</span><span class="mt-count">${day.total}</span></h3>${day.groups
            .map((group) => this.renderGroup(group))
            .join('')}</section>`
      )
      .join('');
    if (this.selectedId !== null) {
      document
        .querySelector(`#memory-timeline [data-record-id="${CSS.escape(this.selectedId)}"]`)
        ?.classList.add('selected');
    }
  }

  private renderChips(counts: Record<string, number>): void {
    const container = getElementByIdOrNull<HTMLElement>('memory-group-chips');
    if (!container) return;
    container.innerHTML = Object.entries(counts)
      .filter(([group, count]) => count > 0 || this.groups.has(group))
      .map(([group, count]) => {
        const info = groupInfo(group);
        return `<button type="button" class="memory-chip" data-group="${escapeAttr(
          group
        )}" aria-pressed="${this.groups.has(group)}" title="${escapeAttr(
          info.hint
        )}"><span class="mt-dot" style="background:${info.color}"></span>${escapeHtml(
          info.label
        )} <span class="mt-count">${count}</span></button>`;
      })
      .join('');
  }

  private renderGroup(group: TimelineGroup): string {
    const info = groupInfo(group.group);
    const body =
      group.items !== undefined
        ? group.items.map((item) => this.renderItem(item)).join('')
        : (group.records ?? []).map((record) => this.renderRecord(record)).join('');
    return `<details class="mt-group" open><summary class="mt-group-head" title="${escapeAttr(
      info.hint
    )}"><span class="mt-dot" style="background:${info.color}"></span>${escapeHtml(
      info.label
    )}<span class="mt-count">${group.count}</span></summary>${body}</details>`;
  }

  private renderRecord(record: TimelineRecord): string {
    const via = record.via === null ? '' : (VIA_LABELS[record.via] ?? record.via);
    const status =
      record.status === null || record.status === 'active'
        ? ''
        : `<span class="mt-badge">${escapeHtml(record.status)}</span>`;
    return `<button type="button" class="mt-row" data-record-id="${escapeAttr(
      record.id
    )}"><span class="mt-time">${escapeHtml(record.time)}</span><span class="mt-body"><span class="mt-topic">${escapeHtml(
      record.topic
    )}${status}</span><span class="mt-summary">${escapeHtml(record.summary)}</span>${
      via === '' ? '' : `<span class="mt-via">from ${escapeHtml(via)}</span>`
    }</span></button>`;
  }

  private renderItem(item: TimelineItem): string {
    const latest = item.revisions[0];
    const updates = item.revisions.length;
    return `<details class="mt-item"><summary class="mt-item-head"><span class="mt-time">${escapeHtml(
      latest?.time ?? ''
    )}</span><span class="mt-body"><span class="mt-topic">${escapeHtml(
      item.title ?? item.topic
    )}</span><span class="mt-summary">${escapeHtml(latest?.summary ?? '')}</span></span><span class="mt-count">${updates} ${
      updates === 1 ? 'update' : 'updates'
    }</span></summary>${item.revisions
      .map(
        (revision) =>
          `<button type="button" class="mt-row mt-revision" data-record-id="${escapeAttr(
            revision.id
          )}"><span class="mt-time">${escapeHtml(revision.time)}</span><span class="mt-body"><span class="mt-op">${escapeHtml(
            OPERATION_LABELS[revision.operation ?? ''] ?? revision.operation ?? ''
          )}${revision.revision === null ? '' : ` · revision ${revision.revision}`}</span><span class="mt-summary">${escapeHtml(
            revision.summary
          )}</span></span></button>`
      )
      .join('')}</details>`;
  }
}
