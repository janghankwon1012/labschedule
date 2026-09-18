/* ============================================================================
 * 화면 로직. 데이터는 전부 window.api (api.js) 를 통해서만 주고받습니다.
 * ========================================================================== */
(function () {
  "use strict";

  const cfg = window.LABSCHED_CONFIG;
  const api = window.api;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // 초대/재설정 메일 링크로 들어왔는지 (supabase 가 URL 을 정리하기 전에 먼저 읽어둔다)
  const urlAuthType = (location.hash.match(/[#&]type=(\w+)/) || [])[1] || "";
  const needsSetPassword = urlAuthType === "invite" || urlAuthType === "recovery";

  const state = {
    session: null,
    profile: null,
    equipment: [],
    access: [],       // equipment_access rows
    profiles: [],     // 관리자만 전체, 일반 사용자도 이름 표시용으로 전체 조회 가능
    calendar: null,
    entered: false,
    unsubscribe: null,
  };

  // ------------------------------------------------------------------ 유틸
  const pad = (n) => String(n).padStart(2, "0");
  const DOW = "일월화수목금토";
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function toLocalInput(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fromLocalInput(s) {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }
  function roundToSlot(d) {
    const m = cfg.SLOT_MINUTES || 30;
    const r = new Date(d);
    r.setSeconds(0, 0);
    r.setMinutes(r.getMinutes() - (r.getMinutes() % m));
    return r;
  }
  function fmtTime(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function fmtDate(d) { return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} (${DOW[d.getDay()]})`; }
  function fmtRange(s, e) {
    const S = new Date(s), E = new Date(e);
    const same = S.toDateString() === E.toDateString();
    return same
      ? `${fmtDate(S)} ${fmtTime(S)} – ${fmtTime(E)}`
      : `${fmtDate(S)} ${fmtTime(S)} – ${pad(E.getMonth() + 1)}.${pad(E.getDate())} ${fmtTime(E)}`;
  }
  function hoursBetween(s, e) { return Math.round(((new Date(e) - new Date(s)) / 36e5) * 100) / 100; }

  let toastTimer;
  function toast(msg, isError) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.toggle("error", !!isError);
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 5000 : 3000);
  }

  function myId() { return state.session?.user?.id; }
  function isAdmin() { return !!state.profile?.is_admin; }
  function canEdit(r) {
    if (isAdmin()) return true;
    return r.user_id === myId() && new Date(r.end_at) > new Date();
  }
  function nameOf(userId) {
    const p = state.profiles.find((x) => x.id === userId);
    return p ? p.display_name || p.email : "";
  }
  function equipmentById(id) { return state.equipment.find((e) => e.id === id); }
  function userCanBook(eq) {
    if (isAdmin()) return true;
    if (!eq.is_active) return false;
    const rows = state.access.filter((a) => a.equipment_id === eq.id);
    return rows.length === 0 || rows.some((a) => a.user_id === myId());
  }

  // ------------------------------------------------------------------ 뷰 전환
  const VIEWS = ["login", "setpw", "calendar", "my", "stats", "admin"];
  function showView(name) {
    if (name === "admin" && !isAdmin()) name = "calendar";
    VIEWS.forEach((v) => ($(`#view-${v}`).hidden = v !== name));
    $$("#topbar nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === name));
    if (name === "calendar" && state.calendar) setTimeout(() => state.calendar.updateSize(), 0);
    if (name === "my") renderMy();
    if (name === "stats") renderStats();
    if (name === "admin") renderAdmin();
  }
  function route() {
    if (!state.entered) return;
    const name = (location.hash || "#calendar").slice(1).split("?")[0];
    showView(["calendar", "my", "stats", "admin"].includes(name) ? name : "calendar");
  }
  window.addEventListener("hashchange", route);

  function showLogin() {
    $("#topbar").hidden = true;
    showView("login");
    $("#login-email").focus();
  }
  function showSetPw() {
    $("#topbar").hidden = true;
    showView("setpw");
    if (state.profile?.display_name) $("#setpw-name").value = state.profile.display_name;
  }

  // ------------------------------------------------------------------ 모달
  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }
  $$(".modal-backdrop").forEach((bd) => {
    bd.addEventListener("click", (e) => { if (e.target === bd) bd.hidden = true; });
    bd.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => (bd.hidden = true)));
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $$(".modal-backdrop").forEach((m) => (m.hidden = true)); });

  // ------------------------------------------------------------------ 인증
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#login-error");
    err.textContent = "";
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await api.signIn($("#login-email").value.trim(), $("#login-password").value);
      // 이후 흐름은 onAuthStateChange 가 이어받는다
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
    }
  });

  $("#link-forgot").addEventListener("click", async (e) => {
    e.preventDefault();
    const email = $("#login-email").value.trim();
    const err = $("#login-error");
    if (!email) { err.textContent = "이메일을 먼저 입력하고 다시 눌러 주세요."; return; }
    try {
      await api.resetPassword(email);
      err.textContent = "";
      toast("비밀번호 재설정 메일을 보냈습니다. 메일함을 확인하세요.");
    } catch (ex) {
      err.textContent = ex.message;
    }
  });

  $("#setpw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#setpw-error");
    err.textContent = "";
    const p1 = $("#setpw-1").value, p2 = $("#setpw-2").value, name = $("#setpw-name").value.trim();
    if (p1.length < 8) { err.textContent = "비밀번호는 8자 이상이어야 합니다."; return; }
    if (p1 !== p2) { err.textContent = "두 비밀번호가 서로 다릅니다."; return; }
    try {
      await api.updatePassword(p1);
      if (name) await api.updateMyName(name);
      history.replaceState(null, "", location.pathname + "#calendar");
      toast("비밀번호를 저장했습니다.");
      await enterApp();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });

  $("#btn-logout").addEventListener("click", async () => {
    await api.signOut();
    location.hash = "";
  });

  // 이름 변경
  $("#btn-profile").addEventListener("click", () => {
    $("#profile-name").value = state.profile?.display_name || "";
    $("#profile-pw").value = "";
    $("#profile-error").textContent = "";
    openModal("#modal-profile");
  });
  $("#profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#profile-error");
    err.textContent = "";
    const name = $("#profile-name").value.trim();
    const pw = $("#profile-pw").value;
    if (!name) { err.textContent = "이름을 입력하세요."; return; }
    if (pw && pw.length < 8) { err.textContent = "비밀번호는 8자 이상이어야 합니다."; return; }
    try {
      await api.updateMyName(name);
      if (pw) await api.updatePassword(pw);
      state.profile = await api.getMyProfile();
      state.profiles = await api.listProfiles();
      $("#btn-profile").textContent = state.profile.display_name;
      closeModal("#modal-profile");
      state.calendar?.refetchEvents();
      toast(pw ? "이름과 비밀번호를 저장했습니다." : "이름을 저장했습니다.");
    } catch (ex) {
      err.textContent = ex.message;
    }
  });

  // ------------------------------------------------------------------ 앱 진입
  async function loadBaseData() {
    const [profile, equipment, access, profiles] = await Promise.all([
      api.getMyProfile(), api.listEquipment(), api.listEquipmentAccess(), api.listProfiles(),
    ]);
    state.profile = profile;
    state.equipment = equipment;
    state.access = access;
    state.profiles = profiles;
  }

  async function enterApp() {
    try {
      await loadBaseData();
    } catch (ex) {
      toast(ex.message, true);
      return;
    }
    state.entered = true;
    $("#topbar").hidden = false;
    $("#lab-name").textContent = cfg.LAB_NAME || "실험실 장비 예약";
    document.title = cfg.LAB_NAME || "실험실 장비 예약";
    $("#btn-profile").textContent = state.profile?.display_name || state.session.user.email;
    $("#nav-admin").hidden = !isAdmin();
    renderLegend();
    initCalendar();
    if (!state.unsubscribe) {
      let t;
      state.unsubscribe = api.subscribeReservations(() => {
        clearTimeout(t);
        t = setTimeout(() => state.calendar?.refetchEvents(), 400);
      });
    }
    route();
  }

  // ------------------------------------------------------------------ 캘린더
  const LEGEND_KEY = "labsched.legend";
  function selectedEquipmentIds() {
    return $$("#legend input:checked").map((c) => c.dataset.id);
  }
  function renderLegend() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LEGEND_KEY) || "null"); } catch (e) { saved = null; }
    const ul = $("#legend");
    if (!state.equipment.length) {
      ul.innerHTML = `<li class="muted small">등록된 장비가 없습니다.${isAdmin() ? ' <a href="#admin">장비 추가</a>' : " 관리자에게 요청하세요."}</li>`;
      return;
    }
    ul.innerHTML = state.equipment.map((eq) => `
      <li>
        <input type="checkbox" id="eq-${eq.id}" data-id="${eq.id}" ${!saved || saved.includes(eq.id) ? "checked" : ""}>
        <span class="swatch" style="background:${esc(eq.color)}"></span>
        <label for="eq-${eq.id}" class="${eq.is_active ? "" : "inactive"}" title="${esc(eq.location)}">${esc(eq.name)}</label>
      </li>`).join("");
    ul.querySelectorAll("input").forEach((cb) => cb.addEventListener("change", () => {
      try { localStorage.setItem(LEGEND_KEY, JSON.stringify(selectedEquipmentIds())); } catch (e) {}
      state.calendar?.refetchEvents();
    }));
  }
  $("#toggle-all").addEventListener("click", (e) => {
    e.preventDefault();
    const boxes = $$("#legend input");
    const allOn = boxes.every((b) => b.checked);
    boxes.forEach((b) => (b.checked = !allOn));
    try { localStorage.setItem(LEGEND_KEY, JSON.stringify(selectedEquipmentIds())); } catch (err) {}
    state.calendar?.refetchEvents();
  });

  function toEvent(r) {
    return {
      id: r.id,
      title: `${r.equipment_name} · ${r.user_name}`,
      start: r.start_at,
      end: r.end_at,
      color: r.equipment_color,
      editable: canEdit(r),
      classNames: r.user_id === myId() ? ["mine"] : [],
      extendedProps: { ...r, mine: r.user_id === myId() },
    };
  }

  function initCalendar() {
    if (state.calendar) { state.calendar.refetchEvents(); return; }
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem("labsched.view") || "{}"); } catch (e) { saved = {}; }
    const slot = `00:${pad(cfg.SLOT_MINUTES || 30)}:00`;

    const cal = new FullCalendar.Calendar($("#calendar"), {
      locale: "ko",
      timeZone: "local",
      initialView: saved.view || "timeGridWeek",
      initialDate: saved.date || undefined,
      headerToolbar: { left: "prev,next today", center: "title", right: "timeGridDay,timeGridWeek,dayGridMonth,listWeek" },
      height: "auto",
      nowIndicator: true,
      slotDuration: slot,
      snapDuration: slot,
      slotMinTime: cfg.DAY_START || "07:00:00",
      slotMaxTime: cfg.DAY_END || "24:00:00",
      scrollTime: "09:00:00",
      allDaySlot: false,
      firstDay: 1,
      selectable: true,
      selectMirror: true,
      editable: true,
      eventOverlap: (still, moving) => still.extendedProps.equipment_id !== moving.extendedProps.equipment_id,

      events: (info, success, failure) => {
        api.listReservations(info.start.toISOString(), info.end.toISOString())
          .then((rows) => {
            const sel = new Set(selectedEquipmentIds());
            success(rows.filter((r) => sel.has(r.equipment_id)).map(toEvent));
          })
          .catch((ex) => { toast(ex.message, true); failure(ex); });
      },

      select: (info) => {
        const sel = selectedEquipmentIds();
        openReservationModal({ start: info.start, end: info.end, equipment_id: sel.length === 1 ? sel[0] : null });
        cal.unselect();
      },
      eventClick: (info) => {
        info.jsEvent.preventDefault();
        openDetail(info.event.extendedProps);
      },
      eventDrop: (info) => moveEvent(info),
      eventResize: (info) => moveEvent(info),
      eventDidMount: (info) => {
        const p = info.event.extendedProps;
        info.el.title = `${p.equipment_name}\n${p.user_name}${p.purpose ? "\n" + p.purpose : ""}`;
      },
      datesSet: (info) => {
        try { localStorage.setItem("labsched.view", JSON.stringify({ view: info.view.type, date: info.view.currentStart.toISOString() })); } catch (e) {}
      },
    });
    cal.render();
    state.calendar = cal;
  }

  async function moveEvent(info) {
    const r = info.event.extendedProps;
    const start = info.event.start.toISOString();
    const end = info.event.end.toISOString();
    try {
      const conflict = await api.findConflict(r.equipment_id, start, end, r.id);
      if (conflict) throw new Error(conflictMessage(conflict));
      await api.updateReservation(r.id, { start_at: start, end_at: end });
      toast("예약 시간을 변경했습니다.");
      state.calendar.refetchEvents();
    } catch (ex) {
      info.revert();
      toast(ex.message, true);
    }
  }

  function conflictMessage(c) {
    return `이미 ${c.user_name} 님이 ${fmtRange(c.start_at, c.end_at)} 에 예약했습니다.`;
  }

  // ------------------------------------------------------------------ 예약 폼
  function fillEquipmentSelect(select, currentId) {
    const list = state.equipment.filter((eq) => userCanBook(eq) || eq.id === currentId);
    select.innerHTML = list.map((eq) =>
      `<option value="${eq.id}" ${eq.id === currentId ? "selected" : ""}>${esc(eq.name)}${eq.is_active ? "" : " (잠김)"}</option>`).join("");
    if (!list.length) select.innerHTML = `<option value="">예약 가능한 장비가 없습니다</option>`;
  }
  function updateEquipmentHelp() {
    const eq = equipmentById($("#res-equipment").value);
    const parts = [];
    if (eq?.location) parts.push(eq.location);
    if (eq?.max_hours_per_reservation) parts.push(`1회 최대 ${eq.max_hours_per_reservation}시간`);
    if (eq && state.access.some((a) => a.equipment_id === eq.id)) parts.push("사용 허가자만 예약 가능");
    $("#res-equipment-help").textContent = parts.join(" · ");
  }
  $("#res-equipment").addEventListener("change", updateEquipmentHelp);

  // 시작을 바꾸면 종료도 같은 길이만큼 따라간다
  let prevStart = null;
  $("#res-start").addEventListener("change", () => {
    const s = fromLocalInput($("#res-start").value), e = fromLocalInput($("#res-end").value);
    if (prevStart && s && e) $("#res-end").value = toLocalInput(new Date(s.getTime() + (e - prevStart)));
    prevStart = s;
  });

  function openReservationModal(opts) {
    // opts: {id?, start, end, equipment_id?, user_id?, purpose?}
    const isNew = !opts.id;
    $("#res-title").textContent = isNew ? "새 예약" : "예약 수정";
    $("#res-submit").textContent = isNew ? "예약하기" : "저장";
    $("#res-id").value = opts.id || "";
    $("#res-error").textContent = "";

    let start = opts.start ? new Date(opts.start) : roundToSlot(new Date(Date.now() + (cfg.SLOT_MINUTES || 30) * 60000));
    let end = opts.end ? new Date(opts.end) : new Date(start.getTime() + 3600000);
    if (end <= start) end = new Date(start.getTime() + 3600000);
    $("#res-start").value = toLocalInput(start);
    $("#res-end").value = toLocalInput(end);
    prevStart = start;
    $("#res-purpose").value = opts.purpose || "";

    fillEquipmentSelect($("#res-equipment"), opts.equipment_id || null);
    updateEquipmentHelp();

    const userRow = $("#res-user-row");
    if (isAdmin()) {
      userRow.hidden = false;
      $("#res-user").innerHTML = state.profiles.map((p) =>
        `<option value="${p.id}" ${(opts.user_id || myId()) === p.id ? "selected" : ""}>${esc(p.display_name || p.email)}</option>`).join("");
    } else {
      userRow.hidden = true;
    }
    openModal("#modal-reservation");
    $("#res-purpose").focus();
  }
  $("#btn-new").addEventListener("click", () => openReservationModal({}));

  $("#res-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#res-error");
    err.textContent = "";
    const id = $("#res-id").value || null;
    const equipment_id = $("#res-equipment").value;
    const start = fromLocalInput($("#res-start").value), end = fromLocalInput($("#res-end").value);
    if (!equipment_id) { err.textContent = "장비를 선택하세요."; return; }
    if (!start || !end) { err.textContent = "시작과 종료 시각을 입력하세요."; return; }
    if (end <= start) { err.textContent = "종료 시각은 시작 시각보다 뒤여야 합니다."; return; }
    const payload = {
      equipment_id,
      user_id: isAdmin() ? $("#res-user").value : myId(),
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      purpose: $("#res-purpose").value.trim(),
    };
    const btn = $("#res-submit");
    btn.disabled = true;
    try {
      const conflict = await api.findConflict(equipment_id, payload.start_at, payload.end_at, id);
      if (conflict) throw new Error(conflictMessage(conflict));
      if (id) await api.updateReservation(id, payload);
      else await api.createReservation(payload);
      closeModal("#modal-reservation");
      state.calendar?.refetchEvents();
      toast(id ? "예약을 수정했습니다." : "예약이 등록되었습니다.");
      if (!$("#view-my").hidden) renderMy();
    } catch (ex) {
      if (ex.code === "23P01") {
        // 저장 직전에 다른 사람이 먼저 잡은 경우: 누가 잡았는지 다시 조회
        const c = await api.findConflict(equipment_id, payload.start_at, payload.end_at, id).catch(() => null);
        err.textContent = c ? conflictMessage(c) : ex.message;
      } else {
        err.textContent = ex.message;
      }
    } finally {
      btn.disabled = false;
    }
  });

  // ------------------------------------------------------------------ 예약 상세
  let detailRow = null;
  function openDetail(r) {
    detailRow = r;
    const eq = equipmentById(r.equipment_id);
    $("#det-title").innerHTML = `<span class="dot" style="background:${esc(r.equipment_color)}"></span>${esc(r.equipment_name)}`;
    const rows = [
      ["시간", `${fmtRange(r.start_at, r.end_at)} <span class="muted">(${hoursBetween(r.start_at, r.end_at)}시간)</span>`],
      ["예약자", esc(r.user_name)],
      r.purpose ? ["목적", esc(r.purpose)] : null,
      eq?.location ? ["위치", esc(eq.location)] : null,
      ["상태", r.status === "booked" ? (new Date(r.end_at) <= new Date() ? "예약됨 <span class='muted'>(종료됨)</span>" : "예약됨") : "취소됨"],
    ].filter(Boolean);
    $("#det-body").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
    $("#det-error").textContent = "";
    const editable = canEdit(r) && r.status === "booked";
    $("#det-edit").hidden = !editable;
    $("#det-cancel").hidden = !editable;
    openModal("#modal-detail");
  }
  $("#det-edit").addEventListener("click", () => {
    closeModal("#modal-detail");
    openReservationModal({ id: detailRow.id, start: detailRow.start_at, end: detailRow.end_at, equipment_id: detailRow.equipment_id, user_id: detailRow.user_id, purpose: detailRow.purpose });
  });
  $("#det-cancel").addEventListener("click", async () => {
    if (!confirm("이 예약을 취소할까요?")) return;
    try {
      await api.cancelReservation(detailRow.id);
      closeModal("#modal-detail");
      state.calendar?.refetchEvents();
      if (!$("#view-my").hidden) renderMy();
      toast("예약을 취소했습니다.");
    } catch (ex) {
      $("#det-error").textContent = ex.message;
    }
  });

  // ------------------------------------------------------------------ 내 예약
  function reservationTable(rows, opts) {
    if (!rows.length) return `<p class="muted">${opts.empty}</p>`;
    return `<table><thead><tr><th>장비</th><th>시간</th><th>목적</th><th>${opts.past ? "상태" : ""}</th></tr></thead><tbody>
      ${rows.map((r) => `
        <tr class="clickable ${r.status !== "booked" ? "dim" : ""}" data-id="${r.id}" style="cursor:pointer">
          <td><span class="dot" style="background:${esc(r.equipment_color)}"></span>${esc(r.equipment_name)}</td>
          <td>${fmtRange(r.start_at, r.end_at)} <span class="muted small">(${hoursBetween(r.start_at, r.end_at)}h)</span></td>
          <td class="muted">${esc(r.purpose)}</td>
          <td>${opts.past ? (r.status === "booked" ? "완료" : "취소됨") : `<button class="btn btn-sm">상세</button>`}</td>
        </tr>`).join("")}
    </tbody></table>`;
  }
  async function renderMy() {
    try {
      const { upcoming, past } = await api.listMyReservations(myId());
      $("#my-upcoming").innerHTML = reservationTable(upcoming, { empty: "예정된 예약이 없습니다." });
      $("#my-past").innerHTML = reservationTable(past, { empty: "지난 예약이 없습니다.", past: true });
      const all = [...upcoming, ...past];
      $$("#view-my tr.clickable").forEach((tr) => tr.addEventListener("click", () => {
        const r = all.find((x) => x.id === tr.dataset.id);
        if (r) openDetail(r);
      }));
    } catch (ex) {
      toast(ex.message, true);
    }
  }

  // ------------------------------------------------------------------ 통계
  $("#stats-days").addEventListener("change", renderStats);
  async function renderStats() {
    const days = parseInt($("#stats-days").value, 10) || 30;
    const now = new Date();
    const since = new Date(now.getTime() - days * 86400000);
    $("#stats-note").textContent = `${fmtDate(since)} 이후 시작된 예약 기준 (취소 제외)`;
    let rows;
    try {
      rows = await api.listReservationsForStats(since.toISOString(), now.toISOString());
    } catch (ex) {
      toast(ex.message, true);
      return;
    }
    const byEq = new Map(), byUser = new Map();
    let totalHours = 0;
    rows.forEach((r) => {
      const h = (new Date(r.end_at) - new Date(r.start_at)) / 36e5;
      totalHours += h;
      const e = byEq.get(r.equipment_id) || { name: r.equipment_name, color: r.equipment_color, hours: 0, count: 0 };
      e.hours += h; e.count += 1; byEq.set(r.equipment_id, e);
      const u = byUser.get(r.user_id) || { name: r.user_name, hours: 0, count: 0 };
      u.hours += h; u.count += 1; byUser.set(r.user_id, u);
    });
    const eqList = [...byEq.values()].sort((a, b) => b.hours - a.hours);
    const userList = [...byUser.values()].sort((a, b) => b.hours - a.hours);
    const r1 = (x) => Math.round(x * 10) / 10;

    $("#stats-tiles").innerHTML = `
      <div class="stat"><div class="num">${rows.length}</div><div class="lbl">예약 건수</div></div>
      <div class="stat"><div class="num">${r1(totalHours)}</div><div class="lbl">총 예약 시간 (h)</div></div>
      <div class="stat"><div class="num">${userList.length}</div><div class="lbl">사용자 수</div></div>`;

    const maxEq = Math.max(...eqList.map((x) => x.hours), 0) || 1;
    $("#stats-equipment").innerHTML = eqList.length ? `<table>
      <thead><tr><th style="width:26%">장비</th><th style="width:40%">예약 시간</th><th>시간 (h)</th><th>건수</th><th title="예약 시간 / 기간 전체 시간">가동률</th></tr></thead>
      <tbody>${eqList.map((x) => `<tr>
        <td><span class="dot" style="background:${esc(x.color)}"></span>${esc(x.name)}</td>
        <td><div class="bar-wrap"><div class="bar" style="width:${Math.round(x.hours / maxEq * 100)}%;background:${esc(x.color)}"></div></div></td>
        <td>${r1(x.hours)}</td><td>${x.count}</td><td>${r1(x.hours / (days * 24) * 100)}%</td></tr>`).join("")}
      </tbody></table>` : `<p class="muted">이 기간에는 예약이 없습니다.</p>`;

    const maxU = Math.max(...userList.map((x) => x.hours), 0) || 1;
    $("#stats-users").innerHTML = userList.length ? `<table>
      <thead><tr><th style="width:26%">사용자</th><th style="width:40%">예약 시간</th><th>시간 (h)</th><th>건수</th></tr></thead>
      <tbody>${userList.map((x) => `<tr>
        <td>${esc(x.name)}</td>
        <td><div class="bar-wrap"><div class="bar" style="width:${Math.round(x.hours / maxU * 100)}%"></div></div></td>
        <td>${r1(x.hours)}</td><td>${x.count}</td></tr>`).join("")}
      </tbody></table>` : `<p class="muted">이 기간에는 예약이 없습니다.</p>`;
  }

  // ------------------------------------------------------------------ 관리
  async function renderAdmin() {
    if (!isAdmin()) return;
    try {
      [state.equipment, state.access, state.profiles] = await Promise.all([api.listEquipment(), api.listEquipmentAccess(), api.listProfiles()]);
    } catch (ex) { toast(ex.message, true); return; }

    $("#admin-equipment").innerHTML = state.equipment.length ? `<table>
      <thead><tr><th>장비</th><th>위치</th><th>최대 시간</th><th>허가자</th><th>상태</th><th></th></tr></thead>
      <tbody>${state.equipment.map((eq) => {
        const n = state.access.filter((a) => a.equipment_id === eq.id).length;
        return `<tr>
          <td><span class="dot" style="background:${esc(eq.color)}"></span>${esc(eq.name)}</td>
          <td class="muted">${esc(eq.location)}</td>
          <td>${eq.max_hours_per_reservation ? eq.max_hours_per_reservation + "h" : "제한 없음"}</td>
          <td>${n ? n + "명" : "누구나"}</td>
          <td>${eq.is_active ? "예약 가능" : '<span class="badge">잠김</span>'}</td>
          <td style="text-align:right"><button class="btn btn-sm" data-edit="${eq.id}">수정</button></td></tr>`;
      }).join("")}</tbody></table>` : `<p class="muted">장비가 없습니다. "장비 추가"를 눌러 등록하세요.</p>`;
    $$("#admin-equipment [data-edit]").forEach((b) => b.addEventListener("click", () => openEquipmentModal(equipmentById(b.dataset.edit))));

    $("#admin-members").innerHTML = `<table>
      <thead><tr><th>이름</th><th>이메일</th><th>관리자</th></tr></thead>
      <tbody>${state.profiles.map((p) => `<tr>
        <td><input type="text" value="${esc(p.display_name)}" data-name="${p.id}" style="width:100%;max-width:200px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;font:inherit"></td>
        <td class="muted">${esc(p.email || "")}</td>
        <td><label class="check" style="margin:0"><input type="checkbox" data-admin="${p.id}" ${p.is_admin ? "checked" : ""} ${p.id === myId() ? "disabled title='본인 권한은 해제할 수 없습니다'" : ""}> ${p.is_admin ? '<span class="badge badge-admin">관리자</span>' : ""}</label></td>
      </tr>`).join("")}</tbody></table>`;
    $$("#admin-members [data-admin]").forEach((cb) => cb.addEventListener("change", async () => {
      try { await api.admin.setAdmin(cb.dataset.admin, cb.checked); toast("권한을 변경했습니다."); renderAdmin(); }
      catch (ex) { cb.checked = !cb.checked; toast(ex.message, true); }
    }));
    $$("#admin-members [data-name]").forEach((inp) => inp.addEventListener("change", async () => {
      try { await api.admin.setDisplayName(inp.dataset.name, inp.value.trim()); toast("이름을 저장했습니다."); state.profiles = await api.listProfiles(); }
      catch (ex) { toast(ex.message, true); }
    }));

    try {
      const s = await api.admin.getSettings();
      $("#set-slack").value = s.slack_webhook_url || "";
      $("#set-site").value = s.site_url || (location.origin + location.pathname);
      $("#set-reminder").value = s.reminder_minutes || "30";
    } catch (ex) { $("#settings-error").textContent = ex.message; }
  }

  $("#btn-add-equipment").addEventListener("click", () => openEquipmentModal(null));
  function openEquipmentModal(eq) {
    $("#eq-title").textContent = eq ? "장비 수정" : "장비 추가";
    $("#eq-id").value = eq?.id || "";
    $("#eq-name").value = eq?.name || "";
    $("#eq-location").value = eq?.location || "";
    $("#eq-description").value = eq?.description || "";
    $("#eq-color").value = eq?.color || "#3788d8";
    $("#eq-max").value = eq?.max_hours_per_reservation ?? 0;
    $("#eq-sort").value = eq?.sort_order ?? (state.equipment.length + 1);
    $("#eq-active").checked = eq ? eq.is_active : true;
    const allowed = new Set(state.access.filter((a) => a.equipment_id === eq?.id).map((a) => a.user_id));
    $("#eq-access").innerHTML = state.profiles.map((p) =>
      `<label><input type="checkbox" value="${p.id}" ${allowed.has(p.id) ? "checked" : ""}> ${esc(p.display_name || p.email)}</label>`).join("");
    $("#eq-error").textContent = "";
    $("#eq-delete").hidden = !eq;   // 새 장비 추가 화면에서는 삭제 버튼 숨김
    openModal("#modal-equipment");
    $("#eq-name").focus();
  }

  // 장비 삭제: 예약 기록이 없으면 바로 삭제, 있으면 잠금 처리를 안내
  $("#eq-delete").addEventListener("click", async () => {
    const id = $("#eq-id").value;
    const eq = equipmentById(id);
    if (!eq) return;
    const err = $("#eq-error");
    err.textContent = "";
    try {
      const n = await api.admin.countReservations(id);
      if (n > 0) {
        const lock = confirm(
          `"${eq.name}" 에는 예약 기록이 ${n}건 있어 삭제하면 과거 예약과 통계가 함께 사라지므로 삭제할 수 없습니다.\n\n` +
          `대신 "예약 불가"로 잠가서 새 예약만 막을까요? (캘린더에는 취소선으로 표시됩니다)`
        );
        if (!lock) return;
        await api.admin.saveEquipment({ ...eq, is_active: false });
        toast(`"${eq.name}" 을(를) 잠갔습니다.`);
      } else {
        if (!confirm(`"${eq.name}" 장비를 삭제할까요? 되돌릴 수 없습니다.`)) return;
        await api.admin.deleteEquipment(id);
        toast(`"${eq.name}" 을(를) 삭제했습니다.`);
      }
      closeModal("#modal-equipment");
      await renderAdmin();
      renderLegend();
      state.calendar?.refetchEvents();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
  $("#eq-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#eq-error");
    err.textContent = "";
    const name = $("#eq-name").value.trim();
    if (!name) { err.textContent = "이름을 입력하세요."; return; }
    try {
      const saved = await api.admin.saveEquipment({
        id: $("#eq-id").value || undefined,
        name,
        location: $("#eq-location").value.trim(),
        description: $("#eq-description").value.trim(),
        color: $("#eq-color").value,
        max_hours_per_reservation: parseInt($("#eq-max").value, 10) || 0,
        sort_order: parseInt($("#eq-sort").value, 10) || 0,
        is_active: $("#eq-active").checked,
      });
      const userIds = $$("#eq-access input:checked").map((c) => c.value);
      await api.admin.setAccess(saved.id, userIds);
      closeModal("#modal-equipment");
      toast("장비를 저장했습니다.");
      await renderAdmin();
      renderLegend();
      state.calendar?.refetchEvents();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });

  $("#settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#settings-error"); err.textContent = "";
    try {
      await api.admin.saveSettings({
        slack_webhook_url: $("#set-slack").value.trim(),
        site_url: $("#set-site").value.trim(),
        reminder_minutes: parseInt($("#set-reminder").value, 10) || 30,
      });
      $("#settings-status").textContent = "저장했습니다.";
      setTimeout(() => ($("#settings-status").textContent = ""), 3000);
    } catch (ex) { err.textContent = ex.message; }
  });
  $("#btn-test-slack").addEventListener("click", async () => {
    const err = $("#settings-error"); err.textContent = "";
    try {
      await api.admin.sendTestSlack();
      $("#settings-status").textContent = "테스트 메시지를 보냈습니다. 슬랙 채널을 확인하세요. (저장한 URL 기준)";
    } catch (ex) { err.textContent = ex.message; }
  });

  // ------------------------------------------------------------------ 시작
  function init() {
    if (/YOUR-PROJECT|YOUR-ANON/.test(cfg.SUPABASE_URL + cfg.SUPABASE_ANON_KEY)) {
      $("#config-warning").hidden = false;
    }
    api.onAuthStateChange((event, session) => {
      // supabase 안내: 콜백 안에서 바로 다른 supabase 호출을 하면 교착이 생길 수 있어 setTimeout 으로 뺀다
      setTimeout(async () => {
        if (event === "SIGNED_OUT" || !session) {
          state.session = null; state.profile = null; state.entered = false;
          showLogin();
          return;
        }
        state.session = session;
        if (event === "PASSWORD_RECOVERY" || (needsSetPassword && !state.entered)) {
          try { state.profile = await api.getMyProfile(); } catch (e) {}
          showSetPw();
          return;
        }
        if (!state.entered && (event === "SIGNED_IN" || event === "INITIAL_SESSION")) {
          await enterApp();
        }
      }, 0);
    });
  }
  init();
})();
