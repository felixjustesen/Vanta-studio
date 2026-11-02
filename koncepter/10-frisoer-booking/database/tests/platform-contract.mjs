// Vanta Platforms egen validering af /api/v1/appointments (src/lib/integrations/schema.ts),
// så testerne tjekker bookingens data mod præcis de regler, platformen bruger.
import { register } from "node:module";

register("./platform-alias-hook.mjs", import.meta.url);
const schema = await import(new URL("../../../../vanta-platform/src/lib/integrations/schema.ts", import.meta.url).href);

export const { appointmentsRequestSchema } = schema;

// { ok: true, data } eller { ok: false, issues: [{ path, message }] }
export function validateAppointments(body) {
  const parsed = appointmentsRequestSchema.safeParse(body);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
}
