const auth = require('../../middleware/auth');
const repo = require('./repository');
const { z } = require('zod');

const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(50)
    .transform((val) => Math.min(val, 100)),
  userId: z.string().uuid().optional(),
  resourceType: z.string().optional(),
});

async function routes(fastify) {
  fastify.get('/', { preHandler: [auth] }, async (req, reply) => {
    const parsed = auditQuerySchema.safeParse(req.query);

    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Invalid query parameters',
        details: parsed.error.issues,
      });
    }

    let { page, limit, userId, resourceType } = parsed.data;

    // If user is not an admin, they can only view their own logs
    if (req.user.role !== 'ADMIN') {
      userId = req.user.id;
    }

    const offset = (page - 1) * limit;

    const { records, total } = await repo.getAuditLogs(limit, offset, {
      userId,
      resourceType,
    });

    // Sanitize records: non-admins should not see IP address or User Agent for logs that don't belong to them
    const sanitizedRecords = records.map((row) => {
      if (req.user.role !== 'ADMIN' && row.user_id !== req.user.id) {
        const { ip_address, user_agent, ...rest } = row;
        return rest;
      }
      return row;
    });

    return {
      data: sanitizedRecords,
      total,
      page,
      limit,
    };
  });
}

module.exports = routes;
