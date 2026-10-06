import { z } from 'zod';

const name = z.string().trim().min(2, 'Give the product a name.').max(80, 'The name is too long (80 characters).');
const description = z.string().trim().max(300, 'The description is too long (300 characters).');
/** Integer paise, Rs 1 to Rs 1,00,000. The owner types rupees in the app; money is never a float on the wire. */
const pricePaise = z.number().int().min(100, 'The minimum price is Rs 1.').max(10_000_000, 'The maximum price is Rs 1,00,000.');

export const createProductBodySchema = z
  .object({
    name,
    description: description.optional(),
    pricePaise,
    /** Starting stock. */
    quantity: z.number().int().min(0).max(100_000),
  })
  .strict();
export type CreateProductBody = z.infer<typeof createProductBodySchema>;

export const updateProductBodySchema = z
  .object({
    name: name.optional(),
    description: description.optional(),
    pricePaise: pricePaise.optional(),
    /** false hides the product from customers (it is kept, not deleted). */
    isAvailable: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update.' });
export type UpdateProductBody = z.infer<typeof updateProductBodySchema>;
