const applyMigrations = (db) => {
  db.prepare("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)").run();
  const getVersion = () => {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    return row?.value ? Number(row.value) : 0;
  };
  const setVersion = (version) => {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      String(version)
    );
  };

  let version = getVersion();
  if (version < 1) {
    db.prepare("CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks (state)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_tasks_due_at ON tasks (due_at)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks (created_by)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_task_owners_member ON task_owners (member_id)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks (task_id)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_comments_task ON comments (task_id)").run();
    setVersion(1);
    version = 1;
  }

  if (version < 2) {
    db.prepare("CREATE TABLE IF NOT EXISTS reminders (task_id TEXT PRIMARY KEY, remind24h_sent INTEGER, remind2h_sent INTEGER, last_overdue_at TEXT, snooze_until TEXT)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_reminders_task ON reminders (task_id)").run();
    setVersion(2);
    version = 2;
  }

  if (version < 3) {
    db.prepare("CREATE TABLE IF NOT EXISTS reminder_events (id TEXT PRIMARY KEY, task_id TEXT, member_id TEXT, type TEXT, sent_at TEXT)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_reminder_events_task ON reminder_events (task_id)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_reminder_events_member ON reminder_events (member_id)").run();
    setVersion(3);
    version = 3;
  }

  if (version < 4) {
    db.prepare("CREATE TABLE IF NOT EXISTS task_events (id TEXT PRIMARY KEY, task_id TEXT, actor_id TEXT, action TEXT, occurred_at TEXT)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events (task_id)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_task_events_actor ON task_events (actor_id)").run();
    setVersion(4);
    version = 4;
  }

  if (version < 5) {
    db.prepare("CREATE INDEX IF NOT EXISTS idx_reminder_events_sent_at ON reminder_events (sent_at)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_task_events_occurred_at ON task_events (occurred_at)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_task_events_action ON task_events (action)").run();
    setVersion(5);
    version = 5;
  }

  if (version < 6) {
    try {
      db.prepare("ALTER TABLE members ADD COLUMN wechat_openid TEXT").run();
    } catch (error) {
      db.prepare("SELECT wechat_openid FROM members LIMIT 1").get();
    }
    setVersion(6);
    version = 6;
  }

  return version;
};

module.exports = { applyMigrations };
