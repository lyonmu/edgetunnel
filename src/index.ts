import { createRequestContext } from './app/request-context';
import { routeRequest } from './app/router';

export default {
  async fetch(request: Request, env: Env, execution: ExecutionContext): Promise<Response> {
    const context = await createRequestContext(request, env, execution);
    return routeRequest(context);
  },
} satisfies ExportedHandler<Env>;
