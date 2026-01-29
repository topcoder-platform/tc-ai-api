/**
 * Use @mastra/express to run Mastra with Express for AWS Fargate.

 */

import express from 'express';
import { MastraServer } from '@mastra/express';

import { mastra } from './mastra';

const app = express();
app.use(express.json()); // Required for body parsing

const server = new MastraServer({
  app,
  mastra,
});

await server.init();

// Custom route with access to Mastra context via res.locals
// app.get('/health', (req, res) => {
//   const mastraInstance = res.locals.mastra;
//   const agents = Object.keys(mastraInstance.listAgents());
//   res.json({ status: 'ok', agents });
// });

const port = 4111;

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`Try: curl http://localhost:${port}/api/agents`);
});
