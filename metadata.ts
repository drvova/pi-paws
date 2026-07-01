/**
 * metadata.ts — Proto metadata builder.
 *
 * Builds Connect-RPC compatible metadata (headers) for requests
 * to the backend. Handles content-type, auth, and protocol versioning.
 */

import type { AuthState } from "./auth";
import { buildAuthHeaders } from "./auth";

export interface RpcMetadata {
  headers: Record<string, string>;
}

const CONNECT_CONTENT_TYPE = "proto";
const CONNECT_PROTOCOL_VERSION = "1";

export function buildConnectMetadata(auth: AuthState): RpcMetadata {
  return {
    headers: {
      ...buildAuthHeaders(auth),
      "Content-Type": `application/connect+${CONNECT_CONTENT_TYPE}`,
      "Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
      "Connect-Timeout-Ms": "60000",
    },
  };
}

export function buildGrpcMetadata(auth: AuthState, service: string, method: string): RpcMetadata {
  return {
    headers: {
      ...buildAuthHeaders(auth),
      "Content-Type": "application/grpc",
      TE: "trailers",
      "Grpc-Timeout": "60S",
      "x-service": `${service}/${method}`,
    },
  };
}

export function buildPlainHeaders(auth: AuthState): Record<string, string> {
  return {
    ...buildAuthHeaders(auth),
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
}
