import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';
import { createAuthRouter } from './routes/auth';
import { createDriverRouter } from './routes/driver';
import { createDriverAssignmentsRouter } from './routes/driver/assignments';
import { createCustomerNotificationsRouter } from './routes/customer/notifications';
import { createCustomerTrackingRouter } from './routes/customer/tracking';
import { createDriverProfileRouter } from './routes/driver/profile';
import { createMerchantProfileRouter } from './routes/merchant/profile';
import { createDriverDutyRouter } from './routes/driver/duty';
import { createDriverLocationRouter } from './routes/driver/location';
import { createExotelWebhookRouter } from './routes/webhooks/exotel';
import { createDriverTrackingRouter } from './routes/driver/tracking';
import { createMerchantRouter } from './routes/merchant';
import { createMerchantDeliveriesRouter } from './routes/merchant/deliveries';
import { createMerchantInventoryRouter } from './routes/merchant/inventory';
import { createMerchantOrdersRouter } from './routes/merchant/orders';
import { createMerchantProductsRouter } from './routes/merchant/products';

export const app = express();

// No confirmed web/admin origin exists yet, so CORS defaults closed rather
// than reflecting any origin. Set CORS_ORIGIN (comma-separated) once a real
// origin is known.
const allowedOrigins = (process.env.CORS_ORIGIN ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(helmet());
app.use(cors({ origin: allowedOrigins.length > 0 ? allowedOrigins : false }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/auth', createAuthRouter());
app.use('/customer', createCustomerTrackingRouter());
app.use('/customer/notifications', createCustomerNotificationsRouter());
app.use('/merchant', createMerchantRouter());
app.use('/merchant/profile', createMerchantProfileRouter());
app.use('/merchant/inventory', createMerchantInventoryRouter());
app.use('/merchant/products', createMerchantProductsRouter());
app.use('/merchant/orders', createMerchantOrdersRouter());
app.use('/merchant/deliveries', createMerchantDeliveriesRouter());
app.use('/driver', createDriverRouter());
app.use('/driver/profile', createDriverProfileRouter());
app.use('/driver/duty', createDriverDutyRouter());
app.use('/driver/location', createDriverLocationRouter());
app.use('/driver/tracking', createDriverTrackingRouter());
app.use('/driver/assignments', createDriverAssignmentsRouter());
app.use('/webhooks/exotel', createExotelWebhookRouter());

app.use(notFound);
app.use(errorHandler);
