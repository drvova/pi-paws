/**
 * wire.ts — Proto wire format helpers.
 *
 * Minimal helpers for encoding/decoding protobuf wire format.
 * Used by chat.ts when communicating via Connect-RPC.
 */

// Wire types
export const WIRE_VARINT = 0;
export const WIRE_64BIT = 1;
export const WIRE_LENGTH_DELIMITED = 2;
export const WIRE_32BIT = 5;

export function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return bytes;
}

export function decodeVarint(bytes: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset + bytesRead < bytes.length) {
    const b = bytes[offset + bytesRead];
    value |= (b & 0x7f) << shift;
    bytesRead++;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value, bytesRead };
}

export function encodeField(fieldNumber: number, wireType: number, data: number[]): number[] {
  return [...encodeVarint((fieldNumber << 3) | wireType), ...data];
}

export function encodeLengthDelimited(fieldNumber: number, data: number[]): number[] {
  return encodeField(fieldNumber, WIRE_LENGTH_DELIMITED, [...encodeVarint(data.length), ...data]);
}

export function encodeString(fieldNumber: number, value: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(value));
  return encodeLengthDelimited(fieldNumber, bytes);
}

export function encodeBytes(fieldNumber: number, data: Uint8Array): number[] {
  return encodeLengthDelimited(fieldNumber, Array.from(data));
}

export function encodeMessage(fieldNumber: number, message: number[]): number[] {
  return encodeLengthDelimited(fieldNumber, message);
}

export function toUint8Array(bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}
