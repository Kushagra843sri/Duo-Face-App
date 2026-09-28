import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';

export const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use(notFound);
app.use(errorHandler);
