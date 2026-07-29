import type { InboundProtocol, EgressProfile } from '../../config/schema';
import type { ProfileCredential } from '../../security/secret-store';

export interface DialTarget {
  hostname: string;
  port: number;
}

export interface Connector {
  connect(
    target: DialTarget,
    profile: EgressProfile,
    credential: ProfileCredential | null,
    signal: AbortSignal,
    initialData?: Uint8Array,
  ): Promise<Socket>;
}

export interface ConnectorRegistry {
  get(type: EgressProfile['type']): Connector;
}

export interface DialResult {
  socket: Socket;
  profile: EgressProfile;
  target: DialTarget;
  inbound: InboundProtocol;
}
