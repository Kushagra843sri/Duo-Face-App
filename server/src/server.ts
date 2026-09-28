import 'dotenv/config';

import { app } from './app';
import { loadEnv } from './config/env';

const env = loadEnv();

app.listen(env.PORT, () => {
  console.log(`Duo-Face server listening on port ${env.PORT} (${env.NODE_ENV})`);
});
