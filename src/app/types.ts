export type RuntimeEnv = Env;

export interface RequestMetadata {
  request: Request;
  env: RuntimeEnv;
  execution: ExecutionContext;
  url: URL;
  clientIp: string;
  userAgent: string;
  requestId: string;
}

export type RequestContext = RequestMetadata;

export interface DataPlaneContext extends RequestMetadata {
  userId: string;
  runtimeSnapshot: import('../config/runtime').RuntimeSnapshot;
}
