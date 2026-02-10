const fs = require("fs");
const path = require("path");
let Database;
try {
  Database = require("better-sqlite3");
} catch (error) {
  throw new Error("SQLite 依赖未安装，请执行: npm install better-sqlite3");
}
const { applyMigrations } = require("./migrations");

const resolveSqliteFile = () => {
  if (process.env.SQLITE_FILE) {
    return path.resolve(process.env.SQLITE_FILE);
  }
  return path.join(__dirname, "..", "data.sqlite");
};

const resolveSeedFile = () => {
  if (process.env.DATA_FILE) {
    return path.resolve(process.env.DATA_FILE);
  }
  return path.join(__dirname, "..", "data.json");
};

const ensureDir = (filePath) => {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
};

const createSqliteStore = ({ createMember, defaultMembers }) => {
  const sqliteFile = resolveSqliteFile();
  ensureDir(sqliteFile);
  const db = new Database(sqliteFile);
  db.pragma("journal_mode = WAL");
  db.prepare(
    "CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, name TEXT, reminder_prefs TEXT)"
  ).run();
  db.prepare(
    "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, content TEXT, due_at TEXT, require_confirm INTEGER, state TEXT, created_by TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT, repeat_rule TEXT, series_id TEXT, occurrence INTEGER, reminders TEXT)"
  ).run();
  db.prepare(
    "CREATE TABLE IF NOT EXISTS task_owners (task_id TEXT, member_id TEXT, PRIMARY KEY (task_id, member_id))"
  ).run();
  db.prepare(
    "CREATE TABLE IF NOT EXISTS subtasks (id TEXT PRIMARY KEY, task_id TEXT, content TEXT, done INTEGER, created_at TEXT, done_at TEXT)"
  ).run();
  db.prepare(
    "CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, task_id TEXT, author_id TEXT, content TEXT, mentions TEXT, created_at TEXT)"
  ).run();
  db.prepare(
    "CREATE TABLE IF NOT EXISTS reminders (task_id TEXT PRIMARY KEY, remind24h_sent INTEGER, remind2h_sent INTEGER, last_overdue_at TEXT, snooze_until TEXT)"
  ).run();
  db.prepare(
    "CREATE TABLE IF NOT EXISTS reminder_events (id TEXT PRIMARY KEY, task_id TEXT, member_id TEXT, type TEXT, sent_at TEXT)"
  ).run();
  db.prepare(
    "CREATE TABLE IF NOT EXISTS task_events (id TEXT PRIMARY KEY, task_id TEXT, actor_id TEXT, action TEXT, occurred_at TEXT)"
  ).run();
  const state = { members: [], tasks: [] };
  const insertMember = db.prepare(
    "INSERT INTO members (id, name, reminder_prefs) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, reminder_prefs = excluded.reminder_prefs"
  );
  const insertTask = db.prepare(
    "INSERT INTO tasks (id, content, due_at, require_confirm, state, created_by, created_at, updated_at, archived_at, deleted_at, repeat_rule, series_id, occurrence, reminders) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, due_at = excluded.due_at, require_confirm = excluded.require_confirm, state = excluded.state, created_by = excluded.created_by, created_at = excluded.created_at, updated_at = excluded.updated_at, archived_at = excluded.archived_at, deleted_at = excluded.deleted_at, repeat_rule = excluded.repeat_rule, series_id = excluded.series_id, occurrence = excluded.occurrence, reminders = excluded.reminders"
  );
  const insertOwner = db.prepare(
    "INSERT INTO task_owners (task_id, member_id) VALUES (?, ?) ON CONFLICT(task_id, member_id) DO NOTHING"
  );
  const insertSubtask = db.prepare(
    "INSERT INTO subtasks (id, task_id, content, done, created_at, done_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, done = excluded.done, created_at = excluded.created_at, done_at = excluded.done_at"
  );
  const insertComment = db.prepare(
    "INSERT INTO comments (id, task_id, author_id, content, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET author_id = excluded.author_id, content = excluded.content, mentions = excluded.mentions, created_at = excluded.created_at"
  );
  const insertReminder = db.prepare(
    "INSERT INTO reminders (task_id, remind24h_sent, remind2h_sent, last_overdue_at, snooze_until) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET remind24h_sent = excluded.remind24h_sent, remind2h_sent = excluded.remind2h_sent, last_overdue_at = excluded.last_overdue_at, snooze_until = excluded.snooze_until"
  );
  const insertReminderEvent = db.prepare(
    "INSERT INTO reminder_events (id, task_id, member_id, type, sent_at) VALUES (?, ?, ?, ?, ?)"
  );
  const insertTaskEvent = db.prepare(
    "INSERT INTO task_events (id, task_id, actor_id, action, occurred_at) VALUES (?, ?, ?, ?, ?)"
  );
  const deleteOwnersByTask = db.prepare("DELETE FROM task_owners WHERE task_id = ?");
  const deleteSubtasksByTask = db.prepare("DELETE FROM subtasks WHERE task_id = ?");
  const deleteCommentsByTask = db.prepare("DELETE FROM comments WHERE task_id = ?");
  const deleteRemindersByTask = db.prepare("DELETE FROM reminders WHERE task_id = ?");

  const loadSeed = () => {
    const seedFile = resolveSeedFile();
    if (!fs.existsSync(seedFile)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(seedFile, "utf8");
      const parsed = JSON.parse(raw);
      return {
        members: Array.isArray(parsed.members) ? parsed.members : [],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : []
      };
    } catch (error) {
      return null;
    }
  };

  const upsertMember = (member) => {
    insertMember.run(member.id, member.name, JSON.stringify(member.reminderPrefs || {}));
  };

  const upsertMembers = (members) => {
    const transaction = db.transaction(() => {
      members.forEach((member) => upsertMember(member));
    });
    transaction();
  };

  const upsertTask = (task) => {
    insertTask.run(
      task.id,
      task.content,
      task.dueAt,
      task.requireConfirm ? 1 : 0,
      task.state,
      task.createdBy,
      task.createdAt,
      task.updatedAt,
      task.archivedAt || null,
      task.deletedAt || null,
      task.repeat ? JSON.stringify(task.repeat) : null,
      task.seriesId || null,
      Number.isFinite(task.occurrence) ? task.occurrence : null,
      JSON.stringify(task.reminders || {})
    );
    const reminder = task.reminders || {};
    insertReminder.run(
      task.id,
      reminder.remind24hSent ? 1 : 0,
      reminder.remind2hSent ? 1 : 0,
      reminder.lastOverdueAt || null,
      reminder.snoozeUntil || null
    );
    deleteOwnersByTask.run(task.id);
    deleteSubtasksByTask.run(task.id);
    deleteCommentsByTask.run(task.id);
    (task.owners || []).forEach((ownerId) => {
      insertOwner.run(task.id, ownerId);
    });
    (task.subtasks || []).forEach((subtask) => {
      insertSubtask.run(
        subtask.id,
        task.id,
        subtask.content,
        subtask.done ? 1 : 0,
        subtask.createdAt,
        subtask.doneAt || null
      );
    });
    (task.comments || []).forEach((comment) => {
      insertComment.run(
        comment.id,
        task.id,
        comment.authorId,
        comment.content,
        JSON.stringify(comment.mentions || []),
        comment.createdAt
      );
    });
  };

  const upsertTasks = (tasks) => {
    const transaction = db.transaction(() => {
      tasks.forEach((task) => upsertTask(task));
    });
    transaction();
  };

  const logReminderEvents = (events) => {
    if (!events.length) {
      return;
    }
    const transaction = db.transaction(() => {
      events.forEach((event) => {
        insertReminderEvent.run(
          event.id,
          event.taskId,
          event.memberId,
          event.type,
          event.sentAt
        );
      });
    });
    transaction();
  };

  const logTaskEvents = (events) => {
    if (!events.length) {
      return;
    }
    const transaction = db.transaction(() => {
      events.forEach((event) => {
        insertTaskEvent.run(
          event.id,
          event.taskId,
          event.actorId,
          event.action,
          event.occurredAt
        );
      });
    });
    transaction();
  };

  const getReminderStats = (sinceDays = 7) => {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
    const byType = db.prepare(
      "SELECT type, COUNT(*) as count FROM reminder_events WHERE sent_at >= ? GROUP BY type"
    ).all(since);
    const byMember = db.prepare(
      "SELECT member_id as memberId, COUNT(*) as count FROM reminder_events WHERE sent_at >= ? GROUP BY member_id"
    ).all(since);
    const byTask = db.prepare(
      "SELECT task_id as taskId, COUNT(*) as count FROM reminder_events WHERE sent_at >= ? GROUP BY task_id"
    ).all(since);
    return { byType, byMember, byTask };
  };

  const getReminderTrend = (sinceDays = 7) => {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(
      "SELECT substr(sent_at, 1, 10) as day, type, COUNT(*) as count FROM reminder_events WHERE sent_at >= ? GROUP BY day, type ORDER BY day"
    ).all(since);
    return { rows };
  };

  const getTaskEventStats = (sinceDays = 7) => {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
    const byAction = db.prepare(
      "SELECT action, COUNT(*) as count FROM task_events WHERE occurred_at >= ? GROUP BY action"
    ).all(since);
    const byActor = db.prepare(
      "SELECT actor_id as actorId, COUNT(*) as count FROM task_events WHERE occurred_at >= ? GROUP BY actor_id"
    ).all(since);
    return { byAction, byActor };
  };

  const getMemberStats = (sinceDays = 7) => {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
    const totals = db.prepare(
      "SELECT task_owners.member_id as memberId, COUNT(*) as total FROM task_owners JOIN tasks ON tasks.id = task_owners.task_id WHERE tasks.created_at >= ? GROUP BY task_owners.member_id"
    ).all(since);
    const completed = db.prepare(
      "SELECT task_owners.member_id as memberId, COUNT(*) as completed FROM task_owners JOIN tasks ON tasks.id = task_owners.task_id WHERE tasks.state = '已完成' AND tasks.updated_at >= ? GROUP BY task_owners.member_id"
    ).all(since);
    const names = db.prepare("SELECT id, name FROM members").all();
    const totalMap = totals.reduce((acc, row) => {
      acc[row.memberId] = row.total;
      return acc;
    }, {});
    const completedMap = completed.reduce((acc, row) => {
      acc[row.memberId] = row.completed;
      return acc;
    }, {});
    const members = names.map((member) => {
      const total = totalMap[member.id] || 0;
      const done = completedMap[member.id] || 0;
      const rate = total ? Number((done / total).toFixed(4)) : 0;
      return {
        memberId: member.id,
        name: member.name,
        totalAssigned: total,
        completed: done,
        completionRate: rate
      };
    });
    return { members };
  };

  const saveAll = () => {
    const transaction = db.transaction(() => {
      const currentMemberIds = new Set(state.members.map((member) => member.id));
      const currentTaskIds = new Set(state.tasks.map((task) => task.id));
      if (currentMemberIds.size) {
        db.prepare(
          `DELETE FROM members WHERE id NOT IN (${Array.from(currentMemberIds).map(() => "?").join(",")})`
        ).run(...Array.from(currentMemberIds));
      } else {
        db.prepare("DELETE FROM members").run();
      }
      if (currentTaskIds.size) {
        db.prepare(
          `DELETE FROM tasks WHERE id NOT IN (${Array.from(currentTaskIds).map(() => "?").join(",")})`
        ).run(...Array.from(currentTaskIds));
        db.prepare(
          `DELETE FROM task_owners WHERE task_id NOT IN (${Array.from(currentTaskIds).map(() => "?").join(",")})`
        ).run(...Array.from(currentTaskIds));
        db.prepare(
          `DELETE FROM subtasks WHERE task_id NOT IN (${Array.from(currentTaskIds).map(() => "?").join(",")})`
        ).run(...Array.from(currentTaskIds));
        db.prepare(
          `DELETE FROM comments WHERE task_id NOT IN (${Array.from(currentTaskIds).map(() => "?").join(",")})`
        ).run(...Array.from(currentTaskIds));
        db.prepare(
          `DELETE FROM reminders WHERE task_id NOT IN (${Array.from(currentTaskIds).map(() => "?").join(",")})`
        ).run(...Array.from(currentTaskIds));
      } else {
        db.prepare("DELETE FROM tasks").run();
        db.prepare("DELETE FROM task_owners").run();
        db.prepare("DELETE FROM subtasks").run();
        db.prepare("DELETE FROM comments").run();
        db.prepare("DELETE FROM reminders").run();
      }
      upsertMembers(state.members);
      upsertTasks(state.tasks);
    });
    transaction();
  };

  const load = () => {
    applyMigrations(db);
    const members = db.prepare("SELECT id, name, reminder_prefs FROM members").all();
    const tasks = db.prepare("SELECT id, content, due_at, require_confirm, state, created_by, created_at, updated_at, archived_at, deleted_at, repeat_rule, series_id, occurrence, reminders FROM tasks").all();
    if (members.length || tasks.length) {
      state.members = members.map((row) => ({
        id: row.id,
        name: row.name,
        reminderPrefs: row.reminder_prefs ? JSON.parse(row.reminder_prefs) : {}
      }));
      const ownerRows = db.prepare("SELECT task_id, member_id FROM task_owners").all();
      const subtaskRows = db.prepare("SELECT id, task_id, content, done, created_at, done_at FROM subtasks").all();
      const commentRows = db.prepare("SELECT id, task_id, author_id, content, mentions, created_at FROM comments").all();
      const reminderRows = db.prepare("SELECT task_id, remind24h_sent, remind2h_sent, last_overdue_at, snooze_until FROM reminders").all();
      const ownersByTask = ownerRows.reduce((acc, row) => {
        if (!acc[row.task_id]) acc[row.task_id] = [];
        acc[row.task_id].push(row.member_id);
        return acc;
      }, {});
      const subtasksByTask = subtaskRows.reduce((acc, row) => {
        if (!acc[row.task_id]) acc[row.task_id] = [];
        acc[row.task_id].push({
          id: row.id,
          content: row.content,
          done: Boolean(row.done),
          createdAt: row.created_at,
          doneAt: row.done_at || null
        });
        return acc;
      }, {});
      const commentsByTask = commentRows.reduce((acc, row) => {
        if (!acc[row.task_id]) acc[row.task_id] = [];
        acc[row.task_id].push({
          id: row.id,
          authorId: row.author_id,
          content: row.content,
          mentions: row.mentions ? JSON.parse(row.mentions) : [],
          createdAt: row.created_at
        });
        return acc;
      }, {});
      const remindersByTask = reminderRows.reduce((acc, row) => {
        acc[row.task_id] = {
          remind24hSent: Boolean(row.remind24h_sent),
          remind2hSent: Boolean(row.remind2h_sent),
          lastOverdueAt: row.last_overdue_at || null,
          snoozeUntil: row.snooze_until || null
        };
        return acc;
      }, {});
      state.tasks = tasks.map((row) => ({
        id: row.id,
        content: row.content,
        dueAt: row.due_at,
        requireConfirm: Boolean(row.require_confirm),
        state: row.state,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        archivedAt: row.archived_at || null,
        deletedAt: row.deleted_at || null,
        repeat: row.repeat_rule ? JSON.parse(row.repeat_rule) : null,
        seriesId: row.series_id || null,
        occurrence: Number.isFinite(row.occurrence) ? row.occurrence : null,
        reminders: remindersByTask[row.id] || (row.reminders ? JSON.parse(row.reminders) : {}),
        owners: ownersByTask[row.id] || [],
        subtasks: subtasksByTask[row.id] || [],
        comments: commentsByTask[row.id] || []
      }));
      if (!reminderRows.length && state.tasks.length) {
        const transaction = db.transaction(() => {
          state.tasks.forEach((task) => {
            const reminder = task.reminders || {};
            insertReminder.run(
              task.id,
              reminder.remind24hSent ? 1 : 0,
              reminder.remind2hSent ? 1 : 0,
              reminder.lastOverdueAt || null,
              reminder.snoozeUntil || null
            );
          });
        });
        transaction();
      }
      return;
    }
    const seed = loadSeed();
    if (seed) {
      state.members = seed.members;
      state.tasks = seed.tasks;
      saveAll();
      return;
    }
    state.members = defaultMembers.map(createMember);
    state.tasks = [];
    saveAll();
  };

  return { state, load, saveAll, upsertMember, upsertMembers, upsertTask, upsertTasks, logReminderEvents, logTaskEvents, getReminderStats, getReminderTrend, getTaskEventStats, getMemberStats, dataFile: sqliteFile };
};

module.exports = { createSqliteStore };
