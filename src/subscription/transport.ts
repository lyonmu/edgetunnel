export interface TransportConfig {
  type: string;
  hostField: string;
  pathField: string;
}

export function getTransportConfig(config: { transport: string; path: string }): TransportConfig {
  switch (config.transport) {
    case 'ws':
      return {
        type: 'ws',
        hostField: 'host',
        pathField: 'path',
      };
    case 'http':
      return {
        type: 'http',
        hostField: 'host',
        pathField: 'path',
      };
    case 'grpc':
      return {
        type: 'grpc',
        hostField: 'authority',
        pathField: 'serviceName',
      };
    default:
      return {
        type: 'ws',
        hostField: 'host',
        pathField: 'path',
      };
  }
}

export function getTransportPath(path: string, isGrpc: boolean): string {
  if (!isGrpc) return path;
  return path.split('?')[0] || '/';
}
