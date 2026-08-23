import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { classroom } from "./classroom";
import { createdAt } from "./helpers";
import { modelAlias } from "./model-alias";

/**
 * Which aliases a classroom may use (PRD §8, §19).
 *
 * "Allowlists are join tables between Classroom and ModelAlias, McpTool, and
 * Skill respectively."
 *
 * An absent row is a denial, so a new alias reaches no classroom until an
 * educator allowlists it — the safe direction. The membership is read by
 * `$lib/server/classroom/enforcement` on every path that can reach a model (§21),
 * never by the browser.
 */
export const classroomModelAlias = sqliteTable(
  "classroom_model_alias",
  {
    classroomId: text()
      .notNull()
      .references(() => classroom.id, { onDelete: "cascade" }),
    modelAliasId: text()
      .notNull()
      .references(() => modelAlias.id, { onDelete: "cascade" }),
    /**
     * The educator's explicit acknowledgement that this alias carries no data
     * processing agreement (§9, §16).
     *
     * Recorded rather than merely displayed: §16 requires the decision be "made
     * deliberately, per classroom, by the person accountable for it — never
     * discovered later", and a confirmation nobody can audit afterwards is not
     * that. Null on an alias that carries a DPA, where nothing was confirmed.
     */
    noDpaConfirmedAt: integer({ mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.classroomId, t.modelAliasId] })],
);

export type ClassroomModelAlias = typeof classroomModelAlias.$inferSelect;
