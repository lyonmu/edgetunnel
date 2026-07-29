import { createRequestContext } from './app/request-context';
import { routeRequest } from './app/router';
import type { RuntimeEnv } from './app/types';

export default {
  async fetch(request: Request, env: RuntimeEnv, execution: ExecutionContext): Promise<Response> {
    try {
      const context = await createRequestContext(request, env, execution);
      return await routeRequest(context);
    } catch (error) {
      console.error({ event: 'request_failed', error: String(error) });
      return new Response('Internal Server Error', { status: 500 });
    }
  },
} satisfies ExportedHandler<RuntimeEnv>;
