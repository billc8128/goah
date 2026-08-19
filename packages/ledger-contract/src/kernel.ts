export const CONTRACT_VERSION = "0.3.0" as const;
export const CONTRACT_STABILITY = "experimental" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** One append request. Sequence numbers are assigned by the ledger. */
export interface EventInput {
  streamId: string;
  ts: string;
  actor: string;
  type: string;
  data: JsonValue;
}

/** One immutable fact in the global ledger and in one logical stream. */
export interface EventRecord extends EventInput {
  seq: number;
  streamSeq: number;
}

export interface EventStore {
  appendEvent(input: EventInput): EventRecord;
  appendEvents(inputs: EventInput[]): EventRecord[];
  readStream(streamId: string, fromStreamSeq?: number): EventRecord[];
  eventsSince(seq: number, types?: string[]): EventRecord[];
  events(): EventRecord[];
}

export interface Clock { now(): Date }

export function wakeStream(wakeId: string): string { return `wake:${wakeId}`; }
export function controlStream(actor = "supervisor"): string { return `control:${actor}`; }
export function goalStream(goalId: string): string { return `goal:${goalId}`; }
