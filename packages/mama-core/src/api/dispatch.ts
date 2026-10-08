/**
 * Action dispatch — input validation, exactly one exec call, one result shape.
 *
 * §4.2: dispatch never retries, never guesses sameness, and never turns a thrown
 * error into an empty success. Knowledge-boundary errors keep their own code so
 * the caller can tell a bad call from a denied one from a broken store.
 */
import type {
  ActionCall,
  ActionContract,
  ActionResult,
  ActionSchemaObject,
} from '../action-contracts.js';
import { JudgmentError } from '../knowledge/judgments.js';
import { TwinRefNotVisibleError } from '../knowledge/access.js';
import { AgentGraphValidationError } from '../knowledge/graph-query.js';
import { OperationError } from '../runtime/operations.js';
import { RegistryError } from '../registry/store.js';
import {
  UnknownActionError,
  type ActionCatalog,
  type ActionContext,
  type MemoryReadAllowance,
} from './catalog.js';
import { scanMemoryWriteInput, SecretMaterialRefusedError } from '../memory/secret-filter.js';

export type ActionDispatcher = ((
  call: ActionCall,
  context: ActionContext
) => Promise<ActionResult>) & {
  /**
   * The actions this dispatcher serves, as their contracts. Not a grant: a fact
   * about the catalog it was built from, which an in-process caller with no
   * stated grant of its own stands on. A caller arriving over the socket is a
   * principal and is compared against the grant its credential resolves to.
   *
   * The contracts and not just the names, because a caller that must tell a model
   * what it may call needs to say what each one is for, and deriving that from a
   * second list is how the two stop agreeing.
   */
  readonly contracts: readonly ActionContract[];
};

export interface DispatcherOptions {
  /**
   * Called when a recallable write carries instruction-shaped content that is
   * not secret-shaped enough to refuse. Observation, never a gate: the write
   * proceeds and the host records what it saw. Absent means nobody is
   * watching, which is honest rather than silently safe.
   */
  observeWriteWarning?: (input: {
    action: string;
    principalId: string;
    warnings: readonly string[];
  }) => void;
  /**
   * The receipt for one call: what was asked, what came back, how long it took.
   *
   * This ran in the gateway tool executor, which meant a call arriving any other
   * way -- a program over the socket, a scheduled run -- left no row at all,
   * while lane verification reads exactly those rows to decide whether a lane
   * did what it claimed. One call, one receipt, written where every caller
   * passes.
   *
   * It may return a reference to the receipt it wrote; dispatch hands that back
   * to the caller as the result's `experienceRef` so an agent can read its own
   * run. A
   * thrown observer never turns a completed call into a failed one -- the
   * receipt is bookkeeping and the answer is the answer -- but it is not
   * swallowed silently either: the host states what it does with it.
   */
  observeCall?: (input: {
    action: string;
    /** The command id the caller issued, when it issued one. */
    operationId: string | undefined;
    input: unknown;
    result: ActionResult;
    durationMs: number;
    context: ActionContext;
  }) => Promise<string | undefined> | string | undefined;
}

export function createDispatcher(
  catalog: ActionCatalog,
  options: DispatcherOptions = {}
): ActionDispatcher {
  const runCall = async (call: ActionCall, context: ActionContext): Promise<ActionResult> => {
    let registration;
    try {
      registration = catalog.entry(call.action);
    } catch (error) {
      if (error instanceof UnknownActionError) {
        return fail(call, 'unknown_action', 'unknown_action', error.message);
      }
      throw error;
    }

    const invalid = validateInput(registration.contract.inputSchema, call.input, 'input');
    if (invalid !== null) {
      return fail(call, 'invalid_input', 'invalid_input', invalid);
    }

    // Authority is compared here, before exec, so an ungranted action never
    // reaches an action body. The grant is the principal's configured list —
    // the call cannot widen it, and there is no wildcard to widen it with.
    const granted = context.access.actions;
    if (!Array.isArray(granted)) {
      return fail(
        call,
        'denied',
        'action_grant_missing',
        `principal ${context.access.principalId} states no action grant`
      );
    }
    if (!granted.includes(registration.contract.name)) {
      return fail(
        call,
        'denied',
        'action_not_granted',
        `principal ${context.access.principalId} may not call ${call.action}`
      );
    }

    const readsConnector = registration.contract.readsConnector;
    if (readsConnector !== undefined) {
      const named =
        'fixed' in readsConnector
          ? readsConnector.fixed
          : (call.input as Record<string, unknown> | undefined)?.[readsConnector.fromInput];
      if (typeof named !== 'string' || named === '') {
        return fail(
          call,
          'invalid_input',
          'connector_unnamed',
          `${call.action} reads a connector but its ${'fromInput' in readsConnector ? readsConnector.fromInput : 'connector'} names none`
        );
      }
      // Absent is NO connector read, never all of them - the same fail-closed
      // reading allowanceFromAccess gives the memory window below.
      const grantedConnectors = context.access.connectors ?? [];
      if (!grantedConnectors.includes(named)) {
        // Return the caller's own connector grant to that caller, so it can correct
        // the source name without exposing another principal's grant.
        return fail(
          call,
          'denied',
          'connector_out_of_scope',
          `principal ${context.access.principalId} may not read ${named}; readable connectors: ${[...grantedConnectors].sort().join(', ') || 'none'}`
        );
      }
    }

    if (registration.contract.recallableWrite === true) {
      const scan = scanMemoryWriteInput((call.input ?? {}) as Record<string, unknown>);
      if (scan.warnings.length > 0) {
        options.observeWriteWarning?.({
          action: call.action,
          principalId: context.access.principalId,
          warnings: scan.warnings,
        });
      }
      if (!scan.clean) {
        // The matched pattern NAMES are safe to return; the matched text is not.
        return fail(
          call,
          'invalid_input',
          // The label operators already grep for. The check moved; its name
          // did not.
          'secret_material_refused',
          `refusing to persist content matching ${scan.matches.join(', ')} — a secret written here comes back through recall`
        );
      }
    }

    try {
      const data = await registration.exec(call.input, {
        ...context,
        readAllowance: readAllowanceFor(context),
        operationId: call.operationId,
      });
      const result: ActionResult = { status: 'completed', data };
      if (call.operationId !== undefined) {
        result.operationId = call.operationId;
      }
      return result;
    } catch (error) {
      return fail(call, failureKind(error), errorCode(error), errorMessage(error));
    }
  };

  const dispatch =
    options.observeCall === undefined ? runCall : withCallReceipt(runCall, options.observeCall);

  return Object.assign(dispatch, { contracts: catalog.list() });
}

/**
 * Time one call and hand its receipt's reference back on the result.
 *
 * Exported because a caller that composes its own dispatch -- a test standing a
 * spy where the catalog would be -- must observe through the SAME wrapper. Two
 * copies of "when is a receipt written and where does its ref land" is two
 * answers to one question.
 */
export function withCallReceipt<
  D extends (call: ActionCall, context: ActionContext) => Promise<ActionResult>,
>(dispatch: D, observeCall: NonNullable<DispatcherOptions['observeCall']>): D {
  const observed = async (call: ActionCall, context: ActionContext): Promise<ActionResult> => {
    const startedAt = Date.now();
    let result: ActionResult;
    try {
      result = await dispatch(call, context);
    } catch (error) {
      // One call, one receipt. A dispatch that throws instead of failing is the
      // call most worth a row, not the one exempt from it, so the throw is
      // written as the failure it is and then continues on its way.
      try {
        await observeCall({
          action: call.action,
          operationId: call.operationId,
          input: call.input,
          result: {
            status: 'failed',
            error: {
              kind: failureKind(error),
              code: thrownCode(error),
              message: errorMessage(error),
            },
          },
          durationMs: Date.now() - startedAt,
          context,
        });
      } catch {
        // The call's own throw is the answer; a receipt that also fails must
        // not replace it with a different cause.
      }
      throw error;
    }
    const ref = await observeCall({
      action: call.action,
      operationId: call.operationId,
      input: call.input,
      result,
      durationMs: Date.now() - startedAt,
      context,
    });
    // The receipt points at itself, so the agent that made the call can read
    // what its own run recorded. On the envelope, never inside `data`: the
    // action owns that shape, and a refusal -- the call most worth reading back
    // -- has no `data` to put it in.
    return ref === undefined ? result : { ...result, experienceRef: ref };
  };
  // Whatever the wrapped dispatch declares about itself -- `contracts`, which a
  // caller with no grant of its own stands on -- survives the wrapping. A
  // wrapper that drops it silently narrows the caller's authority.
  return Object.assign(observed, dispatch) as D;
}

/**
 * The read window a principal's own grant states.
 *
 * A citation must not out-read reading. That rule used to hold only where a host
 * assembled the window from a verified envelope, which meant a call arriving
 * without one -- a program over the socket, a scheduled run -- got no window at
 * all. The grant already says which connectors, channels and projects this
 * principal may read; the same four fields ARE the window.
 *
 * A host that composed a narrower window still wins: this fills in only when the
 * context carries none. And it fails closed the same way -- a principal whose
 * grant names no connectors gets `connectors: []`, which is no raw events.
 */
function allowanceFromAccess(access: ActionContext['access']): MemoryReadAllowance {
  const connectors = access.connectors ?? [];
  const wideConnectors = (access.connectorWideRead ?? []).filter((name) =>
    connectors.includes(name)
  );
  // An ordinary connector grant without a tenant is not a raw read window.
  // An explicit connector-wide read is different: the owner stored-source
  // reader already admits that connector across its retained channels. Keep
  // only that exact intersection, never an unrelated narrow connector.
  if (connectors.length > 0 && (access.tenantId ?? null) === null && wideConnectors.length === 0) {
    // Granted channels are an exact window of their own (a member's DM, a granted source channel):
    // keep them, so cited observations from those channels stay readable, and nothing wider.
    return {
      connectors: [],
      tenantId: null,
      ...(access.channels ? { channels: access.channels } : {}),
    };
  }
  return {
    connectors: (access.tenantId ?? null) === null ? wideConnectors : connectors,
    ...(wideConnectors.length === 0 ? {} : { wideConnectors }),
    ...(access.channels ? { channels: access.channels } : {}),
    ...(access.projectRefs === undefined
      ? {}
      : { projectIds: access.projectRefs.map((ref) => ref.id) }),
    tenantId: access.tenantId ?? null,
    maxObservedMs: access.maxObservedMs ?? null,
  };
}

function readAllowanceFor(context: ActionContext): MemoryReadAllowance {
  const allowance = context.readAllowance ?? allowanceFromAccess(context.access);
  const ceiling = context.session?.replaySourceEndMs;
  if (ceiling === undefined) return allowance;
  if (!Number.isSafeInteger(ceiling) || ceiling < 0) {
    throw new JudgmentError(
      'REPLAY_SOURCE_CEILING_INVALID',
      'Replay source ceiling must be a nonnegative epoch millisecond integer'
    );
  }
  const stated = allowance.maxSourceMs;
  if (stated === undefined || stated === null) {
    return { ...allowance, maxSourceMs: ceiling };
  }
  if (!Number.isSafeInteger(stated) || stated < 0) {
    throw new JudgmentError(
      'REPLAY_SOURCE_CEILING_INVALID',
      'Read allowance source ceiling must be a nonnegative epoch millisecond integer'
    );
  }
  return { ...allowance, maxSourceMs: Math.min(stated, ceiling) };
}

function fail(
  call: ActionCall,
  kind: 'unknown_action' | 'invalid_input' | 'denied' | 'failed' | 'internal',
  code: string,
  message: string
): ActionResult {
  const result: ActionResult = {
    status: 'failed',
    error: { kind, code, message },
  };
  if (call.operationId !== undefined) {
    result.operationId = call.operationId;
  }
  return result;
}

function failureKind(error: unknown): 'invalid_input' | 'denied' | 'failed' | 'internal' {
  if (error instanceof TwinRefNotVisibleError || thrownCode(error) === 'denied') {
    return 'denied';
  }
  if (
    error instanceof AgentGraphValidationError ||
    error instanceof SecretMaterialRefusedError ||
    thrownCode(error) === 'invalid_input'
  ) {
    return 'invalid_input';
  }
  if (
    error instanceof JudgmentError ||
    error instanceof OperationError ||
    error instanceof RegistryError
  ) {
    return 'failed';
  }
  return 'internal';
}

/**
 * A thrown value's own `code`, when it states one.
 *
 * `errorCode` answers with the class NAME for a custom Error, which is what a
 * failure result wants. A receipt wants the cause, and a thrower that carries a
 * structured `code` has already named it.
 */
function thrownCode(error: unknown): string {
  const stated = (error as { code?: unknown } | null)?.code;
  return typeof stated === 'string' && stated !== '' ? stated : errorCode(error);
}

function errorCode(error: unknown): string {
  if (
    error instanceof JudgmentError ||
    error instanceof OperationError ||
    error instanceof RegistryError
  ) {
    return error.code;
  }
  if (error instanceof Error && error.name !== 'Error') {
    return error.name;
  }
  return 'internal_error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Structural validation against the contract schema — the deep semantic rules
 * (ref existence, history/direction legality per view) still belong to exec.
 */
export function validateInput(
  schema: ActionSchemaObject,
  value: unknown,
  path: string
): string | null {
  if (schema.const !== undefined && value !== schema.const) {
    return `${path} must be ${JSON.stringify(schema.const)}.`;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    return `${path} must be one of ${schema.enum.map(String).join(', ')}.`;
  }
  if (schema.type !== undefined) {
    const mismatch = typeMismatch(schema.type, value);
    if (mismatch !== null) {
      return `${path} ${mismatch}.${described(schema)}`;
    }
  }
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((sub) => validateInput(sub, value, path) === null).length;
    if (matches !== 1) {
      // A refusal names what is allowed: "(0 matched)" alone once left a caller dropping the
      // field and the write with it.
      const shapes = schema.oneOf.map(shapeName).join(', ');
      return `${path} must match exactly one of: ${shapes} (${matches} matched).${described(schema)}`;
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return `${path} must be >= ${schema.minimum}.`;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `${path} must be <= ${schema.maximum}.`;
    }
  }
  if (
    typeof value === 'string' &&
    schema.minLength !== undefined &&
    value.length < schema.minLength
  ) {
    return `${path} must be at least ${schema.minLength} characters.`;
  }
  if (
    typeof value === 'string' &&
    schema.maxLength !== undefined &&
    value.length > schema.maxLength
  ) {
    return `${path} must be at most ${schema.maxLength} characters.`;
  }
  if (
    typeof value === 'string' &&
    schema.pattern !== undefined &&
    !new RegExp(schema.pattern).test(value)
  ) {
    return `${path} must match ${schema.pattern}.`;
  }
  if (
    schema.type === 'object' &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const objectValue = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    // A misnamed field comes first: a caller that carried `text` over from a sibling action is
    // told the allowed names, not only that the real field is missing.
    if (schema.additionalProperties === false) {
      for (const [key, propertyValue] of Object.entries(objectValue)) {
        // undefined is absent — JSON cannot carry it
        if (propertyValue !== undefined && properties[key] === undefined) {
          return `${path}.${key} is not an allowed property. Allowed: ${Object.keys(properties).join(', ')}.`;
        }
      }
    }
    for (const key of schema.required ?? []) {
      if (objectValue[key] === undefined) {
        const required = properties[key];
        return `${path}.${key} is required.${required === undefined ? '' : described(required)}`;
      }
    }
    for (const [key, propertyValue] of Object.entries(objectValue)) {
      const propertySchema = properties[key];
      if (propertyValue === undefined || propertySchema === undefined) {
        continue;
      }
      const nested = validateInput(propertySchema, propertyValue, `${path}.${key}`);
      if (nested !== null) {
        return nested;
      }
    }
  }
  if (
    schema.type === 'array' &&
    Array.isArray(value) &&
    schema.minItems !== undefined &&
    value.length < schema.minItems
  ) {
    return `${path} must carry at least ${schema.minItems} item(s).`;
  }
  if (
    schema.type === 'array' &&
    Array.isArray(value) &&
    schema.maxItems !== undefined &&
    value.length > schema.maxItems
  ) {
    return `${path} must carry at most ${schema.maxItems} item(s).`;
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items !== undefined) {
    for (let i = 0; i < value.length; i += 1) {
      const nested = validateInput(schema.items, value[i], `${path}[${i}]`);
      if (nested !== null) {
        return nested;
      }
    }
  }
  return null;
}

function described(schema: ActionSchemaObject): string {
  return schema.description === undefined ? '' : ` ${schema.description}`;
}

function shapeName(schema: ActionSchemaObject): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum !== undefined)
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  return schema.type ?? 'a described shape';
}

function typeMismatch(
  type: NonNullable<ActionSchemaObject['type']>,
  value: unknown
): string | null {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? null
        : 'must be an object';
    case 'array':
      return Array.isArray(value) ? null : 'must be an array';
    case 'string':
      return typeof value === 'string' ? null : 'must be a string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) ? null : 'must be an integer';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be a boolean';
    case 'null':
      return value === null ? null : 'must be null';
  }
}
