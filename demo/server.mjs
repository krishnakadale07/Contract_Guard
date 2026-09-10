#!/usr/bin/env node
// A tiny hand-written server implementing demo/openapi-new.yaml — good enough
// to run `contractguard test` against. It has one INTENTIONAL bug (the
// GET /users/{id} response is missing "email") so you can see a real
// contract failure reported, not just a wall of green checkmarks.
import { createServer } from 'node:http';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/users') {
    if (!url.searchParams.get('include')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'include is required' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        users: [
          { id: 'usr_001', email: 'ada@example.com', name: 'Ada', role: 'admin' },
          { id: 'usr_002', email: 'grace@example.com', name: 'Grace', role: 'member' },
        ],
      })
    );
    return;
  }

  const userMatch = url.pathname.match(/^\/users\/([^/]+)$/);
  if (req.method === 'GET' && userMatch) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // BUG (intentional): the spec requires "email" here but this handler
    // forgot to include it — this is what `contractguard test` should catch.
    res.end(JSON.stringify({ id: userMatch[1] }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Demo API listening on http://127.0.0.1:${PORT}`);
  console.log('Try: node bin/contractguard.js test --spec demo/openapi-new.yaml --base-url http://127.0.0.1:' + PORT);
});
