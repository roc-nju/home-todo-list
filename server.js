const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { randomUUID } = require("crypto");
const { createStore } = require("./store");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const defaultMembers = ["爸爸", "妈妈", "爷爷", "奶奶"];

const createMember = (name) => ({
  id: randomUUID(),
  name,
  reminderPrefs: {
    enabled: true,
    remind24h: true,
    remind2h: true,
    overdue: true
  }
});

const store = createStore({ createMember, defaultMembers });
const state = store.state;

const createTask = ({ content, owners, dueAt, requireConfirm, createdBy }) => ({
  id: randomUUID(),
  content,
  owners,
  dueAt,
  requireConfirm,
  createdBy,
  state: "已指派",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  reminders: {
    remind24hSent: false,
    remind2hSent: false,
    lastOverdueAt: null,
    snoozeUntil: null
  }
});

const loadState = () => {
  store.load();
};

const broadcast = () => {
  io.emit("state:update", state);
};

const getMember = (id) => state.members.find((member) => member.id === id);

const isOwner = (task, memberId) => task.owners.includes(memberId);

const isCreator = (task, memberId) => task.createdBy === memberId;

const activeStates = new Set(["已指派", "已接受", "进行中"]);

loadState();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/state", (req, res) => {
  res.json(state);
});

app.get("/api/stats/reminders", (req, res) => {
  const days = Math.max(1, Number(req.query?.days || 7));
  const stats = store.getReminderStats(days);
  res.json(stats);
});

app.get("/api/stats/reminders/trend", (req, res) => {
  const days = Math.max(1, Number(req.query?.days || 7));
  const stats = store.getReminderTrend(days);
  res.json(stats);
});

app.get("/api/stats/tasks", (req, res) => {
  const days = Math.max(1, Number(req.query?.days || 7));
  const stats = store.getTaskEventStats(days);
  res.json(stats);
});

app.get("/api/stats/members", (req, res) => {
  const days = Math.max(1, Number(req.query?.days || 7));
  const stats = store.getMemberStats(days);
  res.json(stats);
});

app.post("/api/members", (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) {
    res.status(400).json({ error: "成员名不能为空" });
    return;
  }
  const member = createMember(name);
  state.members.push(member);
  store.upsertMember(member);
  broadcast();
  res.json(member);
});

app.patch("/api/members/:id", (req, res) => {
  const member = getMember(req.params.id);
  if (!member) {
    res.status(404).json({ error: "成员不存在" });
    return;
  }
  const prefs = req.body?.reminderPrefs;
  if (prefs) {
    member.reminderPrefs = {
      enabled: Boolean(prefs.enabled),
      remind24h: Boolean(prefs.remind24h),
      remind2h: Boolean(prefs.remind2h),
      overdue: Boolean(prefs.overdue)
    };
  }
  if (req.body?.name) {
    member.name = String(req.body.name).trim() || member.name;
  }
  store.upsertMember(member);
  broadcast();
  res.json(member);
});

app.post("/api/tasks", (req, res) => {
  const content = String(req.body?.content || "").trim();
  const createdBy = String(req.body?.createdBy || "").trim();
  if (!content || !createdBy) {
    res.status(400).json({ error: "任务内容或创建者不能为空" });
    return;
  }
  const ownerIds = Array.isArray(req.body?.owners) ? req.body.owners : [];
  const owners = ownerIds.filter((id) => getMember(id));
  if (!owners.length) {
    owners.push(createdBy);
  }
  const dueAt = req.body?.dueAt ? new Date(req.body.dueAt).toISOString() : null;
  const requireConfirm = Boolean(req.body?.requireConfirm);
  const task = createTask({ content, owners, dueAt, requireConfirm, createdBy });
  state.tasks.unshift(task);
  store.upsertTask(task);
  store.logTaskEvents([
    {
      id: randomUUID(),
      taskId: task.id,
      actorId: createdBy,
      action: "create",
      occurredAt: new Date().toISOString()
    }
  ]);
  broadcast();
  res.json(task);
});

app.patch("/api/tasks/:id", (req, res) => {
  const task = state.tasks.find((item) => item.id === req.params.id);
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  const actorId = String(req.body?.actorId || "").trim();
  const action = String(req.body?.action || "").trim();
  let changed = false;

  const applyUpdate = () => {
    task.updatedAt = new Date().toISOString();
    store.upsertTask(task);
    store.logTaskEvents([
      {
        id: randomUUID(),
        taskId: task.id,
        actorId,
        action,
        occurredAt: task.updatedAt
      }
    ]);
    broadcast();
    res.json(task);
  };

  if (action === "accept" && isOwner(task, actorId) && task.state === "已指派") {
    task.state = "已接受";
    changed = true;
  }

  if (action === "start" && isOwner(task, actorId) && task.state === "已接受") {
    task.state = "进行中";
    changed = true;
  }

  if (
    action === "complete" &&
    isOwner(task, actorId) &&
    (task.state === "已接受" || task.state === "进行中")
  ) {
    task.state = task.requireConfirm ? "待确认" : "已完成";
    changed = true;
  }

  if (action === "confirm" && isCreator(task, actorId) && task.state === "待确认") {
    task.state = "已完成";
    changed = true;
  }

  if (action === "snooze" && isOwner(task, actorId)) {
    const minutes = Math.max(5, Number(req.body?.minutes || 60));
    task.reminders.snoozeUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    changed = true;
  }

  if (action === "update" && isCreator(task, actorId)) {
    if (req.body?.content) {
      task.content = String(req.body.content).trim();
    }
    if (Array.isArray(req.body?.owners)) {
      const owners = req.body.owners.filter((id) => getMember(id));
      task.owners = owners.length ? owners : task.owners;
    }
    if ("dueAt" in req.body) {
      task.dueAt = req.body.dueAt ? new Date(req.body.dueAt).toISOString() : null;
      task.reminders.remind24hSent = false;
      task.reminders.remind2hSent = false;
      task.reminders.lastOverdueAt = null;
      task.reminders.snoozeUntil = null;
    }
    if ("requireConfirm" in req.body) {
      task.requireConfirm = Boolean(req.body.requireConfirm);
    }
    changed = true;
  }

  if (!changed) {
    res.status(400).json({ error: "动作不允许或无变化" });
    return;
  }

  applyUpdate();
});

io.on("connection", (socket) => {
  socket.on("user:join", (memberId) => {
    if (memberId) {
      socket.join(`member:${memberId}`);
    }
  });
});

const maybeSendReminder = (task, type, sentAt, events) => {
  task.owners.forEach((ownerId) => {
    const member = getMember(ownerId);
    if (!member || !member.reminderPrefs?.enabled) {
      return;
    }
    if (type === "remind24h" && !member.reminderPrefs.remind24h) {
      return;
    }
    if (type === "remind2h" && !member.reminderPrefs.remind2h) {
      return;
    }
    if (type === "overdue" && !member.reminderPrefs.overdue) {
      return;
    }
    io.to(`member:${ownerId}`).emit("reminder", { taskId: task.id, type });
    events.push({
      id: randomUUID(),
      taskId: task.id,
      memberId: ownerId,
      type,
      sentAt
    });
  });
};

const reminderTick = () => {
  const now = Date.now();
  const sentAt = new Date().toISOString();
  const changedTasks = [];
  const reminderEvents = [];
  state.tasks.forEach((task) => {
    if (!task.dueAt || !activeStates.has(task.state)) {
      return;
    }
    const due = new Date(task.dueAt).getTime();
    if (Number.isNaN(due)) {
      return;
    }
    if (task.reminders.snoozeUntil) {
      const snoozeUntil = new Date(task.reminders.snoozeUntil).getTime();
      if (now < snoozeUntil) {
        return;
      }
      task.reminders.snoozeUntil = null;
      changedTasks.push(task);
    }
    const diff = due - now;
    if (diff <= 24 * 60 * 60 * 1000 && !task.reminders.remind24hSent) {
      maybeSendReminder(task, "remind24h", sentAt, reminderEvents);
      task.reminders.remind24hSent = true;
      changedTasks.push(task);
    }
    if (diff <= 2 * 60 * 60 * 1000 && !task.reminders.remind2hSent) {
      maybeSendReminder(task, "remind2h", sentAt, reminderEvents);
      task.reminders.remind2hSent = true;
      changedTasks.push(task);
    }
    if (diff <= 0) {
      const last = task.reminders.lastOverdueAt
        ? new Date(task.reminders.lastOverdueAt).getTime()
        : 0;
      if (!last || now - last >= 6 * 60 * 60 * 1000) {
        maybeSendReminder(task, "overdue", sentAt, reminderEvents);
        task.reminders.lastOverdueAt = new Date().toISOString();
        changedTasks.push(task);
      }
    }
  });
  if (reminderEvents.length) {
    store.logReminderEvents(reminderEvents);
  }
  if (changedTasks.length) {
    store.upsertTasks(changedTasks);
  }
};

setInterval(reminderTick, 60 * 1000);

const port = process.env.PORT || 5173;
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
