declare const legacyWorker: {
  fetch(request: Request, env: Env, execution: ExecutionContext): Promise<Response>;
};

export default legacyWorker;
