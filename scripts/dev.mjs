// Development launcher: Vite dev server (hot reload) + the Electron window.
//   npm run app:dev
import { spawn } from 'node:child_process';
import electronPath from 'electron';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5173, strictPort: false } });
await server.listen();
const address = server.httpServer?.address();
const port = typeof address === 'object' && address ? address.port : 5173;
const url = `http://localhost:${port}`;
console.log(`[thinkAbuild] dev server at ${url}`);

const child = spawn(electronPath, ['.'], { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: url } });
child.on('close', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
