const ACCESS_PASSWORD = "family";
const AUTH_STORAGE_KEY = "home_todo_access";

const basePath = (document.body?.dataset?.basePath || "").replace(/\/$/, "");
const apiUrl = (path) => `${basePath}${path}`;
const apiFetch = (path, options) => fetch(apiUrl(path), options);

const state = {
  members: [],
  tasks: [],
  reminders: []
};

let eventSource = null;
let sseRetryTimer = null;
let calendarDate = new Date();
let wechatEnabled = false;
const chartTooltip = document.createElement("div");
chartTooltip.className = "chart-tooltip";
document.body.appendChild(chartTooltip);
const reminderTypeLabel = {
  remind24h: "T-24h",
  remind2h: "T-2h",
  overdue: "超时"
};
const taskActionLabel = {
  create: "创建",
  accept: "接受",
  start: "开始",
  complete: "完成",
  confirm: "确认",
  snooze: "稍后提醒",
  update: "编辑"
};

const elements = {
  app: document.getElementById("app"),
  currentUserSelect: document.getElementById("currentUserSelect"),
  addMemberBtn: document.getElementById("addMemberBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  openCreateTask: document.getElementById("openCreateTask"),
  bindWeChatBtn: document.getElementById("bindWeChatBtn"),
  taskList: document.getElementById("taskList"),
  statusFilter: document.getElementById("statusFilter"),
  ownerFilter: document.getElementById("ownerFilter"),
  dueDateFilter: document.getElementById("dueDateFilter"),
  trendRange: document.getElementById("trendRange"),
  trendType: document.getElementById("trendType"),
  exportStatsBtn: document.getElementById("exportStatsBtn"),
  overdueRate: document.getElementById("overdueRate"),
  overdueDetail: document.getElementById("overdueDetail"),
  memberStats: document.getElementById("memberStats"),
  reminderStats: document.getElementById("reminderStats"),
  reminderTaskTop: document.getElementById("reminderTaskTop"),
  reminderMemberTop: document.getElementById("reminderMemberTop"),
  taskEventStats: document.getElementById("taskEventStats"),
  taskActorTop: document.getElementById("taskActorTop"),
  trendLegend: document.getElementById("trendLegend"),
  trendChart: document.getElementById("trendChart"),
  calendarPrev: document.getElementById("calendarPrev"),
  calendarNext: document.getElementById("calendarNext"),
  calendarView: document.getElementById("calendarView"),
  calendarTitle: document.getElementById("calendarTitle"),
  calendarGrid: document.getElementById("calendarGrid"),
  authOverlay: document.getElementById("authOverlay"),
  authPassword: document.getElementById("authPassword"),
  authError: document.getElementById("authError"),
  authConfirm: document.getElementById("authConfirm"),
  completionRate: document.getElementById("completionRate"),
  completionDetail: document.getElementById("completionDetail"),
  reminderList: document.getElementById("reminderList"),
  remindEnabled: document.getElementById("remindEnabled"),
  remind24h: document.getElementById("remind24h"),
  remind2h: document.getElementById("remind2h"),
  remindOverdue: document.getElementById("remindOverdue"),
  modalOverlay: document.getElementById("modalOverlay"),
  modalTitle: document.getElementById("modalTitle"),
  modalBody: document.getElementById("modalBody"),
  modalCancel: document.getElementById("modalCancel"),
  modalConfirm: document.getElementById("modalConfirm")
};

const getCurrentUserId = () => localStorage.getItem("currentUserId");

const setCurrentUserId = (id) => {
  localStorage.setItem("currentUserId", id);
};

const isAuthorized = () => localStorage.getItem(AUTH_STORAGE_KEY) === "true";

const showAuth = () => {
  closeSSE();
  elements.authOverlay.classList.remove("hidden");
  elements.app.classList.add("hidden");
  elements.authPassword.value = "";
};

const enterApp = () => {
  elements.authOverlay.classList.add("hidden");
  elements.app.classList.remove("hidden");
  elements.authError.textContent = "";
  loadState();
};

const ensureValidCurrentUser = () => {
  const currentId = getCurrentUserId();
  if (currentId && state.members.some((m) => m.id === currentId)) {
    return currentId;
  }
  if (state.members.length) {
    const fallbackId = state.members[0].id;
    setCurrentUserId(fallbackId);
    return fallbackId;
  }
  return null;
};

const closeModal = () => {
  elements.modalOverlay.classList.add("hidden");
  elements.modalTitle.textContent = "";
  elements.modalBody.innerHTML = "";
  elements.modalConfirm.onclick = null;
  elements.modalConfirm.textContent = "确定";
};

const openConfirmModal = ({ title, message, onConfirm, confirmLabel = "确定" }) => {
  elements.modalTitle.textContent = title;
  elements.modalBody.textContent = message;
  elements.modalOverlay.classList.remove("hidden");
  elements.modalConfirm.textContent = confirmLabel;
  elements.modalConfirm.onclick = () => {
    closeModal();
    onConfirm();
  };
};

const openEditModal = ({ title, value, onConfirm, confirmLabel = "确定" }) => {
  elements.modalTitle.textContent = title;
  elements.modalBody.innerHTML = `<input class="modal-input" id="modalInput" type="text" />`;
  const input = elements.modalBody.querySelector("#modalInput");
  input.value = value;
  elements.modalOverlay.classList.remove("hidden");
  elements.modalConfirm.textContent = confirmLabel;
  elements.modalConfirm.onclick = () => {
    const nextValue = input.value.trim();
    if (!nextValue) {
      return;
    }
    closeModal();
    onConfirm(nextValue);
  };
  setTimeout(() => input.focus(), 0);
};

const openTaskEditModal = ({ task, onConfirm }) => {
  elements.modalTitle.textContent = "编辑任务";
  elements.modalBody.innerHTML = `
    <div class="modal-field">
      <div class="modal-label">任务内容</div>
      <input class="modal-input" id="modalTaskContent" type="text" />
    </div>
    <div class="modal-field">
      <div class="modal-label">截止时间</div>
      <input class="modal-input" id="modalTaskDueAt" type="datetime-local" />
    </div>
    <div class="modal-field">
      <div class="modal-label">重复频率</div>
      <select class="modal-input" id="modalTaskRepeat">
        <option value="none">不重复</option>
        <option value="daily">每天</option>
        <option value="weekly">每周</option>
        <option value="monthly">每月</option>
      </select>
    </div>
    <div class="modal-field">
      <div class="modal-label">责任人</div>
      <div id="modalOwners" class="chip-list modal-owners"></div>
    </div>
    <label class="checkbox modal-checkbox">
      <input id="modalRequireConfirm" type="checkbox" />
      完成需确认
    </label>
  `;
  const contentInput = elements.modalBody.querySelector("#modalTaskContent");
  const dueAtInput = elements.modalBody.querySelector("#modalTaskDueAt");
  const repeatInput = elements.modalBody.querySelector("#modalTaskRepeat");
  const ownersContainer = elements.modalBody.querySelector("#modalOwners");
  const confirmInput = elements.modalBody.querySelector("#modalRequireConfirm");
  contentInput.value = task.content || "";
  dueAtInput.value = toLocalInputValue(task.dueAt);
  repeatInput.value = task.repeat?.type || task.repeat || "none";
  confirmInput.checked = Boolean(task.requireConfirm);
  ownersContainer.innerHTML = "";
  state.members.forEach((member) => {
    const label = document.createElement("label");
    label.className = "chip";
    const checked = task.owners.includes(member.id) ? "checked" : "";
    label.innerHTML = `<input type="checkbox" value="${member.id}" ${checked} />${member.name}`;
    ownersContainer.appendChild(label);
  });
  elements.modalOverlay.classList.remove("hidden");
  elements.modalConfirm.textContent = "保存";
  elements.modalConfirm.onclick = () => {
    const nextContent = contentInput.value.trim();
    if (!nextContent) {
      return;
    }
    const owners = Array.from(
      ownersContainer.querySelectorAll("input[type='checkbox']")
    )
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => checkbox.value);
    const dueAt = dueAtInput.value ? new Date(dueAtInput.value).toISOString() : null;
    const repeat = repeatInput.value || "none";
    const requireConfirm = confirmInput.checked;
    closeModal();
    onConfirm({
      content: nextContent,
      owners,
      dueAt,
      repeat,
      requireConfirm
    });
  };
  setTimeout(() => contentInput.focus(), 0);
};

const openCommentModal = ({ task, onConfirm }) => {
  elements.modalTitle.textContent = "任务评论";
  elements.modalBody.innerHTML = `
    <div class="comment-section">
      <div class="comment-list" id="commentList"></div>
      <div class="comment-add">
        <textarea id="commentInput" placeholder="写下评论，可用 @姓名 提醒"></textarea>
      </div>
      <div class="mention-suggest" id="mentionSuggest"></div>
    </div>
  `;
  const commentList = elements.modalBody.querySelector("#commentList");
  const commentInput = elements.modalBody.querySelector("#commentInput");
  const mentionSuggest = elements.modalBody.querySelector("#mentionSuggest");
  const comments = task.comments || [];
  if (!comments.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无评论";
    commentList.appendChild(empty);
  } else {
    comments.forEach((comment) => {
      const item = document.createElement("div");
      item.className = "comment-item";
      const authorName = getMemberName(comment.authorId);
      item.innerHTML = `
        <div class="comment-meta">
          <span>${authorName}</span>
          <span>${formatDateTime(comment.createdAt)}</span>
        </div>
        <div class="comment-content">${comment.content}</div>
      `;
      commentList.appendChild(item);
    });
  }
  elements.modalOverlay.classList.remove("hidden");
  elements.modalConfirm.textContent = "发送";
  const getMentionQuery = () => {
    const caret = commentInput.selectionStart || 0;
    const text = commentInput.value.slice(0, caret);
    const atIndex = text.lastIndexOf("@");
    if (atIndex === -1) {
      return null;
    }
    const tail = text.slice(atIndex + 1);
    if (tail.includes(" ") || tail.includes("\n")) {
      return null;
    }
    return { atIndex, query: tail };
  };
  const hideSuggest = () => {
    mentionSuggest.classList.remove("show");
    mentionSuggest.innerHTML = "";
  };
  const insertMention = (name, atIndex) => {
    const caret = commentInput.selectionStart || 0;
    const before = commentInput.value.slice(0, atIndex);
    const after = commentInput.value.slice(caret);
    const nextValue = `${before}@${name} ${after}`;
    commentInput.value = nextValue;
    const nextCaret = before.length + name.length + 2;
    commentInput.setSelectionRange(nextCaret, nextCaret);
    commentInput.focus();
    hideSuggest();
  };
  const updateSuggest = () => {
    const query = getMentionQuery();
    if (!query) {
      hideSuggest();
      return;
    }
    const options = state.members.filter((member) =>
      member.name.includes(query.query)
    );
    if (!options.length) {
      hideSuggest();
      return;
    }
    mentionSuggest.innerHTML = "";
    options.forEach((member) => {
      const item = document.createElement("div");
      item.className = "mention-item";
      item.textContent = member.name;
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        insertMention(member.name, query.atIndex);
      });
      mentionSuggest.appendChild(item);
    });
    mentionSuggest.classList.add("show");
  };
  commentInput.addEventListener("input", updateSuggest);
  commentInput.addEventListener("click", updateSuggest);
  elements.modalConfirm.onclick = () => {
    const content = commentInput.value.trim();
    if (!content) {
      return;
    }
    closeModal();
    onConfirm(content);
  };
  setTimeout(() => commentInput.focus(), 0);
};

const formatDateTime = (value) => {
  if (!value) {
    return "未设置";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未设置";
  }
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
};

const formatRepeat = (repeat) => {
  const type = repeat?.type || repeat || "none";
  if (type === "daily") {
    return "每天";
  }
  if (type === "weekly") {
    return "每周";
  }
  if (type === "monthly") {
    return "每月";
  }
  return "不重复";
};

const getVisibleTasks = () => state.tasks.filter((t) => !t.deletedAt && !t.archivedAt);

const getWeekStart = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d;
};

const getMonthGridStart = (date) => {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  return start;
};

const getMonthGridEnd = (date) => {
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const offset = (last.getDay() + 6) % 7;
  const end = new Date(last);
  end.setDate(last.getDate() + (6 - offset));
  return end;
};

const formatShortDate = (date) =>
  date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });

const formatLocalDate = (value) => {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const toLocalInputValue = (isoValue) => {
  if (!isoValue) {
    return "";
  }
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (num) => String(num).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

const getMemberName = (id) => state.members.find((m) => m.id === id)?.name || "未知成员";

const parseTriage = (content) => {
  const text = content.trim();
  if (!text) {
    return { owners: [], dueAt: null, hint: "" };
  }
  const owners = state.members
    .filter((member) => text.includes(member.name))
    .map((member) => member.id);

  let dueAt = null;
  const now = new Date();
  const matchWeekday = text.match(/周([一二三四五六日天])/);
  if (text.includes("今天")) {
    const date = new Date();
    date.setHours(20, 0, 0, 0);
    dueAt = date.toISOString();
  } else if (text.includes("明天")) {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    date.setHours(20, 0, 0, 0);
    dueAt = date.toISOString();
  } else if (text.includes("后天")) {
    const date = new Date();
    date.setDate(date.getDate() + 2);
    date.setHours(20, 0, 0, 0);
    dueAt = date.toISOString();
  } else if (matchWeekday) {
    const dayMap = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
    const target = dayMap[matchWeekday[1]];
    const date = new Date(now);
    const diff = (target + 7 - now.getDay()) % 7 || 7;
    date.setDate(now.getDate() + diff);
    date.setHours(20, 0, 0, 0);
    dueAt = date.toISOString();
  } else if (text.includes("本月")) {
    const date = new Date(now.getFullYear(), now.getMonth() + 1, 0, 20, 0, 0, 0);
    dueAt = date.toISOString();
  }

  const hintParts = [];
  if (owners.length) {
    hintParts.push(`识别责任人：${owners.map(getMemberName).join("、")}`);
  }
  if (dueAt) {
    hintParts.push(`识别时间：${formatDateTime(dueAt)}`);
  }
  return { owners, dueAt, hint: hintParts.join("，") || "可手动补充责任人与时间" };
};

const renderMembers = () => {
  const currentId = ensureValidCurrentUser();
  elements.currentUserSelect.innerHTML = "";
  state.members.forEach((member) => {
    const option = document.createElement("option");
    option.value = member.id;
    option.textContent = member.name;
    if (member.id === currentId) {
      option.selected = true;
    }
    elements.currentUserSelect.appendChild(option);
  });

  const selectedOwner = elements.ownerFilter.value || "all";
  elements.ownerFilter.innerHTML = "";
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "全部责任人";
  elements.ownerFilter.appendChild(allOption);
  state.members.forEach((member) => {
    const option = document.createElement("option");
    option.value = member.id;
    option.textContent = member.name;
    if (member.id === selectedOwner) {
      option.selected = true;
    }
    elements.ownerFilter.appendChild(option);
  });
  if (selectedOwner === "all") {
    elements.ownerFilter.value = "all";
  }

  if (!currentId && state.members.length) {
    setCurrentUserId(state.members[0].id);
  }
  const currentMember = state.members.find((member) => member.id === ensureValidCurrentUser());
  if (elements.bindWeChatBtn) {
    const bound = Boolean(currentMember?.wechatOpenId);
    elements.bindWeChatBtn.textContent = bound ? "已绑定" : "绑定微信";
    elements.bindWeChatBtn.disabled = !wechatEnabled || bound;
  }
  updateReminderSettingsUI();
};

const updateReminderSettingsUI = () => {
  const member = state.members.find((m) => m.id === ensureValidCurrentUser());
  if (!member) {
    return;
  }
  elements.remindEnabled.checked = Boolean(member.reminderPrefs?.enabled);
  elements.remind24h.checked = Boolean(member.reminderPrefs?.remind24h);
  elements.remind2h.checked = Boolean(member.reminderPrefs?.remind2h);
  elements.remindOverdue.checked = Boolean(member.reminderPrefs?.overdue);
};

const renderCompletion = () => {
  const validTasks = state.tasks.filter((t) => !t.deletedAt && !t.archivedAt);
  const total = validTasks.length;
  const completed = validTasks.filter((t) => t.state === "已完成").length;
  const rate = total ? Math.round((completed / total) * 100) : 0;
  elements.completionRate.textContent = `${rate}%`;
  elements.completionDetail.textContent = `${completed} / ${total}`;
};

const renderTrendLegend = (type) => {
  if (type === "reminders") {
    elements.trendLegend.innerHTML = `
      <div class="legend-item"><span class="legend-dot"></span>提醒总量</div>
      <div class="legend-item"><span class="legend-dot completed"></span>超时提醒</div>
    `;
    return;
  }
  elements.trendLegend.innerHTML = `
    <div class="legend-item"><span class="legend-dot"></span>创建任务</div>
    <div class="legend-item"><span class="legend-dot completed"></span>完成任务</div>
  `;
};

const showChartTooltip = (event, label, value, dateLabel) => {
  const title = dateLabel ? `${dateLabel} ${label}` : label;
  chartTooltip.textContent = `${title}：${value}`;
  chartTooltip.style.left = `${event.clientX}px`;
  chartTooltip.style.top = `${event.clientY}px`;
  chartTooltip.classList.add("show");
};

const hideChartTooltip = () => {
  chartTooltip.classList.remove("show");
};

const renderDashboard = () => {
  const visibleTasks = getVisibleTasks();
  const now = new Date();
  const dueTasks = visibleTasks.filter((t) => t.dueAt && t.state !== "已完成");
  const overdueCount = dueTasks.filter((t) => {
    const due = new Date(t.dueAt);
    return !Number.isNaN(due.getTime()) && due < now;
  }).length;
  const overdueRate = dueTasks.length ? Math.round((overdueCount / dueTasks.length) * 100) : 0;
  elements.overdueRate.textContent = `${overdueRate}%`;
  elements.overdueDetail.textContent = `${overdueCount} / ${dueTasks.length}`;

  elements.memberStats.innerHTML = "";
  state.members.forEach((member) => {
    const owned = visibleTasks.filter((t) => t.owners.includes(member.id));
    const done = owned.filter((t) => t.state === "已完成").length;
    const rate = owned.length ? Math.round((done / owned.length) * 100) : 0;
    const row = document.createElement("div");
    row.className = "member-row";
    row.innerHTML = `
      <span>${member.name}</span>
      <div class="member-bar"><span style="width: ${rate}%"></span></div>
      <span>${rate}%</span>
    `;
    elements.memberStats.appendChild(row);
  });
  if (!state.members.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无成员";
    elements.memberStats.appendChild(empty);
  }

  elements.reminderStats.innerHTML = "";
  elements.taskEventStats.innerHTML = "";
  elements.reminderTaskTop.innerHTML = "";
  elements.reminderMemberTop.innerHTML = "";
  elements.taskActorTop.innerHTML = "";

  const range = Number(elements.trendRange.value || 7);
  const trendType = elements.trendType.value || "tasks";
  renderTrendLegend(trendType);
  const days = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (range - 1));
  for (let i = 0; i < range; i += 1) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d);
  }
  const createdCount = {};
  const completedCount = {};
  if (trendType === "tasks") {
    visibleTasks.forEach((task) => {
      const createdKey = formatLocalDate(task.createdAt);
      if (createdKey) {
        createdCount[createdKey] = (createdCount[createdKey] || 0) + 1;
      }
      if (task.state === "已完成") {
        const doneKey = formatLocalDate(task.updatedAt);
        if (doneKey) {
          completedCount[doneKey] = (completedCount[doneKey] || 0) + 1;
        }
      }
    });
  }
  elements.trendChart.innerHTML = "";
  const renderTrendBars = (seriesA, seriesB, labelA, labelB) => {
    const maxCount = days.reduce((max, d) => {
      const key = formatLocalDate(d);
      const a = seriesA[key] || 0;
      const b = seriesB[key] || 0;
      return Math.max(max, a, b);
    }, 0);
    days.forEach((d) => {
      const key = formatLocalDate(d);
      const a = seriesA[key] || 0;
      const b = seriesB[key] || 0;
      const col = document.createElement("div");
      col.className = "trend-col";
      const bars = document.createElement("div");
      bars.className = "trend-bars";
      const dateLabel = formatShortDate(d);
      const barA = document.createElement("div");
      barA.className = "trend-bar created";
      barA.style.height = maxCount ? `${Math.round((a / maxCount) * 100)}%` : "0%";
      barA.dataset.label = labelA;
      barA.dataset.value = a;
      barA.dataset.date = dateLabel;
      const barB = document.createElement("div");
      barB.className = "trend-bar completed";
      barB.style.height = maxCount ? `${Math.round((b / maxCount) * 100)}%` : "0%";
      barB.dataset.label = labelB;
      barB.dataset.value = b;
      barB.dataset.date = dateLabel;
      [barA, barB].forEach((bar) => {
        bar.addEventListener("mouseenter", (event) => {
          showChartTooltip(event, bar.dataset.label, bar.dataset.value, bar.dataset.date);
        });
        bar.addEventListener("mousemove", (event) => {
          showChartTooltip(event, bar.dataset.label, bar.dataset.value, bar.dataset.date);
        });
        bar.addEventListener("mouseleave", hideChartTooltip);
      });
      bars.appendChild(barA);
      bars.appendChild(barB);
      const label = document.createElement("div");
      label.className = "trend-label";
      label.textContent = dateLabel;
      col.appendChild(bars);
      col.appendChild(label);
      elements.trendChart.appendChild(col);
    });
  };
  if (trendType === "tasks") {
    renderTrendBars(createdCount, completedCount, "创建", "完成");
  } else {
    elements.trendChart.innerHTML = "";
  }

  loadRemoteStats(range, trendType, days);
};

const renderStatList = (container, rows, labelKey, valueKey) => {
  container.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无数据";
    container.appendChild(empty);
    return;
  }
  rows.forEach((row) => {
    const item = document.createElement("div");
    item.className = "stat-list-item";
    item.innerHTML = `<span>${row[labelKey]}</span><strong>${row[valueKey]}</strong>`;
    container.appendChild(item);
  });
};

const renderMemberStatsFromRemote = (members) => {
  if (!members.length) {
    return;
  }
  elements.memberStats.innerHTML = "";
  members.forEach((member) => {
    const rate = Math.round((member.completionRate || 0) * 100);
    const row = document.createElement("div");
    row.className = "member-row";
    row.innerHTML = `
      <span>${member.name}</span>
      <div class="member-bar"><span style="width: ${rate}%"></span></div>
      <span>${rate}%</span>
    `;
    elements.memberStats.appendChild(row);
  });
};

const loadRemoteStats = async (days, trendType, daySeries) => {
  try {
    const [reminderRes, taskRes, memberRes, reminderTrendRes] = await Promise.all([
      apiFetch(`/api/stats/reminders?days=${days}`),
      apiFetch(`/api/stats/tasks?days=${days}`),
      apiFetch(`/api/stats/members?days=${days}`),
      trendType === "reminders" ? apiFetch(`/api/stats/reminders/trend?days=${days}`) : Promise.resolve(null)
    ]);
    if (reminderRes.ok) {
      const reminderStats = await reminderRes.json();
      const list = (reminderStats.byType || []).map((row) => ({
        label: reminderTypeLabel[row.type] || row.type,
        value: row.count
      }));
      renderStatList(elements.reminderStats, list, "label", "value");
      const byTask = (reminderStats.byTask || [])
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .map((row) => ({
          label: (state.tasks.find((task) => task.id === row.taskId)?.content) || row.taskId,
          value: row.count
        }));
      renderStatList(elements.reminderTaskTop, byTask, "label", "value");
      const byMember = (reminderStats.byMember || [])
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .map((row) => {
          const member = state.members.find((m) => m.id === row.memberId);
          return {
            label: member ? member.name : row.memberId,
            value: row.count
          };
        });
      renderStatList(elements.reminderMemberTop, byMember, "label", "value");
    }
    if (taskRes.ok) {
      const taskStats = await taskRes.json();
      const list = (taskStats.byAction || []).map((row) => ({
        label: taskActionLabel[row.action] || row.action,
        value: row.count
      }));
      renderStatList(elements.taskEventStats, list, "label", "value");
      const byActor = (taskStats.byActor || [])
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .map((row) => {
          const member = state.members.find((m) => m.id === row.actorId);
          return {
            label: member ? member.name : row.actorId,
            value: row.count
          };
        });
      renderStatList(elements.taskActorTop, byActor, "label", "value");
    }
    if (memberRes.ok) {
      const memberStats = await memberRes.json();
      if (Array.isArray(memberStats.members)) {
        renderMemberStatsFromRemote(memberStats.members);
      }
    }
    if (trendType === "reminders" && reminderTrendRes && reminderTrendRes.ok) {
      const trendData = await reminderTrendRes.json();
      const rows = trendData.rows || [];
      const total = {};
      const overdue = {};
      rows.forEach((row) => {
        total[row.day] = (total[row.day] || 0) + row.count;
        if (row.type === "overdue") {
          overdue[row.day] = (overdue[row.day] || 0) + row.count;
        }
      });
      elements.trendChart.innerHTML = "";
      const maxCount = daySeries.reduce((max, d) => {
        const key = formatLocalDate(d);
        const a = total[key] || 0;
        const b = overdue[key] || 0;
        return Math.max(max, a, b);
      }, 0);
      daySeries.forEach((d) => {
        const key = formatLocalDate(d);
        const a = total[key] || 0;
        const b = overdue[key] || 0;
        const dateLabel = formatShortDate(d);
        const col = document.createElement("div");
        col.className = "trend-col";
        const bars = document.createElement("div");
        bars.className = "trend-bars";
        const barA = document.createElement("div");
        barA.className = "trend-bar created";
        barA.style.height = maxCount ? `${Math.round((a / maxCount) * 100)}%` : "0%";
        barA.dataset.label = "提醒";
        barA.dataset.value = a;
        barA.dataset.date = dateLabel;
        const barB = document.createElement("div");
        barB.className = "trend-bar completed";
        barB.style.height = maxCount ? `${Math.round((b / maxCount) * 100)}%` : "0%";
        barB.dataset.label = "超时";
        barB.dataset.value = b;
        barB.dataset.date = dateLabel;
        [barA, barB].forEach((bar) => {
          bar.addEventListener("mouseenter", (event) => {
            showChartTooltip(event, bar.dataset.label, bar.dataset.value, bar.dataset.date);
          });
          bar.addEventListener("mousemove", (event) => {
            showChartTooltip(event, bar.dataset.label, bar.dataset.value, bar.dataset.date);
          });
          bar.addEventListener("mouseleave", hideChartTooltip);
        });
        bars.appendChild(barA);
        bars.appendChild(barB);
        const label = document.createElement("div");
        label.className = "trend-label";
        label.textContent = dateLabel;
        col.appendChild(bars);
        col.appendChild(label);
        elements.trendChart.appendChild(col);
      });
    }
  } catch (error) {
    return;
  }
};

const buildCsvSection = (title, rows, headers) => {
  const lines = [];
  lines.push(title);
  lines.push(headers.join(","));
  rows.forEach((row) => {
    lines.push(headers.map((key) => `"${String(row[key] ?? "")}"`).join(","));
  });
  lines.push("");
  return lines.join("\n");
};

const exportStatsCsv = async () => {
  const days = Number(elements.trendRange.value || 7);
  const [reminderRes, taskRes, memberRes, reminderTrendRes] = await Promise.all([
    apiFetch(`/api/stats/reminders?days=${days}`),
    apiFetch(`/api/stats/tasks?days=${days}`),
    apiFetch(`/api/stats/members?days=${days}`),
    apiFetch(`/api/stats/reminders/trend?days=${days}`)
  ]);
  const reminderStats = reminderRes.ok ? await reminderRes.json() : { byType: [], byMember: [], byTask: [] };
  const taskStats = taskRes.ok ? await taskRes.json() : { byAction: [], byActor: [] };
  const memberStats = memberRes.ok ? await memberRes.json() : { members: [] };
  const reminderTrend = reminderTrendRes.ok ? await reminderTrendRes.json() : { rows: [] };
  const sections = [];
  sections.push(buildCsvSection("提醒类型统计", reminderStats.byType || [], ["type", "count"]));
  sections.push(buildCsvSection("提醒成员统计", reminderStats.byMember || [], ["memberId", "count"]));
  sections.push(buildCsvSection("提醒任务统计", reminderStats.byTask || [], ["taskId", "count"]));
  sections.push(buildCsvSection("提醒趋势", reminderTrend.rows || [], ["day", "type", "count"]));
  sections.push(buildCsvSection("任务行为统计", taskStats.byAction || [], ["action", "count"]));
  sections.push(buildCsvSection("任务成员统计", taskStats.byActor || [], ["actorId", "count"]));
  sections.push(buildCsvSection("成员完成率", memberStats.members || [], ["memberId", "name", "totalAssigned", "completed", "completionRate"]));
  const csv = sections.join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `stats_${days}d.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const renderCalendar = () => {
  const view = elements.calendarView.value;
  const visibleTasks = getVisibleTasks();
  const counts = {};
  visibleTasks.forEach((task) => {
    if (!task.dueAt) {
      return;
    }
    const key = formatLocalDate(task.dueAt);
    if (!key) {
      return;
    }
    counts[key] = (counts[key] || 0) + 1;
  });
  elements.calendarGrid.innerHTML = "";
  if (view === "week") {
    const start = getWeekStart(calendarDate);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    elements.calendarTitle.textContent = `${formatShortDate(start)} - ${formatShortDate(end)}`;
    for (let i = 0; i < 7; i += 1) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      const key = formatLocalDate(day);
      const cell = document.createElement("div");
      cell.className = "calendar-cell";
      cell.innerHTML = `
        <div class="calendar-date">${day.getDate()}</div>
        <div class="calendar-count">任务 ${counts[key] || 0}</div>
      `;
      elements.calendarGrid.appendChild(cell);
    }
    return;
  }
  const monthStart = new Date(calendarDate.getFullYear(), calendarDate.getMonth(), 1);
  elements.calendarTitle.textContent = `${monthStart.getFullYear()}年${String(monthStart.getMonth() + 1).padStart(2, "0")}月`;
  const gridStart = getMonthGridStart(calendarDate);
  const gridEnd = getMonthGridEnd(calendarDate);
  const totalDays = Math.round((gridEnd - gridStart) / 86400000) + 1;
  for (let i = 0; i < totalDays; i += 1) {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + i);
    const key = formatLocalDate(day);
    const outside = day.getMonth() !== calendarDate.getMonth();
    const cell = document.createElement("div");
    cell.className = outside ? "calendar-cell outside" : "calendar-cell";
    cell.innerHTML = `
      <div class="calendar-date">${day.getDate()}</div>
      <div class="calendar-count">任务 ${counts[key] || 0}</div>
    `;
    elements.calendarGrid.appendChild(cell);
  }
};

const canViewFullState = (task, currentId) =>
  task.owners.includes(currentId) || task.createdBy === currentId;

const renderTasks = () => {
  const filter = elements.statusFilter.value;
  const ownerFilter = elements.ownerFilter.value;
  const dueFilter = elements.dueDateFilter.value;
  const currentId = ensureValidCurrentUser();
  let tasks = state.tasks;
  if (filter === "trash") {
    tasks = tasks.filter((t) => t.deletedAt);
  } else if (filter === "archived") {
    tasks = tasks.filter((t) => t.archivedAt && !t.deletedAt);
  } else {
    tasks = tasks.filter((t) => !t.deletedAt && !t.archivedAt);
  }
  if (filter === "active") {
    tasks = tasks.filter((t) => ["已指派", "已接受", "进行中"].includes(t.state));
  }
  if (filter === "pending") {
    tasks = tasks.filter((t) => t.state === "待确认");
  }
  if (filter === "done") {
    tasks = tasks.filter((t) => t.state === "已完成");
  }
  if (ownerFilter && ownerFilter !== "all") {
    tasks = tasks.filter((t) => t.owners.includes(ownerFilter));
  }
  if (dueFilter) {
    tasks = tasks.filter((t) => {
      if (!t.dueAt) {
        return false;
      }
      return formatLocalDate(t.dueAt) === dueFilter;
    });
  }

  elements.taskList.innerHTML = "";
  const tooltipMap = {
    pending: "等待发起人确认完成的任务",
    active: "已指派并正在处理的任务",
    done: "已确认完成的任务",
    archived: "已归档但可恢复的任务",
    trash: "已删除但可恢复的任务"
  };
  const groups = filter === "trash"
    ? [{ key: "trash", title: "回收站", states: [] }]
    : filter === "archived"
      ? [{ key: "archived", title: "已归档任务", states: [] }]
      : [
        { key: "pending", title: "待确认任务", states: ["待确认"] },
        { key: "active", title: "进行中任务", states: ["已指派", "已接受", "进行中"] },
        { key: "done", title: "已完成任务", states: ["已完成"] }
      ];

  groups.forEach((group) => {
    const groupTasks = tasks
      .filter((t) => (group.states.length ? group.states.includes(t.state) : true))
      .sort((a, b) => {
        const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
        const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
        if (aDue !== bDue) {
          return aDue - bDue;
        }
        const aUpdated = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const bUpdated = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return bUpdated - aUpdated;
      });
    const groupCard = document.createElement("div");
    groupCard.className = "task-group";
    const header = document.createElement("div");
    header.className = "task-group-title";
    header.innerHTML = `
      <span>${group.title}</span>
      <span class="hint-dot" data-tip="${tooltipMap[group.key] || ""}">?</span>
    `;
    const list = document.createElement("div");
    list.className = "task-group-list";
    groupCard.appendChild(header);
    groupCard.appendChild(list);
    if (!groupTasks.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "暂无任务";
      list.appendChild(empty);
      elements.taskList.appendChild(groupCard);
      return;
    }
    groupTasks.forEach((task) => {
      const card = document.createElement("div");
      card.className = "task-card";
      const ownerNames = task.owners.map(getMemberName).join("、");
      const displayState = canViewFullState(task, currentId)
        ? task.state
        : task.state === "已完成"
          ? "已完成"
          : "进行中";
      card.innerHTML = `
      <div class="task-top">
        <div>
          <div class="task-title">${task.content}</div>
          <div class="task-meta">
            <span>Owner：${ownerNames}</span>
            <span>截止：${formatDateTime(task.dueAt)}</span>
            <span>重复：${formatRepeat(task.repeat)}</span>
            <span>发起：${getMemberName(task.createdBy)}</span>
          </div>
        </div>
        <span class="status-badge">${displayState}</span>
      </div>
      <div class="task-actions" data-task-id="${task.id}">
      </div>
    `;
      const subtasks = task.subtasks || [];
      if (subtasks.length && canViewFullState(task, currentId)) {
        const subtaskList = document.createElement("div");
        subtaskList.className = "subtask-list";
        subtasks.forEach((subtask) => {
          const item = document.createElement("div");
          item.className = "subtask-item";
          const left = document.createElement("div");
          left.className = "subtask-left";
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = Boolean(subtask.done);
          checkbox.dataset.subtaskId = subtask.id;
          checkbox.dataset.taskId = task.id;
          const text = document.createElement("span");
          text.className = subtask.done ? "subtask-text done" : "subtask-text";
          text.textContent = subtask.content;
          left.appendChild(checkbox);
          left.appendChild(text);
          const deleteBtn = document.createElement("button");
          deleteBtn.textContent = "删除";
          deleteBtn.dataset.subtaskAction = "delete";
          deleteBtn.dataset.subtaskId = subtask.id;
          deleteBtn.dataset.taskId = task.id;
          item.appendChild(left);
          item.appendChild(deleteBtn);
          subtaskList.appendChild(item);
        });
        card.appendChild(subtaskList);
      }
      const actions = card.querySelector(".task-actions");
      const isOwner = task.owners.includes(currentId);
      const isCreator = task.createdBy === currentId;

      if (filter === "trash") {
        if (isOwner || isCreator) {
          actions.appendChild(createActionButton("恢复", "restore"));
          actions.appendChild(createActionButton("彻底删除", "purge"));
        }
      } else if (filter === "archived") {
        if (isOwner || isCreator) {
          actions.appendChild(createActionButton("取消归档", "unarchive"));
        }
      } else {
      if (isOwner && task.state === "已指派") {
        actions.appendChild(createActionButton("接受", "accept"));
      }
      if (isOwner && task.state === "已接受") {
        actions.appendChild(createActionButton("开始", "start"));
      }
      if (isOwner && (task.state === "已接受" || task.state === "进行中")) {
        actions.appendChild(createActionButton("标记完成", "complete"));
      }
      if (isCreator && task.state === "待确认") {
        actions.appendChild(createActionButton("确认完成", "confirm"));
      }
      if (isOwner || isCreator) {
        actions.appendChild(createActionButton("编辑内容", "edit"));
        actions.appendChild(createActionButton("评论", "comment"));
        actions.appendChild(createActionButton("添加子任务", "subtask_add"));
        if (task.state === "已完成") {
          actions.appendChild(createActionButton("归档", "archive"));
        }
        actions.appendChild(createActionButton("删除任务", "delete"));
      }
      if (!actions.children.length) {
        const hint = document.createElement("span");
        hint.className = "hint";
        hint.textContent = canViewFullState(task, currentId)
          ? "暂无可操作项"
          : "仅 Owner 可操作";
        actions.appendChild(hint);
      }
      }

      list.appendChild(card);
    });
    elements.taskList.appendChild(groupCard);
  });
};

const createActionButton = (label, action) => {
  const button = document.createElement("button");
  button.textContent = label;
  button.dataset.action = action;
  return button;
};

const renderReminders = () => {
  elements.reminderList.innerHTML = "";
  if (!state.reminders.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无提醒";
    elements.reminderList.appendChild(empty);
    return;
  }
  state.reminders.forEach((reminder) => {
    const task = state.tasks.find((t) => t.id === reminder.taskId);
    if (!task) {
      return;
    }
    const card = document.createElement("div");
    card.className = "reminder-card";
    card.dataset.reminderId = reminder.id;
    const typeLabel = reminder.type === "remind24h"
      ? "T-24h 轻提醒"
      : reminder.type === "remind2h"
        ? "T-2h 强提醒"
        : reminder.type === "mention"
          ? "评论@提醒"
          : "超时提醒";
    card.innerHTML = `
      <div class="reminder-title">${typeLabel}</div>
      <div>${task.content}</div>
      ${reminder.type === "mention" ? `<div class="task-meta">来自：${getMemberName(reminder.authorId)}</div>` : ""}
      ${reminder.type === "mention" ? `<div>${reminder.content || ""}</div>` : ""}
      <div class="task-meta">截止：${formatDateTime(task.dueAt)}</div>
      <div class="reminder-actions" data-task-id="${task.id}">
      </div>
    `;
    const actions = card.querySelector(".reminder-actions");
    actions.appendChild(createReminderButton("知道了", "dismiss"));
    if (reminder.type === "overdue") {
      actions.appendChild(createReminderButton("稍后1小时", "snooze"));
      actions.appendChild(createReminderButton("我已完成", "complete"));
    }
    elements.reminderList.appendChild(card);
  });
};

const createReminderButton = (label, action) => {
  const button = document.createElement("button");
  button.textContent = label;
  button.dataset.reminderAction = action;
  return button;
};

const renderAll = () => {
  renderMembers();
  renderCompletion();
  renderDashboard();
  renderTasks();
  renderCalendar();
  renderReminders();
};

const connectSSE = (memberId) => {
  if (eventSource) {
    eventSource.close();
  }
  if (sseRetryTimer) {
    clearTimeout(sseRetryTimer);
    sseRetryTimer = null;
  }
  if (!memberId) {
    return;
  }
  eventSource = new EventSource(apiUrl(`/events?memberId=${memberId}`));
  eventSource.addEventListener("state_update", (event) => {
    const data = JSON.parse(event.data);
    state.members = data.members || [];
    state.tasks = data.tasks || [];
    renderAll();
  });
  eventSource.addEventListener("reminder", (event) => {
    const payload = JSON.parse(event.data);
    state.reminders.unshift({
      taskId: payload.taskId,
      type: payload.type,
      id: `${payload.taskId}-${payload.type}-${Date.now()}`
    });
    renderReminders();
  });
  eventSource.addEventListener("mention", (event) => {
    const payload = JSON.parse(event.data);
    state.reminders.unshift({
      taskId: payload.taskId,
      commentId: payload.commentId,
      authorId: payload.authorId,
      content: payload.content,
      type: "mention",
      id: `${payload.taskId}-mention-${Date.now()}`
    });
    renderReminders();
  });
  eventSource.onerror = () => {
    if (eventSource) {
      eventSource.close();
    }
    sseRetryTimer = setTimeout(() => connectSSE(memberId), 2000);
  };
};

const closeSSE = () => {
  if (sseRetryTimer) {
    clearTimeout(sseRetryTimer);
    sseRetryTimer = null;
  }
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
};

const loadState = async () => {
  const res = await apiFetch("/api/state");
  const data = await res.json();
  state.members = data.members || [];
  state.tasks = data.tasks || [];
  if (!getCurrentUserId() && state.members.length) {
    setCurrentUserId(state.members[0].id);
  }
  renderAll();
  connectSSE(ensureValidCurrentUser());
  loadWeChatStatus();
};

const loadWeChatStatus = async () => {
  try {
    const res = await apiFetch("/api/wechat/status");
    if (!res.ok) {
      return;
    }
    const data = await res.json();
    wechatEnabled = Boolean(data.enabled);
    renderMembers();
  } catch (error) {
    return;
  }
};

const openTaskCreateModal = () => {
  const currentId = ensureValidCurrentUser();
  if (!currentId) {
    return;
  }
  elements.modalTitle.textContent = "新建任务";
  elements.modalBody.innerHTML = `
    <div class="modal-field">
      <div class="modal-label">任务内容</div>
      <input class="modal-input" id="modalCreateContent" type="text" />
    </div>
    <div class="modal-field">
      <div class="modal-label">截止时间</div>
      <input class="modal-input" id="modalCreateDueAt" type="datetime-local" />
    </div>
    <div class="modal-field">
      <div class="modal-label">重复频率</div>
      <select class="modal-input" id="modalCreateRepeat">
        <option value="none">不重复</option>
        <option value="daily">每天</option>
        <option value="weekly">每周</option>
        <option value="monthly">每月</option>
      </select>
    </div>
    <div class="modal-field">
      <div class="modal-label">责任人</div>
      <div id="modalCreateOwners" class="chip-list modal-owners"></div>
    </div>
    <label class="checkbox modal-checkbox">
      <input id="modalCreateRequireConfirm" type="checkbox" />
      完成需确认
    </label>
    <div id="modalCreateHint" class="hint"></div>
  `;
  const contentInput = elements.modalBody.querySelector("#modalCreateContent");
  const dueAtInput = elements.modalBody.querySelector("#modalCreateDueAt");
  const repeatInput = elements.modalBody.querySelector("#modalCreateRepeat");
  const ownersContainer = elements.modalBody.querySelector("#modalCreateOwners");
  const confirmInput = elements.modalBody.querySelector("#modalCreateRequireConfirm");
  const hintNode = elements.modalBody.querySelector("#modalCreateHint");
  ownersContainer.innerHTML = "";
  state.members.forEach((member) => {
    const label = document.createElement("label");
    label.className = "chip";
    const checked = member.id === currentId ? "checked" : "";
    label.innerHTML = `<input type="checkbox" value="${member.id}" ${checked} />${member.name}`;
    ownersContainer.appendChild(label);
  });
  contentInput.addEventListener("input", () => {
    const { owners, dueAt, hint } = parseTriage(contentInput.value);
    if (!dueAtInput.value && dueAt) {
      dueAtInput.value = dueAt.slice(0, 16);
    }
    if (owners.length) {
      const checkboxes = ownersContainer.querySelectorAll("input[type='checkbox']");
      checkboxes.forEach((checkbox) => {
        if (owners.includes(checkbox.value)) {
          checkbox.checked = true;
        }
      });
    }
    hintNode.textContent = hint;
  });
  elements.modalOverlay.classList.remove("hidden");
  elements.modalConfirm.textContent = "创建";
  elements.modalConfirm.onclick = async () => {
    const nextContent = contentInput.value.trim();
    if (!nextContent) {
      return;
    }
    const owners = Array.from(
      ownersContainer.querySelectorAll("input[type='checkbox']")
    )
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => checkbox.value);
    const dueAt = dueAtInput.value ? new Date(dueAtInput.value).toISOString() : null;
    const repeat = repeatInput.value || "none";
    const requireConfirm = confirmInput.checked;
    closeModal();
    await createTask({ content: nextContent, owners, dueAt, repeat, requireConfirm });
  };
  setTimeout(() => contentInput.focus(), 0);
};

const refreshState = async () => {
  const res = await apiFetch("/api/state");
  if (!res.ok) {
    return;
  }
  const data = await res.json();
  state.members = data.members || [];
  state.tasks = data.tasks || [];
  renderAll();
};

const createTask = async ({ content, owners, dueAt, repeat, requireConfirm }) => {
  const createdBy = ensureValidCurrentUser();
  if (!createdBy) {
    return;
  }
  const res = await apiFetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, owners, dueAt, repeat, requireConfirm, createdBy })
  });
  if (!res.ok) {
    return;
  }
  const task = await res.json();
  state.tasks.unshift(task);
  renderAll();
};

const applyTaskUpdate = (task) => {
  const index = state.tasks.findIndex((item) => item.id === task.id);
  if (index >= 0) {
    state.tasks[index] = task;
  } else {
    state.tasks.unshift(task);
  }
  renderAll();
};

const updateTaskAction = async (taskId, action) => {
  const actorId = ensureValidCurrentUser();
  if (!actorId) {
    return;
  }
  const res = await apiFetch(`/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, actorId })
  });
  if (!res.ok) {
    return;
  }
  const task = await res.json();
  applyTaskUpdate(task);
};

const updateTaskDetails = async (taskId, payload) => {
  const actorId = ensureValidCurrentUser();
  if (!actorId) {
    return;
  }
  const res = await apiFetch(`/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update", actorId, ...payload })
  });
  if (!res.ok) {
    return;
  }
  const task = await res.json();
  applyTaskUpdate(task);
};

const deleteTask = async (taskId) => {
  const actorId = ensureValidCurrentUser();
  if (!actorId) {
    return;
  }
  const res = await apiFetch(`/api/tasks/${taskId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actorId })
  });
  if (!res.ok) {
    return;
  }
  await refreshState();
};

const updateSubtask = async (taskId, action, payload) => {
  const actorId = ensureValidCurrentUser();
  if (!actorId) {
    return;
  }
  const res = await apiFetch(`/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, actorId, ...payload })
  });
  if (!res.ok) {
    return;
  }
  const task = await res.json();
  applyTaskUpdate(task);
};

const updateComment = async (taskId, content) => {
  const actorId = ensureValidCurrentUser();
  if (!actorId) {
    return;
  }
  const res = await apiFetch(`/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "comment", actorId, content })
  });
  if (!res.ok) {
    return;
  }
  const task = await res.json();
  applyTaskUpdate(task);
};

const snoozeTask = async (taskId) => {
  const actorId = ensureValidCurrentUser();
  if (!actorId) {
    return;
  }
  const res = await apiFetch(`/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "snooze", actorId, minutes: 60 })
  });
  if (!res.ok) {
    return;
  }
  const task = await res.json();
  applyTaskUpdate(task);
};

const updateReminderSettings = async () => {
  const memberId = ensureValidCurrentUser();
  if (!memberId) {
    return;
  }
  const reminderPrefs = {
    enabled: elements.remindEnabled.checked,
    remind24h: elements.remind24h.checked,
    remind2h: elements.remind2h.checked,
    overdue: elements.remindOverdue.checked
  };
  await apiFetch(`/api/members/${memberId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reminderPrefs })
  });
};

const addMember = async () => {
  openEditModal({
    title: "添加成员",
    value: "",
    onConfirm: async (name) => {
      await apiFetch("/api/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
    }
  });
};

const bindWeChat = () => {
  const memberId = ensureValidCurrentUser();
  if (!memberId) {
    return;
  }
  window.location.href = apiUrl(`/api/wechat/bind?memberId=${memberId}`);
};

elements.addMemberBtn.addEventListener("click", addMember);
elements.bindWeChatBtn.addEventListener("click", bindWeChat);
elements.openCreateTask.addEventListener("click", openTaskCreateModal);
elements.statusFilter.addEventListener("change", renderTasks);
elements.ownerFilter.addEventListener("change", renderTasks);
elements.dueDateFilter.addEventListener("change", renderTasks);
elements.trendRange.addEventListener("change", renderDashboard);
elements.trendType.addEventListener("change", renderDashboard);
elements.exportStatsBtn.addEventListener("click", exportStatsCsv);
elements.calendarView.addEventListener("change", renderCalendar);
elements.calendarPrev.addEventListener("click", () => {
  if (elements.calendarView.value === "week") {
    calendarDate.setDate(calendarDate.getDate() - 7);
  } else {
    calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1, 1);
  }
  renderCalendar();
});
elements.calendarNext.addEventListener("click", () => {
  if (elements.calendarView.value === "week") {
    calendarDate.setDate(calendarDate.getDate() + 7);
  } else {
    calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 1);
  }
  renderCalendar();
});
elements.currentUserSelect.addEventListener("change", (event) => {
  setCurrentUserId(event.target.value);
  state.reminders = [];
  connectSSE(ensureValidCurrentUser());
  renderAll();
});

elements.remindEnabled.addEventListener("change", updateReminderSettings);
elements.remind24h.addEventListener("change", updateReminderSettings);
elements.remind2h.addEventListener("change", updateReminderSettings);
elements.remindOverdue.addEventListener("change", updateReminderSettings);

elements.taskList.addEventListener("click", (event) => {
  if (event.target.dataset.subtaskId) {
    const taskId = event.target.dataset.taskId;
    const subtaskId = event.target.dataset.subtaskId;
    if (!taskId) {
      return;
    }
    if (event.target.dataset.subtaskAction === "delete") {
      updateSubtask(taskId, "subtask_delete", { subtaskId });
      return;
    }
    if (event.target.matches("input[type='checkbox']")) {
      updateSubtask(taskId, "subtask_toggle", { subtaskId });
      return;
    }
  }
  const action = event.target.dataset.action;
  if (!action) {
    return;
  }
  const taskId = event.target.closest(".task-actions")?.dataset.taskId;
  if (!taskId) {
    return;
  }
  if (action === "edit") {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) {
      return;
    }
    openTaskEditModal({
      task,
      onConfirm: (payload) => updateTaskDetails(taskId, payload)
    });
    return;
  }
  if (action === "delete") {
    openConfirmModal({
      title: "删除任务",
      message: "确认删除该任务吗？",
      onConfirm: () => deleteTask(taskId)
    });
    return;
  }
  if (action === "comment") {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) {
      return;
    }
    openCommentModal({
      task,
      onConfirm: (content) => updateComment(taskId, content)
    });
    return;
  }
  if (action === "subtask_add") {
    openEditModal({
      title: "新增子任务",
      value: "",
      confirmLabel: "添加",
      onConfirm: (content) => updateSubtask(taskId, "subtask_add", { content })
    });
    return;
  }
  if (action === "archive") {
    updateTaskAction(taskId, "archive");
    return;
  }
  if (action === "unarchive") {
    updateTaskAction(taskId, "unarchive");
    return;
  }
  if (action === "restore") {
    updateTaskAction(taskId, "restore");
    return;
  }
  if (action === "purge") {
    openConfirmModal({
      title: "彻底删除",
      message: "该操作无法恢复，确认继续吗？",
      confirmLabel: "彻底删除",
      onConfirm: () => updateTaskAction(taskId, "purge")
    });
    return;
  }
  updateTaskAction(taskId, action);
});

elements.reminderList.addEventListener("click", (event) => {
  const action = event.target.dataset.reminderAction;
  if (!action) {
    return;
  }
  const taskId = event.target.closest(".reminder-actions")?.dataset.taskId;
  const reminderId = event.target.closest(".reminder-card")?.dataset.reminderId;
  if (!taskId) {
    return;
  }
  if (action === "dismiss") {
    if (reminderId) {
      state.reminders = state.reminders.filter((item) => item.id !== reminderId);
    }
    renderReminders();
    return;
  }
  if (action === "snooze") {
    snoozeTask(taskId);
  }
  if (action === "complete") {
    updateTaskAction(taskId, "complete");
  }
  state.reminders = state.reminders.filter((item) => item.taskId !== taskId);
  renderReminders();
});

elements.modalCancel.addEventListener("click", closeModal);
elements.modalOverlay.addEventListener("click", (event) => {
  if (event.target === elements.modalOverlay) {
    closeModal();
  }
});
window.addEventListener("beforeunload", closeSSE);
window.addEventListener("pagehide", closeSSE);

elements.authConfirm.addEventListener("click", () => {
  const input = elements.authPassword.value.trim();
  if (input !== ACCESS_PASSWORD) {
    elements.authError.textContent = "密码不正确";
    return;
  }
  localStorage.setItem(AUTH_STORAGE_KEY, "true");
  enterApp();
});
elements.authPassword.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    elements.authConfirm.click();
  }
});
elements.logoutBtn.addEventListener("click", () => {
  localStorage.removeItem(AUTH_STORAGE_KEY);
  showAuth();
});

if (isAuthorized()) {
  enterApp();
} else {
  showAuth();
}
