import { createRequestContext } from './app/request-context';
import { routeRequest } from './app/router';

export default {
  async fetch(request: Request, env: Env, execution: ExecutionContext): Promise<Response> {
    try {
      const context = await createRequestContext(request, env, execution);
      return await routeRequest(context);
    } catch (error) {
      console.error({ event: 'request_failed', error: String(error) });
      return new Response('Internal Server Error', { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
