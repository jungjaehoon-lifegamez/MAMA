/**
 * Action contracts — the one surface CLI/MCP clients call.
 *
 * §4.2: schema, description, examples and the exec binding live in ONE catalog
 * entry; help/schema/examples are generated from the same contract. Input that
 * fails the schema never reaches exec.
 */

/** JSON-Schema subset the catalog validates against. */
export interface ActionSchemaObject {
  /** Short caller-facing meaning and example shape for this input field. */
  description?: string;
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, ActionSchemaObject>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: ActionSchemaObject;
  enum?: readonly unknown[];
  const?: unknown;
  oneOf?: readonly ActionSchemaObject[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  /** Longest a string value may be. */
  maxLength?: number;
  /** Fewest elements an array value may carry. */
  minItems?: number;
  /** Most elements an array value may carry. */
  maxItems?: number;
  /** Anchored regular expression a string value must match. */
  pattern?: string;
}

export interface ActionExample {
  title: string;
  input: Record<string, unknown>;
}

/**
 * What `client.describe(action)` returns. Everything a caller needs to build a
 * call — name, summary, input schema, examples — without executing anything.
 */
export interface ActionContract {
  name: string;
  summary: string;
  inputSchema: ActionSchemaObject;
  examples?: readonly ActionExample[];
  /**
   * This action persists text that a later read can return. Dispatch scans the
   * input of such a call for secret-shaped material and refuses it, because
   * the one real leak path a chat-reachable caller has is writing a secret
   * into something recall will hand back. Declared by the contract rather than
   * listed in dispatch, so a new recallable write cannot be added without
   * saying that it is one.
   */
  recallableWrite?: boolean;
  /**
   * This action reads a raw connector. Dispatch refuses the call unless the
   * principal's grant names that connector.
   *
   * The rule existed before as a host enforcer keyed on tool names, reachable
   * only from the one caller that went through the tool layer. A program
   * calling the same action over the socket carried no envelope and met no
   * check, so the same read was bounded for one caller and unbounded for the
   * other. Declared by the contract for the same reason `recallableWrite` is:
   * a new connector read cannot be added without saying that it is one.
   *
   * `fromInput` names the input field carrying the connector, for an action
   * that reads whichever source it is told to. `fixed` names it outright, for
   * an action that always reads the same one.
   */
  readsConnector?: { fromInput: string } | { fixed: string };
  /**
   * This action writes on someone's behalf and runs only after a person approved it.
   * `always`: dispatch refuses a call whose session states no approved proposal.
   * `outsideOwnerTurn`: the action itself refuses a turn no owner's message started unless the
   * session states one; dispatch cannot tell an owner's turn, so it leaves the check to the action.
   * The approval is the host's session fact (`ActionSessionFacts.approvedProposalId`), never input.
   */
  approval?: 'always' | 'outsideOwnerTurn';
}

/**
 * One call. `operationId` is issued by the common client before the call and,
 * for knowledge commands, becomes the commandId — retransmission reuses it,
 * topic/body similarity is never used to guess sameness.
 */
export interface ActionCall {
  action: string;
  input?: unknown;
  operationId?: string;
}

export type ActionFailureKind =
  | 'unknown_action'
  | 'invalid_input'
  | 'denied'
  | 'failed'
  | 'internal';

/**
 * Call-site facts the SERVER side knows — never caller input. Provenance is
 * composed from the call authority plus these facts (§240: provenance is
 * composed from the current call authority); a field stays absent rather than
 * being trusted from
 * the payload. The model run, the tool call, the context packet, and the
 * source turn are all things only the host can truthfully state.
 */
/** Native harness identity, supplied per call by the transport hook, never action input. */
export interface NativeToolCaller {
  session_id: string;
  tool_use_id: string;
  agent_id?: string;
  agent_type?: string;
}

/** Wire facts carry identity only; the host resolves authority and run provenance. */
export interface ClientSessionFacts {
  nativeCaller?: NativeToolCaller;
}

export interface ActionSessionFacts {
  nativeCaller?: NativeToolCaller;
  /**
   * The proposal a person approved, stated by the host when it runs the stored call. Never call
   * input: the host sets it only when it dispatches an approved proposal.
   */
  approvedProposalId?: string;
  /** The model run this call belongs to. */
  modelRunId?: string;
  /** The surface the call arrived on (e.g. 'mama_save'). */
  toolName?: string;
  /** The tool-call id the host issued for this invocation. */
  gatewayCallId?: string;
  /** The verified envelope hash this call ran under — an audit fact, not authority. */
  envelopeHash?: string;
  /** The compiled context packet this call is bound to, if any. */
  contextPacketId?: string;
  /** The conversation turn this call belongs to. */
  sourceTurnId?: string;
  /** The source message ref this call is bound to. */
  sourceMessageRef?: string;
  /** Which lane wrote — 'memory_agent' for the memory lane, else main. */
  actor?: 'memory_agent' | 'main_agent';
  /** Extra source refs the host attests (packet refs, message refs). */
  sourceRefs?: readonly string[];
  /** The workorder attempt this call is bound to, if the host bound one. */
  workorderAttemptId?: number;
  /** The call ran under a member-scope-required envelope — owner actions must refuse. */
  memberScopeRequired?: boolean;
  /** The bounded-run batch this call inherits — effects record it as their cause. */
  causeEventIds?: readonly string[];
  /** The channel this call runs on, if the host bound one. */
  channelId?: string;
  /**
   * Inclusive source-event ceiling for a replay turn. The feeder states this
   * fact; callers cannot widen it through action input. Absent means live time.
   */
  replaySourceEndMs?: number;
  /**
   * The turn's recent conversation, for a checkpoint that hands work over.
   *
   * A host fact and only a host fact: the model does not hold the transcript,
   * so asking it for one asks it to write one. It was an input field that one
   * caller filled from the session store and every other caller left empty.
   */
  recentConversation?: readonly unknown[];
  /**
   * Host-issued wiki workorder range: the owner date and the updated bounds
   * the wiki turn is allowed to touch. An agent cannot mint or widen this; a
   * null field is an honest "not bounded" from the host.
   */
  wikiTaskRange?: {
    ownerDate: string | null;
    rangeStartMs: number | null;
    rangeEndMs: number | null;
    connectors: readonly string[] | null;
    updatedSince: string | null;
    updatedBefore: string | null;
  };
  /**
   * The verified envelope's allowed destinations (e.g. drive roots) — host
   * state for destination-gated reads like source.search's folder resolve.
   */
  allowedDestinations?: readonly { kind: string; id: string }[];
  /** The host-resolved role name this call runs under (e.g. 'owner_console'). */
  agentRole?: string;
  /**
   * Whose run this is, for the call receipt: owner scope, project and channel.
   *
   * Stated, never derived here. A host that can name all three says so and its
   * calls are attributable; a host that cannot omits the field and its calls are
   * honestly unattributed. Deriving it from `access` would be a second answer to
   * a question the host already answers.
   */
  runEvidenceScope?: {
    ownerScope: string;
    projectId: string;
    channelId?: string | null;
  };
  /** The verified envelope's expiry (ISO) — bounds any capability a host port mints. */
  envelopeExpiresAt?: string;
}

export interface ActionFailure {
  kind: ActionFailureKind;
  code: string;
  message: string;
}

/**
 * The common result every call returns. `unknown` is reserved for the case the
 * transport loses the answer after a possible commit — dispatch itself only
 * produces `completed` or `failed`.
 */
/**
 * `experienceRef` points at the call's own receipt, so the agent that made the
 * call can read what the run recorded. It rides the envelope rather than the
 * answer: `data` is the action's shape and a refusal has no `data` at all,
 * while a refusal is exactly the call whose receipt is worth reading.
 */
export type ActionResult =
  | { status: 'completed'; operationId?: string; experienceRef?: string; data: unknown }
  | {
      status: 'failed' | 'unknown';
      operationId?: string;
      experienceRef?: string;
      error: ActionFailure;
    };
