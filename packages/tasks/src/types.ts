import { z } from "zod";

export const TASK_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "done",
  "canceled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TaskStatusSchema = z.enum(TASK_STATUSES);

export const NullableIso = z.string().datetime({ offset: true }).nullable();
const IsoString = z.string().datetime({ offset: true });

export const RECURRENCE_SESSION_MODES = ["fresh", "reuse"] as const;
export type RecurrenceSession = (typeof RECURRENCE_SESSION_MODES)[number];

export const MIN_INTERVAL_MS = 60_000;
export const MAX_RECURRENCE_COUNT = 10_000;

const RecurrenceCommon = {
  until: NullableIso.optional(),
  count: z
    .number()
    .int()
    .positive()
    .max(MAX_RECURRENCE_COUNT)
    .nullable()
    .optional(),
  session: z.enum(RECURRENCE_SESSION_MODES).default("fresh"),
};

export const RecurrenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("cron"),
      expr: z.string().min(1),
      tz: z.string().min(1).nullable().optional(),
      ...RecurrenceCommon,
    })
    .strict(),
  z
    .object({
      kind: z.literal("interval"),
      every_ms: z.number().int().min(MIN_INTERVAL_MS),
      ...RecurrenceCommon,
    })
    .strict(),
]);

export type Recurrence = z.infer<typeof RecurrenceSchema>;

export const TaskFrontmatterSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(500),
    status: TaskStatusSchema,
    assignee: z.string().min(1),
    /**
     * Session binding. Three semantically distinct meanings depending
     * on status — don't clear this field without understanding which
     * applies:
     *  - non-terminal (open / in_progress / blocked): the live session
     *    where work is happening or will happen on pickup.
     *  - done / canceled: historical audit trail. The session where the
     *    work happened. Do NOT null this out — readers (event log, web
     *    detail view, prompt rendering of past activity) rely on it.
     *  - recurring task in `open` post-reset with `recurrence.session:
     *    "reuse"`: the session the next fire will run in.
     */
    session_id: z.string().min(1).nullable().default(null),
    created_by: z.string().min(1),
    parent_id: z.string().min(1).nullable().default(null),
    depends_on: z.array(z.string().min(1)).default([]),
    start_at: NullableIso.default(null),
    due_at: NullableIso.default(null),
    created_at: IsoString,
    updated_at: IsoString,
    closed_at: NullableIso.default(null),
    recurrence: RecurrenceSchema.nullable().default(null),
    runs: z.number().int().nonnegative().default(0),
    last_run_at: NullableIso.default(null),
    // Organizational tag — groups work under a team (UI grouping, team
    // workspace conventions). No dispatch semantics: assignment and
    // wake-up are driven by `assignee` + `session_id` only.
    team: z.string().min(1).nullable().default(null),
  })
  .passthrough();

export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;

export interface Task extends TaskFrontmatter {
  body: string;
}

export interface TaskCreate {
  title: string;
  assignee: string;
  created_by: string;
  body?: string;
  session_id?: string | null;
  parent_id?: string | null;
  depends_on?: string[];
  start_at?: string | null;
  due_at?: string | null;
  status?: TaskStatus;
  recurrence?: Recurrence | null;
  team?: string | null;
}

export interface TaskUpdate {
  title?: string;
  body?: string;
  status?: TaskStatus;
  assignee?: string;
  session_id?: string | null;
  depends_on?: string[];
  start_at?: string | null;
  due_at?: string | null;
  recurrence?: Recurrence | null;
  team?: string | null;
}

export interface TaskListFilter {
  assignee?: string;
  status?: TaskStatus | TaskStatus[];
  session_id?: string | null;
  parent_id?: string | null;
  created_by?: string;
  team?: string;
}
