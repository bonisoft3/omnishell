import '../../interpreter/vendor/ses.umd.min.js';

lockdown({ errorTaming: 'unsafe' });
const compiled = new Compartment().evaluate('(value) => ({ value: value + 1, ambient: { fetch: typeof fetch, Deno: typeof Deno, process: typeof process } })');

export default {
  async fetch(request) {
    try {
      const value = new URL(request.url).pathname === '/runtime'
        ? new Compartment().evaluate('(value) => value + 1')(41)
        : compiled(41);
      return Response.json(value);
    } catch (error) {
      return Response.json({ error: String(error), stack: error.stack }, { status: 500 });
    }
  },
};
