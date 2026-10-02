/**
 * trello.read — the current Trello state, read live as Kagemusha reads it. The requests go
 * through the registered TrelloConnector, so the credentials stay in the connector. Past changes
 * are stored history (source.search, source.read); nothing here is cached.
 */
import type { ActionContext, ActionRegistration } from '@jungjaehoon/mama-core';
import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';

import type { ConnectorRegistry } from '../connectors/framework/connector-registry.js';
import { TrelloConnector } from '../connectors/trello/index.js';
import type { TrelloBoardChannel } from '../connectors/trello/actions.js';

export interface TrelloReadPorts {
  connectors?: () => ConnectorRegistry | null;
  adapter: DatabaseAdapter;
  ownerPrincipalId: string;
}

function invalid(message: string): Error {
  const error = new Error(message);
  error.name = 'invalid_input';
  return error;
}

function outOfScope(): Error {
  const error = new Error('trello.read requires a granted Trello board');
  error.name = 'trello_board_out_of_scope';
  return error;
}

function connectorFrom(ports: TrelloReadPorts): TrelloConnector {
  const connector = ports.connectors?.()?.get('trello');
  if (!(connector instanceof TrelloConnector))
    throw new Error('The Trello connector is not active');
  return connector;
}

/** The configured boards this principal may read: all for the owner, the granted ones otherwise. */
function permittedBoards(
  connector: TrelloConnector,
  access: ActionContext['access'],
  ownerPrincipalId: string
): TrelloBoardChannel[] {
  const boards = connector.boards();
  if (access.principalId === ownerPrincipalId) return boards;
  const granted = access.channels?.trello ?? [];
  const permitted = boards.filter((board) => granted.includes(board.key));
  if (permitted.length === 0) throw outOfScope();
  return permitted;
}

function boardNamed(
  connector: TrelloConnector,
  permitted: TrelloBoardChannel[],
  key: unknown
): TrelloBoardChannel {
  if (typeof key !== 'string' || key.trim() === '') throw invalid('trello.read cards needs board');
  const configured = connector.boards();
  if (!configured.some((board) => board.key === key)) {
    throw invalid(
      `trello.read board ${key} is not configured; boards: ${permitted.map((board) => board.key).join(', ')}`
    );
  }
  const board = permitted.find((candidate) => candidate.key === key);
  if (!board) throw outOfScope();
  return board;
}

export function trelloActionRegistrations(ports: TrelloReadPorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'trello.read',
        readsConnector: { fixed: 'trello' },
        summary:
          'Read the current Trello state live. boards lists the configured boards with their open lists and card counts; cards reads the open cards of a board (board key) or one list (list id), at most 100; card reads one card (id) with its description, checklists and latest actions, each with its stored observationRef when the history holds it; search finds cards by text (query, at most 20 terms; limit up to 20). Past changes are stored history: read them with source.search and source.read.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['view'],
          properties: {
            view: { type: 'string', enum: ['boards', 'cards', 'card', 'search'] },
            board: {
              type: 'string',
              minLength: 1,
              description: 'Board key from boards, e.g. "board-key".',
            },
            list: {
              type: 'string',
              minLength: 1,
              description: 'List id from boards, e.g. "list-id".',
            },
            id: { type: 'string', minLength: 1, description: 'Card id, e.g. "card-id".' },
            query: { type: 'string', minLength: 1, description: 'Search text, e.g. "still".' },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 20,
              description: 'Search results; defaults to 10.',
            },
          },
        },
        examples: [
          { title: 'Boards and lists', input: { view: 'boards' } },
          {
            title: 'Cards of one list',
            input: { view: 'cards', board: 'board-key', list: 'list-id' },
          },
          { title: 'One card', input: { view: 'card', id: 'card-id' } },
        ],
      },
      exec: async (input, context) => {
        const values = input as Record<string, unknown>;
        const connector = connectorFrom(ports);
        const permitted = permittedBoards(connector, context.access, ports.ownerPrincipalId);
        switch (values.view) {
          case 'boards':
            return { boards: await connector.readBoards(permitted) };
          case 'cards': {
            const board = boardNamed(connector, permitted, values.board);
            return { cards: await connector.readCards(board, values.list as string | undefined) };
          }
          case 'card': {
            if (typeof values.id !== 'string') throw invalid('trello.read card needs id');
            const { boardId, ...card } = await connector.readCard(values.id);
            if (!permitted.some((board) => board.boardId === boardId)) throw outOfScope();
            const stored = ports.adapter.prepare(
              "SELECT current_observation_id AS ref FROM connector_event_index WHERE source_connector = 'trello' AND source_id = ? LIMIT 1"
            );
            return {
              card: {
                ...card,
                actions: card.actions.map(({ id, ...action }) => ({
                  ...action,
                  observationRef:
                    (stored.get(id) as { ref?: string | null } | undefined)?.ref ?? null,
                })),
              },
            };
          }
          case 'search': {
            if (typeof values.query !== 'string') throw invalid('trello.read search needs query');
            if (values.query.split(/\s+/).filter(Boolean).length > 20) {
              throw invalid('trello.read search takes at most 20 terms');
            }
            const limit = values.limit === undefined ? 10 : Number(values.limit);
            return { cards: await connector.searchCards(values.query, permitted, limit) };
          }
          default:
            throw invalid('trello.read view must be boards, cards, card or search');
        }
      },
    },
  ];
}
